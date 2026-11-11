# WebUI

`crhs` serves the WebUI as a single-page React application at `/`. The source is `web/src`; a
production build is a set of hashed assets under `web/dist`. Vite proxies `/api` and `/agent` to
`crhs` in development, and `crhs` serves `index.html` for every path outside `/api`, `/agent` and
`/mcp` ([Architecture](architecture.md#components)).

The UI is built for many sessions and many messages in one page: lists use cursor pagination and
virtual scrolling, the transcript streams through an external store, and Markdown is rendered
incrementally. The rest of this document describes the stack, the shared UI conventions, the
session interface, Markdown rendering, the HTTP API the UI depends on, and the quality targets.

## Technology stack

Every dependency is pinned to an exact version; `package.json` contains no `^` ranges.

| Purpose | Library | Version |
|---|---|---|
| Build | Vite / `@vitejs/plugin-react` | 8.3.5 / 6.1.2 |
| Framework | React / `react-dom` | 19.3.1 |
| Styles | Tailwind CSS / `@tailwindcss/vite`, `tw-animate-css` | 4.3.3 / 1.4.0 |
| Components | shadcn CLI (component sources copied into the project), `@base-ui/react` primitives | 4.23.0 / 1.9.0 |
| Class utilities | `clsx` + `tailwind-merge` (`cn()`), `class-variance-authority` | 2.1.1 / 3.7.0 / 0.7.1 |
| Icons | `lucide-react` | 1.61.0 |
| i18n | Lingui `@lingui/core`, `react`, `cli`, `vite-plugin` (`macroTransform: true`), `format-po`, `conf` | 6.11.0 |
| Routing | `@tanstack/react-router` (routes defined in code, no file-route generation) | 1.170.46 |
| Server state | `@tanstack/react-query` | 5.105.0 |
| Tables | `@tanstack/react-table` (shadcn data-table pattern) | 9.3.1 |
| Forms | `react-hook-form` + `@hookform/resolvers` + `zod` (same `zod` version as the server) | 7.91.0 / 6.0.0 / 4.6.7 |
| Toasts | `sonner` (shadcn Toast) | 2.0.8 |
| Virtual lists | `virtua` | 0.54.0 |
| Markdown | `react-markdown` + `remark-gfm` + `marked` (Lexer only) + `remend` | 10.1.0 / 4.0.1 / 18.1.2 / 1.4.0 |
| Code highlighting | `shiki` (`createHighlighterCore` + `@shikijs/engine-javascript`, languages imported per chunk) | 4.5.0 |
| Login captcha | `cap-widget`, `@cap.js/wasm`, `@noble/hashes` | 0.1.58 / 0.0.8 / 2.4.0 |
| Passkeys | `@simplewebauthn/browser` | 14.0.0 |
| Tests | Vitest + Testing Library + jsdom, Playwright | 5.0.5 / 16.3.3 / 30.1.3 / 1.64.0 |

The stack uses one library per concern: one router, one server-state cache, one table model and
one component source. shadcn components are generated once and then owned by the project, so
local changes do not fight a dependency upgrade. Virtualisation comes from `virtua` because the
session list, transcripts and long tables all need windowed rendering with prepend support.
Time and number formatting use the platform `Intl` API; the UI has no date library.

## Frontend architecture

The application has a thin entry layer and is split by domain below it. The remaining pages
(schedules, credentials, SSH credentials, authorizations, API tokens, audit) use the same shell,
table, form and dialog conventions. The authorizations page is administrator-only and shows each
stored authorization's payload; it has no revoke action, because an authorization is one-shot and
expires. The audit page is append-only, filters by action and target, and opens one event's detail
in a dialog. Their domain behaviour is described in [Scheduling](scheduling.md#schedule-model),
[Privilege](privilege.md#authorizations) and [Access control](access-control.md#audit).

### Directory layout

```
web/src/
  app/              entry, providers, route table, startup work, lazy chunks, shell
  app/shell/        AppShell, sidebar, navigation table, page title, user menu
  components/ui/    shadcn-generated primitives (project-owned, editable)
  components/       shared project components (DataTable, StatusText, RelativeTime, …)
  components/entity-picker/  the searchable user/group/node picker
  features/<domain>/  sessions, nodes, node-groups, tasks, approvals, schedules,
                      credentials, ssh-credentials, authorizations, tokens, audit,
                      settings, users, auth
  hooks/            small shared hooks (mobile breakpoint, debounce)
  lib/              API client, Query helpers, SSE, theme, i18n, format, status, URL policy
  lib/api/          client.ts, query.ts, sse.ts
  markdown/         SafeMarkdown, block splitter, stream store, Shiki code blocks
  locales/          en.po, zh-CN.po
  test/             Vitest setup and fixtures
```

A feature owns its `api.ts` (query and mutation hooks), page components, domain components, pure
logic and tests. Shared code moves to `components/` or `lib/` only when more than one feature
needs it.

### Routing

Routes are path-based and defined as a typed route tree in `app/router.tsx`; there are no
generated file routes. Every page is its own lazy chunk, loaded through `lazyRouteComponent`. On a
session route the sessions list and session page chunks are prefetched at startup, because the
first screen waits for them.

| Path | Page |
|---|---|
| `/login` | Sign-in page; an authenticated visitor is redirected to `/sessions` |
| `/` | Redirects to `/sessions` |
| `/sessions`, `/sessions/new`, `/sessions/$sessionId` | Sessions layout: list plus draft page or transcript |
| `/schedules`, `/schedules/$scheduleId` | Schedules and one schedule's runs |
| `/tasks`, `/tasks/$taskId`, `/task-groups/$taskGroupId` | Tasks and one task or task group |
| `/batch` | Redirects to `/tasks`; the batch form is the tasks page's Run task dialog |
| `/approvals`, `/approvals/tasks/$taskId`, `/approvals/task-groups/$taskGroupId` | Approvals list and deep links to one approval |
| `/nodes`, `/nodes/$nodeId`, `/node-groups`, `/node-groups/$nodeGroupId` | Nodes and node groups |
| `/ssh-credentials`, `/credentials` | SSH credentials and other credentials |
| `/authorizations`, `/tokens`, `/audit` | Authorizations, API tokens and the audit log |
| `/settings/models` | Model settings |
| `/users`, `/users/$userId`, `/user-groups/$userGroupId` | Users and user groups |

Every route except `/login` requires an authenticated session: an unauthenticated visitor is sent to
`/login` with the current URL as `redirect`. The administrator-only routes (`/authorizations`,
`/settings/models`, `/users`) redirect a non-administrator to `/sessions`. `/users/$userId` has no
kind guard: the server answers the no-access case with the same 404 as a missing user, and the page
shows one message for both.

A link in the hash form (`#/sessions/:id`) is converted to the corresponding path because agent
transcripts still contain that form.
`app/startup.ts` converts `#/...` to the corresponding path with `history.replaceState` before the
router starts, keeping any query string. A malformed hash link is left alone and reaches the
not-found page. Server-generated links (`approvalUrl`, `taskUrl`, `groupUrl`,
`authorization_url`) use the path form.

### Data layer

All server state is managed by one TanStack Query client:

- `staleTime` is 60 s, `gcTime` 10 min, and a query does not refetch on window focus; the console
  polls and receives SSE updates, so focus refetches would multiply traffic.
- A 4xx error is not retried; a network or 5xx error is retried twice. Mutations are not retried.
- Lists use `useCursorInfiniteQuery`, which maps `{ items, nextCursor }` pages to an infinite
  query with `initialPageParam: null` and keeps the previous pages visible while a changed filter
  loads. `prefetchCursorInfiniteQuery` starts a page request before the component that shows it
  mounts; the later hook with the same key joins the request.
- A mutation that fails shows the server's message as a toast by default. A mutation whose error
  belongs inline (a form's error line, a test button) opts out with `meta: { toast: false }`.
- The session list stream patches the query cache with `setQueryData`; the approval queries poll,
  and a mutation invalidates the queries it affects and shows a success toast.
- A 401 from any request, or from an SSE probe, clears the query cache and sends the browser to
  `/login` with the current URL as `redirect`. The login call itself is exempt, so a wrong password
  stays a form error.

The SSE client (`lib/api/sse.ts`) owns reconnect rather than relying on `EventSource`'s default:
it closes the source on error, probes the endpoint with `HEAD` to learn the HTTP status, treats 401
as a lost session and 403/404 as terminal, and otherwise reconnects with exponential backoff from
1 s up to 30 s. After a reconnect it invalidates the affected list so missing events are replaced
by a fresh page.

### Login captcha

With `[auth] captcha = "cap"` (the default), a password login first solves an invisible Cap proof of
work ([Access control](access-control.md#cap-proof-of-work)):

- The challenge is requested from `POST /api/auth/login/challenge` only from the submit handler,
  never prefetched, so it binds the submitted username, password and client address. The page reads
  `/api/auth/login-options` to know whether the server requires a captcha.
- The challenge tag is `base64url(SHA-256(username || 0x00 || password))`, computed with
  `@noble/hashes`. The browser's `crypto.subtle` is unavailable on a plain-HTTP LAN origin, which is
  a supported way to open `crhs`.
- `cap-widget` and its two WASM files load on demand from hashed assets in `web/dist`. The
  `CAP_CUSTOM_WASM_URL` and `CAP_CUSTOM_HASHWX_URL` globals point at them and
  `CAP_DISABLE_WIDGET_REF` is set, so no CDN is contacted.
- While the proof is being solved the submit button reads "Security verification…" and stays
  disabled. A 403 `captcha_failed` (an expired challenge, for example) is solved again and retried
  once; a second failure is shown next to the form. A `captcha_required` answer when the page
  assumed no captcha also switches to solving.

### Shell

The shell is a shadcn `Sidebar` with a 48 px top bar and the routed page.

- The sidebar is `collapsible="icon"`. Its open state is stored in `localStorage` under
  `crh.sidebar.open`; the collapsed rail shows tooltips for its items. Below 768 px it becomes a
  drawer (`Sheet`).
- Navigation has three groups. Work: Sessions, Schedules, Tasks, Approvals (with a pending
  count). Cluster: Nodes, Node groups, SSH credentials (administrators), Credentials. Admin:
  Authorizations (administrators), API tokens, Audit, Models (administrators), Users
  (administrators). The Tasks item also highlights `/task-groups`; Users also highlights
  `/user-groups`. The active item is the longest matching path prefix. Groups are hidden when
  they have no visible item.
- The Approvals badge shows the number of pending decisions and `99+` above 99. Arrow keys,
  Home and End move between sidebar links in addition to Tab.
- The top bar holds the sidebar trigger, a separator and the page title. The browser tab is
  `title · ClusterRightHand`; a detail page may supply the object's own name (a task's summary)
  through `usePageTitle`, truncated to one line of at most 80 characters. Without an override the
  title is the navigation item or the application name.
- The user menu at the bottom shows the signed-in name and offers theme (system, light, dark),
  language (English, 简体中文), change password and log out. The change-password dialog is loaded
  on demand.

### Theme and design tokens

- The resolved theme is written as `data-theme="light"` or `data-theme="dark"` on `<html>`, with a
  Tailwind `@custom-variant dark` keyed on it. `color-scheme` is set alongside it.
- Semantic tokens are CSS custom properties in `index.css`, mapped to Tailwind through
  `@theme inline`. The palette keeps the blue accent; each status colour has a matching soft
  background token (`ok-bg`, `warn-bg`, `danger-bg`, `info-bg`).
- Depth is expressed only through tokens: the main area is the lightest surface, the navigation
  sidebar is one step darker, and cards and popovers sit above the main area. Dark mode keeps the
  same direction. The session list column belongs to the main area and uses `--background`; its
  selected row is an inset rounded rectangle in `--accent`, matching the sidebar's active item,
  and rows keep a small vertical gap.
- Radii, spacing and shadows come from the shadcn token scale. There are no page-specific
  `rounded-xl` or padding values for the same kind of block.
- An inline script in `index.html` sets `data-theme` and `color-scheme` before the first paint, so
  no light flash precedes a dark page. The preference is stored in `localStorage` under
  `crh.theme`; storage reads and writes never throw (a blocked or full store falls back to an
  in-memory value) and a system theme change is followed while the preference is `system`.

### Internationalization

- UI text uses Lingui macros (`<Trans>`, `` t`…` ``, `<Plural>`); message ids are hashes, so the
  English catalog is also loaded at startup and the Chinese catalog is loaded on demand.
- The initial language comes from `navigator.languages`: a `zh*` language selects `zh-CN`,
  everything else selects `en`. A user override is stored in `localStorage` under `crh.locale`,
  and switching updates `<html lang>` without a page reload.
- `lingui extract` refreshes the PO catalogs. `pnpm i18n:check` fails CI when a Chinese entry is
  missing.
- Enum display names (task states, rule presets, model presets, audit actions) are translated. An
  unknown server value stays visible as its raw string, so a new state is diagnosable before its
  translation lands. The UI never says "preset" alone: it says "rule preset" or "model preset".
  Server error messages and agent output are not translated.

### Status, time and task results

- `StatusText` renders a status as plain inline text: the tone colours the label and nothing else,
  with no border, background or dot, at the font size of its row. Every table, list, card and
  detail header uses it. `StatusDot` is reserved for the session sidebar (running, waiting,
  unread), and `StatusBadge` is only the tinted trust-warning chip.
- Tones: ok (green), warn (amber), danger (red), info (blue), muted (grey). Node `pending` is warn
  and `active` is ok. Task `exited` is ok; `awaiting_approval`,
  `awaiting_authorization`, `running` and `dispatched` are info; `failed`, `denied`, `rejected` and
  `unknown` are danger; `cancelled` is muted. A task group reuses the task tones: `finished` is ok,
  `running` and waiting are info, `rejected` and `interrupted` are danger, `cancelled` is muted.
  Session `awaiting` is warn, `running` info and `idle` muted. Schedule `succeeded` is ok,
  `running` info, `preempted` and `pending` warn, `failed` danger. Tokens: `active` ok, `expired`
  warn, `revoked` danger.
- Task state `exited` reads **Finished** whatever the exit code or signal; the exit code appears
  only in the Outcome column.
- `RelativeTime` shows the time in a list (tasks, a node's last connection, a schedule's next run
  and run history, a node's recent tasks, an access grant's creation time). It inherits the row's
  size and colour, refreshes every 30 s, and its `title` is the absolute time with seconds. A
  connected client node shows **Now** in `NodeLastSeen`, with `Connected since <absolute time>` as
  the title; a disconnected node or an SSH node keeps the relative time.
- Absolute time has one format: `DateTime` uses `formatDateTimeSeconds`, a date and time with
  seconds in the UI language and the browser's time zone. Security-relevant lists (audit,
  authorizations, approvals, API tokens, credentials, SSH credentials, user creation) and every
  detail-page timestamp use it. `Intl` is never given a fixed `timeZone`; `tabular-nums` keeps a
  column aligned.
- Task outcome: a non-exec task (`file.read`, `file.write`, `file.edit`, `file.stat`,
  `file.list`) that ended with exit code 0 and no timeout, cancellation or signal shows
  **Succeeded**; an exec task still shows **Exit code N**. Signals, timeouts, cancellation and
  platform errors keep their own labels. An empty outcome is a muted en dash.
- List body text uses the table's `text-sm` and the normal foreground colour. Monospace values
  (ids, commands, paths, keys, cron expressions) use `MONO_CELL` (`font-mono text-xs leading-5`);
  a placeholder dash is muted. Status column headers read **Status**.

### List navigation, links and refresh

A table row that stands for an object with a detail page is clickable as a whole: clicking a
non-interactive part of the row opens that page. The name is not coloured or underlined; the
affordances are the pointer cursor and the existing hover background.

- The row navigation lives in the shared `DataTable`; there is no `absolute inset-0` overlay.
  The row element handles the click, ignoring clicks that start inside an interactive element
  (`a`, `button`, `input`, `select`, `textarea`, `label`, `summary`, `[role=button]`,
  `[role=menuitem]`, `[contenteditable]`) and clicks that end a non-empty text selection, so
  copying a cell never navigates. Ctrl/⌘-click, Shift-click and middle-click open the row's href
  in a new tab.
- Each row has exactly one real link. `DataTable` places it in the first cell, wrapping that
  cell's content, styled as plain text with no underline and a visible keyboard focus ring; its
  accessible name is the object's name (`rowLabel`). It is the row's only tab stop, and middle
  click, Ctrl/⌘-click, "open in new tab" and the status-bar URL all come from that real `<Link>`.
  When the first cell is not the name (the tasks table's Created column, a run history's trigger
  time), `rowLinkColumn` names the column that carries the link. Links, buttons, copy buttons and
  switches inside other cells keep their own focus and do not trigger row navigation.
- Because no overlay covers the cells, a cell's `title` (the absolute time from `RelativeTime`,
  the full text of a truncated value) works normally, and cell text can be selected and copied.
- A row action that is not navigation (the audit row opens an event dialog) uses the same row
  click through `onRowActivate`; the real button sits in the column named by
  `rowActivateColumn` (the audit action column) and keeps an accessible name such as
  "Detail of event 12".
- Links to another object use the foreground colour with a thin underline
  (`text-foreground underline underline-offset-2`, a thicker underline on hover), never the blue
  primary colour, which would read as a button. `linkClass` is the only source of this style.
  Buttons do not look like links, and navigation does not render as a button. The one exception is
  a detail page's back control: `ArrowLeftIcon` plus a muted inline link such as **All nodes** or
  **All approvals**.
- There is no refresh button. Lists and sections stay fresh through polling, SSE or mutation
  invalidation. The audit list and approvals poll every 10 s; a node's trust report and recent
  tasks poll every 10 s; the node list and authorizations poll every 5 s; schedule runs poll while
  they are open; the session list is patched by SSE. The audit log is append-only, so a poll does
  not disturb loaded pages.
- Editing happens on the detail page only. The node-group list has no rename, delete or member
  edit; the node list keeps only Approve/Reject for pending nodes; a schedule list keeps only the
  row action **Run now**.
- A detail-page section removes a row with an outline `xs` button carrying `XIcon` and the visible
  text **Remove**. Its accessible name names the object ("Remove access for alice", "Remove alice
  from ops"). A `ConfirmDialog` asks first. User groups, user-group members, a user's node access
  and a node or node-group's access all follow this rule.
- When a user appears as an actor or owner, the name is a link to that user's page (see below).

### User links

Every user shown as an actor or owner is a link to `/users/$userId` (`UserLink`): the tasks table's
**By** column, a task's **Asked by**, the audit **By** and **On behalf of** columns, and an
approval card's **Asked by** and **Decided by**. Whether the viewer may open that page is the
destination's concern: it answers with its one no-access message. Non-user actors (system, API
token, agent, schedule) stay plain text. The session list's shared hint is plain text.

### Tables, status and dialogs

The following sections describe the shared table, section, warning, form and card conventions.
Status display is covered by [Status, time and task results](#status-time-and-task-results) and
record-shaped display by [KeyValueList](#section-layout).

### DataTable

`DataTable` is the only table implementation. It combines a TanStack Table column model with
cursor-based loading and `virtua` row windowing once a list exceeds 250 rows.

- Columns declare a fixed `size` or a `minSize` that may grow. A name column sets `minSize` (nodes,
  users, model providers, schedules); a time column uses the width measured by
  `useTimeColumnWidth`, and a command, path or URL is the kind of long free text that may
  truncate. A column with neither shares the remaining width above a small floor (12 rem below
  `md`, 48 px above it).
- The table's minimum width is the sum of fixed sizes, minimum sizes and the floors of free
  columns. When the viewport is narrower, header and body scroll together inside
  `data-table-scroll` instead of clipping the last columns.
- Every cell is truncated to its track and carries a `title` with the full text, either its string
  value or a `meta.title` function for a cell whose rendered text differs from its value.
- `density="compact"` shrinks cells and the header for a table nested in a card, dialog or another
  table. `frame={false}` removes the table's own border when the parent already draws one. A
  full-page list passes an `EmptyState` with `bare` as `empty`, so the empty block sits inside the
  table's border; a detail-page section table passes `TableEmpty`.
- Body rows have a minimum height of 40 px (32 px compact) and the header 32 px (28 px compact).
  The row grid centres its items; cells keep only horizontal padding (`px-3`, `px-2` compact) and
  a small vertical padding, so an `xs` button (h-6), an icon-xs copy button, a select or a switch
  fits the fixed row height. Monospace values use `MONO_CELL`, whose 20 px line box matches
  `text-sm`. The row's real link is block text and does not add height.
- The header and body are ARIA rows in a `role="table"` with an accessible label; a row link's
  button or link is the keyboard and new-tab target.

### Section layout

A detail page is a sequence of sections. A table section uses `SectionHeader`: `SectionTitle` on
the left and the section's action buttons on the right (an outline `sm` button with `PlusIcon`,
for example **Add member** or **Add access**), immediately followed by its `DataTable`. An action
is never placed below the table or below an empty state.

A detail page's section table passes `TableEmpty` as `empty`: one small muted line inside the
table's own border ("No user groups", "No node access", "No members", "No access grants", "No
sessions yet", "No tasks yet", "No runs yet"). The read-only sections (a user's Recent sessions
and Recent tasks, a node's Recent tasks, a schedule's Run history) use the same component. There
is no icon-and-title `EmptyState` inside a detail section and no message outside the table.

`KeyValueList` shows a record's fields as a two-column grid with `items-start`: labels are muted,
values use the normal foreground, and both use a 20 px line box (a monospace value uses
`MONO_CELL`). Labels and values therefore centre on the same line without the baseline shift that
made small values sit lower and grow the row. A value that is a control (a Select, Button or
Switch) sets `control: true` on the item, which vertically centres that label/value pair against
the control. User groups, members and shared objects use `DataTable`, not a chip list.

Empty states use `EmptyState` for a whole page or a list page's whole table, `EmptyHint` for a
one-line hint inside a section ("No subagents", "The node trusts nobody"), and `TableEmpty` inside
a detail-section table. These short hints do not end with a period. Loading uses `PageSkeleton`
inside `Page` for a whole page, `DataTable`'s spinner for a table body, and `Spinner` inline or in
a popover; the UI has no "Loading…" text. A failed query uses `ErrorState`, a form or card error
uses `ErrorText`; pages render both inside `Page`, keeping the normal width and padding.

### Tables

Every list is a `DataTable`. Detail-page member tables, an approval's rule chain, an
authorization's task table, file listings, node access grants, a node's trust entries, an SSH
route, a provider's models and a model's thinking levels use it too; no page hand-writes a
`<table>` or uses the raw ui `Table`.

The table inventory:

- tasks: Created, Task (summary with a Privileged badge), Node, By, Status, Outcome;
- task-group members: Node, Status, Outcome, each row linking to its task;
- users: Username, Display name, Kind, Status, Created;
- user groups (under the users page) and a user's memberships: Name/User, Members/Role,
  Status, Created where relevant;
- a user group's members: User, Role, Status, Remove;
- nodes: Name (with an SSH badge), Status (with clock and trust indicators), Hostname, OS, Node
  groups, Last seen, and an administrator's Approve/Reject actions;
- node trust entries: Name, Role, Format, Kinds, Flags, Max TTL, Key;
- an SSH route: Hop, Address, Pinned host key;
- node access and user node access: Target (with a Node/Node group badge), Created, Remove;
- providers: Id, Kind, Name, Base URL, API key (Set/Not set), Status, Models, Edit/Delete;
- API tokens: Name, Rule preset, Created, Expires, Last used, Status;
- authorizations: Created, Issuer, Nodes, Command, Deadline, Tasks; the stored payload opens in a
  wide dialog;
- audit: Time, Action, By, On behalf of, Target, with the event detail in a wide dialog
  ([Access control](access-control.md#audit)).

Column titles are consistent: a time column is **Created**, never "Added"; an actor column is
**By**, and the audit log uses the same word. Removing one row uses `XIcon`; deleting a whole
object uses `Trash2Icon`; a warning triangle and an expand chevron are `size-3.5` in the same
context.

### Warnings

`WarningBanner` is the one warning block: `rounded-lg border border-warn/30 bg-warn-bg px-3 py-2
text-sm text-warn`, an optional warning triangle, and `role="status"` by default (or `alert` when
the caller needs an immediate announcement). Pages use it instead of a page-specific coloured text
line. The schedules page uses it when a schedule has no model, the session list when no model is
configured, and the token dialog for a token that never expires and for a Yolo token.

### Forms

Forms use `react-hook-form` with a `zod` schema and the shared field wrappers (`TextField`,
`TextareaField`, `SelectField`, checkbox and switch fields). `FieldShell` owns the label,
description and inline error line. Native constraint validation is off; the schema is the only
validation, and its messages appear under the field or in the dialog's error line.

`FormDialog` wraps a form: a fixed header and footer with the fields scrolling in a
`DialogScrollArea` inside the rounded popup. `busy` disables the footer and marks the submit button
`aria-busy`; `submitDisabled` holds the submit button back separately. A create/edit dialog's
buttons are **Cancel** and its action (**Save**, **Create**, **Run**); an information-only dialog
closes with **Close**, never "Done". Destructive confirmation uses `ConfirmDialog` and names the
object and the consequence.

Dialogs have two widths: the default (`sm:max-w-sm`) for forms and confirmations, and
`sm:max-w-2xl` for anything that shows code, a payload, JSON or a table (an authorization
payload, an audit event, a rule set, a trust fragment, a provider, a model, the SSH wizard, a
tool call, the session search). Every footer uses `DialogFooter` (directly or through
`FormDialog`/`ConfirmDialog`), never a hand-written `flex justify-end gap-2`.

Creation entries read **New X** (New user, New schedule, New token, New node group, New SSH
credential, New user group, New provider, New node, New SSH node, New model; Chinese 新建 X).
They use the default button size; a secondary creation entry uses the outline variant with
`PlusIcon`.

`EntityPicker` is the one searchable user, user-group, node or node-group control. Its trigger
looks like a Select and its popup has an auto-focused search box. `kind` is `user`, `userGroup`,
`node`, `nodeGroup`, `directory` (users and user groups) or `nodeTarget` (nodes and node groups).
A mixed picker badges every row with its type; `nodeTarget` queries both endpoints and resolves
selected ids through both `ids=` lookups. Single mode takes `value: string | null`; multiple mode
takes `string[]`, shows selected values as secondary badges with an X below the trigger, and keeps
the popup open while more are picked. Search is debounced by 200 ms, always requests `limit=50`,
and shows "More results — keep typing to narrow down" when `more` is true. Selected labels are
resolved by `ids=` and cached by id, so a selected value outside the current result window still
shows its name. `exclude` hides existing members or grants; `includeDisabled={false}` limits a
caller that needs only active users or nodes. Up/Down/Home/End/Enter/Escape are supported, and Base
UI's Combobox provides the combobox/listbox ARIA roles. Because every selector uses this control,
pages never download a full entity list; the 50-result cap also means no virtual list is needed.

### Cards

`Panel` is the one bordered block: `rounded-lg border p-4`. Pages do not mix `Card`, `rounded-xl`
and per-page padding for the same kind of block. The task page, the approval, authorization and
quota cards, the model preset cards, the schedule forms and the credential forms all use it.

Decision cards are shared by the session page, the approvals page, the task and task-group pages:

- `ApprovalCard` shows the subject, whether it is privileged, the command or path, who asked, the
  request time, and the rule chain that produced the decision. Its evaluation table has four
  columns: **Level** (scope type and id), **Matched rule** (the rule as stored, or **Default**),
  **Rule result** (own result), and **Cumulative result** (effective result). A rule result is
  **Allow**, **Deny**, **Require approval** or **Inherit**, coloured by its tone. The card offers
  **Approve**, **Approve and always allow…** and **Reject**; a rejection may carry a reason. The
  always-allow form builds a rule from the operation's exact or prefix form and submits it as
  JSON after client-side parsing.
- `AuthorizationCard` shows the decoded payload, a Passkey button for each matching credential,
  the equivalent `crha grant` command, an `ssh-keygen` recipe, and a paste box for the signed
  output. It reports success or the server's error inline.
- `QuotaCard` names the paused session and level, shows the remaining budget, offers a token
  amount to add, and **Stop**. Its numbers use the budget measure (output tokens), not the usage
  statistic.

### Shared components

The shared inventory, in addition to the table, section, warning, form and card components above:

- Layout: `AppShell`, `Page` (full-width list page or `detail` column), `PageHeader` (title,
  one-line description, actions), `SectionHeader`/`SectionTitle`.
- States: `EmptyState`, `EmptyHint`, `TableEmpty`, `ErrorState`, `ErrorText`, `PageSkeleton`,
  `ListSkeleton`, `CardSkeleton`, `Spinner`.
- Data display: `StatusText`, `StatusDot`, `StatusBadge`, `RelativeTime`, `DateTime`,
  `NodeLastSeen`, `CopyButton`, `CodeText` (monospace, collapsible long output), `KeyValueList`,
  `DataTable`, `UserLink`, `NodeTargetList`, `SessionMarkers`.
- Inputs: `ModelSelect`, `RulePresetSelect`, `ThinkingLevelSelect`, `EntityPicker`,
  `TaskFormFields` (exec, file.read, file.write, file.list, shared by the Run task dialog and the
  rule test), `ShareEditor`.
- Tasks: `TaskResult` (facts, rule-chain evaluation, output and structured file result),
  `TaskSummary` (one compact row), `TaskOutput`, `TaskFacts`, `TaskEvaluation`, `TaskOutcomeText`.
  `TaskResult` is used by the session's tool dialog; the task page composes the same parts itself.
  Output is one stream; a `notice` from `crhs` is shown above it, not mixed into it.
- Markdown: `SafeMarkdown`, `CodeBlock`.
- Dialogs: `ConfirmDialog`, `FormDialog`, `DialogScrollArea` (bleed and inset padding keep the
  focus ring and the scrollbar off the content). `ToolDialog` shows a tool call's arguments, live
  output, result, task result and subagent link; it has no description and no inline expansion.

A task's state is **Finished** for `exited`; a successful non-exec task shows **Succeeded** in the
Outcome column while an exec task shows its exit code. These labels come from the same components
everywhere.

### Task and task group pages

The tasks page is a cursor-paged table of the tasks the caller may see (administrators see every
task; everyone else sees their own). Its header has one primary action, **Run task**, which opens
the dialog of that name. The page filters by **State**, **Actor type** and **Node**; `?node=` and
`?user=` open it pre-filtered.

- The Run task dialog's target control is the only multi-select `nodeTarget` picker, labelled
  **Nodes or node groups**; nodes and node groups are mixed, each with its type badge. A separate
  **All nodes I can access** checkbox disables the picker and overrides its value. There is no free
  text target field.
- The dialog only submits: one selected node creates a single task and opens `/tasks/$taskId`;
  a selected node group, two or more targets, or the all-nodes checkbox creates a task group with
  `POST /task-groups` (targets by name, `_all` for every node) and opens
  `/task-groups/$taskGroupId`. With no target the dialog says "Choose at least one target." in
  place; task-field validation errors appear there too. On success it closes and opens the new
  task or group; it does not show a result.
- **More options** is collapsed by default and holds the parallel count, fail-fast and, for an
  exec task, the output mode (status only or tail of output). These apply to a task group only; a
  single task does not send them.
- The node detail page has no run panel. The `/batch` route redirects to `/tasks`, and the
  sidebar has no Batch item.

The task page's title is the task summary in monospace, wrapped to at most two lines with the full
text in a tooltip. The status sits below it, and when there is a result it is appended after
" · " (for example "Finished · Exit code 3", "Finished · Timed out", "Finished · Cancelled",
"Finished · Succeeded"). A running task or one without a result does not append anything. A
running task shows **Stop task** for an administrator or the task's `on_behalf_of` user. The
shell's top bar shows the same summary on one line, truncated,
instead of "Tasks"; the browser tab is that summary followed by `· ClusterRightHand`. The page then
shows a facts panel, an approval or signature card when the task waits, the recorded decision, a
collapsible **Rule chain evaluation**, and a result panel when there is output or a structured
result. **All tasks** is the back link.

`/task-groups/$taskGroupId` uses the task group's command or summary as the page title, in the same
monospace style, with the state on the next line. The member table (Node, Status, Outcome, each row
linking to its task) has no "Result" heading, no Privileged badge, no node count, no repeated
command line and no "Targets:" line. The skipped or interrupted explanation is one short line
below the title; approval, signature and rejection cards stay between the title and the member
table. `usePageTitle` supplies the shell and browser title for both pages.

A task and a task group have one title source: `taskTitle(task)` in
`web/src/features/tasks/title.ts`, which returns the summary and falls back to the kind. The task
page, task-group page, shell title, task tables, approval lists and a node's recent tasks all use
it.

A node's **Recent tasks** section lists the newest 10 (`GET /nodes/:id/tasks` caps at 10). The
**View all tasks** link at the right of its heading opens `/tasks?node=<nodeId>`.

The tasks page URL accepts `?node=` and `?user=` as strings. The node select initialises from
`node` and writes changes back with `replace`; `user` has no separate control, so the filter row
shows "User: <name>" with a clear button. Both values pass directly as `nodeId` and `userId` to
`GET /tasks`.

### User and user group pages

`/users` is administrator-only. The table shows username, display name, kind, status and creation
time; kind is plain text, with no in-row type select, disable, password reset or actions column.
**New user** stays in the page header and the whole row links to `/users/$userId`.

`/users/$userId` (`UserDetailPage`):

- The header shows the display name, or the username when it is empty; the back link is
  `ArrowLeftIcon` plus **All users**. The facts are username, display name, role, status
  (`StatusText`) and creation time (`DateTime`).
- An administrator changes the role in the facts row, disables or enables the account (disabling
  asks for confirmation and cannot target the administrator's own account), and resets the
  password. A member can open only their own page and sees no edit control.
- **User groups** is a `DataTable` of group name and member count; a row links to
  `/user-groups/$userGroupId`. The member count is shown only when the administrator-readable
  group list is available, otherwise the cell shows an en dash. An empty table shows `TableEmpty` "No user
  groups". For an administrator the heading has **Add to user group** (outline `sm` button with
  `PlusIcon`): a `userGroup` picker that excludes groups the user already belongs to, submitting
  to the add-member endpoint. Every row also has **Remove** (`xs` outline with `XIcon` and the
  visible label), which confirms and then removes the membership and refreshes the page.
- An administrator sees a **Node access** table with the grants held by `user:<id>`. The target
  name carries a **Node** or **Node group** badge (`Badge variant="secondary"`); a node links to
  `/nodes/$nodeId`, a node group to `/node-groups/$nodeGroupId`, and the creation time uses
  `DateTime`. Each row has an outline `xs` **Remove** with `XIcon`, confirmed before the grant is
  deleted. **Add access** by the heading opens a dialog with the `nodeTarget` picker (node and
  node-group badges, existing grants excluded); the grantee is the current user. An empty table
  shows `TableEmpty` "No node access". A member does not see this section, because the grant list
  is administrator-only.
- **Recent sessions** and **Recent tasks** are two `DataTable`s that take only the first page (10
  rows each). Sessions use `scope=all&ownerId=` for an administrator or `scope=visible&ownerId=`
  for the member, with `limit=10`; tasks use `userId=` and `limit=10`. Rows link to the session
  and task pages. The tasks section links **View all tasks** to `/tasks?user=<userId>`; the
  session list has no owner filter, so it has no equivalent link. Times use `RelativeTime`. An
  empty table uses `TableEmpty` ("No sessions yet", "No tasks yet"), not a block `EmptyState`.
- A missing user and a user the viewer may not see produce the same `ErrorState`: "This user
  doesn't exist or you don't have access."

`/user-groups/$userGroupId` (`UserGroupDetailPage`):

- The back link is **All users**. The page shows the name, the creation time and a **Members**
  section with **Add member** at the right of the heading (a dialog with a user picker). The
  `DataTable` lists the user (the whole row links to `/users/$userId`), role, status and
  **Remove** (outline `xs` with `XIcon`, confirmed before the member is removed). An empty table
  shows `TableEmpty` "No members".
- An administrator also sees the same **Node access** table for `user_group:<id>`, with the
  Node/Node group target badges and a confirmed **Remove** per row. **Add access** grants a node
  or node group to the group through the `nodeTarget` picker.
- The page header keeps only rename and delete; deleting asks for confirmation and returns to the
  users page. A rename uses the creation name rules; the server validates and audits it.

`/node-groups/$nodeGroupId`:

- The header keeps only rename and delete. The **Members** section has **Edit members** at the
  right of the heading (the existing member dialog). The table lists the node (the row links to
  `/nodes/$nodeId`), status and hostname; an empty table shows `TableEmpty` "No members".
- The **Access** section lists grantees (their name carries a **User** or **User group** badge),
  creation time (`DateTime`) and an outline `xs` **Remove** with `XIcon` (confirmed). **Add
  access** is the outline `sm` action at the right of the heading. Its dialog has no Type select:
  a `directory` picker lists users and user groups with type badges, and the selected item's kind
  decides the grantee type. An empty table shows `TableEmpty` "No access grants".

The users page's lower section is a read-only user-groups `DataTable` (name, member count,
creation time) whose rows link to the group page. **New user group** is that section's page-level
primary action (default size with `PlusIcon`), opening a dialog for the name. Member editing,
renaming and deletion happen only on the detail page.

### Node pages

The nodes page lists every node the caller can see, with the columns Name (and an **SSH** badge),
Status, Hostname, OS, Node groups and Last seen. Status folds enrollment and reachability into one
`StatusText`: pending reads **Pending approval**, an active client reads **Connected** or
**Offline**, and an active SSH node reads **Active**; the tooltip keeps the raw state and the
connection detail. A measured clock warning shows a warning triangle and **clock** beside the
status, with the full sentence in its tooltip. A trust-warning chip follows the same pattern. Last
seen uses `NodeLastSeen`. An administrator sees Approve/Reject for pending nodes and two page
actions, **New SSH node** (outline) and **New node** (primary).

- **New node** creates a one-time enrollment token and shows the command to run on the node as the
  user `crha` will run tasks as. The token is shown once and its expiry is displayed; the node
  appears as pending until an administrator approves its key fingerprint. The dialog says the
  config and state paths are a suggested layout.
- **New SSH node** opens a four-step wizard: choose a credential, describe the route (jump hosts,
  then the target), pin every host key, then create the node. It opens the new node's page on
  success. The route and credential are administrator data; the server omits them for other
  viewers. The wizard follows [Adding an SSH node](execution.md#adding-an-ssh-node).
- Approving or rejecting a pending node asks for confirmation; the node list is the only place
  with those row actions.

A node's detail page (`/nodes/$nodeId`) has the name as its title, the status, an SSH badge for an
SSH node and a clock warning below it, and **All nodes** as the back link. An administrator also
gets **Edit node groups**, **Rename** and **Delete node** in the header; deleting asks for
confirmation and returns to the node list. Trust-warning chips appear above the facts.

- The facts are transport, hostname, OS, privileged mode (`ignored (SSH)` for an SSH node), node
  groups, and for a client node the client version, last seen and key fingerprint; the node's own
  clock warning and the node id follow. A collapsible **Facts (N)** block shows the raw facts
  collected from the node.
- **Trust** (client nodes): the last report's status, message, digest, update time, aliases, the
  `Authorization clock tolerance` (the configured `clock_skew` used when checking an
  authorization's `issued_at`/`deadline`, not a measured offset), and the unprivileged and
  privileged identities. The report is the node's trust cache
  ([Privilege](privilege.md#trust-cache)); the measured clock offset is the only value taken from
  the connection ([Privilege](privilege.md#clock)). Report status labels are **OK**, **Unavailable**, **Not applicable** and
  **not reported**; a stale report is marked as the last report until the node reconnects. When
  the status is `not_forward` the hint says the privileged mode is not forward, so the node uses
  no trust configuration; `unavailable` says the privileged mode is unreachable, so the trust
  configuration is unknown; otherwise the node has not reported it. The trust-entry table (Name,
  Role, Format, Kinds, Flags, Max TTL, Key) is followed by one expandable block per entry with its
  allow/deny guard rules, environment and public key. With no entries the hint is "The node trusts
  nobody". The measured clock offset is shown only by the status warning, never here.
- The trust configuration editor builds a `[[trust]]` fragment for the node's `privileged.toml`;
  the node enforces it and the page only exports it. When the node has node groups and forward
  mode, an **Aliases for privileged.toml** block offers the top-level `aliases` line with a copy
  button. An administrator also sees the crhs signing-key panel.
- An SSH node shows its route as a table (Hop, Address, Pinned host key), its credential and a
  **Test connection** button. The hop rows name **Target** and **Jump host N**.
- **Node access** lists the grants targeting the node; **Recent tasks** lists the newest 10 with
  a **View all tasks** link to `/tasks?node=<nodeId>`.

### Approvals page

The Approvals page collects everything that waits for the signed-in user. The sidebar badge and
the page count include task approvals, task-group approvals, tasks and task groups waiting for a
signature, and roots whose token quota is used up. A waiting task group counts once, not once per
member.

The page has four sections, each absent when its list is empty:

- **Task approvals**: tasks held back by a rule. One decision applies to one task.
- **Task-group approvals**: one decision applies to every node in the group. The card shows the
  rule chain per node where the group's approval recorded one.
- **Waiting for your signature**: tasks and task groups that passed their rules and run after the
  owner signs. Each row links to its task or task group and names the node or target list. The
  waits expire after 24 hours and the end of the session also ends them
  ([Privilege](privilege.md#waiting-for-signatures)). Signing uses a Passkey or the pasted output
  of `crha grant`, as shown by `AuthorizationCard`.
- **Token quota used up**: one `QuotaCard` per paused root, where the owner adds tokens or stops
  the run.

Decisions go through the shared cards and mutations, so the sidebar badge and the page refresh
together. With nothing pending the page shows an `EmptyState`: "Nothing is waiting for you".

`/approvals/tasks/$taskId` and `/approvals/task-groups/$taskGroupId` are the deep links returned by
MCP and agent tool results. The page shows the approval card while the subject still waits;
otherwise it shows "Already settled", the subject's status and a link to open the task or task
group. **All approvals** is the back link.

### Models page

Model settings are administrator-only. The page shows the three model presets first and the
providers after them.

- **Model presets**: one card each for Session, Auto review and Title generation. Auto review and
  title generation choose a model (including **Use the session's model**); auto review also
  chooses a thinking level. All three edit a system prompt, where an empty value means the built-in
  default; a read-only block shows that default prompt and the fixed protocol note. Saving a card
  updates the preset ([Agent runtime](agent-runtime.md#model-presets)).
- **Providers**: a `DataTable` with Id, Kind, Name, Base URL, API key (**Set** or **Not set**),
  Status, Models, and Edit/Delete actions. **New provider** is the page action; **Edit** reopens
  the dialog; **Delete** asks for confirmation and explains that the provider's models disappear
  and its stored key is deleted.
- The provider dialog's kind is **Pi built-in** or **Custom**. A built-in provider selects one of
  pi-ai's providers and takes an API key and an optional Base URL; only API-key authentication is
  supported. A custom provider takes a Base URL, an API key, extra request headers (key/value
  rows, stored and shown in plaintext, not for secrets) and session-id fields (request-header
  names and request-body dot paths). Its models are edited one by one in a nested dialog: id,
  display name, protocol (**Chat Completions** or **Responses**), context window, maximum output
  tokens, image understanding, thinking (not supported, standard or custom), and a `compat` JSON
  object validated against the protocol with the failing field path marked. Standard thinking
  selects a format and maps each level; custom thinking takes per-level JSON. Every thinking level
  has a display name that defaults to the level id and can be hidden by clearing it, except `off`,
  which cannot be hidden. The API key is never prefilled; changing a custom provider's Base URL
  requires re-entering its key.

The same model list feeds the composer and the presets, so a provider or model that is removed
stops appearing in both.

## Session interface

The Sessions route is a two-column section: the virtualised session list on the left and the
routed page on the right. The list column is 18 rem wide. At `lg` and above the list and the page
are shown side by side; below `lg` the navigation sidebar, list and page do not fit, so a
session-shaped page (`/sessions/new` or `/sessions/:id`) takes the main view and the list is one
back step away. The `/sessions` index renders the draft page, which is session-shaped but not a
session: at `lg` and above the list and the draft are shown together; below `lg` the list is the
main view and the draft is hidden. The back button on the draft and on a session returns to
`/sessions`, which is the list on a narrow screen.

### Sidebar list

The session list is a `virtua` virtual list with cursor-based infinite loading. It shows only the
root sessions the caller can see: the caller's own roots plus roots shared with them
(`scope=visible`). An administrator sees the same union, not an "all" view.

- At the top is a full-width button that looks like a search field (magnifier, "Search sessions…",
  `⌘K` or `Ctrl K`); it opens the session search dialog. Below it is a full-width **New session**
  button and then the grouped list. The New session button opens `/sessions/new` and calls no
  API; pressing it while already on the draft does nothing.
- There is no in-list title filter and no filter input; all searching happens in the dialog. There
  is no horizontal rule in the list, only the vertical border between the list and the session
  area.
- A row shows only its title, on one line, truncated. A null or blank title shows the translated
  **New Session**; the default is not written to the database. The owner and relative time are not
  shown. Sessions started by a schedule and sessions shared with the viewer carry a grey
  **Scheduled** or **Shared** badge at the right end of the row; the shared badge's tooltip names
  the owner. The session header shows the same badges. The row's tooltip is the waiting kind
  ("Waiting for approval", "Waiting for a signature", "Waiting for a quota decision").
- The leading slot holds one indicator, in this priority: a running session spins a 12 px muted
  `LoaderCircle` labelled **Running**; an awaiting session shows the amber status dot; an idle
  session with unread output shows the blue dot labelled **Unread**; otherwise the slot is empty
  but still reserved, so titles align.
- Unread is computed for the owner only: the root's `reply_at` is later than `owner_read_at`, or
  `owner_read_at` is null. A session shared with someone else is never unread for the viewer.
- Rows are grouped by `updatedAt` (the list is already sorted by it): **Today**, **Yesterday**,
  **Within 7 days**, **Within 30 days**, then the local-time month (`2026-09`). Group headings are
  ordinary rows interleaved in the virtual list, so loading another page or patching a row
  re-groups the list. Up/Down move between items and skip headings.
- Up/Down, Home, End and Enter work on the list; focus is roving, so only the active row is a tab
  stop. The list has a `listbox` role and an accessible name.
- Changes arrive over `GET /api/sessions/stream?scope=visible`. The list does not show a session
  count and has no scope switch.

### Session search

`Ctrl+K` or `⌘K` opens the session search dialog from every authenticated page, and the list's
search button opens it too; the shortcut is intercepted so the browser's own find shortcut does
not run. The dialog is wide (`sm:max-w-2xl`), its search input is focused, and the result area
scrolls on its own.

- Input is debounced by 250 ms and sent to `GET /api/sessions/search?q=&scope=&cursor=&limit=`.
  The scope is the list's `visible`; keywords are separated by whitespace.
- Results load one cursor page at a time; scrolling to the bottom fetches the next page.
- Each root session is a group: its title (keywords are highlighted when `titleMatch` is true),
  owner, relative update time and status text. Up to three hit rows follow, each with the role
  (**You** or **Assistant**, and **Subagent: <title>** for a hit in a child), the relative time and
  a snippet where every keyword is marked with a subdued `<mark>`. When `hitCount` exceeds the
  shown hits, a grey row reads **N more matches**; clicking it opens the session, not another
  request.
- With `contentSearch: false` (SQLite), results match titles only and the dialog adds no further
  notice.
- States: an empty input shows "Type keywords separated by spaces"; loading shows a spinner; no
  results and a failed request each have their own message (`ErrorText` for the failure).
- Up/Down move between session headings and hit rows, Enter opens the active row, Escape closes
  the dialog; the mouse works the same way. The input is a combobox with
  `aria-activedescendant`; the result area is a listbox of options.
- Opening a session heading (or **N more matches**) goes to `/sessions/$sessionId`. Opening a hit
  goes to `/sessions/$hitSessionId?entry=<entryId>` and closes the dialog.

### Message view

The transcript is a `virtua` list with `shift` for prepends and an explicit anchor correction: it
records the first visible row and its viewport offset before requesting an older page, then
re-aligns that row after the new page is measured. This keeps the reading position within 2 px
even though `shift` alone would drift by a few dozen pixels while rows are measured.

- While the reader is at the bottom, new content and streamed text keep the view pinned. Scrolling
  up stops following immediately (a wheel or an Up/PageUp/Home key is enough, before the scroll
  event arrives) and shows a round **Jump to latest** button in the bottom centre; the button
  uses `--background` and a border to stand out from the content. Pressing it resumes following.
- When the final answer starts streaming, the process of that turn (thinking, tool calls,
  intermediate text) folds into one line above the final output: **Ended in <duration>**, with a
  bottom border and a chevron immediately after the text. The line starts collapsed, leaving the
  user input and the final answer. The duration ticks every second while the answer streams and
  stops when it ends.
- The duration comes from entry timestamps: while streaming it is the current time minus the
  user message's `timestamp`; after the end it is the final assistant entry's
  `timestamp + durationMs`. A transcript entry without those fields is not folded. The minimum
  shown duration is one second.
- Expanding the line shows the process in its original order. The last turn before the final
  answer starts streaming stays expanded, and a turn whose process contains an error is never
  folded.
- A completed compaction is a collapsible **Context compacted** row (its first line is the
  preview). It stays in commit order around the turn it belongs to and is never hidden by a turn's
  fold. A compaction in progress is a **Compacting context** row at the end of the transcript; the
  Stop button stays available.
- Every rendered row carries `data-entry-id` (all blocks of one assistant entry share the entry
  id) for scroll positioning and highlighting.

### Jumping to a message

A session search hit opens the session with `?entry=<entryId>`. The page finds the first rendered
row whose entry id matches, scrolls it to the centre and marks it with a yellow highlight for
about 2 s. If the entry is not in the snapshot or in an already loaded history page, the page
loads older history pages (up to 20) until it finds the entry or the history cursor ends. If the
entry is inside a folded turn, that turn is expanded first so there is a row to scroll to.

If the entry cannot be found within the 20-page budget, a toast says "Couldn't find that message
in this session." In both cases the page then removes `entry` from the URL with `replace`, so a
reload does not jump again. The route validates `entry` as a non-negative integer and drops
anything else.

### Session header

The header is the title, its breadcrumb and badges, and one share button; it has no bottom
border. The title is inline-editable by a caller with `capabilities.configure`; a blank edit
clears the title and stops title generation, so the default name appears. A subagent shows a
breadcrumb from **Sessions** through its ancestors; a root session has no breadcrumb, because its
title is already the page title. The grey **Scheduled** and **Shared** badges match the list. A
caller with `capabilities.manageShares` gets the share button.

Below the header there is at most one single-line banner. Its priority is: connecting/reconnecting
(muted), failure (danger, `role=alert`), retrying after an error (muted), waiting reason
(approval, signature or quota; warn), queued messages (muted). Nothing is shown while a run is
merely active; there is no "working" line.

- The waiting reason describes this session's own state, not the whole tree; the session list
  shows the tree's aggregate.
- The stop button in the composer can stop a root session while any session in its tree is
  running: the server stops the whole subtree. A subagent page follows its own state.
- Waiting cards appear on the root session page and list the approvals, signatures and quota waits
  of the whole tree. The waiting area sits below the one-line banner and above the messages, with
  no bottom border, close to the header. Decisions use the same cards and mutations as the
  Approvals page, so the header badge and that page update at once.

### Composer

The composer is one rounded box with the text area and the footer inside it; a separate line
below the box shows context and usage.

- The text area supports `/compact [instructions]`: it calls `POST /api/sessions/:id/compact` and
  does not send a message. The finished summary is shown as a compaction row. Typing `/` opens a
  completion popup above the input (Up/Down, Tab or Enter completes, Enter on the complete command
  runs it, Escape closes); a complete command shows its description below. The command registry is
  `web/src/features/sessions/slash-commands.ts`; only the exact name counts, so `/compactor` is an
  ordinary message.
- The text area has no border of its own; the outer container draws the rounded border and focus
  ring. It grows with its content from one line up to half the transcript pane's height, then
  scrolls. The portrait resize handle is not used.
- Enter sends and Shift+Enter adds a line. The send is disabled when there is nothing to send or
  the caller lacks `capabilities.chat`; a viewer without chat access sees one read-only line and
  no composer.
- A send carries a `requestId` generated for the attempt. A retry after a lost response keeps the
  id, so the server deduplicates it; a successful send or a new draft clears it.

The footer's left side has four controls:

1. **Model**: the model's display name (its `name` from the model list, or `modelId` when it is not
   listed). The tooltip holds `provider/modelId` and says the change applies from the next turn.
   Clicking expands a provider-grouped model list; picking one sends `PATCH /sessions/:id { model }`
   without `thinkingLevel`, so the server keeps the level and moves to the nearest supported one
   when the new model cannot use it. The change is written to the conversation and applies from
   the next model request; the turn in flight keeps the model it started with.
2. **Thinking level**: follows the model (for example a light bulb and `high`). It lists only the
   current model's `thinkingLevels` from `/api/models`; it is hidden when the only level is `off`.
   Picking one sends `PATCH { model: { provider, modelId, thinkingLevel } }` and also applies from
   the next turn.
3. **Rule preset**: **Ask**, **Auto Review** or **Yolo** with the matching shield icon. Clicking
   expands the three presets directly; picking one sends `PATCH { rulePreset }`. Only a root
   session has a preset; a subagent shows the read-only count **Rules: N** (or **No rules**). A
   preset change is written to the rule set and applies from the next tool call, and the server
   immediately re-evaluates waiting approvals. Without `capabilities.configure`, the model and
   rule controls are read-only and the waiting query parameters are read-only too.
4. **Budget**: remaining tokens in an automatic unit. With no limit it shows ∞ and the tooltip
   **No budget limit** (never "unlimited quota"); at or below zero it shows `0` in the danger
   colour. A caller who may configure the session can click it to open the quota dialog.

The right side has one icon button: an up arrow to send or a square to stop. While a run can be
stopped and the input is empty, the button is Stop; otherwise it is Send, including while a run is
active when the input has text (the message is queued).

Below the box, one centred line shows three items, left to right (definitions are in
[Agent runtime](agent-runtime.md#session-statistics)):

- **Generation**: `<turns> turns <steps> steps · <rate> tok/s`. Turns and steps come from
  `SessionView.stats.turns` and `stats.steps`; the rate is shown only when `decodeMs > 0` and is
  `decodeTokens / (decodeMs / 1000)`, rounded to an integer from 10 up and to one decimal below
  10. The whole item is hidden while `steps` is 0. Its tooltip holds the average time to first
  token (`ttftMs / ttftSteps`, omitted when `ttftSteps` is 0) and the decode speed.
- **Usage**: the tree's `usageTokens` in an automatic unit, then the cache-hit percentage when
  `promptTokens > 0`: `cacheReadTokens / promptTokens`, floored to an integer, never shown as 100
  unless the read covers the whole prompt. The tooltip holds the exact total and
  `Cache hit: <read> / <prompt>`.
- **Context**: a small ring and a percentage, for example `◔ 42%`. The percentage is
  `contextTokens / contextWindow` from the model list; the item is hidden when either value is
  unknown, and turns warn-coloured at 90% or more. The tooltip is the exact pair.

The footer does not hide items by width: the budget always shows, the model and rule labels
truncate with the full text in the tooltip, and Send/Stop never shrinks or hides. The meta line
wraps on a narrow screen. The 390, 768 and 1440 px widths are asserted in the e2e suite.

### Subagent bar

A rounded strip directly above the composer shows the direct child sessions; with no children the
strip is absent. It is the composer's width, has no border or shadow, and sits about 4 px above
the composer.

- It shows one compact line: `<n> subagents`, then `<n> running` and `<n> awaiting` when those
  counts are non-zero. Counts are of the direct children by their own state, not the tree
  aggregate, and there is no chevron at the right.
- The counts come from `GET /sessions/:id/children/summary`, so showing them does not load every
  child page.
- Clicking opens a popover (a bottom sheet on a narrow screen) with the subagent tree: each node
  shows its state and title and links to the child session. A nested level is fetched only when it
  is expanded.
- Each level is a `/sessions/:id/children` cursor page with its own **Load more**.
- The page refetches the child list and counts on three events: its session stream's `snapshot`,
  the `subagent` tool's `tool_execution_update` or `tool_execution_end`, and an `upsert` for the
  tree's root on the session list stream.

### Streaming output

The text being generated lives in a per-row external store, not in React state. The SSE writer
calls `setText` as often as deltas arrive; the store publishes on the next animation frame, so a
fast stream does not produce one render per character. Rows subscribe with
`useSyncExternalStore` (`useStreamingText`), and the transcript list itself re-renders only when
the number of items changes.

A committed message keeps the same row and store after `message_end`; the renderer switches from
the live text to the committed text in place, so its incremental Markdown tree is not discarded.
A tool call's live output has its own store in the same registry.

### Message rendering

- Assistant text and thinking render through SafeMarkdown. A user message shows its raw text in a
  right-aligned primary bubble.
- A tool call is a borderless button: a status icon, then one line `name · node · subject`. The
  node is the raw `targets` or `node` input and is omitted when absent; the subject is the one
  argument that identifies the work (command, path, prompt or task id) and never an exit code or
  timing field. Clicking opens a dialog with the arguments, live output, result, task result and
  subagent link. It never expands inline; there is no chevron and no description in the dialog.
- Thinking is a borderless collapsible row with the chevron at the start, the same chevron as a
  tool call (right when collapsed, down when open). Its collapsed preview is the latest line while
  streaming and the first line after it ends; the preview is hidden when open. The label is
  **Thinking**.
- A completed context compaction uses the same row with the label **Context compacted** and the
  summary as its body; a running one is **Compacting context** at the end of the transcript.
- Tool and thinking rows keep a small vertical gap; a tool name has the same colour as its
  description until hover, when both and the icon go from muted to foreground. There is no
  background block on hover.
- Approval, authorization and quota waits are cards inserted in the transcript.
- A subagent is reachable from its parent and has a breadcrumb.

Tool rows use no badge; the leading icon is the only status signal:

- While a call has no result and may still return, the wrench is replaced by a spinning loader
  labelled **Running**. A call can still return while the page's session is `running` or
  `awaiting`, and while the task or task group it names has not ended.
- When it cannot return any more, the loader stops and the wrench is shown: the session is idle,
  or the task/task group has ended.
- A returned successful call shows the wrench. A failed call shows the same wrench in the danger
  colour, labelled **Failed** or with the specific reason (`Exit 2`, `Timed out`, `Cancelled`,
  `Partly failed`). Only the call's return matters for the icon: a background `subagent` call whose
  child is still running shows **Done**.
- The subagent's live state is not shown on the tool row; it belongs to the subagent bar and its
  popover.

A stopped card (no result, and none will arrive) follows the task or task group named by
`task_id` / `task_group_id` in the status details:

- It reads the task or task group every 5 s while spinning, and once more when it stops. It does
  not long-poll: one session can have many open calls, and each long poll would occupy one of the
  browser's few connections per origin. A call with a result is never queried.
- When the task reaches a terminal state, or the task group is `finished`, `interrupted`,
  `rejected` or `cancelled`, the card uses the task view's result: a failure is danger with the
  specific reason, otherwise the normal colour with **Done**.
- If the session becomes idle while the task has not ended, or no id is known, the result is
  unknown: normal colour, **No result**.
- `data-tool-status` is `empty` on a stopped card and `failed` when the followed task failed.
- The ids in the status details are pushed by the server before the first wait
  ([Agent runtime](agent-runtime.md#exec-tool-semantics)).

Failure means:

- the tool result itself is an error (`isError`);
- a returned call is judged from its result `details`, not from parsing the model-visible text and
  not with a live query; a result recorded without `details` falls back to its JSON text;
- a stopped call is judged from the followed `TaskView` / `TaskGroupView` with the same rules;
- a single task (`details` has `task_id` and `state`): `failed`, `denied`, `rejected` and
  `unknown` are failures; `exited` is a failure with a non-zero `exit_code`, a `signal`,
  `timed_out` or `cancelled` (a user cancellation counts as a failure);
- a task group (`details` has `task_group_id` and `nodes`): some failed members make it
  **Partly failed**; all members failing, or the group being `interrupted`, `rejected` or
  `cancelled`, is **Failed**;
- other results (a `read_file` without an exit code, `exit 0`, a task still `running`, a group whose
  members all succeeded) do not change the status and show no `exit N` text.

### New session

`/sessions/new` is a blank session page: no header and no title, with one larger line in the
middle of the transcript area, **What's on your plan today?**, and the composer with its footer
below it. The footer is the session footer fed from local state: model (the model of the last
created session from `localStorage`, falling back to the first available model), thinking level,
rule preset (default Ask) and budget (default unlimited).

- The draft does not support `/compact`: the command is not sent, and a hint says compaction is not
  available before the session exists. There is no stop button.
- One `requestId` is generated for the draft's lifetime. Sending calls
  `POST /api/sessions { requestId, model, rulePreset, budgetRemaining?, message }`. On success the
  page inserts the returned session into the session-list cache and navigates to
  `/sessions/$sessionId` with `replace`, so Back does not return to the draft. On failure it stays
  on the draft with the text and the same request id, and shows the error; a retry is
  deduplicated by the server.

## Markdown rendering

Assistant text and thinking are the only untrusted rich content in the UI. They render through one
subsystem that combines block splitting, incremental highlighting and a strict URL policy.

### SafeMarkdown

`SafeMarkdown` splits a message into top-level blocks with the `marked` Lexer and mounts
`react-markdown` once per block, so a growing message re-parses only its last block.

- Finished blocks are kept by their source text and are not re-lexed. An update starts the Lexer
  at the beginning of the previous last block. If the text is replaced rather than appended to,
  the memoised prefix is dropped and the document is split again.
- The last block's fenced code is detected directly, so an unclosed code block goes to the
  incremental highlighter without a Markdown parse.
- Reference definitions are collected across blocks and prepended to every block, so a link whose
  definition appears at the end of the message still resolves above it.
- While streaming, the last block's still-open constructs (an unmatched `**`, an unfinished link)
  are closed by `remend` before rendering; its result is memoised by source.
- A finished block's converted React element is cached by its full source (bounded, cleared as a
  whole), because a virtualised row that scrolls out and back in is a new component instance and
  `memo` alone cannot reuse it. The growing last block of a stream is not cached, so it does not
  evict finished blocks.
- A code block receives `complete`; a complete block keeps its tokenised lines for a later mount.

Security rules:

- Raw HTML is never rendered. `skipHtml` is on and no `rehype-raw` plugin is used; HTML in the
  source appears as text or is dropped.
- Link targets are limited to `http:`, `https:` and `mailto:`. The check strips ASCII whitespace
  and control characters (so `java\tscript:` cannot split a scheme), compares the scheme
  case-insensitively, and rejects relative, anchor and protocol-relative URLs. A rejected link is
  rendered as a span, so `a[href]` in the output can only be one of the three schemes. External
  links carry `rel="noopener noreferrer"` and open in a new tab.
- Images are never loaded: an image renders as a text link `[image: <alt>]`, so no request leaves
  the browser. An image with a non-allowlisted source is plain text.
- A code block renders only text nodes and highlight tokens; its copy button copies the original
  source.

### Code highlighting

- Shiki uses `createHighlighterCore` with the JavaScript regex engine, so there is no WASM or
  oniguruma asset. The GitHub light and dark themes load up front and are exposed as CSS custom
  properties (`defaultColor: false`), which lets one token stream serve both themes.
- The tokenizer is incremental per code block. Only newline-terminated lines are tokenised, each
  batch continuing from the previous grammar state; the trailing incomplete line is re-tokenised
  on every update from the same state. Replacing the code (rather than appending) rebuilds the
  block.
- `bash`, `shellsession`, `json`, `yaml`, `diff` and `ansi` prewarm during idle time. Every other
  language is a separate lazy chunk loaded on first use; until it arrives the block renders as
  plain text.
- Supported languages: bash, shellsession, json, yaml, diff, ini, toml, dockerfile, python, go,
  typescript, javascript, sql, nginx and ansi. Common aliases (`sh`, `zsh`, `yml`, `docker`, `py`,
  `golang`, `ts`, `tsx`, `js`, `jsx`, `postgres`, `postgresql`, `mysql`, `term`, `terminal`, `log`)
  resolve to those languages. An unknown language renders as plain text.

## Backend API

The WebUI is the only client of the session, task, audit and authorization list endpoints. The
wire types live in `packages/api` and are shared by `crhs` and the UI. All endpoints are JSON and
same-origin; every one requires an authenticated session except the login flow and `/api/health`.

### Cursor pagination

Lists use keyset cursors instead of offsets; an offset shifts when a row above the page is
inserted, which makes a scrolling list skip or repeat rows.

- A cursor is an opaque base64url string containing JSON `{ "k": [<sort values>], "id": <row id> }`.
  The server encodes it, validates its shape and types, and answers 400 for anything it did not
  write. It is never trusted as a column name.
- A page is `{ "items": [...], "nextCursor": string | null }`; `null` means the list is complete.
  The server fetches `limit + 1` rows to decide whether another page exists and never returns the
  extra row.
- `limit` defaults to 50 and is an integer from 1 to 200. A `limit` that is not decimal digits or
  is out of range is a 400.
- The condition is the descending multi-column keyset
  `(a < x) OR (a = x AND id < y)`, nested for multiple sort columns; the id breaks ties.
- Endpoints with cursor pages: `GET /api/sessions`, `GET /api/sessions/:id/children`,
  `GET /api/sessions/search`, `GET /api/tasks`, `GET /api/audit`, `GET /api/schedules/:id/runs`
  and `GET /api/authorizations`. These endpoints use cursor pages; `GET /api/audit` takes `cursor`
  instead of `beforeSeq`.
- `GET /api/sessions/:id/entries` uses a history cursor (an entry id) and defaults to 100 entries.

### Session list API

`GET /api/sessions?scope=mine|shared|visible|all&q=&scheduleId=&ownerId=&cursor=&limit=`

- Order: `updated_at desc, id desc`. Only root sessions (`parent_session_id IS NULL`) are
  returned.
- `scope` defaults to `mine`. `shared` is someone else's root shared with the caller. `visible` is
  the union of the caller's own roots and the roots shared with them, also for an administrator;
  it is the WebUI's only scope. `all` is administrator-only and returns the whole organization.
- `q` is a case-insensitive substring match on the title. `%`, `_` and `\` are matched literally.
  Both sides are compared through `lower()`; SQLite's `lower()` folds only ASCII letters, so
  accented or non-Latin case differences do not match on SQLite while PostgreSQL folds by Unicode.
- `scheduleId` filters the schedule that started the sessions. `ownerId` filters the owner; it is
  useful with `scope=all` for an administrator and can only narrow what another scope already
  allows.
- The tree aggregate state is computed in SQL: any `awaiting` session in the tree makes the root
  `awaiting`, otherwise any `running` makes it `running`, otherwise `idle`. The tree's wait is the
  highest-priority one: quota over approval over authorization.
- Indexes for the page: `sessions_owner_parent_updated_idx` on
  `(owner_user_id, parent_session_id, updated_at, id)`, `sessions_parent_updated_idx` on
  `(parent_session_id, updated_at, id)`, and `sessions_root_state_idx` on
  `(root_session_id, state)` for the tree aggregate.
- `updated_at` changes when a session's state, title or messages change, so the list reorders on
  real activity. Marking a tree read does not touch it.
- Unread is owner-only: the root's `reply_at` is later than `owner_read_at`, or `owner_read_at` is
  null. `reply_at` is written on the root when the tree's state leaves `running` for `idle` or
  `awaiting` with new output. A shared viewer always sees `unread: false`; a child list item does
  too.
- `POST /api/sessions/:id/read` (owner only, 204) sets the tree root's `owner_read_at` to the
  current time and publishes the root's `upsert`, so other tabs clear the dot without reordering.
  `:id` may be any session in the tree; opening a subagent marks the whole tree read.

`SessionListItem`:

```ts
{
  id: string;
  title: string | null;          // null until generated or set
  ownerUserId: string;
  ownerName: string;
  scheduleId: string | null;
  shared: boolean;               // not owned by the caller, shared with them
  state: "idle" | "running" | "awaiting"; // the whole tree's aggregate
  waitingKind: "quota" | "approval" | "authorization" | null;
  unread: boolean;               // owner only
  parentSessionId?: string | null; // children list only
  updatedAt: string;             // ISO 8601
}
```

`GET /api/sessions/stream?scope=` is an SSE stream of the roots the caller can see:
`event: upsert` with a `SessionListItem`, `event: remove` with `{ "id" }` when a session is
deleted, unshared or archived, and `event: ping` every 15 s. The connection sends no full snapshot.
The WebUI uses `scope=visible`, so an administrator's stream also contains only their own and
shared sessions. Any session in a tree publishes its root. The client patches the loaded pages at
the server's sort position rather than at the top: an upsert whose `updated_at` did not change
replaces the row in place; a moved row is inserted into the page it belongs to; a row that would
land past the last loaded page is dropped when another page exists, because that page's fetch will
bring it. On reconnect the client invalidates the list and refetches it.

### Session content search

`GET /api/sessions/search?q=&scope=&cursor=&limit=`

- `q` is required. It is split on whitespace into at most 8 keywords (empty parts ignored); every
  keyword must match (AND), as a case-insensitive substring. `%`, `_` and `\` match literally. A
  query with no keyword is a 400.
- A keyword matches when it appears in the root's title, or in the `search_text` of any
  `pi.user` / `pi.assistant` entry in its whole tree (root plus subagents); every keyword must
  match. Only user text and assistant `text` blocks contribute; thinking, tool calls, tool results,
  system messages and compaction do not.
- Scope, visibility and cursor are the session list's. Order is `updated_at desc, id desc`.
  `limit` is 1..50 and defaults to 20.
- Response: `{ items, nextCursor, contentSearch }`. Each item is a `SessionListItem` plus
  `titleMatch`, `hitCount` and `hits`. `titleMatch` means every keyword is in the title.
  `hitCount` is the number of entries in the tree containing at least one keyword. `hits` holds at
  most 3 entries, ordered by number of matched keywords (descending), then by entry id (newest
  first). A hit is `{ entryId, sessionId, sessionTitle, role, at, snippet }`: `entryId` has the
  same numeric form as `EntryRecord.id`; `sessionId` and `sessionTitle` identify the entry's
  session (a subagent is possible); `role` is `user` or `assistant`; `at` is the timestamp of the
  entry's first model message (ISO 8601 or null); `snippet` is about 120 characters around the
  first matched keyword in `q` order, with whitespace collapsed and `…` at a cut edge.
- `contentSearch` is `true` on PostgreSQL. SQLite has no content column, so it searches titles
  only: `contentSearch` is `false`, `hits` is empty and `hitCount` is 0. The generated column and
  its indexing consequences are in [Data model](data-model.md#conversation-content-search). A
  future content-search index is `pg_trgm` GIN on `search_text`; full-text search would change the
  schema.

### Session event stream and history

`GET /api/sessions/:id/events` starts with one `snapshot` event. Its `entries` holds the most
recent 100 shown entries (system messages are filtered out) and a `historyCursor`; a null cursor
means there is no older history. Later events keep their existing shape.

`GET /api/sessions/:id/entries?before=<historyCursor>&limit=` returns
`{ entries, historyCursor }`:

- `before` is the cursor from the snapshot or the previous page; the response holds the entries
  immediately before it, oldest first.
- `limit` defaults to 100 and is 1..200.
- Visibility is the same as for the event stream.
- The client reducer prepends a history page without disturbing live streaming output, so a reader
  can page through entries recorded before a compaction.

### API conventions

- Cursor requests carry `?cursor=<string>&limit=<1..200, default 50>` plus the endpoint's own
  filters; responses carry `{ items, nextCursor }`. The search endpoint defaults to 20.
- Ordinary JSON request bodies are limited to 1 MiB; a larger body is rejected with 413 and
  `{ "error": "request body too large" }`. The limit applies to `POST /api/auth/login` before the
  body is parsed, so an oversized login does not reach authentication or rate limiting. The task
  input routes
  (`POST /api/nodes/:id/tasks`, `POST /api/task-groups`) accept up to 64 MiB of input: the body
  limit is `ceil(64 MiB / 3) * 4 + 64 KiB`, `contentBase64` may be at most
  `ceil(64 MiB / 3) * 4` characters before decoding, and `stdin` may be at most 64 MiB of UTF-8.
  Exceeding either input count is a 400.
- `GET /sessions/:id` returns `SessionView` with the token measures:
  `budgetUsedTokens` (the budget measure: output tokens accumulated up the chain),
  `usageTokens` (the statistics measure: input plus output, accumulated up the chain),
  `contextTokens` (input plus cache read plus cache write of the session's last main-agent call,
  null before the first call), `budgetRemaining` (null means unlimited), and `stats`
  `{ turns, steps, ttftMs, ttftSteps, decodeMs, decodeTokens, promptTokens, cacheReadTokens }`.
  The first six stats belong to the session; `promptTokens` and `cacheReadTokens` cover the tree
  and feed the cache-hit display ([Agent runtime](agent-runtime.md#session-statistics)).
  `POST /sessions` and `PATCH /sessions/:id` use `budgetRemaining`; there is no `quota` field.
- `GET /api/sessions/:id/children?cursor=&limit=` returns `SessionListItem` items plus
  `parentSessionId`. Visibility is `GET /sessions/:id`'s (404 otherwise). The order is
  `updated_at desc, id desc`. `state` and `waitingKind` are the child's own, not the tree's. The
  root list stream does not carry children, so the page refetches this list on its session
  snapshot, on a `subagent` tool update/end, and on its tree root's `upsert`.
- `GET /api/sessions/:id/children/summary` returns
  `{ total, states: { idle, running, awaiting } }` for the direct children only; visibility is the
  same as the session.
- `GET /api/users/:id` returns `{ user, userGroups }`, where `user` matches a users-list item and
  `userGroups` is `[{ id, name }]`. An administrator may read anyone; a member may read only
  themselves, and any other id gets the same 404 as a missing user.
- `GET /api/user-groups/:id` returns `{ group: { id, name, createdAt, members: [{ id, username,
  displayName }] } }`; it is administrator-only and 404 for a missing group.
- `PATCH /api/user-groups/:id` validates `{ name }` with the creation rules and writes an audit
  entry.
- `GET /api/tasks` accepts `state`, `actorType`, `nodeId` and `userId`. `userId` filters
  `on_behalf_of_user_id` (the **By** column's user) after the visibility rule. `GET
  /api/sessions` accepts `ownerId`, which an administrator combines with `scope=all`.
- `GET /api/nodes/:id/tasks` returns the newest 10 tasks for the node, after the node's access
  check; the node's Recent tasks section uses it and links to `/tasks?node=<nodeId>` for the full
  list.

### Entity search

`GET /api/users` and `GET /api/user-groups` (administrators), `GET /api/nodes`,
`GET /api/node-groups` (their normal visibility) and `GET /api/directory` (any signed-in user)
accept three optional parameters:

- `q`: case-insensitive substring match. Users match `username` or `displayName`; user groups and
  node groups match their name; nodes match name or hostname. `%`, `_` and `\` are literal. Prefix
  matches sort before other matches, then by lower-cased name.
- `limit`: an integer from 1 to 100. When it is present the response carries a boolean `more`
  saying whether more items matched; without `limit` there is no `more`.
- `ids`: a comma-separated list of at most 100 ids, de-duplicated. It returns the items that exist
  and are visible to the caller, so an `EntityPicker` can resolve the labels of values selected
  earlier. It cannot be combined with `q` or `limit`.
- With none of the three parameters the endpoint returns the same result and order as a request
  without search parameters, so list pages are unaffected.
- A `limit` that is not 1..100, an empty `ids`, more than 100 ids, or `ids` with `q`/`limit` is a
  400.

Response shapes: `GET /api/users` → `{ users, more? }`, `GET /api/user-groups` →
`{ groups, more? }`, `GET /api/nodes` → `{ nodes, more? }`, `GET /api/node-groups` →
`{ groups, more? }`, `GET /api/directory` → `{ users, userGroups, more? }`. The directory applies
`limit` to both lists; `more` is true when either list was truncated.

### Links

Server-generated WebUI links use the path form: `/approvals/tasks/:id`,
`/approvals/task-groups/:id`, `/tasks/:id`, `/task-groups/:id`, `/sessions/:id`. The client turns
a server-provided path into a link only when `safeInternalPath` accepts it: a same-origin absolute
path with no scheme, protocol-relative prefix, backslash, whitespace, control character or dot
segment that climbs out of the route. Anything else stays text.

## Performance targets

- First screen: the entry JavaScript is at most 250 kB gzip, excluding each page's lazy chunk.
- Session list at 100,000 sessions: the strictly timed first screen (page open to first row
  painted) is acceptable at about 500 ms under 4× CPU throttling, and scrolling has no noticeable
  jank.
- Message view at 20,000 messages (all loaded): the DOM node count stays constant, and inserting
  an older history page shifts the reading position by at most 2 px.
- Streaming: a 100,000-character message at 300 and 1,500 characters per second, under 4×
  throttling, keeps the Stop button's response p95 below 100 ms.
- Security: zero external image requests, no executable HTML, and no link outside the allowlist.
- Accessibility: the sidebar, menus, dialogs and lists are fully keyboard operable and verified
  with Playwright.

The measured baseline for these targets belongs to the testing guide, not to this design
document.

## Known limitations

- The WebUI has been verified in Chromium only; other browsers are not covered by the e2e suite.
- The Chinese catalog is complete but needs a native-speaker review.
- The SSH wizard's end-to-end test needs an external sshd, configured through
  `CRH_TEST_SSH_JUMP`.
- Finished Markdown blocks are cached by calling `react-markdown` 10.1.0's `Markdown()` outside
  JSX, because the renderer is mounted once per block and a virtualised row can be recreated. This
  relies on that version not using hooks; a major upgrade must re-check it.
- On a narrow screen a table keeps its minimum column widths and scrolls horizontally instead of
  turning into cards.
- Message content search needs PostgreSQL. On SQLite the session search matches titles only
  (`contentSearch: false`).

