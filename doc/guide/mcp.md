# Using CRH as an MCP server

crhs is also an MCP server. An external coding agent such as Claude Code or Codex gets the same cluster
tools as CRH's built-in agent, and every call goes through the same node access, rules, approvals,
privilege checks and audit log. No model provider is needed for MCP.

## Connecting a client

### Create an API token

1. Open **API tokens** and choose **New token**.
2. Give it a name, a rule preset and an expiry:
   - **Ask** allows reads and asks you about everything else. **Yolo** allows everything. Auto Review is
     not available for tokens, because a token has no conversation for the review model to judge.
   - Choose an expiry unless you really need a token that never expires.
3. Copy the token; it is shown only once. The dialog also shows a ready-made `claude mcp add` command.

A token acts for you and reaches the nodes you can access. You can change its rules later or revoke it.
Treat it like a password.

### The endpoint

- URL: `https://<your-crhs>/mcp`
- Transport: Streamable HTTP
- Authentication: `Authorization: Bearer crh_…` on every request. OAuth is not supported.

Requests can be large (up to about 85 MiB, for `write_file` content and `exec` input); make sure your
reverse proxy allows it.

### Claude Code

```sh
claude mcp add --transport http crh https://crh.example.com/mcp \
  --header "Authorization: Bearer crh_…"
```

### Codex

```sh
export CRH_MCP_TOKEN='crh_…'
codex mcp add crh --url https://crh.example.com/mcp --bearer-token-env-var CRH_MCP_TOKEN
```

### Other Streamable HTTP clients

Use the `/mcp` URL and the bearer header in whatever form your client expects, for example:

```json
{
  "mcpServers": {
    "crh": {
      "type": "http",
      "url": "https://crh.example.com/mcp",
      "headers": { "Authorization": "Bearer crh_…" }
    }
  }
}
```

Clients that support only stdio need a third-party bridge.

## Tools

| Tool | Purpose |
|---|---|
| `list_nodes` | The nodes you can access, with their status and privilege mode |
| `node_info` | Facts and notes of one or more nodes |
| `exec` | Run a command |
| `read_file` | Read a page of lines from a file |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace text in a file |
| `list_dir` | List a directory on a node, or of a library |
| `stat` | File attributes on a node, or of a library |
| `copy_file` | Copy one file between nodes and libraries, or offer it to the user for download |
| `view_image` | Look at one image, from a node or a library |
| `task_wait` | Keep waiting for an `exec` task or task group |
| `task_cancel` | Cancel an `exec` task or task group |

Your client shows each tool's arguments and descriptions. The library tools reach the libraries of the
user whose API token you use: their own `user:<username>` library and the libraries of their groups.
The token never gets the administrator bypass, even when its user is an administrator.

### Targets and batching

Every node tool takes `targets`, a list of node or node group names, or `_all`. One node gives one
result. A node group, `_all` or several entries run as a task group with one result per node, approved
once; `parallel` and `fail_fast` control the batch. A batch is limited to 512 nodes.

### Libraries and images

`list_dir` and `stat` accept `library` (`user:<username>` or `group:<group name>`) instead of `targets`;
the path inside a library has no leading `/`. `copy_file` copies one file: the source is
`{ node, path }` or `{ library, path }`, and the destination is `targets` plus `path`, or a library plus
`path`. An existing destination is refused unless `overwrite` is true; a node destination also takes
`mode`, `owner`, `group` and `privileged`. A library destination is limited by that library's limits.
With `to_user: true` instead of a destination, nothing is copied: the tool stats the file and reports
that it was offered to the user for download, so you learn whether it exists.

`view_image` accepts PNG, JPEG, GIF and WebP within the model's image limits (by default 2000×2000
pixels and 4.5 MB as base64) and stores the image in crhs's image cache. Over MCP there is no model
request to attach it to, so the result is its one-line description; the image is still cached for a
later turn in the same session. A larger image or another format is refused with the limits, so convert
or shrink it on a node first.

### exec in detail

`exec` takes either `cmd` (run with `sh -c`) or `argv`. It waits up to `wait` seconds (30 by default for
MCP, at most 600) and then returns what it has with a `task_id`; continue with `task_wait`. `wait` is
not a timeout: the command keeps running. Use `timeout` to limit the command itself.

The result is the command's combined output followed by a note in square brackets:

```text
hello
[web-1, exit 0]
```

Notes also report timeouts, signals, a still-running task or a pending approval with its link. Long
output is truncated to its tail; the note names the complete output file on the node, which you can read
with `read_file`. A non-zero exit marks the result as an error but still includes the output.

### File tools

File tools wait until the task finishes, including any approval, and return no task id. Closing the
request cancels the task, so a client that gave up does not leave a write to happen later.

- `read_file` reads up to 2000 lines or 50 KiB per page; continue with `offset`.
- `write_file` fails if the file exists unless `overwrite` is true. `mode` is an octal string such as
  `"0644"`.
- `edit_file` requires each `old_text` to occur exactly once; all edits on a node apply together or not
  at all.

### Errors

Errors are returned as tool results with `isError` set and a stable code, such as `node_offline`,
`approval_rejected`, `invalid_argument` or `no_such_node`: in the note for text results, as
`{"error": {...}}` for JSON results.

## Permissions and approvals

- **Node access** is yours: the token sees the nodes you can access.
- **Rules** are the token's own: its preset plus any rules you add.
- **Approvals** go to you in the WebUI, on the Approvals page. There is no MCP tool to approve. `exec`
  returns the waiting state and a link; call `task_wait` after deciding. File tools keep waiting.
  "Approve and always allow" adds the rule to the token.

Tasks started over MCP appear in **Tasks** with the API token as their actor, and in the audit log.

Set `public_url` in **System settings** when crhs runs behind a reverse proxy, so the links in tool
results use the public address ([Reverse proxy and TLS](install.md#reverse-proxy-and-tls)).

### Privileged tasks over MCP

Set `privileged: true` on `exec` or a file tool. On a `forward` node the task may also need your
signature after the rules allow it; sign it on the task page or the Approvals page with a Passkey or
`crha grant`, then call `task_wait`. SSH nodes ignore the flag.

## Differences from agent sessions

| | Agent session | MCP |
|---|---|---|
| Who acts | A session, for its owner | An API token, for its owner |
| Rule presets | Ask, Auto Review, Yolo | Ask, Yolo |
| Conversation, subagents, schedules | Yes | No; your client is the agent |
| `exec` default wait | 10 minutes | 30 seconds |

Once a task exists, it behaves the same either way.

## Limitations

- No stdio transport; use Streamable HTTP or a third-party bridge.
- Tools only: no MCP resources or prompts, no tools to manage CRH, and no way to hand work to CRH's
  built-in agent.
- Bearer tokens only, no OAuth.
- No progress is pushed to the client; poll with `task_wait`.
- `task_wait` and `task_cancel` reach only `exec` tasks started by the same token.
- Closing an `exec` request does not stop the task; closing a file tool request cancels it. Set your
  client's timeout above the `wait` you use.
