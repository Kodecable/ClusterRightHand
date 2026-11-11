# WebUI

The WebUI is a single-page React application in `web/`. crhs serves the built assets and answers
every path outside `/api`, `/agent` and `/mcp` with `index.html`
([Architecture](architecture.md#components)).

Three requirements shape the design:

- **Scale.** One user may have tens of thousands of sessions and one session tens of thousands of
  messages. Lists page with cursors and render through virtual lists; streamed text bypasses React
  state.
- **Untrusted content.** Agent output is written by a model that may have read hostile input. It is
  rendered through one Markdown path that cannot run code or load remote resources.
- **The server is the authority.** The UI hides what a user cannot do, but every check happens in
  crhs. A page never assumes a permission the server has not confirmed.

## Frontend architecture

The code is split by domain under `web/src/features/`. A feature owns its API hooks, pages and
components; code moves to the shared `components/` or `lib/` only when a second feature needs it.

Each concern has one library and one implementation: one router, one server-state cache, one table
component, one searchable picker, one form pattern. shadcn component sources are copied into the
project and owned by it, so local changes do not fight upgrades. Dependency versions are pinned in
`web/package.json`. Time and number formatting use the platform `Intl` API; there is no date
library.

### Routing

Routes are path-based and typed. Every page is a lazy chunk; the session pages are prefetched at
startup because the first screen waits for them.

Every route except `/login` requires a signed-in user. Administrator-only routes redirect other users,
but that is a convenience: the API refuses the data anyway. Where a user may lack access to an object,
the server answers 404 as for a missing object, and the page shows one message for both, so the UI
does not reveal whether the object exists.

Old transcripts contain hash links (`#/sessions/:id`). They are rewritten to the path form before the
router starts.

### Data layer

All server state goes through one TanStack Query client.

- Queries do not refetch on window focus. Pages stay fresh through polling, SSE and invalidation after
  a mutation; focus refetches would only multiply traffic.
- Client errors (4xx) are not retried; network and server errors are retried twice. Mutations are
  never retried.
- A failed mutation shows the server's message as a toast, unless its error belongs inline, such as
  a form's error line.
- A 401 from any request clears the cache and returns to the login page with the current URL as the
  redirect target.

The SSE client handles reconnects itself instead of relying on `EventSource`. After an error it
probes the endpoint to learn the HTTP status: 401 means the login session is gone, 403 and 404 stop
the stream, anything else reconnects with exponential backoff. After a reconnect it refetches the
affected list, so events missed during the gap are replaced by a fresh page.

### Login captcha

When the server requires a captcha, the login form solves a Cap proof of work
([Access control](access-control.md#cap-proof-of-work)). The challenge is requested only when the user
submits, so it is bound to the submitted credentials and client address. The hash that binds the
credentials is computed in JavaScript, because `crypto.subtle` is unavailable on a plain-HTTP LAN
origin, which is a supported way to open crhs. The widget and its WASM files are served by crhs; no
CDN is contacted. An expired challenge is solved and retried once.

### Shell, theme and language

The shell is a collapsible navigation sidebar, a top bar with the page title, and the routed page.
Below the medium breakpoint the sidebar becomes a drawer. A detail page may title the shell and the
browser tab with the object's own name, for example a task's summary.

Colors, radii and spacing come from semantic design tokens. Depth is expressed only through tokens,
in the same direction in light and dark themes. The theme is applied by an inline script before the
first paint, so a dark page never flashes light.

The UI is available in English and Chinese. Labels for server enums (task states, presets, audit
actions) are translated; an unknown value is shown raw, so a new server state is visible before its
translation exists. Server error messages and agent output are not translated.

### List navigation, links and refresh

A row that stands for an object with a detail page opens that page when clicked anywhere outside its
controls. The row contains exactly one real link, so keyboard focus, middle-click and "open in new
tab" behave as for any link, and a click that ends a text selection does not navigate, so cell text
stays copyable.

Links to other objects look like underlined text, never like buttons, and buttons never look like
links. Every user shown as an actor or owner links to that user's page; whether the viewer may open
it is the destination's concern.

There is no refresh button. Every list or section stays current through polling, SSE or invalidation
after a mutation. Editing happens on an object's detail page; lists offer only the actions that make
sense in bulk, such as approving a pending node.

### Status, time and task results

A status is coloured text with a tone (ok, warn, danger, info, muted), the same everywhere. Dots are
used only in the session list.

Lists show relative times, with the absolute time in the tooltip. Detail pages and security-relevant
lists (audit, authorizations, approvals, tokens, credentials) show absolute times with seconds. All
times use the browser's time zone.

A task in state `exited` reads **Finished** whatever its exit code; the outcome (exit code, signal,
timeout, cancellation, or **Succeeded** for a successful file task) is shown separately. Every page
derives these labels from the same functions, and a task's title always comes from `taskTitle`: its
summary, or its kind when there is none.

### Shared components

The UI is assembled from a small set of shared components so that the same kind of thing looks and
behaves the same on every page:

- **`DataTable`** is the only table. It combines the column model with cursor loading and virtual
  rows for long lists. Columns declare fixed or minimum widths; when the viewport is narrower, the
  table scrolls horizontally instead of clipping columns. Truncated cells carry their full text in a
  tooltip.
- **Sections.** A detail page is a sequence of titled sections. A section's actions sit in its
  heading, never below its table. Empty, loading and error states each have one component, used the
  same way everywhere.
- **Forms** use `react-hook-form` with a `zod` schema as the only validation; native browser
  validation is off. Destructive actions go through a confirmation dialog that names the object and
  the consequence.
- **`EntityPicker`** is the only control for choosing users, user groups, nodes or node groups. It
  searches on the server and resolves already selected ids separately, so no page downloads a full
  list of users or nodes ([Entity search](#entity-search)).
- **Decision component.** One frame (what is asked, the target nodes by name, the operation on one
  truncated line) with a tab bar for the answer: **Approve / Always allow / Reject** for a rule
  approval, **Passkey / `crha grant` / `ssh-keygen` / Local approval / Reject** for a signature wait,
  **Add tokens / Stop** for an exhausted quota. The Passkey tab exists only when a trusted Passkey
  does. Session pages, approvals deep links and task pages render the same component, so a decision
  made in one place updates the others; the rule chain or payload details stay behind a tab or a
  collapsed block, never in the default view.

## Pages

Most pages are a list and a detail page built from the conventions above. The decisions below are
specific to one area.

### Task and task group pages

Tasks are started from the **Run task** dialog on the tasks page. The dialog only submits: one node
creates a task, anything else (a node group, several targets, or all accessible nodes) creates a task
group, and the dialog then opens the new task or group. Results are always read on the task or task
group page, never in the dialog.

The task page shows the outcome next to the state in its header. It shows the rule chain evaluation
whenever an approval was evaluated, and a result panel only when the task produced output. The task
list can be filtered by node and by user through the URL, so other pages link to a pre-filtered list
(**View all tasks**) instead of paging through tasks themselves; their recent lists show only the
newest ten.

### User and user group pages

Only administrators manage users. A member can open only their own user page. Group membership and
node access are edited on the user, user group or node group page, not in lists.

### Node pages

The node list folds enrollment and reachability into one status: pending approval, connected or
offline for a crha node, and active for an SSH node, which has no standing connection.

The node page shows the last trust report the node sent ([Privilege](privilege.md#trust-cache)). The
report is the node's own view; crhs only displays it. The trust editor builds a `[[trust]]` fragment
for the node's `privileged.toml`, which an administrator copies to the node: crhs cannot change what a
node trusts. The measured clock offset is shown only as a warning, because it is measured once per
connection ([Privilege](privilege.md#clock)).

Administrators can delete a node from its page after a confirmation that states the consequences for
that kind of node.

### Approvals page

The approvals page is one table of everything waiting for the signed-in user: task approvals, task
group approvals, tasks waiting for the user's signature, and sessions whose token quota ran out. The
columns are the type, the operation, the target nodes by name, who asked and when; the whole row opens
its detail. A task or task group detail shows the decision component inline (a task in
`awaiting_authorization` shows the signature variant), and a quota row opens its session, where the
docked decision panel holds it. A task group counts once. The deep links that MCP and agent tools
return open one approval and show "Already settled" once it has been decided.

### Models page

Administrators configure model providers and the three model presets here. API keys are never sent
back to the browser; changing a custom provider's base URL requires entering its key again, so a key
cannot be redirected to another host without the person who knows it.

### System settings page

Administrators edit the low-frequency runtime settings here (public URL, clock warning, retention,
WebAuthn, login hashing and captcha, and the real-IP header), plus crhs's authorization signing keys.
Each of the four settings sections is its own form with its own **Save**, which patches only that
section's values and stays disabled until something changed: an unrelated edit elsewhere in the page
cannot be overwritten or submitted along with it. A save applies without a restart and is audited. The
signing keys table marks the newest key, because that is the one crhs signs with by default; a key that
nodes still trust can only be deleted after a second confirmation that names them.

## Session interface

The sessions area shows the session list beside the open session on wide screens. On narrow screens
the session takes the whole view and the list is one step back.

### Sidebar list

The list shows the root sessions the user can see: their own and those shared with them. An
administrator sees the same, not every session; administrative views of other users' sessions go
through the user pages. Rows are grouped by last activity. Changes arrive over the session list stream
([Session list API](#session-list-api)).

A session is unread only for its owner, when the agent replied after the owner last opened it. A shared
viewer never sees unread markers, because read state is stored once per session.

### Session search

`Ctrl+K` / `⌘K` opens session search from every page. Results are grouped by root session, with up to
three matching messages each, including messages in subagents. Choosing a message opens the session
at that message ([Jumping to a message](#jumping-to-a-message)). Message search needs PostgreSQL; on
SQLite only titles are searched ([Session content search](#session-content-search)).

### Message view

The transcript is a virtual list. Older history is loaded when the reader scrolls up, and the reading
position is corrected explicitly after the new rows are measured, because the virtual list alone
drifts while rows are measured.

While the reader is at the bottom, new content keeps the view pinned. Any upward scroll stops following
immediately and shows a **Jump to latest** button.

When the final answer of a turn starts streaming, the turn's intermediate work (thinking, tool calls,
intermediate text) folds into one line with the turn's duration, leaving the question and the answer.
A turn that contains an error is never folded. Compactions appear in transcript order as their own
rows.

### Jumping to a message

A link to a message carries its entry id. The page loads older history until the entry appears, up to
a fixed number of pages, expands a folded turn if needed, scrolls the entry into view and highlights it.
The parameter is then removed from the URL, so a reload does not jump again.

### Session header

The header holds the title, the breadcrumb of a subagent, and sharing. Below it, at most one status
line is shown, chosen by priority: connection problems, failure, retry, the reason the session is
waiting, queued messages. Nothing is shown while a run is merely active.

The root session page shows the approvals, signatures and quota waits of the whole session tree in a
decision panel docked where the composer sits, so a user can answer them without opening each subagent.
The panel is not collapsible: it shows the first pending decision only (quota, then rule approvals,
task-group approvals and signature waits, oldest first), its own scroll and at most half of the session
pane, and a small count while more wait. The composer returns as soon as nothing waits for this viewer;
a session that waits only for someone else keeps the normal composer and the waiting reason.

### Composer

Changes to the model, thinking level or rule preset apply from the next model request or tool call;
the step in progress keeps its settings. A rule preset change re-checks waiting approvals at once.

Every send carries a request id. A retry after a lost response reuses it, so the server does not
create the message twice.

The line below the composer shows generation statistics, token usage with the cache hit rate, and
context use ([Agent runtime](agent-runtime.md#session-statistics)). The remaining budget uses the
budget measure, not the usage measure. A docked decision panel replaces the composer while something
waits for the viewer ([Session header](#session-header)).

### Subagent bar

When a session has subagents, a strip above the composer shows how many there are and how many are
running or waiting. The counts come from a summary endpoint, and the subagent tree loads one level at a
time, so a session with many subagents does not load them all.

### Streaming output

Streamed text is kept in a per-row store outside React state and published once per animation frame,
so a fast stream does not cause one render per token. When the message is committed, the same row keeps
its store and Markdown tree, so the text does not re-render from scratch.

### Message rendering

User messages are shown as raw text. Assistant text and thinking are Markdown
([Markdown rendering](#markdown-rendering)). Tool calls are one-line rows that open a dialog with the
arguments, output and result. Approval, authorization and quota waits appear in the docked decision
panel, not in the transcript.

A tool row's icon shows whether the call is running, finished or failed. Failure is judged from the
structured result the tool returned, not by parsing the text the model sees. A call that stopped
without a result (for example after a restart) follows the task it started by polling it every few
seconds. It does not long-poll, because one session can have many such calls and each long poll would
hold one of the browser's few connections to the origin.

### New session

The new-session page is a draft: it calls no API until the first message is sent. Sending creates the
session and its first message in one request with its own request id, then replaces the draft in the
browser history, so Back does not return to it.

## Markdown rendering

Assistant text and thinking are the only untrusted rich content in the UI. Both go through
`SafeMarkdown`.

### SafeMarkdown

A message is split into top-level blocks, and each block is rendered separately. A growing message
re-parses only its last block, and finished blocks are cached, so long streamed messages stay cheap.
While streaming, unclosed constructs in the last block are closed before rendering, so half-written
Markdown does not flicker.

Security rules:

- Raw HTML is never rendered.
- Links are limited to `http:`, `https:` and `mailto:`. The check strips whitespace and control
  characters before reading the scheme, so `java\tscript:` cannot slip through. Any other link is
  rendered as text. External links open in a new tab without an opener reference.
- Images are never loaded; they render as a text link. No request leaves the browser because of
  message content.
- Code blocks render only text and highlight tokens; their copy button copies the original source.

### Code highlighting

Shiki runs with its JavaScript regex engine, so no WASM is needed. Highlighting is incremental per
code block: completed lines are tokenized once and only the last, incomplete line is redone on each
update. Common shell and data languages load in idle time; others load on first use, and the block
shows plain text until then.

## Backend API

The WebUI uses the same JSON API as other clients. Request and response types are shared with crhs
through `packages/api`, which is the authoritative definition of every endpoint.

### API conventions

All endpoints are same-origin and require a signed-in user, except the login flow and the health
check. Request bodies are size-limited, and the login body is limited before it is parsed, so an
oversized login never reaches authentication or rate limiting. Task inputs have a larger limit to
allow file uploads.

### Cursor pagination

Lists use keyset cursors rather than offsets, because an offset shifts when rows are inserted above the
page, and a scrolling list would then skip or repeat rows. A cursor is opaque to the client; the server
validates it and rejects any cursor it did not produce. A page returns the items and the next cursor,
which is null at the end.

### Session list API

The list returns root sessions only, ordered by last activity. A root's state is the aggregate of its
tree: waiting if any session waits, otherwise running if any runs, otherwise idle. Last activity
changes on state, title or message changes, not when a session is marked read, so reading a session
does not reorder the list.

The list stream sends an update whenever any session in a tree changes. The client places an update at
its sorted position in the pages already loaded, rather than at the top, and drops an update that
belongs beyond the loaded pages, which a later page fetch will bring.

### Session content search

Every keyword must match, either in the root's title or in user and assistant text anywhere in the
tree. Thinking, tool calls and tool output are not searched. Message search uses a generated text
column that exists only on PostgreSQL ([Data model](data-model.md#conversation-content-search)); on
SQLite the endpoint reports that only titles were searched.

### Session event stream and history

A session's event stream starts with a snapshot of its most recent entries and a cursor for older
history. Older entries are fetched in pages, which the client prepends without disturbing a stream in
progress.

### Entity search

The user, user group, node, node group and directory lists accept a search term, a result limit and a
list of ids. The search term and limit serve pickers; the ids let a picker resolve the names of values
selected earlier. Results include only what the caller may see.

### Links

Server-generated links use the path form (`/tasks/:id`, `/approvals/tasks/:id`, …). The client turns a
server-provided path into a link only if it is a same-origin path that cannot escape the app;
anything else stays text.

## Performance targets

- The entry JavaScript is at most 250 kB gzip, excluding lazy page chunks.
- With 100,000 sessions, the session list paints its first row in about 500 ms under 4× CPU
  throttling and scrolls without noticeable jank.
- With 20,000 loaded messages, the DOM size of the transcript stays constant, and loading older history
  moves the reading position by at most 2 px.
- While a 100,000-character message streams at up to 1,500 characters per second under 4× throttling,
  the Stop button responds within 100 ms at p95.
- No external image request, no executable HTML, no link outside the allowlist.
- The sidebar, menus, dialogs and lists are fully keyboard operable.

The measured results belong to [WebUI performance](testing/web.md#webui-performance).

## Known limitations

- Finished Markdown blocks are cached by calling the renderer outside JSX. This relies on
  `react-markdown` not using hooks, which a major upgrade must re-check.
- On narrow screens, tables scroll horizontally instead of turning into cards.
- Message search needs PostgreSQL.
