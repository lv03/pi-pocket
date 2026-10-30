/**
 * Folds a conversation's stored transcript into what a context dashboard shows: the window's size, the composition
 * now and at each request, the events that changed it, and what the agent did to files and commands.
 *
 * It works from `TranscriptEntry`s alone, as Pi's own meter prices them: the ring's figures come from the usage that a
 * response reports, and every split is an estimate scaled onto that figure. The rules mirror Pi Durable: a head marker
 * (compaction or reset) starts the active context with itself, then the entries from its head on; an entry's edits
 * replace or remove what an earlier one gives the model; an answer with stop reason `aborted`, `error`, or `deferred`
 * is not part of the context.
 */
import type { TranscriptEdit, TranscriptEntry, TranscriptMessage, TranscriptPart } from "./host.ts";
import type { UsageState } from "@earendil-works/pi-durable";

export type Category =
    | "system"
    | "tools"
    | "user"
    | "inject"
    | "skill"
    | "answers"
    | "thinking"
    | "toolCalls"
    | "tool";

export const CATEGORIES: readonly Category[] = [
    "system",
    "tools",
    "user",
    "inject",
    "skill",
    "answers",
    "thinking",
    "toolCalls",
    "tool",
];

export type Parts = Record<Category, number>;

export interface Step {
    /** Its place in the session's requests, oldest first. */
    index: number;
    /** The assistant entry's id. */
    id: number;
    at?: number;
    turn: number;
    provider?: string;
    model?: string;
    /** Input, cache reads, and cache writes the provider billed for this request. */
    prompt: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    /** Everything the provider reported: the prompt and the answer. */
    total: number;
    /** The context this request read, split and scaled onto `prompt`. */
    parts: Parts;
    /** The change from the request before it, by category. */
    delta: Parts | null;
    stopReason?: string;
    error?: string;
    /** The message that opened the turn, short. */
    user?: string;
    /** The reply's own words, or the tools it called, short. */
    answer?: string;
}

export type EventKind = "compact" | "reset" | "model" | "inject" | "tools" | "edit" | "error";

export interface EventRow {
    id: number;
    at?: number;
    kind: EventKind;
    /** What changed, in a line, as the transcript says it. */
    detail: string;
    /** The change in the context's size, in estimated tokens. */
    tokens?: number;
    /** The request it happened before, as an index into `steps`, when it is between two of them. */
    step?: number;
}

export interface FileOp {
    kind: "read" | "write" | "edit";
    at?: number;
    /** The tool result's entry. */
    entry: number;
    /** The answer that made the call, for the text it wrote or replaced. */
    call?: number;
    added?: number;
    removed?: number;
    tool: string;
    error?: boolean;
}

export interface FileRow {
    path: string;
    read: number;
    written: number;
    edited: number;
    added: number;
    removed: number;
    ops: FileOp[];
}

export interface CommandRow {
    command: string;
    program: string;
    status: "ok" | "error" | "running";
    at?: number;
    ms?: number;
    entry: number;
    output: string;
}

/** One message between a session and one of its subagents. */
export interface CommsRow {
    at?: number;
    /** `to` the subagent, or `from` it. */
    dir: "to" | "from";
    name: string;
    kind: "ask" | "report";
    text: string;
    entry: number;
}

export interface SectionRow {
    key: string;
    tokens: number;
    group: "system" | "inject" | "skill";
}

export interface ToolRow {
    name: string;
    tokens: number;
    source?: string;
}

/** One thing the model reads: a prompt section, a tool's schema, or a message part. */
export interface Item {
    /** The entry it comes from; 0 for a section or a tool schema. */
    entry: number;
    /** Its place among the entry's parts. */
    part: number;
    role: "section" | "schema" | "user" | "answers" | "thinking" | "toolCall" | "tool";
    category: Category;
    label: string;
    tokens: number;
    preview: string;
    /** A tool schema's extension, when known. */
    source?: string;
}

