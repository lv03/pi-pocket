// Context Insight route coverage uses the real extension HTTP surface and isolated durable storage.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
    AssistantEntry,
    SystemEntry,
    ToolResultEntry,
    UserEntry,
    type ConversationId,
    type EntryId,
    UsageDoc,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { createHandler } from "../src/server/http.ts";
import { InspectionDoc } from "../src/server/context-inspection.ts";
import type { ToolActivityRow } from "../src/server/tool-activity.ts";

const dataDir = join(root, "context-insight-routes-data");
const moduleName = "context-insight";
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base: string;
let session: ConversationId;
const tokens: Record<string, string> = {};

const usage = (input = 10, output = 4, cost = 0.25): Usage => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
});

async function start(): Promise<void> {
    app = await openApp(scriptedModel(), dataDir);
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    tokens.owner = app.config.ownerToken;
    tokens.guest ??= app.config.addUser("route guest", "guest").token;
}

async function stop(): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
}

async function call(path: string, who = "owner", body?: object) {
    const response = await fetch(`${base}/api/x/${moduleName}/${path}`, {
        method: body === undefined ? "GET" : "PUT",
        headers: {
            authorization: `Bearer ${tokens[who]}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();

    return { status: response.status, text };
}

async function body(path: string, who = "owner", value?: object): Promise<any> {
    const result = await call(path, who, value);

    assert.equal(result.status, 200, `${path}: ${result.text}`);

    return JSON.parse(result.text);
}

async function append(
    id: ConversationId,
    entry: typeof UserEntry | typeof AssistantEntry | typeof SystemEntry,
    model: Message[],
    extra: Record<string, unknown> = {},
) {
    return app.harness.commit((tx) => tx.appendEntry(entry, id, { ...extra, model }), context);
}

async function appendTool(id: ConversationId, model: Message[]) {
    return app.harness.commit(
        (tx) => tx.appendEntry(ToolResultEntry, id, { model, data: { diagnostics: [] } }),
        context,
    );
}

async function appendEdit(id: ConversationId, target: EntryId, text: string) {
    return app.harness.commit(
        (tx) =>
            tx.appendEntry(UserEntry, id, {
                edits: [
                    {
                        target,
                        action: "replace",
                        messages: [
                            {
                                role: "user",
                                content: text,
                                timestamp: 1_700_000_010_000,
                            } as Message,
                        ],
                    },
                ],
            }),
        context,
    );
}

before(async () => {
    await start();
    session = await newSession(app);
});

after(async () => {
    await stop();
    cleanUp();
});

test("route reads expose native context, exact edits, ordering, search, and diff bases", async () => {
    const system = await append(session, SystemEntry, [
        {
            role: "system",
            timestamp: 1_700_000_000_000,
            content: "system baseline",
            sections: { preamble: "preamble text", skills: "skill text" },
            toolsAdded: [
                {
                    name: "read",
                    description: "Read a file",
                    parameters: { type: "object" },
                    tokens: 8,
                    source: "coding-tools",
                },
            ],
        } as unknown as Message,
    ]);
    const original = await append(session, UserEntry, [
        { role: "user", content: "old source text", timestamp: 1_700_000_000_000 } as Message,
    ]);
    const calls = await append(session, AssistantEntry, [
        {
            ...fauxAssistantMessage(
                [
                    { ...fauxToolCall("read", { path: "src/b.ts", offset: 1, limit: 2 }), id: "b" },
                    {
                        ...fauxToolCall("write", { path: "src/a.ts", content: "one\ntwo" }),
                        id: "a",
                    },
                    { ...fauxToolCall("bash", { command: "printf route-command" }), id: "cmd" },
                    {
                        ...fauxToolCall("subagent", {
                            action: "spawn",
                            name: "helper",
                            message: "Please inspect the route",
                        }),
                        id: "ask",
                    },
                ],
                { stopReason: "toolUse" },
            ),
            timestamp: 1_700_000_001_000,
            provider: "faux",
            model: "faux-1",
            usage: usage(),
        } as Message,
    ]);
    const resultA = await appendTool(session, [
        {
            role: "toolResult",
            toolCallId: "a",
            toolName: "write",
            content: [{ type: "text", text: "written A" }],
            isError: false,
            timestamp: 1_700_000_002_000,
            details: { complete: true },
            usage: usage(1, 1, 0.05),
        } as Message,
    ]);
    const resultB = await appendTool(session, [
        {
            role: "toolResult",
            toolCallId: "b",
            toolName: "read",
            content: [{ type: "text", text: "B result" }],
            isError: false,
            timestamp: 1_700_000_003_000,
            details: { returned: { startLine: 1, endLine: 2 }, complete: true },
        } as Message,
    ]);
    const commandResult = await appendTool(session, [
        {
            role: "toolResult",
            toolCallId: "cmd",
            toolName: "bash",
            content: [{ type: "text", text: "route-command" }],
            isError: false,
            timestamp: 1_700_000_004_000,
            durationMs: 7,
            details: { status: "ok", durationMs: 7 },
        } as Message,
    ]);

    await appendTool(session, [
        {
            role: "toolResult",
            toolCallId: "ask",
            toolName: "subagent",
            content: [{ type: "text", text: "started" }],
            isError: false,
            timestamp: 1_700_000_005_000,
        } as Message,
    ]);
    const report = await append(session, UserEntry, [
        {
            role: "user",
            content: "[subagent helper] report from the helper",
            timestamp: 1_700_000_006_000,
        } as Message,
    ]);
    const later = await append(session, UserEntry, [
        {
            role: "user",
            content: "needle-later complete server search",
            timestamp: 1_700_000_007_000,
        } as Message,
    ]);
    const failed = await append(session, AssistantEntry, [
        {
            ...fauxAssistantMessage([fauxText("failed response")], {
                stopReason: "error",
                errorMessage: "provider failed",
            }),
            timestamp: 1_700_000_008_000,
            provider: "faux",
            model: "faux-1",
            usage: usage(3, 0, 0.1),
        } as Message,
    ]);
    const replacement = await appendEdit(session, original.id, "replacement exact text");
    const final = await append(session, AssistantEntry, [
        {
            ...fauxAssistantMessage([fauxText("final response")]),
            timestamp: 1_700_000_009_000,
            provider: "faux",
            model: "faux-1",
            usage: usage(5, 2, 0.2),
        } as Message,
    ]);

    const stats = await body(`session/${session}`);

    assert.equal(stats.stats.through, Number(final.id));
    assert.ok(stats.stats.sections.some((section: { key: string }) => section.key === "preamble"));
    assert.ok(stats.stats.tools.some((tool: { name: string }) => tool.name === "read"));
    assert.ok(stats.stats.steps.some((step: { id: number }) => step.id === Number(failed.id)));
    assert.ok(stats.stats.events.some((event: { kind: string }) => event.kind === "error"));

    const items = await body(`items/${session}?limit=800`);

    assert.ok(
        items.items.some((item: { preview: string }) =>
            item.preview.includes("replacement exact text"),
        ),
    );
    const selected = items.items.find((item: { preview: string }) =>
        item.preview.includes("replacement exact text"),
    );

    assert.ok(selected);
    assert.deepEqual(selected.locator.edit?.target, Number(original.id));
    const exact = await body(`detail/${session}?key=${encodeURIComponent(selected.key)}`);

    assert.equal(exact.item.text, "replacement exact text");
    assert.equal(exact.item.locator.edit.target, Number(original.id));

    const schema = items.items.find((item: { role: string }) => item.role === "schema");

    assert.ok(schema);
    const schemaDetail = await body(`detail/${session}?key=${encodeURIComponent(schema.key)}`);

    assert.equal(schemaDetail.item.role, "schema");
    assert.deepEqual(schemaDetail.item.parameters, { type: "object" });

    const searched = await body(`items/${session}?q=NEEDLE-LATER&limit=1`);

    assert.equal(searched.total, 1);
    assert.match(searched.items[0].preview, /needle-later/);

    const files = await body(`history/${session}/files?offset=0&limit=1`);

    assert.equal(files.total, 2);
    assert.equal(files.rows.length, 1);
    assert.equal(files.more, 1);
    const commands = await body(`history/${session}/commands?offset=0&limit=1`);

    assert.equal(commands.total, 1);
    assert.equal(commands.rows[0].command, "printf route-command");
    const comms = await body(`history/${session}/comms?offset=0&limit=1`);

    const commsNext = await body(`history/${session}/comms?offset=1&limit=1`);

    assert.equal(comms.total, 2);
    assert.equal(comms.rows.length, 1);
    assert.equal(comms.more, 1);
    assert.ok(
        [...comms.rows, ...commsNext.rows].some((row: { text: string }) =>
            row.text.includes("route"),
        ),
    );

    const steps = stats.stats.steps as { id: number; turn: number }[];

    assert.ok(steps.length >= 3);
    const current = Number(final.id);
    const previous = steps[steps.length - 2]!;
    const byPrevious = await body(`diff/${session}/${current}?base=previous`);

    assert.equal(byPrevious.base, previous.id);
    const byTurn = await body(`diff/${session}/${current}?base=turn`);

    assert.ok(byTurn.base === null || typeof byTurn.base === "number");
    const byId = await body(`diff/${session}/${current}?base=${Number(calls.id)}`);

    assert.equal(byId.base, Number(calls.id));
    assert.equal((await call(`diff/${session}/${current}?base=999999`)).status, 400);
    assert.equal((await call(`detail/${session}?key=missing`)).status, 404);
    assert.equal((await call(`items/${session}/0`)).status, 400);
    assert.equal((await call(`history/${session}/steps?limit=nope`)).status, 400);
    assert.equal((await call(`history/${session}/unknown`)).status, 404);
    assert.equal((await call(`session/${session}`, "guest")).status, 404);
    assert.notEqual(Number(system.id), Number(replacement.id));
    assert.notEqual(Number(report.id), Number(later.id));
    assert.notEqual(Number(resultA.id), Number(resultB.id));
    assert.notEqual(Number(commandResult.id), Number(failed.id));
    const nativeResults = items.items.filter((item: { role: string }) => item.role === "tool");

    assert.ok(nativeResults.find((item: { preview: string }) => item.preview.includes("B result")));
    assert.ok(
        nativeResults.find((item: { preview: string }) => item.preview.includes("written A")),
    );
});

test("history revisions stay stable while new entries append, including empty lists", async () => {
    const before = await body(`session/${session}`);
    const through = before.stats.through as number;
    const first = await body(`history/${session}/steps?through=${through}&offset=0&limit=2`);

    await append(session, UserEntry, [
        {
            role: "user",
            content: "appended after revision",
            timestamp: 1_700_000_020_000,
        } as Message,
    ]);
    const stable = await body(`history/${session}/steps?through=${through}&offset=0&limit=2`);

    assert.equal(stable.through, through);
    assert.deepEqual(stable.rows, first.rows);
    assert.equal((await call(`history/${session}/steps?through=999999`)).status, 400);

    const empty = await body(`history/${session}/messages?offset=999999&limit=2`);

    assert.deepEqual(empty.rows, []);
    assert.equal(empty.more, 0);
    assert.equal(empty.next, null);
    assert.equal((await call(`history/${session}/files?offset=-1`)).status, 400);
});

test("insight accounts dated own failures and tools, then exposes undated ledger remainder", async () => {
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, false);
    await app.harness.commit(async (tx) => {
        const totals = await tx.doc(UsageDoc, session);

        totals.models["faux/faux-1"] = {
            input: 18,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 24,
            cost: { input: 0, output: 0.55, cacheRead: 0, cacheWrite: 0, total: 0.55 },
        };
        totals.tools.write = {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        };
    }, context);
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, true);
    const dated = await body(`insight/${session}?tz=0`);

    assert.ok(dated.days["2023-11-14"]);
    assert.ok(dated.days["2023-11-14"].models["faux/faux-1"].cost > 0);
    assert.ok(dated.days["2023-11-14"].tools);
    assert.equal(dated.accounting.complete, true);

    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, false);
    await recordCost(app, session, 1.25);
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, true);
    const withRemainder = await body(`insight/${session}?tz=0`);

    assert.ok(withRemainder.accounting.undated.cost >= 1.25);
    assert.equal(withRemainder.accounting.complete, false);
    const datedBeforeCapture = withRemainder.accounting.dated.cost;

    await recordCost(app, session, 0.75);
    await app.inspection.flush();
    const captured = await body(`insight/${session}?tz=0`);

    assert.ok(captured.accounting.dated.cost - datedBeforeCapture >= 0.74);
    assert.ok(captured.accounting.undated.cost >= 1.24);
    assert.equal((await call(`insight/${session}?tz=841`)).status, 400);
    assert.equal((await call(`insight/${session}?tz=bad`)).status, 400);
});

test("native system content and sections have exact independent counts", async () => {
    const id = await newSession(app);
    const system = await append(id, SystemEntry, [
        {
            role: "system",
            timestamp: 1000,
            content: "BASE123",
            sections: { preamble: "PROMPT1", skills: "SKILLS1" },
        } as Message,
    ]);
    const snapshot = await app.transcripts.modelContext(id, { full: true });

    assert.deepEqual(snapshot.messageOrigins, [{ entryId: Number(system.id), messageIndex: 0 }]);
    assert.equal(snapshot.messages[0]?.role, "system");

    if (snapshot.messages[0]?.role === "system") {
        assert.equal(snapshot.messages[0].content, "BASE123");
        assert.deepEqual(snapshot.messages[0].sections, { preamble: "PROMPT1", skills: "SKILLS1" });
    }

    const items = await body(`items/${id}?limit=800`);

    assert.equal(items.total, 3);
    assert.deepEqual(
        items.items.map((item: { key: string; tokens: number }) => [item.key, item.tokens]),
        [
            ["section:preamble", 2],
            ["section:skills", 2],
            ["section:content", 2],
        ],
    );
    const detail = await body(`detail/${id}?key=section%3Acontent`);
    const stats = (await body(`session/${id}`)).stats;

    assert.equal(detail.item.text, "BASE123");
    assert.equal(stats.used, 6);
    assert.equal(stats.parts.system, 2);
    assert.equal(stats.parts.inject, 2);
    assert.equal(stats.parts.skill, 2);
    assert.equal(stats.sections.length, 3);
});

test("synthetic nested task activity reaches files and commands without changing context", async (t) => {
    const id = await newSession(app);

    await append(id, AssistantEntry, [
        fauxAssistantMessage(
            [{ ...fauxToolCall("codemode", { code: "return null" }), id: "nested-root" }],
            { stopReason: "toolUse" },
        ),
    ]);
    await appendTool(id, [
        {
            role: "toolResult",
            toolCallId: "nested-root",
            toolName: "codemode",
            content: [{ type: "text", text: "parent result" }],
            isError: false,
            timestamp: 1000,
        },
    ]);
    const before = (await body(`session/${id}`)).stats;
    const native = await app.transcripts.modelContext(id, { full: true });
    const rows: ToolActivityRow[] = [
        { toolName: "read", arguments: { path: "nested-only.ts", offset: 2, limit: 1 } },
        { toolName: "write", arguments: { path: "nested-only.ts", content: "new line\n" } },
        { toolName: "bash", arguments: { command: "printf nested-command" } },
    ].map((row, index) => ({
        ...row,
        taskId: 101 + index,
        parentTaskId: 100,
        parentCallId: "nested-root",
        rootCallId: "nested-root",
        callId: `nested-root/${index}`,
        status: "completed",
        startedAt: 100 + index * 10,
        endedAt: 105 + index * 10,
        durationMs: 5,
        outputRecorded: false,
        resultAvailable: false,
    }));
    const original = app.transcripts.toolActivity.bind(app.transcripts);

    t.mock.method(app.transcripts, "toolActivity", async (conversation: ConversationId) =>
        conversation === id ? rows : original(conversation),
    );
    const after = (await body(`session/${id}`)).stats;

    assert.equal(after.files.length, 1);
    assert.equal(after.files[0].path, "nested-only.ts");
    assert.equal(after.files[0].read, 1);
    assert.equal(after.files[0].written, 1);
    assert.deepEqual(
        after.files[0].ops.map((operation: { callId: string }) => operation.callId),
        ["nested-root/0", "nested-root/1"],
    );
    assert.deepEqual(after.files[0].ops[0].requested, { offset: 2, limit: 1 });
    assert.equal(after.files[0].ops[0].outputRecorded, false);
    assert.equal(after.commands.length, 1);
    assert.equal(after.commands[0].command, "printf nested-command");
    assert.equal(after.commands[0].callId, "nested-root/2");
    assert.equal(after.commands[0].status, "unknown");
    assert.equal(after.commands[0].outputRecorded, false);

    for (const key of ["used", "parts", "steps", "events", "usage", "entries", "through"]) {
        assert.deepEqual(after[key], before[key], key);
    }

    const repeated = (await body(`session/${id}`)).stats;
    const agent = (await body(`agent/${id}`)).stats;

    assert.deepEqual(repeated.files, after.files);
    assert.deepEqual(repeated.commands, after.commands);
    assert.deepEqual(agent.files, after.files);
    assert.deepEqual(agent.commands, after.commands);
    assert.deepEqual(await app.transcripts.modelContext(id, { full: true }), native);
    const command = rows[2]!;

    rows[2] = { ...command, resultAvailable: true, result: { isError: false, durationMs: 5 } };
    const retained = (await body(`session/${id}`)).stats;

    assert.equal(retained.commands[0].status, "ok");
    assert.equal(retained.commands[0].outputRecorded, false);
    assert.equal(retained.commands[0].contentComplete, false);
});

test("captured request pages retain revision and global order across appends", async () => {
    const id = await newSession(app);
    const capture = (index: number) => ({
        id: `capture-${index}`,
        startedAt: 1000 + index,
        provider: "faux",
        model: "faux-1",
        outcome: "done" as const,
        accuracy: "normalized-after-hooks" as const,
        messages: [
            {
                role: "user" as const,
                parts: [{ type: "text" as const, text: `input-${index}`, tokens: 2 }],
                tokens: 2,
            },
        ],
    });

    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(InspectionDoc, id);

        doc.requests.push(...Array.from({ length: 5 }, (_, index) => capture(index)));
    }, context);
    const first = await body(`requests/${id}?limit=2`);

    assert.equal(first.through, 5);
    assert.equal(first.total, 5);
    assert.equal(first.next, 2);
    assert.equal(first.more, 3);
    assert.deepEqual(
        first.rows.map((row: { id: string; order: number }) => [row.id, row.order]),
        [
            ["capture-3", 3],
            ["capture-4", 4],
        ],
    );
    assert.ok(
        first.rows.every(
            (row: { messages?: unknown; messageCount: number }) =>
                row.messages === undefined && row.messageCount === 1,
        ),
    );

    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(InspectionDoc, id);

        doc.requests.push(capture(5), capture(6));
    }, context);
    assert.deepEqual(await body(`requests/${id}?through=5&limit=2`), first);
    const second = await body(`requests/${id}?through=5&offset=${first.next}&limit=2`);
    const last = await body(`requests/${id}?through=5&offset=${second.next}&limit=2`);

    assert.equal(second.through, 5);
    assert.equal(second.total, 5);
    assert.equal(second.next, 4);
    assert.equal(last.next, null);
    assert.equal(last.more, 0);
    assert.deepEqual(
        [...first.rows, ...second.rows, ...last.rows]
            .sort((a, b) => a.order - b.order)
            .map((row) => [row.id, row.order]),
        Array.from({ length: 5 }, (_, index) => [`capture-${index}`, index]),
    );
    const fresh = await body(`requests/${id}?limit=2`);

    assert.equal(fresh.through, 7);
    assert.equal(fresh.total, 7);
    assert.deepEqual(
        fresh.rows.map((row: { order: number }) => row.order),
        [5, 6],
    );
    assert.equal((await call(`requests/${id}?through=8`)).status, 400);
    const empty = await body(`requests/${id}?through=0&limit=2`);

    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.next, null);
});

test("turn diffs use the first request in the selected turn, including a self baseline", async () => {
    const id = await newSession(app);

    await append(id, UserEntry, [{ role: "user", content: "previous turn", timestamp: 1 }]);
    const previous = await append(id, AssistantEntry, [
        fauxAssistantMessage([fauxText("previous answer")]),
    ]);

    await append(id, UserEntry, [{ role: "user", content: "selected turn", timestamp: 2 }]);
    const first = await append(id, AssistantEntry, [
        fauxAssistantMessage([fauxText("first answer")]),
    ]);
    const middle = await append(id, AssistantEntry, [
        fauxAssistantMessage([fauxText("middle answer")]),
    ]);
    const last = await append(id, AssistantEntry, [
        fauxAssistantMessage([fauxText("last answer")]),
    ]);
    const diff = await body(`diff/${id}/${Number(last.id)}?base=turn`);

    assert.equal(diff.base, Number(first.id));
    assert.notEqual(diff.base, Number(previous.id));
    assert.notEqual(diff.base, Number(middle.id));
    assert.deepEqual(
        diff.added.map((item: { preview: string }) => item.preview),
        ["first answer", "middle answer"],
    );
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.changed, []);
    const self = await body(`diff/${id}/${Number(first.id)}?base=turn`);

    assert.equal(self.base, Number(first.id));
    assert.deepEqual(self.added, []);
    assert.deepEqual(self.removed, []);
    assert.deepEqual(self.changed, []);
});

test("insight applies historical IANA offsets across daylight saving time", async () => {
    const id = await newSession(app);

    for (const timestamp of [
        Date.parse("2026-01-05T04:30:00Z"),
        Date.parse("2026-07-05T04:30:00Z"),
    ]) {
        await append(id, AssistantEntry, [
            {
                ...fauxAssistantMessage([fauxText("dated response")]),
                timestamp,
                usage: usage(),
            },
        ]);
    }

    const local = await body(`insight/${id}?zone=America%2FNew_York`);

    assert.deepEqual(Object.keys(local.days).sort(), ["2026-01-04", "2026-07-05"]);
    assert.equal(local.days["2026-01-04"].tokens, 14);
    assert.equal(local.days["2026-07-05"].tokens, 14);
    assert.equal(local.days["2026-01-04"].steps, 1);
    assert.equal(local.days["2026-07-05"].steps, 1);
    const utc = await body(`insight/${id}?tz=0`);

    assert.deepEqual(Object.keys(utc.days).sort(), ["2026-01-05", "2026-07-05"]);
    assert.equal((await call(`insight/${id}?zone=Not_A_Zone`)).status, 400);
});

test("session catalog includes all sessions beyond the old 60-row boundary", async () => {
    for (let index = 0; index < 64; index++) {
        await newSession(app);
    }

    const catalog = await body("sessions");

    assert.ok(catalog.sessions.length >= 65);
    assert.equal(
        new Set(catalog.sessions.map((item: { id: number }) => item.id)).size,
        catalog.sessions.length,
    );
    assert.equal((await call("sessions", "guest")).status, 404);
});

test("preferences are owner-only, merge values, and survive an app restart", async () => {
    assert.equal((await call("preferences", "guest")).status, 404);
    assert.equal(
        (await call("preferences", "guest", { preferences: { tab: "files" } })).status,
        404,
    );
    assert.equal((await call("preferences", "owner", { preferences: null })).status, 400);
    assert.equal(
        (await call("preferences", "owner", { preferences: { "bad key": true } })).status,
        400,
    );
    const saved = await body("preferences", "owner", {
        preferences: { tab: "files", range: "30", compact: true },
    });

    assert.equal(saved.preferences.tab, "files");
    const merged = await body("preferences", "owner", { preferences: { range: "0" } });

    assert.equal(merged.preferences.tab, "files");
    assert.equal(merged.preferences.range, "0");

    await stop();
    await start();
    assert.equal(app.loader.enabled(`${moduleName}.ts`), true);
    const afterRestart = await body("preferences");

    assert.equal(afterRestart.preferences.tab, "files");
    assert.equal(afterRestart.preferences.range, "0");

    const totals = await app.harness.snapshot(UsageDoc, session, context);

    assert.ok(totals !== undefined);
});
