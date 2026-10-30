/**
 * A conversation's stored history, as people read it: single entries (its own, or ones a fork inherited), the images
 * in them, what came before the active context, and the whole session as Markdown.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type Message, type Usage } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
    type ContextEdit,
    type ConversationId,
    type ConversationRecord,
    type Cursor,
    type EntryId,
    type EntryRecord,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { AuthorsDoc } from "./docs.ts";
import { transcriptMarkdown } from "./export.ts";
import type {
    ModelContextOptions,
    ModelContextSnapshot,
    ModelMessageOrigin,
    TranscriptEdit,
    TranscriptEntry,
    TranscriptMessage,
    TranscriptOptions,
    TranscriptPage,
    TranscriptPart,
    TranscriptTool,
} from "./host.ts";
import { homePath } from "./paths.ts";
import { HttpError } from "./errors.ts";
import { type ClientEntry, projectEntry } from "./projection.ts";
import { ToolActivity, type ToolActivityRow } from "./tool-activity.ts";

const context = BACKGROUND_CONTEXT;
/** Tokens Pi's meter counts for one image: its fixed size in characters, divided as text is. */
const IMAGE_TOKENS = Math.ceil(4800 / 3.5);
/** How much text a page carries for one part when `full` is not asked for. */
const TEXT_LIMIT = 8000;

export class Transcripts {
    readonly #app: PocketApp;
    readonly #toolActivity: ToolActivity;

    constructor(app: PocketApp) {
        this.#app = app;
        this.#toolActivity = new ToolActivity(app);
    }

    /** An image part of a stored message: a pasted image, or an image a tool returned. */
    async entryImage(
        id: ConversationId,
        entryId: number,
        index: number,
        location?: { messageIndex?: number; editIndex?: number },
    ): Promise<{ mimeType: string; data: Buffer } | undefined> {
        if (!Number.isInteger(entryId) || !Number.isInteger(index) || index < 0) {
            return undefined;
        }

        const entry = await this.visibleEntry(id, entryId);

        if (entry === undefined) {
            return undefined;
        }

        const replacement =
            location?.editIndex === undefined ? undefined : entry.edits?.[location.editIndex];
        const messages =
            replacement?.action === "replace"
                ? replacement.messages
                : location?.editIndex === undefined
                  ? entry.model
                  : undefined;
        const content = (
            messages?.[location?.messageIndex ?? 0] as { content?: unknown } | undefined
        )?.content;

        if (!Array.isArray(content)) {
            return undefined;
        }

        const part = (content as { type?: string; data?: unknown; mimeType?: unknown }[]).filter(
            (each) => each?.type === "image",
        )[index];

        if (typeof part?.data !== "string" || typeof part.mimeType !== "string") {
            return undefined;
        }

        return { mimeType: part.mimeType, data: Buffer.from(part.data, "base64") };
    }

    async fullEntry(id: ConversationId, entryId: number): Promise<ClientEntry | undefined> {
        const entry = await this.visibleEntry(id, entryId);

        return entry === undefined ? undefined : projectEntry(entry, true);
    }