export interface ContextModel {
    used: number;
    estimated: boolean;
    window?: number;
    percent?: number;
    parts: Parts;
    steps: Step[];
    events: EventRow[];
    files: FileRow[];
    commands: CommandRow[];
    sections: SectionRow[];
    tools: ToolRow[];
    items: Item[];
    comms: CommsRow[];
    usage: UsageState | null;
    model?: { provider: string; model: string };
    entries: number;
    firstAt?: number;
    lastAt?: number;
}

/** Terms of Pi's own meter, for the one split it does not price per part: system prompt sections. */
const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = Math.ceil(4800 / CHARS_PER_TOKEN);
const EXCLUDED = new Set(["aborted", "error", "deferred"]);
const SYSTEM_KEYS = new Set(["preamble", "guidelines", "instructions"]);
const SKILL_KEYS = new Set(["skills"]);

export function emptyParts(): Parts {
    return {
        system: 0,
        tools: 0,
        user: 0,
        inject: 0,
        skill: 0,
        answers: 0,
        thinking: 0,
        toolCalls: 0,
        tool: 0,
    };
}

function add(into: Parts, from: Parts, sign = 1): Parts {
    for (const category of CATEGORIES) {
        into[category] += from[category] * sign;
    }

    return into;
}

function total(parts: Parts): number {
    let sum = 0;

    for (const category of CATEGORIES) {
        sum += parts[category];
    }

    return sum;
}

/** Scale the estimate onto the figure the provider reported, so a share is right even when the split is not. */
function anchor(parts: Parts, target: number): Parts {
    const estimate = total(parts);

    if (estimate <= 0 || target <= 0) {
        return { ...parts };
    }

    if (estimate === target) {
        return { ...parts };
    }

    const scale = target / estimate;
    const out = emptyParts();
    const remainders = CATEGORIES.map((category) => {
        const scaled = parts[category] * scale;

        out[category] = Math.floor(scaled);

        return { category, fraction: scaled - out[category] };
    }).sort((a, b) => b.fraction - a.fraction);
    const remaining = Math.round(target) - total(out);

    for (let index = 0; index < remaining; index++) {
        out[remainders[index]!.category]++;
    }

    return out;
}

function textTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function partsOfMessage(message: TranscriptMessage, into: Parts, entry: TranscriptEntry): Parts {
    if (message.role === "system") {
        return into;
    }

    if (message.role === "user") {
        for (const part of message.parts) {
            into[userCategory(message, entry)] += partTokens(part);
        }

        return into;
    }

    if (message.role === "toolResult") {
        for (const part of message.parts) {
            into.tool += partTokens(part);
        }

        return into;
    }

    for (const part of message.parts) {
        if (part.type === "text" || part.type === "image") {
            into.answers += partTokens(part);
        } else if (part.type === "thinking") {
            into.thinking += part.tokens;
        } else if (part.type === "toolCall") {
            into.toolCalls += part.tokens;
        }
    }

    return into;
}

function userCategory(
    message: Extract<TranscriptMessage, { role: "user" }>,
    entry: TranscriptEntry,
): "user" | "inject" {
    const text = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ");

    return entry.kind === "pi.compaction" || /^\[subagent [^\]\s]+/.test(text) ? "inject" : "user";
}

function partTokens(part: TranscriptPart): number {
    return part.type === "image" ? IMAGE_TOKENS : part.tokens;
}

function messageTokens(message: TranscriptMessage): number {
    if (message.role === "system") {
        return message.tokens;
    }

    if (message.role === "user" || message.role === "toolResult") {
        let sum = 0;

        for (const part of message.parts) {
            sum += partTokens(part);
        }

        return sum;
    }

    let sum = 0;

    for (const part of message.parts) {
        sum += part.type === "image" ? IMAGE_TOKENS : part.tokens;
    }

    return sum;
}

