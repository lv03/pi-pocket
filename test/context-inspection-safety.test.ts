// Import helpers first: real apps use isolated settings and temporary data.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    createAssistantMessageEventStream,
    normalizeContext,
    type AssistantMessageEvent,
    type Context,
    type Model,
    type Api,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ContextInspection } from "../src/server/context-inspection.ts";
import type { ModelRequestCapture } from "../src/server/host.ts";

after(cleanUp);

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

async function promptly<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Capture blocked the provider")), 1000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

const model = { provider: "faux", id: "faux-1", api: "faux" } as Model<Api>;
const request: Context = {
    messages: [{ role: "user", content: "A real request", timestamp: 1 }],
};

function fixture() {
    const source = createAssistantMessageEventStream();
    const doc: { requests: ModelRequestCapture[]; usage: unknown[] } = {
        requests: [],
        usage: [],
    };
    const controls = {
        calls: 0,
        commits: 0,
        lookup: async (): Promise<number | undefined> => 1,
        beforeCommit: async (_count: number): Promise<void> => {},
        toolSources: (): Record<string, string> => ({}),
        replace: (value: string): string => value,
        sent: undefined as Context | undefined,
    };
    const app = {
        loader: { enabled: () => true },
        harness: {
            snapshot: async () => structuredClone(doc),
            commit: async (change: (tx: unknown) => Promise<void>) => {
                await controls.beforeCommit(++controls.commits);
                await change({ doc: async () => doc });
            },
        },
        toolSources: () => controls.toolSources(),
        hidden: { replace: (value: string) => controls.replace(value) },
        rootOf: (id: number) => id,
        sessionMeta: () => ({}),
        events: { emit: () => {} },
    };
    const inspection = new ContextInspection(app as never);
    const models = {
        streamSimple: ((_model, input) => {
            controls.calls++;
            controls.sent = input;

            return source;
        }) as App["models"]["streamSimple"],
    };

    inspection.install(models as App["models"], () => controls.lookup());

    return {
        controls,
        doc,
        inspection,
        source,
        start: (input = request) => models.streamSimple(model, input, { sessionId: "session" }),
    };
}

test("a stalled lookup does not delay provider startup or terminal delivery", async () => {
    const f = fixture();
    const lookup = deferred<number>();

    f.controls.lookup = () => lookup.promise;

    try {
        const output = f.start();
        const response = fauxAssistantMessage([fauxText("provider answer")]);

        assert.equal(f.controls.calls, 1);
        f.source.push({ type: "done", reason: "stop", message: response });
        assert.equal(await promptly(output.result()), response);
    } finally {
        lookup.resolve(1);
        await f.inspection.flush();
    }

    assert.equal(f.doc.requests[0]?.outcome, "done");
});

for (const stalledWrite of [1, 2]) {
    test("capture write " + stalledWrite + " cannot block a terminal tool call", async () => {
        const f = fixture();
        const blocked = deferred();
        const release = deferred();

        f.controls.beforeCommit = async (count) => {
            if (count === stalledWrite) {
                blocked.resolve();
                await release.promise;
            }
        };

        try {
            const output = f.start();
            const events: AssistantMessageEvent[] = [];
            const consumed = (async () => {
                for await (const event of output) {
                    events.push(event);
                }
            })();

            if (stalledWrite === 1) {
                await promptly(blocked.promise);
            }

            const response = fauxAssistantMessage([], { stopReason: "toolUse" });

            response.content = [
                { type: "toolCall", id: "real-call", name: "read", arguments: { path: "a.ts" } },
            ];
            f.source.push({ type: "done", reason: "toolUse", message: response });
            await promptly(blocked.promise);
            assert.equal(await promptly(output.result()), response);
            await promptly(consumed);
            assert.deepEqual(events, [{ type: "done", reason: "toolUse", message: response }]);
        } finally {
            release.resolve();
            await f.inspection.flush();
        }

        const history = await f.inspection.requestHistory(1 as never);

        assert.equal(history.length, 1);
        assert.equal(history[0]?.outcome, "done");
        assert.equal(history[0]?.response?.role, "assistant");
    });
}

for (const failure of ["lookup", "projection", "redaction", "response projection", "storage"]) {
    test("a rejected " + failure + " preserves the provider response", async (t) => {
        const f = fixture();
        const diagnostic = new Error("test capture " + failure + " failed");
        const logged = t.mock.method(console, "error", () => {});

        if (failure === "lookup") {
            f.controls.lookup = async () => {
                throw diagnostic;
            };
        } else if (failure === "projection") {
            f.controls.toolSources = () => {
                throw diagnostic;
            };
        } else if (failure === "redaction") {
            f.controls.replace = () => {
                throw diagnostic;
            };
        } else if (failure === "storage") {
            f.controls.beforeCommit = async () => {
                throw diagnostic;
            };
        }

        const output = f.start();
        const response = fauxAssistantMessage([fauxText("original provider response")]);

        if (failure === "response projection") {
            await f.inspection.flush();

            f.controls.toolSources = () => {
                throw diagnostic;
            };
        }

        f.source.push({ type: "done", reason: "stop", message: response });
        assert.equal(await promptly(output.result()), response);
        await f.inspection.flush();
        assert.equal(f.controls.calls, 1);
        assert.ok(logged.mock.calls.length > 0);
    });
}

