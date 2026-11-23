# Protocol

crhs and crha speak the CRH protocol; crha's two modes speak `crh-priv`. Both use the same CBOR
profile, frame model and strict decoding; `crh-priv` replaces the encrypted transport with a local
stream.

The authoritative wire layouts are the TypeScript ones in `packages/protocol/src/messages.ts` and the
Go ones in `client/internal/protocol/`; `test/interop/` holds the fixtures both implementations must
decode and the vectors they must reject. Both sides are hand-written, so a value must encode to the
same bytes on both sides; the profile fixes every byte that is signed, hashed or compared.

## Encoding rules

Messages are CBOR under one deterministic profile (`CBOR-CORE-INT-v1`). Determinism is a security
property: an authorization id is `SHA-256(payload)`, a spec hash is `SHA-256(CBOR(TaskSpec))`, and a
verifier re-encodes a payload before trusting a signature over it. A single differing byte would make
a valid signature fail on the other side.

- Core deterministic encoding (RFC 8949 §4.2.1): no floats, tags, indefinite lengths, `undefined` or
  custom simple values. Map keys are text or integers; time is an integer count of Unix epoch
  milliseconds.
- A structure is a fixed-length array in the declared order, and the decoder requires the exact
  length. A tuple has no optional field, only nullable ones (`null`). A union is `[tag, body]`; an
  enum is text, and an unknown tag or value is a decode error.
