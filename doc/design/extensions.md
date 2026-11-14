# Extensions

Agent sessions can use tools beyond the cluster tools through extensions. Every extension looks the same
to sessions: it has a name, tools, an availability and a state, and its tools are found, called, approved
and audited the same way. There are two kinds:

- **MCP extensions** connect to an MCP server an administrator added. There are no in-process plugins
  from outside: those would need a sandbox, a compatibility promise and their own audit path, and MCP
  already is the extension protocol.
- **Built-in extensions** ship with crhs and run inside it: `docs` (the documentation) and `api` (the
  crhs API) ([Built-in extensions](#built-in-extensions)).

The scope of the first version:

- **Administrators manage extensions.** A user cannot add one, so every extension is a deliberate
  decision by someone who controls crhs anyway.
- **MCP over Streamable HTTP only.** A stdio server would run an arbitrary process on the crhs host,
  outside the Cluster API.
- **Static credentials.** An MCP extension gets fixed request headers. Per-user OAuth is not supported.
- **Agent sessions only.** crhs as an MCP server ([MCP](../guide/mcp.md)) does not offer extension tools
  to its own MCP clients.

## Extensions

| Field | Kind | Meaning |
|---|---|---|
| Name | both | Lowercase letters, digits and `-`, not starting with a digit; unique across both kinds. Tools and rules use it. `docs` and `api` are reserved |
| Description | both | Shown to the model with the extension; an MCP extension defaults to the server's own `instructions` |
| Enabled | both | A disabled extension is invisible to sessions |
| List directly | both | Its tools appear in the model's tool list instead of only through search; on by default for built-in extensions |
| Availability | both | Every user, or only the granted users and user groups; built-in extensions default to every user, MCP extensions to granted only |
| URL | MCP | The Streamable HTTP endpoint |
| Headers | MCP | Sent on every request; encrypted with the master key and never returned by the API |
| Identity headers | MCP | Optional names of headers that receive the CRH username and session id |
| Trust annotations | MCP | Use the server's tool annotations for rules (on by default) |
| Timeout | MCP | Per call, 5 minutes by default |

- Built-in extensions exist from the start and cannot be deleted; an administrator can disable them,
  change "list directly" and their availability. "Every user" suits them because they expose only what
  the session owner can already do, under the same rules.
- Changing the URL of an MCP extension with stored headers requires entering the headers again or
  removing them, the same rule as for model provider keys, so a credential cannot be sent to a new
  endpoint unnoticed.
- An MCP server sees every CRH user as the one identity its headers carry. Identity headers let it tell
  them apart for its own logs; they are not authentication.
- A session reaches the extensions available to its owner. Session settings can turn single extensions
  off; a new session has all of them on, because search keeps unused ones out of the context. A subagent
  inherits its parent's set and can only turn more off.
- The **Extensions** page in the WebUI lists both kinds in one table with their kind, state, tools and
  availability.

### MCP connections

crhs connects to an MCP server when it is first needed and keeps one connection per server for all
sessions. It caches the tool list, refreshes it on `notifications/tools/list_changed`, on reconnect and
when an administrator asks. A built-in extension has no connection and is always ready.

- **Disconnects.** A dropped or failed connection is retried with exponential backoff (1 s doubling,
  with jitter, capped at 5 minutes); a successful connection resets it. An administrator's "reconnect"
  tries at once.
- **While unavailable.** The extension stays in the session's list marked unavailable rather than
  hidden, with the last error, so the model can tell the user. `search_tools` still searches the last
  known tool list and says it may be stale.
- **`call_tool` on an unavailable extension** makes one immediate connection attempt (10 s connect
  timeout) instead of waiting for the next scheduled one. On success the call proceeds and the backoff
  resets; on failure the call fails with `unavailable` and the error, and the backoff schedule goes on.
  Concurrent calls share one attempt, and after a failed attempt in the last 10 s a call fails at once
  without trying again, so a looping model cannot hammer the server.
- **Calls in flight.** A connection lost during a call ends that call `unknown`, as a restart does;
  it is not repeated on the new connection.
- The Extensions page shows each MCP extension's state, last error and next attempt.

## Tools for the model

The tool list stays the same for the whole session. Tool definitions sit at the start of the prompt, and
adding or removing one would invalidate the prompt cache for everything after it. Extension tools are
therefore reached through two fixed tools:

| Tool | Purpose |
|---|---|
| `search_tools` | Keyword search over the available extensions' tools (name, title, description). Returns the best matches with their full input schema and annotations. With `extension` and no query, lists that extension's tools by name and summary, paged |
| `call_tool` | Calls `tool` of `extension` with `arguments` |

The session's tool guide lists each available extension with its description, its tool count and
whether it is unavailable, so the model knows when a search is worth it.

An extension marked "list directly" also contributes its tools to the tool list as
`ext__<extension>__<tool>`. This is for small extensions used in most sessions. A tool whose combined
name does not fit the providers' name rules (64 characters of letters, digits, `_` and `-`) stays
reachable only through search. The direct set is computed from the current rows when a request is
built, so changing the flag, an extension's availability or enabled state, or its tool list changes the
tool list of new requests, which costs one cache miss.

Search is lexical BM25 (MiniSearch) over section headings, paths/anchors and text, and over each tool's
name, title, description and extension. Tokens split at anything but letters and numbers, identifiers also
emit their parts (`api_request` → `api_request`, `api`, `request`; `nodeIds` → `nodeids`, `node`, `ids`),
English words are stemmed and small stopwords dropped, and prefix and small-fuzzy matches count; any query
term may match. It uses no embeddings and makes no model call, so it is deterministic, and tool names and
descriptions are short and written to be found.

## Rules and approvals

Each extension turns a call into the operation rules match on. MCP extensions use two methods, mirroring
files:

| Method | Operation |
|---|---|
| `ext.read` | A tool whose annotations say `readOnlyHint: true`, on an extension whose annotations are trusted |
| `ext.write` | Every other tool |

The target is `<extension>/<tool>`, matched with the usual `exact` or `prefix`, so `prefix: "github/"`
covers a whole extension. A rule with `nodes` never matches an extension call, and extension calls are
never privileged. As with files, `allow ext.write` also allows `ext.read` on the same target.

- The Ask preset allows `ext.read` as it allows non-privileged file reads; Auto Review judges the rest;
  Yolo allows everything.
- Annotations are trusted because an administrator chose to connect the server. An MCP extension whose
  annotations are not trustworthy can be switched to "trust annotations: off", which makes all its
  tools `ext.write`.
- A built-in extension states its own operations: the `docs` tools are `ext.read`, and `api_request`
  becomes an `api.read` or `api.write` operation on the route ([API requests](#api-requests)). There is
  no second approval for the tool call itself.
- Auto Review sees the extension, the tool, its annotations and the arguments, never the conversation.

### External calls

Approvals belong to the object that waits ([Approvals](access-control.md#approvals)). A task is bound
to a node, its protocol spec and dispatch, so an extension call gets its own small object instead:
`external_calls` holds the session, actor, extension, tool, arguments, operation and the approval columns
tasks use, plus only the state that must survive while the call is in progress.

- Its id is derived from the tool call, like a task id, so a tool call that runs again after a restart
  finds the call instead of making it again.
- When it ends, the row keeps only its state and `finished_at` and clears its arguments: it is the
  "already ran" marker. The result is in the transcript and who decided is in the audit log. A replay
  after a restart returns "the call finished before a restart; its result could not be kept" instead of
  calling again.
- Terminal rows are kept for one day by a built-in retention policy, not a System setting, after which
  the sweep deletes them ([Retention](data-model.md#retention)). Rows still waiting or running are never
  deleted.
- A call is not assumed to be idempotent. A call that was in flight when crhs stopped ends `unknown` and
  is never repeated.
- Aborting the tool call or reaching an MCP extension's timeout sends an MCP cancellation.
- A waiting call goes up the chain like a task ([Approvals](access-control.md#approvals)): the nearest
  ancestor agent whose cumulative result is `allow` may approve, reject or escalate it. Auto Review, for
  an Auto Review root, and otherwise the owner answer when no agent may decide or the agent escalates.
- The decision panel and the approvals page show extension calls next to tasks, with the extension, tool,
  annotations and arguments (for `api_request`, the method, path, query and body). "Always allow" offers
  the exact target or a prefix: the whole extension, or for API requests the route.
- Calls and their decisions are audited (`external_call.started`, `external_call.finished`, with the
  arguments truncated). Extension changes are audited as configuration (`extension.*`), without header
  values.

## Results

An extension result is converted to the cluster tools' output form ([Tool output](agent-runtime.md#tool-output)):

- Text content is returned as text, truncated with the same limits, followed by a note block naming
  the extension and tool. MCP content is untrusted like node output
  ([Prompt injection](agent-runtime.md#prompt-injection)).
- Images go into the image cache and reach the model as `view_image` results do
  ([Image cache](library.md#image-cache)).
- Structured content without text is returned as compact JSON. Resource links are listed by URI.
  Embedded binary resources and audio are described by type and size, not sent.
- `isError` sets the result's error flag. Files are not saved to a library automatically; the model can
  write what it needs.

## Built-in extensions

| Extension | Tool | Purpose |
|---|---|---|
| `docs` | `search_docs` | Keyword search over the documentation and the API reference; returns the best sections with their path, heading and a snippet |
| `docs` | `read_doc` | One document or one section of it (`path`, optional `section` heading), paged for long documents |
| `api` | `api_request` | One crhs API request as the session owner |

They are split so that an administrator can turn off API requests and keep the documentation.

### Documentation

- The documentation is the `doc/` tree of the running version: the release bundle carries its Markdown
  files (images are left out), and an unbundled crhs reads the repository's. The tools can therefore never
  describe a different version than the one answering.
- The API reference is rendered from the API document at startup, one page per tag under `api/`. It lists
  each route the agent may call with its method, path, summary, parameters, body and response fields,
  and the shared object shapes once. Routes marked `deny` are left out, so the model is not shown what
  it cannot use. The reference is offered even when the `api` extension is off, since it also explains
  what the WebUI does.
- Search splits documents at headings and indexes each section (heading, path/anchor and text) with
  MiniSearch, like `search_tools` indexes each tool (name, title, description and extension).

### API requests

The API document is written for this tool: crhs offers no API to outside programs, and the API has no
versioning policy or compatibility guarantee ([Layering principles](architecture.md#layering-principles)).
The reference always matches the running version, so the model never relies on an older shape.

`api_request(method, path, query, body)` runs the request inside crhs through the app's own router, not
over the network, so the request passes the same route definition, validation, access checks and audit as
a WebUI request.

- **Identity.** The request is authenticated as the session owner and attributed to the session: audit
  events name the session as the actor, on behalf of the owner. Shared users of the session do not lend
  their identity, as with every other tool. The identity travels in the request's environment, which a
  network request cannot set.
- **Access.** The route's declared agent access decides first ([Route definitions](webui.md#route-definitions)):
  `deny`, an unknown route and a path outside `/api` are refused without rules. The others become an
  operation for the rule chain:

  | Agent access | Method | Target |
  |---|---|---|
  | `allow` | `api.read` | `<METHOD> <path template>`, such as `GET /api/nodes/{id}` |
  | `ask` | `api.write` | the same |

  So the Ask preset lets the agent read and asks before every change, Yolo allows both, and a rule such as
  `prefix: "POST /api/sessions"` allows a family of routes. `allow api.write` implies `api.read`, as for
  files and extensions.
- **Approval.** A request that needs an approval waits in an external call ([External calls](#external-calls))
  and is decided like any other.
- **Result.** The status and the JSON response, compact and truncated like other tool output. A binary or
  streamed response is described by type and size instead of returned; files are moved with `copy_file`.
- **Limits.** The body is at most 1 MiB. The event streams are `deny`, since a one-shot request cannot
  follow them.

## Extension points

- Extension tools for API token clients through crhs's MCP endpoint, with API token rules.
- Per-user credentials (OAuth) for MCP servers that act as the individual user.
- A meta tool budget: listing small extensions directly by default once tool counts are measured in
  practice.
