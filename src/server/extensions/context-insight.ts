/**
 * Context Insight: what a session's context is made of, how it grew, what it cost, and what the agent did to files and
 * commands. A panel beside the conversation shows the current window, every request, and every item; a page on the rail
 * sums the sessions up; a sheet opens the same view over the message box.
 */
import { defineDoc, defineExtension, type UsageState } from "@earendil-works/pi-durable";
import type {
    ConversationWebRequest,
    PocketHost,
    TranscriptEntry,
    TranscriptPage,
    TranscriptPart,
    ToolActivityRow,
    ExtensionWeb,
    WebRequest,
} from "../host.ts";
import type { ContextModel, Item } from "../context-insight.ts";
import * as contextFold from "../context-insight.ts";
import { accountUsage, pageRows, type UsageRow } from "../context-insight-data.ts";

export const pocketApi = 2;

const { fold, itemsFromSnapshot } = contextFold;

/** Entries a page of the transcript carries. */
const PAGE = 200;
/** Sessions larger than this are read whole but not retained between requests. */
const MAX_CACHED_ENTRIES = 40_000;
/** Approximate serialized characters retained for one cached transcript; image bytes are never included. */
const MAX_CACHE_CHARS = 16_000_000;
/** Sessions folded and kept in memory. */
const MAX_SESSIONS = 6;
/** Steps, events, items, and commands a response carries; the rest stay on the server. */
const MAX_STEPS = 800;
const MAX_EVENTS = 400;
const MAX_COMMANDS = 300;

/** View preferences belong to the signed-in person and survive changes of device. */
const Preferences = defineDoc<{ users: Record<string, Record<string, string | number | boolean>> }>(
    {
        kind: "x.context-insight.preferences",
        version: 1,
        scope: "session",
        checkpointWhen: () => false,
        initial: () => ({ users: {} }),
    },
);

interface Cached {
    entries: TranscriptEntry[];
    chars: number;
    /** The newest entry id read. */
    last: number;
    truncated: boolean;
    model?: ContextModel;
    activity?: readonly ToolActivityRow[];
    activityKey?: string;
    usage?: UsageState | null;
    /** When the entries were last read, for a session whose fold is reused. */
    at: number;
}

