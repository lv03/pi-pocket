# Context Insight

Context Insight is an optional built-in Pi Pocket extension. The panel, quick sheet, overview page, and routes are
owner-only. New installations start with it off. Enable **Menu → Extensions → Context Insight**.

It makes no model requests, adds no tools, and adds no model-visible messages. While enabled, it retains diagnostic
request and usage records in separate conversation documents. Turning it off stops new capture; it does not delete
records already stored.

## Views

- **Now:** provider-measured context pressure with subsequent estimates, estimated category composition, prompt
  sections, tool definitions, lifetime usage, cache, and cost. Reasoning already included in output is not added again.
- **Growth:** request or turn grouping, context and delta charts, timing, TTFT, throughput, cost, cache, a linked
  overview ribbon, zoom range, selection, and a usage table. Missing timing remains unavailable.
- **Items:** native Durable reading order, complete system sections and tool schemas, exact selected message parts,
  search and filters across the full result, token-width DNA, historical requests, and request-to-request differences.
- **History:** all stored transcript entries through paging, plus captured normalized requests and their responses.
  Large text uses explicit display chunks instead of an invisible character cutoff.
- **Files and commands:** direct and nested activity, requested/returned read ranges where recorded, errors,
  completeness, recorded patches, full stored output, background observations, duration, and program statistics.
- **Fleet:** all direct subagents, stored parent and linked-session relationships, agent history, and recorded
  communications. No task dependency graph or unrecorded communication is invented.
- **Insights:** every visible session, bounded concurrent scanning, progress, cancellation, retry, date-filtered
  token/cache/cost totals, daily activity, and an independent 8-week heatmap.
- **Attachments:** exact stored image locators, including replacement edits, dimensions and size when known.

## Accuracy and Retention

Native `Conversation.context()` supplies current and historical request reconstruction. It applies edits, ordering,
and synthetic missing tool results. That reconstruction precedes `beforeRequest` hooks. The separate captured-request
view records normalized input after those hooks, not provider-wire JSON. Capture begins only when the extension is
enabled. Old hook changes that were never stored cannot be recovered.

Provider usage and costs remain reported values. Category splits and image tokens follow Pi's estimator; they are
not measured per-category charges. Tool sources name the extension in the current registry, not verified historical
provenance. The interface exposes these distinctions.

Daily accounting includes recorded failed responses and tool usage. Enabled capture also records usage-commit deltas,
including entryless compaction and cache maintenance. Inherited fork history is not billed again. Older ledger usage
with no timestamp remains an explicit undated remainder. Date filters do not silently assign that remainder a date.

Every transcript page participates in the fold. The in-memory cache retains at most 6 complete sessions, each below
40,000 entries and approximately 16 million serialized characters. Larger sessions use complete cold reads rather
than losing their system baseline. Response limits are page sizes, with continuations for older rows. The `through`
revision fixes a list's transcript boundary while new entries arrive.

Nested task inputs survive after completion, but older nested results may have retired with their parent task.
Enabled capture retains available result metadata for future inspection. Structured output is not presented as a
complete text rendering. Pocket codemode records up to 100,000 text characters per nested call and 1,000,000 per
script while inspection is selected; omitted counts remain explicit. Stored tool truncation, missing results, and
unknown file coverage remain explicit.

Capture persistence runs outside the provider path. Capture errors or stalled writes do not block model responses or
tool execution. An abrupt process exit can lose queued diagnostic writes; ledger reconciliation still exposes missing
usage. Request and result records can grow with history and currently have no automatic deletion policy.

## Files and Settings

- `../context-insight.ts`: routes, paging, settings, owner preferences, cache, and refresh events.
- `../../context-insight.ts`: pure transcript fold, item locators, file and command activity.
- `../../context-insight-data.ts`: daily accounting and list paging.
- `../../context-inspection.ts`: optional normalized request and usage capture.
- `../../tool-activity.ts`: public Durable task inspection and retained nested result metadata.
- `index.js`, `text.js`, `format.js`, `look.css`: browser interface and translations.

Server defaults still use the existing settings key. View preferences synchronize through the extension's own
person-keyed document, with the existing `x.context-insight.*` browser preferences as the initial fallback.

The built-in keeps the `context-insight.ts` filename, route namespace, enable choice, and defaults. Pi Pocket excludes
same-name drop-ins. Disable/reload removes listeners and derived caches. Core helper changes require a server restart.
The package and custom API annotations remain at **0.26.0**.
