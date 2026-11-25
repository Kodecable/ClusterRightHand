# Using the WebUI

What you see depends on your account: administrators manage the cluster, members work with the nodes
and sessions available to them. The objects are introduced in [Concepts](concepts.md).

## Signing in

Sign in with your username and password. By default the page first runs an invisible security check
(a short proof of work) to slow down password guessing. Administrators create accounts and reset
forgotten passwords; there is no self-service reset.

| Message | Meaning |
|---|---|
| Invalid username or password. | Wrong credentials, or the account is disabled. |
| Too many failed attempts. Try again later. | 10 failures in 15 minutes from your address. |
| Another sign-in from this address is already in progress. | Retry in a moment. |
| The server is busy. | Retry in a moment. |
| Security verification failed. | The security check failed twice; reload and retry. |

You stay signed in for seven days or until you choose **Log out**. Links opened while signed out
return you to the same page after signing in.

**Change password** is in the user menu at the bottom of the sidebar. Changing your password signs out
your other browsers. Your API tokens keep working unless you tick **Also revoke all of my API tokens**.

## Navigation

| Group | Items |
|---|---|
| **Work** | Sessions, Library, Schedules, Tasks, Approvals |
| **Cluster** | Nodes, Node groups, SSH credentials (administrators), Signing credentials |
| **Admin** | Authorizations, API tokens, Audit, Extensions (administrators), Channels (administrators), Models (administrators), System settings (administrators), Users (administrators) |

The **Approvals** badge counts everything waiting for you. **Settings…** in the user menu sets your
language (English or Chinese) and your defaults for new sessions; the language follows your account, so
it is the same in every browser. The theme stays in the user menu and is stored in your browser.

Lists update by themselves; there is no refresh button. Editing happens on an object's own page.

## Extensions

Extensions give agent sessions tools beyond the cluster tools. An administrator manages them under
**System settings → Extensions**, which lists both kinds in one table with their kind, connection state,
tool count, availability and whether they are enabled. There are two kinds:

- **MCP extensions** connect to a Streamable HTTP MCP server. Each needs a name (lowercase letters,
  digits and `-`), its URL and optionally fixed request headers, which are stored encrypted and never
  shown again. Changing a URL therefore asks for the headers again or for removing them. Leave the
  description empty to use what the server reports about itself. crhs connects only when it needs the
  server and closes an idle connection after 10 minutes; the tool list is refreshed daily and kept between
  connections. **Reconnect** connects and lists the tools at once; **Tools** lists what the server offers.
- **Built-in extensions** ship with crhs: `crhs-docs` serves the documentation and the API reference,
  `crhs-api` lets a session make crhs API requests as its owner, and `crhs-ds-search` searches the web and
  fetches pages through DeepSeek's Search and Fetch APIs. They cannot be deleted; an administrator can
  disable one, change whether its tools are listed directly, and set its availability, grants and
  settings. `crhs-ds-search` ships disabled: enter a DeepSeek API key in its settings first, since every
  successful search or fetch is billed to that account. A built-in's description is fixed by crhs. `crhs-docs` offers `search_docs` (keyword search over the documentation and the
  API reference, with the path, heading and a snippet of each match) and `read_doc` (a directory listing, a
  Markdown outline or one section with its subsections, and whole text files, paged when long). The API
  reference is rendered from the running version's API document, one page per tag; routes an agent may not
  call are left out. It stays available when
  `crhs-api` is turned off, because it also explains what the WebUI does. `crhs-api` offers `api_request`,
  which makes one API request (`method`, `path`, `query`, `body`) as the session's owner through the same
  routes, validation and audit as the WebUI; a request that needs approval shows its method, path, query
  and body.

**Availability** decides who may use an extension: **Everyone**, or only the granted users and user
groups. Built-in extensions default to everyone; MCP extensions to granted only. **List directly** puts
a small extension's tools into the model's tool list; otherwise the agent finds them with search and
calls them through the same rules and approvals as cluster tools. A change to the flag, the availability,
the grants or an MCP server's tool list applies from the session's next request.

