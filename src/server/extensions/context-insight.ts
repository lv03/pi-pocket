/**
 * Context Insight: what a session's context is made of, how it grew, what it cost, and what the agent did to files and
 * commands. A panel beside the conversation shows the current window, every request, and every item; a page on the rail
 * sums the sessions up; a sheet opens the same view over the message box.
 */
import { defineExtension, type UsageState } from "@earendil-works/pi-durable";
import type {
    ConversationWebRequest,
    PocketHost,
    TranscriptEntry,
    TranscriptPage,
    TranscriptPart,
    ExtensionWeb,
    WebRequest,
} from "../host.ts";
import { type ContextModel, fold, usageOf } from "../context-insight.ts";

export const pocketApi = 2;

/** Entries a page of the transcript carries. */
const PAGE = 200;
/** Entries one session's fold keeps; past it, the oldest are left out and the view says so. */
const MAX_ENTRIES = 40_000;
/** Sessions folded and kept in memory. */
const MAX_SESSIONS = 6;
/** Steps, events, items, and commands a response carries; the rest stay on the server. */
const MAX_STEPS = 800;
const MAX_EVENTS = 400;
const MAX_ITEMS = 400;
const MAX_COMMANDS = 300;

interface Cached {
    entries: TranscriptEntry[];
    /** The newest entry id read. */
    last: number;
    truncated: boolean;
    model?: ContextModel;
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
        const names = ["sessions", "transcriptOf", "usageOf", "imageOf"];

        if ("conversation" in request) {
            names.push("transcript", "usage", "subagents");
        }

        const missing = names.some((name) => typeof reads[name] !== "function");

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
                : { entries: [], last: 0, truncated: false, at: 0 };
            let added = false;

