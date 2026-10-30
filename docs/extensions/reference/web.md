# web

`web` is the second argument of a module's default export. With it, a module adds to the app what a tool cannot: routes on the server, a browser module, and commands for the message box. [Adding to the app](../app.md) tells you how the parts work together.

Register routes, the browser module, and commands while the module loads. After that, these calls throw. What you register goes when this version of the module goes: an edit replaces it, or the owner turns the module off.

The types are `Web` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts).

## About the module

### `api`

```ts
readonly api: number;
```

Since 0.14.0 · Stable

The version of the extension API. [API versions](api-versions.md) tells you when it changes.

### `module`

```ts
readonly module: string;
```

Since 0.14.0 · Stable

The module's name: the name of its file without `.ts`. The routes of `server-status.ts` are under `/api/x/server-status/`.

## Registering

### `route`

```ts
route(method: WebMethod, path: string, handle: WebHandler, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Adds a route at `/api/x/<module>/<path>`. `handle` answers its requests.

- `method` is a [`WebMethod`](#webmethod).
- `path` is relative to the module's routes: `"status"`, or `"items/:id"`. A part written `:name` matches any one part of the address. [Names](names.md#routes) gives the characters that a part can have.
- When paths overlap, the most specific path answers, whatever the order of registration. From the left, a fixed part comes before a `:name` part: `items/new` comes before `items/:id`.
- `access` says who can use the route. The default is `"owner"`. See [`WebAccess`](#webaccess).
- A method and a path of the same shape can have only one route.

[Routes](../routes.md) tells you about the checks that come before a handler, errors, and what to check in a handler.

### `conversationRoute`

```ts
conversationRoute(
    method: WebMethod,
    path: string,
    handle: (request: ConversationWebRequest) => unknown,
    options: { conversation: string; access?: WebAccess },
): void;
```

Since 0.16.0 · Stable

Register a route with an authorized conversation binding. `conversation` names a required path parameter, without `:`: for `"runs/:source"`, use `{ conversation: "source" }`. Registration refuses a name not in the path. All ordinary route access and header checks still apply; people invited to one session cannot use it. Before the handler runs, GET requires seeing the actual source; other methods also require steering and the turn. Missing, invalid, private PiP, or inaccessible sources never reach the handler. Check `typeof web.conversationRoute === "function"` on older servers.

### `client`

```ts
client(entry: string, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Sets the module's browser module. A module has one browser module at most.

- `entry` is the name of a file or folder immediately beside the module. It must not be a link. [Names](names.md#browser-modules) gives the characters that it can have.
- A `.js` or `.mjs` file is served alone.
- A folder must have an `index.js`, which loads first and can import the other files of the folder.
- `access` says whose tabs load it. The default is `"owner"`. See [`WebAccess`](#webaccess).

[Browser modules](../browser-modules.md) tells you which files a folder serves, and when tabs load a new version.

### `command`

```ts
command(name: string, command: Command): void;
```

Since 0.14.0 · Stable

Adds the command `/name` to the message box, for the people who can run it. The command runs on the server, and it does not ask Pi.

- [Names](names.md#commands) gives the rules for `name`.
- [Command context](command-context.md) gives the fields of `command` and what its handler gets and returns.
- [Slash commands](../commands.md) tells you who can run a command, how a run is kept, and how a person stops it.

### `publicPage`

```ts
publicPage(handle: PublicPageHandler): void;
```

Since 0.22.0 · Experimental

Draws the module's public pages: what anyone with one of its links sees at `/l/<token>`, with no sign-in. A module has one handler. Pi Pocket sends each page in a sandbox: no script, an opaque origin, and forms that post only to this server. See [`PublicPageHandler`](#publicpagehandler) and [Public pages](../public-pages.md).

### `links`

```ts
readonly links: PublicLinks;
```

Since 0.22.0 · Experimental

Makes, lists, and ends the module's public links. Unlike the registering calls, it works while the module runs: from a route, a tool, a timer, or the page handler. A version of the module that went makes, lists, and ends none. See [`PublicLinks`](#publiclinks).

### `provide`

```ts
provide(service: object): void;
```

Since 0.22.0 · Experimental

Offers other modules an object of this module's own: functions and values that they call with `web.use(module)`. A module provides one service, while it loads. When this version of the module goes (an edit, or the owner turns it off), its service goes too, and modules that listen with `onService` hear it. A service is what it says it is: it runs with the providing module's code, so check what other modules give it, as you check what a person gives a route. See [Extensions that work together](../services-settings.md#services).

### `use`

```ts
use(module: string): unknown;
```

Since 0.22.0 · Experimental

The service that a module offers now, by the module's name, or `undefined` while that module is off, still loading, or offers none. Ask again each time that you need it, and do not keep it: a reload replaces it. Check its shape before you call it, since another version of the module may offer another one.

### `onService`

```ts
onService(module: string, listener: () => void): () => void;
```

Since 0.22.0 · Experimental

Calls `listener` when a module's service comes, changes (the module loads again), or goes. It does not call for a service that is there when you start to listen: check `use` then too. Use it to show or hide what you add to the app that needs that service. It returns how to stop. It stops by itself when this version of your module goes.

### `settings`

```ts
settings(fields: readonly SettingField[]): void;
```

Since 0.22.0 · Experimental

Declares the module's settings, while it loads. Core keeps the owner's values in `config.json`, shows them in Menu → Extensions under the module, and checks each value against its field before it keeps it. A mistake in `fields` throws, so the module does not load and the Extensions sheet says why. See [`SettingField`](#settingfield) and [Extensions that work together](../services-settings.md#settings).

### `setting`

```ts
setting(name: string): SettingValue | undefined;
```

Since 0.22.0 · Experimental

A setting's value now: the owner's, or the field's default, or `undefined` when it has neither. A value that no longer fits the field, from an older version of the module, gives the default. A name the module did not declare throws. Read it when you need it: the owner can change it at any time.

### `onSettings`

```ts
onSettings(listener: () => void): () => void;
```

Since 0.22.0 · Experimental

Calls `listener` after the owner changes the module's settings. The module's tabs hear it too, with `pocket.onSettings`. It returns how to stop, and stops by itself when this version of the module goes.

## Sending and answering

### `send`

```ts
send(event: string, data?: unknown, options?: { to?: string }): void;
```

Since 0.14.0 · Stable

Sends an event to the browser module. There, `pocket.on(event, run)` gets it.

- `data` is a value that JSON can hold.
- Without `to`, the event goes to the tabs of all the people that the browser module's `access` lets in. With `to`, it goes only to the tabs of the person with that id.
- Send events only after the module has loaded, and only from a module that has a browser module. Other events go nowhere.
- `send` never throws, because modules call it mostly from timers. When it cannot send an event, it writes the reason to the server's log, one time for each kind of mistake in a version.

[Events](../events.md) tells you about the limits, and about tabs that fall behind.

### `error`

```ts
error(status: number, message: string): Error;
```

Since 0.14.0 · Stable

Makes an error for a route or a command handler to throw: `throw web.error(404, "No such item")`. The person who asked gets `status` and `message` as they are. `status` is from 400 to 599.

Do not put text in `message` that this person must not see. Any other error that a handler throws gives a status of 500, and only the owner sees its words.

### `onDispose`

```ts
onDispose(dispose: () => unknown): void;
```

Since 0.14.0 · Stable

Runs `dispose` when this version of the module goes: an edit replaces it, the owner turns it off, or the server stops. Stop timers and close connections there. `dispose` can return a promise. [Cleanups](../cleanups.md) tells you how long a stopping server waits for it.

## Requests

### `WebHandler`

```ts
type WebHandler = (request: WebRequest) => unknown;
```

Since 0.14.0 · Stable

Answers the requests of a route. The value that it returns goes back as JSON, and `undefined` goes back as `{}`. It can be async.

### `WebRequest`

```ts
interface WebRequest {
    readonly method: WebMethod;
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    readonly body: Readonly<Record<string, unknown>>;
    readonly user: Person;
    readonly signal: AbortSignal;
    readonly snapshot: DocumentReader["snapshot"];
    readonly context: Context;
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
    sessions(): readonly WebSession[];
    modelContextOf(
        conversation: number,
        options?: ModelContextOptions,
    ): Promise<ModelContextSnapshot>;
    subagentsOf(conversation: number): readonly WebSubagent[];
    relationships(): readonly WebRelationship[];
    toolActivityOf(conversation: number): Promise<readonly ToolActivityRow[]>;
    usageHistoryOf(conversation: number): Promise<UsageHistory>;
    requestHistoryOf(conversation: number): Promise<readonly ModelRequestCapture[]>;
}
```

Since 0.14.0 · Stable

What a handler gets.

- `method`: the request's method.
- `params`: the values of the path's `:name` parts, by name. They are text from outside: check a value before you make a file path from it.
- `query`: the query string. `pocket.api("usage?days=7")` sends `days`.
- `body`: the JSON object that the browser sent. It is empty for GET and DELETE.
- `user`: the person who asked, as `{ id, name, role }`.
- `signal`: it aborts when the browser stops waiting for the answer, not on normal handler return. Give it to the work that the handler waits for.
- Since 0.16.0, `snapshot` reads fresh committed documents with `context`. Its `context.abortSignal` is cancelled on disconnect or handler return, independently of the older `signal`. `commit` changes the module's own documents atomically and returns the callback's answer. Follow the `x.<module>.…` naming rule. Viewers cannot commit, even through a GET open to `view`.
- Document operations recheck the current person. Retaining a request, its context, or a callback does not extend its lifetime: commits after disconnect or handler return are refused, and an unfinished callback rolls back. Await all writes before returning. These APIs are for module documents, not core's internal documents or a way to start model work.
- An unbound catalog save has no source plan, turn, or spend checks. A bound commit also requires the source's current steering and turn rights.
- Since 0.20.0 (experimental), `sessions()` gives the sessions that the person who asked can see now, as their session list shows them, archived ones too. See [`WebSession`](#websession). Use it to check the ids that a browser sends, and to keep data about sessions from people who cannot see them. Each call reads the list again.
- Since 0.26.0 (experimental), `transcriptOf(conversation, options)` and `usageOf(conversation)` read any conversation the person who asked may see: a session, or a subagent of one. They are the same reads as a [`ConversationWebRequest`](#conversationwebrequest) gives for its own conversation, and answer 404 for a conversation the person may not see, 400 for an id that is not a positive whole number. Use them with [`transcript`](#transcriptoptions) and [`usage`](#conversationwebrequest), for example to show a subagent's own work.
- Since 0.26.0 (experimental), `imageOf(conversation, entry, index)` gives one image of a stored message, as `{ mimeType, data }` with `data` in base64, or undefined when the entry has no such image. The person must see the conversation, as for `transcriptOf`.
- Since 0.26.0 (experimental), `toolActivityOf(conversation)` reads stored nested tool calls for a visible conversation. It checks visibility before and after the asynchronous Durable read. A bound route uses `toolActivity()` for its source conversation.

### `WebSession`

```ts
interface WebSession {
    readonly id: number;
    readonly title: string;
    readonly cwd: string;
    readonly archived: boolean;
    readonly updatedAt: number;
}
```

Since 0.20.0 · Experimental

A session in a person's session list: its id, a number as in its address (`/s/12`), its title, its folder, whether it is archived, and when it last moved up the list, in milliseconds since 1970. It has no subagents, and no PiP's conversation.

### `ConversationWebRequest`

```ts
interface ConversationWebRequest extends WebRequest {
    readonly conversation: {
        readonly id: ConversationId;
        readonly title: string;
        readonly cwd: string;
        readonly model?: ModelRef;
        readonly thinkingLevel: ModelThinkingLevel;
    };
    readonly linkedSessions: HumanLinkedSessions;
    toolActivity(): Promise<readonly ToolActivityRow[]>;
    modelContext(options?: ModelContextOptions): Promise<ModelContextSnapshot>;
    transcript(options?: TranscriptOptions): Promise<TranscriptPage>;
    usage(): Promise<UsageState | undefined>;
    subagents(): readonly WebSubagent[];
}
```

Since 0.16.0 · Stable

Authoritative source metadata, plus request-lifetime human linked-session capabilities. An omitted `model` means the source has none. Metadata is a snapshot, not a promise that settings cannot change. A start rejects a source model, thinking level, or folder changed while it waits.

Since 0.26.0, experimental, it also reads this conversation's stored transcript and its usage totals. Both read only the bound conversation, which the server already checked that the person may see.

- `transcript(options)`: a page of the conversation's stored entries, oldest first: its own and those it inherited from a fork, with the ones a compaction removed. Each message and each part carries `tokens`, the figure Pi's own meter counts for it, so a dashboard matches the context ring. Image bytes are left out; an image keeps only its type and the tokens the meter counts for it. `full: false` (the default) clips long text for reading, and `tokens` still counts all of it. Read pages with `after` until `more` is false. A page holds 100 entries by default and 200 at most.
- `toolActivity()`: stored nested tool calls for this conversation. Each row has the immediate parent call ID and the root model call ID when task ancestry retains it, exact nested call arguments, lifecycle status, task timestamps, and a duration. `result` is present when the live parent task or enabled inspection capture retains its `NestedCallDoc` result; `result.structuredOutput` remains structured data and is never treated as complete text. `outputRecorded` says that a structured output value exists, while `resultAvailable` says that a result object exists. Image bytes are omitted from metadata, and hidden values keep their existing redaction.
- `usage()`: the conversation's `pi.usage` totals, by `provider/model` and by tool, with cost. Undefined before the first response.
- `modelContext(options)`: native Durable context at the current tail or at a visible entry. See [`ModelContextSnapshot`](#modelcontextsnapshot).
- `subagents()`: every direct subagent this session started, including all finished agents. This read has no board cap. Each has its own conversation, which a person can open. Empty when it started none. See [`WebSubagent`](#websubagent).

### `ToolActivityRow`

```ts
interface ToolActivityRow {
    readonly taskId: number;
    readonly parentTaskId: number;
    readonly callId: string;
    readonly parentCallId: string;
    readonly rootCallId?: string;
    readonly toolName: string;
    readonly arguments: unknown;
    readonly status: ToolActivityStatus;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly durationMs?: number;
    readonly result?: ToolActivityResult;
    readonly outputRecorded: boolean;
    readonly resultAvailable: boolean;
}
```

Since 0.26.0 · Experimental

One nested call retained in the target conversation's Durable task records. `status` is `pending`, `running`, `completed`, `failed`, `aborted`, `orphaned`, or `faulted`. `rootCallId` is found by following public task ancestry to the model-issued call; the implementation never splits call IDs. A missing result is expected for old calls because `NestedCallDoc` retires with its parent task. While Context Insight is enabled, core retains available result metadata before retirement. Pocket codemode uses separate direct-call metadata rather than Durable nested tasks; it records arguments, timing, result metadata, and bounded text with explicit omitted-character counts while the extension is selected.

`arguments` is the exact nested task input after the normal metadata projection. `result` contains only stored structured result fields: `isError`, `structuredOutput`, `details`, `diagnostics`, `usage`, and `durationMs`. `structuredOutput` is not a complete text output. `outputRecorded` is true only when that field exists. `resultAvailable` is true when the result object exists. Image bytes are omitted from metadata.

### `ToolActivityStatus`

```ts
type ToolActivityStatus =
    "pending" | "running" | "completed" | "failed" | "aborted" | "orphaned" | "faulted";
```

Since 0.26.0 · Experimental

The durable task lifecycle and terminal outcome. A completed task can still have `result.isError: true` when the tool returned an error result.

### `ToolActivityResult`

```ts
interface ToolActivityResult {
    readonly isError: boolean;
    readonly structuredOutput?: unknown;
    readonly details?: unknown;
    readonly diagnostics?: readonly unknown[];
    readonly usage?: Usage;
    readonly durationMs?: number;
}
```

Since 0.26.0 · Experimental

The retained nested result. It can be absent when neither the live task nor inspection capture retains it, including for historic nested calls.

- `usage` is the tool execution usage stored by Durable. It is metadata for this call and does not add a second bill to usage history.
- `details` and `diagnostics` are safe metadata. Image data is omitted.

### `WebSubagent`

```ts
interface WebSubagent {
    readonly name: string;
    readonly conversationId: number;
    readonly busy: boolean;
    readonly waiting?: true;
    readonly failed?: true;
    readonly stopped?: true;
    readonly asked?: string;
    readonly askedAt?: number;
    readonly answeredAt?: number;
    readonly error?: string;
    readonly reporting?: true;
}
```

Since 0.26.0 · Experimental

One subagent of a session: its name, its own conversation (open it with the app's normal navigation), whether it is busy or waits for an approval or a provider's limit, whether it failed or was stopped, the message it was given and when, when it answered, why it failed, and whether its answer is on its way to the session.

### `ModelContextOptions`

```ts
interface ModelContextOptions {
    at?: number;
    full?: boolean;
}
```

Since 0.26.0 · Experimental

- `at`: a positive visible entry id. Omission reads the current tail. An invisible entry answers 404, including a parent entry after a fork point.
- `full`: true keeps all text. The default clips long text as transcript pages do. Token estimates still count the complete messages.

### `ModelContextSnapshot`

```ts
interface ModelContextSnapshot {
    readonly messages: readonly TranscriptMessage[];
    readonly messageOrigins: readonly ModelMessageOrigin[];
    readonly entries: readonly TranscriptEntry[];
    readonly head?: TranscriptEntry;
    readonly accuracy: {
        readonly context: "native-durable";
        readonly tokens: "estimate";
        readonly toolSources: "current-registry";
        readonly request: "before-beforeRequest-hooks";
        readonly imageBytes: "omitted";
    };
}
```

Since 0.26.0 · Experimental

- `messages`: the projected output of native `Conversation.context()`. Durable applies context edits, excludes failed/aborted/deferred answers, moves tool results into call order, and synthesizes missing results.
- `messageOrigins`: one origin for each normalized message, in the same order.
- `entries`: native active entries, including the selected head marker. Their messages are stored contributions, before edits and normalization.
- `head`: the selected native head marker when present.
- `accuracy`: native committed context before `beforeRequest` hooks and provider adaptation. Tokens are estimates. Tool attribution uses the current registry. Image bytes are absent.

Any route can call `modelContextOf(conversation, options)`. A bound route can call `modelContext(options)`. Both check current visibility before and after asynchronous reads. Capabilities expire when their request ends.

### `ModelMessageOrigin`

```ts
type ModelMessageOrigin =
    | { entryId: number; messageIndex: number; editIndex?: number; targetEntryId?: number }
    | { synthetic: true };
```

Since 0.26.0 · Experimental

- `entryId`: the source entry containing the exact stored message.
- `messageIndex`: the index in `entry.messages`, or the replacement messages when `editIndex` is present.
- `editIndex` and `targetEntryId`: the source entry's replacement edit and the entry whose contribution it replaces.
- `synthetic`: true for a missing result Durable made. It has no stored image locator.

The source of a winning edit can be an older head marker that native active entries omit. Read that entry from the transcript when needed. To retrieve an image, call `imageOf(conversation, origin.entryId, part.imageIndex, {messageIndex: origin.messageIndex, editIndex: origin.editIndex})`. The optional fourth argument defaults to the first original message for existing callers.

### `WebRelationship`

```ts
interface WebRelationship {
    readonly conversationId: number;
    readonly sessionId: number;
    readonly parentId?: number;
    readonly linkedFrom?: number;
    readonly forkedFrom?: { readonly id: number; readonly entryId?: number };
}
```

Since 0.26.0 · Experimental

`relationships()` returns every known conversation under the person's visible sessions, including archived sessions and all subagents. It checks visibility on each call. Hidden origins are omitted. `parentId` identifies a direct subagent parent; `sessionId` identifies its root session. Links and forks confer no access. `subagentsOf(conversation)` reads every direct subagent of any visible conversation, without the board's 24-finished cap.

### `UsageHistory`

```ts
interface UsageHistory {
    readonly totals?: UsageState;
    readonly events: readonly UsageHistoryEvent[];
    readonly known: UsageState;
    readonly undated: UsageState;
    readonly accuracy: {
        readonly historical: "stored-entry-usage";
        readonly remainder: "undated";
        readonly capture: "enabled-only-best-effort";
    };
}
```

Since 0.26.0 · Experimental

`usageHistoryOf(conversation)` returns the conversation's own authoritative `pi.usage` totals, known entry and captured usage events, their sum, and the explicit remainder. Inherited fork entries contribute no own bills. Captured commit events replace the entry bills in the same commit to prevent double counting.

`pi.usage` retains only its latest value. Old compaction, warm, or missing bills cannot be assigned exact dates. They stay in `undated`. The counters in `known + undated` equal `totals`. An inconsistent imported history can produce a signed remainder; a negative remainder is a reconciliation discrepancy, never a dated credit.

While Context Insight is enabled, core observes usage commits and persists their timestamped deltas. This includes model failures, compaction, tool usage, and cache warms that change `pi.usage`. Persistence occurs after the source commit and can miss the last update on an abrupt process exit. Such a missing bill stays in the remainder. No event is reconstructed from a current total and assigned an old day.

### `UsageHistoryEvent`

```ts
interface UsageHistoryEvent {
    readonly at?: number;
    readonly entryId?: number;
    readonly bucket: "models" | "tools";
    readonly key: string;
    readonly usage: Usage;
    readonly source: "entry" | "usage-commit";
}
```

Since 0.26.0 · Experimental

- `at`: the stored message timestamp, or the time core observed the usage commit. It is absent when the source has no timestamp.
- `entryId`: the stored bill's entry when available. Compaction and warm usage need not have entries.
- `bucket` and `key`: the authoritative usage bucket and its provider/model or tool key.
- `usage`: stored bill counters and costs.
- `source`: stored entry usage or a captured usage delta. A captured delta dates the commit, not the provider's billing clock.

### `ModelRequestCapture`

```ts
interface ModelRequestCapture {
    readonly id: string;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly provider: string;
    readonly model: string;
    readonly messages: readonly TranscriptMessage[];
    readonly response?: TranscriptMessage;
    readonly outcome: "pending" | "done" | "error";
    readonly accuracy: "normalized-after-hooks";
}
```

Since 0.26.0 · Experimental

`requestHistoryOf(conversation)` returns persisted normalized request captures. Core captures only while Context Insight is enabled. It captures stream attempts below the retry gate and cache keeper, including compaction and warm requests. These are normalized messages after request hooks, before provider adaptation and payload shapers. They are not provider-wire JSON.

A pending record is queued independently of the model request. Neither the initial diagnostic write nor its terminal update blocks provider startup, response delivery, or tool execution. Capture failures are diagnostic only. The terminal record includes the provider-reported response usage and measured timing. Request credentials, options, and headers are never captured. Image bytes are omitted. Explicitly hidden values are replaced. A disabled module stores no new records. Records already stored remain readable through authorized core APIs. Capture writes do not add model-visible entries.

A request interrupted before its terminal capture remains pending. Captured provider usage is evidence of the response, while `usageHistoryOf` reconciles actual committed billing. Neither claims that pending work cost zero.

### `TranscriptOptions`

```ts
interface TranscriptOptions {
    after?: number;
    limit?: number;
    full?: boolean;
}
```

Since 0.26.0 · Experimental

- `after`: entries newer than this id, oldest first. Absent or 0 starts at the beginning.
- `limit`: how many entries, from 1 to 200. 100 by default. Other values throw, and the route answers 400.
- `full`: true for the text as it was stored. False or absent clips a long text for reading, and `tokens` still counts the whole of it.

### `TranscriptPage`

```ts
interface TranscriptPage {
    readonly entries: readonly TranscriptEntry[];
    readonly last: number;
    readonly more: boolean;
}
```

Since 0.26.0 · Experimental

- `entries`: the page's entries, oldest first.
- `last`: the newest entry's id, or `after` when the page was empty. Give it as the next page's `after`.
- `more`: true when more entries follow.

### `TranscriptEntry`

```ts
interface TranscriptEntry {
    readonly id: number;
    readonly conversationId?: number;
    readonly kind: string;
    readonly at?: number;
    readonly head?: number;
    readonly data?: unknown;
    readonly edits?: readonly TranscriptEdit[];
    readonly messages?: readonly TranscriptMessage[];
}
```

Since 0.26.0 · Experimental

One stored entry: its id, its kind (`pi.user`, `pi.assistant`, `pi.compaction`, or a kind of Pi Pocket's own), when its first message was made, the first entry of the active context that it selects (`head`; a compaction's head, or a reset's own id), its own payload (`data`, such as a compaction's `reason`), the edits it makes to earlier entries, and the messages it adds to the model's context. `data` and the kinds' fields can change in any release.

### `TranscriptEdit`

```ts
type TranscriptEdit =
    | { target: number; action: "omit" }
    | { target: number; action: "replace"; messages: readonly TranscriptMessage[] };
```

Since 0.26.0 · Experimental

A change to what the entry `target` gives the model: leave it out, or give these messages instead. Pi Pocket's own sessions make none; a session continued from Pi's may have its context edits.

### `TranscriptMessage`

```ts
type TranscriptMessage =
    | { role: "system"; content: string; tokens: number; sections?: …; tools?: …; toolsRemoved?: … }
    | { role: "user"; parts: readonly TranscriptPart[]; tokens: number }
    | { role: "assistant"; parts: readonly TranscriptPart[]; tokens: number; … }
    | { role: "toolResult"; callId: string; name: string; parts: readonly TranscriptPart[]; tokens: number; isError: boolean };
```

Since 0.26.0 · Experimental

A message as the transcript stores it, with the image bytes left out. All roles retain stored `timestamp` and its `at` alias. Users retain `source`; assistants retain `pocketTiming`; tool results retain `details`, `nestedCalls`, `usage`, and `durationMs`. Missing metadata remains absent. `tokens` is Pi's meter's figure for the whole message, which is what the context ring counts. A system message carries the sections it set (`null` removes one), the tools it added, and the names of the tools it removed. An assistant message carries its provider, model, `usage`, `stopReason`, `error`, and `durationMs`.

### `TranscriptPart`

```ts
type TranscriptPart =
    | { type: "text"; text: string; tokens: number; clipped?: number }
    | { type: "thinking"; text: string; tokens: number; redacted?: boolean; clipped?: number }
    | { type: "toolCall"; id: string; name: string; arguments: unknown; tokens: number }
    | { type: "image"; mimeType?: string; tokens: number };
```

Since 0.26.0 · Experimental

A part of a message with its own price in tokens. `clipped` is the text's whole length when `full` was not asked for. Images include their zero-based `imageIndex` within the source message. They retain stored `width`, `height`, and `byteSize` when present. Base64 data can supply the byte size when it was not stored separately. Image bytes never appear in a transcript or model context response.

### `TranscriptTool`

```ts
interface TranscriptTool {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
    readonly tokens: number;
    readonly source?: string;
}
```

Since 0.26.0 · Experimental

A tool as a system message defines it, with the tokens its definition costs in the request. `sourceProvenance: "current-registry"` labels attribution explicitly. `source` is the extension that registered a tool of that name, as the registry knows it now; it is left out for a tool the registry does not list.

### `HumanLinkedSessions`

```ts
interface HumanLinkedSessions {
    start(
        request: {
            title?: string;
            message: string;
            model?: string;
            thinking?: ModelThinkingLevel;
            cwd?: string;
        },
        key: string,
    ): Promise<{ session: ConversationId; address: string }>;
    list(): Promise<HumanLinkedSession[]>;
}
```

Since 0.16.0 · Stable

`cwd` is since 0.19.0. It names an existing folder for the new session, as in [`host.linkedSessions.start`](host.md#linkedsessions). A blank `cwd` counts as no `cwd`. A relative `cwd` resolves against the folder of the server process, not the folder of the source. An older Pi Pocket ignores it.

- `start` acts as the authenticated person and bound source, never the source's last requester. There is no actor override. Current seeing, steering, turn, plan, spend, team, model allow-list, and provider checks apply. The person must see all sessions to start one.
- Explicit `thinking` must be a level that the model has; it is never silently lowered. Omission inherits the level of the source, lowered to one that the model has. Use `host.modelInfo` for effective choices.
- Use a stable, module-namespaced key. A receipt belongs to the same clicking person; a key recorded for someone else is a 409. Starts and their initial message reuse the existing linked-session receipt and request ids. No source message or source attribution is changed.
- `list` returns only linked sessions the clicking person can see. GET needs seeing, not driving. It exposes ids for human navigation, not for a model transcript. Other metadata keeps the shared-audience rule.
- Both methods end with the request. A start waits for admission of its initial message, not a model answer. The final authorization boundary is the start of Durable's submission admission on its mutation line. Intervening source/target policy changes invalidate the short admission lease; config, access, model allowance, and spend are checked again there. Once admitted, later cancellation or policy changes do not undo work.

### `HumanLinkedSession`

```ts
interface HumanLinkedSession extends LinkedSession {
    conversationId: ConversationId;
}
```

Since 0.16.0 · Stable

`conversationId` is visible to the authenticated person and can be passed to `pocket.openConversation`. `address` remains the source's opaque address. `title`, `cwd`, `busy`, and `archived` still show only when the source's whole audience sees this session.

### `SettingField`

```ts
type SettingField =
    | { name: string; label: string; description?: string; type: "boolean"; default?: boolean }
    | {
          name: string;
          label: string;
          description?: string;
          type: "text";
          default?: string;
          placeholder?: string;
          secret?: boolean;
      }
    | {
          name: string;
          label: string;
          description?: string;
          type: "number";
          default?: number;
          min?: number;
          max?: number;
      }
    | {
          name: string;
          label: string;
          description?: string;
          type: "choice";
          default?: string;
          choices: { value: string; label: string }[];
      };
```

Since 0.22.0 · Experimental

One setting.

- `name`: its key: letters, digits, and `_`, up to 40, starting with a letter. Each setting's is its own.
- `label`: what the Extensions sheet calls it, one line of up to 80 characters. `description`: a line of up to 300 under it.
- `type`: `boolean` (a switch), `text` (up to 4096 characters), `number` (with `min` and `max`; `min` is not more than `max`, and a `default` is between them), or `choice` (one of `choices`, up to 50).
- `secret` (text only; on another type it throws): the value never leaves the server, nor does its `default`. The sheet shows only that it is set, and `pocket.settings` leaves both out. Use it for a key or a token.
- `default`: the value until the owner sets one, and again after **Default** or **Clear**.

A module declares 30 settings at most.

### `SettingValue`

```ts
type SettingValue = string | number | boolean;
```

Since 0.22.0 · Experimental

A setting's value: `true` or `false`, text, a number, or a choice's `value`.

### `PublicPageHandler`

```ts
type PublicPageHandler = (
    request: PublicPageRequest,
) => PublicPageAnswer | Promise<PublicPageAnswer>;
```

Since 0.22.0 · Experimental

Draws a public page. A `POST` to a link with `uses` counts one before the handler runs. A handler that throws, or answers with a status of 400 or more, gives it back.

### `PublicPageAnswer`

```ts
type PublicPageAnswer = string | { html: string; status?: number };
```

Since 0.22.0 · Experimental

The page's HTML, or its HTML with a status from 200 to 599 (200 when not given), up to a [size](limits.md#public-links). An error made with `web.error` shows a short page with its message and status. Any other error shows a page that gives no reason, and the server's log has its words.

### `PublicPageRequest`

```ts
interface PublicPageRequest {
    readonly method: "GET" | "POST";
    readonly link: PublicLinkInfo;
    readonly query: URLSearchParams;
    readonly form: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly context: Context;
    readonly snapshot: DocumentReader["snapshot"];
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}
```

Since 0.22.0 · Experimental

A request to a public page, from anyone with its address. It has no person.

- `method`: `"GET"` to show the page (`HEAD` comes as `"GET"`), `"POST"` for a form on it.
- `link`: the link that the address names. It is still open.
- `query`: the query string.
- `form`: the fields of a posted form, `application/x-www-form-urlencoded`, as text. The last of a name that comes twice counts. Empty for `GET`.
- `signal`: aborted when the browser stops waiting.
- `snapshot`, `context`, and `commit`: read and change the module's own documents. They end when the handler returns.

### `PublicLinks`

```ts
interface PublicLinks {
    create(link: PublicLinkRequest): Promise<PublicLinkInfo>;
    get(token: string): Promise<PublicLinkInfo | undefined>;
    list(): Promise<PublicLinkInfo[]>;
    end(token: string): Promise<boolean>;
}
```

Since 0.22.0 · Experimental

The module's public links. Each method sees only the links of its own module.

- `create`: makes a link. A request out of its [limits](limits.md#public-links) throws.
- `get`: one of the module's open links, or `undefined`.
- `list`: the module's open links, newest first.
- `end`: ends a link at once, and gives whether there was one to end.

### `PublicLinkRequest`

```ts
interface PublicLinkRequest {
    hours: number;
    uses?: number;
    by?: string;
    conversation?: number;
    data?: unknown;
}
```

Since 0.22.0 · Experimental

What a module asks for when it makes a link.

- `hours`: how long it stays open: more than 0, and 720 (30 days) at most.
- `uses`: how many answered posts it takes before it closes. Without it, any number until its time.
- `by`: who it is for, such as a route's `user.id`.
- `conversation`: the session that it is about.
- `data`: a small JSON value of the module's own, given back with the link.

### `PublicLinkInfo`

```ts
interface PublicLinkInfo {
    readonly token: string;
    readonly path: string;
    readonly url: string | null;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly uses: number | null;
    readonly by: string | null;
    readonly conversation: number | null;
    readonly data: unknown;
}
```

Since 0.22.0 · Experimental

A link, as its module sees it.

- `token`: 32 hex characters, the whole of its access.
- `path`: `/l/<token>`.
- `url`: the whole address on the server's public one (a tunnel's), or `null`. In the browser, use `location.origin` and `path` when it is `null`.
- `createdAt`, `expiresAt`: when it was made and when it closes, in milliseconds since 1970.
- `uses`: how many answers it takes still, or `null` for any number.
- `by`, `conversation`, `data`: as the module gave them, or `null`.

### `WebMethod`

```ts
type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
```

Since 0.14.0 · Stable

The methods that a route can have.

## Access

### `WebAccess`

```ts
type WebAccess = "owner" | "steer" | "view";
```

Since 0.14.0 · Stable

Who can use a route, or whose tabs load a browser module.

- `"owner"`, the default: the owner alone.
- `"steer"`: the owner, and guests who can steer all sessions.
- `"view"`: the owner, guests, and viewers who can see all sessions.

A person invited to one session never can, because these parts belong to the whole app. Each route has its own `access`, so a browser module for everyone can call a route for the owner alone.

`access` is the same for all methods. A POST route with `"view"` lets viewers change something through it, though they cannot steer a session. Give `"owner"` or `"steer"` to a route that changes things.

To a person that its `access` does not let in, a route is not there. The person gets the same 404 as for a path that the module does not have. Thus another route whose path matches can answer the person. Give the same `access` to routes whose paths overlap, or check `user.role` in the handler.
