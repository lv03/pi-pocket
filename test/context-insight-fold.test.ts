import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageState } from "@earendil-works/pi-durable";
import { CATEGORIES, fold, usageOf } from "../src/server/context-insight.ts";
import type { Parts } from "../src/server/context-insight.ts";
import type { TranscriptEntry, TranscriptMessage, TranscriptPart } from "../src/server/host.ts";

type Assistant = Extract<TranscriptMessage, { role: "assistant" }>;
type System = Extract<TranscriptMessage, { role: "system" }>;

function text(value: string, tokens = 10): TranscriptPart {
    return { type: "text", text: value, tokens };
}

function user(id: number, value: string, tokens = 10): TranscriptEntry {
    return {
        id,
        kind: "pi.user",
        at: id * 100,
        messages: [{ role: "user", parts: [text(value, tokens)], tokens }],
    };
}

function assistant(id: number, changes: Partial<Assistant> = {}): TranscriptEntry {
    return {
        id,
        kind: "pi.assistant",
        at: id * 100,
        messages: [
            {
                role: "assistant",
                parts: [text("answer")],
                tokens: 10,
                provider: "test",
                model: "small",
                stopReason: "stop",
                ...changes,
            },
        ],
    };
}

function system(id: number, changes: Partial<System>): TranscriptEntry {
    return {
        id,
        kind: "pi.system",
        messages: [{ role: "system", content: "", tokens: 0, ...changes }],
    };
}

function billed(input = 60, output = 20): NonNullable<Assistant["usage"]> {
    return {
        input,
        output,
        cacheRead: 30,
        cacheWrite: 10,
        reasoning: 5,
        totalTokens: input + output + 40,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    };
}

function sum(parts: Parts): number {
    return CATEGORIES.reduce((total, category) => total + parts[category], 0);
}

function inspect(entries: readonly TranscriptEntry[], usage: UsageState | null = null) {
    return fold(entries, usage, (provider, model) =>
        provider === "test" && model === "small" ? 1000 : undefined,
    );
}

function call(id: number, name: string, args: unknown): TranscriptEntry {
    return assistant(id, {
        stopReason: "toolUse",
        parts: [{ type: "toolCall", id: `call-${id}`, name, arguments: args, tokens: 5 }],
    });
}

function result(id: number, called: number, name: string, isError = false): TranscriptEntry {
    return {
        id,
        kind: "pi.tool-result",
        at: id * 100,
        messages: [
            {
                role: "toolResult",
                callId: `call-${called}`,
                name,
                parts: [text("done\nmore")],
                tokens: 10,
                isError,
            },
        ],
    };
}

test("empty context has no measurement or model window", () => {
    const model = inspect([]);

    assert.equal(model.used, 0);
    assert.equal(model.estimated, true);
    assert.equal(sum(model.parts), 0);
    assert.deepEqual(model.items, []);
    assert.equal(model.window, undefined);
    assert.equal(model.model, undefined);
});

test("current context uses billed usage, exact category totals, and later message estimates", () => {
    const entries = [
        system(1, {
            sections: { preamble: "base", skills: "skill" },
            tools: [{ name: "read", tokens: 7 }],
        }),
        user(2, "question"),
        assistant(3, { usage: billed() }),
    ];
    const usage: UsageState = { models: { "test/small": billed() }, tools: {} };
    const measured = inspect(entries, usage);
    const later = inspect([...entries, user(4, "next", 11)], usage);
    const step = measured.steps[0]!;

    assert.equal(measured.used, 120);
    assert.equal(measured.estimated, false);
    assert.equal(measured.percent, 12);
    assert.equal(measured.usage, usage);
    assert.equal(sum(measured.parts), measured.used);
    assert.equal(sum(step.parts), 100);
    assert.equal(step.prompt, 100);
    assert.equal(step.reasoning, 5);
    assert.equal(step.total, 120);
    assert.equal(step.cost, 0.02);
    assert.equal(step.user, "question");
    assert.equal(later.used, 131);
    assert.equal(later.estimated, true);
    assert.deepEqual([later.firstAt, later.lastAt], [200, 400]);
});

