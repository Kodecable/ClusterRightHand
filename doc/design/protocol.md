# Protocol

crhs and crha speak the CRH protocol; crha's unprivileged and privileged modes speak `crh-priv`. Both
use the same CBOR profile, frame layout, command/event abstraction and strict decoding; `crh-priv`
replaces the encrypted transport with a local stream. This document is the authority for the online
format: the TypeScript implementation in `packages/protocol` and the Go implementation in
`client/internal/protocol` are hand-written from it and cross-checked with the fixtures in
`test/interop/`. When the two sides disagree, this document and the fixtures decide. What the
messages make the system do is described in [Execution plane](execution.md), [Privilege and
authorization](privilege.md) and [Architecture](architecture.md).

## Encoding rules

Every frame and payload is CBOR under the profile `CBOR-CORE-INT-v1`:

- RFC 8949 §4.2.1 Core Deterministic Encoding, not the §4.2.3 length-first order.
- TypeScript uses `cborg` 6.x with `rfc8949EncodeOptions`; Go uses `fxamacker/cbor/v2` with
  `CoreDetEncOptions()`.
- Floats, tags, indefinite lengths, `undefined` and custom simple values are forbidden. Integers
  stay in the native CBOR major 0/1 range; no bignum tag is used.
- Map keys are text or integers (CBOR major 0, 1 or 3). Any other key type is an error when encoding
  and when decoding.
- Time is an integer count of Unix epoch milliseconds. ISO strings, automatic `Date` or `time.Time`
  encoding and tag 1 are not used.
- Text is valid UTF-8 without Unicode normalization. Linux paths are byte sequences and
  normalization could name another file; signatures cover the exact bytes and rules match them
  exactly. Paths that are not valid UTF-8 are not supported; a future `.v2` command would carry them
  as byte strings.
- Strict decoding rejects duplicate keys, non-shortest encodings and trailing bytes.

On top of the profile:

- **A structure is a fixed-length array (tuple)** in the order listed in this document. The decoder
  requires the exact length. There are no optional fields, only nullable ones, marked `?` and
  encoded as CBOR `null`. The one exception is `Facts`, a map with text keys.
- **A union is `[tag, body]`**, where `tag` is text and `body` is the branch's type. An unknown tag
  is a decode error.
- **An enum is text** with the values listed next to the type. Any other value is a decode error.
- **Primitives** are `uint` (0 ≤ n ≤ 2^53−1), `int` (|n| ≤ 2^53−1), `bool`, `text` (valid UTF-8,
  not normalized), `bytes` (a CBOR byte string), `[T]` (an array) and `{text: text}` (used only for
  `env`, with unique keys). An integer outside 2^53−1 is a decode error in a protocol schema; the
  profile itself allows the full native range, and the golden vectors test the profile layer.
- **Strict decoding** proceeds in three steps: decode under the profile (which rejects tags,
  indefinite lengths, duplicate keys and trailing bytes), check types and lengths against the
  schema, then re-encode the decoded value and compare it with the original bytes. A difference is
  an error. This one check rejects non-shortest encodings, a float posing as an integer and a
  non-canonical map order. Both ends perform it.
- Field semantics, including sentinel values such as `0` and `""`, are those of the schemas in this
  document.
- One encoded frame is at most 60 KiB (`MAX_FRAME_BYTES = 61440`) so that it fits one Noise transport
  message.
- **The sender is responsible for the validity of `text`.** An encoder refuses invalid UTF-8 rather
  than send bytes that would make the receiver disconnect. Text from outside the protocol (the
  contents of `/etc/os-release`, a hostname, a path inside an operating-system error) is cleaned
  before it enters a protocol structure; Go uses `strings.ToValidUTF8(s, "�")`. Content that must be
  preserved byte for byte travels in a `bytes` field.

A frame or body that fails to decode is a protocol error: the receiver closes the connection and
sends no error response.

## Handshake payloads

Handshake payloads are not frames. They are the payloads of the two Noise IK messages. The first
element of each is always `protocol_major`, including in future majors: the receiver reads that
element first and, when it does not match, does not parse the rest.

```text
HandshakeInit     = [protocol_major: uint, protocol_minor: uint, commands: [text],
                     crha_version: text, client_time_ms: int, enroll: Enrollment?]
Enrollment        = [token_secret: text, hostname: text, facts: Facts]

HandshakeResponse = [protocol_major: uint, protocol_minor: uint, commands: [text],
                     connection_id: text, server_time_ms: int,
                     node_state: "active" | "pending", node_id: text]
```

- `commands` lists every command and event name the sender implements, counting both directions.
  After the handshake the two sides send only names in the intersection.