- An open name is text whose set of values grows within a major: lowercase ASCII letters, digits,
  `.`, `_` and `-`, starting with a letter, at most 64 bytes. Any well-formed value decodes and
  re-encodes unchanged, so a peer that predates a value can still carry, hash and verify it; the
  receiver decides what an unknown value means. A value outside the form is a decode error. The
  methods, guard rule match types, trust roles and capabilities of the
  [privilege messages](#privilege-messages), and the `self_upgrade` reasons, are open names.
- Text is valid UTF-8 and is not normalized, because a Linux path is bytes and signatures cover
  bytes. Data that must survive byte for byte uses `bytes`. A sender cleans text from outside the
  protocol and refuses invalid UTF-8.
- Decoding is strict: duplicate keys, non-shortest encodings and trailing bytes are rejected, and the
  decoded value is re-encoded and compared with the input. Both sides do this.
- One frame is at most 60 KiB (`MAX_FRAME_BYTES`), to fit one Noise transport message.

A frame or body that fails to decode is a protocol error: the receiver closes the connection and
sends no error response.

## Handshake payloads

The handshake is the payload of the two Noise IK messages, not a frame. Each payload starts with
`protocol_major`, so a receiver can reject a future major without parsing the rest. The client lists
the names it implements, its version, its clock, and an enrollment record when an unknown key is
enrolling; the server lists its names, the connection id, its clock, the node id and `node_state`.

- The names cover both directions; afterwards the peers use only their intersection.
- `node_state` is `active` or `pending`; a pending node gets a restricted connection.
- An enrollment record (token secret, hostname, facts) is the only way an unknown public key
  completes the handshake.
- A major mismatch or a missing required name refuses the handshake; see
  [Version negotiation](#version-negotiation).

## Frames

After the handshake each message is a request, a response or an event. Requests carry an id from the
requester's own space; a response echoes the request's id and command and may arrive out of order. An
unknown id, or a response command that differs from the pending request, is a protocol error, and a
connection close ends every pending request with an error.

Commands are answered; events are one-way. A known command is decoded and validated before dispatch,
whether or not it was negotiated; only an unknown name skips decoding and is answered
`unsupported_command`. An unnegotiated or undecodable event is a protocol error. A handler that
throws is answered with a generic `internal_error`, never with its internals.

A success response means the command succeeded, not that its work has finished. The common codes are
`unsupported_command`, `node_pending` (a command not allowed on a restricted connection), `busy` and
`internal_error`. A `task.start` for a transfer is refused with `busy` when the node already runs one;
the transfer itself uses `too_large` and `input_mismatch` (a size or SHA-256 mismatch) as error codes.

## Version negotiation

The version is major 1, minor 1. The Noise prologue is `"crh/1"` followed by the server's challenge,
so peers of different majors fail the Noise handshake before a payload is read; the payload's major is
checked too. Major 1 is the protocol of `v0.4.0-rc.1`, the first release under the compatibility rules
([Compatibility](compatibility.md)). Minor 1 adds the [terminal](pty.md) names as optional names: crhs
offers them, while a node offers them only once it implements terminals.

- An incompatible change bumps the major and the prologue. crha and its privileged mode are always
  upgraded together, and crhs is upgraded before its nodes. Across majors crhs keeps only the upgrade
  path ([Compatibility across majors](#compatibility-across-majors)); there is no other compatibility
  layer.
- Within a major only new names are added. A structure is never changed in place; a replacement gets
  a new name such as `task.start.v2`.
- The minor is additive. It may add commands and events, negotiated by intersection; task kinds,
  negotiated through `hello`; and methods, guard match types, trust roles and capabilities, which are
  open names. Nothing else changes within a major.
- The task kinds of the major's base set (`exec`, `file.read`, `file.write`, `file.push`, `file.pull`,
  `file.edit`, `file.stat`, `file.list`) run on every node of the major. Any other kind is sent only to a
  node whose `hello.taskKinds` lists it; otherwise crhs ends the task `unsupported_kind` without
  sending it, since an older node could not even decode its spec.
- The command and event sets have required names and optional names. Every required name must be
  offered, and a missing one refuses the handshake with its name.
- An optional name is negotiated by intersection: a sender uses it only when both sides offered it,
  otherwise it falls back to an older name or gets `unsupported_command`. The terminal names
  (`pty.open`, `pty.resize`, `pty.close`, `pty.meta`, `pty.exited`, `pty.list`) are optional because a
  node of an older minor does not implement them; crhs offers them, and a node offers them only when it
  implements terminals. Frames carry no version field.

`crh-priv` has its own major and minor. Its major must match, and `forward` and `native` also require
an equal `crha_version`, because crha and its privileged mode always upgrade together.

### The major in the clear

crha names its major in the WebSocket request of the control and data connections, as the subprotocol
`crh.<major>` (`Sec-WebSocket-Protocol: crh.1`), and crhs echoes it when it accepts. crhs uses it to
pick the prologue and the codec before the Noise handshake, and refuses a major it does not serve with
HTTP 426, a `CRH-Served-Majors` header and a body naming the majors it serves, so the node logs a clear
reason and crhs logs the attempt (its address and major) although it cannot tell which node it was: the
node's key is encrypted in the handshake. A request that names no `crh.<major>` subprotocol is refused
the same way: the major must be in the clear before the handshake. The header reveals the major to
whoever terminates TLS, which costs nothing worth hiding.

### Compatibility across majors

From `v0.4.0-rc.1` on, as [Compatibility](compatibility.md) requires, crhs keeps an upgrade path to the
nodes of older majors, and each release's documentation states which majors it serves; crhs reports the
same list in `crhs version` and the WebUI. A node of a major outside the window must be upgraded by
hand, or through an intermediate release the documentation names.

The obligation covers the upgrade path only, frozen for each major as it was released:

- the handshake, with that major's prologue and payloads;
- `hello`/`welcome`, `ping`, `facts` (with `self_upgrade` and `upgrade_log_path`) and `node.status`;
- `task.start`, `task.cancel` and the task events for the kind `node.upgrade`, with its data connection,
  and for a `file.read` of the upgrade log, so that a node that rolled back can still say why;
- the hand-over line crha logs when crhs acknowledges a `node.upgrade` result, which the next version's
  installer waits for ([On the node](distribution.md#on-the-node)), and `hello.taskKinds` listing
  `node.upgrade`;
- that major's privilege messages: the [trust summary](#trust-summary), the
  [authorization object](#authorization-object) and the [cosign ticket](#cosign-ticket), which crhs
  plans, signs and verifies, and which the WebUI and `crhu` present to a signer, in that major's format.

A node that predates `node.upgrade` has no upgrade path. crhs keeps one codec per served major, and the
interop fixtures and an end-to-end test against a released crha binary of each served major prove it.

## Commands

| Command | Direction | Purpose |
|---|---|---|
| `hello` | crha → crhs | First command after the handshake; reports the running tasks, supported kinds and privileged mode. crhs answers `welcome` with the output offsets to resume from. |
| `ping` | crha → crhs | Heartbeat; the node echoes the sequence number. |
| `task.start` | crhs → crha | Asks the node to run a task. |
| `task.input` | crhs → crha | One input chunk at a byte offset, after acceptance and in order. |
| `task.cancel` | crhs → crha | Asks the node to stop a task. A cancel that arrives first is remembered, and the later start is refused. |
| `task.query` | crhs → crha | The node's view of a task, used after a reconnect. |
| `pty.open` | crhs → crha | Starts a [terminal](pty.md) with its id, argv, size, privileged flag, scrollback size and opaque crhs metadata, and, for a privileged one, its attempt, authorizations and cosign ticket as `task.start` carries them. Negotiated. |
| `pty.resize` | crhs → crha | Changes a terminal's size. Negotiated. |
| `pty.close` | crhs → crha | Closes a terminal with a reason. Negotiated. |
| `pty.meta` | crhs → crha | Replaces the terminal's opaque crhs metadata. Negotiated. |

`file.push` and `file.pull` tasks move their bytes on a separate
[data connection](#data-connections), never in these commands, and so do terminals.

`pty.open` and `pty.list` carry a `meta` blob that crhs owns: crha stores it and returns it unchanged,
never interpreting it, so crhs can rebuild its memory-only terminal state after a restart
([Reconnect](pty.md#reconnect)).

A task has one merged output stream, and every offset counts bytes in it. `task.cancel` only
acknowledges the signal; the result is `task.exit`. The privilege names are under
[Privilege messages](#privilege-messages).

### task.start

`task.start` carries the task id, attempt, kind and spec, its privileged flag, its authorizations, its
timeouts and its output mode; the fields are in `messages.ts`. Acceptance is the contract:

- crha records the id before answering and starts the task after the response, so every event follows
  it. A task whose response is lost still runs; crhs learns it from the next `hello` and never
  re-sends it.
- The accepted set holds the 16,384 most recent ids for the process lifetime and is not cleared by an
  acknowledgement. A repeat is `already_accepted`; the set is defense in depth.
- `attempt` starts at 1, and only an authorization retry raises it; the task id stays.
- `authorization_required`, `authorization_invalid`, `authorization_expired` and
  `authorization_rejected` are retryable: the task returns to waiting and may be sent again with a
  higher attempt. A rule or path denial is retryable because it does not prove that the owner's
  signature would also be denied. crhs never sends what was refused again: its own signature only
  under a different local window, and only owner authorizations stored after the refused one, so
  this cannot loop (doc/design/privilege.md "The planner").
- `cancelled` means a cancel came first and the task does not run. Every other code is terminal and
  gives the task `errored`: `invalid_spec`, `unsupported_kind`, `privileged_unsupported`,
  `privileged_unavailable`, `already_accepted`. `local_policy_denied` is reserved.
- `full` streams and spills past a size or line threshold, `text` streams and always spills, `status`
  sends no output.
- Input arrives after acceptance, in order and possibly pipelined, and is checked against its declared
  size and SHA-256; a mismatch or an incomplete input kills the task.
- A non-privileged task, and every task in `native` or `ignore` mode, carries no authorization; a
  privileged task in `forward` mode carries at most one, as a CBOR
  [authorization object](#authorization-object), and a [cosign ticket](#cosign-ticket) when the node
  requires crhs's cosignature for it (`cosign`, otherwise null).

## Events

| Event | Direction | Purpose |
|---|---|---|
| `task.output` | crha → crhs | The next bytes of a task's output at a byte offset. |
| `task.exit` | crha → crhs | The task's outcome, output end and optional structured result. |
| `facts` | crha → crhs | The node's facts. |
| `node.status` | crhs → crha | A registration state change: pending, active or rejected. |
| `task.output.ack` | crhs → crha | Releases output the node no longer has to resend. |
| `task.exit.ack` | crhs → crha | Releases the task's retained output and state. |
| `pty.list` | crha → crhs | Every active terminal with its fields, sent after `hello` ([Reconnect](pty.md#reconnect)). Negotiated. |
| `pty.exited` | crha → crhs | A terminal's process ended, with its exit code and the reason (`exited` or `helper_lost`). Negotiated. |

An event has no response; an unnegotiated or undecodable event closes the connection.

Output is delivered in order at byte offsets in the streaming modes, and crha keeps the complete
output on the node. On reconnect `welcome.acks` gives where crhs stopped receiving each task, and the
node resumes there; `task.exit.ack` ends the retention. If the node loses output, its `task.exit`
reports as `output_end` only the contiguous prefix it can still deliver and names no output file, so
crhs records the task with the bytes it received, and sets `output_lost` so every surface can tell the
output is incomplete; it is false when nothing was lost. A `task.exit` whose `output_end` still exceeds the
received bytes means lost output, so crhs closes the connection and the node resends after
reconnecting.

`Facts` describes the node: `hostname` is required, the other keys are optional, and an absent key
means unknown rather than empty. Unknown text keys are ignored, so a fact can be added without a
minor bump; removing one or changing its type needs a major. Facts are not signed or hashed, and node
groups are crhs data that the node does not report.

The system itself is described in two facts written for people and models, never for code: nothing in
crhs or the WebUI may parse them or branch on them.

- `platform` is one line, `<os>, <arch>, <distribution>`: crha's own Go `GOOS` and `GOARCH`, then the
  `PRETTY_NAME` of `os-release` (else `NAME VERSION_ID`, else `ID`), such as `linux, amd64, Ubuntu
  24.04.4 LTS`. crhs keeps at most 256 bytes of it.
- `hints` are short sentences a model needs before it runs anything, one per line: the init system and
  PID 1, the package managers and privilege tools on `PATH` (and their absence), the kernel. At most 16
  lines and 1 KiB, in whole lines; crha truncates and crhs truncates again, since the report is the
  node's.

Separate fields such as an OS id, a version and a package manager list were dropped: a field invites
code to rely on a detection that is only a guess (a package manager on `PATH` is not necessarily the
system's, and PID 1 in a container is rarely an init system).

`task.exit` ends the task with an outcome (exit code, signal or error), the timeout, cancellation and
output-lost flags, the output end, the output file and line count, and an optional result.

**Known limitation:** crhs never sends `task.output.ack`; crha accepts and ignores it, so a node
keeps output for resending until `task.exit.ack`.

### Task results

A structured result travels only in `task.exit.result`, never in the output stream, and only for a
successful task. The union branch is selected by the task kind; `null` means no result. A result must
fit in one frame, so `file.list` stops at 32 KiB of entries and sets `truncated`.

## Privilege messages

The trust report is part of the required command set. crhs never queries trust: crha pushes it after
`hello` and on every change, and a mode that is not `forward` reports `not_forward`.

| Name | Direction | Purpose |
|---|---|---|
| `trust.summary` | crha → crhs, event | The privileged mode's current [trust summary](#trust-summary), including its local approval window. |

There is no per-task local approval exchange. A local administrator opens a window on the node with
`crha approve --for`, and crha pushes a new `trust.summary` when the window opens, closes or
expires. While it is open, crhs may send an ordinary crhs-signed `task.start`; the node waives its
crhs entry's limits (doc/design/privilege.md "Local approval window"). A task whose plan offers a
`local_window` option stays in `awaiting_authorization` with that option on its record; the next
`ok` summary syncs it, and the surfaces render the command text themselves. crhs does not compare the
window's times with its own clock: the window is open until the node reports it closed.

### Trust summary

`TrustSummary` reports the node id, its trust aliases, the clock skew, the run identities of both
modes, the local approval window, and the trust entries: key, role, kinds (`execute`, `cosign`,
`require-cosign`), the `require_*` constraints, an optional TTL cap, and allow and deny rules. The
shapes are in `messages.ts`; what an entry means is in
[Trust configuration](privilege.md#trust-configuration).

- `digest = SHA-256(CBOR(TrustSummary))` lets crhs detect a change and is recorded with the task.
- `aliases` are node-configured UUIDs; an authorization addressed to the node id or an alias is
  accepted. They are not crhs node groups.
- The run identities are here, not in `hello` or `facts`.
- `local_window` is `closed` or `open` with the opening time, the opening uid and the until time.
  A node with no open window still uses `closed`; the field changes the digest, so opening or closing
  a window syncs waiting tasks.

### Authorization object

An authorization is a CBOR payload plus signatures over the exact payload bytes. The payload has a
version, the nodes it addresses, an optional command restriction, issue time and deadline, an
optional task list and attempt, and a note. Every signature of an authorization signs that payload;
crhs's cosignature is a separate [cosign ticket](#cosign-ticket).

- **The id** is `SHA-256(payload)` over the original bytes; a verifier re-encodes the payload and
  compares it with the original, so a signature over non-canonical bytes is rejected.
- **Nodes** are node UUIDs, node-group UUIDs, or `["*"]`. The list cannot be empty; names are
  resolved to UUIDs before signing, so a rename does not invalidate an authorization.
- **Command** is `null` for any command, `spec` (a `spec_sha256` alone) or `prefix` (a method and a
  target). `spec_sha256 = SHA-256(CBOR(TaskSpec))` covers the method and target, environment, working
  directory, input hash and content, and mode and owner, so a `spec` approval covers what runs; the
  method follows from the spec, so the command does not repeat it. A `file.push`/`file.pull` endpoint's
  transfer id is crhs-side routing and is left out, so a group's members hash alike. A privileged
  terminal's `spec` is `SHA-256(CBOR(TaskSpec pty.create))`, whose only field is the argv
  ([Terminals](pty.md#privilege)).
- **Reusable or one-shot.** `task_ids` and `attempt` are both `null` (reusable until the deadline) or
  both set (one-shot). A one-shot authorization has unique task ids and `attempt ≥ 1`, may list only
  node UUIDs, and binds position by position: the task id must be listed, the node id at that
  position must match, and the attempt must match, or it is `authorization_invalid`.
- **The deadline is required in practice.** It is nullable, but a missing deadline is
  `authorization_expired`; without an expiry an authorization could be used forever, and there is no
  revocation.
- **SSHSIG** signs the original payload in the namespace `crh-auth-v1`, in OpenSSH's binary form, so
  `ssh-keygen -Y verify` can check it. **WebAuthn** uses the challenge
  `SHA-256("crh-auth-v1\0" || payload)` in `client_data_json`, with ES256, EdDSA/Ed25519 or RS256.
- An encoded authorization is at most half of `MAX_FRAME_BYTES`, so the rest of `task.start` fits.

### Cosign ticket

A cosign ticket is crhs's confirmation of specific uses of one authorization
([Cosigning](privilege.md#cosigning)): a CBOR payload plus signatures over the exact payload bytes, in
the same `[payload, signatures]` shape as an authorization.

- **The payload** has a version (1), the confirmed authorization's id (its payload's SHA-256), the uses,
  the issue time and a deadline. Each use is a node UUID, a task id and an attempt `≥ 1`. The uses
  cannot be empty, a task id appears once, a node is never `"*"`, and the deadline is not before the
  issue time; a node finds its use by task id and checks the node and the attempt.
- **SSHSIG** signs the original payload bytes in the namespace `crh-cosign-v1`, never `crh-auth-v1`, so a
  ticket signature and an authorization signature can never stand in for each other. Only crhs's keys
  sign tickets; a node counts a signature whose key a `crhs` entry with `cosign` lists, ignores keys it
  does not trust, and refuses a ticket with a trusted signature that does not verify.
- **Size.** The authorization and the ticket together take at most half of `MAX_FRAME_BYTES`. crhs shares
  one ticket across the uses it sends together and splits it per node when it would not fit.

### crh-priv

The modes speak `crh-priv` over a unix socket (`forward`), the helper's stdio (`native`), or the same
socket for `crha approve`, `crha lock` and their state query (the `local` role). It reuses the CBOR
profile, frames and strict decoding, but not the CRH protocol.

- No Noise: threats inside the host are out of scope, and the peer's identity comes from
  `SO_PEERCRED` or the process relationship.
- Frames are length-prefixed on the stream.
- The first pair of frames is its own handshake with a major and minor, the role and `crha_version`.
  The major must match, and the minor is additive. `forward` and `native` also require an equal
  `crha_version`, because the modes come from one binary; a mismatch in `forward` makes privileged
  tasks fail with `privileged_unavailable`.
- Each role requires its names (`task.*` and `trust.query`/`trust.summary` for `forward`, `task.*`
  for `native`, `window.status`/`window.open`/`window.close` for `local`); the rest are optional and
  negotiated by intersection. The terminal names are optional too, and both `forward` and `native`
  offer them: a privileged terminal runs in the privileged mode, which relays its bytes to the
  unprivileged mode — the daemon on the forward connection, or the helper started for that terminal
  ([Privilege](pty.md#privilege)). The unprivileged mode uses a privileged terminal only on a
  connection that negotiated the names; a helper binary from before them lacks them, so a privileged
  `pty.open` there is refused with `privileged_unsupported` while its tasks keep working. `pty.open`,
  `pty.resize`, `pty.close` and `pty.exited` reuse the crhs <-> crha bodies exactly: the privileged
  side ignores `pty.open`'s metadata and scrollback, and always reports `pty.exited` with reason
  `exited`, because the unprivileged mode decides whether a terminal ended or lost its privileged
  mode. Only `pty.input` `[pty_id, data]` and the event `pty.output` `[pty_id, data]` are `crh-priv`'s
  own, since between crhs and crha the bytes travel on the terminal's data connection.
- The role must match the peer: `forward` for the unprivileged uid, `local` for a local approver,
  `native` only on stdio.
- The task bodies are shared with CRH; `native` skips authorization and there are no acks, because
  the unprivileged mode writes its own output file. The trust and window names complete the set.
- The local role has three commands: `window.status` (empty request, current window state),
  `window.open` (a length in milliseconds, opens or replaces the window) and `window.close` (empty
  request). Each answers with the window state: `closed`, or `open` with the opening time, the
  opening uid and the until time.

A forwarded `task.start` has a 30-second timeout. A timed-out start is treated as accepted because it
may still run: the unprivileged mode asks the privileged mode to cancel it and ends the task as
`helper_lost`, which crhs does not retry. Before forwarding an authorization error it refreshes the
trust summary, so crhs's cache is current. A forwarded `pty.open` has the same timeout; a timed-out
one asks the privileged side to close the terminal and answers crhs `helper_lost`.

When a `forward` connection breaks, accepted tasks run to completion and their results go to the
local log, but their output is no longer relayed; the unprivileged mode ends them with `helper_lost`,
and after a restart of that mode crhs marks them `unknown`. Every terminal accepted on that connection
is ended with it: the daemon closes the process groups and records each close, and the unprivileged
mode reports `pty.exited` with code -1 and reason `helper_lost`. A native helper runs one task per
process; if it exits after accepting but before `task.exit`, the task ends `helper_lost` and is not
retried. The helper of a native privileged terminal is the same process for the terminal's whole
life: it refuses a second `pty.open` and a `task.start` while it hosts a terminal, and its exit or
broken stdio before `pty.exited` ends the terminal `helper_lost` with code -1.

## Restricted connections

`node_state = "pending"` tells crha that its connection is restricted. There is no query for the
registration state: crhs pushes every change.

- On a restricted connection crha may send `hello` (with an empty task list), `ping` and `facts`.
  crhs answers `hello` with an empty `welcome`, answers any other command with `node_pending`, and
  pushes only `node.status`.
- **Approval.** crhs pushes `node.status{active}` and closes the connection. crha reconnects at once,
  without backoff, and the new handshake yields a full connection. Permissions are never switched in
  place.
- **Rejection.** crhs deletes the public key, pushes `node.status{rejected}` and closes. crha stops
  reconnecting, and `crha run` exits non-zero with the reason.

## Upgrade-only connections

An active node of an older major in crhs's window gets an upgrade-only connection: the
[upgrade path](#compatibility-across-majors) in that major's codec, and nothing else. crhs creates no
other task for it (a `file.read` only of the upgrade log) and answers every other API request about it
with `upgrade_required`; the WebUI shows the node as needing an upgrade. A pending node of an older
major stays pending until it is upgraded by hand. When the upgraded node reconnects with the current
major, it gets a normal connection.

## Data connections

A data connection carries the bytes of one `file.push` or `file.pull` transfer
([File plane](library.md#file-plane)), or the binary of a `node.upgrade`
([crha self-upgrade](distribution.md#crha-self-upgrade)). It is a separate WebSocket to its own path on the same listener,
so a large transfer never delays the control connection. The path is the control path plus `/data`
(`/agent/data`), and the `crh-data/1` prologue keeps the two handshakes apart.

- The transport is the control connection's: WSS outside, Noise IK inside, the node's static key, and a
  server challenge in the prologue. The prologue prefix is `"crh-data/1"`, so a data handshake can never
  be taken for a control one, or the reverse.
- The client payload holds `protocol_major`, the task id and the transfer id; the server payload holds
  `protocol_major` only. A privileged `file.pull` in `forward` mode sends its chunks to the
  unprivileged mode as `transfer.data` events over `crh-priv`, which relays them; a privileged
  `file.push` receives its content as ordinary `task.input` chunks there. crhs accepts it only from an active node whose control connection is up and
  which has accepted that task, and only once per transfer. Anything else closes the connection.
- After the handshake, each Noise message is one CBOR frame: `[data, bytes]` for a chunk, `[end]` after
  the last chunk, or `[abort, code]`. Chunks are in order, and the sender stops at `[end]` or `[abort]`.
- The receiver verifies the total size and SHA-256 against the task (`file.push`'s spec, or `file.pull`'s
  result) before committing. A mismatch, an abort, or 90 seconds without a frame fails the transfer.
- Flow control is the WebSocket's: the sender waits for its buffer to drain before writing more. The
  receiving node also waits while 8 MiB of a push are buffered ahead of its disk, so the socket's
  backpressure follows the consumer rather than the whole file being held in memory.
- The connection closes after `[end]` or `[abort]`. It never outlives its task, and a task cancel closes
  it.

A terminal has a data connection of its own on the same transport: path `/agent/pty`, prologue prefix
`"crh-pty/1"`, and a client payload with `protocol_major` and the terminal id. crhs accepts it only from
an active node whose control connection is up and which runs that terminal, one connection at a time per terminal. Unlike a
transfer it is bidirectional and has no end-to-end hash: `[data, bytes]` frames carry output from crha
and input from crhs, and `[end]` closes it. It lives as long as the terminal; when it drops, crha keeps
the output in the terminal's ring buffer and opens it again
([crha](pty.md#crha)). **Every new connection begins with the terminal's whole current ring buffer**
as `[data]` frames, then live output; crhs treats each connection as a fresh replay of the screen
rather than a continuation. An `[end]` from crhs closes only the connection, not the terminal, and
crha's `[end]` after the last output means the process exited. The commands, events and this path are
negotiated together as the minor's terminal names.

A transfer endpoint in a task spec is a union. Today it has one variant, `[crhs, transfer_id]`: the node
opens a data connection to crhs. Other endpoints, such as a presigned URL, will come with new negotiated
names ([Extension points](library.md#extension-points)).

## Transport security

The protocol runs over two layers: WSS carries the connection across the network, and a Noise channel
inside it authenticates the two ends and encrypts every message. TLS alone is not enough: whoever
terminates TLS — a reverse proxy, a CDN, a tunnel — would see plaintext and could inject a
`task.start`, which is remote code execution as an ordinary user on every node.

### Threat model

| Attacker | Design goal |
|---|---|
| Network man-in-the-middle: eavesdropping, tampering, replay | No attack succeeds |
| A third party that terminates TLS | Sees only ciphertext and cannot inject messages |
| A stolen enrollment token | Single use, short-lived, and registration still needs confirmation |
| A compromised node | Sees only the tasks sent to it and cannot impersonate another node |
| A compromised crhs | Can send ordinary commands; privilege elevation is limited by the trust configuration of the privileged mode ([Privilege and authorization](privilege.md)) |

### WSS and Noise

- **Outer: WSS (TLS 1.3).** It hides metadata and crosses the network. `tls_verify` is `system` (the
  default) or `none`; with a self-signed certificate `none` loses nothing, because the inner channel
  authenticates both sides.
- **Inner: `Noise_IK_25519_ChaChaPoly_BLAKE2s`.** IK means the client already knows the server's
  static key, which it pinned at enrollment; one round trip authenticates both sides and gives
  forward secrecy. The prologue is the major-version prefix followed by the server's challenge.
- One WebSocket message carries one Noise message. A Noise message is at most 64 KiB, which keeps a
  frame under 60 KiB and output in frames of that size.
- A connection lives at most 24 hours; crha then reconnects and performs a new handshake. There is no
  in-place rekeying, because a reconnect is cheap.

### Handshake and replay protection

1. After the WebSocket opens, crhs sends a 32-byte random challenge; it arrives with the HTTP 101
   response and adds no round trip. A handshake that delivers no first message within 20 seconds is
   closed.
2. crha sends the first Noise IK message with its static key and the client payload. crhs looks the
   key up: an approved node gets a normal connection, a pending node a restricted one, and an unknown
   key with an enrollment record consumes the token, creates a pending node bound to the key, and
   gets a restricted connection. Every other case closes the connection.
3. crhs answers with the second IK message and the server payload. crha reports the clock difference
   in `facts`; the offset is diagnostic only, and a large one is warned about on both sides and in
   the WebUI. The connection then enters `hello`.

**Replay protection.** The first IK message can be replayed. A replayer lacks the client's ephemeral
private key and cannot read the following traffic, but it could make crhs believe that a node
reconnected and displace the real connection. The challenge is therefore part of the Noise prologue:
the prologue enters the handshake hash and is used as associated data for the payload encryption, so
a first message is valid only on the connection whose challenge it used. A replay on another
connection fails to decrypt.

A WireGuard-style timestamp was rejected because it depends on the client clock never moving
backwards: NTP corrections, a dead RTC battery or a virtual-machine rollback would lock a node out
until its clock caught up. A persistent counter fails the same way after a disk rollback or a copied
identity key, and both would need per-node state on crhs. The challenge costs one frame, which
arrives with the 101 response because the client always initiates.

### Keys

| Holder | Key | Algorithm | Use | Consequence of compromise |
|---|---|---|---|---|
| crhs | Server identity key | X25519 | Noise channel | Impersonate crhs and send ordinary commands, without privilege elevation |
| crhs | Authorization signing key | ssh-ed25519 | Sign authorizations and cosign tickets | Elevate on nodes that trust crhs, within their trust entries |
| crhs | Master key | 32-byte symmetric key | Encrypt the `secrets` table | Leak SSH private keys, model API keys and other secrets |
| crha | Node identity key | X25519 | Noise channel | Impersonate this node |

The node identity key is `state_dir/identity.key`, mode 0600; the pinned server key is `server.pub`
in the same directory. crhs reads the master key from `master_key_file` and never stores it in the
database; the server identity private key and the authorization signing key live encrypted with it in
`secrets`.

### Key export

A database backup contains only encrypted private keys and cannot be restored without the master key,
so crhs can export the keys:

- `crhs keys init` generates the master key file, records a non-secret identifier of it in the
  database, and refuses at startup a key file that does not match the database or that is readable by
  group or others.
- `crhs keys export` writes the master key, the server identity key and the authorization signing key
  to a passphrase-encrypted [age](https://age-encryption.org/) file; the standard `age` tool can
  decrypt it without crhs.
- `crhs keys import` restores them on a new deployment with a database backup, after checking that the
  export belongs to the database and that every key matches its row.
- Export and import are local command-line operations only, never available through the WebUI or the
  API. A node needs no export: if its key is lost, it re-enrolls and keeps its record.
- Every key command is recorded in the [audit log](access-control.md#audit) with the actor `cli`; the
  export event names the key fingerprints and the output path, never key material.

### Node registration

1. An administrator creates an enrollment token in the WebUI. It has the form
   `crh1.<server identity fingerprint>.<random secret>`, is valid for one hour, can be used once, and
   can carry a name hint. A token bound to an existing crha node re-enrolls that node instead.
2. On the node, `crha enroll` asks for the crhs address, the token and the setup questions, then
   calls the same enrollment code as `crha register --config <file>` (which reads the token from
   standard input and uses an existing `crha.toml`). crha fetches the server's identity key over
   HTTPS, **checks it against the fingerprint in the token** and pins it, so the token alone
   bootstraps trust. It generates its node key and puts the enrollment record in the first Noise
   message; the token travels inside the channel, so a TLS terminator never sees it, and a replay
   finds the token consumed. Re-enrolling moves an existing `identity.key` and `server.pub` aside as
   `.old` files before this step.
3. crhs validates the token and the node becomes `pending`. An administrator compares the hostname
   and the key fingerprint (`crha status` prints it) and approves the node; a rejection deletes the
   key. Until approval, reconnecting with the same key yields a restricted connection.

A token bound to an existing crha node replaces that node's public key instead of creating a node: the
record keeps its id, name, node groups, access grants and task history, its status returns to
`pending`, and the old key stops authenticating. crhs closes a connection authenticated with the old
key and clears the cached facts and trust report, so the node reports them again after approval. A
token whose node was deleted is invalid.

### Rotation and revocation

- **Revoke a node.** Deleting the node removes its public key; the next handshake fails, and an
  established connection is closed after `node.status{rejected}`.
- **Replace a node key.** Re-enroll the node: its page's **Re-enroll** action issues a token bound to
  the node, and `crha enroll` asks whether to re-enroll and replaces the identity key (or
  `crha register --replace` does the same for a manual layout). The node keeps its record, and an
  administrator approves the new fingerprint. There is no online rotation.
- **Rotate the server identity key.** crhs keeps one server identity key. A node pins the key it saw
  at enrollment and a different key fails the handshake, so replacing the key requires every node to
  re-enroll; each one uses a Re-enroll token, so the node records stay.

## JSON storage forms

The database and the Web API use JSON, not CBOR. `TaskSpec`, `Facts` and `TaskResult` have JSON forms
with camelCase fields and the wire tag as `kind`; optional facts are omitted, and nullable fields are
`null`. The conversions are in `packages/protocol/src/json.ts`; a task spec is stored in `tasks.spec`
and `task_groups.spec`, facts in `nodes.facts`, and the result in `tasks.result`. A trust report is
stored in `nodes.trust_report` and returned by the node trust API in the same JSON form, with bytes
(a Passkey's credential id and COSE key) as standard base64 text (`server/src/cluster/trust.ts`).

## Interop fixtures

Both implementations are hand-written, so `test/interop/` holds fixtures that both must decode and
negative cases that both must reject; see [Interop fixtures](testing/interop.md).
