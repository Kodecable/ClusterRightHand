# WebUI

The WebUI is a single-page React application in `web/`. crhs serves the built assets and answers
every path outside `/api`, `/agent` and `/mcp` with `index.html`
([Architecture](architecture.md#components)). The shell is served with a Content-Security-Policy that
allows only same-origin resources (plus inline styles, the theme bootstrap by its hash, and the captcha's
worker and WebAssembly) and refuses framing.

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
Shared layers (`components/`, `lib/`, `hooks/`, `markdown/`) never import from `features/` or `app/`,
and a feature never imports from `app/`; type imports count. `pnpm check` enforces this with
`scripts/check-web-layers.ts`, which names the file and import line of every violation.

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
browser tab with the object's own name, for example a task's summary. The sidebar header shows the CRH
mark; it is black, so the dark theme sets it on a white tile. The favicon set and the web manifest are
served from the WebUI root (`web/public/`); their sources are the logo delivery package.

Colors, radii and spacing come from semantic design tokens. Depth is expressed only through tokens,
in the same direction in light and dark themes. The theme is applied by an inline script before the
first paint, so a dark page never flashes light.

The UI is available in English and Chinese. The theme is a per-device choice in localStorage. The
language is the user's account setting: after login the server's value wins and the client switches to
it, writing the `crh.locale` cache that the login page and the first paint use. When the server value is
null, the WebUI writes the stored or browser choice back once, so the settings dialog never shows an
unsaved language as the account's; a saved value is never overwritten and a failed write is not retried.
The browser tags go through the shared RFC 4647 registry (`packages/api/src/locales.ts`): `zh-TW` and
`zh-Hans` select zh-CN (no Traditional catalogue exists yet), `en-GB` selects en, and an unknown language
falls back to English. Labels for server enums (task states, presets, audit actions) are translated; an
unknown value is shown raw, so a new server state is visible before its translation exists. Server error
messages and agent output are not translated.

### List navigation, links and refresh

A row that stands for an object with a detail page opens that page when clicked anywhere outside its
controls. The row contains exactly one real link, so keyboard focus, middle-click and "open in new
tab" behave as for any link, and a click that ends a text selection does not navigate, so cell text
stays copyable.

Links to other objects look like underlined text, never like buttons, and buttons never look like
links. Every user shown as an actor or owner links to that user's page; whether the viewer may open
it is the destination's concern. An internal link is foreground text with a faint underline that turns
solid on hover; the underline thickness never changes. An external link takes the brand colour with the
same faint-to-solid underline and a small arrow after its text, and opens in a new tab without an opener
reference. `InternalLink` and `ExternalLink` are the only components; a hand-written underline class is
not.

There is no refresh button. Every list or section stays current through polling, SSE or invalidation
after a mutation. Editing happens on an object's detail page; lists offer only the actions that make
sense in bulk, such as approving a pending node.

### Status, time and task results

A status is coloured text with a tone (ok, warn, danger, info, muted), the same everywhere. A task
outcome is the one exception that also carries a dot, so its green, red or muted colour reads before
its text.

Lists show relative times, with the absolute time in the tooltip. Detail pages and security-relevant
lists (audit, authorizations, approvals, tokens, signing credentials) show absolute times with seconds. A
stream of messages, where the day is usually clear from what is around it, shows the short absolute form
(`ShortDateTime`): the time alone today, the month and day before it this year, and the full date in an
earlier year, in minutes, with the absolute time with seconds in the tooltip. All three come from
`lib/format.ts` in the interface language's order with a 24-hour clock, and all times use the browser's
time zone. Durations share one formatter (`formatDuration`): **1h 02m**,
**2m 00s**, **13s**; a task's max TTL, a measured clock offset, an ETA and a turn's duration all read the
same way.

A task in state `exited` reads **Finished** whatever its exit code. The server classifies the result once
and every page renders that same `outcome` through **`TaskOutcomeBadge`**: **Exit code N** (an exec task
keeps `Exit code 0`), **Done** for a successful file operation, **Killed by signal …**, **Timed out**,
**Cancelled**, **Expired**, **Rejected**, **Denied by rules**, the platform error text, or **Result
unknown**. A terminal status takes its tone from `outcome.failed`, so a non-zero exit is never green
beside a red result; a cancelled or expired result is muted, not failed. Status labels read **Finished**,
**Errored**, **Rejected**, **Denied by rules**, **Cancelled**, **Expired** and **Unknown**. A task
group has the same outcome: cancelled and expired are not failed, rejected and interrupted are, and a
finished group fails when any member did. A task's title always comes
from `taskTitle`: the server-built action (the command or the file operation with its path), or its kind
when the row has no readable action.

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
- **Decision component.** One card layout for every wait, mirroring the chat card's line order: the
  title with its privileged mark, a grey meta line, Auto Review's risk badge and reason, the one-line
  monospace detail, a divider with room on both sides, then the panel's own tabs. Every slot except the
  title and the tabs is optional, and the truncated meta and reason lines show their full text on hover.
  Three panels share it: **ApprovalPanel** (**Approve / Always allow / Reject**), **SignaturePanel**
  (**Passkey / Passkey 5min / crhu / crhu 5min / OpenSSH / Local / Reject**, rendered from the options
  the server planned: the Passkey tab only when a `sign` option exists with a trusted Passkey, the crhu
  and OpenSSH tabs for every `sign` option, the Local tab only for a `local_window` option, and
  "Preparing…" plus Reject while no plan is written) and **QuotaPanel** (**Add tokens / Stop**). The
  two 5min tabs appear beside their signing method when the `sign` option carries a `reusableScope`:
  the request's nodes and the one method its waiting tasks use (file.write when they read and write),
  offered only when every node has a planned user entry that requires neither a bound spec nor task
  ids. They sign a reusable authorization with an empty prefix of that method on those nodes for five
  minutes instead of this payload, so any task of that method the owner starts there in that time runs
  without a signature, from any session or schedule; the tab says so. Passkey 5min drafts the payload
  with `POST /api/authorizations/draft` and signs its challenge; crhu 5min shows the matching
  `crhu grant --method … --prefix '' --deadline 5m` command and a paste box. The approval and signature
  panels render only the server-built compact `ApprovalRequest` through one mapper: the target node
  names with "and N more", Auto Review's settled risk and reason, and the action on one line (the
  command, the file operation with its path and line range, the API method and path, or the extension
  tool). The title is **Your approval is needed** for a rule approval, **Your signature is needed**
  for a signature wait and **Token quota used up** for an exhausted quota. The source (a session title
  links to the session, an API token or a user) appears only in the page variant as
  **Nodes: … · Source: Session …**; the inline variant used by the session dock shows neither the source
  nor the rule chain evaluation. Every quota surface shows used first and never a negative remaining:
  **Used N · N left**, or **Used up, over by N** when exhausted.
  **Always allow** offers the request's server-built candidates (exact or prefix, this tool or the
  whole extension, this request or this route) as radios over editable rule JSON. Session pages,
  approvals deep links, task pages and external call pages render the same components, so a decision
  made in one place updates the others. The page variant adds the shared **RequestDetails** section
  below the card: Auto Review's full verdict (decision, risk, reason and model), the rule chain
  evaluation folded away (one table per node for a task group), and the request content as JSON code
  blocks (the operation, an external call's arguments or annotations, or an API request's query and
  body). Task, task group and external call pages use that same section instead of separate review and
  external call detail panels, and a settled request on the approval pages shows one status badge and
  a link to its object. A request Auto Review is still judging shows the reviewing notice inside the
  same card and offers no decision controls; in the transcript it looks like a tool call in progress.