export function usageOf(message: TranscriptMessage): {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    total: number;
} {
    const usage = message.role === "assistant" ? message.usage : undefined;
    const input = Number(usage?.input ?? 0);
    const output = Number(usage?.output ?? 0);
    const cacheRead = Number(usage?.cacheRead ?? 0);
    const cacheWrite = Number(usage?.cacheWrite ?? 0);
    const reasoning = Number(usage?.reasoning ?? 0);
    const cost = Number(usage?.cost?.total ?? 0);
    const billed = Number(usage?.totalTokens ?? 0);

    return {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        cost,
        total: billed > 0 ? billed : input + output + cacheRead + cacheWrite,
    };
}

function sectionGroup(key: string): "system" | "inject" | "skill" {
    if (SKILL_KEYS.has(key)) {
        return "skill";
    }

    return SYSTEM_KEYS.has(key) ? "system" : "inject";
}

/** One line of a command's output, clean enough to show. */
function firstLine(text: string, limit = 240): string {
    const line = text.trim().split("\n")[0] ?? "";

    return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

function countLines(text: string): number {
    if (text === "") {
        return 0;
    }

    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

interface Call {
    name: string;
    args: Record<string, unknown>;
    at?: number;
    entry: number;
}

function stringOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function recordOf(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * Fold a transcript, oldest first. `windowFor` gives the context window of a model, as `host.modelInfo` knows it; it
 * is asked for the model of the newest answer.
 */
export function fold(
    entries: readonly TranscriptEntry[],
    usage: UsageState | null,
    windowFor: (provider: string, model: string) => number | undefined,
): ContextModel {
    const steps: Step[] = [];
    const events: EventRow[] = [];
    const files = new Map<string, FileRow>();
    const commands: CommandRow[] = [];
    const comms: CommsRow[] = [];
    const calls = new Map<string, Call>();
    const edits = new Map<number, TranscriptEdit>();
    const sections = new Map<string, { text: string; tokens: number }>();
    const tools = new Map<string, ToolRow>();

    /** Indices of the entries in the model's context, in reading order. */
    let active: number[] = [];
    let turn = 0;
    let last: { provider?: string; model?: string } = {};
    /** The newest head marker: a measurement from before it describes a context that is gone. */
    let boundary = 0;

    const contribution = (index: number): readonly TranscriptMessage[] => {
        const entry = entries[index]!;
        const edit = edits.get(entry.id);

        if (edit?.action === "omit") {
            return [];
        }

        const messages = edit?.action === "replace" ? edit.messages : (entry.messages ?? []);

        return messages.filter(
            (message) => message.role !== "assistant" || !EXCLUDED.has(message.stopReason ?? ""),
        );
    };

    // Replay the active contributions so resets and edits also remove obsolete sections and tools.
    const replaySystem = (): void => {
        sections.clear();
        tools.clear();

        for (const index of active) {
            for (const message of contribution(index)) {
                if (message.role !== "system") {
                    continue;
                }

                for (const [key, text] of Object.entries(message.sections ?? {})) {
                    if (text === null) {
                        sections.delete(key);
                    } else {
                        sections.set(key, { text, tokens: textTokens(text) });
                    }
                }

                if (message.content !== "") {
                    sections.set("content", {
                        text: message.content,
                        tokens: textTokens(message.content),
                    });
                }

                // A changed declaration can be removed and added in the same patch.
                for (const name of message.toolsRemoved ?? []) {
                    tools.delete(name);
                }

                for (const tool of message.tools ?? []) {
                    tools.set(tool.name, {
                        name: tool.name,
                        tokens: tool.tokens,
                        ...(tool.source === undefined ? {} : { source: tool.source }),
                    });
                }
            }
        }
    };

    const partsNow = (): Parts => {
        replaySystem();

        const parts = emptyParts();

        for (const [key, section] of sections) {
            parts[sectionGroup(key)] += section.tokens;
        }

        for (const tool of tools.values()) {
            parts.tools += tool.tokens;
        }

        for (const index of active) {
            for (const message of contribution(index)) {
                partsOfMessage(message, parts, entries[index]!);
            }
        }

        return parts;
    };

    const tokenNow = (): number => total(partsNow());

    /** The newest message a person wrote in the context, as one short line. */
    const lastUser = (): string | undefined => {
        for (let at = active.length - 1; at >= 0; at--) {
            const entry = entries[active[at]!]!;

            if (entry.kind !== "pi.user") {
                continue;
            }

            for (const message of contribution(active[at]!)) {
                if (message.role !== "user") {
                    continue;
                }

                const text = message.parts
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();

                if (text !== "") {
                    return text.length <= 180 ? text : `${text.slice(0, 180)}…`;
                }
            }
        }

        return undefined;
    };

    const itemsNow = (): Item[] => {
        const items: Item[] = [];

        for (const [key, section] of sections) {
            items.push({
                entry: 0,
                part: 0,
                role: "section",
                category: sectionGroup(key),
                label: key,
                tokens: section.tokens,
                preview: section.text.slice(0, 160),
            });
        }

        for (const tool of tools.values()) {
            items.push({
                entry: 0,
                part: 0,
                role: "schema",
                category: "tools",
                label: tool.name,
                tokens: tool.tokens,
                preview: "",
                ...(tool.source === undefined ? {} : { source: tool.source }),
            });
        }

        for (const index of active) {
            const entry = entries[index]!;
            let part = 0;

            for (const message of contribution(index)) {
                if (message.role === "user") {
                    const text = message.parts
                        .flatMap((value) => (value.type === "text" ? [value.text] : []))
                        .join(" ");
                    const report = /^\[subagent ([^\]\s]+)/.exec(text);
                    const summary = entry.kind === "pi.compaction";
                    const label = summary ? "Summary" : report ? `${report[1]} report` : "You";

                    for (const value of message.parts) {
                        const file =
                            value.type === "text" ? /^<file name="([^"]+)"/.exec(value.text) : null;

                        items.push({
                            entry: entry.id,
                            part: part++,
                            role: "user",
                            category: userCategory(message, entry),
                            label: file === null ? label : "File",
                            tokens: partTokens(value),
                            preview: file === null ? previewOf(value) : file[1]!,
                        });
                    }
                } else if (message.role === "toolResult") {
                    for (const value of message.parts) {
                        items.push({
                            entry: entry.id,
                            part: part++,
                            role: "tool",
                            category: "tool",
                            label: message.name,
                            tokens: partTokens(value),
                            preview: previewOf(value),
                        });
                    }
                } else if (message.role === "assistant") {
                    for (const value of message.parts) {
                        items.push({
                            entry: entry.id,
                            part: part++,
                            role:
                                value.type === "thinking"
                                    ? "thinking"
                                    : value.type === "toolCall"
                                      ? "toolCall"
                                      : "answers",
                            category:
                                value.type === "thinking"
                                    ? "thinking"
                                    : value.type === "toolCall"
                                      ? "toolCalls"
                                      : "answers",
                            label:
                                value.type === "toolCall"
                                    ? value.name
                                    : value.type === "thinking"
                                      ? "Reasoning"
                                      : "Answer",
                            tokens: value.type === "image" ? IMAGE_TOKENS : value.tokens,
                            preview: previewOf(value),
                        });
                    }
                }
            }
        }

        return items;
    };

    /** The newest answer in the context that measured it: its entry and the usage the provider reported. */
    const measurement = ():
        | {
              index: number;
              entry: TranscriptEntry;
              message: Extract<TranscriptMessage, { role: "assistant" }>;
              total: number;
          }
        | undefined => {
        for (let at = active.length - 1; at >= 0; at--) {
            const index = active[at]!;
            const entry = entries[index]!;

            if (entry.id <= boundary) {
                continue;
            }

            const messages = contribution(index);

            for (let part = messages.length - 1; part >= 0; part--) {
                const message = messages[part]!;

                if (message.role === "assistant") {
                    const measured = usageOf(message);

                    if (measured.total > 0) {
                        return { index, entry, message, total: measured.total };
                    }
                }
            }
        }

        return undefined;
    };

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;

        for (const edit of entry.edits ?? []) {
            edits.set(edit.target, edit);
            events.push({
                id: entry.id,
                ...(entry.at === undefined ? {} : { at: entry.at }),
                kind: "edit",
                detail:
                    edit.action === "omit"
                        ? "an earlier entry was left out"
                        : "an earlier entry was replaced",
                ...(steps.length === 0 ? {} : { step: steps.length - 1 }),
            });
        }

        if (entry.kind === "pi.system") {
            const beforeSections = new Map(sections);
            const beforeTools = new Map(tools);

            active.push(index);
            replaySystem();

            for (const key of new Set([...beforeSections.keys(), ...sections.keys()])) {
                const before = beforeSections.get(key);
                const after = sections.get(key);

                if (before?.text !== after?.text) {
                    const change =
                        after === undefined
                            ? "removed"
                            : before === undefined
                              ? "added"
                              : after.tokens === before.tokens
                                ? "changed"
                                : after.tokens > before.tokens
                                  ? "grew"
                                  : "shrank";

                    events.push({
                        id: entry.id,
                        ...(entry.at === undefined ? {} : { at: entry.at }),
                        kind: "inject",
                        detail: `${key} ${change}`,
                        tokens: (after?.tokens ?? 0) - (before?.tokens ?? 0),
                        ...(steps.length === 0 ? {} : { step: steps.length - 1 }),
                    });
                }
            }

            if (JSON.stringify([...beforeTools]) !== JSON.stringify([...tools])) {
                events.push({
                    id: entry.id,
                    ...(entry.at === undefined ? {} : { at: entry.at }),
                    kind: "tools",
                    detail: `${tools.size} tools offered`,
                    ...(steps.length === 0 ? {} : { step: steps.length - 1 }),
                });
            }

            continue;
        }

        if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
            boundary = entry.id;
            const before = tokenNow();
            const head = entry.head ?? entry.id;
            const kept: number[] = [];

            edits.clear();

            for (let each = 0; each <= index; each++) {
                const candidate = entries[each]!;

                if (candidate.id < head) {
                    continue;
                }

                for (const edit of candidate.edits ?? []) {
                    edits.set(edit.target, edit);
                }

                if (
                    each !== index &&
                    candidate.head === undefined &&
                    candidate.kind !== "pi.compaction" &&
                    candidate.kind !== "pi.reset"
                ) {
                    kept.push(each);
                }
            }

            active = [index, ...kept];
            const after = tokenNow();

            events.push({
                id: entry.id,
                ...(entry.at === undefined ? {} : { at: entry.at }),
                kind: entry.kind === "pi.compaction" ? "compact" : "reset",
                detail:
                    entry.kind === "pi.compaction"
                        ? compactionReason(entry)
                        : entry.messages?.[0]?.role === "user"
                          ? "a new context, with a handoff"
                          : "a new context",
                tokens: after - before,
                ...(steps.length === 0 ? {} : { step: steps.length - 1 }),
            });
            continue;
        }

        if (entry.kind === "pi.user") {
            turn++;
            active.push(index);

            for (const message of entry.messages ?? []) {
                if (message.role !== "user") {
                    continue;
                }

                const text = message.parts
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join(" ");
                const report = /^\[subagent ([^\]]+)\]\s*([\s\S]*)$/.exec(text);

                if (report !== null) {
                    comms.push({
                        ...(entry.at === undefined ? {} : { at: entry.at }),
                        dir: "from",
                        name: report[1]!.split(/[\s,]/)[0] ?? report[1]!,
                        kind: "report",
                        text: brief(report[2]!, 500),
                        entry: entry.id,
                    });
                }
            }

            continue;
        }

        if (entry.kind === "pi.assistant") {
            const message = entry.messages?.[0];

            if (message?.role === "assistant") {
                const measured = usageOf(message);
                const raw = partsNow();
                const prompt = measured.input + measured.cacheRead + measured.cacheWrite;
                const parts = anchor(raw, prompt > 0 ? prompt : total(raw));
                const stopReason = message.stopReason;
                const error = message.error;
                const user = lastUser();
                const answer = answerBrief(message);

                steps.push({
                    index: steps.length,
                    id: entry.id,
                    ...(entry.at === undefined ? {} : { at: entry.at }),
                    turn,
                    ...(message.provider === undefined ? {} : { provider: message.provider }),
                    ...(message.model === undefined ? {} : { model: message.model }),
                    prompt,
                    output: measured.output,
                    reasoning: measured.reasoning,
                    cacheRead: measured.cacheRead,
                    cacheWrite: measured.cacheWrite,
                    cost: measured.cost,
                    total: measured.total,
                    parts,
                    delta:
                        steps.length === 0
                            ? null
                            : add(add(emptyParts(), parts), steps[steps.length - 1]!.parts, -1),
                    ...(stopReason === undefined ? {} : { stopReason }),
                    ...(error === undefined ? {} : { error }),
                    ...(user === undefined ? {} : { user }),
                    ...(answer === undefined ? {} : { answer }),
                });

                if (stopReason !== undefined && EXCLUDED.has(stopReason)) {
                    events.push({
                        id: entry.id,
                        ...(entry.at === undefined ? {} : { at: entry.at }),
                        kind: "error",
                        detail: error ?? `the answer ended: ${stopReason}`,
                        step: steps.length - 1,
                    });
                } else {
                    if (
                        last.model !== undefined &&
                        (last.provider !== message.provider || last.model !== message.model)
                    ) {
                        events.push({
                            id: entry.id,
                            ...(entry.at === undefined ? {} : { at: entry.at }),
                            kind: "model",
                            detail: `${message.provider}/${message.model}`,
                            step: steps.length - 1,
                        });
                    }

                    last = {
                        ...(message.provider === undefined ? {} : { provider: message.provider }),
                        ...(message.model === undefined ? {} : { model: message.model }),
                    };

                    for (const part of message.parts) {
                        if (part.type === "toolCall" && typeof part.id === "string") {
                            calls.set(part.id, {
                                name: part.name,
                                args: recordOf(part.arguments),
                                ...(entry.at === undefined ? {} : { at: entry.at }),
                                entry: entry.id,
                            });
                        }
                    }
                }
            }

            active.push(index);
            continue;
        }

        if (entry.kind === "pi.tool-result") {
            const message = entry.messages?.[0];

            if (message?.role === "toolResult") {
                collect(message, calls.get(message.callId), entry, files, commands, comms);
            }

            active.push(index);
            continue;
        }

        active.push(index);
    }

    const currentRaw = partsNow();
    const measured = measurement();

    if (measured === undefined) {
        const estimated = total(currentRaw);
        const modelName = last;

        return finish({
            used: estimated,
            estimated: true,
            parts: currentRaw,
            steps,
            events,
            files,
            commands,
            sections,
            tools,
            items: itemsNow(),
            comms,
            usage,
            model: modelName,
            entries: entries.length,
            window: windowOf(modelName, windowFor),
            entriesList: entries,
        });
    }

    const measuredMessages = contribution(measured.index);
    const sameEntryAfter = measuredMessages
        .slice(measuredMessages.indexOf(measured.message) + 1)
        .reduce((sum, message) => sum + messageTokens(message), 0);
    const after = active.slice(active.indexOf(measured.index) + 1).reduce((sum, index) => {
        let tokens = 0;

        for (const message of contribution(index)) {
            tokens += messageTokens(message);
        }

        return sum + tokens;
    }, sameEntryAfter);
    const used = measured.total + after;
    const window = windowOf(last, windowFor);
    const entry = measured.entry;
    const message = measured.message;

    return finish({
        used,
        estimated: after > 0,
        parts: anchor(currentRaw, used),
        steps,
        events,
        files,
        commands,
        sections,
        tools,
        items: itemsNow(),
        comms,
        usage,
        model: last,
        entries: entries.length,
        window,
        entriesList: entries,
        measured: {
            provider: message?.role === "assistant" ? message.provider : undefined,
            model: message?.role === "assistant" ? message.model : undefined,
            at: entry.at,
        },
    });
}

