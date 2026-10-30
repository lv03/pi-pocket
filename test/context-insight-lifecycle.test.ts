// Factory lifecycle: cold reads share a cursor, disposed reads fail, and every listener is removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import createContextInsight from "../src/server/extensions/context-insight.ts";
import type {
    AppEventName,
    ConversationWebRequest,
    ExtensionWeb,
    PocketHost,
    TranscriptPage,
} from "../src/server/host.ts";

const page: TranscriptPage = {
    entries: [
        {
            id: 1,
            kind: "pi.assistant",
            messages: [{ role: "assistant", parts: [], tokens: 1 }],
        },
    ],
    last: 1,
    more: false,
};

function fixture() {
    const routes = new Map<string, (request: ConversationWebRequest) => unknown>();
    const cleanups: (() => unknown)[] = [];
    const listeners: { event: AppEventName; disposed: number }[] = [];
    const host = {
        modelInfo: () => undefined,
        on: (event: AppEventName) => {
            const listener = { event, disposed: 0 };

            listeners.push(listener);

            return () => {
                listener.disposed++;
            };
        },
    } satisfies Pick<PocketHost, "modelInfo" | "on">;
    const web = {
        conversationRoute: (_method, path, handle) => {
            routes.set(path, handle);
        },
        route: () => {},
        client: () => {},
        settings: () => {},
        send: () => {},
        error: (status, message) => Object.assign(new Error(message), { status }),
        onDispose: (cleanup) => {
            cleanups.push(cleanup);
        },
    } satisfies Pick<
        ExtensionWeb,
        "conversationRoute" | "route" | "client" | "settings" | "send" | "error" | "onDispose"
    >;

    createContextInsight(host as unknown as PocketHost, web as unknown as ExtensionWeb);

    return {
        listeners,
        dispose: () => {
            for (const cleanup of cleanups.splice(0)) {
                cleanup();
            }
        },
        read: async (request: ConversationWebRequest) => {
            const handle = routes.get("session/:source");

            assert.ok(handle);

            return (await handle(request)) as {
                stats: { entries: number; steps: { id: number }[] };
            };
        },
    };
}

function request(transcript: ConversationWebRequest["transcript"]): ConversationWebRequest {
    return {
        conversation: { id: 1, title: "Test", cwd: "/tmp", thinkingLevel: "off" },
        transcript,
        usage: async () => undefined,
        sessions: () => [],
        transcriptOf: async () => page,
        usageOf: async () => undefined,
        imageOf: async () => undefined,
        subagents: () => [],
    } as unknown as ConversationWebRequest;
}

test("cold concurrent reads do not duplicate entries", { timeout: 5000 }, async (t) => {
    const module = fixture();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const cursors: number[] = [];
    const input = request(async ({ after = 0 } = {}) => {
        cursors.push(after);
        entered.resolve();
        await gate.promise;

        return after === 0 ? page : { entries: [], last: after, more: false };
    });

    t.after(module.dispose);
    t.after(() => gate.resolve());

    const readings = Promise.all(Array.from({ length: 3 }, () => module.read(input)));

    await entered.promise;
    await setImmediate();
    gate.resolve();

    const results = await readings;

    assert.deepEqual(cursors, [0, 1, 1]);

    for (const result of results) {
        assert.equal(result.stats.entries, 1);
        assert.deepEqual(
            result.stats.steps.map((step) => step.id),
            [1],
        );
    }
});

test("a blocked read fails after its module is disposed", { timeout: 5000 }, async (t) => {
    const module = fixture();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const input = request(async () => {
        entered.resolve();
        await gate.promise;

        return page;
    });

    t.after(module.dispose);
    t.after(() => gate.resolve());

    const rejected = assert.rejects(module.read(input), {
        status: 503,
        message: /Context Insight was turned off/,
    });

    await entered.promise;
    module.dispose();
    gate.resolve();
    await rejected;
});

test("module cleanup runs every host.on disposer", (t) => {
    const module = fixture();

    t.after(module.dispose);
    assert.deepEqual(module.listeners.map((listener) => listener.event).sort(), [
        "message.sent",
        "run.ended",
        "run.started",
    ]);
    assert.ok(module.listeners.every((listener) => listener.disposed === 0));
    module.dispose();
    assert.ok(module.listeners.every((listener) => listener.disposed === 1));
});
