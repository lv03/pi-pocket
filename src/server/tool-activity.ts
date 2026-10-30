/** Reads durable nested tool tasks and their optional live result documents for one conversation. */
import type { Context, JsonRepresentation, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
    defineDoc,
    NestedCallDoc,
    ToolTask,
    type ConversationId,
    type Cursor,
    type TaskId,
    type TaskRecord,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { safeMetadata } from "./transcripts.ts";

const context = BACKGROUND_CONTEXT;
const PAGE_SIZE = 256;

/** Retained result metadata has no model contribution, and a fork starts with no parent's tool observations. */
export const ToolActivityCaptureDoc = defineDoc<{ results: Record<string, JsonValue> }>({
    kind: "pocket.context-tool-results",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ results: {} }),
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type JsonObject = { readonly [key: string]: JsonValue };
type NestedInput = {
    kind: "nested";
    parent: TaskId;
    parentCallId: string;
    key: string;
    call: JsonObject & {
        type: "toolCall";
        id: string;
        name: string;
        arguments: JsonObject;
    };
};
type ModelInput = { kind: "model"; callId: string };
type NestedResult = JsonRepresentation<{
    taskId: TaskId;
    structuredOutput?: JsonValue;
    isError: boolean;
    details?: JsonValue;
    diagnostics: readonly JsonValue[];
    usage?: Usage;
    durationMs?: number;
}>;

/** The durable lifecycle or tool outcome of one nested call. */
export type ToolActivityStatus =
    "pending" | "running" | "completed" | "failed" | "aborted" | "orphaned" | "faulted";

/** The stored result of a nested call, when its parent task still retains the result document. */
export interface ToolActivityResult {
    readonly isError: boolean;
    /** Structured output only. It is not a complete text rendering of the tool output. */
    readonly structuredOutput?: unknown;
    readonly details?: unknown;
    readonly diagnostics?: readonly unknown[];
    readonly usage?: Usage;
    readonly durationMs?: number;
}

/** A stored nested tool call in one visible conversation. */
export interface ToolActivityRow {
    readonly taskId: number;
    readonly parentTaskId: number;
    readonly callId: string;
    /** The immediate parent call ID. It can be another nested call ID. */
    readonly parentCallId: string;
    /** The root model-issued call ID found by following task ancestry. */
    readonly rootCallId?: string;
    /** Its registered tool name. */
    readonly toolName: string;
    /** Exact arguments retained in the nested task input, after metadata safety projection. */
    readonly arguments: unknown;
    readonly status: ToolActivityStatus;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly durationMs?: number;
    readonly result?: ToolActivityResult;
    /** True only when a structured output value is stored in the result. This is not complete text output. */
    readonly outputRecorded: boolean;
    /** True when the live task or enabled inspection capture retains the result. */
    readonly resultAvailable: boolean;
}

/** Reads nested tool calls from Durable task records. */
export class ToolActivity {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async read(conversationId: ConversationId): Promise<readonly ToolActivityRow[]> {
        const captured = await this.#app.harness.snapshot(
            ToolActivityCaptureDoc,
            conversationId,
            context,
        );
        const tasks = await this.#app.harness.commit(async (tx) => {
            const found: StoredTask[] = [];
            let cursor: Cursor | undefined;

            do {
                const page = await tx.scanTasks(
                    { conversationId, kind: ToolTask.definition.name, order: "ascending" },
                    PAGE_SIZE,
                    cursor,
                );

                found.push(...page.items);
                cursor = page.next;
            } while (cursor !== undefined);

            return found;
        }, context);

        const byId = new Map<number, StoredTask>();

        for (const task of tasks) {
            byId.set(Number(task.id), task);
        }

        const rows: ToolActivityRow[] = [];

        for (const task of tasks) {
            if (!isNestedInput(task.input)) {
                continue;
            }

            const input = task.input;
            const retained = captured?.results[String(task.id)] as NestedResult | undefined;
            const result = (await this.#result(input.parent, input, context)) ?? retained;
            const resultValue = result === undefined ? undefined : projectResult(result);
            const rootCallId = rootCallOf(input.parent, byId);
            const startedAt = finite(task.startedAt);
            const endedAt = finite(task.endedAt);
            const durationMs =
                finite(resultValue?.durationMs) ??
                (startedAt === undefined || endedAt === undefined
                    ? undefined
                    : Math.max(0, endedAt - startedAt));

            rows.push({
                taskId: Number(task.id),
                parentTaskId: Number(input.parent),
                callId: input.call.id,
                parentCallId: input.parentCallId,
                ...(rootCallId === undefined ? {} : { rootCallId }),
                toolName: input.call.name,
                arguments: safeMetadata(input.call.arguments),
                status: statusOf(task, resultValue),
                ...(startedAt === undefined ? {} : { startedAt }),
                ...(endedAt === undefined ? {} : { endedAt }),
                ...(durationMs === undefined ? {} : { durationMs }),
                ...(resultValue === undefined ? {} : { result: resultValue }),
                outputRecorded: resultValue?.structuredOutput !== undefined,
                resultAvailable: resultValue !== undefined,
            });
        }

        return rows;
    }

    async #result(
        parentTaskId: TaskId,
        input: NestedInput,
        readContext: Context,
    ): Promise<NestedResult | undefined> {
        const state = await this.#app.harness.snapshot(
            NestedCallDoc,
            parentTaskId,
            input.key,
            readContext,
        );

        return state?.result as NestedResult | undefined;
    }
}

function isNestedInput(value: JsonValue): value is NestedInput {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { kind?: unknown }).kind === "nested" &&
        typeof (value as { parent?: unknown }).parent === "number" &&
        typeof (value as { parentCallId?: unknown }).parentCallId === "string" &&
        typeof (value as { key?: unknown }).key === "string" &&
        typeof (value as { call?: unknown }).call === "object" &&
        (value as { call?: unknown }).call !== null
    );
}

function rootCallOf(parentId: TaskId, tasks: ReadonlyMap<number, StoredTask>): string | undefined {
    const seen = new Set<number>();
    let current: StoredTask | undefined = tasks.get(Number(parentId));

    while (current !== undefined && !seen.has(Number(current.id))) {
        seen.add(Number(current.id));
        const input = current.input;

        if (isModelInput(input)) {
            return input.callId;
        }

        if (!isNestedInput(input)) {
            return undefined;
        }

        current = tasks.get(Number(input.parent));
    }

    return undefined;
}

function isModelInput(value: JsonValue): value is ModelInput {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as { kind?: unknown }).kind === "model" &&
        typeof (value as { callId?: unknown }).callId === "string"
    );
}

function projectResult(result: NestedResult): ToolActivityResult {
    return {
        isError: result.isError,
        ...(result.structuredOutput === undefined
            ? {}
            : { structuredOutput: safeMetadata(result.structuredOutput) }),
        ...(result.details === undefined ? {} : { details: safeMetadata(result.details) }),
        ...(result.diagnostics === undefined
            ? {}
            : { diagnostics: safeMetadata(result.diagnostics) as readonly unknown[] }),
        ...(result.usage === undefined ? {} : { usage: safeMetadata(result.usage) as Usage }),
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    };
}

function statusOf(task: StoredTask, result: ToolActivityResult | undefined): ToolActivityStatus {
    if (task.state.status === "terminal" || task.state.status === "completing") {
        const outcome = task.state.outcome;

        if (outcome !== undefined) {
            return outcome.status;
        }
    }

    if (result?.isError === true) {
        return "failed";
    }

    return task.state.status === "running" ? "running" : "pending";
}

function finite(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) ? value : undefined;
}