export default function createContextInsight(host: PocketHost, web: ExtensionWeb) {
    // Each installed version owns its derived cache, including when tests open separate apps in one process.
    const cache = new Map<number, Cached>();
    const pending = new Map<number, Promise<void>>();
    let disposed = false;

    web.onDispose(() => {
        disposed = true;
        cache.clear();
    });

    function remember(id: number, value: Cached): void {
        cache.delete(id);

        // Evict whole derived sessions, never the beginning of a transcript. Losing a system baseline would make
        // later composition and historical detail wrong. Large sessions use a cold read on the next request.
        if (value.entries.length > MAX_CACHED_ENTRIES || value.chars > MAX_CACHE_CHARS) {
            return;
        }

        cache.set(id, value);

        while (cache.size > MAX_SESSIONS) {
            const oldest = cache.keys().next().value;

            if (oldest === undefined) {
                break;
            }

            cache.delete(oldest);
        }
    }

    /** A running server can still have the old request API after a checkout changes. */
    function checked(request: ConversationWebRequest): ConversationWebRequest;
    function checked(request: WebRequest): WebRequest;

    function checked(request: WebRequest): WebRequest {
        const reads = request as unknown as Record<string, unknown>;
        const names = [
            "sessions",
            "transcriptOf",
            "usageOf",
            "imageOf",
            "modelContextOf",
            "usageHistoryOf",
            "requestHistoryOf",
            "toolActivityOf",
            "relationships",
            "subagentsOf",
        ];

        if ("conversation" in request) {
            names.push("transcript", "usage", "subagents", "modelContext", "toolActivity");
        }

        const missing =
            typeof itemsFromSnapshot !== "function" ||
            names.some((name) => typeof reads[name] !== "function");

        if (missing) {
            throw web.error(
                503,
                "Context Insight needs the extension read API. Restart the server to load it.",
            );
        }

        return request;
    }

    if (typeof web.settings === "function") {
        web.settings([
            {
                name: "tab",
                label: "Default tab",
                description: "The panel's tab when it opens.",
                type: "choice",
                default: "current",
                choices: [
                    { value: "current", label: "Now" },
                    { value: "trend", label: "Growth" },
                    { value: "browser", label: "Items" },
                    { value: "events", label: "Events" },
                    { value: "files", label: "Files" },
                    { value: "commands", label: "Commands" },
                    { value: "fleet", label: "Fleet" },
                ],
            },
            {
                name: "trend",
                label: "Growth view",
                description: "How the growth chart starts.",
                type: "choice",
                default: "total",
                choices: [
                    { value: "total", label: "Total" },
                    { value: "delta", label: "Delta" },
                ],
            },
            {
                name: "range",
                label: "Insights range",
                description: "The range the overview page starts with.",
                type: "choice",
                default: "7",
                choices: [
                    { value: "7", label: "Last 7 days" },
                    { value: "30", label: "Last 30 days" },
                    { value: "0", label: "All" },
                ],
            },
        ]);
    }

    const windowFor = (provider: string, model: string): number | undefined =>
        host.modelInfo(`${provider}/${model}`)?.contextWindow;

    /** Read what is new into a conversation's cache; a page already read is not read again. */
    async function readWith(
        id: number,
        page: (after: number, limit: number) => Promise<TranscriptPage>,
        usageOf: () => Promise<UsageState | null>,
        signal?: AbortSignal,
    ): Promise<{ cached: Cached; usage: UsageState | null; added: boolean }> {
        const previous = pending.get(id);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        pending.set(id, gate);
        await previous;

        try {
            if (disposed) {
                throw web.error(503, "Context Insight was turned off. Open it again to refresh.");
            }

            const before = cache.get(id);
            const cached: Cached = before
                ? { ...before, entries: [...before.entries] }
                : { entries: [], chars: 0, last: 0, truncated: false, at: 0 };
            let added = false;

            // Every page participates in the fold. A response is paged; its source history is not clipped.
            for (;;) {
                signal?.throwIfAborted();

                if (disposed) {
                    throw web.error(
                        503,
                        "Context Insight was turned off. Open it again to refresh.",
                    );
                }

                const pageOf = await page(cached.last, PAGE);

                if (pageOf.entries.length === 0) {
                    break;
                }

                if (pageOf.last <= cached.last) {
                    throw web.error(
                        503,
                        "The transcript cursor did not advance. Refresh the page.",
                    );
                }

                const fresh = pageOf.entries.filter((entry) => entry.id > cached.last);

                cached.entries.push(...fresh);
                cached.chars += JSON.stringify(fresh).length;
                cached.last = pageOf.last;
                added = true;

                if (!pageOf.more) {
                    break;
                }
            }

            const usage = await usageOf();

            if (disposed) {
                throw web.error(503, "Context Insight was turned off. Open it again to refresh.");
            }

            if (added) {
                cached.model = undefined;
            }

            cached.usage = usage;
            cached.at = Date.now();
            remember(id, cached);

            return { cached, usage, added };
        } finally {
            release();

            if (pending.get(id) === gate) {
                pending.delete(id);
            }
        }
    }

    /** Read the bound conversation. */
    function read(
        request: ConversationWebRequest,
    ): Promise<{ cached: Cached; usage: UsageState | null; added: boolean }> {
        return readWith(
            Number(request.conversation.id),
            async (after, limit) => {
                const page = await request.transcript({ after, limit, full: true });

                return page;
            },
            async () => (await request.usage()) ?? null,
            request.signal,
        );
    }

    /** Read any conversation the person may see, such as a subagent's. */
    function readOf(
        request: WebRequest,
        id: number,
    ): Promise<{ cached: Cached; usage: UsageState | null; added: boolean }> {
        return readWith(
            id,
            (after, limit) => request.transcriptOf(id, { after, limit, full: true }),
            async () => (await request.usageOf(id)) ?? null,
            request.signal,
        );
    }

    /** Read what is new, then fold it; a fold already at the newest entry is reused. */
    async function stats(
        request: ConversationWebRequest,
    ): Promise<{ model: ContextModel; cached: Cached }> {
        const { cached, usage, added } = await read(request);

        const activity =
            typeof request.toolActivity === "function" ? await request.toolActivity() : [];
        const activityKey = JSON.stringify(activity);

        if (added || cached.model === undefined || cached.activityKey !== activityKey) {
            cached.model = withActivity(
                fold(cached.entries, usage, windowFor),
                activity,
                windowFor,
            );
            cached.activityKey = activityKey;
            cached.activity = activity;
        } else {
            cached.model.usage = usage;
        }

        remember(Number(request.conversation.id), cached);

        return { model: cached.model, cached };
    }

    /** Bound list responses keep every older row available through the history route. */
    function trimmed(model: ContextModel) {
        const cut = Math.max(0, model.steps.length - MAX_STEPS);
        const events = model.events.map((event) => ({
            ...event,
            ...(event.step === undefined ? {} : { stepId: model.steps[event.step]?.id }),
        }));

        return {
            used: model.used,
            estimated: model.estimated,
            ...(model.window === undefined ? {} : { window: model.window }),
            ...(model.percent === undefined ? {} : { percent: model.percent }),
            parts: model.parts,
            steps: model.steps.slice(-MAX_STEPS),
            stepsMore: cut,
            stepsTotal: model.steps.length,
            events: events.slice(-MAX_EVENTS),
            eventsMore: Math.max(0, events.length - MAX_EVENTS),
            eventsTotal: events.length,
            files: model.files.slice(0, 120),
            filesMore: Math.max(0, model.files.length - 120),
            filesTotal: model.files.length,
            commands: model.commands.slice(-MAX_COMMANDS),
            commandsMore: Math.max(0, model.commands.length - MAX_COMMANDS),
            commandsTotal: model.commands.length,
            comms: model.comms.slice(-300),
            commsMore: Math.max(0, model.comms.length - 300),
            commsTotal: model.comms.length,
            sections: model.sections,
            tools: model.tools,
            usage: model.usage,
            ...(model.model === undefined ? {} : { model: model.model }),
            entries: model.entries,
            ...(model.firstAt === undefined ? {} : { firstAt: model.firstAt }),
            ...(model.lastAt === undefined ? {} : { lastAt: model.lastAt }),
            truncated: false,
            through: undefined,
            historyComplete: true,
            accuracy: {
                composition: "estimated",
                totals: model.estimated ? "estimated" : "provider-usage",
                request: "transcript-reconstruction",
                toolSource: "current-registry",
            },
        };
    }

    function integer(
        request: WebRequest,
        name: string,
        fallback: number,
        max = Number.MAX_SAFE_INTEGER,
    ) {
        const raw = request.query?.get(name);

        if (raw === null || raw === undefined || raw === "") {
            return fallback;
        }

        const value = Number(raw);

        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0 || value > max) {
            throw web.error(400, `${name} must be a whole number from 0 to ${max}.`);
        }

        return value;
    }

    /** A stable revision keeps live appends from moving rows between history pages. */
    function revision(request: WebRequest, cached: Cached) {
        const through = integer(request, "through", cached.last);

        if (through > cached.last) {
            throw web.error(400, "The history revision is newer than this session.");
        }

        return {
            through,
            entries:
                through === cached.last
                    ? cached.entries
                    : cached.entries.filter((entry) => entry.id <= through),
        };
    }

    function paging(request: WebRequest) {
        return {
            offset: integer(request, "offset", 0),
            limit: Math.max(1, integer(request, "limit", 200, 800)),
        };
    }

    // These values are owned by the person, rather than the browser where a tab was opened.
    web.route(
        "GET",
        "preferences",
        async (request) => ({
            preferences:
                (await request.snapshot(Preferences, request.context))?.users[request.user.id] ??
                null,
        }),
        { access: "owner" },
    );
    web.route(
        "PUT",
        "preferences",
        async (request) => {
            const value = request.body.preferences;

            if (
                value === null ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                Object.keys(value).length > 50
            ) {
                throw web.error(400, "Preferences must be an object of at most 50 view options.");
            }

            const preferences: Record<string, string | number | boolean> = {};

            for (const [key, field] of Object.entries(value)) {
                if (
                    !/^[a-z][a-z0-9_.-]{0,63}$/i.test(key) ||
                    !(
                        typeof field === "boolean" ||
                        (typeof field === "string" && field.length <= 256) ||
                        (typeof field === "number" && Number.isFinite(field))
                    )
                ) {
                    throw web.error(
                        400,
                        "A view option must be a short name and a primitive value.",
                    );
                }

                Object.defineProperty(preferences, key, { value: field, enumerable: true });
            }

            const saved = await request.commit(async (tx) => {
                const doc = await tx.doc(Preferences);
                const previous = doc.users[request.user.id] ?? {};
                const merged = { ...previous, ...preferences };

                doc.users[request.user.id] = merged;

                return merged;
            });

            web.send("preferences", { userId: request.user.id, preferences: saved });

            return { preferences: saved };
        },
        { access: "owner" },
    );

    // GET /api/x/context-insight/sessions: the sessions the person may see.
    web.route("GET", "sessions", (request) => ({ sessions: checked(request).sessions() }), {
        access: "owner",
    });

    // GET /api/x/context-insight/session/:source: the fold, as the panel draws it.
    web.conversationRoute(
        "GET",
        "session/:source",
        async (request) => {
            const { model, cached } = await stats(checked(request));
            const out = trimmed(model);

            return {
                conversation: request.conversation,
                stats: { ...out, truncated: cached.truncated, through: cached.last },
            };
        },
        { conversation: "source", access: "owner" },
    );

    // Every retained response list has a continuation. All pages use one immutable transcript revision.
    web.conversationRoute(
        "GET",
        "history/:source/:kind",
        async (request) => {
            const { model: current, cached } = await stats(checked(request));
            const { entries, through } = revision(request, cached);
            const model =
                through === cached.last
                    ? current
                    : withActivity(
                          fold(entries, null, windowFor),
                          cached.activity ?? [],
                          windowFor,
                          entries,
                      );
            const { offset, limit } = paging(request);
            const kind = request.params.kind;
            let rows: readonly unknown[];

            switch (kind) {
                case "steps":
                    rows = model.steps;
                    break;
                case "events":
                    rows = model.events.map((event) => ({
                        ...event,
                        ...(event.step === undefined
                            ? {}
                            : { stepId: model.steps[event.step]?.id }),
                    }));
                    break;
                case "files":
                    rows = model.files;
                    break;
                case "commands":
                    rows = model.commands;
                    break;
                case "comms":
                    rows = model.comms;
                    break;
                case "messages":
                    rows = entries.filter(
                        (entry) =>
                            (entry.messages?.length ?? 0) > 0 || (entry.edits?.length ?? 0) > 0,
                    );
                    break;
                default:
                    throw web.error(404, "No such history list.");
            }

            return { ...pageRows(rows, offset, limit, kind === "files"), through };
        },
        { conversation: "source", access: "owner" },
    );

    async function contextItems(request: ConversationWebRequest, step?: number) {
        const { model, cached } = await stats(checked(request));
        const revisionOf = revision(request, cached);
        let before = revisionOf.entries;

        if (step !== undefined) {
            const index = before.findIndex((entry) => entry.id === step);

            if (index < 0 || before[index]?.kind !== "pi.assistant") {
                throw web.error(404, "No such step in this session.");
            }

            before = before.slice(0, index);
        }

        const through = before[before.length - 1]?.id;
        const base =
            step === undefined && revisionOf.through === cached.last
                ? model
                : fold(before, null, windowFor);
        let items = base.items;
        let accuracy: Record<string, unknown> = {
            context: "transcript-reconstruction",
            tokens: "estimate",
            toolSources: "current-registry",
            request: "before-beforeRequest-hooks",
        };

        if (typeof request.modelContext === "function" && through !== undefined) {
            const snapshot = await request.modelContext({ at: through, full: true });

            items = itemsFromSnapshot(snapshot);
            accuracy = { ...snapshot.accuracy };
        }

        return { items, parts: base.parts, used: base.used, accuracy, through: revisionOf.through };
    }

    function itemPage(items: readonly Item[], request: WebRequest) {
        const query = request.query?.get("q")?.toLocaleLowerCase() ?? "";
        const category = request.query?.get("category");
        const role = request.query?.get("role");
        const source = request.query?.get("source");
        const orderedItems = items.map((item, order) => ({ ...item, order }));
        const orderOf = new Map(orderedItems.map((item) => [item.key, item.order]));
        const filtered = orderedItems.filter((item) => {
            if (category && category !== "all" && item.category !== category) {
                return false;
            }

            if (role && role !== "all" && item.role !== role) {
                return false;
            }

            if (source && source !== "all" && item.source !== source) {
                return false;
            }

            return query === "" || JSON.stringify(item).toLocaleLowerCase().includes(query);
        });
        const { offset, limit } = paging(request);
        const pinned = filtered.filter((item) => item.role === "section" || item.role === "schema");
        const messages = filtered.filter(
            (item) => item.role !== "section" && item.role !== "schema",
        );
        const shown = pageRows([...messages, ...pinned], offset, limit);
        const ordered = [
            ...shown.rows.filter((item) => item.role === "section" || item.role === "schema"),
            ...shown.rows.filter((item) => item.role !== "section" && item.role !== "schema"),
        ];

        return {
            items: ordered.map((item) => ({ ...itemSummary(item), order: orderOf.get(item.key) })),
            total: shown.total,
            itemsMore: shown.more,
            more: shown.more,
            next: shown.next,
        };
    }

    // GET /api/x/context-insight/items/:source: the items in the context now, newest last.
    web.conversationRoute(
        "GET",
        "items/:source",
        async (request) => {
            const { items, ...context } = await contextItems(request);

            return { ...context, ...itemPage(items, request) };
        },
        { conversation: "source", access: "owner" },
    );

    web.conversationRoute(
        "GET",
        "items/:source/:step",
        async (request) => {
            const step = Number(request.params.step);

            if (!Number.isSafeInteger(step) || step <= 0) {
                throw web.error(400, "The step must be an entry id.");
            }

            const { items, ...context } = await contextItems(request, step);

            return { ...context, ...itemPage(items, request), step };
        },
        { conversation: "source", access: "owner" },
    );

    web.conversationRoute(
        "GET",
        "detail/:source",
        async (request) => {
            const step = integer(request, "step", 0);
            const key = request.query.get("key");
            const { items, accuracy } = await contextItems(request, step || undefined);
            const item = items.find((candidate) => candidate.key === key);

            if (item === undefined) {
                throw web.error(404, "No such context item at this revision.");
            }

            return { item, accuracy };
        },
        { conversation: "source", access: "owner" },
    );

    web.conversationRoute(
        "GET",
        "diff/:source/:step",
        async (request) => {
            const step = Number(request.params.step);
            const { model } = await stats(checked(request));
            const selected = model.steps.findIndex((candidate) => candidate.id === step);

            if (selected < 0) {
                throw web.error(404, "No such step in this session.");
            }

            const mode = request.query.get("base") ?? "previous";
            const previous =
                mode === "turn"
                    ? model.steps.find(
                          (candidate) => candidate.turn === model.steps[selected]!.turn,
                      )
                    : mode === "previous"
                      ? model.steps[selected - 1]
                      : model.steps.find((candidate) => candidate.id === Number(mode));

            if (mode !== "previous" && mode !== "turn" && previous === undefined) {
                throw web.error(400, "The diff base must name a request in this session.");
            }

            const current = await contextItems(request, step);
            const baseline =
                previous === undefined ? [] : (await contextItems(request, previous.id)).items;
            const before = new Map(baseline.map((item) => [item.key, item]));
            const after = new Map(current.items.map((item) => [item.key, item]));
            const added = current.items.filter((item) => !before.has(item.key)).map(itemSummary);
            const removed = baseline.filter((item) => !after.has(item.key)).map(itemSummary);
            const changed = current.items.flatMap((item) => {
                const old = before.get(item.key);

                return old !== undefined &&
                    JSON.stringify(old.content) !== JSON.stringify(item.content)
                    ? [{ before: itemSummary(old), after: itemSummary(item) }]
                    : [];
            });

            return {
                base: previous?.id ?? null,
                step,
                added,
                removed,
                changed,
                accuracy: current.accuracy,
            };
        },
        { conversation: "source", access: "owner" },
    );

    web.conversationRoute(
        "GET",
        "requests/:source",
        async (request) => {
            const current = checked(request);
            const rows =
                typeof current.requestHistoryOf === "function"
                    ? await current.requestHistoryOf(Number(request.conversation.id))
                    : [];
            const { offset, limit } = paging(request);
            const through = integer(request, "through", rows.length, rows.length);
            const result = pageRows(rows.slice(0, through), offset, limit);

            return {
                ...result,
                through,
                rows: result.rows.map(({ messages, response: _response, ...summary }, index) => ({
                    ...summary,
                    order: Math.max(0, through - offset - result.rows.length) + index,
                    messageCount: messages.length,
                })),
                accuracy: "normalized-after-hooks",
            };
        },
        { conversation: "source", access: "owner" },
    );
    web.conversationRoute(
        "GET",
        "request/:source/:request",
        async (request) => {
            const current = checked(request);
            const rows =
                typeof current.requestHistoryOf === "function"
                    ? await current.requestHistoryOf(Number(request.conversation.id))
                    : [];
            const capture = rows.find((row) => row.id === request.params.request);

            if (capture === undefined) {
                throw web.error(404, "No such captured request.");
            }

            const { offset, limit } = paging(request);
            const result = pageRows(capture.messages, offset, limit, true);

            return {
                ...capture,
                messages: result.rows.map((message, index) => ({
                    ...message,
                    key: `request:${capture.id}:message:${offset + index}`,
                    messageIndex: offset + index,
                })),
                total: result.total,
                next: result.next,
                more: result.more,
            };
        },
        { conversation: "source", access: "owner" },
    );

    // GET /api/x/context-insight/agent/:id: a subagent's own fold and messages, for the Fleet view.
    web.route(
        "GET",
        "agent/:id",
        async (request) => {
            const id = Number(request.params.id);

            if (!Number.isSafeInteger(id) || id <= 0) {
                throw web.error(400, "The conversation must be a positive whole number.");
            }

            const { cached, usage } = await readOf(checked(request), id);
            const activity =
                typeof request.toolActivityOf === "function"
                    ? await request.toolActivityOf(id)
                    : [];
            const model = withActivity(fold(cached.entries, usage, windowFor), activity, windowFor);

            return {
                messages: messagesOf(cached.entries).slice(-80),
                messagesMore: Math.max(0, messagesOf(cached.entries).length - 80),
                stats: { ...trimmed(model), truncated: cached.truncated, through: cached.last },
            };
        },
        { access: "owner" },
    );

    // GET /api/x/context-insight/image/:source/:entry/:index: one image of a stored entry.
    web.conversationRoute(
        "GET",
        "image/:source/:entry/:index",
        async (request) => {
            const entry = Number(request.params.entry);
            const index = Number(request.params.index);
            const image = await checked(request).imageOf(
                Number(request.conversation.id),
                entry,
                index,
                request.query.has("message") || request.query.has("edit")
                    ? {
                          ...(request.query.has("message")
                              ? { messageIndex: integer(request, "message", 0) }
                              : {}),
                          ...(request.query.has("edit")
                              ? { editIndex: integer(request, "edit", 0) }
                              : {}),
                      }
                    : undefined,
            );

            if (image === undefined) {
                throw web.error(404, "No such image.");
            }

            return image;
        },
        { conversation: "source", access: "owner" },
    );

    // The graph contains only stored parent, linked-session, and fork relationships, never guessed dependencies.
    web.conversationRoute(
        "GET",
        "fleet/:source",
        async (request) => {
            const current = checked(request);
            const id = Number(request.conversation.id);
            const agents = current.subagents();
            const sessions = new Map(current.sessions().map((session) => [session.id, session]));
            const relationships =
                typeof current.relationships === "function"
                    ? current.relationships()
                    : agents.map((agent) => ({
                          conversationId: agent.conversationId,
                          sessionId: id,
                          parentId: id,
                      }));
            const connected = new Set([id]);
            let changed = true;

            while (changed) {
                changed = false;

                for (const relation of relationships) {
                    const parents = [
                        relation.parentId,
                        "linkedFrom" in relation ? relation.linkedFrom : undefined,
                    ];

                    if (
                        connected.has(relation.conversationId) ||
                        parents.some((parent) => parent !== undefined && connected.has(parent))
                    ) {
                        const before = connected.size;

                        connected.add(relation.conversationId);

                        for (const parent of parents) {
                            if (parent !== undefined) {
                                connected.add(parent);
                            }
                        }

                        changed ||= connected.size !== before;
                    }
                }
            }

            const known = new Map(agents.map((agent) => [agent.conversationId, agent]));

            if (typeof current.subagentsOf === "function") {
                for (const relation of relationships) {
                    if (!connected.has(relation.conversationId)) {
                        continue;
                    }

                    for (const agent of current.subagentsOf(relation.conversationId)) {
                        known.set(agent.conversationId, agent);
                        connected.add(agent.conversationId);
                    }
                }
            }

            const nodes = [...connected].map((conversationId) => {
                const agent = known.get(conversationId);
                const relation = relationships.find(
                    (candidate) => candidate.conversationId === conversationId,
                );
                const session = sessions.get(conversationId);

                return {
                    conversationId,
                    name: agent?.name ?? session?.title ?? `Session ${conversationId}`,
                    title: session?.title ?? agent?.name,
                    parentId: relation?.parentId,
                    relationship:
                        relation?.parentId !== undefined
                            ? "subagent"
                            : relation !== undefined &&
                                "linkedFrom" in relation &&
                                relation.linkedFrom !== undefined
                              ? "linked"
                              : "session",
                    state:
                        agent === undefined
                            ? "unknown"
                            : agent.failed
                              ? "failed"
                              : agent.stopped
                                ? "stopped"
                                : agent.waiting
                                  ? "waiting"
                                  : agent.busy
                                    ? "running"
                                    : "done",
                    ...agent,
                };
            });
            const edges = relationships.flatMap((relation) => {
                if (!connected.has(relation.conversationId)) {
                    return [];
                }

                const rows: { from: number; to: number; type: string }[] = [];

                if (relation.parentId !== undefined && connected.has(relation.parentId)) {
                    rows.push({
                        from: relation.parentId,
                        to: relation.conversationId,
                        type: "subagent",
                    });
                }

                if (
                    "linkedFrom" in relation &&
                    relation.linkedFrom !== undefined &&
                    connected.has(relation.linkedFrom)
                ) {
                    rows.push({
                        from: relation.linkedFrom,
                        to: relation.conversationId,
                        type: "linked",
                    });
                }

                if (
                    "forkedFrom" in relation &&
                    relation.forkedFrom !== undefined &&
                    connected.has(relation.forkedFrom.id)
                ) {
                    rows.push({
                        from: relation.forkedFrom.id,
                        to: relation.conversationId,
                        type: "fork",
                    });
                }

                return rows;
            });
            const { model } = await stats(current);

            return {
                agents,
                nodes,
                edges,
                communications: model.comms.slice(-300),
                communicationsMore: Math.max(0, model.comms.length - 300),
                communicationsTotal: model.comms.length,
                accuracy: {
                    relationships: "stored",
                    communication: "recorded-transcript",
                    dependencies: "not-stored",
                },
                limits: [
                    "Task dependencies are not stored.",
                    "Communication rows show recorded messages only.",
                ],
            };
        },
        { conversation: "source", access: "owner" },
    );

    // GET /api/x/context-insight/entry/:source/:id: one entry whole, for an expanded item.
    web.conversationRoute(
        "GET",
        "entry/:source/:id",
        async (request) => {
            const id = Number(request.params.id);

            if (!Number.isSafeInteger(id) || id <= 0) {
                throw web.error(400, "The entry must be an id.");
            }

            const page = await checked(request).transcript({
                after: id - 1,
                limit: 1,
                full: true,
            });
            const entry = page.entries[0];

            if (entry === undefined || entry.id !== id) {
                throw web.error(404, "No such entry in this session.");
            }

            return { entry };
        },
        { conversation: "source", access: "owner" },
    );

    // GET /api/x/context-insight/insight/:source: a session's totals by day, for the overview page.
    web.conversationRoute(
        "GET",
        "insight/:source",
        async (request) => {
            const current = checked(request);
            const { cached, usage } = await read(current);
            const id = Number(request.conversation.id);
            const history =
                typeof current.usageHistoryOf === "function"
                    ? await current.usageHistoryOf(id)
                    : undefined;
            const rows: UsageRow[] =
                history === undefined
                    ? cached.entries.flatMap((entry) => {
                          if (entry.conversationId !== undefined && entry.conversationId !== id) {
                              return [];
                          }

                          return (entry.messages ?? []).flatMap((message): UsageRow[] => {
                              if (message.role !== "assistant" && message.role !== "toolResult") {
                                  return [];
                              }

                              if (message.usage === undefined) {
                                  return [];
                              }

                              return [
                                  {
                                      at: message.timestamp ?? message.at ?? entry.at,
                                      bucket: message.role === "assistant" ? "models" : "tools",
                                      key:
                                          message.role === "assistant"
                                              ? `${message.provider ?? "?"}/${message.model ?? "?"}`
                                              : message.name,
                                      usage: message.usage,
                                  },
                              ];
                          });
                      })
                    : [...history.events];
            const offset = request.query.get("tz");
            let timezone: number | string | undefined =
                offset === null ? undefined : Number(offset);
            const zone = request.query.get("zone");

            if (zone !== null) {
                try {
                    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
                    timezone = zone;
                } catch {
                    throw web.error(400, "The timezone must be a valid IANA timezone name.");
                }
            }

            if (
                typeof timezone === "number" &&
                (!Number.isInteger(timezone) || Math.abs(timezone) > 840)
            ) {
                throw web.error(400, "The timezone must be a UTC offset in minutes.");
            }

            const accounting = accountUsage(rows, history?.totals ?? usage, timezone);
            const lastAt = cached.entries.findLast((entry) => entry.at !== undefined)?.at;

            return {
                conversation: request.conversation,
                usage: history?.totals ?? usage,
                ...accounting,
                historyComplete: true,
                truncated: false,
                ...(lastAt === undefined ? {} : { lastAt }),
            };
        },
        { conversation: "source", access: "owner" },
    );

    web.client("context-insight", { access: "owner" });

    // A run or a message changes what the dashboard would show: tell the tabs, with the session it is about.
    if (typeof host.on === "function") {
        const tell = ({ conversationId }: { conversationId: number }) =>
            web.send("changed", { conversationId });

        web.onDispose(host.on("run.ended", tell));
        web.onDispose(host.on("message.sent", tell));
        web.onDispose(host.on("run.started", tell));

        // Old running cores reject new event names until restarted; ordinary run events remain usable meanwhile.
        for (const event of ["request.completed", "usage.updated"] as const) {
            try {
                web.onDispose(host.on(event, tell));
            } catch {
                // A checkout can replace this module before the process reloads its core API.
            }
        }
    }

    return defineExtension({ name: "pocket-context-insight" });
}