function windowOf(
    model: { provider?: string; model?: string },
    windowFor: (provider: string, model: string) => number | undefined,
): number | undefined {
    if (model.provider === undefined || model.model === undefined) {
        return undefined;
    }

    const window = windowFor(model.provider, model.model);

    return window !== undefined && window > 0 ? window : undefined;
}

interface Finish {
    used: number;
    estimated: boolean;
    parts: Parts;
    steps: Step[];
    events: EventRow[];
    files: Map<string, FileRow>;
    commands: CommandRow[];
    sections: Map<string, { text: string; tokens: number }>;
    tools: Map<string, ToolRow>;
    items: Item[];
    comms: CommsRow[];
    usage: UsageState | null;
    model: { provider?: string; model?: string };
    entries: number;
    window?: number;
    entriesList: readonly TranscriptEntry[];
    measured?: { provider?: string; model?: string; at?: number };
}

function finish(input: Finish): ContextModel {
    const sectionRows: SectionRow[] = [...input.sections].map(([key, section]) => ({
        key,
        tokens: section.tokens,
        group: sectionGroup(key),
    }));
    const toolRows: ToolRow[] = [...input.tools.values()];
    const fileRows = [...input.files.values()]
        .map((file) => ({
            ...file,
            added: file.ops.reduce((sum, op) => sum + (op.added ?? 0), 0),
            removed: file.ops.reduce((sum, op) => sum + (op.removed ?? 0), 0),
            read: file.ops.filter((op) => op.kind === "read").length,
            written: file.ops.filter((op) => op.kind === "write").length,
            edited: file.ops.filter((op) => op.kind === "edit").length,
        }))
        .sort((a, b) => b.added + b.removed + b.ops.length - (a.added + a.removed + a.ops.length));
    const model =
        input.model.provider !== undefined && input.model.model !== undefined
            ? { provider: input.model.provider, model: input.model.model }
            : input.measured?.provider !== undefined && input.measured.model !== undefined
              ? { provider: input.measured.provider, model: input.measured.model }
              : undefined;
    const firstAt = input.entriesList.find((entry) => entry.at !== undefined)?.at;
    const lastAt = input.entriesList[input.entriesList.length - 1]?.at;

    return {
        used: input.used,
        estimated: input.estimated,
        ...(input.window === undefined ? {} : { window: input.window }),
        ...(input.window === undefined || input.window <= 0
            ? {}
            : { percent: Math.min(100, Math.round((input.used / input.window) * 1000) / 10) }),
        parts: input.parts,
        steps: input.steps,
        events: input.events,
        files: fileRows,
        commands: input.commands,
        sections: sectionRows.sort((a, b) => b.tokens - a.tokens),
        tools: toolRows.sort((a, b) => b.tokens - a.tokens),
        items: input.items,
        comms: input.comms,
        usage: input.usage,
        ...(model === undefined ? {} : { model }),
        entries: input.entries,
        ...(firstAt === undefined ? {} : { firstAt }),
        ...(lastAt === undefined ? {} : { lastAt }),
    };
}