- **`RequestSource`** is the only way a request's origin is shown: **Session …** (the title links to the
  session), **User …** (linked to the user page) or **API token …**; audit events also carry **System**,
  **Auto Review** and **Schedule …**. There is no second wording for the same person. The one shared
  `actionText` names what a task or approval does, so a task titled **Write file /etc/x** in the tasks
  list reads the same in approvals and decision cards.
- **`TaskOutcomeBadge`** is the only way a finished task, task group or node result is shown: its dot and
  one localized line come from the server's `outcome` ([Status, time and task results](#status-time-and-task-results)).
  Session tool cards read the same outcome from the result details instead of re-deriving failure.
- **`PrivilegedMark`** is the only privileged pill. A decision card shows it beside the title; the task
  list and the task and task group facts show it beside the kind.
- **`NodeTargetList`** is the only node or node-group target list. Each target is a link to its page,
  `_all` reads **All accessible nodes**, a deleted reference says so, and an id with no known name stays
  visible as muted monospace text. A compact request's leftover names are the same message as the list
  (**… and N more**, localized), and the `compact` mode keeps a table cell on one clipped line. The
  matching `nodeTargetsText` gives a clipped cell its tooltip.
- **`TaskFacts` / `TaskGroupFacts`** build a detail page's fields from the same rows: id and copy button,
  kind with the privileged mark, source, status and result (a group shows its targets), then created and
  finished times.
