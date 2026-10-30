import assert from "node:assert/strict";
import { test } from "node:test";
import {
    fold,
    itemsFromSnapshot,
    normalizedRequest,
    usageOf,
} from "../src/server/context-insight.ts";
import type { TranscriptEntry, TranscriptMessage, TranscriptPart } from "../src/server/host.ts";

type Assistant = Extract<TranscriptMessage, { role: "assistant" }>;
type Result = Extract<TranscriptMessage, { role: "toolResult" }>;
const text = (value: string, tokens = 1): TranscriptPart => ({ type: "text", text: value, tokens });
const entry = (
    id: number,
    messages: TranscriptMessage[],
    extra: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({
    id,
    at: id * 100,
    kind: `pi.${messages[0]?.role === "toolResult" ? "tool-result" : (messages[0]?.role ?? "custom")}`,
    messages,
    ...extra,
});
const answer = (parts: TranscriptPart[], extra: Partial<Assistant> = {}): Assistant => ({
    role: "assistant",
    parts,
    tokens: 1,
    stopReason: "stop",
    ...extra,
});
const call = (id: string, name: string, args: unknown): TranscriptPart => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
    tokens: 1,
});
const result = (id: string, name: string, output: string, extra: Partial<Result> = {}): Result => ({
    role: "toolResult",
    callId: id,
    name,
    parts: [text(output)],
    tokens: 1,
    isError: false,
    ...extra,
});
const inspect = (entries: TranscriptEntry[]) => fold(entries, null, () => 1000000);

test("items preserve exact sections, schemas, selected message parts, and replacement source locators", () => {
    const long = "exact text\n".repeat(20000);
    const schema = { type: "object", properties: { path: { type: "string", description: long } } };
    const model = inspect([
        entry(1, [
            {
                role: "system",
                content: "",
                tokens: 1,
                sections: { preamble: long },
                tools: [{ name: "read", description: long, parameters: schema, tokens: 100 }],
            },
        ]),
        entry(2, [{ role: "user", parts: [text("old")], tokens: 1 }], { conversationId: 40 }),
        entry(3, [], {
            conversationId: 41,
            edits: [
                {
                    target: 2,
                    action: "replace",
                    messages: [
                        answer([
                            text("first"),
                            text(long),
                            {
                                type: "image",
                                mimeType: "image/png",
                                tokens: 77,
                                imageIndex: 3,
                                width: 24,
                                height: 32,
                            },
                        ]),
                    ],
                },
            ],
        }),
    ]);
    const section = model.items.find((item) => item.key === "section:preamble")!;
    const tool = model.items.find((item) => item.key === "schema:read")!;
    const selected = model.items.find((item) => item.text === long && item.role === "answers")!;
    const image = model.items.find((item) => item.image)!;

    assert.equal(section.text, long);
    assert.equal(section.content, long);
    assert.equal(tool.description, long);
    assert.deepEqual(tool.parameters, schema);
    assert.deepEqual(section.locator, { entry: 1, message: 0, section: "preamble" });
    assert.deepEqual(selected.locator, {
        entry: 3,
        message: 0,
        part: 1,
        conversationId: 41,
        edit: { entry: 3, index: 0, target: 2 },
    });
    assert.equal(selected.entry, 2);
    assert.equal(selected.key, "entry:3:message:0:part:1:edit:3:0");
    assert.equal(image.locator.imageIndex, 3);
    assert.equal(image.locator.entry, 3);
    assert.equal(image.tokens, 77);
    assert.equal(image.tokenMethod, "native-image-estimate");
    assert.equal(image.image!.width, 24);
    assert.equal(new Set(model.items.map((item) => item.key)).size, model.items.length);
});

test("native snapshots retain normalized origins, schemas, and synthetic result identity", () => {
    const replacement = answer([text("replacement")]);
    const messages: TranscriptMessage[] = [
        {
            role: "system",
            content: "",
            tokens: 1,
            sections: { instructions: "baseline" },
            tools: [{ name: "read", tokens: 4, parameters: { type: "object" } }],
        },
        replacement,
        result("missing", "read", "unavailable"),
    ];
    const items = itemsFromSnapshot({
        messages,
        entries: [entry(10, [], { conversationId: 7 })],
        messageOrigins: [
            { entryId: 10, messageIndex: 0 },
            { entryId: 10, messageIndex: 1, editIndex: 2, targetEntryId: 3 },
            { synthetic: true },
        ],
    });

    assert.equal(items[0]!.key, "section:instructions");
    assert.equal(items[1]!.key, "schema:read");
    assert.equal(items[2]!.text, "replacement");
    assert.deepEqual(items[2]!.locator.edit, { entry: 10, index: 2, target: 3 });
    assert.equal(items[3]!.locator.synthetic, true);
});

