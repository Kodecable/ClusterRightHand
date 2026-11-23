# Terminals

A terminal is an interactive shell on a crha node, held open by crha and reached through crhs: a person
types into it from the WebUI, several people can watch and type into the same one, and an agent can read
it, watch it and write to it. This document describes the terminal object, its lifecycle, crha's and
crhs's parts, the WebUI page, the agent tools and the audit events.

A terminal is its own object, not a task. A task is one bounded operation with a spec, a result and a
record; a terminal is a long-lived process whose input nobody can know in advance. Tasks keep the
non-interactive `exec`; there is no PTY mode for `exec`.

CRH is an operations console, and an interactive shell is part of one. What it records is the terminal's
existence and who touched it, at the level of the session, not what was typed or shown
([Audit](#audit)). An administrator can turn the whole subsystem off ([Settings](#settings-and-limits)).

## Scope

- **crha nodes only.** SSH nodes have no terminals: a shell there would live on crhs's SSH connection and
  die with crhs, unlike everything else about a terminal. A request for one fails with
  `unsupported_node`.
- **Linux only**, like crha. crha runs the shell with [crosspty](https://github.com/Kodecable/crosspty).
- **Privileged terminals exist.** A terminal opened in crha's privileged mode runs as the privileged
  mode's identity after an authorization at open ([Privilege](#privilege)).
- **No recording.** Neither the input nor the output is stored beyond crha's scrollback buffer and
  crhs's screen state in memory. Recording can come later.

## The terminal object

| Field | Meaning |
|---|---|
| `id` | UUIDv7 chosen by crhs at open; crha keeps the same id |
| `node_id` | The crha node |
| `user_id` | The user it belongs to: the person who opened it, or the owner of the session whose agent opened it |
| `privileged` | Whether it runs in the privileged mode |
| `argv` | The command; default the identity's login shell with `-l` |
| `size` | Rows and columns; changed only by an explicit resize |
| `created_by_session_id` | The session whose agent opened it; null when a person opened it |
| `session_ids` | The sessions it is associated with |
| `idle_timeout` | Required when an agent opens it; none when a person does |
| `state` | `running`, `exited` |
| `exit_code`, timestamps | Opened, last activity, ended |

- **Memory only.** The object lives in crha's memory, where the process is, and in crhs's memory as a
  copy. No table holds it; only its audit events are stored. A crhs restart rebuilds the copy from crha
  ([Reconnect](#reconnect)); a crha restart ends every terminal on the node.
- **The creating session** may close the terminal. **The creating session and the associated
  sessions** may read and write it. A person associates a terminal with one of their sessions from the
  WebUI or the API, and removes the association the same way; an agent cannot associate. A session is
  associated with at most the per-session limit of terminals ([Settings](#settings-and-limits)).
- Deleting the creating session closes the terminal. Deleting an associated session removes the
  association.

## Lifecycle

1. **Open.** From the Terminals page, the API, or an agent's `pty_open`. crhs checks the subsystem is on,
   the limits, node access, and, for an agent, the session's rules; a privileged terminal also gets its
   authorization. crhs sends `pty.open` to the node.
2. **Running.** crha starts the process on a PTY of the requested size and opens the terminal's data
   connection ([crha](#crha)). Output flows to crhs whether or not anyone is attached.
3. **Exited.** The process ended by itself. crha reports `pty.exited` with the exit code. The object
   stays, read-only, for five minutes or until the last viewer detaches, whichever is later, so
   viewers see the last screen and the exit code; then it is gone.
4. **Closed.** Every way a terminal ends has a reason in its `pty.closed` event:

| Reason | When |
|---|---|
| `manual` | A person (its user or an administrator) or the creating session closed it |
| `idle` | The idle timeout ran out ([Idle](#idle)) |
| `exited` | The process ended by itself |
| `session_deleted` | The creating session was deleted |
| `crha_restarted` | crha came back without it ([Reconnect](#reconnect)) |
| `disabled` | An administrator turned the subsystem off |
| `node_removed` | The node was removed or revoked |
| `helper_lost` | A privileged terminal lost its privileged mode: the `forward` connection broke or the `native` helper exited |

Closing sends the process a hangup and follows crosspty's close sequence: SIGHUP to the process group,
then SIGKILL after the grace period, so child processes of the shell do not outlive it.

### Idle

A terminal opened by a person has no idle timeout: it stays until it is closed or its process exits.
A terminal opened by an agent must have one, at most the configured maximum.

A terminal is idle when all of these hold:

- nobody is attached in the WebUI;
- no `pty_watch` on it is running;
- the creating session and every associated session are `idle`
  ([Session state](agent-runtime.md#session-state)). A session waiting for a job's completion notice is
  `idle`, so it counts as idle; a session `running` or `awaiting` does not.

Output does not count: a terminal running `tail -f` with nobody looking at it is idle. The timer starts
when the terminal becomes idle and resets whenever it stops being idle.

## Privilege

A privileged terminal is authorized once, at open, through the ordinary paths: a crhs trust entry, the
owner's signature, or the node's local approval window ([Privilege](privilege.md)). What runs inside it
afterwards is not authorized command by command; the authorization covers the terminal.

- `pty.create` is a method of its own, in authorizations and guard rules as in crhs rules
  ([Rules](#rules)). Its target is the argv rendered canonically, as for `exec`
  ([Methods and targets](privilege.md#methods-and-targets)). The node never sees `pty.io`: what is typed
  into an authorized terminal is not authorized again.
- An interactive shell can run anything the privileged identity can, so `pty.create` is treated like `upgrade`
  in guard rules: an entry with `allow` rules refuses it unless an allow rule names it, and crhs warns of
  a deny-only entry that does not deny it (`pty_not_denied`).
- In `forward` mode the privileged daemon runs the process and relays its bytes over `crh-priv` to the
  unprivileged mode, which carries them on the data connection. In `native` mode the helper started for
  the terminal stays alive as long as the terminal.
- A person opening a privileged terminal from the WebUI waits on the same signature panel as a privileged
  task.

## crha

- crha keeps a map of active terminals in memory: the object's fields, the crosspty handle, and a ring
  buffer of the latest raw output (the size crhs sends in `pty.open`). The ring holds at least 64 KiB
  and at most 16 MiB, whatever crhs asks for.
- A terminal stays in the map after its process exits: with its last output and its exit code, until
  crhs sends `pty.close` or, if crhs never does, ten minutes after the exit.
- At most 64 terminals are held at once, running or exited and not yet closed. The 64 is a backstop
  against a crhs that loses track, not the configured limit (crhs enforces that): a `pty.open` beyond
  it is refused with `busy`.
- The process starts through crosspty's `New` and `Start`, so the reader is in place before the shell
  prints anything. `KillMode` covers the process group, so a child of the shell dies with it.
- **Data connection.** Each terminal has one data connection, opened by crha after `pty.open`: the
  transport of [Data connections](protocol.md#data-connections) on its own path and prologue
  (`/agent/pty`, `crh-pty/1`), with the terminal id in the client payload. Unlike a transfer it is
  bidirectional: output frames go to crhs, input frames come back. Terminal bytes never travel on the
  control connection.
- **Every connection is a replay.** A new data connection starts with the whole current ring buffer,
  as `[data]` frames chunked at the protocol's chunk size, and only then follows live output. crhs
  treats each connection as a fresh replay of the screen, so a reconnected terminal never continues
  mid-stream. A sender that falls more than the ring capacity behind live output would have to skip
  bytes; crha closes its connection and opens a new one, which replays instead. While no data
  connection is up, output only fills the ring buffer and the process is never blocked by crhs.
- **An exited terminal is replayed once per control connection.** A terminal whose process ended but
  that crhs has not closed still gets a data connection on each new control connection: it replays
  the ring buffer, ends with `[end]`, and its worker stops until the next control connection.
- **`pty.close`.** crha drops the terminal at once — a running process gets crosspty's close sequence
  (SIGHUP, then SIGKILL after the grace period) for its whole process group — and answers the
  command; an unknown id is still a success. crhs asked for the close, so no `pty.exited` is emitted
  for a terminal closed this way. An exited terminal is only dropped, its PTY freed.
- Control messages go on the control connection: `pty.open`, `pty.resize`, `pty.close`, `pty.meta`
  (commands) and `pty.exited`, `pty.list` (events).

### Reconnect

When crha connects, after `hello`, it sends `pty.list`: every held terminal, running or exited, with
its fields, its state and, for an exited process, its exit code. crhs:

- adopts each listed terminal into its copy, rebuilding its owner, its creating and associated
  sessions and its idle timeout from the terminal's `meta` blob, which crhs owns and crha returns
  unchanged; crha opens the data connections again for the running terminals, and each one begins
  with the ring buffer's replay; for an exited terminal crhs has not closed, crha replays the ring
  buffer once and ends with `[end]`;
- rebuilds each terminal's screen state by replaying the ring buffer into a fresh emulator. If output
  was lost beyond the ring buffer, the screen starts from the oldest kept byte;
- closes, with reason `crha_restarted`, any terminal it knew on that node that is not listed.

An exited terminal crhs has not closed yet is listed too, with its exit code, and stays on the node
until the close arrives or ten minutes pass after the exit. On each new control connection it is
replayed once, ending with `[end]`. A terminal crhs closed on the node before the reconnect is not
listed.

crhs does not keep terminals across its own restart other than through this list, so a crhs restart
loses nothing that crha still holds.

## crhs

- The terminal subsystem holds the copies, checks access and limits, records the audit events, and runs
  the idle timers.
- Each running terminal has a headless terminal emulator (`@xterm/headless`) fed with its output. It gives
  a joining viewer the current screen at once and gives the agent tools a text snapshot.
- **Viewers.** The WebUI attaches through `GET /api/ptys/:id/attach` (WebSocket, binary frames for bytes,
  JSON frames for resize and state). Several viewers can attach to one terminal and every one of them
  can type; input from all of them is written in arrival order. A viewer that cannot keep up with the
  output past a buffer limit is disconnected with a reason and can attach again.
- **Size.** A terminal has one size. It changes only when a viewer or an agent resizes it explicitly;
  attaching or resizing a browser window does not. A resize is sent to crha and broadcast to every
  viewer, whose terminal adopts the new rows and columns.
- **API.** `GET /api/ptys`, `POST /api/ptys` (node, privileged, argv, size), `GET /api/ptys/:id`,
  `POST /api/ptys/:id/resize`, `PUT`/`DELETE /api/ptys/:id/sessions/:sessionId` for associations,
  `DELETE /api/ptys/:id` to close.

## Access

- A person opens a terminal on a node they have node access to; only node access is checked, as for a
  task run from the WebUI ([Access control](access-control.md)). Rules apply to agents, not to people.
- A terminal's user sees it, attaches to it, resizes, associates and closes it.
- Administrators see every terminal and can attach to, resize and close any of them without further
  checks. Their attach is audited like anyone's.
- A share viewer of a session does not see its terminals.

## Agent tools

The tools are offered to every agent session, root or subagent, while the subsystem is on. MCP clients
do not get them: an MCP client has a terminal of its own.

| Tool | Does |
|---|---|
| `pty_open(node, argv?, privileged?, size?, idle_timeout)` | Opens a terminal created by this session; `idle_timeout` is required |
| `pty_list()` | The terminals this session created or is associated with |
| `pty_read(id, mode?)` | Non-blocking. `screen` (default): the current screen as text with the cursor position. `output`: what was written since this session's last read, escape sequences stripped, capped |
| `pty_watch(id, timeout, keywords?, bell?)` | Blocks until one of the conditions, then returns the reason and the screen |
| `pty_write(id, text?, keys?)` | Writes text and named keys (`Enter`, `Tab`, `Escape`, `Up`, `Ctrl-C`, …) |
| `pty_resize(id, rows, cols)` | Resizes it |
| `pty_close(id)` | Closes a terminal this session created |

- **Rules.** `pty_open` is decided under `pty.create`, `pty_write` and `pty_resize` under `pty.io`
  ([Rules](#rules)). `pty_read`, `pty_watch` and `pty_list` need no decision.
- **`pty_watch`** is a blocking call, not a job. It ends at the first of:
  - `timeout`, required, at most the configured maximum;
  - a keyword appearing in the output written since the watch started, matched as plain text after
    escape sequences are stripped, with a tail kept across chunks so a keyword split between two reads
    still matches;
  - a bell, when `bell` is set: a BEL the terminal parser sees on its own, not the BEL that ends an OSC
    sequence such as a window title;
  - the process exiting or the terminal closing;
  - the session being stopped.

  It returns the reason, the matched keyword if any, and the screen. A watch replayed after a crhs
  restart returns that the watch was interrupted, or that the terminal is gone.
- A tool call on a terminal the session may not use, or one that no longer exists, returns an error
  result naming why.

## Rules

An agent's terminal operations go through the session's rules ([Rules](access-control.md#rules)) under
two methods of their own:

| Method | Covers | Target | `privileged` matcher |
|---|---|---|---|
| `pty.create` | `pty_open` | The argv rendered canonically, as for `exec` | Whether the terminal is opened privileged |
| `pty.io` | `pty_write`, `pty_resize` | None; `exact` and `prefix` never match it | Whether the terminal is privileged |

- `privileged` is a flag of `pty.create`, as it is of an `exec` task, and a privileged `pty.create`
  also needs its node authorization ([Privilege](#privilege)). A terminal keeps the flag, so a rule can
  treat writing into a privileged terminal differently: `allow pty.io` with `privileged: false` lets the
  agent type into its ordinary terminals while a root shell still asks.
- `pty.io` has no target. Rules have no regular expressions, and a prefix of typed text is no boundary:
  input is keystrokes, not a command line, and what it does depends on the program reading it. The
  approval and Auto Review show the input and the current screen instead.
- Allowing one method implies nothing about the other: `allow pty.create` does not allow typing, and an
  agent typing into a terminal a person associated with its session needs `pty.io` only.
- **Presets.** Ask and Auto Review leave both methods to their default, `require-approval`; Auto Review
  answers them first with the screen as context. Yolo allows them.
- "Always allow" on a `pty.create` approval proposes the argv as an `exact` target; on a `pty.io`
  approval it proposes `allow pty.io` for that node and privileged flag.

## Settings and limits

System settings:

| Setting | Default |
|---|---|
| `pty.enabled` | on |
| `pty.max_per_node` | 8 |
| `pty.max_total` | 64 |
| `pty.max_per_session` | 4, terminals a session created or is associated with |
| `pty.agent_idle_timeout_max` | 1 hour |
| `pty.watch_timeout_max` | 10 minutes |
| `pty.scrollback_bytes` | 1 MiB, crha's ring buffer per terminal |

Terminals opened by agents count toward the node and total limits like any other. Turning `pty.enabled`
off closes every terminal with reason `disabled`, hides the Terminals page and removes the agent tools
from the next request.

## WebUI

- **Terminals** is its own entry in the navigation. The page lists the terminals the user can see (all
  of them for an administrator): node, user, privileged, state, creating session, associated sessions,
  viewers, age. A button opens a new terminal on a chosen node.
- `/terminals/:id` attaches with xterm.js, bundled with the WebUI. It shows the terminal's size, a
  **Fit to window** button that resizes the terminal to the viewer's window, the other viewers, and the
  associations. An exited terminal shows its last screen and exit code.
- The session page lists the session's terminals and links to them.

## Audit

Session-level events only; no input or output:

| Event | Detail |
|---|---|
| `pty.opened` | Node, privileged, argv, size, creating session, how it was authorized |
| `pty.attached`, `pty.detached` | Viewer, client address |
| `pty.associated`, `pty.unassociated` | Session |
| `pty.closed` | Reason, exit code, duration, bytes in and out |

An agent's `pty_write` is a tool call like any other and stays in its session's transcript.

## Protocol additions

All within major 1, negotiated by the minor ([Version negotiation](protocol.md#version-negotiation)):

- Commands `pty.open`, `pty.resize`, `pty.close`, `pty.meta`; events `pty.exited`, `pty.list`. crhs
  uses them only with a node that offered them in its handshake; any other node answers a terminal request
  with `unsupported_node`.
- The terminal data connection: path `/agent/pty`, prologue `crh-pty/1`, client payload with
  `protocol_major` and the terminal id; frames `[data, bytes]` in both directions and `[end]`.
- `crh-priv`: optional names for the privileged mode to run a terminal and relay its bytes: commands
  `pty.open`, `pty.input`, `pty.resize`, `pty.close`, events `pty.output`, `pty.exited`.
- Method `pty.create` in authorizations and guard rules.

## Documents that change with this design

- [Architecture](architecture.md): the "No interactive terminal" limitation goes.
- [Execution plane](execution.md): tasks have no PTY mode; SSH nodes have no terminals.
- [Protocol](protocol.md): the commands, events, data connection and `crh-priv` messages.
- [Privilege](privilege.md): the `pty.create` method and its guard-rule treatment.
- [Access control](access-control.md): who sees and uses terminals, the `pty.create` and `pty.io` rule
  methods and the presets; the audit events.
- [Agent runtime](agent-runtime.md): the tools.
- [WebUI](webui.md): the Terminals page.
- [crhs configuration](../guide/reference/crhs-config.md) and the [WebUI guide](../guide/webui.md): the
  settings and the page, when they are implemented.
- [Compatibility](compatibility.md): nothing; terminals keep no files or tables.
