// Native context and inspection capabilities use isolated data and a scripted model.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
    AgentDoc,
    AssistantEntry,
    defineEntry,
    type ConversationId,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type {
    ConversationWebRequest,
    ModelContextSnapshot,
    UsageHistory,
} from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { zeroUsage } from "../src/server/context-inspection.ts";
import { SubagentsDoc } from "../src/server/docs.ts";

const dataDir = join(root, "inspection-data");
const Raw = defineEntry("pocket.inspection-test");
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base: string;
let lastRequest: Message[] = [];
const retained = globalThis as unknown as {
    inspectionRequest?: ConversationWebRequest;
    inspectionGate?: Promise<void>;
};

before(async () => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "inspection-test.ts"),
        `/** Inspection test module. */
import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
export default (_host, web) => {
    web.conversationRoute("GET", "bound/:id", async (request) => {
        globalThis.inspectionRequest = request;
        if (request.query.has("wait")) await globalThis.inspectionGate;
        return request.modelContext({full: true});
    }, {conversation: "id", access: "view"});
    web.route("GET", "context/:id", (request) => request.modelContextOf(Number(request.params.id), {at: request.query.has("at") ? Number(request.query.get("at")) : undefined, full: true}), {access: "view"});
    web.route("GET", "usage/:id", (request) => request.usageHistoryOf(Number(request.params.id)), {access: "view"});
    web.route("GET", "agents/:id", (request) => request.subagentsOf(Number(request.params.id)), {access: "view"});
    web.route("GET", "relations", (request) => request.relationships(), {access: "view"});
    return defineExtension({name: "inspection-test", hooks: [hook(GenerationTask, {
        beforeRequest: ({messages}) => ({messages: [...messages, {role: "user", content: "added after native context", timestamp: 123}]}),
    })]});
};
`,
    );
    app = await openApp(
        scriptedModel((request) => {
            lastRequest = structuredClone(request.messages) as Message[];

            return fauxAssistantMessage([fauxText("A measured answer.")]);
        }),
        dataDir,
    );
    await app.setExtensionEnabled(owner(app), "inspection-test.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    cleanUp();
});

async function get(path: string, token = app.config.ownerToken) {
    const response = await fetch(`${base}/api/x/inspection-test/${path}`, {
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
    });

    return { status: response.status, body: await response.json() };
}

async function append(id: ConversationId, messages: unknown[]) {
    return app.harness.commit(
        (tx) => tx.appendEntry(Raw, id, { model: messages as Message[] }),
        context,
    );
}

test("native context preserves edits, tool ordering, synthetic results, and exact message origins", async () => {
    const id = await newSession(app);
    const original = await append(id, [{ role: "user", content: "old text", timestamp: 1 }]);
    const assistant = await append(id, [
        {
            ...fauxAssistantMessage([], { stopReason: "toolUse" }),
            content: [
                { type: "toolCall", id: "b", name: "read", arguments: {} },
                { type: "toolCall", id: "a", name: "read", arguments: {} },
                { type: "toolCall", id: "missing", name: "read", arguments: {} },
            ],
        },
    ]);
    const later = await append(id, [
        { role: "user", content: "between calls and results", timestamp: 2 },
    ]);
    const resultA = await append(id, [
        {
            role: "toolResult",
            toolCallId: "a",
            toolName: "read",
            content: [{ type: "text", text: "A" }],
            isError: false,
            timestamp: 3,
        },
    ]);
    const resultB = await append(id, [
        {
            role: "toolResult",
            toolCallId: "b",
            toolName: "read",
            content: [{ type: "text", text: "B" }],
            isError: false,
            timestamp: 4,
        },
    ]);
    const edit = await app.harness.commit(
        (tx) =>
            tx.appendEntry(Raw, id, {
                edits: [
                    {
                        action: "replace",
                        target: original.id,
                        messages: [{ role: "user", content: "replacement", timestamp: 5 }],
                    },
                ],
            }),
        context,
    );
    const native = await (await app.conversation(id)).context(context);
    const snapshot = await app.transcripts.modelContext(id, { full: true });

    assert.deepEqual(
        snapshot.messages.map((message) => message.role),
        native.messages.map((message) => message.role),
    );
    assert.deepEqual(snapshot.messageOrigins, [
        {
            entryId: Number(edit.id),
            messageIndex: 0,
            editIndex: 0,
            targetEntryId: Number(original.id),
        },
        { entryId: Number(assistant.id), messageIndex: 0 },
        { entryId: Number(resultB.id), messageIndex: 0 },
        { entryId: Number(resultA.id), messageIndex: 0 },
        { synthetic: true },
        { entryId: Number(later.id), messageIndex: 0 },
    ]);
    assert.equal(snapshot.messages[4]!.role, "toolResult");
    assert.equal(snapshot.accuracy.context, "native-durable");
});