test("usage fallback includes caches and counts reasoning within output", () => {
    const message = assistant(1, { usage: { ...billed(), totalTokens: 0 } }).messages![0]!;

    assert.equal(usageOf(message).total, 120);
    assert.equal(usageOf({ role: "user", parts: [], tokens: 0 }).total, 0);
});

test("new prompt text with the same token count replaces the preview and emits a section event", () => {
    const model = inspect([
        system(1, { sections: { instructions: "old", skills: "skill" } }),
        system(2, { sections: { instructions: "new", skills: null } }),
    ]);

    assert.deepEqual(
        model.sections.map((section) => section.key),
        ["instructions"],
    );
    assert.equal(model.items[0]!.preview, "new");
    assert.equal(model.events.filter((event) => event.kind === "tools").length, 0);
    assert.ok(model.events.some((event) => event.detail === "instructions changed"));
    assert.ok(model.events.some((event) => event.detail === "skills removed"));
});

test("tool changes remove before adding and retain the current tool source", () => {
    const model = inspect([
        system(1, {
            tools: [
                { name: "read", tokens: 10, source: "old" },
                { name: "bash", tokens: 5, source: "shell" },
            ],
        }),
        system(2, {
            toolsRemoved: ["read", "bash"],
            tools: [{ name: "read", tokens: 12, source: "files" }],
        }),
    ]);

    assert.deepEqual(model.tools, [{ name: "read", tokens: 12, source: "files" }]);
    assert.equal(model.parts.tools, 12);
    assert.equal(model.items.find((item) => item.role === "schema")!.source, "files");
});

test("compaction keeps the selected history after the summary and discards the old measurement", () => {
    const model = inspect([
        user(1, "old"),
        assistant(2, { usage: billed() }),
        user(3, "keep", 7),
        {
            id: 4,
            kind: "pi.compaction",
            head: 3,
            data: { reason: "threshold" },
            messages: [{ role: "user", parts: [text("summary", 5)], tokens: 5 }],
        },
    ]);

    assert.equal(model.used, 12);
    assert.equal(model.estimated, true);
    assert.deepEqual(
        model.items.map((item) => item.entry),
        [4, 3],
    );
    assert.equal(model.parts.inject, 5);
    assert.equal(model.parts.user, 7);
    assert.ok(model.events.some((event) => event.detail === "the window reached its limit"));
});

test("a second compaction excludes the prior head marker even when its id is in the kept range", () => {
    const model = inspect([
        user(1, "keep", 7),
        {
            id: 2,
            kind: "pi.compaction",
            head: 1,
            messages: [{ role: "user", parts: [text("old summary", 50)], tokens: 50 }],
        },
        {
            id: 3,
            kind: "pi.compaction",
            head: 1,
            messages: [{ role: "user", parts: [text("new summary", 5)], tokens: 5 }],
        },
    ]);

    assert.equal(model.used, 12);
    assert.deepEqual(
        model.items.map((item) => item.entry),
        [3, 1],
    );
});

test("reset removes the old prompt and tools and keeps its handoff", () => {
    const model = inspect([
        system(1, { sections: { preamble: "old" }, tools: [{ name: "old", tokens: 100 }] }),
        assistant(2, { usage: billed() }),
        {
            id: 3,
            kind: "pi.reset",
            head: 3,
            messages: [{ role: "user", parts: [text("handoff", 5)], tokens: 5 }],
        },
        system(4, { sections: { instructions: "new" }, tools: [{ name: "new", tokens: 2 }] }),
    ]);

    assert.equal(model.used, 8);
    assert.equal(model.estimated, true);
    assert.deepEqual(
        model.sections.map((section) => section.key),
        ["instructions"],
    );
    assert.deepEqual(
        model.tools.map((tool) => tool.name),
        ["new"],
    );
    assert.deepEqual(
        model.items.filter((item) => item.entry !== 0).map((item) => item.entry),
        [3],
    );
    assert.ok(model.events.some((event) => event.detail === "a new context, with a handoff"));
});

