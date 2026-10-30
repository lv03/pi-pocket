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
import type {
    ModelContextSnapshot,
    TranscriptEdit,
    TranscriptEntry,
    TranscriptMessage,
    TranscriptPart,
} from "./host.ts";
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
    /** Prompt and output counters, with reasoning already included in output. */
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
    ttftMs?: number;
    durationMs?: number;
    outputTokensPerSecond?: number;
    timing?: { startedAt: number; endedAt: number; firstTokenAt?: number };
    accuracy?: {
        usage: "measured" | "unavailable";
        composition: "estimated";
        timing: "recorded" | "unavailable";
    };
    /** Billing may include provider-specific counters. Context pressure uses the counter sum. */
    billedTotal?: number;
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
    kind: "read" | "write" | "edit" | "search";
    at?: number;
    /** The tool result's entry. */
    entry: number;
    /** The answer that made the call, for the text it wrote or replaced. */
    call?: number;
    added?: number;
    removed?: number;
    tool: string;
    error?: boolean;
    callId?: string;
    nested?: number[];
    status?: string;
    requested?: { offset?: number; limit?: number; startLine?: number; endLine?: number };
    returned?: { startLine?: number; endLine?: number; lines?: number; bytes?: number };
    completeness?: "complete" | "partial" | "unknown";
    output?: string;
    clipped?: number;
    contentComplete?: boolean;
    outputRecorded?: boolean;
    details?: unknown;
    matches?: unknown;
    arguments?: unknown;
    changedLinesMethod?: "stored" | "stored-patch" | "replacement-line-count";
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
    status: "ok" | "error" | "running" | "unknown";
    at?: number;
    ms?: number;
    entry: number;
    output: string;
    fullOutput?: string;
    clipped?: number;
    contentComplete?: boolean;
    outputRecorded?: boolean;
    startedAt?: number;
    endedAt?: number;
    durationMethod?: "recorded" | "entry-timestamps";
    callId?: string;
    nested?: number[];
    backgroundId?: string;
    details?: unknown;
}

export interface ProgramGroup {
    program: string;
    count: number;
    ok: number;
    error: number;
    running: number;
    unknown: number;
    durationMs: number;
    entries: number[];
}

/** One message between a session and one of its subagents. */
export interface CommsRow {
    at?: number;
    /** `to` the subagent, or `from` it. */
    dir: "to" | "from";
    name: string;
    kind: "ask" | "report";
    text: string;
    clipped?: number;
    contentComplete?: boolean;
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
export interface ItemLocator {
    conversationId?: number;
    imageIndex?: number;
    entry: number;
    message: number;
    part?: number;
    section?: string;
    tool?: string;
    edit?: { entry: number; index: number; target: number };
    synthetic?: boolean;
}

export interface Item {
    key: string;
    locator: ItemLocator;
    text?: string;
    description?: string;
    parameters?: unknown;
    content?: unknown;
    image?: Record<string, unknown>;
    attribution?: unknown;
    contentComplete?: boolean;
    tokenMethod: "native-meter" | "native-image-estimate" | "character-estimate";
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
    programGroups: ProgramGroup[];
    accuracy: {
        context: "measured" | "estimated";
        composition: "estimated";
        reconstruction: "projected-transcript";
        images: "native-meter";
    };
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