- `Enrollment` is present only when an unknown node key is enrolling. `token_secret` is the secret
  part of an enrollment token; registration is described under [Node
  registration](#node-registration).
- `node_state` tells crha whether the connection is a full connection (`active`) or a restricted one
  (`pending`). `node_id` is the node's UUID.
- `client_time_ms` and `server_time_ms` are diagnostic. The difference is the clock offset that crha
  reports later in `facts`; no authentication depends on it.
- A `protocol_major` mismatch is refused without parsing the rest of the payload, and a `commands`
  list without a required name refuses the handshake; both rules are in [Version
  negotiation](#version-negotiation).

## Frames

```text
request  = [0, id: uint, cmd: text, body]
response = [1, id: uint, cmd: text, true,  body]
         | [1, id: uint, cmd: text, false, Error]
event    = [2, name: text, body]

Error    = [code: text, message: text]
```

- The sender limits `Error.message` to 1024 bytes of UTF-8, after cleaning it and truncating on a
  code-point boundary. The receiver does not check the length.
- A command or event name (`cmd`, `name`) is at most 64 bytes. A frame whose name is longer is a
  protocol error; it is not answered with `unsupported_command`.
- `id` is allocated by the requesting side and increases from 1. The two directions have independent
  id spaces: a response carries the id of the request it answers.
- A response's `cmd` equals the `cmd` of its request. A response with an unknown `id`, or with a
  `cmd` that differs from the pending request, is a protocol error.
- Responses may arrive out of order; they are matched by `id`. When the connection closes, every
  pending request ends with a connection error. An implementation may set a deadline on a request;
  the TypeScript peer uses 60 seconds by default. A request that times out is withdrawn, and a late
  response for it is ignored without closing the connection.
- A command that was not negotiated is answered with `unsupported_command`. An event that was not
  negotiated is a protocol error.
- A command name the receiver knows is decoded against its schema before dispatch, whether or not it
  was negotiated and whether or not a handler is registered; a decode failure is a protocol error.
  Only a name the receiver does not know at all skips body decoding and is answered directly with
  `unsupported_command`. The success response body is always decoded and validated too, whether or
  not the caller looks at it.
- A handler may return a success response that cannot be encoded (the body does not match the
  schema, or the frame exceeds `MAX_FRAME_BYTES`). The peer then sends an `internal_error` response
  instead and never stays silent; a hook that runs after the response is not run. If the error
  response cannot be sent either because the connection is closed, the request ends as a connection
  error.
- An unexpected exception in a handler is logged locally and answered with a generic `internal_error`
  message, so that SQL, paths and other internals do not reach the peer.
- A peer may cap the inbound handlers that run at once. A request above the cap is answered with
  `busy` without running, which tells the sender that the request was not accepted. The TypeScript
  peer caps them at 64 by default; `0` disables the cap. Events are not limited.

Common error codes are `unsupported_command`, `node_pending` (a command that is not allowed on a
restricted connection), `busy` and `internal_error`.

## Version negotiation

The CRH protocol version is major 3, minor 0. The Noise prologue is `"crh/3"` followed by the
server's challenge.

- A peer with a different major is refused. crhs closes the WebSocket with close code 1008 and the
  reason `protocol_major mismatch: server 3, client N`; crha closes the connection and reports the
  reason. Both sides treat it as a handshake failure (`HandshakeError`). Because the major is part of
  the prologue, peers with different majors fail the Noise handshake itself, before the payloads are
  compared.
- An incompatible change bumps the major and the prologue prefix. There is no compatibility layer
  across majors: crha, its privileged mode and crhs are upgraded together.
- The minor version is additive only. A different minor does not refuse the handshake: new commands
  and events are optional and are negotiated through the `commands` intersection. A handshake is
  refused only when a required name is missing.
- The required names are those in the command and event tables of [Commands](#commands) and
  [Events](#events). A missing one refuses the handshake with the reason
  `missing required command: <name>`. The names added for privilege (`trust.summary`, `local.*`) are
  optional; a node that does not offer them is treated as not supporting `forward`.
- Within one major, only new commands and events are added; existing structures are not changed or
  removed. A replacement gets a new name, such as `task.start.v2`.
- Frames after the handshake carry no version field: the negotiated set and the fixed structures
  already constrain them.
- A name is used only when both sides advertised it; otherwise a sender falls back to an older name
  or the receiver answers `unsupported_command`.

`crh-priv` versions itself separately, with its own major and minor: its major must be equal on both
sides, and the `forward` handshake also requires an equal `crha_version`. Both rules are described
under [`crh-priv`](#crh-priv).

## Commands

| Name | Direction | Request body | Success response body | Error codes |
|---|---|---|---|---|
| `hello` | C→S | `Hello` | `Welcome` | none (also allowed on a restricted connection) |
| `ping` | C→S | `[seq: uint]` | `[seq: uint]` (returned unchanged) | |
| `task.start` | S→C | `TaskStart` | `[]` | see below |
| `task.input` | S→C | `[task_id: text, offset: uint, data: bytes]` | `[]` | `unknown_task`, `input_out_of_order`, `input_too_large` |
| `task.cancel` | S→C | `[task_id: text]` | `[]` | none (an unknown or finished task also succeeds; a cancel for an unknown id is remembered, see [`task.start`](#taskstart)) |
| `task.query` | S→C | `[task_id: text]` | `TaskStatus` | none (an unknown task returns `state = "unknown"`) |

The privilege commands and events are listed under [Privilege messages](#privilege-messages).

`ok = true` means the command succeeded, not that the work it started has finished. For
`task.start`, a success response is acceptance: crha has recorded the task id and runs the task, and
a later failure arrives as a `task.exit` event, never as a second error response. `ok = false` is a
refusal before acceptance, in one of three classes: `authorization_*` codes are retryable and the
task can be sent again with a higher attempt, `cancelled` means a cancel arrived first and the task
did not run, and every other code is terminal and gives the task `failed` with that `error_code`.

```text
Hello      = [tasks: [TaskStatus], task_kinds: [text], privileged_mode: text]
Welcome    = [acks: [OutputAck]]
OutputAck  = [task_id: text, offset: uint]
TaskStatus = [task_id: text, state: "running" | "exited" | "unknown", output_end: uint]
```

- `hello` is the first command after the handshake. `tasks` lists the tasks the node is still
  running, `task_kinds` the kinds it supports, and `privileged_mode` the configured handling of
  privileged tasks. crhs answers `welcome`; its `acks` are the output offsets from which the node
  resumes. On a restricted connection `hello` is answered with an empty `welcome`, and a task
  command is answered with `node_pending`.
- `ping` is the heartbeat. The node echoes `seq` in the response; see [Heartbeat](execution.md#heartbeat)
  for the timing.
- `task.input` carries one chunk of a task's input at `offset`. It is sent only after a successful
  `task.start`, may be pipelined without waiting for each response, and is processed in order.
- `task.cancel` only acknowledges that the cancel was received and a signal was sent; the final
  result of the task is its `task.exit` with `cancelled = true`. Cancelling a finished task, or an id
  the node does not know, also succeeds.
- `task.query` returns the node's view of a task. A task the node does not know is
  `state = "unknown"`; `ok = false` is reserved for a genuine error such as a malformed body.

### task.start

```text
TaskStart  = [task_id: text, attempt: uint, spec: TaskSpec, privileged: bool,
              authorizations: [bytes], timeout_ms: uint, kill_grace_ms: uint, output: OutputMode]

OutputMode = ["full",   [spill_bytes: uint, spill_lines: uint]]   ; single task: stream in real time, spill past the thresholds
           | ["text",   []]                                       ; batch text: stream in real time, always spill
           | ["status", []]                                       ; no output (single or batch): push nothing, always spill

TaskSpec   = ["exec",      ExecSpec]
           | ["file.read",  [path: text, start_line: uint, line_count: uint]]
           | ["file.write", [path: text, content: InputRef, overwrite: bool, mode: uint, owner: text, group: text,
                             create_parent_dirs: bool]]
           | ["file.edit",  [path: text, edits: [[old_text: text, new_text: text]]]]
           | ["file.stat",  [path: text]]
           | ["file.list",  [path: text, limit: uint]]

ExecSpec   = [command: Command, env: {text: text}, cwd: text, stdin: InputRef?]
Command    = ["argv", [text]] | ["shell", text]
InputRef   = [size: uint, sha256: bytes]          ; sha256 is exactly 32 bytes
```

- `attempt` starts at 1. Only an authorization retry increases it.
- A success response is acceptance. Before sending it, crha records `task_id` in its accepted set.
  The response is sent before execution starts, so every event of the task follows the response.
- A task that is in the accepted set but whose success response could not be sent, because the
  connection broke, still executes. Acceptance is already decided, crhs does not send the task
  again, and it picks the task up from the `hello` of the next connection and receives its output
  and `task.exit`.
- The accepted set is kept for the lifetime of the crha process; a `task.exit.ack` does not remove
  an id. It holds at most the 16384 most recent ids, and a hit is answered with `already_accepted`.
  crhs never re-sends an accepted task; the set is defense in depth.
- Each element of `authorizations` is a `CBOR(Authorization)` (see [Authorization
  object](#authorization-object)). It is empty for a non-privileged task, for `native` and `ignore`
  modes, and for a local approval. At most one element is allowed; more is `authorization_invalid`.
- Errors:
  - Retryable, after which the task returns to `awaiting_authorization`:

    | Code | Situation |
    |---|---|
    | `authorization_required` | No authorization and no usable local approval |
    | `authorization_invalid` | The authorization does not decode, a signature is invalid, the trust entry is missing, the node or an alias does not match, the task id is not in `task_ids`, `attempt` differs, or there is more than one authorization |
    | `authorization_expired` | Expired, issued in the future, without a `deadline`, or beyond `max_ttl` |
    | `authorization_rejected` | Already used, at or below the used-list watermark, the command restriction does not cover the task, `require_exact` / `require_task` / `require_uv` is violated, a guard rule, environment or path is denied, a cosignature is missing, or the trust entry has no `execute` |

    The `message` names the validation step that failed; see [Validation
    flow](privilege.md#validation-flow). A rule or path denial is retryable as well: a refusal of
    crhs's signature path does not mean that the owner's signature would be refused. crhs never
    retries its own signature path, so this does not loop.
  - Terminal, after which the task ends as `failed` with `error_code` set to the code:
    `invalid_spec` (an empty id, a hash of the wrong length, or `size` 0 with a `sha256` other than
    the SHA-256 of empty input), `unsupported_kind`, `privileged_unsupported` (`reject` mode; in
    `native` mode the privilege tool is unavailable or the helper version differs),
    `privileged_unavailable` (`forward` mode with an unreachable privileged mode),
    `local_policy_denied` (reserved for a node-local policy; crha does not return it) and
    `already_accepted` (the task id already ran on this node).
  - `cancelled`: crha received a `task.cancel` for the id before the `task.start`. The task did not
    run; crhs ends it as `rejected` with `error_code = cancelled` and does not retry.
- For a task id crha does not know yet, `task.cancel` records the cancel: at most 1024 ids, expiring
  after 10 minutes, evicting the oldest when full. A `task.start` that arrives later is answered
  `cancelled` and is not run.
- In `forward` mode the unprivileged mode forwards `task.start` unchanged to the privileged mode
  (see [`crh-priv`](#crh-priv)); the privileged mode's response is the response here. A forwarded
  request has a 30-second timeout. A `task.start` that times out is treated as accepted, because it
  may be queued in the privileged mode and may still run; the unprivileged mode asks the privileged
  mode to cancel it and ends the task as `helper_lost`, with an unknown outcome that crhs does not
  retry. Before forwarding an `authorization_*` error, it queries the privileged mode for the
  `TrustSummary` again; when the digest changed it sends a `trust.summary` event first and then the
  error response, so crhs's cache is already current when it handles the error.
- `task.input` is sent only after the success response, and the input is the exec stdin or the
  `file.write` content. One input is at most 64 MiB. The offset is the byte offset in the input.
- `file.read` reads by line: `start_line` counts from 1, and the task reads at most `line_count`
  whole lines, with the page at most 50 KiB (`FileReadMaxBytes` = 51200 bytes). The node scans from
  the start of the file to the first requested line, sends only whole lines, and stops at the first
  line that does not fit; it does not read to the end of the file. The output is the page's bytes
  with the file's own line endings. Information about the page is in `task.exit.result` (see [Task
  results](#task-results)), not in the output stream: `from` and `to` are the first and last line
  numbers of the page and are both 0 for an empty page; `eof` says that the scan reached the end of
  the file; `total` is the file's line count and is present only when `eof` is true; `too_long` says
  that the first requested line alone is larger than 50 KiB, in which case the page is empty.
  `file.read` and `file.edit` operate on regular files only. The node checks the type before reading
  or editing; a character or block device, a FIFO, a socket or a directory is refused with
  `not_regular_file` (message "`<path>` is not a regular file"), without opening a device or
  waiting for a writer on a FIFO. `file.edit` refuses an existing target of another type in the same
  way. `file.write` does not open an existing target (it stats it to keep mode and owner and
  publishes by rename), so it is not subject to this check.
- `file.write` with `create_parent_dirs` true creates missing parent directories first, like
  `mkdir -p`: new directories get mode 0755 before the umask and the same owner as the identity that
  writes the file. Authorization rules still consider only the target file path; the parent
  directories are its prefixes and cannot extend the allowed range. The field is part of
  `TaskSpec`, so it is covered by the spec hash of an `exact` authorization.

## Events

| Name | Direction | Body |
|---|---|---|
| `task.output` | C→S | `[task_id: text, offset: uint, data: bytes]` |
| `task.exit` | C→S | `TaskExit` |
| `facts` | C→S | `Facts` |
| `node.status` | S→C | `[node_id: text, state: "pending" \| "active" \| "rejected" \| "disabled", message: text]` |
| `task.output.ack` | S→C | `OutputAck` |
| `task.exit.ack` | S→C | `[task_id: text]` |

An event has no response. An unnegotiated or undecodable event is a protocol error and closes the
connection. `task.output` carries the next bytes of a task's output at `offset`; `task.exit` is the
task's final event; `facts` reports the node's facts; `node.status` reports a state change of the
node; the two acknowledgements release buffers on the node. crha handles `task.output.ack`, but crhs
does not send it: crhs acknowledges output through `welcome.acks` on reconnect and through
`task.exit.ack` when the task ends (see [Execution plane](execution.md)).

```text
TaskExit = [task_id: text, outcome: Outcome, timed_out: bool, cancelled: bool,
            output_end: uint, output_file: text, output_lines: uint,
            result: TaskResult?]
Outcome  = ["code", int] | ["signal", text] | ["error", Error]      ; signal without the SIG prefix

Facts    = {text: any}                    ; CBOR map with text keys, see the table below
```

`Facts` is the only protocol structure that is not a fixed tuple. It describes the node and gains
entries as the node software changes, and it is not part of authorization, signatures or hashes.

| Key | Type | Required |
|---|---|---|
| `hostname` | `text` | yes |
| `os_id`, `os_version_id`, `os_pretty_name`, `kernel`, `arch`, `init_system`, `notes_path` | `text` | no |
| `package_managers`, `privilege_tools` | `[text]` | no |
| `clock_offset_ms` | `int` | no |
| `shells` | `{text: any}`: `sh: text` (required), `bash: text?` (absent or `null` means there is no bash) | no; absolute paths of the `sh` and `bash` the node discovered, see [The exec environment](execution.md#the-exec-environment) |

- An absent optional key means "unknown", not an empty value. Unknown text keys are ignored, also
  inside `shells`. A non-text key (for example an integer), a known key of the wrong type, or a
  missing required key fails the whole `Facts`; no part of it is used.
- The groups a node belongs to are not part of `Facts`. crhs maintains node groups and uses them
  with the access grants to decide visibility; the node does not report them.
- Strict decoding applies as usual: the profile rejects duplicate keys, a non-canonical map order and
  non-shortest encodings, and the byte comparison is against the re-encoding of the generic CBOR
  value, which keeps unknown keys, not against a structure decoded under the schema.
- A later fact is added as a new optional key without bumping `protocol_minor`. Removing a key or
  changing the type of an existing key needs a new major version.
- Wire keys are snake_case. The JSON form (`factsToJson` / `factsFromJson`) is a camelCase object
  with absent keys omitted, as described under [JSON storage forms](#json-storage-forms). The facts
  of an SSH node contain only `shells`, from the connection probe (see [SSH
  execution](execution.md#ssh-execution)), and are never encoded on the wire.
- A task has one output stream: crha connects stdout and stderr of the command to the same pipe. The
  `offset` of `task.output`, the `output_end` of `TaskExit` and of `TaskStatus`, and the `offset` of
  `OutputAck` are all byte offsets in this one stream.
- `output_lines` is the line count of the output, the same bytes `output_file` holds: the number of
  newline characters, plus one when the last line has no newline, and 0 when there is no output.
  crha counts it in `full`, `text` and `status` modes; crhs uses it for the "lines X–Y of N"
  truncation notice (see [Tool output](agent-runtime.md#tool-output)).
- Input error codes, in the `error` branch of `Outcome`: `input_mismatch` (the input does not match
  its `InputRef`: it is longer than the declared size, or its SHA-256 differs; a running task is
  killed) and `input_incomplete` (the connection broke before the whole input arrived; the task is
  killed).

### Task results

A task's structured result travels only in `task.exit.result`. Its type is selected by the task
kind; `null` means that there is no result. Only kinds that produce structured data have a branch;
`exec` has none. The result never enters the output stream. It is present only when the task ended
successfully; a failed task has no result.

`size`, `uid` and `gid` are `int` (`uid` and `gid` are -1 on a non-Unix node), `mode` is a four-digit
octal permission string, and `mtime` is an RFC 3339 time. `link_target` is present only when `path`
is a symbolic link.

A result must fit in one frame. `file.list` stops listing when the entries' fields reach
`FileListMaxBytes` (32 KiB) and sets `truncated`, so a large directory cannot push `task.exit` past
`MAX_FRAME_BYTES`.

```text
TaskResult = ["file.read",  FileReadResult]
           | ["file.write", FileWriteResult]
           | ["file.edit",  FileEditResult]
           | ["file.stat",  FileStatResult]
           | ["file.list",  FileListResult]

FileReadResult  = [from: uint, to: uint, eof: bool, total: uint?, too_long: bool]
FileWriteResult = [bytes: uint, created: bool]
FileEditResult  = [replacements: uint]
FileStatResult  = [path: text, type: "file" | "dir" | "symlink" | "other", size: int, mode: text,
                   uid: int, gid: int, owner: text, group: text, mtime: text, link_target: text?]
FileListResult  = [entries: [FileListEntry], truncated: bool]
FileListEntry   = [name: text, type: "file" | "dir" | "symlink" | "other", size: int, mode: text, mtime: text]
```

```text
TaskResult = ["file.read", [from: 1, to: 3, eof: true, total: 3, too_long: false]]
TaskResult = ["file.stat", [path: "/etc/hosts", type: "file", size: 220, mode: "0644",
                            uid: 0, gid: 0, owner: "root", group: "root",
                            mtime: "2026-01-01T00:00:00Z", link_target: null]]
TaskResult = ["file.list", [[[name: "a.txt", type: "file", size: 3, mode: "0644",
                              mtime: "2026-01-01T00:00:00Z"]], truncated: false]]
TaskResult = ["file.write", [bytes: 3, created: true]]
TaskResult = ["file.edit", [replacements: 1]]
```

## Privilege messages

The privilege message set carries the privileged mode's trust report and the local approval flow.
Its semantics, including the authorization decision and the trust configuration, are described in
[Privilege and authorization](privilege.md); this section defines the online format. The names are
optional in the handshake; a node that does not offer them is treated as not supporting `forward`.

| Name | Direction | Form | Body | Success response body |
|---|---|---|---|---|
| `trust.summary` | C→S | event | `TrustReport` | |
| `local.request` | S→C | command | `LocalRequest` | `LocalState` |
| `local.withdraw` | S→C | command | `[task_id: text, attempt: uint]` | `[]` |
| `local.decision` | C→S | event | `[task_id: text, attempt: uint, state: LocalState]` | |

```text
TrustReport  = ["ok", TrustSummary] | ["unavailable", [message: text]] | ["not_forward", []]
LocalRequest = [task_id: text, attempt: uint, spec: TaskSpec, note: text, input_preview: bytes]
LocalState   = ["pending", []] | ["approved", []] | ["denied", [message: text]]
```

- **`trust.summary`**: crha sends the report once after the response to `hello`, and then whenever it
  changes: when the digest changes or when the privileged mode connects or disconnects. crhs does
  not query it. When `privileged_mode` is not `forward`, the report is `not_forward`.
- **Local approval** is used only for a single task; tasks of a task group do not produce a
  `local.request`. It does not occupy `task.start`:
  1. crhs sends `local.request`. `input_preview` is the first 4 KiB of the task's stdin or file
     content, or empty when there is no input. The privileged mode adds `(task_id, attempt, spec,
     input_preview)` to its pending list and answers with the current state. A repeated request for
     the same `(task_id, attempt)` is idempotent and returns the existing state.
  2. After someone runs `crha approve` or `crha deny`, crha sends `local.decision`.
  3. When the state is `approved`, crhs sends `task.start` with the same `attempt` and an empty
     `authorizations`. The privileged mode checks that the `spec_sha256` still matches the spec it
     approved and then consumes the approval.

- When the owner signs in the WebUI instead, or the task is cancelled, crhs sends `local.withdraw`.
- Pending and approved records exist only in the privileged mode's memory and are lost when it
  restarts. On every `trust.summary` with `ok`, crhs re-sends `local.request` for the tasks of that
  node that are still waiting for a local approval. If the record was lost, `task.start` answers
  `authorization_required` and the ordinary retry applies.
- A disconnect is safe at any point: without a `task.start` the task does not execute, and a
  disconnect while waiting does not make the task `unknown`.
- Error codes: `privileged_unavailable`, `local_not_trusted` (the node has no `local` trust entry;
  terminal) and `invalid_spec`.

### Trust summary

```text
TrustSummary = [node_id: text, aliases: [text], clock_skew_ms: uint,
                identities: [unprivileged: Identity, privileged: Identity],
                trust: [TrustEntry]]
Identity     = [uid: uint, gid: uint, user: text]
TrustEntry   = [name: text, source: "local", role: "crhs" | "user" | "local", key: TrustKey,
                kinds: [text], require_exact: bool, require_task: bool, require_uv: bool, max_ttl_ms: uint?,
                allow: [GuardRule], deny: [GuardRule], env_allow: [text]]
TrustKey     = ["sshsig",   [public_key: text, fingerprint: text]]   ; authorized_keys form; SHA256:… fingerprint
             | ["webauthn", [credential_id: bytes, cose_key: bytes, rp_id: text, origins: [text]]]
             | ["local",    [uids: [uint]]]
GuardRule    = [method: "exec" | "file.read" | "file.write", match: "any" | "prefix" | "regex", pattern: text]
```

- `digest = SHA-256(CBOR(TrustSummary))`. crhs uses it to decide whether its cache changed and
  records it in the task's authorization record.
- `aliases` is the node's configured trust aliases, as UUIDs. An authorization whose payload
  `nodes` contains the node's `node_id` or any of these UUIDs is addressed to this node; see [Trust
  aliases](privilege.md#trust-aliases).
- `kinds` takes the values `execute`, `cosign` and `require-cosign`; see [Privilege and
  authorization](privilege.md). `cose_key` is the credential's raw COSE public key.
  `source` is reserved for additional trust sources: in the current version it is always `local`.
- When `match` is `"any"`, `pattern` is the empty string.
- The run identities of both modes are carried here, not in `Hello` or `Facts`.

### Authorization object

```text
Authorization        = [payload: bytes, signatures: [Signature]]       ; payload is the original CBOR(AuthorizationPayload)
AuthorizationPayload = [v: 1, nodes: [text], command: AuthCommand?,
                        issued_at_ms: int, deadline_ms: int?,
                        task_ids: [text]?, attempt: uint?, note: text]
AuthCommand          = [method: "exec" | "file.read" | "file.write", match: AuthMatch]
AuthMatch            = ["exact", [target: text, spec_sha256: bytes]]    ; spec_sha256 is exactly 32 bytes
                     | ["prefix", [target: text]]
Signature            = ["sshsig", [blob: bytes]]
                     | ["webauthn", [credential_id: bytes, authenticator_data: bytes,
                                     client_data_json: bytes, signature: bytes]]
```

- **The authorization id** is `SHA-256(payload)`, over the original bytes. A verifier decodes the
  payload, re-encodes it and compares the result with the original bytes.
- `nodes` lists node UUIDs, node-group UUIDs, or exactly `["*"]` (every node that trusts the signer).
  It cannot be empty. There is no `group:` syntax: names are used only for input and display and are
  resolved to UUIDs before signing.
- `command` is `null` when any method and any target are allowed.
- `task_ids` and `attempt` are both `null` (a reusable authorization) or both set (a one-shot
  authorization, with a non-empty `task_ids` without duplicates and `attempt ≥ 1`). A one-shot
  authorization's `nodes` may contain only node UUIDs, not node-group UUIDs and not `*`, and its
  length matches `task_ids`, position by position: `task_ids[i]` runs only on `nodes[i]`. The
  `task_id` of a `task.start` must be in the list, the node UUID at the same position must equal
  the node's own id, and `attempt` must match; otherwise the code is `authorization_invalid`.
- `note` is the empty string when there is no note.
- `deadline_ms` must not be `null`: the field is nullable in the encoding, but validation rejects a
  missing deadline as `authorization_expired`.
- **`spec_sha256`** is `SHA-256(CBOR(TaskSpec))`, where `TaskSpec` is the structure of `task.start`
  (stdin and file contents are already `InputRef` values).
- **SSHSIG**: `blob` is the binary form of an OpenSSH SSHSIG (the bytes after decoding the
  `-----BEGIN SSH SIGNATURE-----` armor from base64). Version must be 1, the namespace must be
  `crh-auth-v1`, the reserved field must be empty, and the hash is `sha512` (the `ssh-keygen`
  default; `sha256` is also accepted). **The signed message is the original payload bytes**, hashed
  by SSHSIG itself, not a pre-hash.
- **WebAuthn**: the challenge is `SHA-256("crh-auth-v1\0" ‖ payload)` (32 bytes). The browser sees
  its base64url form, and the `challenge` in `client_data_json`, after decoding, must equal it byte
  for byte. The accepted COSE algorithms are ES256 (`-7`), EdDSA / Ed25519 (`-8`) and RS256
  (`-257`).
- One encoded `Authorization` is at most half of `MAX_FRAME_BYTES`, leaving room for the rest of
  `TaskStart`; 512 task ids take about 14 KiB.

### crh-priv

The unprivileged and privileged modes of crha speak `crh-priv`, over a unix socket in `forward` mode
and over the helper's stdin and stdout in `native` mode. The `local` role uses the same socket for
`crha pending`, `crha approve` and `crha deny`. It uses the same frames, command/event abstraction
and strict decoding rules, but it is not the same protocol as the CRH protocol:

- There is no Noise. Threats inside the host are out of scope (see [Threat model and
  scope](privilege.md#threat-model-and-scope)); the peer's identity comes from `SO_PEERCRED` on the
  socket, or from the process relationship on stdio.
- It is a stream. Each frame is preceded by a 4-byte big-endian length. A length of 0, or a length
  above `MAX_FRAME_BYTES`, is a protocol error.
- The handshake is the first pair of frames and does not go through Noise:

```text
PrivHello   = [priv_major: 3, priv_minor: 0, commands: [text], crha_version: text,
               role: "forward" | "native" | "local"]
PrivWelcome = [priv_major: 3, priv_minor: 0, commands: [text], crha_version: text]
```

- Required names: for `native` the `task.*` group; for `forward` `task.*`, `trust.query` and
  `trust.summary`; for `local` every name of the role. The rest (`local.*` in `forward`) are
  optional, and a name that is missing removes the corresponding function. Names added later are
  optional and negotiated by intersection.
- `priv_major` must be equal; either side closes the connection when it sees a different one. This
  is required because crha and its privileged mode always upgrade together, so a privileged process
  of another major is never used by a newer unprivileged mode.
- `priv_minor` is additive. A different minor never refuses the handshake.
- In `forward` mode the unprivileged mode additionally requires `PrivWelcome.crha_version` to equal
  its own. A difference is treated as an unreachable privileged mode: privileged tasks fail with
  `privileged_unavailable` and a log line names both versions. This covers replacing only the
  `crha` binary without restarting the privileged mode. In `native` mode the helper requires the
  same equality and refuses the handshake otherwise.
- `role` must match the peer's identity. `forward` requires the peer uid to equal
  `unprivileged_uid`; `local` requires the peer uid to be in a `local` trust entry's `uids`;
  `native` exists only on stdio. On a mismatch the privileged side closes the connection.

| Name | Direction | Role | Description |
|---|---|---|---|
| `task.start` / `task.input` / `task.cancel` / `task.query` | U→P | forward, native | Same structures as between crhs and crha; `native` skips the authorization check |
| `task.output` / `task.exit` | P→U | forward, native | Same structures; there are no acks. The unprivileged mode writes its own output file, reusing its spill and resume logic |
| `trust.query` | U→P | forward | Request `[]`, response `TrustSummary` |
| `trust.summary` | P→U | forward | Event `TrustReport` (always `ok` from the privileged mode), pushed when the digest changes after a reload; the unprivileged mode forwards it to crhs unchanged |
| `local.request` / `local.withdraw` | U→P | forward | As described above |
| `local.decision` | P→U | forward | As described above |
| `pending.list` | L→P | local | Request `[]`, response `[[task_id: text, attempt: uint, spec: TaskSpec, note: text, received_at_ms: int, input_preview: bytes]]` |
| `local.approve` / `local.deny` | L→P | local | Request `[task_id: text, attempt: uint, spec_sha256: bytes, message: text]` (`spec_sha256` is exactly 32 bytes and must equal the spec hash of the pending record, otherwise `invalid_spec`), response `[]` |

`local.approve` and `local.deny` answer `unknown_task` when no request is pending for the pair,
`already_decided` when a different verdict was already recorded for it, `invalid_spec` when
`spec_sha256` differs, and `local_not_trusted` when the peer uid is not a local approver.

- **Disconnect**: when a `forward` connection breaks, tasks the privileged mode has already accepted
  run to completion and their results go to the local log; their output is no longer relayed. The
  unprivileged mode ends them with an `error` outcome and `code = helper_lost` ("the task may still
  be running"). A `task.start` that was sent but whose response was lost to the disconnect is
  treated as accepted in the same way, so crhs does not retry a task that may have run. When the
  unprivileged mode itself restarts, it does not know these tasks and crhs treats them as `unknown`.
  When the stdin of a `native` helper closes, the helper waits for the current task to end and then
  exits.
- **The native helper** runs exactly one task per process: handshake, one `task.start`, input,
  output, `task.exit`, then exit. It refuses to start when its stdin is a terminal. If it exits or
  disconnects after accepting the task but before `task.exit`, the unprivileged mode ends the task
  with an `error` outcome and `code = helper_lost`: the task may have partially run, and it is not
  retried.

## Restricted connections

`node_state = "pending"` in the handshake response tells crha that its connection is restricted.
There is no command that queries the registration state; crhs pushes every change.

- On a restricted connection crha may send `hello` (with an empty task list), `ping` and `facts`.
  crhs answers `hello` with an empty `welcome`, answers any other command with `node_pending`, and
  pushes only `node.status`, never tasks or a trust report.
- **Approval**: crhs pushes `node.status{active}` and closes the connection. crha reconnects at once,
  without backoff, and the new handshake yields a full connection. Permissions are never switched in
  place on the existing connection; the reconnect takes the same path as any other connection.
- **Rejection**: crhs deletes the public key, pushes `node.status{rejected}` and closes. crha stops
  reconnecting, and `crha run` exits with a non-zero status and prints the reason.
- **Disable**: crhs pushes `node.status{disabled}` and closes. crha backs off and retries, and the
  next handshake is refused because the node is disabled.

## Transport security

The CRH protocol is carried over two layers: an outer WSS connection and an inner Noise channel. The
channel has five layers:

```text
message layer   CBOR with deterministic encoding; authorization payloads also use CBOR
session layer   version negotiation, hello, heartbeat, reconnect
abstraction     commands and events in both directions
security layer  Noise_IK end-to-end encrypted channel
transport       any reliable ordered message stream (v1: WebSocket over TLS)
```

### Threat model

| Attacker | Design goal |
|---|---|
| Network man-in-the-middle: eavesdropping, tampering, replay | No attack succeeds |
| A third party that terminates TLS: a reverse proxy, a CDN, Cloudflare Tunnel and the like | Sees only ciphertext and cannot inject messages |
| A stolen enrollment token | Single use, short-lived, and registration still requires confirmation |
| A compromised node | Sees only the tasks sent to it and can operate only on them; cannot impersonate another node |
| A compromised crhs | Can send ordinary commands to nodes; privilege elevation is constrained by the trust configuration of the privileged mode, see [Privilege and authorization](privilege.md) |

TLS alone is insufficient. Whoever terminates TLS would see all plaintext and could inject a
`task.start`, which is equivalent to ordinary-user remote code execution on every node. An
end-to-end layer inside TLS prevents this.

### WSS and Noise

- **Outer: WSS (TLS 1.3).** It carries the connection across the network and hides metadata. The
  certificate verification mode `tls_verify` is `system` (the default) or `none`. With a
  self-signed certificate, `none` does not reduce security, because the inner channel authenticates
  both sides.
- **Inner: a Noise channel**, `Noise_IK_25519_ChaChaPoly_BLAKE2s`. The prologue is the protocol's
  major-version prefix followed by the server's challenge (see [Handshake and replay
  protection](#handshake-and-replay-protection)). IK means the client already knows the server's
  static public key, which it pinned at enrollment. One round trip authenticates both sides and
  gives forward secrecy.
- One WebSocket binary message carries one Noise transport message. A Noise message is at most
  64 KiB, so a frame stays within 60 KiB and output travels in frames of at most that size.
- A connection lives at most 24 hours. crha then reconnects and performs a new handshake; rekeying
  in place is not implemented, because a reconnect is cheap.

### Handshake and replay protection

0. After the WebSocket is established, crhs immediately sends the first frame: a 32-byte random
   **challenge**. It arrives together with the HTTP 101 response and adds no round trip. crhs closes
   a connection that does not deliver the first handshake message within 20 seconds.
1. crha → crhs: the first Noise IK message, carrying the client's static public key and a fixed CBOR
   payload (`HandshakeInit`). crhs looks the node up by that key:
   - An approved node gets a normal connection.
   - A pending node gets a **restricted connection**, which accepts no tasks; see [Restricted
     connections](#restricted-connections).
   - An unknown key with an `enroll` payload (token secret, hostname, facts) and a valid token
     consumes the token, creates a pending node bound to the key, and gets a restricted connection.
     This is the only case in which an unknown public key completes the handshake.
   - Every other case closes the connection.
2. crhs → crha: the second Noise IK message, carrying `HandshakeResponse`. crha compares
   `server_time_ms` with its own clock and reports the offset in `facts`. A large offset produces a
   warning in the log on both sides and in the WebUI; see [Clock](privilege.md#clock). After this
   the connection enters `hello` and the reconnect procedure.

**Replay protection.** The first IK message can be replayed. A replayer does not have the client's
ephemeral private key and cannot decrypt the following traffic, but it can make crhs believe that a
node reconnected, for example by displacing the real connection. The challenge is therefore part of
the Noise prologue: the prologue enters the handshake hash and is used as associated data for the
payload encryption, so the first message is valid only on the connection that carried its challenge.
A replay on another connection fails to decrypt the payload.

- A WireGuard-style timestamp was rejected. It would have crhs remember each node's last handshake
  timestamp and refuse an older one. It compares only the client's own times and is immune to clock
  differences between the two hosts, but it depends on the client clock never going backwards: NTP
  correcting backwards, a dead RTC battery and a virtual-machine snapshot rollback each keep the
  node from connecting until it catches up with the old time, and a clock that jumps into the future
  and is later corrected locks the node to that future time. A persistent counter has the same
  problem after a disk rollback or when an identity key is copied to another machine. Both would
  also make crhs keep per-node state.
- The price of the challenge is that one server frame must arrive before the handshake. The client
  always initiates a connection, so this frame arrives with the 101 response and adds no latency. A
  server-initiated transport, which is reserved, sends the challenge from the crha side with the
  same symmetric rules; see [Extension points](architecture.md#extension-points).
- The client time in the handshake is diagnostic and does not take part in authentication.

### Keys

| Holder | Key | Algorithm | Use | Consequence of compromise |
|---|---|---|---|---|
| crhs | Server identity key | X25519 | Noise channel | Impersonate crhs and send ordinary commands to nodes (no privilege elevation) |
| crhs | Authorization signing key | ssh-ed25519 | Sign authorizations and cosignatures, see [Privilege and authorization](privilege.md) | Elevate on nodes that trust crhs, within the limits of their trust entries |
| crhs | Master key | 32-byte symmetric key | Encrypt the `secrets` table | Leak SSH private keys, model API keys and other secrets |
| crha | Node identity key | X25519 | Noise channel | Impersonate this node |

- The node identity key is stored at `identity.key` under the configured `state_dir`, with mode 0600
  and owned by the crha user; with `state_dir = "/var/lib/crha"` the path is
  `/var/lib/crha/identity.key`. The server public key that crha pins at enrollment is `server.pub`
  in the same directory.
- crhs reads the master key from the file named by `master_key_file` in `crhs.toml`; it is never
  written to the database.
- crhs keeps its server identity private key and its authorization signing private key, encrypted
  with the master key, in the `secrets` table.

### Key export

A database backup contains only encrypted private keys. Without the master key it cannot be
restored, so crhs provides key export and import:

- `crhs keys init` generates the master key file (mode 0600) and records a non-secret identifier of
  the key (an HMAC derivation) in the database. At startup crhs refuses a key file that does not
  match the database, and also refuses a key file that is readable by the group or by other users.
- `crhs keys export --out crhs-keys.age` exports the master key, the server identity private key and
  the authorization signing private key.
- The file is in [age](https://age-encryption.org/) format with ASCII armor, encrypted with a
  passphrase and scrypt. The passphrase is read at export time from the terminal (twice) or as one
  line from stdin. The standard `age` tool can decrypt it for verification, without crhs.
- `crhs keys import crhs-keys.age` imports the keys on a new or rebuilt deployment, together with a
  database backup. It checks that the export belongs to the database and that every exported server
  key matches its row in `secrets`.
- Export is a local command-line operation only, never available through the WebUI or the API. It
  requires reading `crhs.toml` and the master key file, which means being able to log in to the host
  that runs crhs.
- A restore is a database backup plus the key export file. A node needs no export: if its identity
  key is lost, the node enrolls again.

### Node registration

crha has no built-in paths for its configuration, state, logs or socket; all of them come from the
`--config` file and its values. The one exception is the socket that `crha pending`, `crha approve`
and `crha deny` connect to for local approval: `/run/crha/privileged.sock`, overridable with
`CRHA_PRIVILEGED_SOCKET` or `--socket`. The paths the WebUI suggests, `/etc/crha/crha.toml` and
`/var/lib/crha`, are only a suggested layout.

1. An administrator creates an enrollment token in the WebUI. The node belongs to the organization,
   and the token has the form `crh1.<server identity public key fingerprint>.<random secret>`. It is
   valid for one hour and can be used once; it can carry a name hint for the node's generated name.
2. On the node, run `crha enroll --config /etc/crha/crha.toml --state-dir /var/lib/crha
   https://crh.example.com crh1.xxxx.yyyy`:
   - `--config` is required. When the file exists, it must already set `server` and `state_dir`.
     When the file does not exist, `--state-dir` makes `enroll` write a minimal configuration with
     only those two keys. Omitting `--state-dir` is an error, and passing it when the file already
     exists is an error too.
   - The paths in the example are the suggested layout, not built-in defaults.
   - crha fetches the server identity public key over HTTPS, **checks it against the fingerprint in
     the token** and pins it. The token alone bootstraps trust, as in kubeadm's
     `--discovery-token-ca-cert-hash`.
   - crha generates the node identity key, starts a Noise IK handshake and puts `enroll` (token
     secret, hostname and facts) in the payload of the first message. This is the only case in which
     an unknown public key completes the handshake. The token secret travels inside the Noise
     channel, so a TLS terminator never sees it, and a replay of the first message finds the token
     already consumed.
3. crhs validates the token and the node enters `pending`. **Registration must be confirmed.** An
   administrator compares the hostname and the node's public key fingerprint (`crha status --config
   <crha.toml>` prints the fingerprint) in the WebUI and approves the node; only then can it receive
   tasks. Until then, reconnecting with the same key yields a restricted connection. A rejection
   deletes the key.
4. The handshake response already carries `node_state = "pending"`, so no separate registration
   query exists and all state changes are pushed by crhs. The allowed messages and the transitions
   are described under [Restricted connections](#restricted-connections).

### Rotation and revocation

- **Revoke a node.** Deleting the node removes its public key; the next handshake fails, and an
  established connection is closed after `node.status{rejected}`.
- **Rotate a node key.** Keys are not rotated online; `crha rotate-key` is present but does not
  change the key. Replacing a node key means removing `state_dir/identity.key`, enrolling the node
  again with a new token, approving the new node and deleting the old node record.
- **Rotate the server identity key.** crhs keeps one server identity key. A node pins the key it saw
  at enrollment and a different key fails the handshake, so there is no online rotation:
  replacing the key requires every node to enroll again.

## JSON storage forms

The database and the Web API use JSON. The JSON forms of `TaskSpec`, `Facts` and
`TaskResult` are provided by `packages/protocol` (`taskSpecToJson` / `taskSpecFromJson`,
`factsToJson` / `factsFromJson`, `taskResultToJson` / `taskResultFromJson`).

```jsonc
// TaskSpec: kind is the wire tag, the other fields are camelCase, and all of them are present
{ "kind": "exec", "command": { "argv": ["ls", "-l"] }, "env": {}, "cwd": "", "stdin": null }
{ "kind": "exec", "command": { "shell": "ls | wc -l" }, "env": {}, "cwd": "", "stdin": { "size": 3, "sha256": "<64 hex characters>" } }
{ "kind": "file.read", "path": "/etc/hosts", "startLine": 1, "lineCount": 100 }
{ "kind": "file.write", "path": "/tmp/x", "content": { "size": 3, "sha256": "<hex>" }, "overwrite": false, "mode": 0, "owner": "", "group": "", "createParentDirs": false }
{ "kind": "file.edit", "path": "/tmp/x", "edits": [{ "oldText": "a", "newText": "b" }] }
{ "kind": "file.stat", "path": "/tmp/x" }
{ "kind": "file.list", "path": "/tmp", "limit": 0 }

// Facts: camelCase keys, absent optional keys omitted (the example lists every key), numbers as numbers
{ "hostname": "...", "osId": "...", "osVersionId": "...", "osPrettyName": "...", "kernel": "...", "arch": "...",
  "initSystem": "...", "packageManagers": [], "privilegeTools": [], "notesPath": "...", "clockOffsetMs": 0,
  "shells": { "sh": "/bin/sh", "bash": "/bin/bash" } }

// TaskResult: the same camelCase, nullable fields are null rather than omitted; kind is the wire tag
{ "kind": "file.read", "from": 1, "to": 3, "eof": true, "total": 3, "tooLong": false }
{ "kind": "file.stat", "path": "/etc/hosts", "type": "file", "size": 220, "mode": "0644", "uid": 0, "gid": 0,
  "owner": "root", "group": "root", "mtime": "2026-01-01T00:00:00Z", "linkTarget": null }
{ "kind": "file.list", "entries": [{ "name": "a.txt", "type": "file", "size": 3, "mode": "0644",
  "mtime": "2026-01-01T00:00:00Z" }], "truncated": false }
{ "kind": "file.write", "bytes": 3, "created": true }
{ "kind": "file.edit", "replacements": 1 }
```

`taskResultToJson` writes the result that crhs stores unchanged in `tasks.result`; the Web API
returns it as the task's `result`. A `TaskSpec` is stored in `tasks.spec` and in `task_groups.spec`;
`Facts` is stored in `nodes.facts`.

## Interop fixtures

The TypeScript and Go implementations are hand-written from this document and kept compatible by
the shared fixtures in `test/interop/`. Both sides consume them, and a generated fixture is never
edited by hand: it is written by its generator, committed, and changed by changing the generator.

- `cbor_core_golden_vectors.json` is the profile's vector set: positive examples and rejection cases
  that both profile codecs must pass.
- `crh_frames.json` is generated by the TypeScript implementation. Each positive entry is
  `{ "id", "description", "hex" }` and covers every command, success and error response, event,
  handshake payload and union branch. A `negative` list holds length mismatches, unknown tags,
  unknown enum values, over-long command names, non-canonical encodings, a float posing as an
  integer, integers above 2^53−1, a wrong `sha256` length, trailing bytes and similar cases. The Go
  test decodes every positive, compares it with an expectation written independently from this
  document, re-encodes it and compares the hex, and requires every negative to be rejected.
- `m4_vectors.json` holds `spec_sha256` and authorization payload examples (positive and structurally
  invalid), authorization objects, the privilege bodies including the `TrustSummary` digest, the
  `crh-priv` handshake and length-prefixed frames, SSHSIG vectors (signed by `ssh-keygen` and built
  by hand, including `sk-*`; each records whether crha accepts it and what `ssh-keygen -Y verify`
  says) and WebAuthn assertions (positive and negative for ES256, EdDSA and RS256). Every generation
  uses fresh keys, so the tests check properties (re-encoding, hashes, the reference verifier,
  `ssh-keygen -Y verify`) and not bytes. OpenSSH 10.6's `ssh-keygen -Y verify` accepts an `sk-*`
  signature without the user-presence flag, while crha rejects it.
- `m4_authz_cases.json` holds the shared authorization decision cases. Signatures are abstracted to
  "which trust entry signed, whether it is valid, whether user verification happened"; each case
  gives the expected result code and the validation step that fails. A `targets` list maps task
  specs to the rendered method and target, and crhs's `operationOf` is checked against it. Both
  crha's validation and crhs's planning run these cases.
- `noise-crh.json` holds a Noise handshake for the protocol's prologue with a fixed challenge, in
  message and transport-key form; both the TypeScript and the Go implementation verify it.

The generators are under `packages/protocol/test/` (`generate-crh-frames.ts`,
`generate-m4-vectors.ts`, `generate-m4-authz-cases.ts`, `generate-noise-interop.ts`); generating
`m4_vectors.json` also needs `ssh-keygen`.