test("projected timing measures TTFT and decode speed without double counting reasoning or billing totals", () => {
    const usage = {
        input: 100,
        cacheRead: 20,
        cacheWrite: 10,
        output: 40,
        reasoning: 30,
        totalTokens: 900,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const message = answer([text("reply")], {
        usage,
        pocketTiming: { startedAt: 1000, firstTokenAt: 1500, endedAt: 3500 },
    });
    const model = inspect([entry(1, [message])]);
    const step = model.steps[0]!;

    assert.equal(model.used, 170);
    assert.equal(usageOf(message).billedTotal, 900);
    assert.equal(step.billedTotal, 900);
    assert.equal(step.prompt, 130);
    assert.equal(step.reasoning, 30);
    assert.equal(step.ttftMs, 500);
    assert.equal(step.durationMs, 2500);
    assert.equal(step.outputTokensPerSecond, 20);
    assert.equal(step.accuracy!.timing, "recorded");
    assert.equal(model.accuracy.composition, "estimated");
    const missing = inspect([
        entry(1, [answer([], { pocketTiming: { startedAt: 100, endedAt: 200 } })]),
    ]).steps[0]!;

    assert.equal(missing.ttftMs, undefined);
    assert.equal(missing.outputTokensPerSecond, undefined);
});

test("source metadata attributes injected messages and clipped text stays explicit", () => {
    const part: TranscriptPart = {
        type: "text",
        text: "[subagent helper] partial",
        tokens: 800,
        clipped: 2000,
    };
    const source = { type: "extension", name: "helper" };
    const model = inspect([entry(1, [{ role: "user", source, parts: [part], tokens: 800 }])]);

    assert.equal(model.parts.inject, 800);
    assert.deepEqual(model.items[0]!.attribution, source);
    assert.equal(model.items[0]!.contentComplete, false);
    assert.equal(model.comms[0]!.clipped, 2000);
    assert.equal(model.comms[0]!.contentComplete, false);
});

test("nested Durable metadata records ranges, matches, failed edits, and successful siblings", () => {
    const model = inspect([
        entry(1, [answer([call("outer", "codemode", {})])]),
        entry(2, [result("outer", "codemode", "script failed", { isError: true })], {
            data: {
                details: {
                    calls: [
                        {
                            name: "read",
                            arguments: { path: "a.ts", offset: 41, limit: 20 },
                            status: "ok",
                            result: {
                                output: "line\nnext",
                                details: {
                                    returned: { startLine: 41, endLine: 42 },
                                    truncation: { truncated: true, outputLines: 2, outputBytes: 9 },
                                },
                            },
                        },
                        {
                            name: "edit",
                            args: JSON.stringify({
                                path: "a.ts",
                                oldText: "old",
                                newText: "new\nline",
                            }),
                            status: "error",
                            error: "text not found",
                        },
                        {
                            name: "write",
                            arguments: { path: "a.ts", content: "one\ntwo\n" },
                            status: "ok",
                        },
                        {
                            name: "search",
                            arguments: { path: "a.ts", query: "line" },
                            result: { details: { matches: [{ line: 42, text: "next" }] } },
                            status: "ok",
                        },
                        {
                            name: "codemode",
                            args: {},
                            status: "ok",
                            details: { calls: [{ name: "read", path: "b.ts", status: "ok" }] },
                        },
                    ],
                },
            },
        }),
    ]);
    const file = model.files.find((file) => file.path === "a.ts")!;
    const read = file.ops.find((op) => op.kind === "read")!;
    const failed = file.ops.find((op) => op.kind === "edit")!;
    const search = file.ops.find((op) => op.kind === "search")!;
    const unknown = model.files.find((file) => file.path === "b.ts")!.ops[0]!;

    assert.deepEqual(read.requested, { offset: 41, limit: 20 });
    assert.deepEqual(read.returned, { startLine: 41, endLine: 42, lines: 2, bytes: 9 });
    assert.equal(read.completeness, "partial");
    assert.deepEqual(read.nested, [0]);
    assert.equal(read.output, "line\nnext");
    assert.equal(failed.error, true);
    assert.equal(failed.added, undefined);
    assert.equal(file.added, 2);
    assert.deepEqual(search.matches, [{ line: 42, text: "next" }]);
    assert.equal(unknown.completeness, "unknown");
    assert.equal(unknown.returned, undefined);
    assert.equal(unknown.outputRecorded, false);
    assert.deepEqual(unknown.nested, [4, 0]);
});

test("direct reads keep errors and unknown completeness; stored changes override replacement counts", () => {
    const model = inspect([
        entry(1, [
            answer([
                call("read", "read", { path: "a", offset: 99, limit: 5 }),
                call("edit", "edit", { path: "a", edits: [{ oldText: "a\nb", newText: "x\ny" }] }),
            ]),
        ]),
        entry(2, [result("read", "read", "offset beyond file", { isError: true })]),
        entry(3, [result("edit", "edit", "done", { details: { added: 1, removed: 1 } })]),
    ]);
    const file = model.files[0]!;

    assert.equal(file.ops[0]!.error, true);
    assert.equal(file.ops[0]!.completeness, "unknown");
    assert.equal(file.ops[0]!.returned, undefined);
    assert.equal(file.ops[0]!.output, "offset beyond file");
    assert.equal(file.ops[1]!.changedLinesMethod, "stored");
    assert.deepEqual([file.added, file.removed], [1, 1]);
});

test("commands preserve full recorded output, clipping, recorded duration, and running calls", () => {
    const output = "first\n" + "long line\n".repeat(1000);
    const model = inspect([
        entry(1, [
            answer([
                call("done", "bash", { command: "CI=1 env npm test" }),
                call("running", "bash", { command: "npm run dev" }),
            ]),
        ]),
        entry(2, [
            result("done", "bash", output, {
                durationMs: 25,
                parts: [{ type: "text", text: output, tokens: 5000, clipped: 100 }],
            }),
        ]),
    ]);
    const command = model.commands[0]!;

    assert.equal(command.fullOutput, output);
    assert.equal(command.output, "first");
    assert.equal(command.clipped, 100);
    assert.equal(command.contentComplete, false);
    assert.equal(command.ms, 25);
    assert.equal(command.durationMethod, "recorded");
    assert.equal(command.program, "npm");
    assert.equal(model.commands[1]!.status, "running");
    assert.equal(model.commands[1]!.endedAt, undefined);
    assert.equal(model.commands[1]!.outputRecorded, false);
    assert.equal(model.programGroups[0]!.count, 2);
});

test("full outbound communication is retained", () => {
    const message = "check all files\n".repeat(1000);
    const model = inspect([
        entry(1, [answer([call("send", "subagent", { action: "send", name: "helper", message })])]),
        entry(2, [result("send", "subagent", "done")]),
    ]);

    assert.equal(model.comms[0]!.text, message);
    assert.equal(model.comms[0]!.contentComplete, true);
});

test("normalized requests order results by call, use the first duplicate, and synthesize missing results", () => {
    const entries = [
        entry(1, [{ role: "user", parts: [text("question")], tokens: 1 }]),
        entry(2, [{ role: "system", content: "baseline", tokens: 1 }]),
        entry(3, [answer([call("a", "read", {}), call("b", "write", {}), call("c", "bash", {})])]),
        entry(4, [{ role: "user", parts: [text("interruption")], tokens: 1 }]),
        entry(5, [result("b", "write", "b first")]),
        entry(6, [result("a", "read", "a")]),
        entry(7, [result("b", "write", "b duplicate")]),
        entry(8, [result("orphan", "read", "orphan")]),
        entry(9, [answer([text("next")])]),
        entry(10, [result("c", "bash", "late result")]),
    ];
    const request = normalizedRequest(entries, 9);

    assert.deepEqual(
        request.messages.map((message) => message.role),
        ["system", "user", "assistant", "toolResult", "toolResult", "toolResult", "user"],
    );
    assert.deepEqual(
        request.messages
            .filter((message) => message.role === "toolResult")
            .map((message) => message.callId),
        ["a", "b", "c"],
    );
    assert.equal(
        (request.messages[4] as Result).parts[0]!.type === "text" &&
            ((request.messages[4] as Result).parts[0] as { text: string }).text,
        "b first",
    );
    assert.equal(request.syntheticResults, 1);
    assert.equal((request.messages[5] as Result).isError, true);
    assert.equal(
        normalizedRequest(entries).messages.filter((message) => message.role === "toolResult")
            .length,
        3,
    );
});

test("normalized reconstruction preserves compacted baselines and retained replacement edits", () => {
    const entries = [
        entry(1, [answer([text("kept")])]),
        entry(2, [], {
            head: 1,
            kind: "pi.compaction",
            edits: [{ target: 1, action: "replace", messages: [answer([text("replacement")])] }],
        }),
        entry(3, [], { head: 1, kind: "pi.compaction" }),
        entry(4, [{ role: "system", content: "new baseline", tokens: 1 }]),
        entry(5, [answer([text("answer")])]),
    ];
    const request = normalizedRequest(entries, 5);

    assert.deepEqual(
        request.messages.map((message) => message.role),
        ["system", "assistant"],
    );
    assert.equal(
        (request.messages[1] as Assistant).parts[0]!.type === "text" &&
            ((request.messages[1] as Assistant).parts[0] as { text: string }).text,
        "replacement",
    );
});

test("repeated part objects still have distinct exact part locators", () => {
    const shared = text("same object");
    const model = inspect([entry(1, [answer([shared, shared])])]);

    assert.deepEqual(
        model.items.map((item) => item.locator.part),
        [0, 1],
    );
    assert.equal(new Set(model.items.map((item) => item.key)).size, 2);
});

test("native nested-call wrappers preserve receipt limits and stored patches", () => {
    const model = inspect([
        entry(1, [answer([call("outer", "codemode", {})])]),
        entry(2, [
            result("outer", "codemode", "done", {
                nestedCalls: {
                    complete: true,
                    calls: [
                        {
                            id: "edit",
                            name: "edit",
                            arguments: { path: "a" },
                            status: "ok",
                            result: {
                                details: {
                                    patch: "--- a\n+++ a\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n",
                                },
                            },
                        },
                        {
                            id: "shell",
                            name: "bash",
                            arguments: { command: "pwd" },
                            status: "ok",
                            durationMs: 5,
                        },
                    ],
                },
            }),
        ]),
    ]);

    assert.equal(model.files[0]!.ops[0]!.changedLinesMethod, "stored-patch");
    assert.deepEqual([model.files[0]!.added, model.files[0]!.removed], [1, 1]);
    assert.equal(model.commands[0]!.callId, "shell");
    assert.equal(model.commands[0]!.outputRecorded, false);
    assert.equal(model.commands[0]!.contentComplete, false);
    assert.equal(model.commands[0]!.ms, 5);
});

test("background observations keep running state and join all recorded output", () => {
    const start = "Started bg-1 (pid 1) in /tmp. Read what it prints with action output, id bg-1.";
    const output = "bg-1: running.\nhello\nworld";
    const entries = [
        entry(1, [
            answer([call("start", "background", { action: "start", command: "node server.js" })]),
        ]),
        entry(2, [result("start", "background", start, { durationMs: 10 })]),
        entry(3, [answer([call("output", "background", { action: "output", id: "bg-1" })])]),
        entry(4, [result("output", "background", output, { durationMs: 1 })]),
    ];
    const running = inspect(entries).commands[0]!;

    assert.equal(running.status, "running");
    assert.equal(running.startedAt, 100);
    assert.equal(running.endedAt, undefined);
    assert.equal(running.ms, undefined);
    assert.equal(running.fullOutput, `${start}\n${output}`);
    const ended = inspect([
        ...entries,
        entry(5, [answer([call("stop", "background", { action: "stop", id: "bg-1" })])]),
        entry(6, [result("stop", "background", "Stopped bg-1.")]),
    ]).commands[0]!;

    assert.equal(ended.status, "ok");
    assert.equal(ended.endedAt, 600);
    assert.equal(ended.ms, 500);
    assert.equal(ended.fullOutput, `${start}\n${output}\nStopped bg-1.`);
});

test("edits after a measured request discard stale pressure measurements", () => {
    const usage = {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 20,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const model = inspect([
        entry(1, [{ role: "user", parts: [text("before", 100)], tokens: 100 }]),
        entry(2, [answer([text("answer", 20)], { usage })]),
        entry(3, [], {
            edits: [
                {
                    target: 1,
                    action: "replace",
                    messages: [{ role: "user", parts: [text("after", 10)], tokens: 10 }],
                },
            ],
        }),
    ]);

    assert.equal(model.used, 30);
    assert.equal(model.estimated, true);
    assert.equal(model.parts.user, 10);
});

test("large ordinary histories retain every item and compose every request", () => {
    const entries = Array.from({ length: 40001 }, (_, index) =>
        entry(index + 1, [answer([text("a")])]),
    );
    const model = inspect(entries);

    assert.equal(model.items.length, 40001);
    assert.equal(model.steps.length, 40001);
    assert.equal(model.used, 40001);
    assert.equal(model.steps.at(-1)!.parts.answers, 40000);
});
