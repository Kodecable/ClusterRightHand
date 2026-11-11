# ClusterRightHand

ClusterRightHand (CRH) is an agent platform for managing a cluster of Linux servers. The `crhs` server
runs agent sessions and sends the commands they decide on to your nodes. A node either runs the `crha`
agent, which connects to crhs, or is reached over SSH with nothing installed.

crhs is also an MCP server, so external coding agents such as Claude Code or Codex can use the same
tools. Whether a task comes from a session, a schedule, the WebUI or an external agent, it passes the
same node access checks, rules, approvals and audit log.

- **Privilege is decided on the node.** A privileged task runs only with an authorization the node
  accepts. A node can be configured so that crhs alone can never elevate, and only a user's signature
  or a local approval can.
- **One process.** crhs serves the WebUI, the MCP endpoint, the agents and the scheduler, and stores
  everything in SQLite or PostgreSQL.
- **English and Chinese WebUI.**

## Where to start

1. [Install CRH](doc/guide/install.md) and enroll your first node.
2. Read the [concepts](doc/guide/concepts.md).
3. [Use the WebUI](doc/guide/webui.md), or [connect an external agent over MCP](doc/guide/mcp.md).

## Documentation

**Guide**

| Page                                                                 | Covers                                              |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| [Concepts](doc/guide/concepts.md)                                    | Nodes, tasks, sessions, rules, approvals, privilege |
| [Install](doc/guide/install.md)                                      | Setting up crhs, nodes and models                   |
| [Using the WebUI](doc/guide/webui.md)                                | A tour of the console                               |
| [MCP server](doc/guide/mcp.md)                                       | Connecting external coding agents                   |
| [Security](doc/guide/security.md)                                    | Trust, privilege modes, hardening                   |
| [Operations](doc/guide/operations.md)                                | Upgrades, backups, logs, troubleshooting            |
| [crhs configuration](doc/guide/reference/crhs-config.md)             | `crhs.toml`                                         |
| [crha configuration](doc/guide/reference/crha-config.md)             | `crha.toml`                                         |
| [Privileged configuration](doc/guide/reference/privileged-config.md) | `privileged.toml`                                   |
| [Command line](doc/guide/reference/cli.md)                           | `crhs` and `crha` commands                          |

**Design**

| Document                                                   | Covers                                        |
| ---------------------------------------------------------- | --------------------------------------------- |
| [Architecture](doc/design/architecture.md)                 | Components, boundaries, limitations           |
| [Protocol](doc/design/protocol.md)                         | The crhs–crha protocol and transport security |
| [Execution plane](doc/design/execution.md)                 | Tasks, output, connections, SSH               |
| [Privilege and authorization](doc/design/privilege.md)     | Privilege modes, authorizations, node trust   |
| [Users, ownership and audit](doc/design/access-control.md) | Users, access, rules, approvals, audit        |
| [Agent runtime](doc/design/agent-runtime.md)               | Sessions, tools, subagents, quotas            |
| [Scheduled tasks](doc/design/scheduling.md)                | Schedules                                     |
| [Data model](doc/design/data-model.md)                     | Storage and retention                         |
| [WebUI](doc/design/webui.md)                               | Frontend design                               |
| [Testing](doc/design/testing/README.md)                    | Test layers and how to run them               |

## License

MIT; see [LICENSE](LICENSE).