    return entry.kind === "pi.compaction" ||
        isInjection(message) ||
        /^\[subagent [^\]\s]+/.test(text)
        ? "inject"
        : "user";
}

function partTokens(part: TranscriptPart): number {
    return part.type === "image" ? (part.tokens > 0 ? part.tokens : IMAGE_TOKENS) : part.tokens;
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
        sum += partTokens(part);
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
    billedTotal: number;
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
        total: input + output + cacheRead + cacheWrite,
        billedTotal: billed,
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
    id?: string;
    nested?: number[];
}

function stringOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function recordOf(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

interface SectionState {
    text: string;
    tokens: number;
    locator: ItemLocator;
}
interface ToolState extends ToolRow {
    description?: string;
    parameters?: unknown;
    locator: ItemLocator;
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
    const completedCalls = new Set<string>();
    const edits = new Map<number, TranscriptEdit>();
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const editSources = new Map<number, { entry: number; index: number; target: number }>();
    const sections = new Map<string, SectionState>();
    const tools = new Map<string, ToolState>();

    /** Indices of the entries in the model's context, in reading order. */
    let active: number[] = [];
    let turn = 0;
    let last: { provider?: string; model?: string } = {};
    /** The newest head marker: a measurement from before it describes a context that is gone. */
    let boundary = 0;
    let editedAt = 0;
    let systemApplied = 0;
    let partsApplied = 0;
    let cachedParts = emptyParts();
    let cachedUser: string | undefined;
    let userCached = false;

    const invalidate = (): void => {
        systemApplied = 0;
        partsApplied = 0;
        cachedParts = emptyParts();
        userCached = false;
    };

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

    const locatorOf = (index: number, message: TranscriptMessage): ItemLocator => {
        const entry = entries[index]!;
        const edit = edits.get(entry.id);
        const messages = edit?.action === "replace" ? edit.messages : (entry.messages ?? []);

        const source = editSources.get(entry.id);
        const owner = source === undefined ? entry : (entryById.get(source.entry) ?? entry);

        return {
            entry: owner.id,
            message: messages.indexOf(message),
            ...(owner.conversationId === undefined ? {} : { conversationId: owner.conversationId }),
            ...(source === undefined ? {} : { edit: source }),
        };
    };

    // Replay the active contributions so resets and edits also remove obsolete sections and tools.
    const replaySystem = (): void => {
        if (systemApplied === 0) {
            sections.clear();
            tools.clear();
        }

        for (let position = systemApplied; position < active.length; position++) {
            const index = active[position]!;

            for (const message of contribution(index)) {
                if (message.role !== "system") {
                    continue;
                }

                for (const [key, text] of Object.entries(message.sections ?? {})) {
                    if (text === null) {
                        sections.delete(key);
                    } else {
                        sections.set(key, {
                            text,
                            tokens: textTokens(text),
                            locator: { ...locatorOf(index, message), section: key },
                        });
                    }
                }

                if (message.content !== "") {
                    sections.set("content", {
                        text: message.content,
                        tokens: textTokens(message.content),
                        locator: { ...locatorOf(index, message), section: "content" },
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
                        ...(tool.description === undefined
                            ? {}
                            : { description: tool.description }),
                        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
                        locator: { ...locatorOf(index, message), tool: tool.name },
                    });
                }
            }
        }

        systemApplied = active.length;
    };

    const partsNow = (): Parts => {
        replaySystem();

        for (let position = partsApplied; position < active.length; position++) {
            const index = active[position]!;

            for (const message of contribution(index)) {
                partsOfMessage(message, cachedParts, entries[index]!);
            }
        }

        partsApplied = active.length;
        const parts = { ...cachedParts };

        for (const [key, section] of sections) {
            parts[sectionGroup(key)] += section.tokens;
        }

        for (const tool of tools.values()) {
            parts.tools += tool.tokens;
        }

        return parts;
    };

    const tokenNow = (): number => total(partsNow());

    /** The newest message a person wrote in the context, as one short line. */
    const lastUser = (): string | undefined => {
        if (userCached) {
            return cachedUser;
        }

        userCached = true;
        cachedUser = undefined;

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
                    cachedUser = text.length <= 180 ? text : `${text.slice(0, 180)}…`;

                    return cachedUser;
                }
            }
        }

