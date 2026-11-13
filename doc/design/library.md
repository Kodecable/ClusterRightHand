# Libraries and file transfer

A library is a file store on crhs. Every user has one, and so does every user group. The file plane moves
whole files between libraries and nodes, always through crhs. Chat attachments and image input are built on
both.

The scope is deliberately narrow:

- **Whole files only.** A file is uploaded, downloaded or copied in one piece. There is no random access,
  append, partial read or resume; an interrupted transfer starts over.
- **crhs always relays.** A node never talks to a library backend or to another node. The protocol leaves
  room for presigned URLs (S3) and node-to-node transfer ([Extension points](#extension-points)).
- **The backend is trusted.** crhs owns the backend exclusively, and nothing else reads or writes it.
  Contents are not encrypted at rest and not checked for outside tampering.

## Libraries

| Library | Name in tools and the API | Who can use it |
|---|---|---|
| A user's own | `user:<username>` | The user and administrators |
| A user group's | `group:<group name>` | The group's members (read and write) and administrators |

- A library is created with its user or group. Existing users and groups get theirs in the migration
  that introduces libraries, with the defaults of that time.
- Users are never deleted, only disabled ([User types](access-control.md#user-types)). A disabled user's
  library stays as it is; administrators can still reach it.
- A user group can be deleted only while its library is empty; the empty library is deleted in the same
  transaction. Deleting the files with the group was rejected because a mistaken deletion would lose them
  with no way back, and handing them to someone needs a rule for who. Group libraries start with zero
  limits, so most are empty anyway.
- Administrators reach every library, personal ones included, without access checks; they control the
  backend anyway.
- The reference always names its owner. A bare `me` was rejected: in a shared session it would mean the
  owner while the person typing is someone else, a model can read it as itself, and a group could be
  named `me`.
- An agent session acts as its owner, so it reaches the owner's library and the libraries of the owner's
  groups. Users chatting in a shared session do not lend their own libraries. The administrator bypass
  is for the WebUI and API only: an administrator's agent sessions and API tokens reach the same
  libraries as a member's would.

### Paths

A file is addressed by a path within its library. Paths are flat keys: `/` separates segments for listing,
and there are no directory objects. A directory exists while some file is under it. A write is refused when
the path is a directory (some file lies under `path/`) or when any ancestor of the path is a file;
server-side auto-numbering treats both as taken.

- Valid UTF-8, at most 1024 bytes, no leading or trailing `/`, no empty, `.` or `..` segments, no control
  characters.
- Listing takes a prefix and returns the files and the next-level directory names under it, like `list_dir`.
- Moving and renaming change only metadata.

### Metadata and objects

The database is the source of truth.

- A `libraries` row holds the owner (kind and id, unique together), the three limits, and the usage: file
  count and total bytes. A separate table keeps these hot counters off the user and group rows, and gives
  files a real foreign key instead of a polymorphic owner reference. A library owned by neither, such as
  a shared one, would be one more owner kind.
- A `library_files` row holds the library id, path, size, SHA-256, media type, backend, object key,
  creator and times. `(library_id, path)` is unique.
- Usage changes in the same transaction as the file rows.

- **Object keys are random**, not derived from the path. An upload writes a new object, verifies its size
  and SHA-256, and then points the row at it in one transaction; the old object is deleted afterwards. A
  half-written upload is never visible, and an overwrite is atomic.
- **Orphans** are objects no row references, left by a crash between those steps. A sweep at startup and
  hourly deletes orphans older than one hour.
- The media type is sniffed from the content on upload, not taken from the client.

### Backends

One backend serves all libraries, configured in `crhs.toml`:

| Backend | Storage |
|---|---|
| `local` (default) | A directory under crhs's data directory |
| `webdav` | A WebDAV collection; credentials in `crhs.toml` |

A backend implements four streaming operations: put, get, delete and list (for the orphan sweep). Each row
records its backend, so a later migration can move objects without guessing.

Placement is each backend's own strategy: an object lives under one level of two hex characters taken from
its key (`<first two>/<full key>`). This spreads objects over at most 256 directories or collections,
keeping a directory's entries and a PROPFIND response small; empty shards are created on demand and kept,
never removed.

### Limits

Each library has three limits that administrators can change: the number of files, the size of one file,
and the total size. A new library copies them once from the defaults in System settings:

| Library | Files | One file | Total |
|---|---|---|---|
| A user's | 256 | 32 MiB | 256 MiB |
| A group's | 0 | 0 | 0 |

- A limit of 0 allows nothing, so a group library is unusable until an administrator raises its limits.
- A write (upload, overwrite, copy or move into the library) is allowed only if the library is within
  every limit after it. When a library is over a limit, for example after an administrator lowered it,
  nothing can be added or overwritten until files are deleted. Deletions are always allowed.
- A write whose size is not known in advance is counted while it streams and fails at the first byte
  past a limit; its object is never committed.
- Changing the defaults does not change existing libraries.
- The one-file limit is checked before an upload starts when its size is known. The file-count and
  total limits are checked when the upload commits, by one conditional update that adds the new usage
  only if the library stays within its limits. The commit takes the library row lock before reading the
  target it replaces, so its byte delta and old object key are read under that lock; deletes and moves
  take the lock too. When two uploads race, the one that commits second fails and its object is
  discarded.

## File plane

The file plane adds two task kinds. They are ordinary tasks: rules, approvals, privilege, authorizations,
audit and retention apply as they do to `file.read` and `file.write`.

| Kind | Direction | Rule method | Behavior |
|---|---|---|---|
| `file.push` | crhs → node | `file.write` | Writes the received bytes to a path, atomically, like `file.write` |
| `file.pull` | node → crhs | `file.read` | Sends a regular file's bytes to crhs |

- `file.push` carries the size and SHA-256 of the content in its spec, so an `exact` authorization or an
  approval binds the content, as with `file.write`. It also takes `overwrite`, `mode`, `owner` and `group`
  with `file.write`'s meaning.
- `file.pull` carries `max_bytes`, the most the destination accepts; the node refuses a larger file with
  `too_large` before sending anything. Its result reports the size and SHA-256 it sent, and crhs checks
  the received bytes against them. crhs also enforces `max_bytes` itself at the first byte past it, so a
  node that sends more than it declared cannot fill crhs's disk.
- The transfer endpoint's crhs-side location (a staging file, later a library object) is stored with the
  task, so a transfer waiting for approval survives a crhs restart. A task group's members each carry
  their own transfer id and the same source location, while node-to-nodes members all read the one
  staging file. A transfer already streaming when crhs stops fails, like any interrupted transfer.
- The transfer endpoint (which data connection crhs accepts) is routing, not something the node does, so
  the spec hash an approval or `exact` authorization binds leaves the transfer id out.
- The approval view shows the path, size, SHA-256 and the library source, not the content.
- Neither kind has a timeout; a stalled transfer fails through the data connection's idle timeout.
- Privileged transfers in `forward` mode pass through the privileged mode over `crh-priv`, as file content
  does today.

### Data connections

Bytes never travel on the control connection. A 4 GiB transfer would otherwise hold up heartbeats,
approvals and task output behind it.

1. crhs sends `task.start` for `file.push` or `file.pull`. Its spec names the transfer endpoint, today
   always `[crhs, transfer_id]`.
2. After accepting the task, crha opens a data connection to crhs for that transfer:
   [the same transport](protocol.md#data-connections), one transfer per connection.
3. The bytes stream in order. The receiver verifies size and SHA-256 at the end.
4. The task's result arrives on the control connection, as for every task.

A transfer that fails for any reason, including a dropped data connection, fails the task.

crhs schedules transfers; nodes keep no queue:

| | Running | Queued |
|---|---|---|
| Per crha node | 1 | 4 |
| Per crhs | 16 | 256 |

A transfer that finds the queue full fails with `busy` at once rather than waiting. crha refuses a second
concurrent transfer with `busy` as well, as a backstop; crhs retries that refusal for a few seconds,
because it frees a node's slot when the task ends while the node may still be finishing the previous
transfer. A staged copy counts as one transfer per leg. With one transfer per node, a large transfer
delays the next one on that node, including a small `view_image`.

### SSH nodes

SSH nodes use the same task kinds over SFTP on their existing connection, streaming directly; there is no
data connection. SFTP's write differences apply ([SFTP file operations](execution.md#sftp-file-operations)).

### Hashing

SHA-256 runs on the stream while it passes, never as a second read. With hardware SHA instructions
(SHA-NI on x86, the ARMv8 crypto extensions) it runs at 1 GB/s or more, and at 150 MB/s or more without
them, so the network is the bottleneck. The digest also matches `sha256sum`, so a user can check a file by
hand.

## Copies

A copy has one source file and one or more destinations:

| Source | Destinations |
|---|---|
| A library file | One library path, or one path on one or more nodes |
| A node file | One library path, or one path on one or more nodes |

- **Library to nodes**: one task group whose members push the library object to one node each, all
  streaming from the backend.
- **Node to library**: one `file.pull`, streaming into a new object.
- **Node to nodes**: one `file.pull` into a staging file in crhs's data directory, then one task group
  whose members push that staged file to the destination nodes. The staging file is deleted when the
  group ends; leftovers are removed at startup. A staged file may be at most the one-file limit of the
  acting user's own library, though it does not count toward that library's usage. `view_image` stages
  under the same limit.
- **Library to library**: a backend copy (get and put); no task.
- Several destination nodes are one task group, like `write_file` with several targets: the group is
  approved once and runs its members with bounded parallelism. Every member carries its own transfer
  id and location on its task row, while the source location and the size and SHA-256 in the spec are
  shared, so the group's approval and authorization cover every member. Only the transfer endpoint
  differs, and the spec hash leaves it out. The tool returns one result per node.
- An existing destination is refused unless `overwrite` is set, on nodes and in libraries alike.
- Missing parent directories on a node are created only with `create_parent_dirs: true`, like
  `write_file`; by default a missing parent fails the task. A library has no directory objects, so any
  library path works.

## Agent tools

The tools follow the existing naming and argument style ([Cluster tools](agent-runtime.md#cluster-tools)).
A location is either a node (`node`, or `targets` where several are allowed) or a library (`library`,
whose value is `user:<username>` or `group:<group name>`). The session's system prompt names the owner
the session acts for; the MCP facade adds that name to the library tools' descriptions too (an agent
session's tool descriptions are registered once per server, so its prompt carries the name).

| Tool | Behavior |
|---|---|
| `copy_file` | Copies one file. The source is `{ node, path }` or `{ library, path }`. The destination is a node `{ targets, path }` (taking `create_parent_dirs`, `mode`, `owner`, `group` and `privileged`), a library `{ library, path }`, or `{ user_interface: true }`, which copies nothing and offers the file to the people in the session ([Deliveries](#deliveries)). `overwrite` applies to node and library destinations and has no effect with `user_interface`. Blocks like the other file tools. |
| `view_image` | Gives the model one image from `{ node, path }` or `{ library, path }`. |
| `list_dir`, `stat` | Also accept `library` instead of `node`. |

- `read_file`, `write_file` and `edit_file` stay node-only, since a library has no partial reads. To read a
  library file, copy it to a node.
- The tools are shared with MCP. Over MCP, `library` reaches the libraries of the token's user.

### Deliveries

A file can be handed to the people in the session without copying it: `copy_file` takes
`{ user_interface: true }` as its destination. Nothing is copied, and no destination path or node option
applies; `overwrite` is accepted and has no effect.

- **Nothing is transferred.** The tool stats the source (a library stat, or a `file.stat` task on the node
  through the ordinary rules, approvals included) so the model learns whether the file exists and how
  large it is. A missing file is the ordinary error result.
- The result carries `details.delivery = { source, name, bytes }`, where `source` is
  `{ library, libraryId, path }` or `{ node, nodeId, path }`; the model-facing text says the file was
  offered to the user for download.
- After the turn ends, the WebUI shows each delivered file as its own box with the name, the source
  (library reference or node name) and the size; clicking it downloads the file. A library source is
  resolved by its id, so a renamed group keeps the link. It downloads the path as it is when clicked: no
  size, SHA-256 or version is pinned.
- Permission is decided at click time by the ordinary rules for the clicking user: a library source uses
  the library file endpoint and needs library access, and a node source uses
  `GET /api/nodes/:id/file?path=`, which runs a `file.pull` for that user (see [WebUI and API](#webui-and-api)).
  A user who cannot reach either gets the same 404 as a missing resource.

### view_image

- A node source runs a `file.pull` into a staging file, so it needs `file.read` on that node.
- It accepts PNG, JPEG, GIF and WebP within the model's image limits (by default 2000×2000 pixels and
  4.5 MB of base64), judged from the file header without decoding. A larger image or another format is
  refused with the limits, so the agent can shrink it on a node first. A model without image input gets
  an error.
- The stored result is one line of text for the model and, in `details`, `image: { sha256, mime, width,
  height, bytes, source }`, where `source` is `{ library, path }` or `{ node, path }`. The image bytes go
  into the [image cache](#image-cache), never into the transcript.
- Before each model request, a `beforeRequest` hook replaces the content of every `view_image` result that
  carries `details.image` with the image block. It matches on the tool name and the structured `details`,
  which only the tool produces, and never parses text. The replacement applies to that request only, and
  only while the disk entry was written at or before the result's timestamp. An entry restored by a later
  read therefore cannot turn an older placeholder back into an image: the prompt cache misses once, not
  twice, and the image is not sent twice.
- Provider rejection is derived from the conversation's transcript, which is the single source of truth:
  it follows forks, needs no cleanup, and belongs to one conversation because a rejection is specific to
  the provider/model that saw it. A `view_image` result counts as sent when an assistant message after it
  ended without an error. Otherwise the assistant messages after it with a provider 4xx status (a numeric
  status or error code, never provider wording) are counted; after two such failures the image is rejected
  in that conversation. A success in between means the image was sent, so it is not rejected; a 5xx or
  network error does not count. Once one result of a SHA-256 is rejected, a later `view_image` of the same
  SHA-256 in the same conversation is rejected too. The hook then replaces the results with a placeholder
  saying it was rejected and not sent, and `view_image` returns that text instead of an image. The answer
  is derived again from the transcript after a restart, so no separate state is kept or cleaned up.
- The WebUI's tool card shows the source, dimensions, size and SHA-256, with a link when the source is a
  library; it does not render the image.

### Image cache

The bytes for `view_image` results live in a bounded, disposable cache keyed by SHA-256 on crhs's local
disk:

| Where | Default size |
|---|---|
| `<data dir>/image-cache/<first two>/<sha256>`, indexed by an `image_cache` table (SHA-256, size, media type, last use, stored time) | 1 GiB |

- Entries are evicted least recently used, and dropped when unused for longer than the TTL (default 7
  days). The size and TTL are system settings. The cache counts toward no library's limits.
- The cache is local and independent of the library backend, whatever the backend is. It is not part of
  a library and is not backed up with one; it is outside the database, so it does not grow the database
  or its backups. Repeated reads rely on the operating system's page cache.
- `stored_at` is when the current entry entered the cache; writing the same SHA-256 again keeps it,
  because the bytes never left. A hit moves only `last_used_at`, so `beforeRequest` can tell whether the
  bytes stayed cached continuously since a result was produced. A library re-read on a miss writes the
  entry back with `stored_at` set to the restored result's timestamp, so that result is restored once and
  newer reads use the entry normally.
- **On a miss**, a library source is read again from its recorded path and used if its SHA-256 still
  matches; it is then cached again. A node source is never read again during a request: that would start
  a task, possibly wait for an approval, and stall on an offline node, all invisibly. The agent can call
  `view_image` again, visibly and under the rules.
- An image that cannot be restored becomes a text placeholder giving the reason (changed or deleted
  library file, expired cache entry, a cache entry newer than the result) and suggesting `view_image`
  again where it can help. The prompt cache misses once when this happens.
- A model without image input gets the same kind of placeholder for every image.
- Compaction does not go through `beforeRequest`, so the summarizer sees the one-line text, which is
  enough for a summary.

## Chat attachments

Every attachment goes to a library; a message never carries image bytes.

- Only the session's owner can attach files. Others with chat access do not see the button, and the
  server refuses their uploads, so attachments always land in a library the agent can reach.
- The composer's **+** menu offers **Upload files** and **Choose from library** (the shared file picker).
  Paste and drop upload too.
- Uploaded files go to the owner's library under `attachments/<YYYY-MM>/`. An upload with `rename=1` asks
  the server to keep an existing file: inside the commit it picks `name (1)`, `name (2)`, … before the
  first dot of the base name (a leading dot does not count), retrying on a concurrent insert, and returns
  the final path. The composer uses this option, so concurrent uploads of one name cannot race.
  Upload happens before sending, with progress, and can be cancelled; sending waits for it.
- The input is placed as a `crh.user_input` entry. Its model content is a list of separate text blocks:
  the typed text first, then one block per attachment. Each attachment block starts with "The user
  uploaded the file <name> (<size>), saved to <library> at <path>." The entry's `data` lists the
  attachments (library reference and id, path, name, size, media type, SHA-256, whether inlined) for the
  WebUI, which reads the typed text from the first block and the attachments from `data`. Nothing parses
  message text.
- **Short text is also inlined.** A file that is valid UTF-8 without NUL bytes and at most 32 KiB has its
  content appended to its block, after the note. At most 64 KiB is inlined per message; files past that
  get the note only, saying the content was not included and can be copied to a node and read there.
  Both limits are system settings. Since each file is its own block, its content cannot blend into the
  note or the typed text, and needs no escaping.
- An image gets the note only; the agent calls `view_image` to see it. Images and models without image
  input therefore take one path.
- The transcript shows attachments as chips from `data`, linking to the library file. A chip resolves the
  library by its id, so a renamed group keeps the link; an entry written before ids were recorded falls
  back to its reference. A chip is inactive with a reason when the file is gone or the viewer cannot reach
  the library. Deleting a session leaves its attachments in the library.

## WebUI and API

- A **Library** page (`/library/$library?path=…`) uses the shared file manager to list, upload, download,
  rename, delete and preview files, with the library's usage against its limits. Copies between libraries
  and nodes are not in the WebUI yet; agents do them with `copy_file`.
- Uploads and downloads stream as plain HTTP bodies outside the JSON body limit; there are no multipart
  forms and no range requests.
- File responses carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. Only PNG,
  JPEG, GIF and WebP, by the sniffed type, are served inline for preview, and only up to 20 MiB; everything
  else, SVG and HTML included, is served as an attachment. Library files are served from the WebUI's
  origin, so an inline SVG or HTML file would be stored cross-site scripting.
- A node file downloads through `GET /api/nodes/:id/file?path=` (without `preview=1`, which stays an image
  preview). As the signed-in user and unprivileged, the endpoint runs a `file.pull` with purpose `browse`
  into staging, capped at the user's own library one-file limit, and streams the result as an attachment
  with the same safe headers; the staging file is deleted afterwards. Rules, approvals and audit apply as
  for any task: if the pull needs approval, the request returns an error naming the approval page instead
  of waiting, and cancels the waiting task.

Uploads, overwrites, moves and deletions are audited with the library, path, size and SHA-256. Transfers
to and from nodes are audited as tasks.

## Extension points

- **Transfer endpoints.** A transfer endpoint is a union; only `crhs` exists today. Since an unknown union
  tag is a decode error, a new endpoint such as `url` (a presigned S3 URL) or `peer` (another node) comes
  with a new negotiated protocol name, and crhs offers it only to nodes that advertise it. Copy planning
  is in crhs alone, so nodes need no routing logic.
- **Backends.** S3 is another implementation of put, get, delete and list.
- **Server-side image processing** (EXIF orientation, resizing, format conversion, thumbnails) would let
  `view_image` accept larger images and the file manager show thumbnails. It is left out because the
  WebAssembly decoder complicates the crhs bundle.
