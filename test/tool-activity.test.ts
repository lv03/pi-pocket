import assert from "node:assert/strict";
import { test } from "node:test";
import { NestedCallDoc, ToolTask, type TaskId } from "@earendil-works/pi-durable";
import { ToolActivity, ToolActivityCaptureDoc } from "../src/server/tool-activity.ts";

function task(value: unknown) {
    return value as never;
}

test("tool activity follows task ancestry and reads retained nested results", async () => {
    const parent = 10 as TaskId;
    const child = 11 as TaskId;
    const records = [
        task({
            id: parent,
            conversationId: 7,
            kind: ToolTask.definition.name,
            input: { kind: "model", assistant: 1, callId: "model-call" },
            state: {
                status: "terminal",
                outcome: { status: "completed", result: { kind: "model", entryId: 2 } },
            },
        }),
        task({
            id: child,
            conversationId: 7,
            kind: ToolTask.definition.name,
            input: {
                kind: "nested",
                parent,
                parentCallId: "model-call",
                key: "step",
                call: {
                    type: "toolCall",
                    id: "model-call/step",
                    name: "read",
                    arguments: { path: "secret.png", image: { type: "image", data: "bytes" } },
                },
            },
            startedAt: 100,
            endedAt: 125,
            state: {
                status: "terminal",
                outcome: { status: "completed", result: { kind: "nested" } },
            },
        }),
    ];
    const harness = {
        commit: async (change: (tx: unknown) => unknown) =>
            change({
                scanTasks: async (query: unknown) => {
                    assert.deepEqual(query, {
                        conversationId: 7,
                        kind: ToolTask.definition.name,
                        order: "ascending",
                    });

                    return { items: records, next: undefined };
                },
            }),
        snapshot: async (token: unknown, taskId: TaskId, key: string) => {
            if (token === ToolActivityCaptureDoc) {
                return undefined;
            }

            assert.equal(token, NestedCallDoc);
            assert.equal(taskId, parent);
            assert.equal(key, "step");

            return {
                result: {
                    taskId: child,
                    structuredOutput: { ok: true },
                    isError: false,
                    details: { image: { type: "image", data: "bytes", width: 2 } },
                    diagnostics: [],
                    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                    durationMs: 20,
                },
            };
        },
    };
    const activity = new ToolActivity({ harness } as never);
    const rows = await activity.read(7 as never);

    assert.deepEqual(rows, [
        {
            taskId: 11,
            parentTaskId: 10,
            callId: "model-call/step",
            parentCallId: "model-call",
            rootCallId: "model-call",
            toolName: "read",
            arguments: { path: "secret.png", image: { type: "image" } },
            status: "completed",
            startedAt: 100,
            endedAt: 125,
            durationMs: 20,
            result: {
                isError: false,
                structuredOutput: { ok: true },
                details: { image: { type: "image", width: 2 } },
                diagnostics: [],
                usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                durationMs: 20,
            },
            outputRecorded: true,
            resultAvailable: true,
        },
    ]);
});

test("tool activity does not split a nested ID when root ancestry is missing", async () => {
    const child = 20 as TaskId;
    const records = [
        task({
            id: child,
            conversationId: 8,
            kind: ToolTask.definition.name,
            input: {
                kind: "nested",
                parent: 999 as TaskId,
                parentCallId: "opaque/parent",
                key: "x",
                call: { type: "toolCall", id: "opaque/parent/x", name: "bash", arguments: {} },
            },
            state: { status: "running", checkpoint: { phase: "call" } },
        }),
    ];
    const harness = {
        commit: async (change: (tx: unknown) => unknown) =>
            change({ scanTasks: async () => ({ items: records, next: undefined }) }),
        snapshot: async () => undefined,
    };
    const rows = await new ToolActivity({ harness } as never).read(8 as never);

    assert.equal(rows[0]!.rootCallId, undefined);
    assert.equal(rows[0]!.resultAvailable, false);
    assert.equal(rows[0]!.outputRecorded, false);
    assert.equal(rows[0]!.status, "running");
});