test("a replacement image keeps its locator when an older head marker leaves native active entries", async () => {
    const id = await newSession(app);
    const original = await append(id, [{ role: "user", content: "original", timestamp: 1 }]);
    const edit = await app.harness.commit(
        (tx) =>
            tx.appendEntry(Raw, id, {
                head: original.id,
                edits: [
                    {
                        action: "replace",
                        target: original.id,
                        messages: [
                            {
                                role: "user",
                                timestamp: 2,
                                content: [
                                    { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
                                ],
                            },
                        ],
                    },
                ],
            }),
        context,
    );

    await app.harness.commit((tx) => tx.appendEntry(Raw, id, { head: original.id }), context);
    const snapshot = await app.transcripts.modelContext(id, { full: true });

    assert.equal(
        snapshot.entries.some((entry) => entry.id === Number(edit.id)),
        false,
    );
    assert.deepEqual(snapshot.messageOrigins, [
        {
            entryId: Number(edit.id),
            messageIndex: 0,
            editIndex: 0,
            targetEntryId: Number(original.id),
        },
    ]);
    const image = await app.transcripts.entryImage(id, Number(edit.id), 0, {
        messageIndex: 0,
        editIndex: 0,
    });

    assert.equal(image?.data.toString(), "hello");
    assert.doesNotMatch(JSON.stringify(snapshot), /aGVsbG8=/);
});

test("source, stream timing, tool details, nested operations, and image metadata survive projection", async () => {
    const id = await newSession(app);
    const picture = { type: "image", mimeType: "image/png", data: "aGVsbG8=", width: 2, height: 3 };

    await append(id, [
        { role: "user", content: [picture], timestamp: 11, source: { kind: "linked", id: 9 } },
        {
            ...fauxAssistantMessage([fauxText("answer")]),
            timestamp: 12,
            pocketTiming: { startedAt: 10, firstTokenAt: 11, endedAt: 12 },
        },
        {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            content: [picture],
            timestamp: 13,
            durationMs: 9,
            usage: zeroUsage(),
            details: { nested: { path: "file.ts" }, image: picture },
            nestedCalls: {
                complete: true,
                calls: [
                    {
                        id: "nested",
                        name: "bash",
                        arguments: { command: "pwd" },
                        status: "ok",
                        durationMs: 5,
                    },
                ],
            },
            isError: false,
        },
    ]);
    const page = await app.transcripts.transcript(id, { full: true });
    const [user, assistant, tool] = page.entries[0]!.messages!;

    assert.ok(user && assistant && tool);
    assert.equal(page.entries[0]!.conversationId, Number(id));
    assert.equal(user!.role, "user");
    assert.deepEqual(user!.role === "user" && user.source, { kind: "linked", id: 9 });
    assert.deepEqual(user!.role === "user" && user.parts[0], {
        type: "image",
        mimeType: "image/png",
        tokens: 1372,
        imageIndex: 0,
        width: 2,
        height: 3,
        byteSize: 5,
    });
    assert.deepEqual(assistant!.role === "assistant" && assistant.pocketTiming, {
        startedAt: 10,
        firstTokenAt: 11,
        endedAt: 12,
    });
    assert.equal(tool!.at, 13);
    assert.equal(tool!.role === "toolResult" && tool.durationMs, 9);
    assert.match(JSON.stringify(tool), /nested/);
    assert.doesNotMatch(JSON.stringify(page), /aGVsbG8=/);
});

test("modelContext at reads preserve fork bounds and reject invisible or invalid entries", async () => {
    const id = await newSession(app);

    await say(app, id, "before fork");
    const history = await app.transcripts.transcript(id, { full: true });
    const answer = history.entries.findLast((entry) => entry.kind === "pi.assistant")!;
    const fork = await app.commands.fork(id, owner(app), { entryId: answer.id });
    const future = await append(id, [{ role: "user", content: "parent future", timestamp: 77 }]);
    const inherited = await get(`context/${fork.id}?at=${answer.id}`);

    assert.equal(inherited.status, 200);
    assert.ok(
        (inherited.body as ModelContextSnapshot).entries.some(
            (entry) => entry.conversationId === Number(id),
        ),
    );
    assert.equal((await get(`context/${fork.id}?at=${future.id}`)).status, 404);
    assert.equal((await get(`context/${id}?at=-1`)).status, 400);
    assert.equal((await get(`context/${id}?at=1.5`)).status, 400);
    assert.doesNotMatch(
        JSON.stringify((await app.transcripts.modelContext(fork.id, { full: true })).messages),
        /parent future/,
    );
});

test("read capabilities expire and recheck access while asynchronous work waits", async () => {
    const id = await newSession(app);
    const first = await get(`bound/${id}`);

    assert.equal(first.status, 200);
    await assert.rejects(() => retained.inspectionRequest!.modelContext(), /ended/);

    const viewer = app.config.addUser("inspection viewer", "viewer");
    let release!: () => void;

    retained.inspectionGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const waiting = get(`bound/${id}?wait=1`, viewer.token);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const current = app.config.userById(viewer.user.id)!;

    current.sessions = [String(id)];
    release();
    assert.equal((await waiting).status, 403);
});

test("historical accounting dates own entry usage and leaves missing costs undated", async () => {
    const id = await newSession(app);
    const usage = zeroUsage();

    usage.cost.total = 1;
    usage.cost.output = 1;
    const response = fauxAssistantMessage([fauxText("historical")]);
    const entry = await app.harness.commit(
        (tx) =>
            tx.appendEntry(AssistantEntry, id, {
                model: [{ ...response, usage, timestamp: 1000 }],
            }),
        context,
    );

    await recordCost(app, id, 4);
    const history = await app.inspection.usageHistory(id);

    assert.equal(history.known.models["faux/faux-1"]!.cost.total, 1);
    assert.equal(history.undated.models["faux/faux-1"]!.cost.total, 3);
    assert.equal(history.events[0]!.at, 1000);
    const fork = await app.commands.fork(id, owner(app), { entryId: entry.id });
    const child = await app.inspection.usageHistory(fork.id);

    assert.equal(child.events.length, 0);
    assert.deepEqual(child.known, { models: {}, tools: {} });
    assert.equal((await get(`usage/${id}`)).status, 200);
});

test("captures final hook messages only while enabled and stores measured responses without image bytes", async () => {
    const id = await newSession(app);

    await say(app, id, "capture disabled");
    assert.equal((await app.inspection.requestHistory(id)).length, 0);
    await app.setExtensionEnabled(owner(app), "context-insight.ts", true);
    const completed: unknown[] = [];
    const updated: unknown[] = [];
    const offCompleted = app.events.on("request.completed", (event) => completed.push(event));
    const offUsage = app.events.on("usage.updated", (event) => updated.push(event));

    await say(app, id, "capture enabled");
    const captures = await app.inspection.requestHistory(id);

    assert.equal(captures.length, 1);
    assert.equal(captures[0]!.outcome, "done");
    assert.ok(
        captures[0]!.messages.some(
            (message) =>
                message.role === "user" &&
                message.parts.some(
                    (part) => part.type === "text" && part.text === "added after native context",
                ),
        ),
    );
    assert.equal(lastRequest.at(-1)!.role, "user");
    assert.equal(captures[0]!.response?.role, "assistant");
    assert.ok(captures[0]!.response?.role === "assistant" && captures[0]!.response.pocketTiming);
    assert.equal(completed.length, 1);
    assert.ok(updated.length > 0);
    offCompleted();
    offUsage();
    await app.setExtensionEnabled(owner(app), "context-insight.ts", false);
    await say(app, id, "disabled again");
    assert.equal((await app.inspection.requestHistory(id)).length, 1);
    assert.equal(completed.length, 1);
});

test("direct subagents are unbounded and relationships retain parent and session identity", async () => {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        const agents = await tx.doc(SubagentsDoc, id);

        for (let index = 0; index < 30; index++) {
            const child = await tx.createConversation({ ownership: { kind: "ownerless" } });

            await tx.doc(AgentDoc, child.id);
            agents.agents["helper-" + index] = {
                conversationId: child.id,
                reported: [],
                answeredAt: 100 + index,
            };
        }
    }, context);

    const first = app.subagentsOf(id)[0]!.conversationId;

    await app.harness.commit(async (tx) => {
        const nested = await tx.createConversation({ ownership: { kind: "ownerless" } });

        await tx.doc(AgentDoc, nested.id);
        (await tx.doc(SubagentsDoc, first)).agents.nested = {
            conversationId: nested.id,
            reported: [],
            answeredAt: 200,
        };
    }, context);
    assert.equal(app.subagentsOf(first).length, 1);
    assert.equal((await get("agents/" + first)).body.length, 1);
    const direct = await get("agents/" + id);

    assert.equal(direct.status, 200);
    assert.equal(direct.body.length, 30);
    assert.equal(app.subagentsOf(id).length, 30);
    assert.equal(app.subagents(owner(app)).filter((agent) => agent.id === Number(id)).length, 24);
    const relationships = await get("relations");

    assert.equal(relationships.status, 200);
    assert.equal(
        relationships.body.filter(
            (item: { sessionId: number; parentId?: number }) =>
                item.sessionId === Number(id) && item.parentId === Number(id),
        ).length,
        30,
    );
});

test("captured usage commits reconcile new entryless bills without inventing old dates", async () => {
    const id = await newSession(app);

    await recordCost(app, id, 2);
    await app.setExtensionEnabled(owner(app), "context-insight.ts", true);
    await recordCost(app, id, 3);
    await app.inspection.flush();
    const history = await app.inspection.usageHistory(id);

    assert.equal(history.events.filter((event) => event.source === "usage-commit").length, 1);
    assert.equal(history.known.models["faux/faux-1"]!.cost.total, 3);
    assert.equal(history.undated.models["faux/faux-1"]!.cost.total, 2);
    const total =
        history.known.models["faux/faux-1"]!.cost.total +
        history.undated.models["faux/faux-1"]!.cost.total;

    assert.equal(total, history.totals!.models["faux/faux-1"]!.cost.total);
    const fromRoute = (await get(`usage/${id}`)).body as UsageHistory;

    assert.equal(fromRoute.undated.models["faux/faux-1"]!.cost.total, 2);
    await app.setExtensionEnabled(owner(app), "context-insight.ts", false);
});
