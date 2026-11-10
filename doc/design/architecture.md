# Architecture

ClusterRightHand runs agent sessions on a server and dispatches the work they decide on to managed
nodes. This document describes the components, the boundaries between them, the technology choices,
the repository layout, one end-to-end trace, and the deliberate extension points and limitations.
The execution plane, the wire protocol, privilege, access control, the agent runtime, scheduling,
the data model and the WebUI have their own design documents.

## Components

```text
   WebUI (React)                 external coding agent (Claude Code, Codex, …)
        │ HTTP + WebSocket                    │ MCP (Streamable HTTP)
┌───────┴─────────────────────────────────────┴──────────────────┐
│ crhs (Node.js)                                                  │
│                                                                 │
│  facade layer   WebUI API · MCP facade                          │
│  agent layer    AgentRuntime (pi-durable) · sessions · subagents│
│  scheduler      scheduled-task scheduler                        │
│  ──────────────── Cluster API (the only execution entry) ────── │
│  Cluster core   node registry · task management · policy and    │
│                 approvals · authorization signing · audit       │
│  transports     ClientTransport (CRH protocol) · SshTransport   │
│                                                                 │
│  storage        Kysely → SQLite | PostgreSQL                    │
│                 (business tables + pi_* durable tables)         │
└──────────┬───────────────────────────────────┬──────────────────┘
   CRH protocol / WSS (the client dials in)     SSH
           │                                    │
   crha unprivileged mode ──unix socket── crha privileged mode (no network)
```

`crhs` is a single Node.js process. The WebUI is a React single-page application that crhs serves
itself: paths outside `/api`, `/agent` and `/mcp` fall back to `index.html`, so client-side routes
work without a second server. The MCP facade exposes the same tools to an external coding agent over
Streamable HTTP, authenticated by an API token. The agent runtime runs the pi-durable loop and owns
sessions, with every subagent as a child session; the scheduler creates a session from a cron
schedule. Both the agent and the MCP facade call the Cluster core through the Cluster API, which is
the only execution entry: node registration, tasks, policy, approvals, authorization signing and
audit all happen there. Two transport adapters implement the node side of that interface:
`ClientTransport` speaks the CRH protocol to a crha client over WSS, and `SshTransport` runs tasks
over SSH on a node with no agent installed. Storage is Kysely over SQLite or PostgreSQL; the business
tables and the pi-durable `pi_*` tables share one database. On a node, crha runs in two modes: the
unprivileged mode dials crhs and executes ordinary tasks, and the privileged mode listens on a local
unix socket only and executes tasks that carry an authorization.

## Layering principles

- **The Cluster API is the only execution entry.** Manual actions in the WebUI, agent tool calls, MCP
  calls and scheduled runs all create tasks through the Cluster API. Policy checks, approvals,
  authorization signing and audit happen in the Cluster core, and a caller cannot bypass them. An MCP
  mode without them would be an unaudited back door.
- **The execution plane does not know the agent.** A client only knows task ids; the origin of a task
  (which session, which user, which schedule) is recorded on the server.
- **The agent layer is replaceable.** pi-durable is isolated behind the `AgentRuntime` interface; the
  Cluster core and the facade layer do not depend on any pi type.
- **Dependencies point down.** `util/` does not depend on `api/`, `agent/` or `cluster/`. Policy and
  cluster use `util/` for names, shell quoting, cursors and error types; they do not reach up to a
  higher layer for one helper.

## Component responsibilities

