# Architecture

ClusterRightHand runs agent sessions on a server, crhs, and runs the work they decide on across
managed nodes. This document describes the components, the boundaries between them, the main
technology choices, the deliberate extension points and the known limitations.

## Components

```text
   WebUI                        external coding agent (Claude Code, Codex, …)
     │ HTTP, SSE                         │ MCP (Streamable HTTP)
┌────┴───────────────────────────────────┴─────────────────────┐
│ crhs                                                          │
│   WebUI API · MCP endpoint                                    │
│   agent runtime (sessions, subagents) · scheduler             │
│   ─────────── Cluster API: the only way to run anything ───── │
│   Cluster core: nodes, tasks, rules, approvals, signing, audit│
│   transports: crha (CRH protocol) · SSH                       │
│   storage: SQLite or PostgreSQL · libraries: local or WebDAV  │
└─────────┬────────────────────────────────────┬────────────────┘
          │ CRH protocol over WSS (crha dials) │ SSH
   crha unprivileged mode ── unix socket ── crha privileged mode (no network)
```

crhs is one Node.js process. It serves the WebUI itself, so no second web server is needed. The MCP
endpoint offers the same tools to external coding agents, authenticated by API tokens. The agent runtime
runs sessions on pi-durable, and the scheduler starts sessions on a timetable. Both, and the WebUI, act
only through the Cluster API, which owns node registration, tasks, rules, approvals, authorization
signing and audit. Below it, one transport talks to crha over the CRH protocol and another runs tasks
over SSH on nodes with nothing installed.

Libraries are per-user and per-group file stores on crhs; whole files move between them and nodes
through crhs, on data connections separate from the control connection ([Libraries and file
transfer](library.md)).

Chat channels are outbound connections to chat platforms. The channel module owns the adapters (one per
platform kind) and the platform-independent core: linking accounts, conversations, inbound messages and
files, outbound text, notifications and approvals in chat. The core uses the agent runtime and the
Cluster API like the WebUI does, so a chat decision passes the same checks and is audited
([Chat channels](channels.md)).

On a node, crha's unprivileged mode connects to crhs and runs ordinary tasks; its optional privileged
mode has no network access and runs only authorized tasks ([Privilege](privilege.md)).

## Layering principles

- **The Cluster API is the only way to run anything.** WebUI actions, agent tools, MCP calls and
  scheduled runs all create tasks through it, so rules, approvals, signing and audit cannot be bypassed.
  An MCP mode without them would be an unaudited back door.