function compactionReason(entry: TranscriptEntry): string {
    const reason = recordOf(entry.data).reason;

    return reason === "overflow"
        ? "the window overflowed"
        : reason === "threshold"
          ? "the window reached its limit"
          : "compacted";
}

/** Add what a tool result did to the files it touched, and what a command ran and returned. */
function collect(
    message: Extract<TranscriptMessage, { role: "toolResult" }>,
    call: Call | undefined,
    entry: TranscriptEntry,
    files: Map<string, FileRow>,
    commands: CommandRow[],
    comms: CommsRow[],
): void {
    const name = call?.name ?? message.name;
    const args = call?.args ?? {};
    const at = entry.at;
    const error = message.isError;

    if (name === "subagent") {
        const action = stringOf(args.action);
        const agent = stringOf(args.name);
        const text = stringOf(args.message);

        if (agent !== "" && text !== "" && (action === "spawn" || action === "send")) {
            comms.push({
                ...(call?.at === undefined ? {} : { at: call.at }),
                dir: "to",
                name: agent,
                kind: "ask",
                text: brief(text, 500),
                entry: call?.entry ?? entry.id,
            });
        }

        return;
    }

    if (name === "bash") {
        const command = stringOf(args.command).trim();

        if (command !== "") {
            commands.push({
                command,
                program: command.split(/\s+/)[0] ?? "",
                status: error ? "error" : "ok",
                ...(call?.at === undefined ? {} : { at: call.at }),
                ...(at === undefined || call?.at === undefined
                    ? {}
                    : { ms: Math.max(0, at - call.at) }),
                entry: entry.id,
                output: firstLine(textOf(message)),
            });
        }

        return;
    }

    if (name !== "read" && name !== "write" && name !== "edit") {
        return;
    }

    const path = stringOf(args.path).trim();

    if (path === "") {
        return;
    }

    const file = files.get(path) ?? {
        path,
        read: 0,
        written: 0,
        edited: 0,
        added: 0,
        removed: 0,
        ops: [],
    };
    const operation: FileOp = {
        kind: name === "read" ? "read" : name === "write" ? "write" : "edit",
        ...(at === undefined ? {} : { at }),
        entry: entry.id,
        ...(call?.entry === undefined ? {} : { call: call.entry }),
        tool: name,
        ...(error ? { error } : {}),
    };

    if (name === "write" && !error) {
        operation.added = countLines(stringOf(args.content));
    }

    if (name === "edit" && !error) {
        let added = 0;
        let removed = 0;

        for (const edit of Array.isArray(args.edits) ? args.edits : []) {
            const item = recordOf(edit);

            added += countLines(stringOf(item.newText));
            removed += countLines(stringOf(item.oldText));
        }

        operation.added = added;
        operation.removed = removed;
    }

    file.ops.push(operation);
    file.added += operation.added ?? 0;
    file.removed += operation.removed ?? 0;

    if (operation.kind === "read") {
        file.read++;
    } else if (operation.kind === "write") {
        file.written++;
    } else {
        file.edited++;
    }

    files.set(path, file);
}