In a session, the plug control beside the composer turns single extensions off. A new session has every
available extension on, and a subagent cannot turn on what its parent turned off. Extension calls that
need approval go up the session chain like task approvals: the nearest ancestor agent whose rules allow
the call may approve, reject or pass it on; otherwise it appears in the session's decision panel and on
the Approvals page, with the extension, tool, annotations and arguments. For `api_request` the panel
shows the method, path, query and body instead. **Always allow** offers the exact rule or a prefix: the
whole extension for an MCP tool, or the called API route for `api_request`.

## Sessions

The session list shows your sessions and those shared with you, grouped by last activity. A spinner
means the session is running, an amber dot that it waits for a decision, and a blue dot that it has a
reply you have not read. **Scheduled** and **Shared** badges mark sessions started by a schedule or
shared with you.

### Starting a session

Choose **New session** and send your first message; the session is created with it. The draft starts
with your default model and rule preset from **Settings → Sessions**, or with the first available model
when you have not chosen one. Changing the model, thinking level or rule preset on the draft saves that
choice as your new default. If no model is configured, an administrator must add one first
([Models](#models)).

### The session page

- **Enter** sends, **Shift+Enter** adds a line. You can send while the agent works; the message is
  queued.
- **Stop** stops the session and all its subagents.
- `/compact` summarizes older parts of the conversation to free context.
- Tool calls appear as one-line rows; click one to see its arguments, output and result. When the final
  answer ends, the agent's intermediate steps fold into one line that you can expand; the answer streams
  unfolded first. A `copy_file` that hands you a file is an ordinary tool row, and when the turn ends each
  delivered file gets a small box with its name, source and size: click it to download, and an image can
  be previewed. The file is checked when you click, so the box keeps working while you have access.
- Click the title to rename the session. Clearing it restores the default name and stops automatic
  titling.

The composer footer holds the **model**, the **thinking level**, the **rule preset** (Ask, Auto Review
or Yolo; see [Rules and approvals](concepts.md#rules-and-approvals)) and the **budget**. Changes apply
from the agent's next step. Below the composer, a line shows turns and generation speed, token usage
with the cache hit rate, and how full the context is.

### Attachments

The owner of a session can attach files with the **+** beside the composer: **Upload files** sends a
file to the owner's library under `attachments/<year>-<month>/`, and **Choose from library** picks an
existing library file. You can also paste a file or drop it on the composer. Each attachment shows as a
chip with its upload progress and a **remove** button; sending waits for the uploads to finish, and a
failed attachment must be removed before the message can be sent. Only the session owner can attach
files; the server refuses attachments from anyone else.

An attachment becomes part of the message the agent reads: a short text file has its content included
in the message, up to the limits in System settings, and everything else is described by its name, size,
library and path. To see an image, the agent calls its `view_image` tool. The transcript shows each
attachment as a chip that links to the library file; the chip resolves the library by id, so renaming a
user group does not break it, and a chip is inactive, with the reason, when the file is gone or you cannot
reach its library. Deleting a session leaves its attachments in the library.

### Waiting for a decision

When the session or one of its subagents needs you, a decision panel replaces the composer at the
bottom of the session and the messages stay visible above it. It shows one request at a time — a rule
approval, a signature request for a privileged task, or a used-up token budget — oldest waiting first,
with a count while more wait. Answer it and the next one appears; the composer comes back when nothing
is waiting for you. The same request is on the [Approvals](#approvals) page.

### Subagents

When the agent starts subagents, a strip above the composer shows how many there are and how many are
running or waiting. Click it to open them. Each subagent is a session of its own, with a breadcrumb back
to its parent.

### Sharing

The owner can share a session with users or user groups, for **View** or **Chat**. A shared session
still acts as its owner, so messages sent by others run with the owner's access and the session's rules.
Administrators can see every session, but can send messages only when it is shared with them for chat.

## Session search

Press `Ctrl K` (`⌘K` on a Mac) anywhere, or click **Search sessions…**. Separate keywords with spaces;
every keyword must match. Choosing a matching message opens the session at that message.

With PostgreSQL, search covers titles and message text. With SQLite, only titles are searched.

## Libraries

Every user has a library, and so does every user group. A library holds whole files under paths; there
are no folders, and a directory exists only while a file is under it. **Library** in the sidebar opens
your own library. The control at the top right names the current library by its owner's display name
and opens a picker of your own and your user groups' libraries; administrators can pick any user's or
user group's library there.

- The share of the total size limit in use is shown beside **Upload**, with a bar for the limit that
  is closest to being reached. Hover it for the file-count and total-size ratios; a warning appears near a limit, and when
  a limit is reached, uploads and overwrites are refused with the limit they hit. **0** means the
  library allows nothing until an administrator raises its limit.
- **Upload** or drop files on the page to add them at the current path. They upload one at a time in a
  dialog showing the overall progress, the speed and the time left; a refused file is listed with the
  server's reason and the rest continue, and **Cancel** stops the remaining uploads.
- A file row offers **Download**, **Move or rename** and **Delete**; a small PNG, JPEG, GIF or WebP
  also offers **Preview**. Anything else is downloaded, never shown inline.
- **Move or rename** takes a full path; a `/` in it creates the directories. An existing target is
  refused, so a move never overwrites a file.
- **Delete** asks for confirmation and removes that one file. Deleting all files is the only way to
  empty a library.
- An administrator changes a library's three limits with **Edit limits** on the user or user group page.
  Lowering a limit below the current usage keeps the files and refuses new writes until files are
  deleted.
- A user group whose library still has files cannot be deleted; the error names the file count and
  links to the library, where the files can be deleted first.
- `AGENTS.md` at the root of your own library holds standing instructions for your sessions: crhs adds the
  file to a session's system prompt when the session starts, up to 32 KiB. A larger file is not included;
  the model is told its size and reads it with `read_file`. Group libraries and deeper paths are not read,
  and a change applies to sessions started afterwards.

Use the path in your browser's address bar to link a location: `/library/user:alice?path=docs` opens
Alice's library in `docs`.

## Tasks

**Tasks** lists the tasks you started or that ran on your behalf; administrators see all tasks. Filter
by state, by who started the task, or by node. Node and user pages link here with **View all tasks**.

### The Run task dialog

**Run task** runs a command or file operation directly, without an agent:

1. Choose nodes or node groups, or tick **All nodes I can access**.
2. Choose the kind (`exec` or a file operation) and fill in its fields. Tick **Privileged** if the task
   needs privilege.
3. Under **More options**, set how many nodes run at once, whether to stop after the first failure,
   and whether to keep output.

One node creates a task; anything else creates a task group. Either way the new task or group opens.
Tasks you run yourself skip the rule chain, but still need node access.

### The task page

The header shows the state and outcome, for example **Finished · Exit code 3**. **Stop task** cancels a
running task. Below are the task's details, any pending approval or signature, the rule chain
evaluation, and the output.

The **rule chain evaluation** shows each level of rules that applied:

| Column | Meaning |
|---|---|
| **Level** | The session, schedule or API token |
| **Matched rule** | The rule that matched, or **Default** |
| **Rule result** | This level's own result |
| **Cumulative result** | The result so far, from the top level down; the last row is the decision |

The output shows the beginning and end of the task's combined output. The complete output stays on the
node, in the file listed under **Output file**; SSH nodes keep none.

## Task groups

A task group page shows the group's state, one decision for the whole group (approve it, or sign it
when it is privileged), and a table with one row per node; each row opens that node's task. Nodes that
never started are listed as skipped.

## Nodes

### The node list

| Status | Meaning |
|---|---|
| **Pending approval** | Enrolled, waiting for an administrator |
| **Connected** / **Offline** | A crha node with or without a connection |
| **Active** | An SSH node; it has no standing connection |

A **clock** warning means the node's clock differs from crhs's
([Clock synchronization](operations.md#clock-synchronization)).

The node list opens as cards; **Cards** / **Table** in the page header switches between them and your
choice is remembered in this browser. A card shows the node's name, status, SSH badge and warnings (the
warnings sit before the status, at the right end of the name row), its node groups and the same
approve/reject actions as a table row, then CPU, memory and disk usage, total traffic, uptime (or last
seen for a node that does not report one) and the node's user remark. Live traffic is in the node
page's **Overview** summary, not the card. A value the latest sample lacks shows "–"; the details sit
in the card's tooltips, such as the filesystem's name and when the traffic period started and resets.
Click the card,
or focus it and press Enter, to open the node page; the links and action buttons inside it do their own
thing. The table view keeps the **Metrics** column with each node's CPU and memory use from the latest
sample. A sample older than three collection intervals is dimmed; a node with no sample yet shows
nothing.

The user remark is the bottom line of each card. Administrators click it to write one line about the
node: Enter or clicking elsewhere saves, Escape cancels, and clearing the text removes the remark. It is
shown truncated, with the full text on hover; everyone else reads it without an editor, and an empty
remark is not shown to them at all. The node page's **Overview** repeats a set remark as a **User
remark** row.

A node or node group can have an emoji, shown just left of its name in the lists, the node cards and
the detail page headings. On a node's or a node group's page an administrator clicks the emoji, or the
small smiley-plus button beside the name, to open the emoji picker: search for one, pick it, or
**Remove emoji** to clear it. Everyone else sees the emoji without a way to change it. The picker is
part of crhs, so it works without internet access.

Beside the status, **Metrics** marks a node whose metrics collection is currently failing, and it is
shown only while the node is online; the reason and the time it started are on the node page.
**Update available** marks a crha node whose release is older than crhs's own, with **Upgrade crha** on
the node page when you are an administrator.

### Adding a crha node

Administrators choose **New node**, optionally enter a name, and copy the command, the crhs address
and the one-time token. Run it on the node as described in [Enroll a node](install.md#enroll-a-node).

### Approving a pending node

Before choosing **Approve**, compare the key fingerprint shown in the dialog with the output of
`crha status` on the node. **Reject** deletes the node; it must enroll again.

### Adding an SSH node

Create each credential on the **SSH credentials** page and install its public key on the hops that use
it; each hop picks its own credential. **New SSH node** then takes the name and route (jump hosts first,
the target last), with a credential for every row; pin each hop's host fingerprint, then test the
connection and create the node. See [Add an SSH node](install.md#add-an-ssh-node).

### The node page

The node page has an **Overview** tab, a **Metrics** tab and a **Files** tab. The Overview has the
node's facts, the newest-sample metrics summary and the CPU and memory charts below them, its access
grants and its ten most recent tasks. An SSH node's **SSH** badge sits after its name in the heading.

The **Overview** shows five cards from the newest sample: uptime, CPU usage, memory usage, the first
filesystem's disk usage and live network traffic. Usage turns amber from 60 % and red from 80 %; a card
with no data shows "–" instead of disappearing. The disk card names its filesystem only in a tooltip.
Live traffic shows the newest received and transmitted rate, each after an arrow; its tooltip and
accessible label give the values per second.

Below those cards, the CPU and memory charts use the Metrics tab's default 1-hour window, without a
range picker: they refresh every 30 seconds while the page is visible, reuse the Metrics tab's data
while its range is still 1 hour, and expand into the same zoom dialog. A node with no host metrics
shows neither the cards nor the charts on the Overview; the Metrics tab explains why.

The traffic totals are in the network card below its chart: the received and transmitted total, when the
current period started, when it resets and that it resets every 30 days. A node with a traffic period but
no network series yet still shows the card with just those totals. Times there are shown in your
browser's time zone with the zone named after them. Administrators get **Reset now**, which zeroes the
totals and starts a new 30-day period immediately after a confirmation, and **Set next reset**, which
moves when the current period ends while keeping its totals and lets the normal 30-day cycle continue
from the new time.

The **Metrics** tab picks the range with **1 hour**, **24 hours**, **7 days**, **30 days** and
**365 days**, and **Updated …** names the last read; the window slides with a refresh every 30 seconds
while the tab is visible. The charts show CPU (with the range of values inside each bucket), load, memory
(used, cached and free), swap (used; the card disappears when the node has none), every filesystem's used
space in one chart, and network traffic across the full row with its traffic totals below. The charts
read the stored buckets, so a longer range uses a coarser resolution, and join buckets only where they
exist. A card with no data says so. Click a chart's title to open the same loaded data in a large dialog
with a zoom slider; zooming only re-frames what is already loaded.

Below the charts, an availability strip shows one bar per day over the last 30, 90 or 365 days: green near
100 %, amber from 50 %, red below that, and grey for a day without data. A bar's tooltip gives its date
range and percentage, and several days share a bar when the window is wider than the strip. A node
sampled as reachability only (collection off, a pending node, or a crha too old to report host metrics)
shows only the strip and says why; a node with no stored sample shows an empty state.

**Technical details** starts with the hostname, the privileged mode (an SSH node says "ignored (SSH)")
and the upgrade log when the node reports one, then the facts the node reported and its trust report.

**Files** browses the node's file system with the same file manager as a library, as you and without
privilege: every listing or file check is an ordinary `file.list` or `file.stat` task, so rules and
approvals still apply, but those tasks stay out of the task list (tick **Include file browsing** on the
tasks page to see them). It shows sizes and modification times and previews PNG, JPEG, GIF and WebP
images. A file can be **Downloaded** through a `file.pull` task capped at your own library's one-file
limit; when that pull needs an approval, the download fails with the approval page named. Uploading,
deleting and renaming on a node come later. Administrators
can rename it, change its node groups, edit an SSH node's route, re-enroll it (crha nodes), reset or
reschedule its traffic period, and delete it.

**Last seen** reads **Now** while a crha node is connected.

**Trust** (crha nodes) shows the trust configuration the node last reported: whom it trusts, for what,
and its aliases. **Not applicable** means the node is not in `forward` mode; **Unavailable** means its
privileged mode is not running. Administrators can copy the `aliases` line for the node's
`privileged.toml` here. crhs cannot apply it itself; copy it to the node.

#### Re-enrolling a node

Administrators can re-enroll a crha node with **Re-enroll**. The dialog explains that the node keeps
its id, name, node groups and access grants, and shows the command `sudo crha enroll` with the crhs
address and a one-time token. Run it on the node (it asks to re-enroll) and start `crha` again; the node
returns to **Pending approval** and must be approved with its new fingerprint
([Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys)). SSH nodes have no
key, so they have no **Re-enroll** action.

#### Upgrading crha

**Self-upgrade** (crha nodes) says whether crhs can upgrade the node's crha, and why not: installed by
the package manager, not started by systemd, units not written by `crha enroll`, no privileged side
that runs as root, and so on. **Upgrade log** on **Technical details** names the node's upgrade log,
which the **Files** tab opens.

Administrators upgrade crha with **Upgrade crha**, here or on a node group's page. The dialog first
shows the plan: the nodes upgraded to crhs's version, a warning with the number of running tasks the
restart ends, and the nodes skipped with the reason. **Upgrade** upgrades exactly the nodes shown and
starts one privileged task group per architecture: with one, it opens its page; with several, the dialog
links each. Nodes of an architecture the release has no crha for are skipped only then, and the dialog
stays open to list them. A group waits for a signature or an approval like any privileged task
([crha self-upgrade](../design/distribution.md#crha-self-upgrade)). The node reconnects with the new
version within a few minutes, or rolls back and says why in its upgrade log.

#### Deleting a node

Administrators can delete a node with **Delete node**. A crha node is disconnected and stops; tasks
waiting for the node fail, and tasks running on it end as unknown. Its access grants and group
memberships are removed. The host itself is not changed; to use it again, enroll it again
([Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys)).

## Node groups

**Node groups** lists the groups and their member counts, each with its emoji; a group's page lists its
members. Administrators create groups, edit members, rename them, set their emoji, delete them, grant
access to a group on its page, and upgrade the crha of its members with **Upgrade crha**. Rules and grants that referred to a deleted
group show it as deleted; they never match another group with the same name.

## Users and user groups

**Users** (administrators only) lists the accounts and, below them, the user groups. On a user's page an
administrator can change the role, disable or enable the account, reset the password, manage group
membership and grant node access. Members can open only their own page. A username starts with a letter;
upper case is folded to lower case ([Concepts](concepts.md#users-user-groups-and-administrators)).

On a user group's page, administrators add and remove members, grant node access, rename and delete the
group. A group name follows the same rule, and an existing group is checked again when it is renamed.
Members receive what the group is granted immediately. A user group can be deleted only while its
library is empty.

Both a user's page and a user group's page have a **Library** section with the usage, the three limits
and a link to the library. Administrators edit the limits there.

### Granting node access

**Add access** on a node, node group, user or user group page grants a user or user group access to a
node or node group. Removing a grant takes effect immediately; a task still waiting for a user who lost
access ends without running.

## Terminals

**Terminals** is in the Work group of the sidebar, directly below **Library**, and lists the
terminals you may see: your own, or every terminal for an administrator. The list shows the node, the
program's title, user, state, creating session, associated sessions and age; a privileged terminal
carries a **Privileged** mark beside its title. It has no Viewers column. A program can set the
terminal title; it is untrusted text and never replaces the node name. **New terminal** picks an
active crha node (SSH nodes have no terminals) along with an optional command, the privileged mode
and a size; leave the command empty for the node identity's login shell. A privileged terminal first
waits for its signature: the terminal page shows the same signing options as a privileged task.

`/terminals/<id>` attaches with xterm.js. The terminal has one size: attaching or resizing the browser
window changes nothing. The viewer picks its font from the available width and only caps it by the
layout viewport height (the browser window, not the space a soft keyboard leaves) minus everything
the page shows above the terminal box and around it, so a phone's soft keyboard does not make the
text jump, a height-only change moves only a grid taller than the window, and the last rows stay
visible without scrolling. The terminal box is exactly as tall as the grid; when that is taller than
the window allows, scroll the page, and if the text would be smaller than a sensible minimum the
terminal area scrolls sideways instead of cropping. The page itself never scrolls sideways. **Fit to
window** resizes the terminal to the viewer's area at the default font size, keeping the terminal's
default 80:24 shape (the width fills first; if the height cannot hold those rows, the height decides
and the narrower grid stays centred), for every viewer, instead of only changing one browser's font.
The size in the meta line is a link that opens the same resize as a dialog: columns
and rows, **Use window size**, then **Cancel** or **Apply**; an exited terminal shows the size as
plain text. The page heading is the program's
title; without one it is the command line, the argv joined with spaces, or the localized "Terminal"
for an empty argv. The browser tab and top bar read `<heading> · <node>`, and one meta line carries
the state, node, size, creating user and exit code. The title is untrusted text: it is shown plain,
truncated, with its full text on hover. Several viewers can attach and all of them can type; the
viewer list shows each user once with a count when they have several attachments. The associations use
the same searchable picker as the rest of the WebUI and offer only the terminal user's sessions.
Opening the page focuses the terminal. A short hint reminds you that selecting text needs Shift while
a program uses the mouse; it sits on the **Extra keys** toggle's row, left of the toggle, and wraps
with it on a narrow screen. Mouse clicks and movement are never sent to the shared shell, but the
wheel still scrolls and reaches programs that use it.

The extra-keys bar below the terminal provides Esc, Tab, Ctrl, Alt, the arrows, Home, End, PgUp, PgDn
and `| ~ / -`, and scrolls sideways when it does not fit. It appears by default on a touch device; the
**Extra keys** button toggles it on a desktop and remembers your choice. Ctrl and Alt are sticky: one
tap applies them to the next key, a double tap locks them until you tap again. Text typed on a soft
keyboard while Ctrl is active becomes the matching control character, and Alt prefixes it with ESC.

An exited terminal keeps its last screen for five minutes or until the last viewer detaches, then
disappears.

A background job started in a terminal ends with the shell: crha closes the process group with a
hangup and then a kill, so `nohup`-style children that leave the group may survive only as long as the
shell did. Keep long work in `exec` tasks, which outlive your browser and keep their output.

Terminal rule approvals (`pty.create` for opening one, `pty.io` for typing and resizing) appear on the
terminal page while they wait, with **Approve**, **Always allow** and **Reject** like other approvals;
they also appear in the session's docked decision panel, which decides them through the terminal's own
route. A privileged terminal opened by an agent waits for your signature there too. A person-opened
privileged terminal waits for its signature on the terminal page. No approval shows the terminal's
screen: that stays on the server for Auto Review. Reading a terminal needs no approval.

## Settings

**Settings…** at the bottom of the sidebar has three tabs. **General** chooses your language, which
also sets the language of the chat bot's messages. **Sessions** sets the default model, its thinking
level and the default rule preset for new sessions. **Chat** links a private Telegram chat to your
account, chooses the account notifications fall back to when you are not using the WebUI, and toggles
the progress status. A linked chat acts with your authority, including approvals that need no signature;
the one-time link code you create here is what ties the two together. See
[Using CRH from chat](channels.md).

## Approvals

**Approvals** is one table of everything waiting for you, with its type, operation, target nodes and
when it was requested. Click a row to open it:

| Type | Your options |
|---|---|
| **Approval** | Approve, Always allow, or Reject |
| **Signature** / **Local window** | The options the server planned: sign with a Passkey or `crhu`, sign by hand with OpenSSH, sign a 5-minute reusable authorization, open a local approval window on the node, or Reject ([Signing](#signing-with-an-ssh-key-or-a-passkey)) |
| **Quota** | Add tokens or stop the run; the row opens the session, where the decision panel shows it |

**Always allow** adds an allow rule, prefilled from the operation, to the session, schedule or token
that asked. A plain approval adds no rule. Approvals never expire; signature requests expire after 24
hours.

## Channels page

**Admin → Channels** (administrators) lists the chat bots crhs runs as, their state, the bot
account and the last error. **New channel** adds a Telegram bot: a name and the write-only bot token. Sessions
started from chat use your own defaults from **Settings → Sessions**. A disabled channel stops polling; a
deleted one also removes its linked accounts and threads. A dropped connection is retried with the same
backoff as an MCP extension, and the next attempt is shown. See [Chat channels](../design/channels.md).

## Authorizations

**Authorizations** lists the signed authorizations crhs has stored: for which nodes and command, and
until when. Administrators see everyone's, with who signed; everyone else sees their own. It is a
record, not a control: an authorization cannot be revoked here. To withdraw a signer, change the
node's trust configuration.

**Issue authorization** signs a reusable authorization, so matching privileged tasks of yours run
without asking you each time. Choose the nodes or node groups, what it allows (a method and a target
prefix, or any command), how long it lasts and an optional note, then sign with one of your Passkeys
or copy the `crhu grant` command, run it on your workstation and paste its output. A prefix is matched
character by character: an empty prefix allows every target of the method, a command prefix should end
with a space and a directory with `/`. Tasks already waiting that it covers run at once. Keep the limit
narrow and the lifetime short: it cannot be revoked before its deadline.

### Signing with an SSH key or a Passkey

When a privileged task waits for an authorization, its decision shows the options crhs planned:

- **Passkey**, if the node trusts one of your Passkeys for this command;
- **crhu**: copy the `crhu sign` command, run it on your workstation, and paste its output back with
  **Submit authorization**. The copied command carries `--hint` fingerprints of the SSH credentials
  that match the plan's entries, so `crhu` picks the right key;
- **Passkey 5min** and **crhu 5min**, when the nodes accept a reusable authorization: instead of this
  one task, sign every task of the same method on these nodes for the next five minutes, so a run of
  similar tasks asks only once. It covers your other sessions and scheduled runs on those nodes too;
- **OpenSSH**: the same signature by hand with `ssh-keygen`. The authorizations endpoint takes the base64
  Authorization that `crhu sign` prints, not the armored `.sig` alone;
- **Local**, if the plan offers it: run the copied `sudo crha approve --for 30m` command on
  the named node instead. While that window is open crhs can run any privileged task there, so prefer
  a signature when only this task matters. A task group is never offered a local window;
- **Reject**, with an optional reason; the task ends rejected and the reason is shown on it.

A task whose plan is still being written shows "Preparing…" and keeps Reject available.

Register your SSH keys and Passkeys on **Signing credentials**. An SSH key is registered by signing a
short-lived server challenge: request it, run `crhu register <challenge>` (or the shown `ssh-keygen`
command) on your workstation, and paste the signature. crhs takes the public key from the signature,
so only a key you can sign with is registered. **Rename** changes a credential's display name; nodes
trust the key, not the name, so nothing on the nodes needs to change. **Generate trust config** builds
the `[[trust]]` entries for a node's `privileged.toml`. Passkeys need the WebUI to be served over HTTPS
with a hostname.

## Schedules

A schedule sends a fixed message to a new session on a cron timetable, as you, with its own rule preset
and optional token budget. Only one run of a schedule is active at a time: **Run now**, or the next
trigger, stops a run that is still going.

| Field | Notes |
|---|---|
| **Prompt** | The message each run sends |
| **Model**, **Thinking level** | For each run's session |
| **Rule preset** | Ask pauses runs for your approval; Yolo runs everything unasked |
| **Token budget** | Optional limit per run |
| **Cron**, **Timezone** | Five-field cron; the form previews the next triggers |
| **Catch up a missed trigger** | Run the most recent missed trigger after downtime |

The schedule page shows the run history, with a link to each run's session.

A privileged task in a scheduled run waits for your signature, unless you have signed a reusable
authorization that covers it, with **Issue authorization** on [Authorizations](#authorizations)
([Privilege](../design/scheduling.md#privilege)).

## Models

**Models** (administrators only) configures model providers and the three model presets.

- **Providers.** **Pi built-in** providers need an API key. **Custom** providers take a base URL, an API
  key and a list of models with their protocol, context window and thinking support. Stored keys are
  never shown again. Changing a custom provider's base URL requires entering its key again. Extra
  headers are stored in plain text; never put secrets in them.
- **Model presets.** **Session** sets the system prompt of sessions started afterwards; a session keeps
  the prompt it started with. **Auto review** and **Title
  generation** set the model and prompt used for reviews and session titles. An empty prompt uses the
  built-in default, which the card shows.

## System settings

**System settings** (administrators only) edits crhs's runtime settings; a save applies without a
restart and is recorded in the audit log. The [configuration reference](reference/crhs-config.md#system-settings)
lists every value and its default. Each settings section has its own **Save**.

- **General.** **Public URL** is the address crhs uses in links it returns, such as MCP results; empty
  uses the request's address. **Clock warning threshold** is how far a node's clock may drift before
  the node page warns; `0s` disables the warning.
- **Sign-in.** **Captcha** requires the Cap proof of work at sign-in; `none` is for environments without
  a browser. **Real client IP header** is the header the client address is read from; the reverse proxy
  must overwrite it. **Argon2 concurrency** and **queue** limit password hashing; each concurrent hash
  uses 64 MiB.
- **Passkeys.** **Relying party ID**, **Display name** and **Allowed origins** configure Passkeys. Set
  the RP ID and origins together, or leave both empty to derive them from each request. Changing the RP
  ID invalidates Passkeys registered for the old one.
- **Data retention.** How long **Tasks**, **Audit events** and **Agent tool records** are kept: a
  duration of at least one day, or **Keep forever**.
- **Library defaults.** The files, one-file size and total size limits that a new user or user group
  library copies when it is created. Changing them applies only to libraries created later, not to
  existing ones.
- **Directory copies and skills.** The most files and bytes one directory copy into a library takes, and
  the most skills a session's system prompt lists from `skills/` in the owner's library; past that limit
  it lists none and the model browses the directory itself.
- **Metrics.** **Collect host metrics** turns sampling on or off; stored samples stay until retention
  removes them. **Sample interval** is 15, 20, 30 or 60 seconds and applies from the next tick. The four
  retention fields keep 1-minute, 5-minute, 1-hour and 1-day buckets, each at least ten buckets long and
  at least as long as the level before it; a rejected value is shown on its field.
- **Authorization signing keys.** The keys crhs signs authorizations with; the newest is marked and
  used by default. **Add authorization signing key** creates one and shows the public key line to paste
  into a node's `privileged.toml`. The table counts the nodes that trust each key; the delete dialog
  names at most three of them. A key that nodes still trust needs **Delete anyway**, and deleting the
  last key stops crhs from signing for every node.

## API tokens

**API tokens** lists your tokens for MCP clients. See [Create an API token](mcp.md#create-an-api-token).
**Rules** edits a token's preset and added rules, **Revoke** stops it immediately, and **Delete**
removes a revoked or expired token.

## Audit

**Audit** shows the audit log: administrators see every event, others the events recorded on their
behalf. Filter by action (a value ending in `.` matches a prefix, such as `task.`) or target; click a row
for its details. `crhs` CLI commands appear with the actor `system:cli`; their detail names the OS user
and host, and the key actions (`keys.initialized`, `keys.imported`, `keys.exported`) never contain key
material. Old events are removed after the retention period ([Retention and cleanup](operations.md#retention-and-cleanup)).

## SSH credentials

**SSH credentials** (administrators only) holds the keys crhs uses to reach SSH nodes. The private key
never leaves crhs. A credential in use on any hop cannot be deleted; to change a hop's credential, use
**Edit route** on the node page.