test("request capture normalizes public systemPrompt and tools shorthand", async () => {
    const f = fixture();
    const input: Context = {
        ...request,
        systemPrompt: "The real system instruction",
        tools: [
            { name: "read", description: "Read a file", parameters: { type: "object" } as never },
        ],
    };
    const output = f.start(input);

    f.source.push({ type: "done", reason: "stop", message: fauxAssistantMessage([]) });
    await promptly(output.result());

    const history = await f.inspection.requestHistory(1 as never);
    const system = history[0]?.messages[0];

    assert.equal(f.controls.sent, input);
    assert.deepEqual(
        history[0]?.messages.map((message) => message.role),
        ["system", "user"],
    );
    assert.equal(system?.role, "system");

    if (system?.role === "system") {
        assert.equal(system.content, normalizeContext(input).messages[0]?.content);
        assert.equal(system.tools?.[0]?.name, "read");
        assert.deepEqual(system.tools?.[0]?.parameters, { type: "object" });
    }

    assert.equal(history[0]?.accuracy, "normalized-after-hooks");
    assert.equal(history[0]?.outcome, "done");
});

test("system text block arrays retain their actual text in request captures", async () => {
    const f = fixture();
    const output = f.start({
        messages: [
            {
                role: "system",
                content: [{ type: "text", text: "Keep this instruction" }],
                timestamp: 1,
            },
        ],
    });

    f.source.push({ type: "done", reason: "stop", message: fauxAssistantMessage([]) });
    await promptly(output.result());

    const history = await f.inspection.requestHistory(1 as never);
    const system = history[0]?.messages[0];

    assert.equal(system?.role, "system");
    assert.equal(system?.role === "system" && system.content, "Keep this instruction");
});

test("capture endedAt records provider completion, not deferred storage time", async (t) => {
    const f = fixture();
    const blocked = deferred();
    const release = deferred();
    let now = 1000;

    t.mock.method(Date, "now", () => now);

    f.controls.beforeCommit = async (count) => {
        if (count === 1) {
            blocked.resolve();
            await release.promise;
        }
    };

    try {
        const output = f.start();

        await promptly(blocked.promise);
        now = 2000;
        f.source.push({ type: "done", reason: "stop", message: fauxAssistantMessage([]) });
        await promptly(output.result());
        now = 9000;
    } finally {
        release.resolve();
        await f.inspection.flush();
    }

    assert.equal(f.doc.requests[0]?.startedAt, 1000);
    assert.equal(f.doc.requests[0]?.endedAt, 2000);
});

test("the first post-restart entryless bill is dated without dating historical spend", async () => {
    const folder = join(root, "inspection-safety-restart");
    let app = await openApp(scriptedModel(), folder);

    try {
        const id = await newSession(app);

        await recordCost(app, id, 2);
        await app.setExtensionEnabled(owner(app), "context-insight.ts", true);
        await app.close();
        app = await openApp(scriptedModel(), folder);

        const before = Date.now();

        await recordCost(app, id, 3);

        const history = await app.inspection.usageHistory(id);
        const event = history.events[0];

        assert.equal(history.events.length, 1);
        assert.equal(event?.source, "usage-commit");
        assert.equal(event?.entryId, undefined);
        assert.ok(event?.at !== undefined && event.at >= before && event.at <= Date.now());
        assert.equal(history.known.models["faux/faux-1"]?.cost.total, 3);
        assert.equal(history.undated.models["faux/faux-1"]?.cost.total, 2);
        assert.equal(history.totals?.models["faux/faux-1"]?.cost.total, 5);
    } finally {
        await app.close();
    }
});

test("private PiP creation and usage emit no inspection events", async () => {
    const app = await openApp(scriptedModel(), join(root, "inspection-safety-pip"));
    const usage: number[] = [];
    const completed: number[] = [];
    const offUsage = app.events.on("usage.updated", ({ conversationId }) =>
        usage.push(conversationId),
    );
    const offCompleted = app.events.on("request.completed", ({ conversationId }) =>
        completed.push(conversationId),
    );

    try {
        await app.setExtensionEnabled(owner(app), "pip.ts", true);
        await app.setExtensionEnabled(owner(app), "context-insight.ts", true);

        const id = await app.pip.ensure(owner(app));

        await recordCost(app, id, 1);
        await app.inspection.flush();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(app.sessionMeta(id)?.pip, owner(app).id);
        assert.equal(usage.length, 0);
        assert.equal(completed.length, 0);

        const visible = await newSession(app);

        await recordCost(app, visible, 1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(usage.includes(Number(visible)));
        assert.ok(!usage.includes(Number(id)));
    } finally {
        offUsage();
        offCompleted();
        await app.close();
    }
});