| Component | Responsibility |
|---|---|
| WebUI API | User login, session chat (streaming), node management, approvals, scheduled tasks and audit queries; see [WebUI](webui.md) |
| MCP facade | Exposes the cluster tools as MCP tools, authenticated by an API token; see [Using CRH as an MCP server](../guide/mcp.md) |
| AgentRuntime | Session lifecycle, agent loop, subagents and context compaction; see [Agent runtime](agent-runtime.md) |
| Scheduled-task scheduler | Creates a session with a fixed message on a timetable; see [Scheduled tasks](scheduling.md) |
| Cluster core | Node registration and state, the task state machine and output storage, the policy engine, approvals, server-side signing and audit |
| ClientTransport | Maintains the connection to crha and implements the CRH protocol; see [Execution plane](execution.md) and [Protocol](protocol.md) |
| SshTransport | Runs tasks over SSH and presents the same task interface upwards |
| crha unprivileged mode | Node daemon: dials crhs and executes ordinary tasks; privileged tasks are forwarded to the privileged mode, run with sudo, run directly, or rejected, by configuration |
| crha privileged mode | Listens on a local unix socket only, verifies authorizations and executes privileged tasks; usually runs as root, but the mode is independent of the Linux identity; see [Privilege and authorization](privilege.md) |
| crha user subcommands | `crha grant` (issues an authorization on a user workstation), `crha approve` / `crha pending` (local approval on the node) |

## Technology stack

| Part | Choice |
|---|---|
| Server | Node.js ≥ 24.7, TypeScript; Argon2id from `node:crypto` |
| Database access | Kysely; SQLite through `node:sqlite`, PostgreSQL through `pg` |
| Agent | `@earendil-works/pi-durable` and `@earendil-works/pi-ai`, pinned to exact versions |
| WebUI | React (Vite) |
| Client | Go, one static binary cross-compiled for linux/amd64 and linux/arm64; cobra; module path `github.com/Kodecable/ClusterRightHand/client` |
| Release | Plain shell scripts for cross-compilation, packaging, checksums and signing; not goreleaser |
| Protocol | CBOR (`CBOR-CORE-INT-v1`), bidirectional commands and events; hand-written TypeScript and Go types and codecs, cross-checked by golden vectors |
| SSH (server side) | `ssh2` |
| Configuration | TOML for every configuration file |
| Rule matching | Native `re2` package |

Node.js runs the pi SDK directly, and Go cross-compiles to a single static binary with little
ceremony; this split keeps the agent loop on the server and the node client small. SQLite suits a
single-machine installation and PostgreSQL a team deployment, and Kysely keeps one schema for both.
The CBOR types and codecs are hand-written on both sides rather than generated, with golden vectors
under `test/interop/` keeping them compatible; see [Protocol](protocol.md).

