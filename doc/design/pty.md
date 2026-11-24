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
| `title` | The title the program set through OSC 0/2, sanitized; untrusted text, empty until set |
| `created_by_session_id` | The session whose agent opened it; null when a person opened it |
| `session_ids` | The sessions it is associated with |
| `idle_timeout` | Required when an agent opens it; none when a person does |
| `state` | `running`, `exited` |
| `exit_code`, timestamps | Opened, last activity, ended |

- **Memory only.** The object lives in crha's memory, where the process is, and in crhs's memory as a
  copy. No table holds it; only its audit events are stored. The two copies must agree: a terminal one
  side holds and the other does not, or whose byte streams no longer line up, is closed, never rebuilt
  or guessed ([Reconnect](#reconnect)). A crhs restart therefore ends every terminal, and a crha restart
  every terminal on its node.
- **The creating session** may close the terminal. **The creating session and the associated
  sessions** may read and write it. A person associates a terminal with one of their sessions from the
  WebUI or the API, and removes the association the same way; an agent cannot associate. A session is
  associated with at most the per-session limit of terminals ([Settings](#settings-and-limits)).
- Deleting the creating session closes the terminal. Deleting an associated session removes the
  association.
- **Title.** The program owns the terminal title (OSC 0/2). crhs subscribes to the headless emulator's
  `onTitleChange`, not to the bytes, and stores a sanitized copy: control characters removed,
  whitespace folded and at most 256 characters. It is untrusted text set by whatever runs in the
  terminal, so it is rendered as plain text and never replaces the node in the browser tab, the top
  bar or the meta line. A title change is not an audit event.

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
| `crhs_restarted` | crha listed it after a crhs restart; crhs no longer knows it ([Reconnect](#reconnect)) |
| `stream_lost` | A byte stream could not be continued without a gap: crha's ring buffer or crhs's input buffer no longer held the bytes the other side was missing ([Reconnect](#reconnect)) |
| `disabled` | An administrator turned the subsystem off |
| `node_removed` | The node was removed or revoked (re-enrollment revokes its old key) |
| `user_removed` | The terminal's user was deleted or disabled |
| `helper_lost` | A privileged terminal lost its privileged mode: the `forward` connection broke, or the `native` helper exited before its `pty.exited` |

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
  ([Rules](#rules)). Its target is the argv rendered canonically, as for `exec`, and the login shell
  (empty argv) renders as the empty string ([Methods and targets](privilege.md#methods-and-targets)).
  The node never sees `pty.io`: what is typed into an authorized terminal is not authorized again.
- A privileged terminal's authorization is a `spec` command over the TaskSpec kind `pty.create`, whose
  only field is the argv. The terminal id stands in for the task id and the `pty.open` attempt for the
  task's, so the one-shot ids, used list, local approval window and cosign work unchanged. Size and
  scrollback are not in the spec, so resizing never invalidates an authorization.
- An interactive shell can run anything the privileged identity can, so `pty.create` is treated like `upgrade`
  in guard rules: an entry with `allow` rules refuses it unless an allow rule names it, and crhs warns of
  a deny-only entry that does not deny it (`pty_not_denied`).
- A privileged terminal works in both privileged modes, through whichever privileged channel the node
  has. In `forward` mode the privileged daemon runs the process and relays its bytes over `crh-priv` to
  the unprivileged mode, which carries them on the data connection. In `native` mode the unprivileged
  mode starts one privileged helper for the terminal, with the same escalation tool, argv and relayed
  stderr as a native task ([Native mode](privilege.md#native-mode)); that helper hosts the terminal
  and lives exactly as long as it does. Native mode does not authorize the terminal, exactly as it
  does not authorize a native task, and the helper's relayed stderr lines are the only record of it.
- The unprivileged mode uses a privileged channel only when the connection negotiated the `crh-priv`
  terminal names. A daemon or helper binary without them, and a mode that has no privileged channel
  (`reject`, `ignore`, and an unset mode), refuse a privileged `pty.open` with
  `privileged_unsupported`. A forward connection that is down refuses it with
  `privileged_unavailable`; a native helper that cannot be started refuses it the way a native task's
  helper does, with `privileged_unsupported` and the escalation tool's error.
- A relayed terminal is the same object as a local one: the same id, argv, size, `privileged` flag,
  scrollback ring and `startedAt`, the same `pty.list` entry, retention and close semantics. Only
  its process side differs: output arrives as `pty.output` events into the ring, and input, resize and
  close are sent back as `pty.input`, `pty.resize` and `pty.close` in order. The daemon streams output
  through the connection's bounded outbox; when it is full, that terminal's reader waits and the PTY
  applies backpressure to the process, while the connection's other traffic never waits (the existing
  queueing drops or bounds its own events and never blocks on a terminal). The privileged side's
  `pty.exited` ends a relayed terminal exactly like a local process exit, and crhs sees reason `exited`.
  `pty.close` closes the terminal's process group and, in native mode, ends the helper: crha reaps it,
  killing it after a bounded wait if it does not leave.
- When the `forward` connection breaks, every relayed terminal ends as `helper_lost` with exit code -1:
  its output ends, the data connection sends `[end]` after the remaining ring, and the entry stays as
  exited under the usual retention. A native helper that exits, or whose stdio breaks, before its
  `pty.exited` ends its terminal the same way. The daemon closes every terminal it accepted on that
  connection, process groups included, and writes one audit record per terminal; a native terminal's
  close is recorded by the helper's relayed stderr line.
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
  prints anything. `KillMode` covers the process group, so a child of the shell dies with it. A relayed
  terminal has no local process: its backend is the node's privileged channel — the shared daemon
  connection in `forward` mode, the helper of that terminal in `native` mode — its output comes from the
  privileged side and its input, size and close go back over it. Losing that channel ends it as
  `helper_lost` (-1) rather than dropping it (see [Privilege](#privilege)).
- **Data connection.** Each terminal has one data connection, opened by crha after `pty.open`: the
  transport of [Data connections](protocol.md#data-connections) on its own path and prologue
  (`/agent/pty`, `crh-pty/1`). Unlike a transfer it is bidirectional: output frames go to crhs, input
  frames come back. Terminal bytes never travel on the control connection.
- **Two continuous byte streams.** A terminal's output and its input are each one stream numbered from
  byte 0. A terminal is stateful, an escape sequence or a UTF-8 character can span any two bytes, so
  each side must receive the other's stream without a gap or a repeat. Every data connection handshake
  states where to continue: the client payload carries how many input bytes crha has received, the
  server payload how many output bytes crhs has received. crha continues its output from there, out of
  its ring buffer; crhs continues its input from there, out of a buffer of the last 64 KiB of input it
  sent. When either buffer no longer holds the bytes the other side is missing, the streams cannot
  line up: crha answers `[abort, stream_lost]` (or crhs does), and crhs closes the terminal with reason
  `stream_lost`. Nothing is replayed and no screen is rebuilt.
- While no data connection is up, output only fills the ring buffer; the process is never blocked by
  crhs. A sender that falls more than the ring capacity behind live output has lost bytes, so the
  terminal ends with `stream_lost` as well.
- An exited terminal crhs has not closed keeps its data connection worker: on a reconnect it continues
  the output from crhs's offset to the end and sends `[end]`.
- **`pty.close`.** crha drops the terminal at once — a running process gets crosspty's close sequence
  (SIGHUP, then SIGKILL after the grace period) for its whole process group — and answers the
  command; an unknown id is still a success. crhs asked for the close, so no `pty.exited` is emitted
  for a terminal closed this way. An exited terminal is only dropped, its PTY freed.
- Control messages go on the control connection: `pty.open`, `pty.resize`, `pty.close` (commands) and
  `pty.exited`, `pty.list` (events).

### Reconnect

When crha connects, after `hello`, it sends `pty.list`: the id of every terminal it holds, and for an
exited one its exit code. The two sides then agree or close:

- A listed terminal crhs holds continues. crha opens its data connection again, and both streams
  continue from the offsets in the handshake ([crha](#crha)); an exit that happened while crhs was away
  is taken from the list. A terminal whose streams cannot continue ends with `stream_lost`.
- A listed terminal crhs does not hold is one crhs forgot by restarting: crhs sends `pty.close` with
  reason `crhs_restarted` and audits it. crhs never adopts a terminal it did not open in this process.
- A terminal crhs holds for that node that is not listed is gone from crha: crhs closes it with reason
  `crha_restarted`.

Only continuity is kept. crhs restarting ends every terminal; crha restarting ends every terminal on
its node; a dropped connection between two running processes loses nothing.

## crhs

- The terminal subsystem holds the copies, checks access and limits, records the audit events, and runs
  the idle timers.
- Each running terminal has a headless terminal emulator (`@xterm/headless`) fed with its output. It gives
  a joining viewer the current screen at once, gives the agent tools a text snapshot, and is the
  terminal's single responder: when the program's output asks a terminal query — a cursor position
  report, device attributes, and so on — the parser answers, and the answer goes back to the program as
  input on the terminal's input stream, numbered and buffered like any other input. A browser never
  answers a query: it forwards only user input (keyboard, paste, IME, mouse), using xterm.js's own
  user-input signal.
- **Viewers.** The WebUI attaches through `GET /api/ptys/:id/attach` (WebSocket, binary frames for bytes,
  JSON frames for resize and state). Several viewers can attach to one terminal and every one of them
  can type; input from all of them is written in arrival order. Every viewer forwards only its user's
  input: xterm.js's automatic replies to terminal queries are never sent back, so several viewers never
  answer one query several times. A viewer that cannot keep up with the output past a buffer limit is
  disconnected with a reason and can attach again.
- **Size.** A terminal has one size. It changes only when a viewer or an agent resizes it explicitly;
  attaching or resizing a browser window does not. A resize is sent to crha and broadcast to every
  viewer, whose terminal adopts the new rows and columns. The viewer does not change the grid to fit
  its window: it scales its font so the whole grid fits, and scrolls inside the terminal area when
  the minimum font cannot show it all (see [WebUI](#webui)). **Fit to window** is the explicit resize
  a person can send: it computes the rows and columns that fill the viewer's terminal area at the
  default font size, then uses `POST /api/ptys/:id/resize`; every viewer adopts the new size and each
  one scales its own font to fit it.
- **Title.** `view.title` carries the program's sanitized title. A change is pushed to every attached
  viewer as a `state` frame and appears in the next list poll.
- **API.** `GET /api/ptys`, `POST /api/ptys` (node, privileged, argv, size), `GET /api/ptys/:id`,
  `POST /api/ptys/:id/resize`, `PUT`/`DELETE /api/ptys/:id/sessions/:sessionId` for associations,
  `POST /api/ptys/:id/approval` for a waiting rule approval, and `DELETE /api/ptys/:id` to close. The
  approvals API (`GET /api/approvals`) lists the caller's waiting terminal approvals beside the tasks,
  external calls and signatures.

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
| `pty_list()` | The terminals this session created or is associated with; each carries `title` (untrusted program text) |
| `pty_read(id, mode?)` | Non-blocking. `screen` (default): the current screen as text with the cursor position. `output`: what was written since this session's last read, escape sequences stripped, capped. Both carry the program's sanitized `title`, marked `title_untrusted`. While a full-screen program holds the alternate screen, `output` is unavailable and the current screen is returned in the `screen` shape with a note |
| `pty_watch(id, timeout, keywords?, bell?)` | Blocks until one of the conditions, then returns the reason and the screen |
| `pty_write(id, text?, keys?)` | Writes text and named keys (`Enter`, `Tab`, `Escape`, `Up`, `Ctrl-C`, …) |
| `pty_resize(id, rows, cols)` | Resizes it |
| `pty_close(id)` | Closes a terminal this session created |

- **Named keys and modes.** The cursor keys follow the terminal's current mode, read from the
  headless emulator's public `modes.applicationCursorKeysMode`: while a program has application
  cursor keys enabled, `Up`/`Down`/`Left`/`Right` send `ESC O A/B/C/D` and `Home`/`End` send
  `ESC O H` / `ESC O F`; otherwise the normal `ESC [ A` style sequences. Other keys are unchanged.
- **Title is untrusted.** Nothing in a tool result is an instruction: a `title` is text the program
  inside the terminal set, and the tools mark it `title_untrusted` so the model can tell it from the
  node and the command.
- **Full-screen programs.** While the headless buffer is the alternate screen
  (`terminal.buffer.active.type === "alternate"`), the program is drawing a picture, not writing a
  log: that output is not appended to the escape-stripped log, so `pty_read output` and the log
  matching of `pty_watch` never see it. `pty_read` with mode `output` returns the current screen
  instead, in the same shape as mode `screen` (text, cursor, size) with a short note that a
  full-screen program is running and output mode is unavailable. `pty_watch` matches a keyword on
  the alternate screen when it is on the screen now and was not on the screen when the watch started,
  or when the alternate screen began during the watch. After the program leaves the alternate
  screen, `pty_read output` and `pty_watch` resume on the normal screen with only the text written
  after leaving.
- **Rules.** `pty_open` is decided under `pty.create`, `pty_write` and `pty_resize` under `pty.io`
  ([Rules](#rules)). `pty_read`, `pty_watch` and `pty_list` need no decision.
- **`pty_watch`** is a blocking call, not a job. It ends at the first of:
  - `timeout`, required, at most the configured maximum;
  - a keyword appearing in the output written since the watch started, matched as plain text after
    escape sequences are stripped, with a tail kept across chunks so a keyword split between two reads
    still matches — or, while the alternate screen is active, a keyword new to that screen (see
    **Full-screen programs** above);
  - a bell, when `bell` is set: a BEL the terminal parser sees on its own, not the BEL that ends an OSC
    sequence such as a window title;
  - the process exiting or the terminal closing;
  - the session being stopped.

  It returns the reason, the matched keyword if any, and the screen. A data connection that drops and
  reconnects continues the stream, so a watch spans it unchanged. After a crhs restart every terminal is
  closed, so a replayed watch, read or write reports that the terminal is gone.
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
  approval shows the input and the keys instead; Auto Review sees the current screen as context.
- Allowing one method implies nothing about the other: `allow pty.create` does not allow typing, and an
  agent typing into a terminal a person associated with its session needs `pty.io` only.
- **Presets.** Ask and Auto Review leave both methods to their default, `require-approval`; Auto Review
  answers them first with the screen as context. Yolo allows them.
- "Always allow" on a `pty.create` approval proposes the argv as an `exact` target; on a `pty.io`
  approval it proposes `allow pty.io` for that node and privileged flag. A candidate is offered only
  when appending it to the root would end the approval, as for every other approval.

### Approvals

A terminal rule approval is an ordinary approval (doc/design/access-control.md "Approvals"), not a
terminal-only notice:

- The server builds the same compact `ApprovalRequest` every surface renders, with kind `pty`, the
  acting session as its source, the node name, the privileged flag and a structured action:
  `{type:"pty.create", argv}` for an open and `{type:"pty.io", input, keys}` for a write or resize. The
  screen is not part of the request: it stays on the server as Auto Review's context, and no WebUI or
  chat card renders it.
- The approvals API lists it (with the other waiting requests and its `rootSessionId`), the WebUI's
  Approvals page and pending badge count it, and the chat channels send the same approval card. The
  terminal page shows the same request inline through the shared approval panel; the terminal view
  carries it as `approvalRequest`. The session page's decision dock shows it like a task's approval,
  and decides it through the terminal route.
- An agent-created privileged terminal that waits for its owner's signature is listed the same way:
  the same `PtyApprovalItem` with a request whose phase is `awaiting_signature` and a `pty.create`
  action, under `authorizations.ptys`. The session dock renders it with the shared signature panel and
  the terminal's own reject route; a person-opened terminal has no session, so its wait stays on its
  terminal page.
- While it waits, the acting session is `awaiting` with wait kind `approval`, exactly as for a task or
  an external call; deciding it makes the session `running` again. A privileged terminal's signature
  wait makes the session `awaiting` with wait kind `authorization` until it opens, fails or is closed.
  Stopping the session or ending its run rejects the pending terminal approvals. A crhs restart has no
  terminal waits: terminals and their approvals are memory-only.
- Auto Review answers first when its preset is on; an escalated request waits for the user.
- The decision is the ordinary body `{decision: "approve"|"reject", reason?, always?}` through
  `POST /api/ptys/:id/approval`, from the approvals page, the terminal page, the session dock or chat.
  Only the terminal's user decides, like every approval's owner. An `always` rule must be an allow rule
  that would end the approval and is appended to the root of the request's chain.

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

- **Terminals** is in the **Work** group of the navigation, directly below **Library**, hidden while
  `pty.enabled` is off. The page lists the terminals the user can see (all of them for an
  administrator): node, the program's title, user, state, creating session, associated sessions and
  age. A privileged terminal carries the shared **Privileged** mark beside its title; there is no
  privileged or viewers column. **New terminal** picks an active crha node with the shared
  `EntityPicker` (SSH nodes have no terminals), a command, the privileged mode and a size.
- `/terminals/:id` attaches with xterm.js, bundled with the WebUI. The heading is the program's title;
  without one it is the command line, the argv joined with spaces, or the localized "Terminal" for
  an empty argv. The browser tab and the top bar show `<heading> · <node>`. One small grey meta line
  carries the state, node, size, creating user and, when exited, the exit code. The title is untrusted
  text: it is rendered plain, truncated with its full text on hover, and never replaces the node in
  the tab or the meta line. The terminal keeps its own rows and columns;
  the viewer scales its font so the whole grid fits both width and height, recomputed on window and
  terminal resize, and scrolls inside the terminal area below a sensible minimum font size. **Fit to
  window** resizes the terminal to the viewer's area at the default font size, so every viewer adopts
  the same grid and then scales its own font to it. Opening or returning to the page focuses the
  terminal. The page shows the other viewers (one entry per user, with a count for several
  attachments) and the associations, which use the server-searched session `EntityPicker` restricted
  to the terminal user's own sessions. A short hint says that selecting text needs Shift while a
  program uses the mouse; it sits on the **Extra keys** toggle's row and wraps with the toggle on a
  narrow screen.
- An **extra-keys bar** below the terminal sends Esc, Tab, Ctrl, Alt, the arrows, Home, End, PgUp,
  PgDn and `| ~ / -` by dispatching keyboard events to xterm.js's textarea, so xterm generates the
  sequence for the terminal's current modes. It scrolls horizontally when it does not fit. Touch
  devices (`pointer: coarse`) show it by default; a button toggles it on desktop, and the choice is
  remembered per viewer. Ctrl and Alt are sticky: one tap applies to the next key, a double tap locks
  them until tapped again. Soft-keyboard text typed while Ctrl is active becomes the control
  character of the next character, and Alt prefixes it with ESC.
- A viewer forwards no data produced by a mouse click, button or movement, because several people
  share the terminal; wheel events are forwarded (local scrollback, xterm's alternate-scroll arrows
  and the program's mouse wheel reports). The browser decides by event source, never by parsing
  escape sequences.

## Audit

Session-level events only; no input or output:

| Event | Detail |
|---|---|
| `pty.opened` | Node, privileged, argv, size, creating session, how it was authorized |
| `pty.attached`, `pty.detached` | Viewer, client address |
| `pty.associated`, `pty.unassociated` | Session |
| `pty.approval` | Rule method, decision and reason |
| `pty.closed` | Reason, exit code, duration, bytes in and out |

An agent's `pty_write` is a tool call like any other and stays in its session's transcript.

## Protocol additions

All within major 1, negotiated by the minor ([Version negotiation](protocol.md#version-negotiation)):

- Commands `pty.open`, `pty.resize`, `pty.close`; events `pty.exited`, `pty.list`. crhs
  uses them only with a node that offered them in its handshake; any other node answers a terminal request
  with `unsupported_node`.
- The terminal data connection: path `/agent/pty`, prologue `crh-pty/1`, client payload
  `[protocol_major, pty_id, input_received]`, server payload `[protocol_major, output_received]`; frames
  `[data, bytes]` in both directions, `[end]` after the last output, and `[abort, code]`.
- `pty.open` carries the terminal's authorization like `task.start`: `attempt`, `authorizations` and
  `cosign` follow its existing fields; an unprivileged terminal sends 0, an empty list and null.
  `pty.exited` carries a reason, `exited` or `helper_lost`.
- `crh-priv`: optional names for the privileged mode to run a terminal and relay its bytes. `pty.open`,
  `pty.resize`, `pty.close` and `pty.exited` reuse the bodies above (the privileged side ignores the
  scrollback and always reports reason `exited`); only the command `pty.input`
  `[pty_id, data]` and the event `pty.output` `[pty_id, data]` are its own. The `forward` and `native` roles
  both offer them; a helper binary from before them lacks the names, and a privileged `pty.open` then
  answers `privileged_unsupported` while its tasks keep working. `pty.open` has the same 30-second
  timeout as a forwarded `task.start`: on a timeout crha asks the privileged side to `pty.close` and
  answers crhs `helper_lost`.
- Method `pty.create` in authorizations and guard rules, over the TaskSpec kind `pty.create`
  `[argv]`.

## Implementation notes

These are decisions the implementation had to make where this document leaves a detail open; they are
part of the contract for the WebUI and the API.

- **States.** A terminal is `opening` while its rule approval or signature wait is pending, and only
  then are an in-memory approval (`pty.create`/`pty.io`) and the planned authorization options
  attached to its view. `running` and `exited` are the object's states from [Lifecycle](#lifecycle).
- **Replayed calls.** Within one crhs process a replayed `pty_open` finds the terminal it already opened
  by its tool call key, kept in memory. After a crhs restart that terminal was closed as
  `crhs_restarted`, so a replayed `pty_open` that had not finished opens a new one, and a replayed
  read, watch, write, resize or close reports the terminal gone.
- **Attach frames.** `GET /api/ptys/:id/attach` is a WebSocket authenticated by the session cookie.
  The first server frame is a JSON `{type:"snapshot", data, rows, cols}` holding the serialized screen,
  modes included, so a viewer joining after a program enabled application cursor keys sends the same
  key sequences; binary frames are output bytes. JSON state frames are
  `{type:"state", rows, cols, title, state, viewers}`, `{type:"exited", exitCode, reason}` and
  `{type:"closed", reason}`. The client sends binary frames as input and may send
  `{type:"resize", rows, cols}`. A viewer past a 4 MiB socket buffer is disconnected with reason `slow`.
- **Rule approvals and signatures.** A rule approval is the ordinary `ApprovalRequest`, decided through
  `POST /api/ptys/:id/approval` with the ordinary approval body; the terminal view carries it both as
  `approval` (with the server-built "always allow" candidates) and as `approvalRequest`. The signature
  wait is served by `GET /api/ptys/:id/authorization` in the same `phase`/`PendingAuthorization` shape
  as a task's, signed through the ordinary `POST /api/authorizations`, and declined through
  `POST /api/ptys/:id/authorization/reject`.
- **Data connections.** A terminal's data connection is accepted only from the node that holds the
  terminal (`pty.list`'s node): a connection naming a terminal id from another node is closed as an
  unknown terminal and never replaces the real connection.
- **Error codes.** The API and the tools name the refusal: `disabled`, `node_not_found`, `node_offline`,
  `unsupported_node`, `invalid_size`, `invalid_argv`, `idle_timeout_required`,
  `idle_timeout_too_large`, `limit_node`, `limit_total`, `limit_session`, `rule_denied`,
  `approval_rejected`, `approval_pending`, `not_found`, `session_not_found`, `session_not_owned`,
  `not_waiting`, `not_running`, `not_connected`, `exited`, `invalid_key`, `timeout_too_large`,
  `authorization_declined`, and the node's own `busy`, `invalid_spec`, `privileged_unsupported` and
  `privileged_unavailable`.
- **Output reads and watches.** crhs keeps a bounded (256 KiB) escape-stripped text log beside the
  emulator. `pty_read output` reads from the session's cursor in it, at most 64 KiB per call; `pty_watch`
  matches plain text against it, keeping a keyword-length tail across chunks. Output written while the
  parser is on the alternate screen is not appended to that log, so each session's cursor skips it;
  `pty_read output` returns the screen with a note instead (and moves that session's cursor to the end
  of the log), and `pty_watch` matches the alternate screen against the screen it started with. The
  switch is taken from the headless buffer's `onBufferChange` event, never by parsing escape sequences.
  A dropped data connection continues both streams, so the log and every watch continue too.
- **User input in the browser.** The headless emulator answers terminal queries, and a browser must not
  add its own answer. In @xterm/xterm 6.0.0, `CoreService.triggerDataEvent(data, wasUserInput)` fires
  `coreService.onUserInput` synchronously immediately before `onData` when — and only when — the data is
  user input. `onUserInput` is not public, so `web/src/features/terminals/user-input.ts` reaches it
  through `term._core.coreService.onUserInput`; if the hook is missing at runtime the helper fails closed
  (forwards nothing and logs a console error). `@xterm/xterm` is pinned at exactly 6.0.0 for this reason,
  and `user-input.test.ts` guards it: it writes `ESC[6n` and `ESC[c` to a real xterm.js terminal and
  asserts that no automatic reply is forwarded, while typing and paste still are.
- **Mouse sharing.** `user-input.ts` also listens on the terminal element in the capture phase for
  `mousedown`, `mouseup`, `mousemove`, `click`, `auxclick` and `wheel`, and marks the kind of mouse
  event being dispatched (cleared in a bubble listener and a microtask). `onData` produced during a
  non-wheel mouse event is dropped, and `onBinary` (mouse-only) is forwarded only during a wheel.
  Keyboard, paste and IME input are unaffected. This keeps one viewer's click from typing into
  everyone's shared shell while wheel scrolling still works.

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
