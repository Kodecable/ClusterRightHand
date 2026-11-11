# Using the WebUI

The WebUI is the operations console of ClusterRightHand. It is where you start agent sessions,
run and watch tasks, manage nodes and their trust, decide approvals, sign privileged tasks and read
the audit log. What you can see and do depends on your account: an administrator manages the
cluster, a member works with the nodes and sessions they have been granted. The objects and terms
are defined in [Concepts](concepts.md); this page is a tour by task and uses the labels the console
shows. The frontend's internals are in [WebUI design](../design/webui.md).

## Signing in

Open `https://<your-crhs>/`. The sign-in page has two fields, **Username** and **Password**, and a
**Sign in** button that shows a spinner while the form is submitted; the account is a local one.

| Field | Meaning |
|---|---|
| **Username** | The account name, case-insensitive at sign-in. |
| **Password** | The account's local password. |

Sign-in is password-only. A **Passkey is not a login factor**: it signs privilege authorizations
from inside the console, after you are signed in ([Authorizations](#authorizations); [Signing
methods](../design/privilege.md#signing-methods)). Administrators create accounts, set
initial passwords and reset forgotten ones ([Users and user groups](#users-and-user-groups)).

### Captcha

With the default `[auth] captcha = "cap"`, the page also runs an invisible Cap proof of work before
the password is checked. It downloads its two WASM files from the same crhs, never from a CDN, and
the button reads **Running a security check…** while it solves. The proof is bound to the submitted
username, password and client address. A challenge that is rejected on arrival (an expired one, for
example) is solved again and retried once; a second failure shows **Security verification failed.
Try again.** next to the form.

The check exists to make password guessing expensive before any Argon2id work starts. With
`[auth] captcha = "none"` the challenge endpoint is disabled and no proof is requested; use that only
in a controlled environment that cannot run a browser. The settings and their defaults are in the
[`[auth]` reference](reference/crhs-config.md#auth); the mechanism is in [Cap proof of
work](../design/access-control.md#cap-proof-of-work).

### Failed sign-ins and limits

The console reports the server's answer as one line. The common failures are the following.

| Message | Cause |
|---|---|
| **Invalid username or password.** | Wrong username, wrong password, no password set, or a disabled account. The server does not say which. |
| **Too many failed attempts. Try again later.** | 10 failures in 15 minutes for this address or for this address and username. |
| **Another sign-in from this address is already in progress. Try again.** | Only one login per client address may verify a password at a time. |
| **The server is busy. Try again later.** | The Argon2id gate queue is full (`hash_busy`); retry after a moment. |
| **Security verification failed. Try again.** | The captcha proof was rejected twice. |

A limited attempt is not written to the audit log, so brute force cannot fill the log with entries.
The limits reset when crhs restarts. The algorithm, keys and reservations are described in [Rate
limiting](../design/access-control.md#rate-limiting); passwords are stored as Argon2id PHC strings
([Password hashing](../design/access-control.md#password-hashing)).

### The signed-in session

A successful sign-in creates a WebUI session that lasts seven days. The session cookie is
`HttpOnly`, `SameSite=Strict` and `Secure` except on a loopback host. A request that changes data
must be JSON and, when it carries an `Origin`, must come from the same host, which is the console's
CSRF protection. Closing the browser does not end the session; **Log out** in the user menu does.

If you followed a deep link while signed out, crhs keeps it in the login URL's `redirect` parameter
and returns you there after signing in. Approval and task links handed out by MCP or agent tools work
this way.

### Changing your password

Open the user menu at the bottom of the sidebar and choose **Change password**.

| Field | Notes |
|---|---|
| **Current password** | Checked by the server and counted by the login limiter under the account and the address. |
| **New password** | At least 8 characters, at most 1024; NFKC-normalized before hashing. |
| **Repeat new password** | Must match. |
| **Also revoke all of my API tokens** | Off by default. Changing the password always signs out your other web sessions; existing API tokens keep working unless you tick this. |

The dialog closes with **Save password** and a toast confirms the change. There is no self-service
password reset: a forgotten password is reset by an administrator ([Users and user
groups](#users-and-user-groups)). If you use a Passkey for privilege authorizations, register it on
the **Credentials** page in the same console ([Signing with an SSH key or a
Passkey](#signing-with-an-ssh-key-or-a-passkey)); Passkey registration needs an
HTTPS origin with a hostname, not a bare IP address.

## Navigation

The sidebar has three groups; items that require an administrator are hidden from members, and a
group with no visible item disappears.

| Group | Item | Opens | Who sees it |
|---|---|---|---|
| **Work** | **Sessions** | `/sessions` | Everyone |
| **Work** | **Schedules** | `/schedules` | Everyone |
| **Work** | **Tasks** | `/tasks` (also highlights task-group pages) | Everyone |
| **Work** | **Approvals** | `/approvals` | Everyone; the badge counts what waits for you |
| **Cluster** | **Nodes** | `/nodes` | Everyone (the list shows the nodes you may see) |
| **Cluster** | **Node groups** | `/node-groups` | Everyone |
| **Cluster** | **SSH credentials** | `/ssh-credentials` | Administrators |
| **Cluster** | **Credentials** | `/credentials` | Everyone (your signing keys and Passkeys) |
| **Admin** | **Authorizations** | `/authorizations` | Administrators |
| **Admin** | **API tokens** | `/tokens` | Everyone (your own tokens) |
| **Admin** | **Audit** | `/audit` | Everyone (administrators see every event, members the events on their behalf) |
| **Admin** | **Models** | `/settings/models` | Administrators |
| **Admin** | **Users** | `/users` (also highlights user-group pages) | Administrators |

The **Approvals** item carries a badge when something waits for you. It counts task approvals,
task-group approvals, tasks and task groups waiting for your signature, and roots whose token quota
is used up; a waiting task group counts once, not once per member. Above 99 it shows `99+`.

The sidebar can collapse to an icon rail; hovering an icon shows its label as a tooltip. Below
768 px it becomes a drawer, opened from the top bar. Arrow keys, Home and End move between the
sidebar links in addition to Tab.

The top bar shows the current page's title, and a detail page may show its object instead (a task's
summary, for example). The browser tab reads `<title> · ClusterRightHand`.

The user menu at the bottom of the sidebar shows **Signed in as <name>** and offers:

- **Theme**: **System**, **Light** or **Dark**.
- **Language**: **English** or **中文 (简体)**.
- **Change password**.
- **Log out**.

Lists refresh themselves: there is no refresh button. Sessions are patched over an event stream; the
audit list and the approvals page poll every 10 seconds, the node list and the authorizations list
every 5 seconds, and a node's trust report and recent tasks every 10 seconds. Editing happens on a
detail page, never inline in a list. Rows that stand for an object with a detail page are clickable
as a whole; they contain exactly one real link, so Ctrl/⌘-click and middle-click open a new tab.
A detail page's back link is an arrow plus the list's name (**All nodes**, **All tasks**, **All
users**, **All approvals**). Removing one row uses a **Remove** button with a confirmation; deleting
a whole object uses **Delete**.

## Sessions

The Sessions route is the console's main workspace. At wide widths the session list sits on the left
and the selected session on the right; below the `lg` breakpoint a session page takes the whole main
area and the list is one back step away. `/sessions` itself is the new-session page, not a stored
session.

### The session list

At the top of the list are two controls.

- **Search sessions…** (with `⌘K` on a Mac and `Ctrl K` elsewhere) opens [session
  search](#session-search). It does not filter the list in place.
- **New session** opens the new-session page ([Starting a session](#starting-a-session)). If no model is
  configured the button is disabled, a warning says **No models are configured, so sessions cannot
  start.**, and an administrator gets a link **Configure a model provider** while a member is told to
  ask an administrator.

A row shows only the session's title on one line. A session without a title shows **New Session**.
Two grey badges may sit at the right end: **Scheduled** for a session a schedule started, and
**Shared** for a session someone shared with you (its tooltip names the owner).

The leading slot holds one indicator:

| Indicator | Meaning |
|---|---|
| A small spinning loader, labelled **Running** | The session (or a session below it) is running. |
| An amber dot | The session is **Awaiting** a decision: an approval, a signature or a quota decision. Its tooltip says which wait. |
| A blue dot, labelled **Unread** | The session produced output that its owner has not seen. Unread is computed for the owner only; a shared session is never unread for the viewer. |
| Nothing | The session is idle and read. The slot keeps its width so titles line up. |

Rows are grouped by their last update: **Today**, **Yesterday**, **Within 7 days**, **Within
30 days**, then the local-time month. Scrolling to the bottom loads the next page. Up/Down, Home/End
and Enter work on the list; only the active row is a tab stop.

The list contains root sessions you can see: your own roots and roots shared with you. An
administrator sees the same union, not every session in the organization.

### Starting a session

**New session** opens `/sessions/new`, a blank session page: no transcript, the line **What's on
your plan today?**, and the composer. The footer starts with the model you last used in this browser
(or the first available model), thinking **Off**, the **Ask** rule preset and no budget limit.

Type a message and press Enter (Shift+Enter adds a line). The first send creates the session and
submits the message in one request; the page then replaces the new-session page with the new
session. A failed send leaves you on the new-session page with the text intact, and a retry is safe:
the page keeps one request id for its lifetime, so the server does not create two sessions. The
new-session page has no stop button, and `/compact` is refused with **Compaction is not available
before the session exists.** because there is nothing to compact yet.

Below the `lg` breakpoint the new-session page is not shown at `/sessions`; the list is the main
view there.

### The session page

The header has the title, up to two badges and the share button. The title is editable by a caller
who may configure the session: click it, change the text and press Enter or leave the field. A blank
title is a real change — it clears the title and stops title generation, so the default **New
Session** appears. The limit is 200 characters. A subagent shows a breadcrumb from **Sessions**
through its ancestors; a root session has none, because its title is already the page title.

Below the header there is at most one single-line banner. Its priority is:

1. **Connecting…** or **Reconnecting…** while the event stream is not live.
2. A failure, in the danger colour.
3. **Retrying after an error: …**.
4. The waiting reason: **The session is waiting for an approval.**, **The session is waiting for a
   signature.** or **The session is paused: its token quota is used up.**
5. **# message queued** / **# messages queued** while a message waits for the run to end.

The transcript shows your messages as right-aligned bubbles and the agent's text and thinking as
rendered Markdown. A thinking block is a collapsible row labelled **Thinking**. A tool call is one
line `name · node · subject`; clicking it opens a dialog with the arguments, live output, the result,
the task result and a link to a subagent. When the final answer of a turn starts streaming, the
turn's process folds into one line **Ended in <duration>** above it; expanding the line shows the
process again.

A completed compaction is a collapsible **Context compacted** row. A compaction in progress is a
**Compacting context** row at the end of the transcript; Stop stays available while it runs. While
you are at the bottom, new output keeps the view pinned; scrolling up stops following and shows
**Jump to latest** in the bottom centre. Older messages load when you scroll to the top.

#### Waiting for a decision

When the session tree waits for something, cards appear between the banner and the messages:

- **Task** or **Task group** approval cards, with the rule chain and the approve/reject actions.
- **Waiting for your authorization** cards for privileged tasks, with the signing controls.
- A quota card when the session's quota is exhausted, where the owner adds tokens or stops the run.
  On the [Approvals page](#approvals) the same card appears under **Token quota used up**.

These are the same cards as on the [Approvals page](#approvals): a decision here also updates the
sidebar badge and that page. A decision that an agent is handling stays in the session and is not
listed twice. If the session is waiting but no card belongs to you, the page says **This session is
waiting, but there is nothing for you to decide.**

#### Sending and stopping

The composer is one rounded box. Its placeholder reads **Ask the agent to do something. Enter sends,
Shift+Enter adds a line, /compact summarizes older context.** Enter sends; Shift+Enter adds a line.
The send button is disabled while there is nothing to send. With view access the composer is
replaced by **You have view access: the owner can let you send messages by sharing it for chat.**

While the session runs, sending a message is allowed and the message is queued; the banner counts
the queue. The button on the right is Stop (a square) while something can be stopped and the input is
empty; otherwise it is Send (an up arrow). On a root session, Stop stops the session and every
subagent below it. On a subagent page it follows that session's own state. Stop stays available
during a manual compaction.

`/compact [instructions]` compacts older context instead of sending a message and keeps the most
recent part of the conversation; the finished summary appears as a **Context compacted** row.
Typing `/` opens a completion list above the input (Up/Down, Tab or Enter completes, Enter on the
complete command runs it, Escape closes). Only an exact registered command is treated as a command,
so `/compactor` is an ordinary message and the hint **Unknown command: it will be sent as a
message.** appears. A recognised command shows `/{name}: {description} (not sent as a message)`
under the input.

#### Model, thinking level, rule preset and budget

The footer inside the composer has four controls.

| Control | What it shows | What a change does |
|---|---|---|
| **Model** | The model's display name. The tooltip holds `provider/modelId` and says the change applies from the next turn. | Opens the model list grouped by provider. The choice is stored on the conversation and applies from the next model request; a turn already in flight keeps the model it started with. |
| **Thinking level** | A light bulb and a level: **Off**, **Minimal**, **Low**, **Medium**, **High**, **Extra high** or **Max**, depending on the model. Hidden when the model supports only Off. | Applies from the next turn. |
| **Rule preset** | **Ask**, **Auto Review** or **Yolo** with a shield icon. Only a root session has a preset; a subagent shows **Rules: N** or **No rules**. | Applies to the next tool call, and the server immediately re-evaluates approvals that wait on this chain. |
| **Budget** | `∞` when there is no limit, otherwise the remaining tokens in an automatic unit. The tooltip says **No budget limit**, `<n> tokens left` or **The budget is used up.** | Opens the quota dialog for a caller who may configure the session. The number is the budget measure (output tokens), not the usage statistic. |

Without permission to configure the session, the model and rule controls are read-only text.

#### The generation and usage line

Under the composer box is one centred line with three items. They are the numbers to watch while a
session works; their exact definitions are in [Session
statistics](../design/agent-runtime.md#session-statistics) and [Token
measures](../design/agent-runtime.md#token-measures).

| Item | Reads | When it appears |
|---|---|---|
| Generation | **N turns M steps**, followed by **X tok/s** when timing is known | After the first step. The rate is decoded tokens divided by decode time, rounded for display. The tooltip adds the average time to first token and the decode speed. |
| Usage | The session tree's total tokens, then the cache-hit percentage | The percentage appears when the tree recorded prompt tokens. The tooltip holds the exact total and `Cache hit: <read> / <prompt>`. |
| Context | A small ring and a percentage, for example **42%** | When both the last main call's context size and the model's context window are known. It turns warning-coloured at 90% or more, and the tooltip is the exact pair. |

The usage numbers accumulate up the tree, so a root's figures include its subagents'. The context
figure is the session's own last main call.

#### Subagents

A rounded strip directly above the composer shows the session's direct children, for example
**3 subagents**, then **1 running** and **2 awaiting** when those counts are not zero. With no
children the strip is absent. Clicking it opens a popover (a bottom sheet on a phone) with the
subagent tree: each node shows its state and title and opens that session. A nested level is loaded
only when you expand it, and each level has its own **Load more**. Every subagent is its own session
with its own rules, budget and state, and it has a breadcrumb back to its ancestors. The session
list shows roots only.

#### Sharing

A caller with `manageShares` gets the **Share** button in the header. The dialog is titled
**Shares** and explains that view access is read-only while chat access can send messages.

- The current shares are listed with their kind (**User** or **User group**), the grantee's name and
  **View** or **Chat**. **Remove** revokes one.
- The owner (not an administrator who is only viewing) can add a user or a user group with **View**
  or **Chat**.
- An empty list reads **Not shared.**

Sharing is one level: it does not give access to the grantee's other sessions, and an administrator
still cannot create a share on someone else's session. The rules are in [Ownership, access grants
and sharing](../design/access-control.md#ownership-access-grants-and-sharing).

## Session search

Press `Ctrl K` on Linux and Windows, or `⌘K` on a Mac, from any page, or click **Search sessions…**
above the list. The key combination is intercepted so the browser's own action for it does not run.
The dialog has one input, and the results area scrolls independently.

- Input is debounced by 250 ms. Keywords are separated by spaces; at most eight are used.
- Results are root sessions you can see, one cursor page at a time; scrolling to the bottom loads the
  next page.
- A result starts with the session: its title (keywords are highlighted when the title matched), the
  owner, the relative update time and its status (**Running**, **Awaiting** or **Idle**). Up to
  three message hits follow. A hit shows **You** or **Assistant**, the relative time and a snippet
  with the keywords marked. A hit inside a subagent says **Subagent: <title>**. When more hits exist
  than are shown, a grey row reads **N more matches**; clicking it opens the session.
- An empty input says **Type keywords separated by spaces**; a search with no results says **No
  matching sessions**.

Message search depends on the database:

| Database | What is searched | Effect |
|---|---|---|
| PostgreSQL | Session titles and the text of the messages in the root's tree | Hits and snippets are returned; `contentSearch` is true. |
| SQLite | Session titles only | No hit rows and no snippets; `contentSearch` is false. The dialog gives no extra notice, so a title search is what you get. |

Up/Down move through session headings and hit rows, Home/End jump to the ends, Enter opens the
active row and Escape closes the dialog. Choosing a session heading opens that session. Choosing a
hit opens its session with `?entry=<entryId>`.

That parameter is a jump request: the session page scrolls the first row with that entry id to the
centre and marks it with a yellow highlight for about two seconds. If the entry is not in the
current snapshot, the page loads older history pages (up to 20) until it finds it, expanding a folded
turn when the entry is inside one. If it cannot find the entry, a toast says **Couldn't find that
message in this session.** In both cases the page removes `entry` from the URL with `replace`, so a
reload does not jump again. The mechanism is in [Jumping to a
message](../design/webui.md#jumping-to-a-message); the search API is in [Session content
search](../design/webui.md#session-content-search).

## Tasks

**Tasks** lists the tasks you may see: an administrator sees every task, everyone else their own.
The table has the columns **Created**, **Task** (the command or summary, with a **Privileged**
badge when it applies), **Node**, **By**, **Status** and **Outcome**. The whole row opens the task.

The filter row has three selects and, when a user filter is active, one extra line:

| Filter | Options | Notes |
|---|---|---|
| **State** | **Any state**, or one of Awaiting approval, Awaiting authorization, Dispatched, Running, Finished, Failed, Rejected, Denied, Cancelled, Unknown | The labels match the task states. |
| **Actor type** | **Any actor**, **User**, **API token**, **Agent**, **Subagent**, **Schedule** | Who started the task. |
| **Node** | **Any node**, or one node | The choice is written to the URL as `?node=<nodeId>` and survives a reload or a shared link. |

`?user=<userId>` opens the page filtered to one user. There is no separate user select: the row
shows **User: <name>** with a clear button. The node page's **View all tasks** links to
`?node=<id>`, and a user page's **View all tasks** links to `?user=<id>`.

### The Run task dialog

**Run task** in the page header opens a dialog that only submits; it does not show a result.

1. Pick the targets with **Nodes or node groups**. The picker is searchable and every row carries
   its type; several targets may be selected. The checkbox **All nodes I can access** overrides the
   picker and sends `_all`.
2. Fill the shared task fields: **Kind** (exec, file.read, file.write, file.edit, file.stat,
   file.list), **Timeout (s)** and **Privileged**.
3. For an exec task, choose **Shell command** or **argv** and fill **Command line (split into argv)**
   for argv mode, **Working directory (optional)** and **Stdin (optional)**. For a file task fill
   **Path**, plus the kind's own fields:
   - file.read: **Start line** and **Lines**.
   - file.list: **Limit**.
   - file.write: **Content** and **Overwrite if it exists**.
   - file.edit: **Old text** and **New text**.
4. **More options** is collapsed by default. It holds **Parallel** (the number of nodes that run at
   once; default 10), **Fail fast**, and, for an exec task, **Output** with **Status only** or
   **Tail of output**. These apply to a task group; a single task does not send them.

The dialog's submit button is **Run**. Exactly one selected node creates one task and opens its page.
A node group, `_all`, or two or more targets create a task group and open the group's page. With no
target it says **Choose at least one target.**; a task-field error is shown in the dialog too.

### The task page

The back link is **All tasks**. The title is the task's command or summary in monospace, with the
full text in a tooltip. Under it are the status and, when there is a result, the outcome after a dot:
for example **Finished · Exit code 3**, **Finished · Timed out**, **Finished · Cancelled** or
**Finished · Succeeded**. A non-exec file task that ended cleanly reads **Succeeded**; an exec task
shows its exit code. A running task shows **Stop task** for an administrator or the task's
`on_behalf_of` user; it sends a cancellation request at once.

The facts panel lists the task id (with a copy button), **Kind** (with the **Privileged** badge),
**Summary**, **Node**, **Asked by**, **Status**, **Exit code**, **Signal**, **Error**, **Created**,
**Finished at** and **Output file**, plus links to the **Session** and **Task group** when they
exist. Node and user names are links.

What follows depends on the state:

- **Awaiting approval**: an approval card with the rule chain and the actions, if you may decide
  it. A viewer who may not decide sees the facts only.
- **Awaiting authorization**: the signature card for the task's owner (see
  [Authorizations](#authorizations)).
- **Finished or otherwise settled**: a collapsible **Rule chain evaluation** and the result panel.

The **Rule chain evaluation** table has four columns:

| Column | Contents |
|---|---|
| **Level** | The chain level: the scope type (API token, Session or Schedule) and its id; an API token shows its name when crhs knows it. |
| **Matched rule** | The rule that matched at that level as stored, with node and node-group names resolved, or **Default** when no rule matched. |
| **Rule result** | That level's own result: **Allow**, **Deny**, **Require approval** or **Inherit**. |
| **Cumulative result** | The effective result from the root down to this level. The last row is the decision. |

A lower level can only tighten the result above it, so a child's **Allow** never widens a parent's
restriction. The reasoning is in [Rule chain](../design/access-control.md#rule-chain) and
[Evaluation](../design/access-control.md#evaluation).

The result panel shows a notice from crhs (for example the SSH privileged notice), then the output
and any structured result. Output is one merged stream (stdout and stderr), and crhs keeps only a
head and a tail; the panel says how many bytes were kept and how many were omitted, and offers a
copy button. The full output is a file on the node, named under **Output file**. An SSH node keeps
no full output. With **Status only**, the panel says so and points at the file or explains that the
output stays on the node. File tasks add their structured result: a line range, a file's metadata, a
directory listing, or what a write or edit changed.

Tasks are visible by relationship, not by node access: a user sees their own tasks, an administrator
sees all. The task page needs no node grant.

## Task groups

A task group is one call over several targets. It is created by the Run task dialog (a node group,
`_all` or several targets), by an agent tool call, or over MCP; the page is at
`/task-groups/<id>`. Its title is the command or summary in the same monospace style as a task, and
the next line is the group's status: **Awaiting approval**, **Awaiting authorization**, **Running**,
**Finished**, **Interrupted**, **Rejected** or **Cancelled**.

- **One approval covers the group.** The approval card lists the rule chain per node where one was
  recorded. A rejection or a decision is shown once for the whole group.
- A signature wait is also one card for the group, but a Passkey is bound to one relying party. If
  the nodes trust Passkeys under different RPs, the card offers one signing button per credential;
  each signature releases the nodes that accept it, and the others keep waiting.
- **Skipped: <nodes>** names the targets that never started, with ** (the batch was interrupted)**
  or ** (the batch was cancelled)** when that is why.
- The member table has **Node**, **Status** and **Outcome**, one row per node, and every row opens
  that member's task page. There is no separate result heading or repeated command line.

There is no stop button on the task-group page. One member's running task can be stopped from that
task's own page, which cancels that member only; the group as a whole is cancelled from the session
or tool call that owns it, or from the API, and that stops the workers and every unfinished member
([Task cancellation](../design/execution.md#task-cancellation)). The group itself is one entry in
the approvals list, not one per node.

## Nodes

### The node list

**Nodes** lists every node you can see. The columns are **Name** (with an **SSH** badge for an SSH
node), **Status**, **Hostname**, **OS**, **Node groups** and **Last seen**. The status folds
enrollment and reachability into one label:

| Label | Meaning |
|---|---|
| **Pending approval** | A crha node has enrolled but no administrator has approved its key. It has a restricted connection and receives no tasks. |
| **Connected** | An active crha node with a live connection. |
| **Offline** | An active crha node without one. |
| **Active** | An active SSH node. It has no standing connection; its last seen time comes from the last task that reached it. |

A measured clock offset adds a warning triangle and **clock** beside the status, with the full
sentence in its tooltip. A trust warning adds a small chip in the same place. **Last seen** shows
**Now** for a connected client node; hovering it reveals **Connected since <time>**. A disconnected
node or an SSH node shows a relative time.

An administrator gets an **Actions** column with **Approve** and **Reject** for a pending node, and
two page actions: **New SSH node** (outline) and **New node** (primary).

### Adding a crha node

**New node** creates a one-time enrollment token and shows the command to run on the node.

1. Optionally enter a **Node name**. The description says **Optional; it defaults to the node's
   hostname.** The name must be unique among nodes and node groups.
2. Choose **New token**. The dialog then shows **Run this on the node:** with the command, which
   includes the URL, a suggested config path and state directory, and the token. Copy it with **Copy
   command**. The token is shown once and its expiry is displayed. The paths are a suggested layout,
   not built-in defaults.
3. Run the command on the node as the user `crha` should run tasks as. The node connects as pending;
   the dialog tells you to compare its key fingerprint with `crha status` on the node before
   approving.

The full procedure, including the config file and the agent process, is in [Enroll a
node](install.md#enroll-a-node). The token is single-use and valid for one hour; it carries the
server's key fingerprint so the node can pin the right crhs ([Node
registration](../design/protocol.md#node-registration)).

### Approving a pending node

A newly enrolled node appears as **Pending approval**. On the node, `crha status --config
<crha.toml>` prints the node key fingerprint and the privileged mode. Compare the hostname and the
fingerprint with the dialog.

- **Approve** asks **Approve node** and shows **Node key fingerprint: <value>**. Approving is
  administrator-only. crhs pushes the active state, closes the restricted connection, and the node
  reconnects with full permissions.
- **Reject** asks **Reject and delete**: it deletes the node's public key, so the node must enroll
  again with a new token.

Until approval the node has a restricted connection: it may say hello, ping and send facts, and it
receives no tasks or trust report ([Restricted
connections](../design/protocol.md#restricted-connections)). The procedure is also in [Approve a
node](install.md#approve-a-node).

### Adding an SSH node

An SSH node needs no crha. **New SSH node** opens a four-step wizard:

1. **Credential**. Choose an existing SSH credential or create one with **New credential**. The
   private key stays in crhs; the page shows the public key, which must be appended to
   `~/.ssh/authorized_keys` of the target user on every hop (each jump host and the target) before
   you continue.
2. **Target**. Describe the target's **Host**, **Port** and **User**, and add any jump hosts before
   it with **Add jump host**; a jump host can be moved **Up** or **Down** or removed. **Node name**
   is optional and defaults to the target's host.
3. **Host keys**. Choose **Check the next host key**; the wizard shows the fingerprint the host
   presented. Compare it with the output of
   `for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done` on that host; choose **It
   matches, pin it** only when one line matches. **Discard** rejects the candidate. Every hop must
   be pinned before you can continue; the step says **All host keys are confirmed.** when done.
4. **Create**. Review the node name and the route, and choose **Test connection** to authenticate
   hop by hop and run a trivial command on the target. **New node** creates the node; it is active
   immediately and the browser opens its page.

The pinned host keys are enforced on every later connection. The server-side procedure and the
requirements on the remote account are in [Add an SSH node](install.md#add-an-ssh-node) and [Adding
an SSH node](../design/execution.md#adding-an-ssh-node). An SSH credential cannot be deleted while a
node uses it.

### The node page

The back link is **All nodes**. The header shows the node's name, its status, the **SSH** badge for
an SSH node and the clock warning. An administrator gets **Edit node groups**, **Rename** and
**Delete node**. Trust-warning chips, when present, sit above the facts.

The facts panel lists **Transport** (**crha client** or **SSH**), **Hostname**, **OS**, **Privileged
mode** (the configured mode, or **ignored (SSH)**), **Node groups**, and for a client node the
**Client** version, **Last seen** and **Key fingerprint**. A **Clock** line appears when a clock
warning exists, and **Node id** follows. A collapsible **Facts (N)** block shows the raw facts the
node reported.

#### Last seen

`last_seen_at` is written when a crha connects, says hello or disconnects. A node that stays
connected would therefore read "9 hours ago" while it is online, so a connected client node shows
**Now**, with **Connected since <absolute time>** as its tooltip. A disconnected node and an SSH
node keep the relative time.

#### Trust and the trust report

Client nodes have a **Trust** section. It shows the last trust report the node pushed, not a live
query:

| Field | Meaning |
|---|---|
| **Report** | **OK**, **Unavailable**, **Not applicable** or **not reported**. A stale report is marked as the last report until the node reconnects. |
| **Message** | The node's explanation, when it sent one. |
| **Digest** | The digest of the trust configuration. A change of digest is a configuration change. |
| **Updated** | When crhs last received a report. |
| **Aliases** | The node's trust aliases (UUIDs), each with its node group's current name when the UUID names one. |
| **Authorization clock tolerance** | The configured `clock_skew` used when checking an authorization's `issued_at` and `deadline`. It is not a measured offset. |
| **Unprivileged identity** / **Privileged identity** | The user, uid and gid each mode runs as. |

The trust-entry table has **Name**, **Role**, **Format**, **Kinds**, **Flags**, **Max TTL** and
**Key**. Each entry has an expandable block with its **Allow** and **Deny** rules, its **Environment**
allowlist and, for an SSH key, its **Public key**. With no entries the section says **The node trusts
nobody**.

The hints under the report are specific:

- **Not applicable** means the privileged mode is not `forward`, so the node uses no trust
  configuration.
- **Unavailable** means the privileged mode is unreachable, so the trust configuration is unknown.
- **not reported** means the node has not sent one.
- A stale report says it is the last report, stale until the node reconnects.

The report comes from the trust cache; the rules behind it are in [Trust
cache](../design/privilege.md#trust-cache). The measured clock offset is shown only by the status
warning, never here.

Below the report, the page can build the `[[trust]]` block for the node's `privileged.toml`
in **Trust configuration**. The page only exports the fragment; the node enforces it. On a
`forward` node that belongs to node groups, an administrator also sees **Aliases for
privileged.toml** with the top-level `aliases` line and a copy button. An administrator also sees
the crhs signing-key panel for the trust entry that lets crhs sign authorizations.

#### Clock warning

When the offset crha measured during the handshake exceeds `clock_warn` (60 seconds by default), the
node shows a warning triangle and **clock** next to its status. The tooltip reads **The node's clock
is <n> s ahead of crhs (measured once when crha connects)** or **behind crhs**. The measurement
happens once per connection and is diagnostic: it never refuses work. The tolerance used for
authorizations is the separate `clock_skew` shown in the trust report. Both are in [Clock
synchronization](operations.md#clock-synchronization) and [Clock](../design/privilege.md#clock).

#### SSH route, access and recent tasks

An SSH node shows its route as a table with **Hop**, **Address** and **Pinned host key**, its
credential and **Test connection**. The route and credential are administrator data; the server
omits them for other viewers.

**Access** lists the users and user groups that hold a grant on the node; it is administrator-only
([Granting node access](#granting-node-access)). **Recent tasks** lists the newest ten tasks on the
node, with **View all tasks** at the right of the heading opening `/tasks?node=<nodeId>`. Tasks are
started from the Tasks page, not from the node page; the node page has no run panel.

#### Deleting a node

An administrator deletes a node from its page with **Delete node** in the header. The confirmation
names the node and explains the consequences:

- A crha node is told it was removed; crha disconnects and stops. An SSH node's host is not
  contacted, because no crha runs there.
- Tasks waiting for the node end as `failed/node_deleted`; a task already running loses its
  connection and ends as `unknown` ([Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys)).
- Its access grants and node group memberships are removed. The node's record and public key are
  gone, so the next handshake fails.
- An SSH node's credential stays in **SSH credentials**.

Deleting a record does not touch the host. To use a crha host again, create a new enrollment token
and enroll it after removing `identity.key` and `server.pub`; to reuse its name, delete the old node
first ([Rotate a node key](operations.md#rotating-and-revoking-node-keys)). A pending node keeps its
**Approve**/**Reject** actions in the list; rejecting it is the same deletion.

## Node groups

**Node groups** lists every group with **Name**, **Members** (the count and links to each node) and
**Node group id** (a copy button). An administrator gets **New node group**; everyone else sees the
list read-only. Row click opens the group.

The group page shows the id with a copy button, a **Members** table with **Node**, **Status** and
**Hostname**, and, for administrators, **Edit members** in the section header plus **Rename** and
**Delete** in the page header. **Access** lists the grantees and **Add access** grants another user
or user group ([Granting node access](#granting-node-access)).

Deleting a group removes its members from it. Rules, task groups and access grants that reference the
group keep the UUID and display it as a deleted node group; they do not silently start matching
something else. A group's UUID is also what a node's `aliases` list in `privileged.toml` usually
contains ([Node groups and names](../design/access-control.md#node-groups-and-names)).

## Users and user groups

### The users list

**Users** is administrator-only. The table shows **Username**, **Display name**, **Kind**,
**Status** and **Created**. **Kind** is **Administrator** or **Member**; **Status** is **Active** or
**Disabled**. **New user** is the page action. The whole row opens the user's page. The list has no
in-row edit, disable or reset control: those live on the user's page.

**New user** asks for **Username**, **Display name**, **Kind** and an optional **Password**. A user
without a password cannot sign in until an administrator sets one.

### The user page

The back link is **All users**. The title is the display name, or the username when it is empty. An
administrator gets **Disable** (or **Enable** for a disabled account) and **Reset password**; the
first asks for confirmation, and you cannot disable your own account. The facts are **Username**,
**Display name**, **Role** (a select for an administrator, plain text otherwise), **Status** and
**Created**. An administrator cannot change their own role; the server also refuses a change that
would leave the organization without an active administrator.

A member may open their own page; any other id shows the same message as a missing user: **This user
doesn't exist or you don't have access.** A member sees no edit control.

The page continues with the user's **User groups**, the admin-only **Node access** table, and
**Recent sessions** and **Recent tasks** (the first ten each) when you are an administrator or the
user themselves. **View all tasks** opens `/tasks?user=<id>`. There is no equivalent link for
sessions, because the session list has no owner filter.

### User groups

The lower part of the users page is the **User groups** table: **Name**, **Members** and **Created**.
**New user group** is that section's action; a row opens the group. Members are edited on the group
page, not in the list.

The group page shows its name, **Created**, a **Members** table with **User**, **Role** and
**Status**, and **Add member** at the right of the section header. Each row has **Remove**, which
confirms and then removes the membership; the member loses the node access the group grants.
**Rename** and **Delete** are in the page header. Deleting a user group removes its shares and the
access it grants.

A user's page has **User groups** as a table of the groups they belong to, with **Add to user group**
(an administrator action) and a **Remove** per row. Adding a user to a group gives them everything
the group has been granted, effective immediately.

### Granting node access

Node access is administrator-only and one level deep: a grant gives a user or a user group the
ability to see a node or every node of a node group and run tasks on it. There is no read-only node
grant; the rule chain and the approval flow decide what may run.

- On a **node** or **node group** page, **Access** lists the grantees with their **User** or **User
  group** badge, the creation time and **Remove**. **Add access** opens a dialog with a user/user
  group picker; a group grants access to every current member.
- On a **user** or **user group** page, **Node access** lists the targets with their **Node** or
  **Node group** badge and **Remove**, and **Add access** opens a node/node-group picker. Existing
  grantees or targets are excluded from the picker.
- The same grant works in both directions; removing it takes effect at once. A waiting task whose
  `on_behalf_of` user loses node access ends.
- Nodes themselves belong to the organization, not to the user who enrolled them. An administrator
  sees every node; a member sees only granted nodes.

## Approvals

**Approvals** collects everything that waits for the signed-in user. The sidebar badge and the page
count use the same list: task approvals, task-group approvals, tasks and task groups waiting for
your signature, and roots whose token quota is used up. A waiting task group counts once.

The page has four sections, each absent when its list is empty:

| Section | What it holds | Decision |
|---|---|---|
| **Task approvals** | Tasks held back by a rule. | **Approve**, **Approve and always allow…** or **Reject**. |
| **Task-group approvals** | One decision for every node in the group; the card shows the rule chain per node where one was recorded. | The same three actions for the whole group. |
| **Waiting for your signature** | Tasks and task groups that passed their rules and run after the owner signs a privileged payload. | A Passkey button or a pasted `crha grant` result on the task or group page. |
| **Token quota used up** | One quota card per paused root, with its remaining budget. | Add tokens, or **Stop** the run. |

Each approval card shows the task or group, whether it is **Privileged**, the **Command / path**,
**Asked by**, **Requested** time and the rule chain. The rule chain table has the four columns
described under [The task page](#the-task-page). **Reason (optional, used when rejecting)** is
recorded with a rejection. **Approve and always allow…** opens a small form that pre-fills an
`exact` or `prefix` rule from the operation; the rule is added to the caller's rule set, and only an
`allow` rule can be added this way. A one-off approval writes no rule.

Decisions go through the same cards and mutations as the waiting cards inside a session, so the
badge and the page update together. With nothing pending the page says **Nothing is waiting for
you**.

An approval has no deadline. It waits until a handler or the owner decides, until a rule change
removes the need, or until the API token that started it is revoked or expires. A signature wait is
different: it expires after 24 hours and also ends when its session is stopped or its run ends
([Waiting for signatures](../design/privilege.md#waiting-for-signatures)). The routing rules — up the
chain to the first allowing agent, then the review model for Auto Review, then the owner — are in
[Approvals](../design/access-control.md#approvals).

The deep links `/approvals/tasks/<taskId>` and `/approvals/task-groups/<taskGroupId>` are the URLs
MCP and agent tools hand out. They show the card while the subject waits; otherwise they say
**Already settled** and link to the task or group. **All approvals** is the back link.

## Authorizations

**Authorizations** is the administrator-only list of stored authorization objects. It answers "what
has been signed for which nodes, for which command, until when". A regular user may submit an
authorization from a signing card but cannot list the organization's.

The table has **Created**, **Issuer** (a user link, or **crhs** when crhs signed it), **Nodes**,
**Command**, **Deadline** and **Tasks** (`reusable`, or the number of one-shot tasks), plus a
**Payload** button. **Payload** opens a dialog with the id, issuer, issued and deadline times, the
attempt, the command limit (`<method> exact <target>`, `<method> prefix <target>` or **any method and
target**), the nodes, the tasks and any note.

An authorization is valid on the nodes its payload names until its deadline and, for a one-shot
authorization, until it is used up. It cannot be revoked here: withdrawing a signer's permission
means changing the node's trust configuration and reloading it ([Revoking
trust](../design/privilege.md#revoking-trust)). The list is a record of what was signed, not a
control panel.

### Signing with an SSH key or a Passkey

When a privileged task or task group waits for its owner's signature, the task page, the task-group
page and the session show the same card, **Waiting for your authorization**; the Approvals page
lists the wait and links to it. The card decodes the payload and offers three ways to sign.

- **Passkey.** If one of your Passkeys is trusted by the node for this command, a button **Sign with
  Passkey “<name>”** appears. It runs the browser's WebAuthn prompt for that credential. If none
  matches, the card says **No Passkey of yours is trusted by this node for this command; sign with
  your SSH key below.** A Passkey signature is bound to one relying party; a task group spanning
  nodes with different RPs offers one button per credential.
- **`crha grant`.** The card shows the exact command and a **Copy crha grant command** button. Run it
  on your workstation; it decodes the payload for confirmation and prints the authorization. Paste
  the output into **Authorization from `crha grant`** and choose **Submit authorization**.
- **By hand.** The card also shows an `ssh-keygen` recipe with a copy button: `ssh-keygen -Y sign -n
  crh-auth-v1` over the payload, using a key that OpenSSH can use (an encrypted key, an agent or a
  FIDO key).

The signature is bound to the attempt. If the plan changes while the task waits, the card shows a
new payload and signatures for the old one are invalid. A local approval may be available instead:
the card then says you can run `crha approve <task-id>` on the node, if a `local` trust entry allows
your uid there ([Local approval](../design/privilege.md#local-approval)). The payload, the signature
formats and the validation steps are in [Signing
methods](../design/privilege.md#signing-methods) and [Authorization
path](../design/privilege.md#authorization-path).

Your credentials are managed on **Credentials** (the sidebar item under Cluster), not here:

- **Add an SSH key** takes one `authorized_keys` line (`ssh-ed25519`, `sk-ssh-ed25519@openssh.com`,
  `ecdsa-sha2-nistp256` or `sk-ecdsa-sha2-nistp256@openssh.com`) and an optional name.
- **Add a Passkey** registers a platform authenticator or a security key (ES256, EdDSA or RS256).
- Each credential's **Trust snippet** is the `[[trust]]` block to paste into the node's
  `privileged.toml`; **Delete** removes the credential, and nodes that trusted it stop accepting its
  signatures.

## Schedules

**Schedules** lists the schedules you own. A schedule creates a new session at each trigger and
submits a fixed prompt; the run then acts as the schedule's owner through the same rules, approvals
and limits as any other session. The table shows **Name**, **Cron** (with its timezone and a preview
error when the stored zone is invalid), **Next run**, **Status** and **Enabled**, plus a per-row **Run
now**. A disabled schedule shows **Disabled** and no next run.

**New schedule** opens the same form as the detail page:

| Field | Notes |
|---|---|
| **Name** | A label for the list. |
| **Prompt** | What the new session should do; the run submits this text. |
| **Model** / **Thinking level** | The model of each new session. |
| **Rule preset** | **Ask**, **Auto Review** or **Yolo**, with a warning under it: Ask can pause the schedule while it waits for confirmation; Yolo runs every action without asking or checking. |
| **Token budget** | Optional; empty means unlimited. |
| **Cron** | Five fields: minute, hour, day of month, month, day of week. |
| **Timezone** | An IANA name; a live preview lists the expected triggers. |
| **Catch up a missed trigger immediately** | After downtime, the most recent missed trigger runs once instead of being skipped. |
| **Enabled** | Whether the schedule may trigger. |

**Save schedule** stores an edit; the list's **New schedule** dialog closes with **New schedule** and
opens the new schedule. **Run now** starts a run immediately. If an instance is already running (or
claimed and pending), crhs asks **Run <name> now?** and explains that this stops the current run and
records it as preempted; **Stop it and run now** confirms. The **Enabled** switch turns the schedule
on or off without deleting it.

The detail page shows **Last result:** and the status, the form, a **Run history** table and a
**Privileges** note. Run history has **Triggered for**, **Status**, **When**, **Session** and
**Note**; a run with a session links to it, and a manual run is marked **run by hand**. The history
is separate from the sessions: every run links the session it created.

**Privileges**: a scheduled run uses the normal authorization path, so a privileged task waits for
the owner's signature. To let a fixed command run unattended, create a reusable authorization for it
(no task ids, for example with `crha grant --nodes ...`) and have the prompt run exactly that
command. The **Authorizations** page lists the stored authorizations; it does not issue them.
Anything else still waits in Approvals, and the next trigger ends the run. At most one instance of
a schedule runs at a time, and a schedule belongs to its creator: it cannot be shared. The rules and
lifecycle are in [Scheduling](../design/scheduling.md#schedule-model) and [Triggering and
submission](../design/scheduling.md#triggering-and-submission).

## Models

Model settings are administrator-only. The sidebar item is **Models** and the page is
`/settings/models`; it is the console's only settings page. It shows the three model presets first
and the providers after them.

### Model presets

There is one card each for **Session**, **Auto review** and **Title generation**:

- **Session** edits only a **System prompt**. Its model is the session's own. Changes take effect on
  the next model request.
- **Auto review** and **Title generation** choose a **Model** — including **Use the session's
  model** — and a **System prompt**. Auto review also chooses a **Thinking level**.
- An empty prompt means the built-in default. **Default prompt and protocol** expands to show that
  default and the fixed protocol note that is always appended.
- **Save** updates the preset. A provider or model that is removed stops appearing in the lists; a
  preset that still names it keeps that reference until you choose another model. The rules are in
  [Model presets](../design/agent-runtime.md#model-presets).

### Providers

The **Model providers** table has **Id**, **Kind**, **Name**, **Base URL**, **API key** (**Set** or
**Not set**), **Status**, **Models** and **Edit**/**Delete** actions. **New provider** opens the
provider dialog.

| Kind | Fields |
|---|---|
| **Pi built-in** | Choose one of the library's providers, enter its **API key** and optionally a **Base URL** that overrides the default endpoint. Only API-key authentication is supported. |
| **Custom** | **Provider id** (lowercase letters, digits and dashes), **Name**, **Base URL**, **API key**, **Extra headers**, **Session id fields**, and the provider's **models**. |

- The stored key is never shown back. Leave **API key** empty to keep the current key, or tick
  **Remove the stored key** to delete it. Changing the **Base URL** of a custom provider that has a
  stored key requires re-entering the key, because the key would otherwise be sent to a new endpoint.
- **Extra headers** are stored and displayed in plaintext; do not put API keys or `Authorization`
  tokens there. Use the API key field. **Session id fields** name request headers and request-body
  dot paths that receive the CRH session id for gateways that route by it.
- A custom provider's **Models** table lists **Id**, **Protocol** (**Chat Completions** or
  **Responses**), **Context window**, **Max output**, **Image** and **Thinking**. **New model** opens
  a nested dialog for the model id, display name, protocol, context window, maximum output tokens,
  image understanding, thinking mode and the advanced `compat` JSON. Standard thinking maps each
  level to a format value; custom thinking takes a JSON body per level. Every level needs a display
  name to be offered, except **Off**, which cannot be hidden.
- **Delete** a provider after confirmation. Its models disappear from the composer and the presets,
  its key is deleted, and existing sessions that use its models stop working until their model is
  changed.

The model list feeds the composer and the presets, so a provider or model that is removed stops
appearing in both. The underlying fields are in [Model
configuration](../design/agent-runtime.md#model-configuration) and [Custom
providers](../design/agent-runtime.md#custom-providers).

## API tokens

**API tokens** lists the tokens you created. A token is a bearer credential for an MCP client or
automation; it belongs to you and acts for you. The table shows **Name**, **Rule preset**,
**Created**, **Expires** (**Never** or a time), **Last used** and **Status** (**Active**,
**Expired** or **Revoked**). The action column depends on the status: an active token has **Rules**
and **Revoke**; an inactive one has **Delete**.

**New token** asks for:

| Field | Notes |
|---|---|
| **Name** | Up to 100 characters; a name such as **Claude Code on the laptop** is useful later. |
| **Rule preset** | **Ask** or **Yolo** only. Auto Review needs a user's instructions and a token has none. **Ask** allows ordinary reads and sends everything else to you; **Yolo** lets the token run anything without asking. If you choose Yolo, a warning says so. |
| **Expires after** | **30 days**, **90 days** (the default), **365 days** or **Never**. A token that never expires stays valid until revoked; the dialog warns about that. |

The dialog then shows the secret once. Copy it then: it cannot be retrieved later. The same dialog
shows **Connect Claude Code with:** and the exact `claude mcp add` command, with a **Copy command**
button ([Using CRH as an MCP server](mcp.md)). Close the dialog when you have stored the secret.

**Rules** opens the token's rule editor: the preset can be changed with **Save rule preset**, and
the **Added rules (JSON)** box holds the rules on top of the preset, with the same fields as a
session's rules (`action`, optional `method`, `nodes`, `exact` or `prefix`). Save with **Save rules**.
**Revoke** asks for confirmation and stops anything using the token immediately; it cannot be
undone. **Delete** removes an inactive token but keeps its audit trail. A password change does not
revoke your tokens unless you tick the box in the password dialog. The storage, expiry and rule-root
rules are in [API tokens](../design/access-control.md#api-tokens).

## Audit

**Audit** is the append-only log. An administrator sees every event; everyone else sees the events
recorded on their behalf. The table shows **Time**, **Action**, **By**, **On behalf of** and
**Target**; a target that is a task or a node is a link. Clicking a row opens **Event <seq>** with
the action and the event's `detail` JSON.

The filter form takes **Action**, **Target type** and **Target id**, and applies with **Filter**. An
action ending in `.` is a prefix filter, so `task.` matches every task event. The table loads newest
first, one cursor page at a time.

The log records decisions and actions, not conversation content: logins and failed logins, user and
token changes, node enrollment and approval, trust changes, task creation, approval, review and
finish, authorizations issued or submitted, session and tool calls, rule and schedule changes, and
provider and preset changes. Model calls are not audit events; their tokens and timing are session
statistics. The event categories are listed in [Recorded
events](../design/access-control.md#recorded-events).

The log is append-only but has no hash chain, and the application's database account can write it.
Its tamper evidence comes from copying it to a system outside crhs; the node's privileged mode also
keeps its own log. See [Audit](security.md#audit) for the operator's view and
[Tamper resistance](../design/access-control.md#tamper-resistance) for the reasoning. Entries older
than `[retention].audit` (180 days by default) are deleted, except the newest 16384 sequence numbers.

## Settings

The console has no general settings page. Settings are split by what they configure:

| Setting | Where |
|---|---|
| Model presets and providers | **Models** (`/settings/models`), administrators ([Models](#models)). |
| Users, user groups and node access | **Users** ([Users and user groups](#users-and-user-groups)). |
| Signing credentials | **Credentials** ([Signing with an SSH key or a Passkey](#signing-with-an-ssh-key-or-a-passkey)). |
| SSH keys used by crhs | **SSH credentials**, administrators. |
| Audit retention and other server settings | `crhs.toml`, then restart crhs ([crhs configuration reference](reference/crhs-config.md)). |
| Your theme, language and password | The user menu ([Themes and language](#themes-and-language)). |

**SSH credentials** is the organization's key store for SSH nodes. It shows **Name**, **Public key**,
**Created** and **Used by**, with **New SSH credential**. The private key never leaves crhs. A
credential that a node uses cannot be deleted, and an existing SSH node's credential cannot be
changed; replacing one means deleting the node and adding it again.

## Themes and language

The user menu switches the console's appearance and language without a reload.

- **Theme**: **System**, **Light** or **Dark**. **System** follows the operating system while it is
  selected. The choice is stored in this browser under `crh.theme` and applied before the first
  paint, so a dark page does not flash light.
- **Language**: **English** or **中文 (简体)**. The first visit follows the browser's preferred
  languages (`zh*` selects Chinese, everything else English). The override is stored under
  `crh.locale`, and switching updates the document language without a reload.
- Enum labels (task states, rule presets, model presets, audit actions) are translated. A value the
  console does not know stays visible as its raw server string, so a new state is diagnosable before
  its translation lands. Server error messages and agent output are not translated.

The collapsed sidebar state (`crh.sidebar.open`) and the model of the last created session
(`crh.newSession.model`) are also kept in this browser's storage. None of these preferences follows
you to another browser or device. The details are in [Theme and design
tokens](../design/webui.md#theme-and-design-tokens) and
[Internationalization](../design/webui.md#internationalization).