- **The HTTP API is not a public interface.** crhs offers no API to outside programs. The HTTP API
  exists for the WebUI, and its API document exists only so that agents can operate crhs through
  `api_request` ([Built-in extensions](extensions.md#built-in-extensions)). It has no versioning policy
  and no compatibility guarantee: routes and shapes change with the WebUI. Outside tools integrate
  through MCP.
- **The execution plane does not know the agent.** A node only knows task ids; crhs records which
  session, user or schedule a task came from.
- **The agent layer is replaceable.** pi is isolated behind the agent runtime facade; the Cluster core
  and the API do not depend on pi types.
- **Dependencies point down.** Shared helpers in `server/src/util/` depend on nothing above them.

### Server modules

`server/src` is split into top-level modules, lowest layer first:

```text
util, config.ts, version.ts, keys, storage → policy → auth → users →
audit, settings, sessions → library → privilege → cluster, retention → extensions → tools → agent →
scheduler → channels → mcp, api → setup, cli → main.ts
```

A module may import only modules at or below its layer, and `pnpm check` rejects runtime module
cycles (type-only imports do not count) so the layering cannot erode through a local shortcut.

## Concurrency

Most shared state is per key (a session, a task, a channel), and the bugs that kept coming back were
hand-rolled `Map<string, Promise<…>>` helpers that looked alike but differed in whether they queued,
coalesced or dropped a request. Three primitives in `server/src/util` cover the shapes:

- `KeyedReconciler.run(key, compute)` serializes passes for one key and coalesces requests: a request
  during a pass shares its promise and asks for exactly one more pass, which reads data newer than the
  latest request. A throwing pass still removes its entry. Use it for state-change notifications:
  a notification is only a hint, and the pass reads the current state and compares it with what it
  already did, so a missed notification cannot lose the change and a duplicate one is harmless.
- `KeyedQueue.run(key, fn)` runs every operation for a key in order, and a failing operation does not
  stop the later ones. Use it when every operation must run (a task row's writes, a channel's admin
  actions).
- `SingleFlight.run(key, create)` shares one in-flight creation and forgets it when it settles. Use it
  only for an idempotent creation, where running it twice is wrong and skipping it is not needed.

Persisted state transitions still use rev-checked (compare-and-set) writes: these primitives order
work inside one process, they do not replace the database's conditional write. Do not add a new
per-key promise map: pick one of the three, or say in one line why the map is something else (a
registry of live runs, a connection cache). `StateRefreshes` is built on `KeyedReconciler`.

## Technology choices

- **crhs in TypeScript on Node.js**, because the pi agent SDK runs there directly. **crha in Go**,
  because it cross-compiles to one static binary with no runtime to install on the node.
- **SQLite or PostgreSQL through Kysely**, so a single machine needs no database server while a team
  deployment gets a real one, with one schema for both ([Data model](data-model.md)).
- **CBOR with hand-written codecs on both sides**, kept compatible by shared test vectors rather than a
  code generator ([Protocol](protocol.md)).
- **RE2 for privilege guard rules**, as a native module. If it fails to build, crhs refuses to start
  rather than fall back to the JavaScript regex engine, whose backtracking could stall the server.
- **TOML** for every configuration file.

Exact dependencies are pinned in each `package.json` and in `client/go.mod`. The TypeScript code is one
pnpm workspace (`packages/*`, `server`, `web`); `@crh/api` holds the wire types plus the small shared
locale registry, so crhs and the WebUI share
one definition of the HTTP API. The Go client is a separate module under `client/`.

## End-to-end flow: a privileged command

1. A session's model calls `exec` on `web-1` with `systemctl restart nginx`, marked privileged.
2. The tool creates a task through the Cluster API, which records that it comes from session S acting
   for user U.
3. crhs checks that U can access `web-1`, then evaluates the rule chain from the root session down. If
   approval is needed, the request goes up to the nearest allowing agent, or to U
   ([Authorization rules](access-control.md#authorization-rules)).
4. The node's privilege mode decides what else is needed. For a `forward` node, crhs plans an
   authorization from the node's trust report: it signs one itself if the node trusts crhs for this
   command, or uses or waits for U's signature or a local approval
   ([Authorization path](privilege.md#authorization-path)).
5. crha forwards the task to its privileged mode, which verifies the authorization, runs the command and
   streams the output back. crhs keeps the head and tail; the complete output stays on the node.
6. crhs records the audit events; the privileged mode writes its own log on the node.

## Platform support

Linux is the supported platform. crha is built for linux/amd64 and linux/arm64. crhs runs wherever
Node.js 24.7 or later runs. There is no Windows support.

Outbound HTTP follows the process environment: crhs applies `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`
at startup with Node's built-in proxy support, so model SDKs, MCP transports, chat channels, the
models.dev download and the WebDAV backend share one setting
([Outbound proxy](../guide/install.md#outbound-proxy)). A client that builds its own agent hands it the
same environment, and crha uses Go's `ProxyFromEnvironment` for its connection to crhs. Inbound and SSH
traffic is unaffected.

## Extension points

These are not implemented, but the design leaves room for them:

- **Monitoring and alerting.** New protocol commands can carry metrics without changing existing
  ones, crha's fact collection can grow into periodic collectors, and metrics would go to separate
  storage rather than the main tables. Cluster events go through one internal event bus that alerts,
  webhooks or "start a session on alert" could subscribe to.
- **Server-initiated connections** to crha nodes, with the handshake rules mirrored
  ([Handshake and replay protection](protocol.md#handshake-and-replay-protection)).
- **Audit export** to a system outside crhs for tamper evidence
  ([Tamper resistance](access-control.md#tamper-resistance)).
- **Direct transfers**: presigned S3 URLs and node-to-node copies ([Extension points](library.md#extension-points)).
- **Signed trust bundles** for managing node trust centrally ([Extension points](privilege.md#extension-points)).
- **OIDC login** ([Extension points: OIDC](access-control.md#extension-points-oidc)).
- **Local crha policy**, limits in `crha.toml` that would hold even against a compromised crhs. crha
  rejects unknown configuration keys, so such keys fail rather than being silently ignored.
- **Runbooks.** External tools themselves are no longer a future extension point: they are extensions,
  MCP servers an administrator connects or the built-in `crhs-docs` and `crhs-api` ([Extensions](extensions.md)).

## Known limitations

- **Linux only.**
- **No interactive terminal.** Tasks run commands and file operations; there are no PTY tasks.
- **SSH nodes must be reachable from crhs**, and crha nodes must be able to reach crhs.
- **No packages, service units or self-upgrade.** `crha upgrade --apply` is not implemented
  ([Upgrades](../guide/operations.md#upgrades)).
- **No MCP stdio bridge.** MCP clients connect to crhs over HTTP.
- **No redaction** of command output or file contents sent to model providers
  ([Prompt injection](agent-runtime.md#prompt-injection)).
- **Message search needs PostgreSQL.**
- **Deep pages of `read_file` over SSH** rescan the file from the start.
- **A crash can charge a compaction twice**, and a crash right after the owner denies a root quota asks
  the owner again.
- **A privileged task request can block for about 30 seconds** when the node's privileged mode does not
  answer.
- **pi-durable is pinned** until an upstream fix to its subscription push rate is released
  ([Dependency versioning](agent-runtime.md#dependency-versioning)).