function textOf(message: TranscriptMessage): string {
    if (message.role !== "toolResult") {
        return "";
    }

    return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** What a part shows as one line, for a list that opens it whole. */
function previewOf(part: TranscriptPart): string {
    if (part.type === "image") {
        return part.mimeType === undefined ? "an image" : `an image, ${part.mimeType}`;
    }

    if (part.type === "toolCall") {
        const text = part.arguments === undefined ? "" : (JSON.stringify(part.arguments) ?? "");

        return `${part.name} ${text}`.trim().slice(0, 160);
    }

    const text = part.text.replace(/\s+/g, " ").trim();

    return text.length <= 160 ? text : `${text.slice(0, 160)}…`;
}

/** The reply in one short line: its words, or the tools it called. */
function answerBrief(
    message: Extract<TranscriptMessage, { role: "assistant" }>,
): string | undefined {
    const text = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    if (text !== "") {
        return text.length <= 180 ? text : `${text.slice(0, 180)}…`;
    }

    const tools = message.parts.flatMap((part) => (part.type === "toolCall" ? [part.name] : []));

    return tools.length === 0 ? undefined : tools.join(", ");
}

/** A text as one field shows it: one line, at most `limit` characters. */
function brief(text: string, limit: number): string {
    const line = text.replace(/\s+/g, " ").trim();

    return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}