        return undefined;
    };

    const itemsNow = (): Item[] => {
        const items: Item[] = [];

        for (const [key, section] of sections) {
            items.push({
                key: `section:${key}`,
                locator: section.locator,
                text: section.text,
                content: section.text,
                contentComplete: true,
                tokenMethod: "character-estimate",
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
                key: `schema:${tool.name}`,
                locator: tool.locator,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
                content: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
                contentComplete: true,
                tokenMethod: "native-meter",
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

                    for (const [partIndex, value] of message.parts.entries()) {
                        const file =
                            value.type === "text" ? /^<file name="([^"]+)"/.exec(value.text) : null;

                        items.push({
                            ...itemDetail(
                                value,
                                {
                                    ...locatorOf(index, message),
                                    part: partIndex,
                                },
                                message,
                            ),
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
                    for (const [partIndex, value] of message.parts.entries()) {
                        items.push({
                            ...itemDetail(
                                value,
                                {
                                    ...locatorOf(index, message),
                                    part: partIndex,
                                },
                                message,
                            ),
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
                    for (const [partIndex, value] of message.parts.entries()) {
                        items.push({
                            ...itemDetail(
                                value,
                                {
                                    ...locatorOf(index, message),
                                    part: partIndex,
                                },
                                message,
                            ),
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
                            tokens: partTokens(value),
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

            if (entry.id <= boundary || entry.id < editedAt) {
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

        if ((entry.edits?.length ?? 0) > 0) {
            editedAt = entry.id;
            invalidate();
        }

        for (const [editIndex, edit] of (entry.edits ?? []).entries()) {
            edits.set(edit.target, edit);
            editSources.set(edit.target, {
                entry: entry.id,
                index: editIndex,
                target: edit.target,
            });
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

            const toolState = (rows: Map<string, ToolState>) =>
                JSON.stringify([...rows.values()].map(({ locator: _locator, ...tool }) => tool));

            if (toolState(beforeTools) !== toolState(tools)) {
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
            editSources.clear();

            for (let each = 0; each <= index; each++) {
                const candidate = entries[each]!;

                if (candidate.id < head) {
                    continue;
                }

                for (const [editIndex, edit] of (candidate.edits ?? []).entries()) {
                    edits.set(edit.target, edit);
                    editSources.set(edit.target, {
                        entry: candidate.id,
                        index: editIndex,
                        target: edit.target,
                    });
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
            invalidate();
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
            userCached = false;
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
                        text: report[2]!,
                        ...clippingOf(message),
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
                const timing = timingOf(message, measured.output);

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
                    billedTotal: measured.billedTotal,
                    ...timing,
                    accuracy: {
                        usage: measured.total > 0 ? "measured" : "unavailable",
                        composition: "estimated",
                        timing:
                            timing.timing === undefined && timing.durationMs === undefined
                                ? "unavailable"
                                : "recorded",
                    },
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
                                id: part.id,
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
            for (const message of entry.messages ?? []) {
                if (message.role === "toolResult") {
                    completedCalls.add(message.callId);
                    collect(message, calls.get(message.callId), entry, files, commands, comms);
                    collectNested(
                        message,
                        calls.get(message.callId),
                        entry,
                        files,
                        commands,
                        comms,
                    );
                }
            }

            active.push(index);
            continue;
        }

        active.push(index);
    }

    for (const [id, call] of calls) {
        if (!completedCalls.has(id) && ["bash", "shell", "background"].includes(call.name)) {
            collect(
                {
                    role: "toolResult",
                    callId: id,
                    name: call.name,
                    parts: [],
                    tokens: 0,
                    isError: false,
                    ...{ details: { status: "running", outputRecorded: false } },
                },
                call,
                { id: call.entry, kind: "pending" },
                files,
                commands,
                comms,
            );
        }
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
    sections: Map<string, SectionState>;
    tools: Map<string, ToolState>;
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
    const toolRows: ToolRow[] = [...input.tools.values()].map(({ name, tokens, source }) => ({
        name,
        tokens,
        ...(source === undefined ? {} : { source }),
    }));
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
        programGroups: groupPrograms(input.commands),
        accuracy: {
            context: input.estimated ? "estimated" : "measured",
            composition: "estimated",
            reconstruction: "projected-transcript",
            images: "native-meter",
        },
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
    const details = resultDetails(message, entry);
    const succeeded = !error && details.resultAvailable !== false;
    const fullOutput = textOf(message);
    let status = stringOf(details.status);
    const nested = call?.nested;
    const callId = call?.id ?? message.callId;

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
                text,
                contentComplete: true,
                entry: call?.entry ?? entry.id,
            });
        }

        return;
    }

    if (name === "bash" || name === "shell" || name === "background") {
        const backgroundId =
            stringOf(details.backgroundId ?? details.id ?? args.id) ||
            (/^Started (\S+)/.exec(fullOutput)?.[1] ?? "");
        const action = stringOf(args.action);
        const existing =
            name === "background" && backgroundId !== ""
                ? commands.findLast((command) => command.backgroundId === backgroundId)
                : undefined;
        const command = stringOf(args.command ?? details.command) || existing?.command || "";

        if (name === "background" && status === "") {
            const state = /^(?:\S+: )?(running|starting|stopped|exited with code (-?\d+))\b/i.exec(
                fullOutput,
            );

            status = /^Stopped \S+\./.test(fullOutput)
                ? "stopped"
                : state?.[2] === "0"
                  ? "ok"
                  : state?.[2] !== undefined
                    ? "error"
                    : (state?.[1]?.toLowerCase() ??
                      (action === "output" ? (existing?.status ?? "") : ""));
        }

        const startedAt = finite(details.startedAt) ?? existing?.startedAt ?? call?.at;
        const endedAt =
            finite(details.endedAt) ??
            (status === "running" ||
            status === "starting" ||
            (name === "background" && action === "start")
                ? undefined
                : at);
        const recordedDuration = finite(
            details.durationMs ??
                (name === "background" ? undefined : recordOf(message).durationMs),
        );
        const measuredStart =
            startedAt ??
            (recordedDuration === undefined || endedAt === undefined
                ? undefined
                : endedAt - recordedDuration);
        const ms =
            recordedDuration ??
            (startedAt === undefined || endedAt === undefined
                ? undefined
                : Math.max(0, endedAt - startedAt));

        if (command.trim() !== "") {
            const running =
                status === "running" ||
                status === "starting" ||
                (name === "background" &&
                    action === "start" &&
                    !error &&
                    !["ok", "completed", "error", "stopped"].includes(status));
            const row: CommandRow = {
                command,
                program: programOf(command),
                status:
                    details.resultAvailable === false && !["running", "pending"].includes(status)
                        ? "unknown"
                        : error || ["error", "failed", "cancelled", "interrupted"].includes(status)
                          ? "error"
                          : running
                            ? "running"
                            : "ok",
                ...(measuredStart === undefined
                    ? {}
                    : { at: measuredStart, startedAt: measuredStart }),
                ...(endedAt === undefined ? {} : { endedAt }),
                ...(ms === undefined
                    ? {}
                    : {
                          ms,
                          durationMethod:
                              recordedDuration === undefined ? "entry-timestamps" : "recorded",
                      }),
                entry: entry.id,
                output: firstLine(fullOutput),
                fullOutput,
                ...clippingOf(message, details),
                outputRecorded: details.outputRecorded !== false,
                ...(details.outputRecorded === false ? { contentComplete: false } : {}),
                callId,
                ...(nested === undefined ? {} : { nested }),
                ...(backgroundId === "" ? {} : { backgroundId }),
                ...(Object.keys(details).length === 0 ? {} : { details }),
            };

            if (existing !== undefined && action !== "start") {
                const combinedOutput = `${existing.fullOutput ?? ""}\n${fullOutput}`;
                const contentComplete =
                    existing.contentComplete !== false && row.contentComplete !== false;
                const clipped = (existing.clipped ?? 0) + (row.clipped ?? 0);

                Object.assign(existing, row, {
                    startedAt: existing.startedAt,
                    at: existing.at,
                    fullOutput: combinedOutput,
                    contentComplete,
                    ...(clipped > 0 ? { clipped } : {}),
                });
            } else {
                commands.push(row);
            }
        }

        return;
    }

    const kind = ["read", "read_file"].includes(name)
        ? "read"
        : ["write", "write_file"].includes(name)
          ? "write"
          : ["edit", "edit_file", "apply_patch"].includes(name)
            ? "edit"
            : ["grep", "rg", "search", "search_files", "find"].includes(name)
              ? "search"
              : undefined;

    if (kind === undefined) {
        return;
    }

    const path = stringOf(args.path ?? args.file_path ?? args.filePath ?? details.path).trim();

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
        kind,
        callId,
        ...(nested === undefined ? {} : { nested }),
        ...(status === "" ? {} : { status }),
        ...(details.resultAvailable === false
            ? { status: status === "running" ? "running" : "unknown" }
            : {}),
        output: fullOutput,
        ...clippingOf(message, details),
        outputRecorded: details.outputRecorded !== false,
        ...(details.outputRecorded === false ? { contentComplete: false } : {}),
        arguments: args,
        ...(Object.keys(details).length === 0 ? {} : { details }),
        ...(details.matches === undefined ? {} : { matches: details.matches }),
        ...(at === undefined ? {} : { at }),
        entry: entry.id,
        ...(call?.entry === undefined ? {} : { call: call.entry }),
        tool: name,
        ...(error ? { error } : {}),
    };

    if (kind === "read") {
        const requested = {
            ...(finite(args.offset) === undefined ? {} : { offset: finite(args.offset) }),
            ...(finite(args.limit) === undefined ? {} : { limit: finite(args.limit) }),
            ...(finite(args.startLine) === undefined ? {} : { startLine: finite(args.startLine) }),
            ...(finite(args.endLine) === undefined ? {} : { endLine: finite(args.endLine) }),
        };
        const returned = recordOf(details.returned ?? details.range);
        const truncation = recordOf(details.truncation);
        const diagnostics = Array.isArray(details.diagnostics) ? details.diagnostics : [];
        const diagnosticText = diagnostics
            .map((value) => stringOf(recordOf(value).message))
            .join("\n");
        const shown = /Showing lines (\d+)-(\d+) of (\d+)/.exec(diagnosticText);
        const startLine =
            finite(returned.startLine ?? details.startLine) ??
            (shown === null ? undefined : Number(shown[1]));
        const endLine =
            finite(returned.endLine ?? details.endLine) ??
            (shown === null ? undefined : Number(shown[2]));
        const lines = finite(returned.lines ?? truncation.outputLines);
        const bytes = finite(returned.bytes ?? truncation.outputBytes);

        operation.requested = requested;
        operation.completeness =
            details.complete === true || details.completeness === "complete"
                ? "complete"
                : details.complete === false ||
                    details.completeness === "partial" ||
                    truncation.truncated === true ||
                    shown !== null ||
                    /more lines in file|Use offset=\d+ to continue/.test(diagnosticText)
                  ? "partial"
                  : "unknown";

        if (!error && [startLine, endLine, lines, bytes].some((value) => value !== undefined)) {
            operation.returned = {
                ...(startLine === undefined ? {} : { startLine }),
                ...(endLine === undefined ? {} : { endLine }),
                ...(lines === undefined ? {} : { lines }),
                ...(bytes === undefined ? {} : { bytes }),
            };
        }
    }

    if (kind === "write" && succeeded && typeof args.content === "string") {
        operation.added = countLines(args.content);
        operation.changedLinesMethod = "replacement-line-count";
    }

    if (kind === "edit" && succeeded) {
        let added = 0;
        let removed = 0;

        const replacements = Array.isArray(args.edits)
            ? args.edits
            : typeof args.oldText === "string" || typeof args.old_string === "string"
              ? [args]
              : [];

        for (const edit of replacements) {
            const item = recordOf(edit);

            added += countLines(stringOf(item.newText ?? item.new_string));
            removed += countLines(stringOf(item.oldText ?? item.old_string));
        }

        if (replacements.length > 0) {
            operation.added = added;
            operation.removed = removed;
            operation.changedLinesMethod = "replacement-line-count";
        }
    }

    const patch = stringOf(details.patch);

    if (succeeded && patch !== "") {
        const lines = patch.split("\n");

        operation.added = lines.filter(
            (line) => line.startsWith("+") && !line.startsWith("+++ "),
        ).length;
        operation.removed = lines.filter(
            (line) => line.startsWith("-") && !line.startsWith("--- "),
        ).length;
        operation.changedLinesMethod = "stored-patch";
    }

    if (
        succeeded &&
        (finite(details.added) !== undefined || finite(details.removed) !== undefined)
    ) {
        operation.added = finite(details.added);
        operation.removed = finite(details.removed);
        operation.changedLinesMethod = "stored";
    }

    file.ops.push(operation);
    file.added += operation.added ?? 0;
    file.removed += operation.removed ?? 0;

    if (operation.kind === "read") {
        file.read++;
    } else if (operation.kind === "write") {
        file.written++;
    } else if (operation.kind === "edit") {
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

/** Full recorded detail for precisely one selected part. */
export function itemDetail(
    part: TranscriptPart,
    locator: ItemLocator,
    message?: TranscriptMessage,
): Pick<
    Item,
    | "key"
    | "locator"
    | "content"
    | "text"
    | "image"
    | "attribution"
    | "contentComplete"
    | "tokenMethod"
> {
    const edit = locator.edit;
    const suffix = edit === undefined ? "" : `:edit:${edit.entry}:${edit.index}`;
    const source = message === undefined ? undefined : recordOf(message).source;
    const metadata = recordOf(part);
    const { type: _type, tokens: _tokens, ...image } = metadata;

    const imageLocator =
        part.type === "image" && finite(metadata.imageIndex) !== undefined
            ? { ...locator, imageIndex: Number(metadata.imageIndex) }
            : locator;

    return {
        key: `entry:${locator.entry}:message:${locator.message}:part:${locator.part}${suffix}`,
        locator: imageLocator,
        content: part,
        ...(part.type === "text" || part.type === "thinking" ? { text: part.text } : {}),
        ...(part.type === "image" ? { image: { ...image, locator: imageLocator } } : {}),
        ...(source === undefined ? {} : { attribution: source }),
        contentComplete: !(typeof metadata.clipped === "number" && metadata.clipped > 0),
        tokenMethod: part.type === "image" ? "native-image-estimate" : "native-meter",
    };
}

function isInjection(message: TranscriptMessage): boolean {
    const source = recordOf(message).source;
    const kind =
        typeof source === "string"
            ? source
            : stringOf(recordOf(source).kind ?? recordOf(source).type);

    return kind !== "" && !["user", "human", "input"].includes(kind);
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timingOf(message: TranscriptMessage, output: number): Partial<Step> {
    const raw = recordOf(message);
    const timing = recordOf(raw.pocketTiming);
    const startedAt = finite(timing.startedAt);
    const endedAt = finite(timing.endedAt);
    const firstTokenAt = finite(timing.firstTokenAt);

    if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) {
        const durationMs = finite(raw.durationMs);

        return durationMs === undefined || durationMs < 0 ? {} : { durationMs };
    }

    const validFirst =
        firstTokenAt !== undefined && firstTokenAt >= startedAt && firstTokenAt <= endedAt;
    const decodeMs = validFirst ? endedAt - firstTokenAt : undefined;

    return {
        timing: { startedAt, endedAt, ...(validFirst ? { firstTokenAt } : {}) },
        durationMs: endedAt - startedAt,
        ...(validFirst ? { ttftMs: firstTokenAt - startedAt } : {}),
        ...(decodeMs !== undefined && decodeMs > 0 && output > 0
            ? { outputTokensPerSecond: (output * 1000) / decodeMs }
            : {}),
    };
}

function groupPrograms(commands: readonly CommandRow[]): ProgramGroup[] {
    const groups = new Map<string, ProgramGroup>();

    for (const command of commands) {
        const group = groups.get(command.program) ?? {
            program: command.program,
            count: 0,
            ok: 0,
            error: 0,
            running: 0,
            unknown: 0,
            durationMs: 0,
            entries: [],
        };

        group.count++;
        group[command.status]++;
        group.durationMs += command.ms ?? 0;
        group.entries.push(command.entry);
        groups.set(command.program, group);
    }

    return [...groups.values()].sort(
        (a, b) => b.count - a.count || a.program.localeCompare(b.program),
    );
}

function programOf(command: string): string {
    const words = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    let index = 0;

    while (
        index < words.length &&
        (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[index]!) ||
            ["env", "sudo", "command", "nohup"].includes(words[index]!))
    ) {
        index++;
    }

    return (
        (words[index] ?? "")
            .replace(/^['"]|['"]$/g, "")
            .split("/")
            .pop() ?? ""
    );
}

function parseArgs(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") {
        return recordOf(value);
    }

    try {
        return recordOf(JSON.parse(value));
    } catch {
        return {};
    }
}

function clippingOf(
    message: TranscriptMessage,
    details: Record<string, unknown> = {},
): { clipped?: number; contentComplete: boolean } {
    const clipped =
        message.role === "system"
            ? (finite(details.clipped) ?? 0)
            : message.parts.reduce((sum, part) => sum + (finite(recordOf(part).clipped) ?? 0), 0) +
              (finite(details.clipped) ?? 0);

    const diagnostics = Array.isArray(details.diagnostics) ? details.diagnostics : [];
    const truncated =
        recordOf(details.truncation).truncated === true ||
        details.truncated === true ||
        diagnostics.some((value) =>
            ["truncated", "output_truncated"].includes(stringOf(recordOf(value).code)),
        );

    return { ...(clipped > 0 ? { clipped } : {}), contentComplete: clipped === 0 && !truncated };
}

function resultDetails(
    message: TranscriptMessage,
    entry: TranscriptEntry,
): Record<string, unknown> {
    const data = recordOf(entry.data);
    const stored = recordOf(data.result);

    return {
        ...data,
        ...recordOf(data.details),
        ...stored,
        ...recordOf(stored.details),
        ...recordOf(recordOf(message).details),
        ...(recordOf(message).nestedCalls === undefined
            ? {}
            : { nestedCalls: recordOf(message).nestedCalls }),
    };
}

/** Nested records can carry exact arguments and results, or only a bounded receipt. Keep that distinction. */
function collectNested(
    message: Extract<TranscriptMessage, { role: "toolResult" }>,
    parent: Call | undefined,
    entry: TranscriptEntry,
    files: Map<string, FileRow>,
    commands: CommandRow[],
    comms: CommsRow[],
): void {
    const seen = new Set<unknown>();

    const visit = (container: Record<string, unknown>, prefix: number[]): void => {
        const nested = container.nestedCalls ?? container.nestedTools ?? container.nested;
        const rows = Array.isArray(nested) ? nested : (recordOf(nested).calls ?? container.calls);

        if (!Array.isArray(rows) || seen.has(rows)) {
            return;
        }

        seen.add(rows);

        for (const [index, value] of rows.entries()) {
            const row = recordOf(value);
            const call = recordOf(row.call);
            const result = recordOf(row.result);
            const name = stringOf(row.name ?? row.toolName ?? call.name);
            const nested = [...prefix, index];
            const args = {
                ...parseArgs(row.args ?? row.arguments ?? call.arguments),
                ...(typeof row.path === "string" ? { path: row.path } : {}),
            };
            const output =
                row.textOutputRecorded === false
                    ? undefined
                    : (row.output ??
                      row.structuredOutput ??
                      result.output ??
                      result.structuredOutput);
            const outputText =
                typeof output === "string" ? output : stringOf(recordOf(output).output);
            const parts: TranscriptPart[] = Array.isArray(output)
                ? output.flatMap((part) => {
                      const item = recordOf(part);

                      return item.type === "text" && typeof item.text === "string"
                          ? [
                                {
                                    type: "text" as const,
                                    text: item.text,
                                    tokens: textTokens(item.text),
                                },
                            ]
                          : [];
                  })
                : outputText === ""
                  ? []
                  : [{ type: "text", text: outputText, tokens: textTokens(outputText) }];
            const status = stringOf(row.status);
            const failed =
                row.isError === true ||
                result.isError === true ||
                [
                    "error",
                    "failed",
                    "faulted",
                    "orphaned",
                    "cancelled",
                    "aborted",
                    "interrupted",
                ].includes(status);
            const details = {
                ...row,
                ...recordOf(row.details),
                ...result,
                ...recordOf(result.details),
                outputRecorded: output !== undefined,
            };
            const nestedMessage = {
                role: "toolResult" as const,
                callId: String(
                    row.callId ?? call.id ?? row.id ?? `${message.callId}/${nested.join("/")}`,
                ),
                name,
                parts,
                tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
                isError: failed,
                details,
            };
            const startedAt = finite(row.startedAt);

            if (name !== "") {
                collect(
                    nestedMessage,
                    {
                        name,
                        args,
                        entry: parent?.entry ?? entry.id,
                        id: nestedMessage.callId,
                        nested,
                        ...(startedAt === undefined ? {} : { at: startedAt }),
                    },
                    { ...entry, data: undefined },
                    files,
                    commands,
                    comms,
                );
            }

            visit(details, nested);
        }
    };

    visit(resultDetails(message, entry), []);
}

/** Convert authoritative projected native messages without deriving or changing their ordering. */
export function itemsFromSnapshot(
    snapshot: Pick<ModelContextSnapshot, "messages" | "messageOrigins" | "entries">,
): Item[] {
    const owners = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const prompt = new Map<string, Item>();
    const items: Item[] = [];

    for (const [index, message] of snapshot.messages.entries()) {
        const origin = snapshot.messageOrigins[index];
        const stored = origin !== undefined && "entryId" in origin ? origin : undefined;
        const owner = stored === undefined ? undefined : owners.get(stored.entryId);
        const locator: ItemLocator = {
            entry: stored?.entryId ?? 0,
            message: stored?.messageIndex ?? index,
            ...(owner?.conversationId === undefined
                ? {}
                : { conversationId: owner.conversationId }),
            ...(stored === undefined ? { synthetic: true } : {}),
            ...(stored?.editIndex === undefined
                ? {}
                : {
                      edit: {
                          entry: stored.entryId,
                          index: stored.editIndex,
                          target: stored.targetEntryId ?? stored.entryId,
                      },
                  }),
        };

        if (message.role === "system") {
            const sections = {
                ...(message.sections ?? {}),
                ...(message.content === "" ? {} : { content: message.content }),
            };

            for (const [name, text] of Object.entries(sections)) {
                const key = `section:${name}`;

                if (text === null) {
                    prompt.delete(key);
                } else {
                    prompt.set(key, {
                        key,
                        locator: { ...locator, section: name },
                        entry: 0,
                        part: 0,
                        role: "section",
                        category: sectionGroup(name),
                        label: name,
                        tokens: textTokens(text),
                        preview: text.slice(0, 160),
                        text,
                        content: text,
                        contentComplete: true,
                        tokenMethod: "character-estimate",
                    });
                }
            }

            for (const name of message.toolsRemoved ?? []) {
                prompt.delete(`schema:${name}`);
            }

            for (const tool of message.tools ?? []) {
                const key = `schema:${tool.name}`;

                prompt.set(key, {
                    key,
                    locator: { ...locator, tool: tool.name },
                    entry: 0,
                    part: 0,
                    role: "schema",
                    category: "tools",
                    label: tool.name,
                    tokens: tool.tokens,
                    preview: "",
                    description: tool.description,
                    parameters: tool.parameters,
                    content: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    },
                    contentComplete: true,
                    tokenMethod: "native-meter",
                    ...(tool.source === undefined ? {} : { source: tool.source }),
                });
            }

            continue;
        }

        for (const [partIndex, part] of message.parts.entries()) {
            const role =
                message.role === "user"
                    ? "user"
                    : message.role === "toolResult"
                      ? "tool"
                      : part.type === "thinking"
                        ? "thinking"
                        : part.type === "toolCall"
                          ? "toolCall"
                          : "answers";
            const category =
                role === "user"
                    ? userCategory(
                          message as Extract<TranscriptMessage, { role: "user" }>,
                          owner ?? { id: locator.entry, kind: "" },
                      )
                    : role === "toolCall"
                      ? "toolCalls"
                      : role;
            const label =
                message.role === "toolResult"
                    ? message.name
                    : part.type === "toolCall"
                      ? part.name
                      : role === "user"
                        ? "You"
                        : role === "thinking"
                          ? "Reasoning"
                          : "Answer";

            items.push({
                ...itemDetail(part, { ...locator, part: partIndex }, message),
                entry: stored?.targetEntryId ?? locator.entry,
                part: partIndex,
                role,
                category,
                label,
                tokens: partTokens(part),
                preview: previewOf(part),
            });
        }
    }

    return [...prompt.values(), ...items];
}

export interface NormalizedRequest {
    entries: readonly TranscriptEntry[];
    messages: TranscriptMessage[];
    accuracy: "reconstructed";
    syntheticResults: number;
}

/** Request before an assistant entry. Native modelContext remains authoritative. */
export function normalizedRequest(
    entries: readonly TranscriptEntry[],
    assistantEntryId?: number,
): NormalizedRequest {
    const cut =
        assistantEntryId === undefined
            ? entries.length
            : entries.findIndex((entry) => entry.id === assistantEntryId);
    const history = entries.slice(0, cut < 0 ? entries.length : cut);
    const marker = history.findLast(
        (entry) =>
            entry.head !== undefined || entry.kind === "pi.compaction" || entry.kind === "pi.reset",
    );
    const range =
        marker === undefined
            ? history
            : history.filter((entry) => entry.id >= (marker.head ?? marker.id));
    const active =
        marker === undefined
            ? range
            : [
                  marker,
                  ...range.filter(
                      (entry) =>
                          entry !== marker &&
                          entry.head === undefined &&
                          entry.kind !== "pi.compaction" &&
                          entry.kind !== "pi.reset",
                  ),
              ];
    const edits = new Map<number, TranscriptEdit>();

    for (const entry of range) {
        for (const edit of entry.edits ?? []) {
            edits.set(edit.target, edit);
        }
    }

    const messages = active.flatMap((entry) => {
        const edit = edits.get(entry.id);

        return edit?.action === "omit"
            ? []
            : [...(edit?.action === "replace" ? edit.messages : (entry.messages ?? []))].filter(
                  (message) =>
                      message.role !== "assistant" || !EXCLUDED.has(message.stopReason ?? ""),
              );
    });
    const ordered: TranscriptMessage[] = [];
    let syntheticResults = 0;

    for (const [index, message] of messages.entries()) {
        if (message.role === "toolResult") {
            continue;
        }

        ordered.push(message);

        if (message.role !== "assistant") {
            continue;
        }

        const results = new Map<string, TranscriptMessage>();

        for (
            let next = index + 1;
            next < messages.length && messages[next]!.role !== "assistant";
            next++
        ) {
            const result = messages[next]!;

            if (result.role === "toolResult" && !results.has(result.callId)) {
                results.set(result.callId, result);
            }
        }

        for (const call of message.parts) {
            if (call.type !== "toolCall") {
                continue;
            }

            const result = results.get(call.id);

            if (result !== undefined) {
                ordered.push(result);
            } else {
                const text = "Tool result unavailable: history ends before this call completed.";

                ordered.push({
                    role: "toolResult",
                    callId: call.id,
                    name: call.name,
                    parts: [{ type: "text", text, tokens: textTokens(text) }],
                    tokens: textTokens(text),
                    isError: true,
                    ...{ details: { reason: "missing_result" } },
                });
                syntheticResults++;
            }
        }
    }

    const baseline = active.find(
        (entry) =>
            (marker === undefined || entry.id > marker.id) &&
            (entry.kind === "pi.system" ||
                entry.messages?.some((message) => message.role === "system") ||
                entry.edits?.some(
                    (edit) =>
                        edit.action === "replace" &&
                        edit.messages.some((message) => message.role === "system"),
                )),
    );
    const firstSystem = ordered.findIndex((message) => message.role === "system");
    const baselineSystem =
        baseline?.kind === "pi.system"
            ? baseline.messages?.find((message) => message.role === "system")
            : undefined;

    if (
        firstSystem > 0 &&
        (ordered[firstSystem] === baselineSystem ||
            ordered.slice(0, firstSystem).every((message) => message.role === "user"))
    ) {
        ordered.unshift(ordered.splice(firstSystem, 1)[0]!);
    }

    return { entries: active, messages: ordered, accuracy: "reconstructed", syntheticResults };
}
