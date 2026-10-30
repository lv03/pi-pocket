// Context Insight as a built-in: installation, owner-only reads, history, subagents, and module lifecycle.
import {
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import type { ContextModel } from "../src/server/context-insight.ts";
import { createHandler } from "../src/server/http.ts";
import { BUILT_IN_MODULES } from "../src/server/reload.ts";

const dataDir = join(root, "data");
const moduleName = "context-insight";
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base: string;
let session: ConversationId;
let other: ConversationId;
const tokens: Record<string, string> = {};

async function start() {
    app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);

            if (role === "user" && text.includes("delegate")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("subagent", {
                            action: "spawn",
                            name: "helper",
                            message: "Read the task and answer briefly.",
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([
                fauxText(role === "toolResult" ? "Delegated." : `echo: ${text}`),
            ]);
        }),
        dataDir,
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    tokens.owner = app.config.ownerToken;
}

async function stop() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
}

async function call(path: string, who = "owner", body?: object) {
    const response = await fetch(`${base}${path}`, {
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

async function stats(id = session): Promise<ContextModel> {
    const result = await call(`/api/x/${moduleName}/session/${id}`);

    assert.equal(result.status, 200, result.text);

    return (JSON.parse(result.text) as { stats: ContextModel }).stats;
}

before(async () => {
    // An old installation keeps this file, but only the built-in must register the module's routes.
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", `${moduleName}.ts`),
        '/** Old Context Insight. */\nexport default () => { throw new Error("old drop-in loaded"); };\n',
    );
    await start();
    session = await newSession(app);
    other = await newSession(app);

    for (const [name, role, sessions] of [
        ["guest", "guest", undefined],
        ["viewer", "viewer", undefined],
        ["invitee", "guest", [String(session)]],
    ] as const) {
        tokens[name] = app.config.addUser(name, role, sessions ? [...sessions] : undefined).token;
    }
});

after(async () => {
    await stop();
    cleanUp();
});

test("Context Insight is a built-in that starts off and replaces a same-name drop-in", async () => {
    assert.ok(BUILT_IN_MODULES.has(moduleName));

    const modules = app.loader.list().filter((each) => each.file === `${moduleName}.ts`);

    assert.equal(modules.length, 1);
    assert.equal(modules[0]!.source, "built-in");
    assert.equal(modules[0]!.title, "Context Insight");
    assert.equal(modules[0]!.enabled, false);
    assert.equal((await call(`/api/x/${moduleName}/sessions`)).status, 404);
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, true);
    assert.equal(
        app.loader.list().find((each) => each.file === `${moduleName}.ts`)!.error,
        undefined,
    );
    assert.ok(app.loader.extensionNames().includes("pocket-context-insight"));
    assert.equal((await call(`/api/x/${moduleName}/sessions`)).status, 200);
});

test("only the owner gets the routes and bundled browser files", async () => {
    for (const who of ["guest", "viewer", "invitee"]) {
        assert.equal((await call(`/api/x/${moduleName}/session/${session}`, who)).status, 404);
        assert.equal((await call(`/api/x/${moduleName}/agent/${session}`, who)).status, 404);
    }

    const mine = app.webs.clients(owner(app)).find((each) => each.module === moduleName)!;

    assert.ok(mine.url.endsWith("/index.js"));

    for (const file of ["index.js", "format.js", "text.js", "look.css"]) {
        const url = mine.url.replace(/index\.js$/, file);

        assert.equal((await call(url)).status, 200, file);
        assert.equal((await call(url, "guest")).status, 404, file);
    }

    assert.equal((await call(mine.url.replace(/index\.js$/, "fold.ts"))).status, 404);
});

test("existing history and concurrent reads agree and keep following new requests", async () => {
    await say(app, session, "before the dashboard");

    const first = await stats();
    const simultaneous = await Promise.all(Array.from({ length: 6 }, () => stats()));

    assert.ok(first.steps.length >= 1);

    for (const reading of simultaneous) {
        assert.equal(reading.entries, first.entries);
        assert.equal(reading.steps.length, first.steps.length);
        assert.equal(reading.used, first.used);
    }

    await say(app, session, "after the dashboard");

    const next = await stats();
    const empty = await stats(other);

    assert.ok(next.steps.length > first.steps.length);
    assert.equal(new Set(next.steps.map((step) => step.id)).size, next.steps.length);
    assert.equal(empty.steps.length, 0);
    assert.equal(empty.entries, 0);

    const items = await call(`/api/x/${moduleName}/items/${session}`);
    const browser = JSON.parse(items.text) as { items: { preview: string }[]; total: number };

    assert.ok(browser.items.some((item) => item.preview.includes("before the dashboard")));
    assert.ok(browser.total >= browser.items.length);
    assert.equal((await call(`/api/x/${moduleName}/items/${session}/999999`)).status, 404);
});

test("subagent reads, full entries, image cards, and tool sources work from the built-in", async () => {
    await say(app, session, "delegate");
    await until(
        () => app.subagentsOf(session).some((agent) => agent.answeredAt !== undefined),
        "the helper's answer",
    );

    const fleet = await call(`/api/x/${moduleName}/fleet/${session}`);
    const agents = (JSON.parse(fleet.text) as { agents: { conversationId: number }[] }).agents;
    const child = await call(`/api/x/${moduleName}/agent/${agents[0]!.conversationId}`);

    assert.equal(child.status, 200, child.text);
    assert.match(child.text, /Read the task and answer briefly/);
    assert.ok((await stats()).tools.some((tool) => tool.source === "coding-tools"));

    const conversation = await app.conversation(session);
    const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yO5sAAAAASUVORK5CYII=";
    const entry = await conversation.commit(
        (tx) =>
            tx.appendEntry(UserEntry, session, {
                model: [
                    {
                        role: "user",
                        timestamp: Date.now(),
                        content: [
                            { type: "text", text: "A stored picture" },
                            { type: "image", mimeType: "image/png", data: image },
                        ],
                    },
                ],
            }),
        context,
    );
    const picture = await call(`/api/x/${moduleName}/image/${session}/${entry.id}/0`);

    assert.equal(picture.status, 200, picture.text);
    assert.deepEqual(JSON.parse(picture.text), { mimeType: "image/png", data: image });
    assert.equal((await call(`/api/x/${moduleName}/image/${other}/${entry.id}/0`)).status, 404);
    assert.equal((await call(`/api/x/${moduleName}/entry/${other}/${entry.id}`)).status, 404);
    assert.match(
        (await call(`/api/x/${moduleName}/entry/${session}/${entry.id}`)).text,
        /A stored picture/,
    );
});

test("switching off removes browser entries and listeners, and settings survive restart", async () => {
    const tab = fakeTab(session, owner(app));

    await app.attach(tab.client);
    tab.events.length = 0;
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, false);
    await new Promise((resolve) => setImmediate(resolve));
    tab.events.length = 0;
    app.events.emit("run.ended", { conversationId: session, session });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await call(`/api/x/${moduleName}/sessions`)).status, 404);
    assert.equal(
        app.webs.clients(owner(app)).some((each) => each.module === moduleName),
        false,
    );
    assert.equal(
        tab.events.some((each) => each.event === "ext"),
        false,
    );
    await app.setExtensionEnabled(owner(app), `${moduleName}.ts`, true);
    assert.equal(
        (
            await call(`/api/extension-settings/${moduleName}`, "owner", {
                tab: "fleet",
                range: "30",
            })
        ).status,
        200,
    );
    await app.detach(tab.client);
    await stop();
    await start();
    assert.equal(app.loader.enabled(`${moduleName}.ts`), true);
    assert.equal(app.config.extensionSettings(moduleName).tab, "fleet");
    assert.equal(app.config.extensionSettings(moduleName).range, "30");
    assert.ok((await stats()).steps.length >= 2);
});
