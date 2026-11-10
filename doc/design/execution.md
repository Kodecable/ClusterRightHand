# Execution plane

The execution plane delivers tasks to nodes and returns their results. It knows only tasks: each
task names one node, one kind and one specification. It does not know the agent, session or model
that created the task; that origin is recorded by the server beside the task (see
[Layering principles](architecture.md#layering-principles)).

The wire protocol and its security are described in [Protocol](protocol.md). This document covers
how a task is specified, dispatched, executed, cancelled and ended, and how output, task groups,
the client connection, the SSH transport and crha reload and upgrade behave.

## Task model

A task is one execution on one node. The server generates `task_id` as a UUIDv7. A tool call can
supply an id derived from its durable call key; when a task with that id already exists, creation
returns the existing task instead of starting a second execution, so a call that runs again after a
crash reattaches to the first task.

A task group is one call over several nodes; each member is an ordinary task with its own id. The
execution plane does not create a task without a node, and a task never moves to another node.

### Task types

| Kind | Behaviour |
|---|---|
| `exec` | Runs a command, either `argv` directly or `shell` through the discovered sh (`sh -c`). `env`, `cwd`, `stdin` and a timeout are optional. |
| `file.read` | Reads whole lines starting at `start_line`, at most `line_count` lines and 50 KiB per page. The node scans from the start of the file and stops at the first line that does not fit; it does not read to the end unless the page reaches it. Only regular files: a device, FIFO, socket or directory is refused with `not_regular_file`. The page is the task's output; the line range, `eof` and `total` are in `task.exit.result`. |
| `file.write` | Writes atomically through a temporary file and a rename. By default it creates a new file only and fails when the target exists (`RENAME_NOREPLACE`); `overwrite = true` replaces the target. `mode`, `owner`, `group` and `create_parent_dirs` are optional. The result reports the byte count and whether the file was created. |
| `file.edit` | Applies `edits[]` in the format of pi's edit tool: each entry has `oldText` and `newText`, and each `oldText` must occur exactly once in the original content. All edits match the original bytes; the BOM and line-ending style are preserved and the result is written back atomically. Only regular files; a file larger than 16 MiB is refused with `too_large`. The result reports the number of replacements. |
| `file.stat` | Returns the file's metadata as the task's structured result. |
| `file.list` | Lists a directory with a limit (`limit` 0 means the default 500, the maximum is 5000). Entries stop when their fields reach 32 KiB so the result fits one frame, and `truncated` reports that entries were left out. |

The structured result of a file task travels only in `task.exit.result`, never in the output stream.
`file.read`'s output is the page bytes; `file.write`, `file.edit`, `file.stat` and `file.list`
produce no output. The exact result structure is defined under [Task results](protocol.md#task-results).

These six kinds are the whole task vocabulary. There is no PTY task and no file-transfer task;
see [Known limitations](architecture.md#known-limitations).

### Common fields

| Field | Meaning |
|---|---|
| `task_id` | UUIDv7 task identifier. It is unique within the execution plane and stays with the task through every retry. |
| `node_id` | The task's node. `tasks.node_id` has no foreign key, so a task can outlive its node row; the state machine describes how that ends. |
| `kind`, `spec` | The task kind and its fixed specification; see [Task types](#task-types) and [task.start](protocol.md#taskstart). |
| `privileged` | `true` marks a privileged task. It goes through the authorization path and the node's privileged mode decides how to execute it; see [Privilege and authorization](privilege.md). |
| `attempt` | The authorization attempt for this task id, starting at 1. The payload and `task.start` both carry it. It increases only for the authorization retry described under [No duplicate execution and authorization retry](#no-duplicate-execution-and-authorization-retry). |
| `authorization` | Optional authorization object for a privileged task: a payload and its signatures. It is empty when the path is local approval; see [Local approval](privilege.md#local-approval). |
| `timeout_ms` | `exec` only. On expiry the node sends SIGTERM to the task's process group and SIGKILL after the kill grace; see [Process groups and cleanup](#process-groups-and-cleanup). File tasks have no timeout and end only through cancellation. |
| `output_mode` | `full` for a single task, `status` for a single task created with `with_output: false`, and `text`, `status` or `head` for a member of a task group. The group's mode is fixed at creation; see [Output](#output) and [Batch output](#batch-output). |

### The exec environment

A crha node does not pass its own process environment to a task. When the process starts, it
resolves the identity, `PATH` and shells below; every `exec` task in the non-privileged mode, the
privileged mode and the native helper uses the result. SSH nodes use the environment of the remote
SSH session instead; see [SSH execution](#ssh-execution).

| Variable | Non-privileged mode | Privileged mode and native helper |
|---|---|---|
| `PATH` | crha's own `PATH`; the fixed PATH when it is empty | The fixed PATH; a task cannot override it |
| `HOME`, `USER`, `LOGNAME` | The account crha runs as (`os/user.Current()`) | root (`os/user.LookupId("0")`) |
| `SHELL` | The discovered sh (see below) | The discovered sh |
| `LANG`, `LC_ALL` | `C.UTF-8` | `C.UTF-8` |
| The task's `env` | Appended, and may override every entry above, including `PATH` | May override every entry above except `PATH`; in `forward` mode only names listed in the trust entry's `env_allow` are accepted, while the native helper has no trust configuration and applies no such limit (native mode is not a security boundary) |

The fixed PATH is `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. No other
environment variable of the crha process reaches a task.

`CRHA_TASK_HOME`, `CRHA_TASK_USER`, `CRHA_TASK_LOGNAME` and `CRHA_TASK_SHELL` are variables of the
crha process itself (`crha run`, `crha privileged run`, `crha privileged stdio`). A non-empty value
replaces the resolved value; `CRHA_TASK_SHELL` also selects the sh that runs a `shell` command. It
must be the absolute path of an existing executable file, otherwise the process fails to start.
Every name beginning with `CRHA_TASK_` is dropped from a task's `env`, so a task cannot set one.

- Resolution happens when the process starts; the native helper resolves each time it is spawned.
  A failure to resolve without an override ends the process: `crha run` exits, the privileged mode
  exits, and the native helper makes privileged tasks of that node fail with
  `privileged_unsupported` while ordinary tasks are unaffected.
- crha is built with `CGO_ENABLED=0`, so `os/user` reads `/etc/passwd` only and does not consult
  NSS: an account from LDAP or SSSD is not found. `user.Current()` then falls back to `$HOME` and
  `$USER`; `LookupId("0")` has no fallback. Use the `CRHA_TASK_*` overrides for an account that is
  not in `/etc/passwd`.
- The native helper is started by sudo or doas. Their default `env_reset` drops the
  `CRHA_TASK_*` variables; add `env_keep += "CRHA_TASK_*"` to sudoers, or use `setenv` with doas,
  when an override is needed.

**Shell discovery.** At startup the process tries, in order: the `CRHA_TASK_SHELL` override; the
first absolute path in `/etc/shells` whose basename is `sh` and that exists and is executable;
then `sh` on the PATH (the process's own PATH in the non-privileged mode, the fixed PATH in the
privileged mode and the native helper; empty and relative entries are skipped and the result must
be absolute). If all fail, the process fails to start. A `shell` command runs as
`<sh> -c <cmd>`.

- Signing, rule matching (`exact` / `prefix` / RE2), `spec_sha256` and display render a `shell`
  command as `/bin/sh -c '<cmd>'`. That `/bin/sh` means "the sh the node discovered", not a literal
  path; rendering on crhs and crha does not vary by node.
- bash is discovered the same way (the first `/etc/shells` entry named `bash`, then the PATH); its
  absence is not an error. The non-privileged mode reports both shells in `facts.shells` (see
  [Events](protocol.md#events)), and the agent uses that to decide whether `bash -c` is available.
- `C.UTF-8` is built into glibc from 2.35. An older system may not have the locale; the program
  then falls back to the C locale and may print a warning on stderr. crha does not check.

### File tasks

An edit is performed on the node: read, match, replace and write back run in one sequence without
the file crossing the network. No hash is compared; `oldText` itself is the conflict check:

- When someone changed another part of the file, the edit succeeds and their change is kept.
- When someone changed the same segment, `oldText` no longer matches (or is no longer unique), the
  edit fails, and the agent reads the file again and retries.
- **Approval delay.** An `exact` authorization binds the `edits` themselves: the user approves
  changing this text into that text. If the file changes while the approval waits, the approved
  edit still runs when `oldText` is still unique, and fails otherwise.
- **Overwrite protection.** `file.write` creates a new file by default, so a model cannot replace
  existing content with a whole-file write by accident. Replacing a file needs an explicit
  `overwrite`.
- **Symbolic links.** A non-privileged `file.write` or `file.edit` follows a symbolic link and
  writes the link's target while keeping the link; `file.write` on a dangling link creates the
  target. A privileged task refuses a symbolic link at any level with `symlink_not_allowed`; see
  [Methods and targets](privilege.md#methods-and-targets).
- **Target directory.** `file.write` creates a 0600 temporary file in the target's directory,
  fsyncs it and renames it to the target name, so the directory must let crha create a file. In a
  directory that is writable by everyone and has no sticky bit, another local user can replace or
  move the temporary file before the rename, and the published content is no longer what crha
  wrote; such a directory is not a supported target. Add the sticky bit when shared writing is
  needed, as `/tmp` does. `file.edit` publishes through the same temporary file and follows the
  same rule.
- The remaining race, the short window between crha's read and the rename, is the same as a local
  edit by pi and is accepted.
- `file.read` and `file.edit` check the file type before opening it: a device, FIFO, socket or
  directory is refused with `not_regular_file` without opening a device or waiting for a FIFO
  writer. `file.write` does not open an existing target (it stats it to keep mode and owner and
  publishes by rename), so the check does not apply to it.
- `file.write` with `create_parent_dirs` creates missing parent directories like `mkdir -p`: new
  directories get mode 0755 before the umask and the same owner as the writing identity.
  Authorization rules still consider only the target file path; its parents are prefixes and
  cannot extend an allowed range.
- `file.edit` reads at most 16 MiB; a larger file ends the task with `too_large`.

### Process groups and cleanup

Every `exec` task runs in its own process group (`setpgid`). When the task ends, normally or
through a timeout or cancellation, crha signals the whole group with SIGKILL before reaping the
task process, so remaining background children end with the task and even a task running as root
cannot leave a daemon behind. A service that must keep running is started through `systemctl` (or
`setsid`, or another service manager), which moves it out of the task's process group; a process
started with `cmd &` inside a task is killed when the task ends.

- Cancellation and timeout keep the original order: SIGTERM to the process group, then SIGKILL
  after the kill grace (`kill_grace_ms`, 5 seconds by default). A normal exit gets one final
  SIGKILL to clean up whatever the task left in its group.
- **pidfd.** Linux 5.3 and later provides pidfd, 5.4 and later supports `waitid(P_PIDFD)`, and 6.9
  and later can signal a whole process group through a pidfd
  (`PIDFD_SIGNAL_PROCESS_GROUP`). crha waits on the task through a pidfd and cleans the group
  before reaping it, so the pid and pgid are not reused before the signal is sent. A kernel
  without the capability falls back to `waitid(P_PID)` and `kill(-pgid, …)`, and signals by pgid
  only while the task process is still unreaped (a zombie); once it has been reaped, crha sends no
  signal by pgid.

### State machine

```text
created ──▶ awaiting_approval ──▶ awaiting_authorization ──▶ dispatched ──▶ running ──▶ exited(code)
   │               │                        │  ▲                 │             │
   │               └──▶ rejected            │  └── auth retry ───┘             ├──▶ failed(reason)
   ├──▶ awaiting_authorization ─────────────┘                                   ├──▶ cancelled
   └──▶ denied(policy)                                                          └──▶ unknown(reason)
```

`created` is the moment of creation, not a stored state: a task row is inserted directly as
`awaiting_approval` (also when it will be dispatched at once), as `awaiting_authorization`, or as a
terminal `denied` / `rejected` row. A task that is allowed to dispatch is written as
`awaiting_approval` with no handler and dispatched immediately; during that short interval it is
not waiting for anybody. A dispatch that throws before touching the row ends the task as
`failed/internal_error`.

- A task with no rule chain, such as a user acting in the WebUI, goes straight to authorization or
  dispatch.
- With no approval policy but a privileged task that still needs a signature, creation goes
  directly to `awaiting_authorization`.
- When the policy passes but a privileged task needs a user or local signature, the task waits in
  `awaiting_authorization` and is dispatched once the authorization arrives.
- An approval decision is written together with `handler_type = null` and `handler_session_id =
  null`. The task changes from "waiting for a person" to "allowed, waiting to be claimed", which is
  the same shape as a task dispatched right after creation, so it leaves the user's and the agent's
  waiting lists at once. Until it is claimed its state is still `awaiting_approval`, but a second
  decision, a rule change, Auto Review or restart recovery no longer treats it as waiting; the
  claim then moves it to `dispatched`.
- **Approval waits have no automatic timeout.** An approval wait ends when the user rejects the
  task, the task is cancelled, or the rules change. A task that waits for a signature ends after
  **24 hours** as `rejected` with `authorization_wait_expired`, measured from the approval decision
  when there was one and from creation otherwise; see [Waiting for
  signatures](privilege.md#waiting-for-signatures).
- A rule denial ends a task as `denied` with `error_code = policy_denied`. A rejected approval,
  including one caused by token revocation, ends it as `rejected` with
  `error_code = approval_rejected`.
- The final failure of a signature wait is `rejected` with `error_code = authorization_required`,
  `authorization_invalid`, `authorization_expired`, `authorization_rejected` (a final rejection by
  the user or the local approver) or `authorization_wait_expired`. When the privileged path cannot
  run at all, the task ends as `failed` with `privileged_unsupported` or `privileged_unavailable`.
- A reusable authorization issued for a node-group UUID is never sent to a `forward` node that
  lacks the matching alias: the task ends as `failed` with `error_code = alias_missing`; see
  [Authorization path](privilege.md#authorization-path).
- A task waiting for approval stores its input (stdin, or the content to write) in
  `tasks.pending_input`; dispatch takes it out and clears the column. If the node is offline when
  the approval arrives, the task waits through the offline grace described under [Node
  offline](#node-offline) and then fails with `node_offline`; it is not queued for a later
  connection. A privileged task that dispatches without waiting, using a reusable authorization its
  owner already stored, takes its input from the memory of the creating call; when `task.start`
  rejects the authorization and the task returns to `awaiting_authorization`, the input is written
  to `pending_input` for the next attempt.
- A task group that needs approval waits as a whole (`task_groups.state = awaiting_approval`), and
  its specification and input are kept on the group because no member task exists yet. Nodes that
  the rules deny get a `denied` member immediately. After the one approval, the remaining nodes run
  with the group's parallelism.
- Every member of a running group is judged against the current rules when it is created. A member
  that needs approval when it is created does not stop inside a group that already started; it ends as `rejected`
  with `error_code = approval_required` and a reason that the rules changed while the group ran. A
  `deny` verdict still ends as `denied`.
- Members of a group are independent: when some nodes have run and others wait for an
  authorization, the finished tasks are not rolled back and the group can end with a mixed result.
  When every unfinished member is waiting for an authorization, the group shows
  `awaiting_authorization`; otherwise it stays `running`.
- `fail_fast` affects only nodes that have not started; it does not roll back a task that started
  or finished, and a retryable authorization rejection is not a final failure. See [Task
  groups](#task-groups).
- `tasks.node_id` has no foreign key. Deleting a node makes crhs end that node's tasks that are
  still in `awaiting_approval` or `awaiting_authorization` in each task's own queue turn, through
  the normal ending path, as `failed` with `error_code = node_deleted`; group members are ended the
  same way and the group then ends through its normal state machine. Approving a task whose node was
  deleted in the meantime also ends it as `node_deleted`, and no "always allow" rule is appended
  for it.
- A waiting task whose `on_behalf_of` user lost access to the node ends as `failed` with
  `error_code = node_access_revoked`.
- When crhs restarts, a task left between its claim and its `task.start` (`awaiting_approval` with
  no handler) ends as `failed` with `error_code = dispatch_interrupted`: nobody can approve it, its
  input is gone, and a reattached call must not wait forever. The same shape occurs after an
  approval and before the claim, so a restart ends it the same way instead of treating it as a new
  approval request. Task groups recover first, and their members follow the group's interruption
  rules.

**Task groups across a restart and on errors.**

- A task group left in `running` or `awaiting_authorization` by a previous crhs process is marked
  `interrupted`. Nodes without a task are recorded in `skipped`, members that were created but not
  dispatched (`awaiting_approval` / `awaiting_authorization`) end as `rejected` with
  `error_code = cancelled` and a reason naming the restart, and a group that is already `finished`,
  `interrupted`, `rejected` or `cancelled` dispatches no member.
- When a group's run throws, for example because storing a member fails, the group also ends as
  `interrupted`, not `finished`: unstarted nodes go to `skipped` and created-but-undispatched
  members are cancelled with the reason `the task group failed: …`. There is no separate failed
  group state; a group never retries, and `interrupted` is the state for "did not finish". After
  one worker throws, the other workers take no further node.
- Cancelling a task group ends it as `cancelled`: stopping the session, aborting a blocking file
  tool call, or `task_cancel` naming the group sets an in-process stop flag that each worker checks
  before taking the next node and after every wait, so nodes that have not been created never take
  effect. Created members, including those in `awaiting_approval` / `awaiting_authorization`, end
  through task cancellation, and nodes without a task go to `skipped`. Cancellation is the decision
  of the user or caller, not a failure: the tool result says `cancelled`, while individual members
  can end as `cancelled` failures. A group has no separate reason column; the cancellation reason
  is written to each member's `error_message`.

**`unknown`** is the execution plane's only "outcome not known" state. Its reasons are:

| Reason | Trigger |
|---|---|
| `connection_lost` | A dispatched task lost its connection before a terminal state, and reconnect recovery failed. An SSH task is in this state as soon as its connection drops. |
| `executor_restarted` | After a reconnect, a `task.query` finds that the client does not know the task id because the client process restarted. |
| `dispatch_unconfirmed` | `task.start` was sent but no response arrived before the connection broke. |

An `unknown` task is reported as a failure with an unknown status and the reason. Whether to retry,
and whether to inspect the machine before retrying, is the decision of the agent or the user.

### Node offline

When crhs has to send a `task.start` and the node is not connected, it waits up to
`NODE_OFFLINE_GRACE` (30 seconds) for the node to reconnect. A node that reconnects in that window
receives the task (`forward` nodes also wait for a fresh trust report); otherwise the task ends as
`failed` with `error_code = node_offline`. The task was never dispatched, so it is not `unknown`.

- The wait applies at every moment a dispatch is due: immediately after creation, after an
  approval, after a signature arrives, after a local approval, when a task group starts its next
  node, and when a schedule fires. All tools and APIs behave the same way; no task stays pending
  forever because a node is offline.
- A task waiting for a signature or an approval is not affected: it waits for a person, not for a
  node. The node is checked only when the task is released for dispatch.
- The grace covers the seconds after a crhs restart in which nodes reconnect, and short network
  hiccups. A longer absence is a failure, and the caller decides whether to retry.
- A member of a task group waits the same way, and its failure counts for `fail_fast`.
- An SSH node has no standing connection. Without a configured route it fails at once with
  `node_offline`; with a route it proceeds, and a connection failure is the task's own failure.

### No duplicate execution and authorization retry

- One task id is **accepted and executed at most once**. The guarantee is about acceptance, not
  about how often `task.start` is sent.
- There is exactly one retry: when crha refuses the authorization (`authorization_*`) **before**
  sending the success response (`accepted`), the task returns to `awaiting_authorization` and is
  dispatched again with `attempt + 1`. The old authorization cannot be used for the new attempt.
- When `task.start` was sent but the connection broke before an explicit refusal arrived, crhs
  **never retries**. The task becomes `unknown` with `dispatch_unconfirmed` or `connection_lost`,
  which prevents a duplicate execution.
- An accepted task is not sent again even if it later fails or becomes `unknown`; after a reconnect
  crhs only sends `task.query`.
- A client that receives a `task.query` for a task id it does not know answers normally
  (`ok = true`) with state `unknown`. This is not an error.
- The client does not persist tasks and does not replay them. Its accepted/executed record lives in
  memory only; after a client restart, a query produces `unknown` with reason
  `executor_restarted`.

### Task cancellation

- A task waiting for approval or a signature has no node-side task yet. Cancelling it ends it as
  `rejected` with `error_code = cancelled` and withdraws an outstanding local approval request.
- A task that is claimed (`dispatched`) but has not sent `task.start`, or has not had it accepted,
  gets `tasks.cancelled = 1` first, then crhs sends `task.cancel` to the node. This succeeds even
  when the node is offline. Immediately before the one `task.start` is sent, crhs reads the row
  again: if the task is no longer `dispatched` (for example because `task.query` already made it
  `unknown`), nothing is sent; if `cancelled = 1`, the task ends as `rejected` with
  `error_code = cancelled` and nothing is sent.
- crha remembers the cancel of a task id it does not know yet for 10 minutes, keeping at most 1024
  ids and evicting the oldest when full. A `task.start` that arrives later is refused with
  `cancelled`. When `task.start` was already accepted, crhs sends a second `task.cancel` from
  `onAccepted`, which covers the window in which the cancel reached the node first.
- An SSH node also records the cancel on the row first. A cancel that arrives during connection,
  shell probe or opening the execution channel is not lost, and a remote command that has not
  started is never run. Such a task ends as `exited` with `cancelled = true`.

### Task row concurrency

One task row is written by several paths: creation and dispatch, approval, signature submission,
local approval, the answer to `task.start`, node events, disconnects, re-planning after a trust
report, a task group's shared-payload refresh, and sweeps. The rules are:

**1. Correctness comes from the row version, not from the queue.**

- `tasks.rev` is the row version. Every `UPDATE tasks` increments it, and only the writer module
  (`cluster/task-rows.ts`) writes the table.
- A write that follows a decision made from a row read earlier is a compare-and-set write: its
  condition includes the `rev` it read (and the state when useful). A miss means another path has
  changed the row; the caller gives up because the row is no longer in the shape it handles, or
  reads it again and decides again.
- Compare-and-set writes run in the task's own queue turn. In tests, a compare-and-set write
  outside its turn throws. Two paths are explicitly exempt: cancellation, which is the user's
  decision and retries the write against the current row, and a task group's shared-payload refresh,
  which writes member rows at the `rev` it read while holding the group queue.
- Node-event writes (`onAccepted`, `task.exit`, `markUnknown`, disconnect) do not depend on an
  earlier read and are guarded only by state and node, but they also increment `rev`, so a row held
  by another path becomes stale.
- `attempt` is only the protocol attempt number; it is not a row version.

**2. The queue reduces conflicts, and one turn stays short.**

- A `taskQueue` turn only reads the row, decides and writes it. It does not wait for a node
  (`readyNode`, `waitNodeReady`, `waitTrust`) and does not send a request that needs an answer
  (`task.start`, `local.request`). In tests, calling those functions inside a turn throws.
- A flow that must wait is split into several turns: the first turn claims the task with a
  compare-and-set write (moving it to `dispatched` and so excluding other paths); the node wait and
  the request happen outside a turn; the next turn reads the row again and writes the result with a
  fresh comparison.
- The answer to `task.start` is always settled in the task's queue, for an ordinary dispatch and an
  authorized one alike.
- Queues nest in one direction only: `taskQueue` → `groupQueue` → `trustQueue`. While holding a
  later queue, a path must not wait for an earlier one.
- A task group's shared-payload refresh therefore reads member rows and computes the payload in one
  `groupQueue` turn, then writes the member rows at the `rev` it read without entering a member's
  `taskQueue`. If a member write misses, it reads and computes again, a bounded number of times.

**3. An HTTP request waits only for what must finish synchronously.**

- `POST /api/authorizations` verifies and stores the signature and then returns
  `{ authorization: { id } }`. Waiting for nodes, planning, claiming and sending happen in the
  background, and the outcome shows up in the task states.
- Requests that create or approve a task still wait for their dispatch result, but waiting for a
  node does not hold the task's queue.
- The re-evaluation triggered by a rule change (`reevaluate`) records the allow or deny decision
  synchronously; an allowed dispatch finishes in the background. Editing a rule or appending an
  "always allow" rule is therefore not serialized behind the 30-second offline grace of a task.

## Task groups

A task group is one call over many targets, from the WebUI, an agent tool or MCP. Targets are node
names, node-group names, UUIDs or `_all`, matched case-insensitively; a call whose single target
names one node is a single task, and anything else becomes a task group. Every task tool takes the
same `targets` list, with one entry for a single node; see [Batch
execution](agent-runtime.md#batch-execution).

- A task group targets at most **512 nodes**, after target expansion and de-duplication; an offline
  node counts. More is an error that asks the caller to split the batch, never a truncated
  execution. The cap also keeps the common one-line-per-node result inside the `text` output
  budget, while per-node status information is not charged to that budget.
- The group runs one task per node with bounded parallelism: 10 by default, at most 100.
- Members are independent tasks and their results are independent. A group can finish with a mixed
  set of exits, failures and rejections, and a finished member is never rolled back.
- One approval covers the whole group; see [State machine](#state-machine).
- `fail_fast` stops the workers from taking unstarted nodes after a member failure. It does not
  cancel or roll back a task that has started or finished, and a retryable authorization rejection
  does not count as a final failure.
- Cancelling or interrupting the group is described under [State machine](#state-machine); a group
  that ends as `interrupted` or `cancelled` dispatches no further member.
- The output mode is fixed at creation and stored on the group and on each member. An `exec` group
  takes `status` (the default) or `text`; a file-operation group always keeps each node's head
  (`head`), and any other requested mode is rejected. See [Batch output](#batch-output).

## Output

- **A task has one output stream.** crha connects the command's stdout and stderr to the same pipe,
  equivalent to `2>&1`, and their bytes interleave in write order. The privileged mode, both the
  `forward` daemon and the `native` helper, also uses one pipe. An SSH node prints its pid marker
  and then runs `exec 2>&1` in the remote wrapper, so its stream is merged remotely. Separating the
  two streams has no use here: the model, the full output file and the WebUI all read the merged
  stream. A command that needs the streams apart redirects them itself (`2>/dev/null`,
  `2>err.log`).
- **Every chunk carries a byte offset.** `task.output` has `task_id`, `offset` and `data`; there is
  no stream field. Output is pushed to crhs in real time for the modes that keep it, and a `status`
  task pushes nothing. See [Events](protocol.md#events).
- **crhs keeps only a truncated part of the output.** For a single task it keeps the head and the
  tail (`output_head` / `output_tail`), each at most 2000 lines or 50 KiB, with the tail starting at
  a whole line. The model receives the tail and the WebUI task page shows both. It never keeps the
  complete output.
- **The complete output stays on the node as a normal file.** In the single-task `full` mode, crha
  spills the output to a file when it exceeds 2000 lines or 50 KiB; the batch `text` and `status`
  modes always spill. The unprivileged mode writes the file under `[output].dir`, which defaults to
  `output/` under the configured `state_dir` (with `state_dir = "/var/lib/crha"` the path is
  `/var/lib/crha/output/<task_id>.log`). The file contains the single stream, exactly what `2>&1`
  shows in a terminal; crha keeps a segment index in memory for resending. `task.exit` carries the
  file path, the byte count and the line count (`output_lines`). The file has mode 0600 and is owned
  by the user the unprivileged mode runs as, because the output may contain secrets.
  - A privileged task's output is forwarded through the unprivileged mode, so that mode writes the
    file too and the privileged output exposes nothing extra.
  - crha cleans these files by `[output].max_age` and `[output].max_total` (default 7 days and
    1 GiB). A complete output is read with an ordinary `read_file` task.
- **crhs's own notice is not output.** A message such as the SSH privilege notice is stored in
  `tasks.notice` instead of the stream, so a `file.read` page remains the file's bytes. A tool result
  renders the notice as a line in its note, and the WebUI shows it above the output. File results
  live in `task.exit.result` and do not consume the output budget.
- **crhs records the end only when the output is complete.** For every mode except `status`, crhs
  compares the received end with `task.exit.output_end`; when bytes are missing it closes the
  connection, and the client resends after reconnecting. A `status` task has no output events, so
  there is nothing to compare, and its byte count and file path are recorded from `task.exit`.
- **A break can be resumed.** While a task runs, and after it ends until crhs acknowledges the end,
  crha keeps the output crhs has not received: output that has not spilled stays in memory, and
  output already in the node file stays there. After a reconnect, crhs sends the offsets it has in
  `welcome.acks`, and crha resends from those offsets. `task.exit.ack` releases the node's buffer.
  As output grows, the node spills it to the file instead of dropping it; only a spill file that
  cannot be written falls back to memory and, beyond 16 MiB, to dropping bytes.
- An SSH node keeps no complete output file. It pushes the single stream, and crhs keeps only the
  head or tail its mode allows; see [SSH execution](#ssh-execution).

### Batch output

| Mode | Where it is used | What crhs keeps |
|---|---|---|
| `status` | The default for an `exec` group; also a single task with `with_output: false` | Nothing but the status, exit code and the node's full output file path. No output is sent to crhs; on a crha node the complete output stays in the node file. |
| `text` | An `exec` group that asks for output | The tail of each node's stream, at most 8 KiB or 128 lines per node, within one group budget of 50 KiB or 2000 lines. On a crha node the complete output stays in the node file. |
| `head` | Every file-operation group; not selectable | The head of each node's stream, at most 8 KiB or 128 lines per node, within the same group budget. On a crha node the complete output stays in the node file. |

An SSH node has no complete output file: the same modes keep only what crhs holds, and `status`
returns the status and byte count without a path.

The `head` mode exists because each `file.read` page must be continuable from its own next line:
one node's page can be continued with `Use offset=<n> to continue.` independently of the other
nodes' line ranges. `file.write` and `file.list` have no page; their structured result comes from
`task.exit.result` and is not subject to the output budget.

- **The budget is allocated in arrival order.** When a node's output arrives, it draws a grant from
  the group's remaining total, up to the per-node cap. A grant only grows: bytes rolled out of a tail
  are not returned to the group. Once the total is exhausted, nodes that already hold a grant keep
  receiving output and roll it within their own grant, while nodes without a grant have all their
  output dropped. The kept bytes are at most the sum of the grants, so the kept output does not grow
  with the number of nodes; only a small amount of metadata is kept per node.
- **A whole node may be dropped.** A node that receives no grant has its output discarded, even
  when that output would explain a failure. There is no priority for failing nodes: failures take
  part in arrival order like everything else. For the complete error output, read the node's file
  or run the task alone in `full` mode. This is a deliberate trade for a fixed memory bound.
- **A dropped node is still acknowledged.** Even when a node's bytes are dropped, crhs advances the
  offset it reports as received and acknowledges the task's end, so crha can release its buffer.
- **The mode is fixed at creation.** It is stored in `task_groups.output_mode` and in each member's
  `tasks.output_mode`. An `exec` group takes `text` or `status` (the Web API `outputMode`, the tool
  `with_output`); a file-operation group is always `head`, the Web API rejects any other value, and
  the file tools take no such parameter. A single task's `tasks.output_mode` is `full`, or `status`
  with `with_output: false`.
- **`head` is a crhs-side mode.** The node receives a task in `full` mode, streams output in real
  time, and spills by its thresholds; crhs keeps the head under the budget described above.
- **Per-node caps can be lowered by the caller.** `max_lines` and `max_bytes` change the per-node
  window (default 8 KiB / 128 lines) up to the group budget (50 KiB / 2000 lines). The caps are
  written at creation to `task_groups.node_max_lines` / `node_max_bytes` and to each member's
  `tasks.max_lines` / `max_bytes`, so a resend after a crhs restart uses the stored caps.
- **A single task's budget is its own cap.** It defaults to 50 KiB / 2000 lines. When a single task
  sets `max_lines` or `max_bytes`, the `task.start` `full` spill thresholds (`spill_lines` /
  `spill_bytes`) use the same values, so a truncated tail always has a complete output file on the
  node.
- **The budget lives in crhs memory and follows a restart.** After a crhs restart, unfinished tasks
  resend their output from offset 0 and draw grants again in the new arrival order; a finished
  task's stored tail is already in its row and takes no part. The memory bound does not change.
- **`text` keeps whole lines.** When the tail rolls, it keeps at most the granted number of newline
  characters; a partial last line remains until its newline arrives.
- **A `status` task skips the completeness check.** crha sends no `task.output` for it, so crhs does
  not check that output arrived; `task.exit` still records the byte count and file path.

## Client connection lifecycle

A crha node reaches crhs over one CRH protocol session. The handshake, the command and event
formats and the transport security are in [Protocol](protocol.md); this section describes the
client-side contract that keeps the session and its tasks alive: heartbeat and reconnect.

### Heartbeat

- crha must send a `ping` at least every 45 seconds; the recommended interval is 30 seconds with
  ±5 seconds of random jitter, so a large fleet does not ping in lockstep. crhs only answers with
  `pong`.
- When either side receives no message from the other for 90 seconds (two maximum intervals), it
  closes the connection and enters disconnect handling.
- The heartbeat is an application-level command inside the Noise channel, not a WebSocket control
  frame. It proves that the whole session path still works and is not affected by a proxy that
  handles control frames itself.

### Reconnect

- When the network breaks, the client process stays alive, its tasks keep running, and output keeps
  being buffered.
- The client reconnects with exponential backoff and jitter, starting at 1 second and capped at
  1 minute.
- `hello` carries the list of tasks the client is still running; `welcome` answers each task's
  acknowledged output offset, and the client resends from there.
- When crhs sees an unfinished task that is absent from the client's list, it sends `task.query`.
  A client that does not know the id answers `unknown`, and the task becomes `unknown` with
  `executor_restarted` when it was accepted, or `dispatch_unconfirmed` when it was not.
- After a crhs restart, the in-memory output is gone and `welcome` acknowledges offset 0, so crha
  resends from the beginning. crha keeps the output until `task.exit.ack`, so a crhs restart loses
  no output.
- A large input (exec stdin or the content of `file.write`) is sent as `task.input` chunks after
  `task.start` is accepted; `task.start` carries only the size and SHA-256. An authorization
  refusal therefore needs no input transfer, and an authorization retry (`attempt + 1`) sends the
  input again. A break while input chunks are in flight cannot be resumed: crha sees that the input
  is incomplete and fails the task. One input is at most 64 MiB.
- When a disconnect lasts longer than the reconnect grace (2 minutes by default), crhs first reports
  the affected tasks upwards as `unknown/connection_lost`, or `unknown/dispatch_unconfirmed` for a
  task that was never confirmed accepted. A result that the client reports after reconnecting is
  recorded as the task's late result, but the answer already returned to the agent does not change.
- On a crhs restart, leftover `dispatched` / `running` tasks are handled the same way: a client
  node's tasks get the grace starting at the restart, and are recovered through `hello` /
  `task.query` if the node reconnects; an SSH node's tasks become `unknown/connection_lost`
  immediately because their connection died with the process. Tasks between claim and dispatch end
  first as `failed/dispatch_interrupted`.
- Output kept in memory for a late result has a limit (`UNKNOWN_OUTPUT_KEEP_MS`, 10 minutes). When
  the node reconnects and says it does not know the task, the buffer is released at once instead of
  waiting out the limit.

## SSH transport

An SSH node installs nothing. crhs executes through `SshTransport`, which presents the same task
interface to the layers above as a crha node.

The `privileged` flag keeps its rule and approval meaning on an SSH node, so the agent can batch
the same command across transports, but execution ignores it: the task runs as the SSH user and a
notice says so. The notice is stored in `tasks.notice` and not in the output stream; it is kept in
`status` mode too. When the SSH user is root, this is real root execution, not a denied privilege
request.

| Capability | Own client | SSH |
|---|---|---|
| exec and file operations | Yes | Yes. Exec uses an exec channel; file operations use SFTP with the same semantics, JSON output and error codes, except where [SFTP file operations](#sftp-file-operations) lists a difference. |
| Resume after a disconnect | Yes | No. When the connection drops, the task is `unknown/connection_lost`. |
| Reverse connection | Yes | No. The server must be able to reach the node's SSH port. |
| Privileged tasks | Four handling modes, see [Privilege and authorization](privilege.md) | Not elevated: `privileged` is ignored, the task runs as the SSH user, and the notice is added. SFTP `file.*` tasks remain available. |
| Node-local logs | The privileged mode's local log plus journald | Only the system logs (sshd, sudo) |

### SSH execution

- **Shell probe.** Every new connection, including a replacement in the pool, first probes for sh
  and bash in the same order crha uses: the first absolute, existing and executable path in
  `/etc/shells` whose basename is `sh` or `bash`, then `command -v`. The result is stored in the
  node's `facts.shells` (an SSH node's facts contain only this entry), and the connection's tasks
  use the discovered sh; when no sh is found, `/bin/sh` is used. Authorization and display still
  render a shell command as `/bin/sh -c '<cmd>'`.
- **Process group.** sshd already starts the command in a new session, so the shell's pid is the
  process group id. The remote command is:

  ```text
  cd <cwd> || exit 127; exec env -- LANG=C.UTF-8 LC_ALL=C.UTF-8 [K=V…] <sh> -c '<wrapper>' crh <argv…>
  ```

  The wrapper writes `crh-pgid:<pid>` on the first stderr line, which crhs parses and removes,
  then runs `exec 2>&1` to merge stderr into stdout, and then `exec`s the real command. An SSH
  node's output is therefore one stream and crhs does not merge two. `setsid(1)` is not used: the
  caller already leads its process group, setsid would fork, and the exit status would be lost.
- **Cancellation and timeout.** A second exec channel runs `kill -TERM -- -<pgid>`, then
  `kill -KILL` after the grace; the result is reported as a signal, as on a crha node. A task
  cancelled while the connection is being established or the shell is probed never executes and
  ends as `exited` with `cancelled = true`, without a command being sent. The cancel is registered
  when the task is claimed, before any wait, and the row's `cancelled` flag is checked again before
  the command starts. An abort listener attached after the exec channel opens checks the signal
  again immediately, so an abort that fired in between is not missed.
- **Exit-status race.** A short command's output and exit status can arrive in the same packet as
  the channel-open confirmation, so crhs attaches every listener synchronously inside the open
  callback.
- **Connection reuse.** Each node reuses one connection (keepalive every 10 seconds, 3 misses); a
  disconnect at any hop closes the whole route. When a pooled connection has died but the task has
  not started, crhs retries once on a fresh connection.
- **Result classification.** A connection failure before the remote command starts is
  `failed/connect_failed` or `failed/host_key_mismatch`; a disconnect after it starts is
  `unknown/connection_lost`. A cancellation before the start is a cancellation, not a connection
  failure. SSH keeps no complete output file: crhs stores only the head or tail its mode allows.

### Jump hosts

An SSH node can have one or more jump hosts, equivalent to OpenSSH's `ProxyJump`; at most five.

- Each hop has its own host, port, user and credential, and each hop's host key is pinned
  separately.
- Every hop of a route uses the same credential in this version.
- crhs opens the route hop by hop with `ssh2`'s `forwardOut` on the previous hop, then connects
  through the resulting TCP stream.
- A disconnect at any hop is a disconnect of the whole route, and a running task becomes
  `unknown/connection_lost`.

### Adding an SSH node

1. **Credential.** crhs generates an ed25519 key pair, encrypts the private key with the master key
   and stores it in `secrets`, and gives the user only the public key to add to the target user's
   `authorized_keys` on every hop. The credential belongs to the organization; only administrators
   create, view, delete and bind it.
2. **Probe the host keys.** `POST /api/ssh-nodes/probe` returns the fingerprint of the first hop
   that is not pinned yet (`SHA256:…`, the same form as `ssh-keygen -lf`). It only handshakes and
   does not authenticate. The user verifies the fingerprint on that host, pins it, and probes the
   next hop.
3. **Create.** Every hop must have a pinned host key before the node can be created. An SSH node has
   no crha; like a crha node it is organized through crhs's node groups.
4. **Test the connection** (optional, before or after creation): `POST /api/ssh-nodes/test` for an
   unsaved route, or `POST /api/nodes/:id/ssh-test` for a saved node (administrators only),
   authenticates hop by hop against the pinned keys and runs `true` on the target. This catches a
   public key that was not installed and an account that cannot run commands (`ForceCommand`,
   `nologin`).
5. **Afterwards.** The node page shows the full route and the pinned host keys, and
   `PUT /api/nodes/:id/node-groups` changes the node's groups; membership of crha nodes and SSH
   nodes is maintained in crhs alike. An SSH node's "last seen" is the time of the last task that
   reached the node. It has no standing connection, so the node is not shown as online or offline.

### Requirements on the node

- The login shell parses a POSIX-style `cd … || exit 127; exec …`: bash, zsh, dash, ash and ksh
  work; fish, nushell and the csh family do not, and an account with `ForceCommand`, a restricted
  shell (`rbash`) or a `command=` restriction is not supported.
- `sh` and `env` exist. Cancellation uses a shell builtin or `/bin/kill`'s
  `kill -<SIG> -- -<pgid>`.
- File tasks require sshd's SFTP subsystem.
- No pty is allocated, so the environment is a non-interactive SSH session: bash as the login shell
  reads `~/.bashrc`, most other shells read no configuration file, and `PATH` and the rest can
  differ from an interactive login. sshd sets `HOME`, `USER`, `LOGNAME` and `SHELL` for the
  account; crhs additionally sets `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`, and a task's `env` can
  override them. Put any other variable in the task's `env` or use an absolute path. Names beginning
  with `CRHA_TASK_` are dropped as on a crha node.
- SSH takes no part in privileged execution: the `privileged` flag is ignored and the task runs as
  the SSH user. There is no `native` or `forward` mode and no trust configuration.

### SFTP file operations

- `file.read` pages by line like crha: it streams from the start of the file and stops when the page
  is complete; only a page that reaches the end reads the whole file. A deep page scans the earlier
  lines again, so its cost grows with the page offset; see [Known
  limitations](architecture.md#known-limitations).
- Setting an owner or group by name is not supported: a non-empty `owner` or `group` fails with
  `invalid_spec`. `file.stat` returns numeric `uid` and `gid` with empty `owner` and `group`.
- A non-overwrite write is "check, then rename", not atomic like `RENAME_NOREPLACE`. An overwrite
  uses `posix-rename@openssh.com`, and falls back to unlink plus rename when the server lacks the
  extension.
- No `fsync` is performed, and `mtime` has one-second precision.

## Reload and upgrade

- **Reload.** Each process re-reads its own configuration on SIGHUP: `crha run` reads `crha.toml`,
  and `crha privileged run` reads `privileged.toml` and pushes a new `trust.summary` when its
  digest changed. crha has no reload command of its own; a service manager normally sends the
  signal, for example systemd's `ExecReload=/bin/kill -HUP $MAINPID`, and OpenRC's `reload` works
  the same way.
  - An invalid new configuration is not applied; the process keeps the running configuration and
    logs that the reload failed.
  - A changed notes path re-reports `facts`; a changed server address or `tls_verify` reconnects;
    `state_dir`, `clock_warn`, `[output]` and `[privileged]` take effect only after a restart and
    are logged as such. Node groups do not pass through crha; an administrator changes them in
    crhs.
- **Configuration edits** are ordinary privileged tasks: a `file.write` writes the configuration
  file, then the corresponding process is sent SIGHUP, usually through the service manager's
  reload.
- **Binary upgrades** are ordinary privileged tasks too: write the new binary with `file.write` or
  install it with an `exec` call to the package manager, then restart the service. A restart stops
  every task running on the node, including the task that performs the upgrade, so schedule the
  restart to allow the task to report its result first (for example with
  `systemd-run --on-active=2s`), or restart from outside a task. The repository has no self-upgrade
  command; see [Known limitations](architecture.md#known-limitations).
- A restart makes the node's running tasks unknown on the server side: after the client reconnects,
  crhs queries the tasks the client no longer reports and records them as
  `unknown/executor_restarted`. The client keeps no task across the restart.

## Configuration and paths

crha has no built-in path for its own configuration, state, log or socket. They all come from the
command line and the configuration file named by `--config`, which the commands that need a
configuration require (`run`, `privileged run`, `enroll`, `status`); `privileged stdio` reads no
configuration file. The one exception is the local approval socket used by `crha pending` /
`crha approve` / `crha deny`: those commands default to `/run/crha/privileged.sock`, and
`--socket` or the `CRHA_PRIVILEGED_SOCKET` environment variable overrides it.

```text
crha enroll --config /etc/crha/crha.toml --state-dir /var/lib/crha https://crh.example.com crh1.…
```

When the configured file does not exist, enroll writes a minimal configuration containing only
`server` and `state_dir`. Without `--state-dir` enroll cannot create the file and fails; when the
file already exists, passing `--state-dir` is an error. The paths that the WebUI suggests,
`/etc/crha/crha.toml` and `/var/lib/crha`, are suggestions, not defaults. The keys and paths of the
configuration file are described in the
[configuration reference](../guide/reference/crha-config.md).