- **`displaySessionTitle`** is the one session title: the stored title, or **New Session** for a null,
  empty or whitespace-only one. Lists, breadcrumbs, decision cards and the channel cards all use it.
  Titles are at most 60 code points (`SESSION_TITLE_MAX_CHARS`); the title editor shows a field error
  for a longer one and does not send it, rather than letting the server's 400 be the only feedback.
- **`CodeFrame`** is the one code-block frame: a bordered rounded block with an optional header bar
  (title, optional meta such as a byte count, and actions such as copy), a transparent scrollable body
  and an optional footer bar. **`CodeText`** is the collapsible output variant: its label is the header
  title, its copy action sits in the header, and a footer keeps **Showing first N of M lines** with
  **Show all** / **Show less** while the text is cut. **`OutputBlock`** is the task-output variant whose
  header carries the label and byte count, and whose body joins head and tail with one omitted-bytes
  line. The Markdown **`CodeBlock`** renders through the same frame.
- **`FileManager`** is the only file browser. It knows nothing of libraries or nodes: it takes a
  `FileSource` with `list` and `stat`, and optionally `download`, `upload`, `delete`, `rename` and
  `preview`. A missing operation hides its action. Its toolbar (a home icon, the path breadcrumb and
  an actions slot) and its list are exported as `FileToolbar` and `FileList`, so a page supplies its
  own actions; directories list before files, and a narrow screen hides the size and updated columns.
  Previews are images only (PNG, JPEG, GIF, WebP up to 20 MiB), loaded when opened; lists show no
  thumbnails. Uploads run through `useUploadQueue` — sequential, with byte progress, speed, time left,
  skip-on-error and cancel — and are shown in `UploadProgressDialog`. **`FilePickerDialog`** is the
  same component in selection mode (single or multiple files) over any source.

## Pages

Most pages are a list and a detail page built from the conventions above. The decisions below are
specific to one area.

### Task and task group pages

Tasks are started from the **Run task** dialog on the tasks page. The dialog only submits: one node
creates a task, anything else (a node group, several targets, or all accessible nodes) creates a task
group, and the dialog then opens the new task or group. Results are always read on the task or task
group page, never in the dialog.

A task reported `unknown` is shown as not running — no Stop control — while the page keeps asking for
a late result every 15 seconds; every recorded terminal state stops the polling. The terminal states
come from `@crh/api`, the same set the server uses.

The task page shows the outcome badge next to the state in its header, and its shared facts name the
source. The task group page keeps its status above the member rows and shows one facts block built from
the same rows: source, the privileged mark, the stored target nodes as links, the group's outcome, and
the created and finished times. Its shared request details show the
rule chain evaluation whenever an approval was evaluated and Auto Review's verdict when it ran, and a
result panel appears only when the task produced output. While Auto Review is judging a task or task
group, its page shows the reviewing notice inside the decision card and offers no controls. The task
list can be filtered by node and by user through the URL, so other pages link to a pre-filtered list
(**View all tasks**) instead of paging through tasks themselves; their recent lists show only the
newest ten.