`re2` is a native module. `pnpm-workspace.yaml` allows its build script (`allowBuilds`), a prebuilt
binary is downloaded for the running Node ABI, and `RE2_DOWNLOAD_MIRROR` points at a mirror for
offline installs. A failed build is fatal: crhs never falls back to the JavaScript `RegExp` engine.
The release scripts are not part of the repository; see [Known limitations](#known-limitations).

## Repository layout

```text
ClusterRightHand/
├── doc/                    design and guide documentation
├── packages/
│   ├── api/                @crh/api: HTTP API types shared by the server and the WebUI
│   ├── noise/              @crh/noise: Noise IK implementation in TypeScript
│   └── protocol/           @crh/protocol: CBOR types, codecs and golden vectors
├── server/                 @crh/server: crhs
│   ├── src/agent/          AgentRuntime interface and durable implementation, cluster tools
│   ├── src/api/            WebUI API and MCP facade
│   ├── src/audit/          append-only audit log
│   ├── src/auth/           login, sessions, password hashing
│   ├── src/cli/            crhs command line
│   ├── src/cluster/        Cluster core and transport adapters
│   ├── src/keys/           master key and key export
│   ├── src/mcp/            MCP endpoint
│   ├── src/policy/         rule engine and approvals
│   ├── src/privilege/      authorization payloads, planning and signing
│   ├── src/scheduler/      scheduled tasks
│   ├── src/storage/        Kysely wrapper (node:sqlite adapter), migrations, durable storage
│   ├── src/tools/          tool catalog
│   ├── src/users/          users and groups
│   ├── src/util/           names, shell quoting, cursors, errors (no agent/cluster dependency)
│   ├── src/config.ts       configuration parsing
│   └── src/main.ts         crhs entry point
├── web/                    @crh/web: WebUI (Vite + React)
│   └── src/                app/, components/, features/, hooks/, lib/, markdown/, locales/, test/
├── client/                 Go module github.com/Kodecable/ClusterRightHand/client
│   ├── cmd/crha/           single binary (cobra)
│   └── internal/           cli, config, transport, noise, executor, privileged, protocol (CBOR)
├── test/
│   └── interop/            golden vectors shared by the TypeScript and Go implementations
└── .github/workflows/      continuous integration
```

The TypeScript side is one pnpm workspace: `packages/*`, `server` and `web`, declared in
`pnpm-workspace.yaml`. The three packages under `packages/` are private workspace packages consumed
through `workspace:*`; `@crh/api` contains only types, so the server and the WebUI share one
definition of the HTTP API. Node runs `.ts` files directly (type stripping), and `tsc --noEmit` only
type-checks; Biome lints and formats, and Vitest runs the tests. The Go client is a separate module
under `client/`.

Root commands:

- `pnpm check` runs Biome, the TypeScript type check of every package, `gofmt -l` and `go vet`.
- `pnpm test` runs the Vitest suites and `go test ./...`; with `CRH_TEST_PG_URL` set, the server tests
  also run against PostgreSQL.

## End-to-end flow: a privileged command

1. The model in a session calls `exec(node="web-1", cmd="systemctl restart nginx", privileged=true)`.
2. The tool handler calls the Cluster API to create the task. The Cluster core records the origin:
   session S, acting for user U.
3. The policy engine decides whether U can access web-1 (as an administrator, or through a node
   access grant directly or through a node group), then walks the rule chain from the root session S
   down and decides allow, deny or require-approval. When approval is required it walks up the
   session chain to the first allowing ancestor agent, then to the user; see
   [Authorization rules](access-control.md#authorization-rules) and
   [Approvals](access-control.md#approvals).
4. The node's `[privileged].mode` decides the authorization path:
   - `native` and `ignore`: only the crhs policy has to allow the task; `reject`: the task is
     refused.
   - `forward`: crhs computes an authorization plan from the cached privileged-mode `TrustSummary`:
     - A crhs trust entry can authorize the task alone: once the approval path allows it, crhs signs
       a single-command authorization.
     - Only the owner's user trust entries can take the user paths: use a valid authorization the
       owner already issued, or wait for a Passkey or SSH key signature or for a local approval. When
       the entry requires a cosignature, crhs adds its signature to the same payload.
     - Only credentials of `on_behalf_of_user_id` are considered; shared users and other
       administrators are not.
5. The task and its authorization go to the crha unprivileged mode, which forwards them to the
   privileged mode; the privileged mode verifies the authorization, executes the task, and the output
   streams back through the unprivileged mode as one stream. crhs stores a truncated head and tail
   and records the node-side output file; a `status` task pushes no output and keeps only the file
   path. SSH nodes ignore the privileged flag, run as the SSH user and carry a notice on the task
   instead of an authorization.
6. Audit: crhs writes the Cluster audit table; the privileged mode writes the node-local log.

## Platform support

Linux is the primary supported platform. crha is a single static binary cross-compiled for
linux/amd64 and linux/arm64; the server runs wherever Node.js ≥ 24.7 runs. There is no Windows
service story and no Windows binary.

## Extension points

These mechanisms are reserved, not implemented. The current design must not block them.

- **Monitoring, alerting and dashboards.** Protocol messages are fixed-structure CBOR commands and
  events; a new feature adds a new command (for example `metrics.batch`) and never changes an
  existing structure in place, and the handshake negotiates the command set. crha organizes
  collection as collectors (v1 has only `Facts`), so periodic metric collection can be added without
  touching the execution path. Metrics do not go into business tables: a separate storage interface
  can connect a time-series store, or downsampled tables in PostgreSQL or SQLite, without changing
  the data model. Cluster core events (a node connecting or disconnecting, a task ending, an
  approval) go through one event bus; alert rules, notifications and "an alert starts an agent
  session" become subscribers of it.
- **Protocol command namespace.** New commands and events are added, never in-place changes; a
  replacement is a new name such as `task.start.v2`.
- **Server-initiated transport.** A crha node always dials crhs. A transport in which the server
  connects to the client sends the challenge from the crha side, with symmetric rules; see
  [Handshake and replay protection](protocol.md#handshake-and-replay-protection).
- **Audit export.** The audit log is append-only and has no in-database tamper evidence; real
  tamper evidence depends on exporting it to another trust domain, which is reserved; see
  [Tamper resistance](access-control.md#tamper-resistance).
- **Webhook notifications.** A subscriber of the event bus, like alerting.
- **Signed trust bundles.** A node's trust configuration could come from an offline-signed bundle;
  the reserved fields are described in [Signed trust bundles](privilege.md#signed-trust-bundles).
- **OIDC login.** Login is separate from identity, a password may be absent, and a user identity may
  come from an external provider; see [Extension points: OIDC](access-control.md#extension-points-oidc).
- **Local crha policy.** `crha.toml` could carry node-side limits such as `allow_kinds` and
  `read_only`, which would hold even if crhs were compromised. crha does not read them and never
  returns `local_policy_denied`; the configuration parser rejects unknown keys, so these keys fail
  startup instead of being ignored.
- **Extension mechanisms.** crhs as an MCP client for external tools, and runbooks, are reserved and
  not implemented.

## Known limitations

- **Linux only.** There is no Windows binary and no Windows service story; see
  [Platform support](#platform-support).
- **No PTY or terminal.** v1 executes commands and file operations; there is no interactive PTY and
  no WebUI terminal; see [Task types](execution.md#task-types).
- **SSH nodes have no reverse connection.** The server must be able to reach each SSH node's SSH
  port; see [SSH transport](execution.md#ssh-transport).
- **The server cannot initiate a connection to a crha node.** A crha node always dials crhs; a
  server-initiated transport is reserved; see [Extension points](#extension-points).
- **No packaging, systemd units or self-upgrade in the repository.** `crha upgrade --apply` is
  present but not implemented; an upgrade replaces the binary and restarts the service; see
  [Upgrades](../guide/operations.md#upgrades).
- **No local crha policy enforcement.** A node's only local limit on crhs is the privileged mode's
  trust configuration; see [Extension points](#extension-points).
- **No MCP stdio bridge.** crha does not proxy stdio MCP; clients connect to crhs at `/mcp` over
  HTTP; see [Limitations](../guide/mcp.md#limitations).
- **No monitoring, alerting or dashboards.** See [Extension points](#extension-points).
- **No redaction of data sent to model providers.** Command output and file contents enter the
  model context as they are; there is no redaction and no "do not send to the model" flag; see
  [Prompt injection](agent-runtime.md#prompt-injection).
- **No signed trust bundles.** See [Signed trust bundles](privilege.md#signed-trust-bundles).
- **No OIDC login.** See [Extension points: OIDC](access-control.md#extension-points-oidc).
- **No audit hash chain.** The audit log is append-only by design; tamper evidence depends on
  external export; see [Audit](access-control.md#audit).
- **Content search needs PostgreSQL.** SQLite searches session titles only; message content search
  is PostgreSQL-only; see [Conversation content search](data-model.md#conversation-content-search).
- **SSH `file.read` rescans the file from the start for a deep page.** The cost grows with the page
  offset; see [SFTP file operations](execution.md#sftp-file-operations).
- **Compaction metering depends on pi-durable internals.** An upgrade of pi-durable must re-check
  it; see [Dependency versioning](agent-runtime.md#dependency-versioning).
- **A crash can charge a compaction twice.** If crhs crashes after a compaction and the task runs
  again, the compaction is metered again; see
  [Quota and token accounting](agent-runtime.md#quota-and-token-accounting).
- **Root-quota denial race.** If crhs crashes after the owner denies a root quota but before the
  paused call observes the denial, recovery pauses once more and the owner decides again; see
  [Quota enforcement](agent-runtime.md#quota-enforcement).
- **A privileged task creation request can block for about 30 seconds.** `POST
  /api/nodes/:id/tasks` waits for the node's `task.start` response; a stuck privileged mode can hold
  it until the forwarding timeout, past the caller's `waitMs`; see
  [Task row concurrency](execution.md#task-row-concurrency).
- **The pinned pi-durable version waits for an upstream release.** The subscription push-rate fix is
  not in a released version; the exact pin stays until it is; see
  [Dependency versioning](agent-runtime.md#dependency-versioning).