test("the system baseline after compaction honors edits that omit retained system entries", () => {
    const baseline = system(4, {
        sections: { instructions: "new" },
        tools: [{ name: "new", tokens: 2, source: "core" }],
    });
    const model = inspect([
        system(1, { sections: { preamble: "obsolete" }, tools: [{ name: "old", tokens: 100 }] }),
        user(2, "keep"),
        { id: 3, kind: "pi.compaction", head: 1 },
        { ...baseline, edits: [{ target: 1, action: "omit" }] },
    ]);

    assert.deepEqual(
        model.sections.map((section) => section.key),
        ["instructions"],
    );
    assert.deepEqual(
        model.tools.map((tool) => tool.name),
        ["new"],
    );
    assert.equal(model.parts.tools, 2);
});

test("edits replace and omit contributions, including the measured assistant", () => {
    const model = inspect([
        user(1, "old", 100),
        assistant(2, { usage: billed() }),
        {
            id: 3,
            kind: "custom.edit",
            edits: [
                {
                    target: 1,
                    action: "replace",
                    messages: [{ role: "user", parts: [text("new", 3)], tokens: 3 }],
                },
                { target: 2, action: "omit" },
            ],
        },
    ]);

    assert.equal(model.used, 3);
    assert.equal(model.estimated, true);
    assert.deepEqual(
        model.items.map((item) => item.preview),
        ["new"],
    );
    assert.equal(model.steps.length, 1);
});

test("head ranges retain edits on older head markers and can restore earlier history", () => {
    const model = inspect([
        user(1, "discard", 50),
        user(2, "keep", 10),
        {
            id: 3,
            kind: "pi.compaction",
            head: 2,
            edits: [
                {
                    target: 2,
                    action: "replace",
                    messages: [{ role: "user", parts: [text("replacement", 4)], tokens: 4 }],
                },
            ],
        },
        { id: 4, kind: "pi.compaction", head: 2 },
    ]);
    const restored = inspect([
        user(1, "restored", 10),
        { id: 2, kind: "pi.compaction", head: 2 },
        { id: 3, kind: "pi.compaction", head: 1 },
    ]);

    assert.equal(model.used, 4);
    assert.equal(model.items[0]!.preview, "replacement");
    assert.equal(restored.used, 10);
});

test("failed requests stay in history but do not change the active context or successful model", () => {
    const entries: TranscriptEntry[] = [user(1, "question"), assistant(2, { usage: billed() })];

    for (const [index, stopReason] of ["aborted", "error", "deferred"].entries()) {
        entries.push(
            assistant(index + 3, {
                stopReason,
                error: "failed",
                model: "failed-model",
                usage: billed(900),
                parts: [text("discard", 900)],
            }),
        );
    }

    const model = inspect(entries);

    assert.equal(model.used, 120);
    assert.equal(model.estimated, false);
    assert.equal(model.steps.length, 4);
    assert.equal(model.events.filter((event) => event.kind === "error").length, 3);
    assert.equal(
        model.items.some((item) => item.preview === "discard"),
        false,
    );
    assert.deepEqual(model.model, { provider: "test", model: "small" });
    assert.equal(model.window, 1000);
});

test("later system changes contribute an estimate after the last measured answer", () => {
    const model = inspect([
        user(1, "question"),
        assistant(2, { usage: billed() }),
        system(3, { sections: { instructions: "new" }, tokens: 9 }),
    ]);

    assert.equal(model.used, 129);
    assert.equal(model.estimated, true);
});

test("summary and subagent message categories agree with their current context items", () => {
    const model = inspect([user(1, "[subagent helper] report", 7), user(2, "question", 3)]);

    assert.equal(model.parts.inject, 7);
    assert.equal(model.parts.user, 3);
    assert.equal(model.items[0]!.category, "inject");
    assert.equal(model.comms[0]!.name, "helper");
});

test("file operations use matched calls and failed writes do not add changed lines", () => {
    const model = inspect([
        call(1, "read", { path: "a.ts" }),
        result(2, 1, "read"),
        call(3, "write", { path: "a.ts", content: "one\ntwo\n" }),
        result(4, 3, "write"),
        call(5, "edit", { path: "a.ts", edits: [{ oldText: "one\n", newText: "three\nfour\n" }] }),
        result(6, 5, "edit"),
        call(7, "write", { path: "a.ts", content: "not written" }),
        result(8, 7, "write", true),
        call(9, "edit", {
            path: "a.ts",
            edits: [{ oldText: "not removed", newText: "not added" }],
        }),
        result(10, 9, "edit", true),
        call(11, "unknown", { path: "other.ts" }),
        result(12, 11, "unknown"),
        result(13, 99, "write"),
    ]);
    const file = model.files[0]!;

    assert.equal(model.files.length, 1);
    assert.deepEqual([file.path, file.read, file.written, file.edited], ["a.ts", 1, 2, 2]);
    assert.deepEqual([file.added, file.removed], [4, 1]);
    assert.equal(file.ops[1]!.call, 3);
    assert.equal(file.ops[3]!.error, true);
    assert.equal(file.ops[3]!.added, undefined);
    assert.equal(file.ops[4]!.removed, undefined);
});