/** Nested calls have no model messages of their own. Merge their activity without changing context or usage. */
function withActivity(
    model: ContextModel,
    activity: readonly ToolActivityRow[],
    windowFor: (provider: string, model: string) => number | undefined,
    entries?: readonly TranscriptEntry[],
): ContextModel {
    const roots =
        entries === undefined
            ? undefined
            : new Set(
                  entries.flatMap((entry) =>
                      (entry.messages ?? []).flatMap((message) =>
                          message.role === "assistant"
                              ? message.parts.flatMap((part) =>
                                    part.type === "toolCall" ? [part.id] : [],
                                )
                              : [],
                      ),
                  ),
              );
    const eligible =
        roots === undefined
            ? activity
            : activity.filter((row) => row.rootCallId !== undefined && roots.has(row.rootCallId));

    if (eligible.length === 0) {
        return model;
    }

    const parent: TranscriptEntry = {
        id: 0,
        kind: "pi.tool-result",
        messages: [
            {
                role: "toolResult",
                callId: "nested-inspection",
                name: "codemode",
                parts: [],
                tokens: 0,
                isError: false,
                nestedCalls: eligible.map((row) => ({
                    name: row.toolName,
                    callId: row.callId,
                    arguments: row.arguments,
                    status: row.status,
                    startedAt: row.startedAt,
                    endedAt: row.endedAt,
                    durationMs: row.durationMs,
                    outputRecorded: false,
                    textOutputRecorded: false,
                    structuredOutputRecorded: row.outputRecorded,
                    resultAvailable: row.resultAvailable,
                    ...(row.result === undefined ? {} : { result: row.result }),
                })),
            },
        ],
    };
    const nested = fold([parent], null, windowFor);
    const files = new Map(model.files.map((file) => [file.path, file]));

    for (const file of nested.files) {
        const previous = files.get(file.path);

        if (previous === undefined) {
            files.set(file.path, file);
            continue;
        }

        const existing = new Set(previous.ops.map((operation) => operation.callId).filter(Boolean));
        const operations = file.ops.filter((operation) => !existing.has(operation.callId));

        if (operations.length === 0) {
            continue;
        }

        files.set(file.path, {
            ...previous,
            read:
                previous.read + operations.filter((operation) => operation.kind === "read").length,
            written:
                previous.written +
                operations.filter((operation) => operation.kind === "write").length,
            edited:
                previous.edited +
                operations.filter((operation) => operation.kind === "edit").length,
            added:
                previous.added +
                operations.reduce((sum, operation) => sum + (operation.added ?? 0), 0),
            removed:
                previous.removed +
                operations.reduce((sum, operation) => sum + (operation.removed ?? 0), 0),
            ops: [...previous.ops, ...operations],
        });
    }

    const calls = new Set(model.commands.map((command) => command.callId).filter(Boolean));

    return {
        ...model,
        files: [...files.values()].sort(
            (a, b) => b.ops.length - a.ops.length || a.path.localeCompare(b.path),
        ),
        commands: [
            ...model.commands,
            ...nested.commands.filter((command) => !calls.has(command.callId)),
        ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        comms: [...model.comms, ...nested.comms],
    };
}

/** Heavy exact content is fetched only for the selected item. List previews never claim to be full text. */
function itemSummary(item: Item): Omit<Item, "text" | "description" | "parameters" | "content"> {
    const {
        text: _text,
        description: _description,
        parameters: _parameters,
        content: _content,
        ...summary
    } = item;

    return summary;
}

/** A subagent's own messages, oldest first, for its Fleet card. */
function messagesOf(entries: readonly TranscriptEntry[]): {
    at?: number;
    from: "parent" | "agent";
    text: string;
    entry: number;
}[] {
    const messages: {
        at?: number;
        from: "parent" | "agent";
        text: string;
        entry: number;
    }[] = [];

    for (const entry of entries) {
        for (const message of entry.messages ?? []) {
            if (message.role === "user") {
                const text = textOf(message.parts);

                if (text !== "") {
                    messages.push({
                        ...(entry.at === undefined ? {} : { at: entry.at }),
                        from: "parent",
                        text: text.trim(),
                        entry: entry.id,
                    });
                }
            } else if (message.role === "assistant") {
                const text = textOf(message.parts);

                if (text !== "") {
                    messages.push({
                        ...(entry.at === undefined ? {} : { at: entry.at }),
                        from: "agent",
                        text: text.trim(),
                        entry: entry.id,
                    });
                }
            }
        }
    }

    return messages;
}

/** The words of a message's parts, as one line. */
function textOf(parts: readonly TranscriptPart[]): string {
    return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
}
