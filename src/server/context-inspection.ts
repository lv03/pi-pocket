/** Optional, non-model-visible request capture and usage reconciliation for Context Insight. */
import { randomUUID } from "node:crypto";
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    createAssistantMessageEventStream,
    normalizeContext,
    type AssistantMessage,
    type Usage,
} from "@earendil-works/pi-ai";
import {
    defineDoc,
    NestedCallDoc,
    UsageDoc,
    type CommitPublication,
    type ConversationId,
    type Cursor,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { ModelRequestCapture, UsageHistory, UsageHistoryEvent } from "./host.ts";
import { safeMetadata, transcriptMessage } from "./transcripts.ts";
import { ToolActivityCaptureDoc } from "./tool-activity.ts";

const context = BACKGROUND_CONTEXT;

type CapturedUsage = { seq: number; at: number; entryIds: number[]; events: UsageHistoryEvent[] };
type InspectionState = { requests: ModelRequestCapture[]; usage: CapturedUsage[] };

/** The fork owns no parent bills or request captures. No field here changes model context. */
export const InspectionDoc = defineDoc<JsonRepresentation<InspectionState>>({
    kind: "pocket.context-capture",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ requests: [], usage: [] }),
    checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export class ContextInspection {
    readonly #app: PocketApp;
    readonly #totals = new Map<number, UsageState>();
    #writes = Promise.resolve();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    enabled(): boolean {
        return this.#app.loader?.enabled("context-insight.ts") === true;
    }

    /** Initialize accounting before recovered work can add an entryless bill. */
    async load(conversations: readonly ConversationId[]): Promise<void> {
        for (const conversation of conversations) {
            const totals = await this.#app.harness.snapshot(UsageDoc, conversation, context);

            this.#totals.set(Number(conversation), structuredClone(totals ?? emptyUsage()));
        }
    }

    #enqueue(write: () => Promise<void>): void {
        this.#writes = this.#writes
            .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
            .then(write)
            .catch((error) => this.#captureFailed(error));
    }

    /** Install below retries and warming. Diagnostics must never delay a provider or its terminal response. */
    install(
        models: PocketApp["models"],
        conversationOf: (sessionId: string) => Promise<number | undefined>,
    ): void {
        const stream = models.streamSimple.bind(models);

        models.streamSimple = (model, transcript, options) => {
            if (!this.enabled() || options?.sessionId === undefined) {
                return stream(model, transcript, options);
            }

            const startedAt = Date.now();
            const id = randomUUID();
            let messages: ModelRequestCapture["messages"] | undefined;

            try {
                messages = normalizeContext(transcript).messages.map((message) =>
                    transcriptMessage(message, true, this.#app.toolSources()),
                );
            } catch (error) {
                this.#captureFailed(error);
            }

            // Start the real request before conversation lookup or any diagnostic storage work.
            const source = stream(model, transcript, options);
            const output = createAssistantMessageEventStream();
            const capture = Promise.resolve()
                .then(() => conversationOf(options.sessionId!))
                .then((found) => {
                    if (found === undefined || messages === undefined || !this.enabled()) {
                        return undefined;
                    }

                    const conversation = found as ConversationId;
                    const value: ModelRequestCapture = {
                        id,
                        startedAt,
                        provider: model.provider,
                        model: model.id,
                        messages: messages.map((message) => this.#clean(message, conversation)),
                        outcome: "pending",
                        accuracy: "normalized-after-hooks",
                    };

                    return { conversation, value };
                })
                .catch((error) => {
                    this.#captureFailed(error);

                    return undefined;
                });

            this.#enqueue(async () => {
                const state = await capture;

                if (state !== undefined) {
                    await this.#saveRequest(state.conversation, state.value);
                }
            });

            const finish = (message: AssistantMessage, outcome: "done" | "error") => {
                const endedAt = Date.now();

                this.#enqueue(async () => {
                    const state = await capture;

                    if (state !== undefined) {
                        await this.#finish(
                            state.conversation,
                            state.value,
                            message,
                            outcome,
                            endedAt,
                        );
                    }
                });
            };

            void (async () => {
                let terminal = false;

                try {
                    for await (const event of source) {
                        output.push(event);

                        if (event.type === "done" || event.type === "error") {
                            terminal = true;
                            finish(event.type === "done" ? event.message : event.error, event.type);
                        }
                    }

                    const result = await source.result();

                    output.end(result);

                    if (!terminal) {
                        finish(
                            result,
                            ["error", "aborted"].includes(result.stopReason) ? "error" : "done",
                        );
                    }
                } catch (error) {
                    const message = {
                        role: "assistant",
                        content: [],
                        api: model.api,
                        provider: model.provider,
                        model: model.id,
                        timestamp: startedAt,
                        stopReason: "error",
                        errorMessage: String(error),
                        usage: zeroUsage(),
                    } as AssistantMessage;

                    output.push({ type: "error", reason: "error", error: message });
                    output.end(message);
                    finish(message, "error");
                }
            })();

            return output;
        };
    }

    #project(message: unknown, conversation: ConversationId) {
        return this.#clean(transcriptMessage(message, true, this.#app.toolSources()), conversation);
    }

    #clean(projected: ReturnType<typeof transcriptMessage>, conversation: ConversationId) {
        // Only explicitly hidden values are replaced. Options, headers, and provider payloads are never captured.
        const clean = (value: unknown): unknown => {
            if (typeof value === "string") {
                return this.#app.hidden.replace(value, conversation);
            }

            if (Array.isArray(value)) {
                return value.map(clean);
            }

            if (value !== null && typeof value === "object") {
                return Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [
                        this.#app.hidden.replace(key, conversation),
                        clean(item),
                    ]),
                );
            }

            return value;
        };

        return clean(projected) as ReturnType<typeof transcriptMessage>;
    }

    #captureFailed(error: unknown): void {
        console.error("Context request capture failed:", error);
    }

    async #saveRequest(conversation: ConversationId, capture: ModelRequestCapture): Promise<void> {
        if (!this.enabled()) {
            return;
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(InspectionDoc, conversation);
            const index = doc.requests.findIndex((request) => request.id === capture.id);
            const value = JSON.parse(JSON.stringify(capture));

            if (index < 0) {
                doc.requests.push(value);
            } else {
                doc.requests[index] = value;
            }
        }, context);
    }

    async #finish(
        conversation: ConversationId,
        capture: ModelRequestCapture,
        message: AssistantMessage,
        outcome: "done" | "error",
        endedAt: number,
    ): Promise<void> {
        if (!this.enabled()) {
            return;
        }

        await this.#saveRequest(conversation, {
            ...capture,
            endedAt,
            outcome,
            response: this.#project(message, conversation),
        });

        const meta = this.#app.sessionMeta(this.#app.rootOf(conversation));

        if (meta !== undefined && meta.pip === undefined) {
            this.#app.events.emit("request.completed", {
                conversationId: Number(conversation),
                session: Number(this.#app.rootOf(conversation)),
                at: endedAt,
                requestId: capture.id,
            });
        }
    }

    /** Called synchronously by the one core commit coordinator. Writes run later, outside the commit listener. */
    committed(publication: CommitPublication): void {
        for (const change of publication.changes) {
            if (
                this.enabled() &&
                change.type === "document" &&
                change.record.kind === NestedCallDoc.definition.kind &&
                change.conversationId !== undefined &&
                change.value !== null &&
                typeof change.value.taskId === "number" &&
                change.value.result !== undefined
            ) {
                const conversation = change.conversationId;
                const taskId = String(change.value.taskId);
                const result = safeMetadata(change.value.result);

                this.#enqueue(async () => {
                    if (!this.enabled()) {
                        return;
                    }

                    await this.#app.harness.commit(async (tx) => {
                        const doc = await tx.doc(ToolActivityCaptureDoc, conversation);

                        doc.results[taskId] = result as JsonValue;
                    }, context);
                });
            }

            if (
                change.type !== "document" ||
                change.record.kind !== UsageDoc.definition.kind ||
                change.conversationId === undefined ||
                change.value === null
            ) {
                continue;
            }

            const conversation = change.conversationId;
            const key = Number(conversation);
            const totals = structuredClone(change.value) as UsageState;
            const previous = this.#totals.get(key) ?? emptyUsage();
            const at = Date.now();

            this.#totals.set(key, totals);

            const meta = this.#app.sessionMeta(this.#app.rootOf(conversation));

            if (meta !== undefined && meta.pip === undefined) {
                this.#app.events.emit("usage.updated", {
                    conversationId: key,
                    session: Number(this.#app.rootOf(conversation)),
                    at,
                });
            }

            if (!this.enabled()) {
                continue;
            }

            const delta = subtractUsage(totals, previous);
            const events = usageEvents(delta, at);

            if (events.length === 0) {
                continue;
            }

            const record: CapturedUsage = {
                seq: Number(publication.seq),
                at,
                entryIds: publication.changes.flatMap((item) =>
                    item.type === "entry" && item.value.conversationId === conversation
                        ? [Number(item.value.id)]
                        : [],
                ),
                events,
            };

            this.#writes = this.#writes
                .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
                .then(async () => {
                    if (!this.enabled()) {
                        return;
                    }

                    await this.#app.harness.commit(async (tx) => {
                        const doc = await tx.doc(InspectionDoc, conversation);

                        if (!doc.usage.some((item) => item.seq === record.seq)) {
                            doc.usage.push(JSON.parse(JSON.stringify(record)));
                        }
                    }, context);
                })
                .catch((error) => console.error("Context usage capture failed:", error));
        }
    }

    async flush(): Promise<void> {
        await this.#writes;
    }

    async requestHistory(conversation: ConversationId): Promise<readonly ModelRequestCapture[]> {
        await this.flush();

        return structuredClone(
            (await this.#app.harness.snapshot(InspectionDoc, conversation, context))?.requests ??
                [],
        );
    }

    async usageHistory(conversation: ConversationId): Promise<UsageHistory> {
        await this.flush();

        const doc = await this.#app.harness.snapshot(InspectionDoc, conversation, context);
        const covered = new Set(doc?.usage.flatMap((item) => item.entryIds) ?? []);
        const events: UsageHistoryEvent[] = [...(doc?.usage.flatMap((item) => item.events) ?? [])];
        const source = await this.#app.conversation(conversation);
        let cursor: Cursor | undefined;

        do {
            const page = await source.entries({ order: "ascending" }, 256, cursor, context);

            for (const entry of page.items) {
                if (entry.conversationId !== conversation || covered.has(Number(entry.id))) {
                    continue;
                }

                for (const message of entry.model ?? []) {
                    if (message.role === "assistant" || message.role === "toolResult") {
                        if (message.usage !== undefined) {
                            events.push({
                                entryId: Number(entry.id),
                                at: message.timestamp,
                                bucket: message.role === "assistant" ? "models" : "tools",
                                key:
                                    message.role === "assistant"
                                        ? `${message.provider}/${message.model}`
                                        : message.toolName,
                                usage: structuredClone(message.usage),
                                source: "entry",
                            });
                        }
                    }
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        const totals = await this.#app.harness.snapshot(UsageDoc, conversation, context);
        const known = emptyUsage();

        for (const event of events) {
            addBucket(known, event.bucket, event.key, event.usage);
        }

        return {
            ...(totals === undefined ? {} : { totals }),
            events: events.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)),
            known,
            undated: subtractUsage(totals ?? emptyUsage(), known),
            accuracy: {
                historical: "stored-entry-usage",
                remainder: "undated",
                capture: "enabled-only-best-effort",
            },
        };
    }
}

export function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function emptyUsage(): UsageState {
    return { models: {}, tools: {} };
}

function addBucket(state: UsageState, bucket: "models" | "tools", key: string, usage: Usage): void {
    const total = Object.hasOwn(state[bucket], key) ? state[bucket][key]! : zeroUsage();

    for (const field of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "totalTokens",
        "cacheWrite1h",
        "reasoning",
    ] as const) {
        if (usage[field] !== undefined) {
            total[field] = (total[field] ?? 0) + usage[field];
        }
    }

    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
        total.cost[field] += usage.cost[field];
    }

    Object.defineProperty(state[bucket], key, {
        value: total,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

/** Signed residuals expose inconsistent imported data instead of silently inventing billed usage. */
export function subtractUsage(total: UsageState, known: UsageState): UsageState {
    const result = structuredClone(total);

    for (const bucket of ["models", "tools"] as const) {
        for (const [key, usage] of Object.entries(known[bucket])) {
            const negative = structuredClone(usage);

            for (const field of [
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "totalTokens",
                "cacheWrite1h",
                "reasoning",
            ] as const) {
                if (negative[field] !== undefined) {
                    negative[field] = -negative[field]!;
                }
            }

            for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
                negative.cost[field] = -negative.cost[field];
            }

            addBucket(result, bucket, key, negative);
        }
    }

    return result;
}

function usageEvents(state: UsageState, at: number): UsageHistoryEvent[] {
    return (["models", "tools"] as const).flatMap((bucket) =>
        Object.entries(state[bucket])
            .filter(([, usage]) =>
                Object.entries(usage).some(([key, value]) =>
                    key === "cost"
                        ? Object.values(value).some((number) => number !== 0)
                        : value !== 0,
                ),
            )
            .map(([key, usage]) => ({ at, bucket, key, usage, source: "usage-commit" as const })),
    );
}
