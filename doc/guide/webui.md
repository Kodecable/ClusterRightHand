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
| **Work** | Sessions, Schedules, Tasks, Approvals |
| **Cluster** | Nodes, Node groups, SSH credentials (administrators), Signing credentials |
| **Admin** | Authorizations (administrators), API tokens, Audit, Models (administrators), System settings (administrators), Users (administrators) |

The **Approvals** badge counts everything waiting for you. The user menu also sets the theme and the
language (English or Chinese); these are stored in your browser.

Lists update by themselves; there is no refresh button. Editing happens on an object's own page.

## Sessions

The session list shows your sessions and those shared with you, grouped by last activity. A spinner
means the session is running, an amber dot that it waits for a decision, and a blue dot that it has a
reply you have not read. **Scheduled** and **Shared** badges mark sessions started by a schedule or
shared with you.

### Starting a session

Choose **New session**, pick a model, and send your first message; the session is created with it. If
no model is configured, an administrator must add one first ([Models](#models)).

### The session page

- **Enter** sends, **Shift+Enter** adds a line. You can send while the agent works; the message is
  queued.
- **Stop** stops the session and all its subagents.
- `/compact` summarizes older parts of the conversation to free context.
- Tool calls appear as one-line rows; click one to see its arguments, output and result. When the final
  answer arrives, the agent's intermediate steps fold into one line that you can expand.
- Click the title to rename the session. Clearing it restores the default name and stops automatic
  titling.

The composer footer holds the **model**, the **thinking level**, the **rule preset** (Ask, Auto Review
or Yolo; see [Rules and approvals](concepts.md#rules-and-approvals)) and the **budget**. Changes apply
from the agent's next step. Below the composer, a line shows turns and generation speed, token usage
with the cache hit rate, and how full the context is.

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

### Adding a crha node

Administrators choose **New node**, optionally enter a name, and copy the command with the one-time
token. Run it on the node as described in [Enroll a node](install.md#enroll-a-node).

### Approving a pending node

Before choosing **Approve**, compare the key fingerprint shown in the dialog with the output of
`crha status` on the node. **Reject** deletes the node; it must enroll again.

### Adding an SSH node

Create each credential on the **SSH credentials** page and install its public key on the hops that use
it; each hop picks its own credential. **New SSH node** then takes the name and route (jump hosts first,
the target last), with a credential for every row; pin each hop's host fingerprint, then test the
connection and create the node. See [Add an SSH node](install.md#add-an-ssh-node).

### The node page

The node page shows the node's facts, its access grants and its ten most recent tasks. Administrators
can rename it, change its node groups, edit an SSH node's route, re-enroll it (crha nodes), and delete
it.

**Last seen** reads **Now** while a crha node is connected.

**Trust** (crha nodes) shows the trust configuration the node last reported: whom it trusts, for what,
and its aliases. **Not applicable** means the node is not in `forward` mode; **Unavailable** means its
privileged mode is not running. The page can also build `[[trust]]` entries and the `aliases` line for
the node's `privileged.toml`, and administrators see crhs's signing key there. crhs cannot apply these
itself; copy them to the node.

#### Re-enrolling a node

Administrators can re-enroll a crha node with **Re-enroll**. The dialog explains that the node keeps
its id, name, node groups and access grants, and shows a one-time token and the command
`crha enroll --replace --config /etc/crha/crha.toml <url> '<token>'`. Run it on the node and start
`crha` again; the node returns to **Pending approval** and must be approved with its new fingerprint
([Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys)). SSH nodes have no
key, so they have no **Re-enroll** action.

#### Deleting a node

Administrators can delete a node with **Delete node**. A crha node is disconnected and stops; tasks
waiting for the node fail, and tasks running on it end as unknown. Its access grants and group
memberships are removed. The host itself is not changed; to use it again, enroll it again
([Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys)).

## Node groups

**Node groups** lists the groups and their members. Administrators create groups, edit members, rename
and delete them, and grant access to a group on its page. Rules and grants that referred to a deleted
group show it as deleted; they never match another group with the same name.

## Users and user groups

**Users** (administrators only) lists the accounts and, below them, the user groups. On a user's page an
administrator can change the role, disable or enable the account, reset the password, manage group
membership and grant node access. Members can open only their own page.

On a user group's page, administrators add and remove members, grant node access, rename and delete the
group. Members receive what the group is granted immediately.

### Granting node access

**Add access** on a node, node group, user or user group page grants a user or user group access to a
node or node group. Removing a grant takes effect immediately; a task still waiting for a user who lost
access ends without running.

## Approvals

**Approvals** is one table of everything waiting for you, with its type, operation, target nodes and
when it was requested. Click a row to open it:

| Type | Your options |
|---|---|
| **Approval** | Approve, Always allow, or Reject |
| **Signature** | Sign with a Passkey or `crha grant`, sign by hand with `ssh-keygen`, use a local `crha approve` when the node allows it, or Reject ([Signing](#signing-with-an-ssh-key-or-a-passkey)) |
| **Quota** | Add tokens or stop the run; the row opens the session, where the decision panel shows it |

**Always allow** adds an allow rule, prefilled from the operation, to the session, schedule or token
that asked. A plain approval adds no rule. Approvals never expire; signature requests expire after 24
hours.

## Authorizations

**Authorizations** (administrators only) lists the signed authorizations crhs has stored: who signed,
for which nodes and command, and until when. It is a record, not a control: an authorization cannot be
revoked here. To withdraw a signer, change the node's trust configuration.

### Signing with an SSH key or a Passkey

When a privileged task waits for your signature, its decision offers:

- **Passkey**, if the node trusts one of your Passkeys for this command;
- **crha grant**: copy the command, run it on your workstation, and paste its output back with
  **Submit authorization**;
- **ssh-keygen**: the same steps by hand, with the same paste box;
- **Local approval**, if the node allows it: run the copied `crha approve` command on the node instead;
- **Reject**, with an optional reason; the task ends rejected and the reason is shown on it.

Register your SSH keys and Passkeys on **Signing credentials**. Each signing credential has a **Trust snippet** to add to
a node's `privileged.toml`. Passkeys need the WebUI to be served over HTTPS with a hostname.

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
authorization for exactly that command ([Privilege](../design/scheduling.md#privilege)).

## Models

**Models** (administrators only) configures model providers and the three model presets.

- **Providers.** **Pi built-in** providers need an API key. **Custom** providers take a base URL, an API
  key and a list of models with their protocol, context window and thinking support. Stored keys are
  never shown again. Changing a custom provider's base URL requires entering its key again. Extra
  headers are stored in plain text; never put secrets in them.
- **Model presets.** **Session** sets the system prompt for every session. **Auto review** and **Title
  generation** set the model and prompt used for reviews and session titles. An empty prompt uses the
  built-in default, which the card shows.

## System settings

**System settings** (administrators only) edits crhs's runtime settings; a save applies without a
restart and is recorded in the audit log. The [configuration reference](reference/crhs-config.md#system-settings)
lists every value and its default. Each of the four settings sections has its own **Save**.

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
for its details. Old events are removed after the retention period ([Retention and cleanup](operations.md#retention-and-cleanup)).

## SSH credentials

**SSH credentials** (administrators only) holds the keys crhs uses to reach SSH nodes. The private key
never leaves crhs. A credential in use on any hop cannot be deleted; to change a hop's credential, use
**Edit route** on the node page.
