# Using CRH as an MCP server

ClusterRightHand can be used without its built-in agent. In that mode crhs is an MCP server: an
external coding agent such as Claude Code, Codex or another Streamable HTTP client receives the
cluster tools, and every call runs through the same Cluster core as an agent session — the same
nodes, rules, approvals, privilege checks, task records and audit log. This page covers the
connection, the tool surface, permissions and the limits. The component view is in
[Architecture](../design/architecture.md); the tool definitions are in [Cluster
tools](../design/agent-runtime.md#cluster-tools).

## Connecting a client

You need a running crhs, at least one active node you may operate, and an API token. No model
provider is needed: MCP tool calls do not call a model. The token supplies both the identity and the
permission rules.

### Create an API token

1. Sign in and open **API tokens** in the sidebar's **Admin** group.
2. Choose **New token**.
3. Fill the dialog:

   | Field | Notes |
   |---|---|
   | **Name** | Up to 100 characters; it identifies the token in the list and the audit log. |
   | **Rule preset** | **Ask** or **Yolo**. **Auto Review** is not offered: it needs the owner's instructions, and a token has none. Ask allows ordinary reads and sends everything else to you; Yolo runs everything without asking. |
   | **Expires after** | **30 days**, **90 days** (the default), **365 days** or **Never**. A token that never expires stays valid until you revoke it. |

4. Choose **New token** in the dialog to create it. The dialog then shows **Token created** and the
   secret once. Copy it now; it cannot be shown again. It also shows **Connect Claude Code with:**
   and the exact `claude mcp add` command for this crhs, which you can copy with **Copy command**.

A token belongs to the user who created it and acts on that user's behalf. Its node access is the
owner's node access: an administrator's token reaches every node, a member's token only the granted
ones. Tokens are stored hashed, can be revoked at any time, and their rule preset and added rules can
be edited later with **Rules** in the token list. The UI details are in [API
tokens](webui.md#api-tokens); the rules are in [API tokens](../design/access-control.md#api-tokens).

### The endpoint

| Property | Value |
|---|---|
| URL | `https://<your-crhs>/mcp` — the path is `/mcp`, with no subpath. |
| Transport | MCP Streamable HTTP. |
| Authentication | `Authorization: Bearer crh_…` on every request. |
| State | Stateless: each request is authenticated and handled on its own; no MCP session state is kept between requests. |
| Request body | JSON, up to 89,544,024 bytes (about 85 MiB). |

The request body limit is the base64 form of the largest task input (64 MiB) plus 64 KiB for the
rest of the JSON, because `write_file` content and `exec` stdin travel inside the request. A larger
body is answered with 413 and `request body too large`; make sure a reverse proxy allows the same
size. The limit is the same as the task-input routes (`server/src/api/body-limit.ts`).

A missing, malformed, expired or revoked token gets HTTP 401 with a JSON error and a
`WWW-Authenticate: Bearer realm="crh"` header. Only bearer tokens are supported; there is no OAuth
flow and no interactive consent at connection time. Treat the token as a password: use HTTPS, keep
it out of committed files, and revoke it when the client or laptop goes away.

### Claude Code

The token page prints the command with the real origin. It has this form:

```sh
claude mcp add --transport http crh https://crh.example.com/mcp \
  --header "Authorization: Bearer crh_…"
```

Claude Code then lists the ten tools below. The server name `crh` is only a local label; choose
another if you run more than one CRH deployment. The header is the whole authentication: the token
is not passed in a URL, a query parameter or an environment variable read by crhs.

### Codex

The Codex CLI adds a Streamable HTTP server with `--url` and can read the bearer token from an
environment variable, so the secret does not appear in the command or in Codex's configuration:

```sh
export CRH_MCP_TOKEN='crh_…'
codex mcp add crh --url https://crh.example.com/mcp --bearer-token-env-var CRH_MCP_TOKEN
```

`--bearer-token-env-var` names the variable Codex reads; crhs still receives the token in the
`Authorization: Bearer` header. The command records the server in Codex's configuration; the same
two values (the `/mcp` URL and the bearer header) apply if you write that entry by hand. The OAuth
options Codex offers do not apply, because crhs implements only bearer tokens.

### Other Streamable HTTP clients

Any client that can add a Streamable HTTP server with a custom header works with the same two
values: the URL ending in `/mcp`, and the bearer header. The configuration *shape* is client-specific;
a common JSON form is:

```json
{
  "mcpServers": {
    "crh": {
      "type": "http",
      "url": "https://crh.example.com/mcp",
      "headers": {
        "Authorization": "Bearer crh_…"
      }
    }
  }
}
```

For Codex and other clients, use their Streamable HTTP server entry and set the URL and the
`Authorization` header in whatever field names that client documents. Field names and the value of
`type` differ between clients; the URL path and the header do not. If the client stores secrets
separately (an environment variable or a secret store), prefer that over writing the token into a
repository file.

A client that only supports stdio cannot connect directly. CRH does not ship a stdio bridge; a
third-party stdio-to-HTTP bridge pointed at `/mcp` is outside CRH's support
([Limitations](#limitations)).

## Tools

The ten tools are the same definitions the built-in agent uses — one catalog in the server — so the
names, arguments and semantics do not drift between the two surfaces. Arguments and JSON fields are
snake_case.

### The tool list

| Tool | Arguments | What it returns |
|---|---|---|
| `list_nodes` | none | JSON with the nodes you can access and, per node, its name and id, node groups, status, transport, whether it is connected, hostname, OS, client version, last-seen time, privileged mode and `can_run_tasks`. |
| `node_info` | `targets` | JSON facts for one or more nodes: OS, kernel, architecture, init system, package managers, shells, node groups and the notes path, plus the node's notes. Exactly one node returns one object; several nodes, a node group or `_all` return `{ "nodes": [...] }`. An SSH node has no crha facts and no notes. |
| `exec` | `targets`, `cmd` or `argv`, `cwd`, `env`, `stdin`, `timeout`, `privileged`, `wait`, `parallel`, `fail_fast`, `with_output`, `max_lines`, `max_bytes` | Text: the merged output and a bracketed note. A task that is still running or waiting returns a `task_id` to follow with `task_wait`. `with_output: false` returns JSON with the state and, on a crha node, the full-output path instead. |
| `read_file` | `targets`, `path`, `offset`, `limit`, `max_bytes`, `privileged`, `parallel`, `fail_fast` | Text: one page of whole lines, followed by a note with the line range. Blocks until the task ends, approval and signature included; returns no task id. |
| `write_file` | `targets`, `path`, `content`, `overwrite`, `mode`, `create_parent_dirs`, `privileged`, `parallel`, `fail_fast` | JSON with the result. Creates a new file by default; blocks like `read_file`. |
| `edit_file` | `targets`, `path`, `edits` (each with `old_text` and `new_text`), `privileged`, `parallel`, `fail_fast` | JSON with the result. On one node all edits apply together or not at all; a node where an `old_text` is missing or not unique fails on its own. Blocks. |
| `list_dir` | `targets`, `path`, `limit`, `privileged`, `parallel`, `fail_fast` | JSON: the directory entries and whether the listing was truncated. Blocks. |
| `stat` | `targets`, `path`, `privileged`, `parallel`, `fail_fast` | JSON: type, size, mode, owner, group, modification time and link target. Blocks. |
| `task_wait` | `task_id` or `task_group_id`, `wait` | The same result as `exec`: the output so far and a note, or the final result. Only for `exec` tasks and groups started by this token. |
| `task_cancel` | `task_id` or `task_group_id` | JSON with `cancel_sent`. Only for `exec` tasks and groups started by this token. |

### Targets and batching

Every node-scoped tool takes `targets`: a list of node or node-group names or UUIDs, or `_all`
(every node the token's owner can operate). The result shape depends on the input, not on how many
nodes a group happens to contain:

- Exactly one entry that names a node: one task, and that task's result.
- A node-group entry, `_all`, or two or more entries: a task group, with one result per node.

`exec`, `read_file`, `write_file`, `edit_file`, `list_dir`, `stat` and `node_info` accept several
targets. The task tools also take `parallel` (how many nodes run at once, default 10) and
`fail_fast` (start no more nodes after one fails); a single task ignores both. A group is approved
once, and a target set that expands to more than 512 nodes is an error, not a truncation. The full
batch rules are in [Batch execution](../design/agent-runtime.md#batch-execution).

### exec in detail

`exec` takes exactly one of `cmd` (run with the node's POSIX `sh -c`) and `argv` (a program and its
arguments, without a shell). The other arguments are:

| Argument | Meaning |
|---|---|
| `cwd` | Absolute working directory; default `/`. |
| `env` | Environment variables for the task. A `forward` node keeps only variables its trust entry permits. |
| `stdin` | Text written to the process's standard input. |
| `timeout` | Seconds before the command is killed; the task's own timeout, not the tool's wait. |
| `privileged` | Request the node's privileged path. SSH nodes ignore it; `forward` nodes still need an authorization. |
| `wait` | Seconds this call waits for the result, 0–600. MCP's default is 30. After it, the call returns and `task_wait` continues. |
| `with_output` | Default true. `false` returns status JSON and no output, and forbids `max_lines` and `max_bytes`. |
| `max_lines` / `max_bytes` | Per-node output budget, at most 2000 lines and 51200 bytes. |

The result is the merged stdout and stderr, then a bracketed note that a client can parse:

```text
hello
[web-1, exit 0]
```

Other notes you will see are `[web-1, exit 3]`, `[web-1, timed out after 30 s]`,
`[web-1, killed by SIGKILL]`, `[web-1, still running, task_id <id>. Call task_wait with this
task_id.]` and `[web-1, waiting for approval: <url>, task_id <id>. Call task_wait with this
task_id.]`. When the output was truncated, a note gives the kept range and the full-output path on
the node; read that file with `read_file`. A non-zero exit is an error result (`isError: true`), but
the output and the note are still returned.

### File tools

The file tools block until the task is final, including approval and signature waits. They return no
task id, so they cannot be followed with `task_wait` or cancelled with `task_cancel`; closing the MCP
request cancels the task instead, which keeps a closed client from leaving a write behind after an
approval.

- `read_file` pages by lines: `offset` is 1-based (default 1), `limit` is at most 2000 lines
  (default 2000) and a page also stops at 50 KiB. The note gives the line range and, only on a page
  that reached the end, the total. Continue with `offset`.
- `write_file` creates a new file and fails if the path exists unless `overwrite` is true. `mode` is
  an octal string such as `"0644"`; `create_parent_dirs` creates missing parents like `mkdir -p`.
- `edit_file` requires each `old_text` to occur exactly once in each node's file. On one node, all
  edits apply together or none do. A node where a text is missing or ambiguous fails alone; the
  other nodes still finish.
- `list_dir` takes `limit` from 1 to 10000 and reports `truncated` when more entries exist.
- `stat` reports the attributes and the link target of a symbolic link.

### Result shape and errors

Tools that return raw content (`exec`, `read_file`, `task_wait`) return MCP text content blocks: an
output block when there is output, then the note block. All other tools return one compact JSON text
block. The agent's `details` field — the data behind the WebUI's tool cards — is not sent to MCP
clients.

An expected failure is `isError: true` with a stable code. A text tool writes `[error <code>:
<message>]` in its note block; a JSON tool returns `{"error": {"code": "...", "message": "..."}}`.
Codes include task errors such as `node_offline`, `not_found`, `permission_denied` and
`approval_rejected`, and tool errors such as `invalid_argument`, `no_such_node` and `no_such_task`.
An unexpected server failure is not turned into a tool result; it remains a server error.

Every call writes an audit event `tool.call` with the tool name and `{ "via": "mcp" }`. The task it
creates records the API token as the actor and the owner as `on_behalf_of`, so it appears in the
owner's **Tasks** list with the **API token** actor type and in the audit log.

## Permissions and approvals

An API token is the root of its own rule chain, and the task it starts acts as the token's owner.
Three things follow:

1. **Node access is the owner's.** `list_nodes` and every task tool see only the nodes the owner may
   operate: an administrator's token sees every node, a member's token only granted ones.
2. **Rules are the token's.** The preset is **Ask** or **Yolo**, and the token's added rules sit on
   top. Ask allows ordinary reads (`file.read`, including `stat` and directory listings) and sends
   everything else — including every privileged task — to the owner. Yolo allows everything. There
   is no Auto Review for a token root, because the review model needs the owner's instructions and a
   token has none; an operation that would be reviewed in a session goes straight to the user. The
   rule fields and the evaluation are in [Authorization rules](../design/access-control.md#authorization-rules).
3. **Approvals go to the owner in the WebUI.** There is no MCP tool to approve or reject. A waiting
   task is listed on the owner's **Approvals** page and on its task or task-group page; the token
   waits for a person.

What the client sees while waiting depends on the tool:

- **`exec`** waits up to its `wait` (30 seconds by default, at most 600). If the task is still
  running, or is waiting for approval or a signature, the call returns the output so far and a note
  with the state, a link to the approval or task page, and the `task_id`/`task_group_id`. The client
  calls `task_wait` to continue; a rejection comes back as an error such as `approval_rejected:
  <reason>`.
- **File tools** keep waiting until the task is final, approval and signature included. If the
  client's own timeout closes the request first, the task is cancelled. Hence a file operation
  either returns its result or does not run; it does not continue invisibly after the client went
  away.
- **A task group** is approved once, as a group; one decision covers every node.

The approval URL is `/approvals/tasks/<id>` or `/approvals/task-groups/<id>`, made absolute from
`public_url` when it is set and from the request's origin otherwise. The owner decides there
with the usual card: **Approve**, **Approve and always allow…** or **Reject** ([Approvals
page](../design/webui.md#approvals-page)). An "always allow" decision appends the rule to this
token's rule set, because the token is the root of this chain; a one-off approval writes no rule. A
rule change re-evaluates the waits on the chain, and revoking the token or letting it expire ends
them. The routing and the no-deadline rule are in [Approvals](../design/access-control.md#approvals);
signature waits expire after 24 hours ([Waiting for
signatures](../design/privilege.md#waiting-for-signatures)).

### Privileged tasks over MCP

`privileged: true` on `exec` or a file tool asks for the privileged path. On an SSH node the flag is
ignored and the task runs as the SSH user. On a `native` or `ignore` node only the token's rules
decide. On a `forward` node the task also needs an authorization that the node's trust configuration
accepts, so the node may ask the owner to sign even after the rules allowed the task. That wait
appears in the **Waiting for your authorization** card on the task or task-group page and in the
**Waiting for your signature** section of the Approvals page. Signing happens on that page, with a
Passkey button or the `crha grant` text. An `exec` call returns the waiting state; after the owner
signs, `task_wait` returns the result. A file tool keeps waiting until the task is final. The full
path is in [Authorization path](../design/privilege.md#authorization-path).

## Differences from agent sessions

The tools are shared; the surrounding surfaces are not. The main differences are:

| Aspect | Built-in agent session | MCP |
|---|---|---|
| Actor | A `session` acting for its owner. | An `api_token` acting for its owner (`on_behalf_of`). |
| Rule chain root | The root session, with **Ask**, **Auto Review** or **Yolo**. | The token, with **Ask** or **Yolo** only; no review model. |
| Conversation | Model calls, transcript, thinking, compaction, subagents, title, quota. | None. The client is the agent; crhs only executes tools. |
| Approval wait | The tool waits (600 seconds by default) and the session shows the state. | `exec` waits within its `wait` (default 30 seconds), then returns the wait state and a URL; the client follows with `task_wait`. No UI push to the client. |
| Long-running `exec` | Returns a task id after `wait`; follow with `task_wait`. | The same. |
| File tools | Block; an aborted tool call cancels the task. | Block; a closed request cancels the task. |
| Tool output | Content blocks, plus `details` for the WebUI's tool cards. | Content blocks only; `details` is dropped. |
| Task ownership | The session and its subtree; another session of the same user cannot see its tasks. | The token's own tasks only; a token has no subtree. |
| Audit | `tool.call` with `{ via: "session" }`. | `tool.call` with `{ via: "mcp" }`. |
| Scheduling, subagents | Sessions can start subagents and be triggered by schedules. | No subagents, sessions or schedules; tools only. |
| Common core | Cluster rules, approvals, privilege, task records, output handling, audit. | The same core, so a task behaves identically once it is created. |

Two practical consequences: a task created over MCP still appears in **Tasks** and **Approvals**,
filterable by **API token**; and nothing in the MCP surface can approve, sign, stop a session,
change a rule or schedule a run. Those remain WebUI (or API) actions.

## Limitations

- **No stdio bridge.** crhs serves Streamable HTTP at `/mcp` and does not proxy or spawn a stdio MCP
  server. A stdio-only client needs a third-party bridge; that is outside CRH's support. This is
  listed in [Known limitations](../design/architecture.md#known-limitations).
- **No MCP resources or prompts.** Only tools are registered. The node list and task output are not
  exposed as resources; use `list_nodes`, `read_file` and the task output file.
- **No delegation tool.** There is no tool that asks a built-in agent session to do something, so an
  external agent cannot hand work to CRH's agent runtime.
- **No management tools.** Tokens, users, node access, schedules and model providers are managed in
  the WebUI or the HTTP API, not over MCP.
- **Bearer token only.** There is no OAuth, no per-user consent screen and no scoped token; a token
  is one rule root with the owner's node access. Treat it as a password and revoke it when it is no
  longer needed.
- **No server-initiated progress.** Because each request is handled on its own, an approval that is
  decided later does not push anything to the client; the client polls with `task_wait`. Approval and
  signature waits themselves follow the server's rules (no deadline for an approval, 24 hours for a
  signature).
- **Links behind a reverse proxy need `public_url`.** crhs builds absolute links from `public_url`
  when it is set and otherwise from `new URL(c.req.url).origin`; it does not read
  `X-Forwarded-Proto`. Set `public_url` to the console's public base URL behind a TLS-terminating
  proxy so the links in a tool note use `https://`. See
  [Reverse proxy and TLS](install.md#reverse-proxy-and-tls).
- **Request body and node caps.** A tool call body is limited to 89,544,024 bytes, and one task group
  is capped at 512 nodes. Larger inputs must be split; a larger target set is an error.
- **Output is truncated at crhs.** The tool result carries a head or tail within the per-node and
  per-group budgets. A crha node keeps the complete output in its output file, which the note names;
  an SSH node has no full output file.
- **`task_wait` and `task_cancel` are narrow.** They reach only `exec` tasks and groups started by
  this token. File-tool tasks have no task id, and another token's or a session's tasks are not
  visible.
- **A closed request has different effects.** Closing an `exec` request while it waits ends that
  wait; the task itself keeps running, and a client that received its `task_id` can follow it with
  `task_wait`. Closing a file-tool request cancels its task, so a timed-out write does not run after
  the client went away. Set the client's timeout above the `wait` you expect, and use `task_wait`
  for long work.
