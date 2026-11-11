# Execution plane

The execution plane delivers tasks to nodes and returns their results. It knows only tasks: each task
names one node, one kind and one specification. It does not know which agent, session or model created
a task; crhs records that origin beside the task
([Layering principles](architecture.md#layering-principles)). The wire protocol is in
[Protocol](protocol.md).

## Task model

A task is one execution on one node, and it never moves to another node. A task group is one call over
several nodes, with one ordinary task per node.

A tool call can create its task with an id derived from the call itself. If the call runs again after a
crash, creation returns the existing task instead of running the command twice.

### Task types

| Kind | Behavior |
|---|---|
| `exec` | Runs an argv directly, or a shell command through the node's `sh`. |
| `file.read` | Reads a page of whole lines, bounded by line count and size, and reports the range and whether the end was reached. |
| `file.write` | Writes a file atomically. By default it only creates a new file. |
| `file.edit` | Replaces text segments, each of which must occur exactly once in the file. |
| `file.stat` | Returns file metadata. |
| `file.list` | Lists a directory, up to a limit. |

The spec and result shapes are in `packages/protocol/src/messages.ts`. File results travel in the task's
structured result, never in the output stream. These six kinds are the whole vocabulary: there are no
interactive (PTY) or file-transfer tasks ([Known limitations](architecture.md#known-limitations)).

An `exec` task can have a timeout. File tasks have none and end only through cancellation. A task's
`attempt` increases only when a privileged task is retried after an authorization refusal.

### The exec environment

A crha node does not pass its own environment to tasks. A task starts with a small fixed environment
(identity variables for the account it runs as, a UTF-8 locale and `PATH`) plus the task's own `env`.
This keeps a task's behavior independent of how the crha service happened to be started.

- In the unprivileged mode, a task's `env` may override everything, including `PATH`. In the privileged
  mode `PATH` is fixed, and `forward` mode accepts only variables the trust entry allows, so variables
  like `LD_PRELOAD` cannot bypass command rules.
- The node discovers `sh` and `bash` at startup and reports them to crhs. Authorizations and rules
  always render a shell command as `/bin/sh -c '…'`, meaning "the node's sh", so the rendering does not
  vary by node.
- crha is built without cgo, so it resolves accounts from `/etc/passwd` only. The `CRHA_TASK_*`
  variables override the identity and shell for accounts from LDAP or SSSD. Tasks cannot set these
  variables themselves.

### File tasks

Edits run entirely on the node: the file is read, matched, changed and written back without crossing
the network. The text being replaced is itself the conflict check. If someone changed another part of
the file, the edit succeeds and keeps their change; if they changed the same segment, the edit fails and
the agent reads the file again. An approval binds the edits themselves, so an edit approved earlier still
applies only if its text is still there.

- `file.write` refuses to replace an existing file unless `overwrite` is set, so a model cannot destroy
  content with a whole-file write by accident.
- Writes go through a temporary file in the target directory and a rename. In a world-writable directory
  without the sticky bit another user could swap the temporary file, so such directories are not
  supported targets.
- Unprivileged writes follow symbolic links; privileged tasks refuse them
  ([Methods and targets](privilege.md#methods-and-targets)).
- Reads and edits accept regular files only, so reading a device or FIFO has no side effect and never
  blocks.

### Process groups and cleanup

Every `exec` task runs in its own process group, and when it ends, by exit, timeout or cancellation,
crha kills the whole group. Background children therefore end with the task, and even a root task
cannot leave a daemon behind by accident. A service that must keep running is started through
`systemctl` or `setsid`. Timeouts and cancellation send SIGTERM first and SIGKILL after a grace
period.

crha waits on the task through a pidfd where the kernel supports it, so the process group cannot be
reused by another process before it is signaled.

### State machine

```text
awaiting_approval ──▶ awaiting_authorization ──▶ dispatched ──▶ running ──▶ exited
        │                     │   ▲                  │             ├──▶ failed
        └──▶ rejected         │   └── auth retry ────┘             └──▶ unknown
denied (by a rule, at creation)
```

- A task is created waiting for approval, waiting for a signature, ready to dispatch, or already ended
  (`denied` by a rule). A task with no rule chain, such as one a user starts in the WebUI, skips the
  approval wait.
- Approval waits never expire. A signature wait ends the task as `rejected` after 24 hours
  ([Waiting for signatures](privilege.md#waiting-for-signatures)).
- An approved task is not queued for an offline node. When it is released for dispatch, it waits only
  the short [offline grace](#node-offline) and otherwise fails.
- A waiting task ends without running if its node is deleted or its user loses access to the node.
- After a crhs restart, a task that was approved but not yet sent fails as `dispatch_interrupted`: its
  input lived in memory and nobody would release it again.
- A task group interrupted by a restart or an internal error ends as `interrupted`. Members that did not
  start are cancelled and nodes without a member are recorded as skipped. Groups are never retried.
- `exited` means the command ran and reported an exit code, including non-zero codes. `failed` means
  it could not run or complete.

`unknown` is the only state for "the outcome is not known": the connection was lost and could not be
recovered, the node restarted and no longer knows the task, or the node never confirmed that it
accepted the task. crhs does not guess; the agent or user decides whether to inspect the machine and
retry.

### Node offline

When a task is due to be sent and its node is not connected, crhs waits a short grace period (30
seconds) for the node to reconnect, and otherwise fails the task with `node_offline`. Tasks are never
queued for a later connection, so no task stays pending indefinitely because a node is gone. The grace
covers nodes reconnecting after a crhs restart and brief network problems; a longer absence is a
failure, and the caller decides whether to retry. Tasks waiting for a person are not affected; the node
is checked only when the task is released.

### No duplicate execution and authorization retry

A task id is accepted and executed at most once.

- The only retry is for an authorization refused before the node accepted the task: the task returns to
  waiting for a signature and is sent again with the next attempt number.
- If the connection breaks after the task was sent but before the node answered, crhs never resends it.
  The task becomes `unknown`, because sending it again could run it twice.
- An accepted task is never resent. After a reconnect, crhs only asks the node about it.
- crha does not persist tasks. After crha restarts, it no longer knows its earlier tasks, and they
  become `unknown`.

### Task cancellation

A task that is still waiting has nothing running yet; cancelling it ends it as `rejected`. Otherwise
crhs records the cancellation on the task first and then tells the node, so the cancellation holds even
while the node is offline, and crhs checks the flag again immediately before sending the task. crha also
remembers cancellations for tasks it has not received yet, so a cancellation that overtakes the task is
not lost.

### Task row concurrency

Many paths write the same task row: dispatch, approvals, signatures, node responses and events,
disconnects, re-planning and sweeps. Three rules keep this correct:

1. **Correctness comes from the row version.** Every update increments the row's version, and a write
   based on an earlier read is a compare-and-set on that version. A miss means another path changed
   the row; the caller re-reads and decides again, or gives up. One module, `cluster/task-rows.ts`,
   writes the table.
2. **Queues only reduce conflicts, and a turn stays short.** Each task has a queue, and a turn only
   reads, decides and writes. Waiting for a node or for a response happens between turns: the first
   turn claims the task, the wait happens outside, and the next turn writes the result with a fresh
   comparison. Queues nest in one direction only (task, then group, then trust), which rules out
   deadlocks. Tests fail if a turn waits.
3. **HTTP requests wait only for what must be synchronous.** Submitting a signature stores it and
   returns; planning and dispatch continue in the background. A rule change records its decisions at
   once and dispatches in the background, so editing a rule never waits for an offline node's grace
   period.

## Task groups

A task group runs one task on many nodes, from the WebUI, an agent tool or MCP. Targets are node and
node group references or `_all`; a single node is a single task, and anything else is a group.

- A group targets at most 512 nodes after expansion. More is an error asking the caller to split the
  batch, never a silent truncation.
- Members run with bounded parallelism (10 by default, at most 100).
- Members are independent: a group can end with a mix of results, and nothing is rolled back. One
  approval covers the whole group, but each member is checked against the current rules when it starts,
  so a later deny rule still applies.
- `fail_fast` stops starting new members after a failure. It does not cancel members that already
  started, and a retryable authorization refusal does not count.

## Output

- **One stream.** stdout and stderr share one pipe, as with `2>&1`. The model, the output file and the
  WebUI all read the merged stream, so separating them would serve no one; a command that needs them
  apart can redirect them itself.
- **crhs keeps only the head and tail**, each bounded in lines and bytes. The model sees the tail.
- **The complete output stays on the node** as a file readable only by crha's user, because output may
  contain secrets. A single task spills to the file once it exceeds the kept size; batch tasks always
  spill. The file can be read with an ordinary `read_file` task, and crha removes old files by age and
  total size. SSH nodes have no such file.
- **Output is resumable.** Output carries byte offsets. crha keeps what crhs has not received until crhs
  acknowledges the task's end, and after a reconnect, or a crhs restart, resends from where crhs
  stopped. crhs records a task as finished only when its output is complete.
- **crhs notices are not output.** A notice from crhs, such as "privileged was ignored on this SSH node",
  is stored separately and shown above the output, so a file page stays exactly the file's bytes.

### Batch output

A task group's output mode is fixed when it is created:

| Mode | Used for | What crhs keeps |
|---|---|---|
| `status` | `exec` groups by default | Status, exit code and the path of the node's output file. Nothing is streamed. |
| `text` | `exec` groups that ask for output | The tail of each node's output |
| `head` | All file-operation groups | The head of each node's output, so each node's `file.read` page can be continued on its own |

Kept output is bounded per node and per group. Nodes draw from the group budget in the order their
output arrives, and a node that arrives after the budget is used up keeps no output at all, even if it
failed. This bounds crhs memory regardless of the number of nodes; the complete output of any node is
still in its file. Callers can lower the per-node limits.

## Client connection lifecycle

A crha node keeps one connection to crhs. crha pings every 30 seconds with jitter, and either side
closes the connection after 90 seconds of silence. The heartbeat runs inside the Noise channel rather
than as WebSocket pings, so it proves the whole path works and is not answered by a proxy.

### Reconnect

When the network breaks, crha keeps running its tasks and buffering their output, and reconnects with
exponential backoff (1 second up to 1 minute). On reconnect it reports the tasks it is running, crhs
answers with the output offset it has for each, and crha resends from there. crhs asks about tasks crha
did not report; those crha no longer knows become `unknown`.

- If a disconnect lasts longer than the reconnect grace (two minutes by default), crhs reports the
  affected tasks as `unknown` to the caller. A result that arrives later is recorded, but the answer
  already given does not change.
- Large inputs (stdin or file content, up to 64 MiB) are sent in chunks after the node accepts the task.
  A refused authorization therefore costs no input transfer. An interrupted input transfer cannot
  resume; the task fails.
- After a crhs restart, running tasks on crha nodes get the same grace and are recovered when the node
  reconnects. Tasks on SSH nodes become `unknown` at once, because their connections died with crhs.

## SSH transport

An SSH node installs nothing. crhs runs tasks over SSH behind the same task interface that crha nodes
use.

| Capability | crha | SSH |
|---|---|---|
| Commands and file operations | Yes | Yes; file operations use SFTP |
| Resume after a disconnect | Yes | No; the task becomes `unknown` |
| Connection direction | Node connects to crhs | crhs must reach the node's SSH port |
| Privileged tasks | By privilege mode | Run as the SSH user, with a notice |
| Complete output file | On the node | None |

The `privileged` flag keeps its meaning for rules and approvals on an SSH node, so an agent can run the
same command across both transports, but execution ignores it. When the SSH user is root, that is real
root execution.

### SSH execution

- Each new connection first discovers `sh` and `bash` the same way crha does.
- The remote command is wrapped so that it reports its process group, merges stderr into stdout, and
  then runs the real command. Cancellation and timeouts signal that process group over a second
  channel, as on a crha node.
- A cancellation registered before the command starts prevents it from running at all.
- Each node reuses one connection with keepalives. If a pooled connection turns out to be dead before a
  task starts, crhs retries once on a new connection.
- A failure before the command starts is a connection failure (`connect_failed` or
  `host_key_mismatch`); a disconnect after it starts makes the task `unknown`.

### Jump hosts

An SSH node can be reached through up to five jump hosts, like OpenSSH's `ProxyJump`. Every hop's host
key is pinned separately; all hops currently use the same credential. A disconnect at any hop ends the
whole route.

### Adding an SSH node

1. crhs generates a key pair and stores the private key encrypted with the master key. The administrator
   installs the public key on every hop. SSH credentials belong to the organization and only
   administrators manage them.
2. crhs probes each hop's host key without authenticating, and the administrator verifies and pins each
   fingerprint.
3. The node is created once every hop has a pinned key. A connection test, before or after creation,
   catches a missing public key or an account that cannot run commands.

An SSH node has no standing connection, so it is never shown as online or offline. Its last-seen time
is the last task that reached it.

### Requirements on the node

- The account's login shell must understand POSIX syntax (bash, zsh, dash, ash and ksh work; fish,
  nushell and csh do not). Restricted shells and `ForceCommand` are not supported.
- File tasks need the SFTP subsystem.
- Commands run in a non-interactive session without a PTY, so the environment can differ from an
  interactive login; put needed variables in the task's `env` or use absolute paths.

### SFTP file operations

File operations over SFTP behave like crha's, with these differences: owners and groups cannot be set by
name, a create-only write checks and then renames rather than being atomic, nothing is fsynced, and
modification times have one-second precision. Reading a deep page rescans the earlier lines.

## Reload and upgrade

- **Reload.** Each crha process re-reads its own configuration on SIGHUP, usually sent by the service
  manager. An invalid file is not applied. Some settings, such as the state directory and the privilege
  mode, take effect only after a restart, and crha logs which ones.
- **Configuration changes and upgrades are ordinary privileged tasks**: write the file or the binary,
  then reload or restart the service. A restart ends every running task on the node, including the one
  performing the upgrade, so schedule the restart to happen after the task reports, for example with
  `systemd-run --on-active=2s`. There is no self-upgrade command.
- After a crha restart, its earlier tasks become `unknown`.
