# ClusterRightHand

## What ClusterRightHand is

ClusterRightHand (CRH) is an agent platform for managing a VPS cluster. One `crhs` server runs
multi-session agent loops and dispatches the work they decide on to managed nodes. A node runs the
`crha` client, which dials in and executes tasks locally, or is reached over SSH without installing
anything on the host.

The server is also useful without its built-in agent: crhs is an MCP server, so any coding agent that
speaks Streamable HTTP can drive the same cluster through the same tools. Both modes meet in one
Cluster core, so policy, approvals, privilege checks and audit apply whether a task starts from a
chat session, a scheduled run, a WebUI action or an external agent.

The repository is at <https://github.com/Kodecable/ClusterRightHand>.

## Core properties

- **One Cluster core for every caller.** The agent runtime, the scheduler, the WebUI and the MCP
  facade all create tasks through the Cluster API. Policy checks, approvals, authorization signing
  and audit happen inside the Cluster core, and no caller can bypass them. MCP mode is not an
  unaudited side door.
- **Privilege is rooted in node-side trust.** A privileged task runs only with an authorization the
  node accepts. Each node decides which crhs and user keys it trusts, whether a local approval is
  required and which privileged methods are allowed; a node can be configured so that crhs can
  never elevate alone and only a user signature can.
- **One process, two storage backends.** crhs is a single Node.js process that serves the WebUI and
  its API, the MCP endpoint, the agent runtime and the scheduler. Everything is stored in SQLite by
  default, or in PostgreSQL.
- **A bilingual WebUI.** The built-in WebUI is available in English and Simplified Chinese. You
  switch language in the user menu and the browser remembers the choice.

## Components at a glance

| Component                  | Role                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crhs`                     | The server: WebUI API, MCP facade, agent runtime, scheduler, Cluster core, node registry, policy and audit.                                                              |
| `crha` (unprivileged mode) | The node daemon. Dials crhs over WSS, executes ordinary tasks as its own Linux identity and reconnects after a disconnect.                                               |
| `crha` (privileged mode)   | A separate process that listens on a local unix socket only, verifies authorizations and executes privileged tasks. It usually runs as root and has no network listener. |
| WebUI                      | A React single-page application served by crhs, with sessions, tasks, nodes, approvals, schedules and administration.                                                    |
| MCP facade                 | A Streamable HTTP endpoint that exposes the cluster tools to an external coding agent, authenticated by an API token.                                                    |

## Where to start

1. [Install ClusterRightHand](doc/guide/install.md) to set up crhs, build the WebUI and enroll your first
   node.
2. [Read the concepts](doc/guide/concepts.md) for the objects and terms used in the WebUI, the API and
   the configuration files.
3. [Use the WebUI](doc/guide/webui.md) to run sessions, review approvals, manage nodes and browse the
   audit log.

If you only want to connect an external agent, start with [Using CRH as an MCP
server](doc/guide/mcp.md).

## Documentation

### Guide

Task-oriented pages for people who deploy, operate and use CRH.

| Page                                                                 | What it covers                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Concepts](doc/guide/concepts.md)                                    | The mental model: nodes, groups, tasks, sessions, rules, approvals, privilege and schedules. |
| [Installing](doc/guide/install.md)                                   | Prerequisites, building and running crhs, the WebUI, the database and enrolling a node.      |
| [Using the WebUI](doc/guide/webui.md)                                | Signing in, sessions, tasks, nodes, approvals, authorizations, schedules and settings.       |
| [MCP server](doc/guide/mcp.md)                                       | Connecting an external coding agent, the tool surface and how permissions apply.             |
| [Security](doc/guide/security.md)                                    | What crhs can do on a node, authentication, transport security, trust, audit and hardening.  |
| [Operations](doc/guide/operations.md)                                | Service management, reloads, upgrades, backups, logs, retention and troubleshooting.         |
| [crhs configuration](doc/guide/reference/crhs-config.md)             | Every crhs configuration key, its type, default and effect.                                  |
| [crha configuration](doc/guide/reference/crha-config.md)             | Every crha configuration key and the path defaults.                                          |
| [Privileged configuration](doc/guide/reference/privileged-config.md) | The privileged mode configuration, trust entries and guard rules.                            |
| [Command-line reference](doc/guide/reference/cli.md)                 | The crhs and crha commands, subcommands and flags.                                           |

### Design

How the system works and why: the internals behind the guide.

| Document                                               | What it covers                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [Architecture](doc/design/architecture.md)             | Components, layering, technology stack, repository layout, an end-to-end flow, extension points and limitations.        |
| [Protocol](doc/design/protocol.md)                     | The crhs ↔ crha wire format: encoding, handshake, frames, version negotiation, commands, events and privilege messages. |
| [Execution plane](doc/design/execution.md)             | The task model and state machine, output, connection lifecycle, SSH transport, reloads and upgrades.                    |
| [Privilege and authorization](doc/design/privilege.md) | The threat model, privilege modes, authorization contents, node trust, the validation flow and local approval.          |
| [Users and audit](doc/design/access-control.md)        | Users and groups, node ownership, access grants, rules, API tokens and audit events.                                    |
| [Agent runtime](doc/design/agent-runtime.md)           | The pi-durable loop, the AgentRuntime interface, cluster tools, sessions, subagents, quotas and statistics.             |
| [Scheduled tasks](doc/design/scheduling.md)            | Schedule shape, single-instance execution, triggering, quotas, privilege and lifecycle.                                 |
| [Data model](doc/design/data-model.md)                 | Storage backends, identifiers, migrations, the tables for each object and retention.                                    |
| [WebUI](doc/design/webui.md)                           | The frontend architecture, pages, Markdown rendering, the backend API and performance targets.                          |
| [Testing](doc/design/testing/README.md)                | The test layers, commands, environment variables and CI.                                                                |
| [Server tests](doc/design/testing/server.md)           | The server test suites and what they cover.                                                                             |
| [WebUI tests](doc/design/testing/web.md)               | Browser and component tests for the WebUI.                                                                              |
| [Privileged tests](doc/design/testing/privileged.md)   | System tests for privilege, trust and approval on real hosts.                                                           |
| [Interop fixtures](doc/design/testing/interop.md)      | The shared protocol fixtures and the cases they pin down.                                                               |

## License

ClusterRightHand is released under the MIT license, copyright (c) The ClusterRightHand authors. See
[LICENSE](LICENSE) for the full text.