The list hides tasks that have a `purpose` ([Task purpose](execution.md#task-purpose)), such as file
browsing, unless the filter includes them. `file.push` and `file.pull` tasks and their approvals show
the direction, both ends (a library end links to the file), the size and a copyable SHA-256; content is
never previewed.

### User and user group pages

Only administrators manage users. A member can open only their own user page. Group membership and
node access are edited on the user, user group or node group page, not in lists.

Usernames and user group names start with a letter after trimming and lower-casing
([User model](access-control.md#user-model)). The **New user** form checks the rule before submitting and
shows the same message the server would; the user group dialog shows the server's refusal.

Both pages have a library section with the usage, the three limits, an administrator's **Edit limits**
dialog and a link to the library. Deleting a group whose library is not empty is refused with the file
count and a link to the library ([Libraries](library.md#libraries)).

### Library page

**Library** in the Work group of the sidebar opens `/library/$library?path=…`, so a location can be
linked and survives a reload. One control names the current library by its owner's display name
(**User …'s library** / **User group …'s library**) and opens the entity picker: a member sees their
own and their user groups' libraries, an administrator any user or user group. The page is the file
manager over the library. Its toolbar shows the share of the total-size limit in use and a bar for the
tighter of the file-count and total-size limits, with the exact ratios in a tooltip; the bar turns to a
warning near a limit.
Uploads take the button or a drop on the page, one at a time, in a dialog with the overall progress,
the speed and the time left. A refused file is skipped and listed with the limit it hit, and cancel
stops the remaining uploads. Leaving the page, or any other unmount of the queue, aborts the file in
flight and stops the rest. There are no folder objects: an upload goes to the current path, and a
path with `/` in an upload or rename creates the directories ([Libraries](library.md)).

### Download page

`/download` is the target of a download link made outside the WebUI, such as a file a chat channel
delivered ([Channels](channels.md)). The link names a library file by `libraryId`, with the `library`
reference as a fallback for a library the reader's list does not show, or a node file by `nodeId`, and the
`path`. The page sits behind sign-in like any other, so a signed-out reader signs in and comes back to the
same link. It then checks the file as the signed-in user (a library stat, or a `file.stat` on the node),
shows it as a file box and starts the download once; a click on the box downloads it again. A missing file
and one the reader cannot reach get the same message. The query string is read as it is, so a path or id
is never reparsed. Links inside the WebUI (attachments, delivered files, the file managers) download from
the API directly, since their reader is already signed in.

### Node pages

The node list folds enrollment and reachability into one status: pending approval, connected or
offline for a crha node, and active for an SSH node, which has no standing connection.

The node page's overview has what is used day to day, the platform line included, with trust warnings
at the top: each has its own border and icon, so the list has no heading. A **Technical details** tab
shows the facts, fully, and the last trust report the node sent ([Privilege](privilege.md#trust-cache))
with the `aliases` line for `privileged.toml`: they are for diagnosis. Each trust entry is named by
what identifies its key: an SSHSIG key by its fingerprint, a Passkey by its credential id in base64url
as `privileged.toml` writes it. A Passkey's RP ID and origins are verification constraints shared by
every Passkey of the site, so they appear with the entry's rules. The report is the node's own view;
crhs only displays it. A **Generate trust config** dialog on the signing
credentials page builds basic `[[trust]]` entries for a node's `privileged.toml`, which an administrator
copies to the node: crhs cannot change what a node trusts. The measured clock offset is shown only as a
warning, because it is measured once per connection ([Privilege](privilege.md#clock)).

Administrators can delete a node from its page after a confirmation that states the consequences for
that kind of node.

A **Files** tab browses the node's file system with the file manager, as the signed-in user and
unprivileged. Each listing or stat is a `file.list` or `file.stat` task with `purpose = browse`, created
by a dedicated endpoint that waits for the result, so rules, approvals and audit apply while the task
list stays readable. A file row offers **Download** and, for a PNG, JPEG, GIF or WebP, **Preview**.
**Download** goes to `/api/nodes/:id/file?path=`, which runs a `file.pull` with purpose `browse` capped at
the user's own library one-file limit and streams the file as an attachment; when that pull needs an
approval, the request returns the reason and names the approval page. Upload, delete and rename on
nodes come later.

### Approvals page

The approvals page is one table of everything waiting for the signed-in user: task approvals, task
group approvals, tasks waiting for the user's signature, and sessions whose token quota ran out. The
columns are the type, the operation, the target nodes by name, the source and when, read from the compact
`ApprovalRequest` the server returns beside every waiting item (a signature wait's phase is
`awaiting_signature`); the whole row opens its detail. The source column header is **Source**, never a
raw `api_token:<uuid>`. A task, task group or
external call detail shows the same decision card (a task in `awaiting_authorization` shows the
signature variant) with the shared request details below it, and a quota row opens its session, where
the docked decision panel holds it. A
task group counts once. A request Auto Review is still judging is not listed and does not count; its
direct page shows the reviewing notice in the decision card until the review escalates it. The deep
links that extension and agent tools return open one approval and show the same status badge, a link
to the object and "Already settled" once it has been decided.

### Authorizations page

**Authorizations** is open to every user. Administrators see every stored authorization of the
organization, with its issuer; other users see the ones they issued, without the issuer column.
Each row opens its decoded payload. It is a record: nothing is revoked here.

**Issue authorization** opens a dialog for a reusable authorization: nodes or node groups, a limit
(a method and a target prefix, where an empty prefix allows every target of the method, or any
command), a lifetime from five minutes to a year, and an optional note. It is signed with one of the
user's Passkeys over a payload `POST /api/authorizations/draft` builds, or with the shown
`crhu grant` command, whose printed line is pasted back. Either way the result goes to
`POST /api/authorizations`, which stores it and syncs the user's waiting tasks, so a task it covers
runs at once. The schedule page points here for unattended privileged commands.

### Extensions page

**System settings → Extensions** lists both kinds in one table with their kind (MCP or built-in), state,
last error, next attempt, tool count, availability and mode flags. The list refreshes while the page is
open, and connecting through **Tools** or **Reconnect** refreshes it at once too. An MCP extension's
editor covers every field, with request headers write-only (the stored names are listed, never the values)
and availability and grants chosen with the shared controls; **New extension** creates an MCP extension.
A built-in extension's editor has only enabled, list directly, availability, grants and description, and
it has no **Reconnect** or **Delete**: built-ins exist from the start and are always ready. **Tools**
opens the listed tools with their annotations. A failed connection shows its error and keeps the last tool
list searchable ([Extensions](extensions.md#mcp-connections)).

### Channels page

**Admin → Channels** lists the chat channels with their kind, state, bot account, last error
and next attempt. **New channel** creates a Telegram bot with its write-only token; **Edit** changes
it, and **Delete** also removes the channel's linked accounts and threads. The list refreshes while the page is open, like Extensions
([Chat channels](channels.md#channels)).

### Schedules page

**Schedules** lists the caller's own schedules with their next run and last result; **Run now** starts a
manual run from the row or the detail page. The detail page is the shared schedule form plus the run
history, the privilege note and the destructive actions. The form's **Report** group chooses one of the
owner's linked chat accounts, or **None**, and, once an account is chosen, whether a finished run is
reported **Always**, **Only on failure** or **Only on success**; the detail page also shows the setting
beside the last result ([Reports](scheduling.md#reports)).

### Settings dialog

**Settings…** in the user menu opens one dialog with three tabs. **General** chooses the language.
**Sessions** sets the default model, its thinking level and the default rule preset, and a default model
offers only the levels the model supports; the level names are the same untranslated ones as in the
composer. **Chat** holds the linked chat accounts, **Create link code**,
**Unlink**, the default notification account and **Show progress** ([Accounts](channels.md#accounts)).
A change is saved immediately; the dialog has no Save button, and the language changes as soon as its
PATCH succeeds. The theme stays in the user menu and remains per device; the old chat settings page is
gone.

### Models page

Administrators configure model providers and the three model presets here. API keys are never sent
back to the browser; changing a custom provider's base URL requires entering its key again, so a key
cannot be redirected to another host without the person who knows it.

A custom provider's models section has **List provider models**. It opens a dialog listing only the model
ids the provider offers that are not configured on it yet, with a search box and one checkbox per id plus
**Select all visible**; the dialog has no other columns. An empty state appears when nothing is left to
add, and an upstream failure shows the server's message with **Try again**. Saving adds the selected models
through the provider API, filled from the catalogue ([Model discovery](agent-runtime.md#model-discovery)),
and they stay editable in the model dialog. Discovery reads the saved provider, so the button is disabled
with a hint until a new provider is saved and while its base URL or key has unsaved changes. A new custom
provider can be saved without models; the dialog then stays open as the saved provider's edit dialog, with
the button enabled.

### System settings page

Administrators edit the low-frequency runtime settings here (public URL, clock warning, retention,
WebAuthn, login hashing and captcha, the real-IP header, the default library limits for new users and
groups, the attachment inline limits and the image cache), plus crhs's authorization signing keys.
Each settings section is its own form with its own **Save**, which patches only that
section's values and stays disabled until something changed: an unrelated edit elsewhere in the page
cannot be overwritten or submitted along with it. A save applies without a restart and is audited. The
authorization signing keys table marks the newest key, because that is the one crhs signs with by
default; it shows only how many nodes trust each key, and the delete dialog names at most three of them
before summarising the rest. A key that nodes still trust can only be deleted after a second
confirmation.

## Session interface

The sessions area shows the session list beside the open session on wide screens. On narrow screens
the session takes the whole view and the list is one step back.

### Sidebar list

The list shows the root sessions the user can see: their own and those shared with them. An
administrator sees the same, not every session; administrative views of other users' sessions go
through the user pages. Rows are grouped by last activity. Changes arrive over the session list stream
([Session list API](#session-list-api)).

A session is unread only for its owner, when the agent replied after the owner last opened it. A final
answer or scheduled-run report delivered to the owner's chat counts as read too
([Messages](channels.md#messages)). A shared viewer never sees unread markers, because read state is
stored once per session.

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

When an assistant message ends without tool calls, its text is the turn's final answer: the turn's
intermediate work (thinking, tool calls, intermediate text) folds into one line with the turn's duration,
leaving the question and the answer. While the answer streams the turn stays unfolded and shows no
duration line; it folds when the message ends. An intermediate message that streams its text before its
tool call arrives is not a final answer. A turn folds once it has ended and has a final answer, process
rows and a known duration. An error in the process does not keep it open: when the reader expands the
turn, the error rows sit there with the rest of the process, and no extra warning badge is shown. A turn
without a final answer (a run that failed) stays unfolded. Compactions appear in transcript order as
their own rows.

Under the user's message and below a final answer's delivered files, a small action row holds icon-only
buttons. Copy copies the Markdown source, not the rendered text: the user's typed text for a message, the
raw Markdown for a reply. The row is always shown, in muted colours, so the actions are found without
hovering. It also carries the message's time: when a user message was sent, before its Copy, and when a
final answer finished (its assistant message's start plus its duration), after the buttons, in the short
absolute form ([Status, time and task results](#status-time-and-task-results)); a message without a time
shows none. Viewers of a shared
session get the same copy button. Beside Copy on a final answer, the owner gets Fork, which forks the
session at that reply and opens the new session; it is absent while the turn is still running and for
every viewer but the owner.

### Jumping to a message

A link to a message carries its entry id. The page loads older history until the entry appears, up to
a fixed number of pages, expands a folded turn if needed, scrolls the entry into view and highlights it.
The parameter is then removed from the URL, so a reload does not jump again.

### Session header

The header holds the title, the breadcrumb of a subagent, and sharing. The owner also gets the
extensions button when the session has extensions, directly left of Share: it opens the per-extension
toggles, a new session starts with all available extensions on, and a subagent inherits its parent's set,
only turning more off ([Extensions](extensions.md#extensions)). Administrators and share viewers never
see it. The draft page shows the same button in the same top-right position, and its toggles stay local
until the first message creates the session ([New session](#new-session)). A fork also shows "Forked
from" and a link to its source's title; the line is absent when the server returns no origin (the source
is gone or the caller may no longer see it). Below the header, at most one status line is shown, chosen by
priority: connection problems, failure, retry, the reason the session is waiting, queued messages.
Nothing is shown while a run is merely active.

The root session page shows the approvals, signatures and quota waits of the whole session tree in a
decision panel docked where the composer sits, so a user can answer them without opening each subagent.
The panel is not collapsible: it shows the first pending decision only (quota, then rule approvals,
task-group approvals and signature waits, oldest first), its own scroll and at most half of the session
pane, and a small count while more wait. Its card is the inline variant: it names the nodes and the
action but not the source, and keeps the rule chain evaluation off the dock. The composer returns as
soon as nothing waits for this viewer; a session that waits only for someone else keeps the normal
composer and the waiting reason.

### Composer

Changes to the model, thinking level or rule preset apply from the next model request or tool call;
the step in progress keeps its settings. A rule preset change re-checks waiting approvals at once. The
thinking picker uses the level's display name: a custom model's own label, otherwise the raw level id
(`high`); that name is never translated ([Thinking levels](agent-runtime.md#thinking-levels)).

Only the session owner sees the **+** button, which offers **Upload files** and **Choose from
library**; paste and drop upload too. Each attachment shows as a chip with progress and a remove button,
and sending waits for uploads ([Chat attachments](library.md#chat-attachments)).

Every send carries a request id. A retry after a lost response reuses it, so the server does not
create the message twice.

The composer has no extension control: the per-extension toggles belong to the session header's button,
and to the draft's own button before the session exists ([Session header](#session-header),
[New session](#new-session)).

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

User messages are shown as raw text, with their attachments from the entry's structured data, never
parsed from the text ([Chat attachments](library.md#chat-attachments)). Each attachment is a file box
above the message bubble, on the user's side: the name, the size and, for an image, a small preview
button; clicking the box downloads the library file. A box resolves its library by the id in that data,
so a renamed group keeps the link; an older entry falls back to the stored reference. A box is inactive,
with the reason, when the viewer cannot reach the library or the file is gone. A `view_image` row shows
the image's source, size and SHA-256, not the image. A `copy_file` call is an ordinary tool row. Once a
turn has ended, each file it delivered (`destination.user_interface`) appears after the final answer —
and after anything the turn shows after it — on the assistant's side, left-aligned with the assistant
text. One shared file box renders both: the file name, the source (library reference or node name, shown
for a delivered file) and the size, a download on click, and a preview button for an image. A library
source is resolved by id, like an attachment box, and the box stays visible while the turn's process is
folded. Only a turn's successful deliveries are shown, once per source and path, and nothing is shown
while the turn runs ([Deliveries](library.md#deliveries)). The final answer's copy and fork row is its
own row after the delivered files, so the files sit between the answer and its actions; anything the
turn shows after the answer stays above both. A turn without deliveries keeps the actions directly
below the answer.
While the session runs, a turn whose last rows are errors shows one warn-coloured
"Retrying (attempt N)…" line after the turn, outside its fold; N counts the consecutive trailing
errors plus one. The line leaves as soon as a new assistant message starts or the session stops, while
the red error rows themselves stay.
Assistant text and thinking are Markdown ([Markdown rendering](#markdown-rendering)). Tool calls are
one-line rows that open a dialog with the arguments and the returned result, plus one row of plain links
to the task, task group or subagent session the call names. A call that has not returned shows no result
section. Approval, authorization and quota waits appear in the docked decision panel, not in the
transcript.

A tool row's icon shows whether the call is running, finished or failed. Failure is judged from the
structured result the tool returned, not by parsing the text the model sees. A call that stopped
without a result (for example after a restart) follows the task it started by polling it every few
seconds. It does not long-poll, because one session can have many such calls and each long poll would
hold one of the browser's few connections to the origin.

### New session

The new-session page is a draft: apart from loading its extensions, it calls no API until the first
message is sent. Sending creates the session and its first message in one request with its own request
id, then replaces the draft in the browser history, so Back does not return to it.

Opening the draft applies the user's defaults: the default model, then the session model preset, then
the first offered model; a default model a provider no longer offers falls through to the next step. The
thinking level comes from that model and the rule preset from the user's setting, falling back to `off`
and Ask. Every change of the model, thinking level or rule preset on the draft immediately PATCHes the
corresponding user setting, so the next draft opens with it. The last-used model is not stored in
localStorage.

The draft also loads the extensions the caller may start a session with, in the same shape and
resolution as a session's `extensions`, every entry on. Its extensions button sits in the transcript's
top-right corner, where the session header shows it, with the same on/total label; it is hidden when the
list is empty and clear of the narrow-screen back button on the left. The toggles stay in the draft's
local state, so no PATCH is sent: the off list goes with the create request as `disabledExtensions`, and
the session starts with those extensions already off. A reload or a new draft starts from all on again
([Extensions](extensions.md#extensions)).

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

Footnotes work across those blocks. `[^label]` and its `[^label]: text` definition usually land in
different blocks, so the splitter collects definitions in a `footnotes` field (marked has no footnote
token; a paragraph that starts with `[^label]:`, or a reference-definition token that does, is one) and
prepends them to every block, exactly as it does reference definitions. The definition blocks are not
rendered where they stand. One ordered list at the end of the message carries the bodies, each rendered
through the same block renderer and ended by the ↩ back-link inside the note's last paragraph, not on a
line below it. remark-gfm's own per-block `data-footnotes` section is suppressed.

Because every block runs remark-gfm on its own, the reference numbers inside a block start at 1 again.
The renderer therefore numbers the definitions once for the whole message, in the order of first
reference, and passes that map (plus the index of the first referencing block for each label) through a
React context read by the anchor component when it renders; cached block elements stay valid because
the number and the anchor prefix are resolved at render time. The one ordered list uses the same order. Only the message-wide
first reference of a label keeps its `fnref-…` id, the back-link target; repeats in other blocks drop
it, since remark-gfm only suffixes repeats within one block. The footnotes heading carries
`${prefix}footnote-label`, and every reference's `aria-describedby` points at it, so the description
resolves instead of naming a missing element.

Each message gives its footnotes a prefix from React's `useId` (sanitized to `[a-z0-9-]`), so two
messages on one page never share `fn-1` ids. Cached blocks are converted with one constant placeholder
`clobberPrefix` instead of that prefix: the block cache key is the block's full source (with the
collected definitions and footnotes) and carries no per-message data, so a virtualised row that
remounts, or another message with the same text, reuses the converted element. The anchor component
reads the real prefix from the same React context at render time and rewrites the placeholder in each
footnote reference's `id`, `href` and `aria-describedby` and in each back-link's `href`, so the
placeholder never reaches the DOM. The notes section itself (the heading id and each `li` id) uses
the real prefix; a note body's source carries the placeholder back-link so the body can be cached
too, and the anchor component rewrites it at render time. The URL transform admits those placeholder
footnote fragments for the same reason; everything else, including arbitrary user `#fragment` links,
still goes through the safe URL policy. A definition's `li` id, the reference `href` and the back-link
use the identical encoding remark-rehype uses for the anchor (`safeId`: the label is normalised to
lowercase and percent-encoded like a URL, so uppercase labels fold together and a label such as
`[^注释]` becomes `%E6%B3%A8%E9%87%8A`).

Math is browser-native MathML produced by Temml. Delimiters are `$$…$$` (inline when it stays on one
line, display when it forms a `$$` fence) plus the TeX-style `\(…\)` (inline) and `\[…\]` (display),
which a preprocessor rewrites to the dollar forms before splitting; it never touches fenced code or
inline code spans. `\[…\]` is display math only when it forms a block of its own: the opener starts
a line after at most three spaces of indentation and the closer ends a line (trailing spaces
allowed), and the rewritten `$$` fence keeps that indentation, with its content indented alongside
it so display math inside a list item stays in the item. A `\[…\]` anywhere else is ordinary
Markdown — `\[link\]` mid-sentence is the escaped literal bracket `[link]`, and treating it as a
display fence would split the paragraph around it. A single `$…$` is not math: remark-math runs with
`singleDollarTextMath: false`, so `$5 and $10` stays text, because dollar signs are ordinary prose
money. A display `$$` fence may contain blank lines; the splitter merges the tokens it produced
until the closing `$$`. In a finished message a `$$` opener with no closing fence is not a formula:
it does not absorb the following paragraphs, which render normally as Markdown. While streaming,
only the last block can still be an unfinished formula; it is shown as its source, and invalid TeX
falls back to the source; neither throws. Temml is a dynamic import (a separate chunk), so a page
with no math never loads it; while the chunk loads the TeX source shows in a monospace span. Temml
renders MathML only (`trust: false`), and its small local font stylesheet rides in the same lazy
chunk. Display formulas are centered and scroll horizontally inside their own box, so a wide formula
never widens the page.

### Code highlighting

Shiki runs with its JavaScript regex engine, so no WASM is needed. Highlighting is incremental per
code block: completed lines are tokenized once and only the last, incomplete line is redone on each
update. Common shell and data languages load in idle time; others load on first use, and the block
shows plain text until then. Every code block renders through one frame
(doc/design/webui.md "Shared components"): the header bar shows the language name (never a line count)
with the copy action, and the frame follows the shared framed-block colour rule — a `--border` border,
solid `--muted` header and footer bars, and a transparent `<pre>` body on the surrounding page, card or
dialog surface. Inline code uses `--muted`. The Shiki theme's own background is never used, and plain
(not yet highlighted, or an unsupported language) and highlighted blocks use the same surfaces, so they
look identical in either theme.

## Backend API

The WebUI uses the same JSON API as other clients. Request and response types are shared with crhs
through `packages/api`, which is the authoritative definition of every endpoint.

### API conventions

All endpoints are same-origin and require a signed-in user, except the login flow and the health
check. Request bodies are size-limited, and the login body is limited before it is parsed, so an
oversized login never reaches authentication or rate limiting. Task inputs have a larger limit to
allow file uploads.

### Route definitions

The API serves the WebUI and agents' `api_request`; it is not offered to outside programs and has no
versioning policy or compatibility guarantee ([Layering principles](architecture.md#layering-principles)).

Routes are defined with `defineRoute` (`server/src/api/openapi.ts`, on `@hono/zod-openapi`), so one
definition validates the request, types the handler and produces the API document. Hand-written
parsing and a separate document were rejected because they drift apart.

- Request and response schemas are zod schemas in `@crh/api/schemas`. The wire types in `@crh/api` are
  derived from them with `z.infer`, so the main entry stays types plus the small locale registry and the
  WebUI never bundles zod.
- Every route declares its agent access (`allow`, `ask` or `deny`) for `api_request`
  ([Extensions](extensions.md)). The field is required, so a new route cannot skip the decision.
- A request that fails its schema is a 400 whose message is the first problem, `<field>: <problem>`.
  A handler returns only its successes; a missing object or a rejected request is thrown
  (`NotFoundError`, `UserError`) and answered by the one error handler.
- Descriptions on the schemas and the route summary are the documentation; they are written for a
  reader who has only the document, including a model.
- A test walks every route registered under `/api` on `createApp` and requires it in the document
  with its agent access, so a new route cannot go undocumented.

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

A draft has no session to read, so its extensions come from `GET /api/sessions/extensions`: the
caller's available extensions in the session view's shape, every entry on. The create request,
`POST /api/sessions`, accepts the draft's `disabledExtensions` and stores them on the new row, so the
first turn already leaves those extensions out.

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
