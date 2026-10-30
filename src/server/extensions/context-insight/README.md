# Context Insight

Context Insight is an optional built-in Pi Pocket extension. It reads stored conversation history through the
extension read API. It adds no tools, makes no model requests, and never changes a conversation.

Enable **Menu → Extensions → Context Insight** as the owner. New installations start with it off. The panel,
quick sheet, overview page, and routes are available to the owner only.

## Files

- `../context-insight.ts` registers routes, settings, the browser module, and refresh events.
- `../../context-insight.ts` folds stored transcript entries into the dashboard model.
- `index.js`, `text.js`, `format.js`, and `look.css` implement the browser interface.

## Views

- **Context panel:** current occupancy and estimated composition, request growth in total or delta mode, an overview
  ribbon, grouped or flat DNA item browsing, context events, file operations, commands, and Fleet.
- **Quick sheet:** the Context button beside the message box opens the current composition and recent requests.
- **Context Insights:** the rail entry opens usage by date range, token mix, daily activity, and session cards.
- **Fleet:** agents and their tasks, status, context, usage, and parent/agent messages. It reads the tasks Pi Pocket
  stores; it does not create a task dependency graph.
- **Attachments:** expanding a stored entry can load its image thumbnails and text. File operations show the recorded
  read result or the text supplied to write/edit, rather than reading the file as it is now.

Provider usage and costs are reported as stored. Category splits are estimates. Tool sources name the extension in
Pi Pocket's current registry, when known; a historical tool no longer registered has no verified current source.
The cache retains the newest 40,000 entries per conversation and 6 conversations. A truncated history is marked in
the response and the session panel. New entries continue loading after that limit.

## Settings and migration

Menu → Extensions → Context Insight sets default tab, growth mode, and insights range. Per-device view choices use
the existing `x.context-insight.*` keys.

The built-in keeps the `context-insight.ts` filename, route namespace, and settings key. An existing installation's
enable choice and default settings therefore continue to work. Pi Pocket never loads a same-name drop-in alongside
the built-in. The old drop-in files can be archived outside the active extension paths.

A module reload or disable clears its cache and removes its event listeners. Helper changes require a server restart,
as with other server helpers. The package remains Pi Pocket 0.26.0.