test("commands preserve failure, output, and duration; subagent calls preserve their message", () => {
    const model = inspect([
        call(1, "bash", { command: "npm test" }),
        result(2, 1, "bash", true),
        call(3, "subagent", { action: "send", name: "helper", message: "check files" }),
        result(4, 3, "subagent"),
    ]);

    assert.deepEqual(model.commands[0], {
        command: "npm test",
        program: "npm",
        status: "error",
        at: 100,
        ms: 100,
        entry: 2,
        output: "done",
    });
    assert.equal(model.comms[0]!.text, "check files");
    assert.equal(model.comms[0]!.dir, "to");
});

test("a measured request after compaction uses the new prompt composition", () => {
    const model = inspect([
        user(1, "old", 500),
        assistant(2, { usage: billed(900) }),
        {
            id: 3,
            kind: "pi.compaction",
            head: 3,
            messages: [{ role: "user", parts: [text("summary", 5)], tokens: 5 }],
        },
        system(4, { sections: { instructions: "new" } }),
        assistant(5, { usage: billed(10, 4) }),
    ]);
    const step = model.steps[1]!;

    assert.equal(model.used, 54);
    assert.equal(model.estimated, false);
    assert.equal(step.parts.user, 0);
    assert.ok(step.parts.inject > 0);
    assert.ok(step.parts.system > 0);
    assert.equal(sum(step.parts), 50);
    assert.equal(step.delta!.user, -model.steps[0]!.parts.user);
});

test("only failed requests leave an estimated context and do not record their tool calls", () => {
    const failedCall = call(2, "write", { path: "ignored.ts", content: "ignored" });
    const failed = failedCall.messages![0] as Assistant;
    const model = inspect([
        user(1, "question", 7),
        { ...failedCall, messages: [{ ...failed, usage: billed(), stopReason: "error" }] },
        result(3, 2, "write", true),
    ]);

    assert.equal(model.estimated, true);
    assert.equal(model.parts.toolCalls, 0);
    assert.equal(model.parts.answers, 0);
    assert.deepEqual(model.files, []);
    assert.equal(model.model, undefined);
});

test("images and reasoning keep their categories in the current estimate", () => {
    const image: TranscriptPart = { type: "image", mimeType: "image/png", tokens: 0 };
    const imageTokens = Math.ceil(4800 / 3.5);
    const model = inspect([
        {
            id: 1,
            kind: "pi.user",
            messages: [{ role: "user", parts: [image], tokens: imageTokens }],
        },
        assistant(2, {
            parts: [{ type: "thinking", text: "reason", tokens: 3 }, text("answer", 4), image],
        }),
    ]);

    assert.equal(model.used, imageTokens * 2 + 7);
    assert.equal(model.parts.user, imageTokens);
    assert.equal(model.parts.answers, imageTokens + 4);
    assert.equal(model.parts.thinking, 3);
    assert.equal(
        model.items.reduce((tokens, item) => tokens + item.tokens, 0),
        model.used,
    );
});

test("edits can give context to an entry that initially contributed no messages", () => {
    for (const original of [
        { id: 1, kind: "custom.entry" },
        assistant(1, { stopReason: "error", parts: [text("discard", 500)] }),
    ]) {
        const model = inspect([
            original,
            {
                id: 2,
                kind: "custom.edit",
                edits: [
                    {
                        target: 1,
                        action: "replace",
                        messages: [{ role: "user", parts: [text("replacement", 4)], tokens: 4 }],
                    },
                ],
            },
        ]);

        assert.equal(model.used, 4);
        assert.equal(model.items[0]!.preview, "replacement");
    }
});