            // A clipped cache still follows new entries; only the displayed history is limited.
            for (;;) {
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

                cached.entries.push(...pageOf.entries.filter((entry) => entry.id > cached.last));
                cached.last = pageOf.last;
                added = true;

                if (cached.entries.length > MAX_ENTRIES) {
                    cached.truncated = true;
                    cached.entries = cached.entries.slice(-MAX_ENTRIES);
                }

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
                const page = await request.transcript({ after, limit });

                return page;
            },
            async () => (await request.usage()) ?? null,
        );
    }

    /** Read any conversation the person may see, such as a subagent's. */
    function readOf(
        request: WebRequest,
        id: number,
    ): Promise<{ cached: Cached; usage: UsageState | null; added: boolean }> {
        return readWith(
            id,
            (after, limit) => request.transcriptOf(id, { after, limit }),
            async () => (await request.usageOf(id)) ?? null,
        );
    }

    /** Read what is new, then fold it; a fold already at the newest entry is reused. */
    async function stats(
        request: ConversationWebRequest,
    ): Promise<{ model: ContextModel; cached: Cached }> {
        const { cached, usage, added } = await read(request);

        if (added || cached.model === undefined) {
            cached.model = fold(cached.entries, usage, windowFor);
        } else {
            cached.model.usage = usage;
        }

        remember(Number(request.conversation.id), cached);

        return { model: cached.model, cached };
    }

    /** The fold as a response carries it: the newest of each list, with what was left out. */
    function trimmed(model: ContextModel) {
        const cut = Math.max(0, model.steps.length - MAX_STEPS);
        const events = model.events
            .filter((event) => event.step === undefined || event.step >= cut)
            .map((event) =>
                event.step === undefined ? event : { ...event, step: event.step - cut },
            );

        return {
            used: model.used,
            estimated: model.estimated,
            ...(model.window === undefined ? {} : { window: model.window }),
            ...(model.percent === undefined ? {} : { percent: model.percent }),
            parts: model.parts,
            steps: model.steps.slice(-MAX_STEPS),
            stepsMore: cut,
            events: events.slice(-MAX_EVENTS),
            eventsMore: Math.max(0, events.length - MAX_EVENTS),
            files: model.files.slice(0, 120),
            filesMore: Math.max(0, model.files.length - 120),
            commands: model.commands.slice(-MAX_COMMANDS),
            commandsMore: Math.max(0, model.commands.length - MAX_COMMANDS),
            comms: model.comms.slice(-300),
            sections: model.sections,
            tools: model.tools,
            usage: model.usage,
            ...(model.model === undefined ? {} : { model: model.model }),
            entries: model.entries,
            ...(model.firstAt === undefined ? {} : { firstAt: model.firstAt }),
            ...(model.lastAt === undefined ? {} : { lastAt: model.lastAt }),
            truncated: false,
        };
    }

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
                stats: { ...out, truncated: cached.truncated },
            };
        },
        { conversation: "source", access: "owner" },
    );

    // GET /api/x/context-insight/items/:source: the items in the context now, newest last.
    web.conversationRoute(
        "GET",
        "items/:source",
        async (request) => {
            const { model } = await stats(checked(request));

            const page = itemsOf(model);

            return {
                parts: model.parts,
                items: page.items,
                itemsMore: page.more,
                total: page.total,
                ...(model.used === 0 ? {} : { used: model.used }),
            };
        },
        { conversation: "source", access: "owner" },
    );

    // GET /api/x/context-insight/items/:source/:step: the items the request of that step read.
    web.conversationRoute(
        "GET",
        "items/:source/:step",
        async (request) => {
            const id = Number(request.params.step);
            const { cached } = await stats(checked(request));

            if (!Number.isSafeInteger(id) || id <= 0) {
                throw web.error(400, "The step must be an entry id.");
            }

            const at = cached.entries.findIndex((entry) => entry.id === id);

            if (at < 0 || cached.entries[at]?.kind !== "pi.assistant") {
                throw web.error(404, "No such step in this session.");
            }

            const before = at === 0 ? [] : cached.entries.slice(0, at);
            const model = fold(before, null, windowFor);

            const page = itemsOf(model);

            return {
                parts: model.parts,
                items: page.items,
                itemsMore: page.more,
                total: page.total,
                step: id,
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
            const model = fold(cached.entries, usage, windowFor);

            return {
                messages: messagesOf(cached.entries),
                stats: { ...trimmed(model), truncated: cached.truncated },
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
            );

            if (image === undefined) {
                throw web.error(404, "No such image.");
            }

            return image;
        },
        { conversation: "source", access: "owner" },
    );

    // GET /api/x/context-insight/fleet/:source: the subagents this session started.
    web.conversationRoute(
        "GET",
        "fleet/:source",
        (request) => ({ agents: checked(request).subagents() }),
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
            const { cached, usage } = await read(checked(request));
            const days = daysOf(cached.entries);
            let steps = 0;
            let tokens = 0;
            let cost = 0;
            let lastAt: number | undefined;

            for (const day of Object.values(days)) {
                steps += day.steps;
                tokens += day.tokens;
                cost += day.cost;
            }

            for (let index = cached.entries.length - 1; index >= 0; index--) {
                const at = cached.entries[index]!.at;

                if (at !== undefined) {
                    lastAt = at;
                    break;
                }
            }

            return {
                conversation: request.conversation,
                usage,
                days,
                steps,
                tokens,
                cost,
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
    }

    return defineExtension({ name: "pocket-context-insight" });
}

/** The items a response carries: the sections and schemas always, then the newest messages that fit. */
function itemsOf(model: ContextModel): {
    items: ContextModel["items"];
    more: number;
    total: number;
} {
    const pinned = model.items.filter((item) => item.role === "section" || item.role === "schema");
    const rest = model.items.filter((item) => item.role !== "section" && item.role !== "schema");
    const room = Math.max(0, MAX_ITEMS - pinned.length);
    const shown = room === 0 ? [] : rest.length <= room ? rest : rest.slice(-room);

    return {
        items: [...pinned, ...shown],
        more: Math.max(0, rest.length - shown.length),
        total: model.items.length,
    };
}

/** A session's tokens and cost by local day, from the answers it stored. */
function daysOf(
    entries: readonly TranscriptEntry[],
): Record<string, { tokens: number; cost: number; steps: number }> {
    const days: Record<string, { tokens: number; cost: number; steps: number }> = {};

    for (const entry of entries) {
        if (entry.kind !== "pi.assistant" || entry.at === undefined) {
            continue;
        }

        const message = entry.messages?.[0];

        if (message?.role !== "assistant") {
            continue;
        }

        if (
            message.stopReason === "aborted" ||
            message.stopReason === "error" ||
            message.stopReason === "deferred"
        ) {
            continue;
        }

        const usage = usageOf(message);

        if (usage.total <= 0) {
            continue;
        }

        const day = (days[dayOf(entry.at)] ??= { tokens: 0, cost: 0, steps: 0 });

        day.tokens += usage.total;
        day.cost += usage.cost;
        day.steps++;
    }

    return days;
}

function dayOf(at: number): string {
    const date = new Date(at);

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate(),
    ).padStart(2, "0")}`;
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
                        text: brief(text, 700),
                        entry: entry.id,
                    });
                }
            } else if (message.role === "assistant") {
                const text = textOf(message.parts);

                if (text !== "") {
                    messages.push({
                        ...(entry.at === undefined ? {} : { at: entry.at }),
                        from: "agent",
                        text: brief(text, 700),
                        entry: entry.id,
                    });
                }
            }
        }
    }

    return messages.slice(-80);
}

/** The words of a message's parts, as one line. */
function textOf(parts: readonly TranscriptPart[]): string {
    return parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

/** A text as one field shows it. */
function brief(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