    /**
     * An entry of a conversation's history: its own, or one it inherited as a fork (the fork's parent's entries up to
     * the fork point, and so on up the line). Undefined for an entry of any other conversation.
     */
    async visibleEntry(id: ConversationId, entryId: number): Promise<EntryRecord | undefined> {
        if (!Number.isInteger(entryId)) {
            return undefined;
        }

        return this.#app.harness.commit(async (tx) => {
            const entry = await tx.entry(entryId as unknown as EntryId);

            if (entry === undefined) {
                return undefined;
            }

            // Walk up the forks: each one inherits its parent's entries through `parent.at`, and no later ones.
            let conversation = id;
            let through = Number.POSITIVE_INFINITY;

            for (;;) {
                if (entry.conversationId === conversation) {
                    return entryId <= through ? entry : undefined;
                }

                const parent: ConversationRecord["parent"] = (await tx.conversation(conversation))
                    ?.parent;

                if (parent === undefined) {
                    return undefined;
                }

                through = Math.min(through, parent.at as unknown as number);
                conversation = parent.conversationId;
            }
        }, context);
    }

    /** Entries before the active context: what compaction or a reset hid from the model. Oldest first. */
    async history(id: ConversationId, before: number, limit = 400): Promise<ClientEntry[]> {
        const conversation = await this.#app.conversation(id);
        const out: ClientEntry[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries(
                { maxEntryId: (before - 1) as unknown as EntryId },
                256,
                cursor,
                context,
            );

            for (const entry of page.items) {
                const projected = projectEntry(entry);

                if (projected !== undefined) {
                    out.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined && out.length < limit);

        return out.slice(0, limit).reverse();
    }

    /** A conversation's whole history, oldest first, as browsers get it (`full`: nothing clipped). */
    async allEntries(id: ConversationId, full: boolean): Promise<ClientEntry[]> {
        return (await this.entriesAfter(id, 0, full)).entries;
    }

    /**
     * The entries of a conversation's history newer than `after`, oldest first, as browsers get them, and the newest id
     * read (`after` when there is none). Entries never change, and a later one has a larger id, inherited ones too.
     */
    async entriesAfter(
        id: ConversationId,
        after: number,
        full: boolean,
    ): Promise<{ entries: ClientEntry[]; last: number }> {
        const conversation = await this.#app.conversation(id);
        const query = after > 0 ? { minEntryId: (after + 1) as unknown as EntryId } : {};
        const entries: ClientEntry[] = [];
        let last = after;
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries(query, 256, cursor, context);

            for (const entry of page.items) {
                last = Math.max(last, entry.id as unknown as number);
                const projected = projectEntry(entry, full);

                if (projected !== undefined) {
                    entries.push(projected);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return { entries: entries.reverse(), last };
    }

    /**
     * A page of a conversation's stored transcript, oldest first: its own entries and those it inherited, with the ones
     * a compaction removed. Each part carries the tokens Pi's meter counts for it.
     */
    async transcript(id: ConversationId, options: TranscriptOptions = {}): Promise<TranscriptPage> {
        const after = Math.max(0, Math.trunc(options.after ?? 0));
        const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
        const full = options.full === true;
        const conversation = await this.#app.conversation(id);
        const page = await conversation.entries(
            { minEntryId: (after + 1) as unknown as EntryId, order: "ascending" },
            limit + 1,
            undefined,
            context,
        );
        const items = page.items.slice(0, limit);
        const sources = this.#app.toolSources();

        return {
            entries: items.map((entry) => transcriptEntry(entry, full, sources)),
            last: items.length === 0 ? after : Number(items[items.length - 1]!.id),
            more: page.items.length > limit || page.next !== undefined,
        };
    }

    /** Native Durable context: edits, stop filtering, ordering, and missing results stay native. */
    async modelContext(
        id: ConversationId,
        options: ModelContextOptions = {},
    ): Promise<ModelContextSnapshot> {
        const conversation = await this.#app.conversation(id);

        if (options.at !== undefined && (await this.visibleEntry(id, options.at)) === undefined) {
            throw new HttpError(404, "That entry is not visible from this conversation.");
        }

        const view = await conversation.context(
            context,
            options.at === undefined ? {} : { at: options.at as EntryId },
        );
        const sources = this.#app.toolSources();
        const origins = new Map<Message, ModelMessageOrigin>();
        const entries = [...view.entries];
        // Older head markers can carry winning edits even though native active entries omit those markers.
        const tail = entries.reduce((latest, entry) => Math.max(latest, Number(entry.id)), 0);
        const edits = new Map<
            number,
            { entry: EntryRecord; index: number; messages: readonly Message[] }
        >();
        let cursor: Cursor | undefined;

        if (tail > 0) {
            do {
                const page = await conversation.entries(
                    {
                        maxEntryId: tail as EntryId,
                        ...(view.head === undefined ? {} : { minEntryId: view.head.head }),
                        order: "ascending",
                    },
                    256,
                    cursor,
                    context,
                );

                for (const entry of page.items) {
                    for (const [index, edit] of (entry.edits ?? []).entries()) {
                        if (edit.action === "replace") {
                            edits.set(Number(edit.target), {
                                entry,
                                index,
                                messages: edit.messages,
                            });
                        } else {
                            edits.delete(Number(edit.target));
                        }
                    }
                }

                cursor = page.next;
            } while (cursor !== undefined);
        }

        for (const [index, entry] of entries.entries()) {
            const replacement = edits.get(Number(entry.id));
            const messages = replacement?.messages ?? entry.model ?? [];
            let from = 0;

            for (const message of view.contributions[index] ?? []) {
                const messageIndex = messages.findIndex(
                    (candidate, at) =>
                        at >= from && (candidate === message || json(candidate) === json(message)),
                );

                if (messageIndex < 0) {
                    continue;
                }

                from = messageIndex + 1;
                origins.set(
                    message,
                    replacement === undefined
                        ? { entryId: Number(entry.id), messageIndex }
                        : {
                              entryId: Number(replacement.entry.id),
                              messageIndex,
                              editIndex: replacement.index,
                              targetEntryId: Number(entry.id),
                          },
                );
            }
        }

        return {
            messages: view.messages.map((message) =>
                transcriptMessage(message, options.full === true, sources),
            ),
            messageOrigins: view.messages.map(
                (message) => origins.get(message) ?? { synthetic: true },
            ),
            entries: entries.map((entry) => transcriptEntry(entry, options.full === true, sources)),
            ...(view.head === undefined
                ? {}
                : { head: transcriptEntry(view.head, options.full === true, sources) }),
            accuracy: {
                context: "native-durable",
                tokens: "estimate",
                toolSources: "current-registry",
                request: "before-beforeRequest-hooks",
                imageBytes: "omitted",
            },
        };
    }

    /** Stored nested tool calls and any result still retained by the parent task. */
    async toolActivity(id: ConversationId): Promise<readonly ToolActivityRow[]> {
        await this.#app.inspection.flush();

        return this.#toolActivity.read(id);
    }

    /** A conversation's token and cost totals, from Pi Durable's pi.usage. */
    async usage(id: ConversationId): Promise<UsageState | undefined> {
        return this.#app.harness.snapshot(UsageDoc, id, context);
    }

    /** A session as a Markdown file: its whole history, with who wrote what. */
    async exportMarkdown(
        id: ConversationId,
        user: User,
    ): Promise<{ filename: string; markdown: string }> {
        this.#app.requireSee(user, id);
        const entries = await this.allEntries(id, true);
        const authors: Record<number, string> = {};

        for (const [entryId, userId] of Object.entries(
            (await this.#app.harness.snapshot(AuthorsDoc, id, context))?.entries ?? {},
        )) {
            authors[Number(entryId)] = this.#app.config.userById(userId)?.name ?? "Someone";
        }

        const agent = await this.#app.agentState(id);
        const title = await this.#app.conversationTitle(id);
        const markdown = transcriptMarkdown({
            title,
            cwd: homePath(this.#app.cwdOf(id)),
            ...(agent?.model === undefined
                ? {}
                : { model: `${agent.model.provider}/${agent.model.modelId}` }),
            exportedAt: new Date(),
            entries,
            authors,
        });
        const slug =
            title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || "session";

        return { filename: `${slug}.md`, markdown };
    }
}

/** Metadata keeps its structure, but image objects never expose their bytes. */
export function safeMetadata(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(safeMetadata);
    }

    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !(value.type === "image" && key === "data"))
                .map(([key, item]) => [key, safeMetadata(item)]),
        );
    }

    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON as the meter reads it: the same string, and never a throw. */
function json(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "undefined";
    } catch {
        return "[unserializable]";
    }
}

/** Text as a page carries it: whole with `full`, else its head and tail, still priced whole. */
function clip(text: string, full: boolean): { text: string; clipped?: number } {
    if (full || text.length <= TEXT_LIMIT) {
        return { text };
    }

    const half = Math.floor(TEXT_LIMIT / 2);

    return {
        text: `${text.slice(0, half)}\n\n… ${text.length - TEXT_LIMIT} characters not shown …\n\n${text.slice(-half)}`,
        clipped: text.length,
    };
}

function textPart(text: string, full: boolean): TranscriptPart {
    return { type: "text", tokens: estimateTextTokens(text), ...clip(text, full) };
}

function thinkingPart(text: string, redacted: boolean, full: boolean): TranscriptPart {
    return {
        type: "thinking",
        tokens: estimateTextTokens(text),
        ...(redacted ? { redacted } : {}),
        ...clip(text, full),
    };
}

function callPart(block: Record<string, unknown>): TranscriptPart {
    const name = String(block.name ?? "?");
    const args = block.arguments ?? {};

    return {
        type: "toolCall",
        id: String(block.id ?? ""),
        name,
        arguments: safeMetadata(args),
        tokens: estimateTextTokens(name + json(args)),
    };
}

function imagePart(block: Record<string, unknown>, imageIndex: number): TranscriptPart {
    return {
        type: "image",
        imageIndex,
        ...Object.fromEntries(
            ["width", "height", "byteSize"]
                .filter((key) => typeof block[key] === "number")
                .map((key) => [key, block[key]]),
        ),
        ...(typeof block.byteSize === "number" || typeof block.data !== "string"
            ? {}
            : { byteSize: Buffer.byteLength(block.data, "base64") }),
        ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
        tokens: IMAGE_TOKENS,
    };
}

/** The parts of a user message or a tool result: its text and images, without the image bytes. */
function contentParts(content: unknown, full: boolean): TranscriptPart[] {
    let imageIndex = 0;

    if (typeof content === "string") {
        return [textPart(content, full)];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content.flatMap((value) => {
        if (!isRecord(value)) {
            return [];
        }

        if (value.type === "text") {
            return [textPart(String(value.text ?? ""), full)];
        }

        return value.type === "image" ? [imagePart(value, imageIndex++)] : [];
    });
}

/** The parts of an answer: its replies, its thinking, and the calls it made. */
function answerParts(content: unknown, full: boolean): TranscriptPart[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content.flatMap((value) => {
        if (!isRecord(value)) {
            return [];
        }

        if (value.type === "text") {
            return [textPart(String(value.text ?? ""), full)];
        }

        if (value.type === "thinking") {
            return [thinkingPart(String(value.thinking ?? ""), value.redacted === true, full)];
        }

        return value.type === "toolCall" ? [callPart(value)] : [];
    });
}

/** A tool as a system message defines it, with the tokens its definition costs. */
function toolOf(value: unknown, sources: Record<string, string>): TranscriptTool {
    const tool = isRecord(value) ? value : {};
    const name = String(tool.name ?? "?");
    const source = sources[name];

    return {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.parameters === undefined ? {} : { parameters: safeMetadata(tool.parameters) }),
        tokens: estimateTextTokens(json(tool)),
        ...(source === undefined ? {} : { source, sourceProvenance: "current-registry" as const }),
    };
}

/** One stored message, priced by Pi's meter, with the image bytes left out. */
export function transcriptMessage(
    value: unknown,
    full: boolean,
    sources: Record<string, string>,
): TranscriptMessage {
    const message = isRecord(value) ? value : {};
    const role = message.role;
    const metadata =
        typeof message.timestamp === "number"
            ? { timestamp: message.timestamp, at: message.timestamp }
            : {};

    const tokens = () => {
        try {
            return estimateMessageTokens(value as Message);
        } catch {
            return 0;
        }
    };

    if (role === "system") {
        const sections = isRecord(message.sections) ? message.sections : undefined;
        const added = Array.isArray(message.toolsAdded) ? message.toolsAdded : [];
        const removed = Array.isArray(message.toolsRemoved) ? message.toolsRemoved : [];

        return {
            role: "system",
            ...metadata,
            content: systemText(message),
            tokens: tokens(),
            ...(sections === undefined
                ? {}
                : { sections: sections as Record<string, string | null> }),
            ...(added.length === 0 ? {} : { tools: added.map((tool) => toolOf(tool, sources)) }),
            ...(removed.length === 0
                ? {}
                : {
                      toolsRemoved: removed.map((tool) =>
                          String(isRecord(tool) ? (tool.name ?? "?") : "?"),
                      ),
                  }),
        };
    }

    if (role === "user") {
        return {
            role: "user",
            ...metadata,
            ...(message.source === undefined ? {} : { source: safeMetadata(message.source) }),
            parts: contentParts(message.content, full),
            tokens: tokens(),
        };
    }

    if (role === "toolResult") {
        return {
            role: "toolResult",
            ...metadata,
            ...(message.details === undefined ? {} : { details: safeMetadata(message.details) }),
            ...(message.nestedCalls === undefined
                ? {}
                : { nestedCalls: safeMetadata(message.nestedCalls) }),
            ...(isRecord(message.usage) ? { usage: message.usage as unknown as Usage } : {}),
            ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
            callId: String(message.toolCallId ?? ""),
            name: String(message.toolName ?? "?"),
            parts: contentParts(message.content, full),
            tokens: tokens(),
            isError: message.isError === true,
        };
    }

    return {
        role: "assistant",
        ...metadata,
        ...(isRecord(message.pocketTiming)
            ? {
                  pocketTiming: message.pocketTiming as {
                      startedAt: number;
                      endedAt: number;
                      firstTokenAt?: number;
                  },
              }
            : {}),
        parts: answerParts(message.content, full),
        tokens: tokens(),
        ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
        ...(typeof message.model === "string" ? { model: message.model } : {}),
        ...(isRecord(message.usage) ? { usage: message.usage as unknown as Usage } : {}),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
        ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
    };
}

function systemText(message: Record<string, unknown>): string {
    try {
        return contentText((message.content ?? "") as Parameters<typeof contentText>[0]);
    } catch {
        return typeof message.content === "string" ? message.content : "";
    }
}

function transcriptEntry(
    entry: EntryRecord,
    full: boolean,
    sources: Record<string, string>,
): TranscriptEntry {
    const messages = (entry.model ?? []).map((message) =>
        transcriptMessage(message, full, sources),
    );
    const first = entry.model?.[0] as { timestamp?: unknown } | undefined;
    const at = typeof first?.timestamp === "number" ? first.timestamp : undefined;

    return {
        id: Number(entry.id),
        conversationId: Number(entry.conversationId),
        kind: entry.kind,
        ...(at === undefined ? {} : { at }),
        ...(entry.head === undefined ? {} : { head: Number(entry.head) }),
        ...(entry.data === undefined ? {} : { data: safeMetadata(entry.data) }),
        ...(entry.edits === undefined || entry.edits.length === 0
            ? {}
            : { edits: entry.edits.map((edit) => transcriptEdit(edit, full, sources)) }),
        ...(messages.length === 0 ? {} : { messages }),
    };
}

/** An entry's change to an earlier entry's contribution, with the messages it puts in place of them. */
function transcriptEdit(
    edit: ContextEdit,
    full: boolean,
    sources: Record<string, string>,
): TranscriptEdit {
    if (edit.action === "omit") {
        return { target: Number(edit.target), action: "omit" };
    }

    return {
        target: Number(edit.target),
        action: "replace",
        messages: edit.messages.map((message) => transcriptMessage(message, full, sources)),
    };
}
