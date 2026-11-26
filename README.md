# ClusterRightHand

**English** | [简体中文](README.zh-CN.md)

ClusterRightHand (CRH) is a self-hosted multi-node agent platform with strict agent rules, node-trusted
privilege authorization and auditing.

![An agent session on the desktop, and a privileged command on db-1 signed with a Passkey on a phone](doc/images/hero.en.png)

## Highlights

**Core**

- **A native multi-node agent runtime.** Nodes and node groups are direct arguments of the agent's tools:
  one call runs a command or a file operation on a whole group and returns the result per node.
- **Rules, approvals and audit.** Every task an agent starts is first allowed, denied or held for approval
  by the rules, and every task is recorded in the audit log.
- **Privilege is decided on the node.** A node can require a privileged task to carry a user's SSH key or
  Passkey signature, or a local approval; when the node is configured well, a compromised central server
  cannot become root on it alone.
- **Two ways to reach a node.** Install the `crha` client, which dials out, or connect over SSH with no
  CRH component on the node.
- **Manages CRH itself and serves as an MCP server.** The agent can call the crhs API by its documentation;
  Claude Code, Codex and other MCP clients can use the same cluster tools under the same rules.

**Additional features**

- **Interactive terminals.** Open a terminal on a crha node in the WebUI; people and agents can share it.
- **Host metrics.** crhs collects CPU, memory, disk and network metrics from the nodes, with no separate
  monitoring agent.
- **Chat channels.** Use sessions and answer approvals from a chat app through Telegram or Satori.
- **Scheduled tasks.** Start a session with a preset prompt on a cron schedule.
- **Simple to deploy.** One Node.js process with SQLite or PostgreSQL.

| Node metrics                                                                                               | Node trust                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ![db-1's metrics: CPU, load, memory, disks and network over the last hour](doc/images/node-metrics.en.png) | ![db-1 trusts only the admin's SSH key and Passkey, and local root](doc/images/node-trust.en.png) |

## How it works

```text
 WebUI · MCP clients
        │
      crhs ── agent sessions, scheduler, rules, approvals, signing, audit
        │
   ┌────┴─────────────┐
 crha (WSS, dials out)  SSH
   │
 crha privileged mode (no network; runs only authorized tasks)
```

Every action, whether from a session, a schedule, the WebUI or an MCP client, becomes a task through one
API, so none of them can bypass the checks. See [Architecture](doc/design/architecture.md).

## Getting started

This gets crhs and a first node running on one glibc Linux host (amd64 or arm64), with no domain or TLS
yet; the agent helps with the rest. You can give these steps to an AI or coding agent and ask it to
help. [Install](doc/guide/install.md) has more details and options, and [Concepts](doc/guide/concepts.md)
the vocabulary: nodes, tasks, rules, approvals and privilege.

1. Connect to the host over SSH with a port forward, and keep it open:

   ```sh
   ssh -L 8080:127.0.0.1:8080 you@host
   ```

2. Install Docker (Podman works the same) and choose the database. PostgreSQL is recommended: SQLite
   searches only session titles, and there is no migration between the two later
   ([SQLite and PostgreSQL](doc/guide/operations.md#sqlite-and-postgresql)).
3. Write `/srv/crhs/init.json` and start crhs. It listens on `127.0.0.1:8080` of the host, so only the
   SSH forward reaches it; leave `public_url` empty for now.

   ```json
   {
     "version": 1,
     "listen": { "host": "127.0.0.1", "port": 8080 },
     "database": { "driver": "postgres", "url": "postgres://crh:secret@127.0.0.1/crh" },
     "public_url": "",
     "admin": { "username": "admin", "display_name": "Admin", "password": "change-me" },
     "service": { "install": false }
   }
   ```

   Depending on how your database is installed, crhs in the container may reach it over the network or a
   Unix socket; if you are unsure, give this document and your setup to an AI or coding agent for help.

   ```sh
   sudo install -d -o 1000 -g 1000 -m 0700 /srv/crhs
   sudoedit /srv/crhs/init.json
   sudo chown 1000:1000 /srv/crhs/init.json && sudo chmod 600 /srv/crhs/init.json
   sudo docker run -d --name crhs --restart unless-stopped --network host \
     -v /srv/crhs:/crhs-data ghcr.io/kodecable/crhs:<version>
   ```

   The first start initializes from `init.json`; delete it afterwards, as it holds the password.
4. Open the WebUI at <http://localhost:8080> on your own computer, through the forward. Sign in, add a
   model provider and try a conversation.
5. In **Nodes** → **New node**, copy the token. On the same host, install crha from its release archive
   and enroll it:

   ```sh
   tar -xzf crha-<version>-linux-<arch>.tar.gz && cd crha-<version>-linux-<arch>
   sudo ./install.sh   # runs sudo crha enroll
   ```

   Answer `http://127.0.0.1:8080` and the token, choose the `forward` privileged mode, let local root
   open the local approval window, and leave the trust entries empty. A privileged task then waits until
   you run `sudo crha approve --for 10m` on the host; `sudo crha lock` closes the window early.
6. Approve the node in **Nodes** after comparing the key fingerprint that enroll printed.
7. From here on, ask in a WebUI session for any deployment or change: setting up a domain, TLS and
   `public_url`, registering a Passkey and adding it to the node's trust configuration, moving to Docker
   Compose, enrolling other machines, and so on. Other crha nodes connect from other machines, so they need the domain and TLS
   first; SSH nodes do not. When the agent needs a privileged task, open a short local window as above.
   For example:

   > Check the state of the nodes and of crhs. Read the crhs documentation, then ask me what I want to
   > set up next: a domain and TLS, Passkey signing and the node trust configuration, Docker Compose, or
   > more machines. Propose a plan and wait for my confirmation before changing anything. Tell me when a
   > privileged task needs the local approval window.
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
| [crhs configuration](doc/guide/reference/crhs-config.md)             | `crhs.toml` and system settings                     |
| [crha configuration](doc/guide/reference/crha-config.md)             | `crha.toml`                                         |
| [Privileged configuration](doc/guide/reference/privileged-config.md) | `privileged.toml`                                   |
| [Command line](doc/guide/reference/cli.md)                           | `crhs`, `crha` and `crhu` commands                  |

**Design**

| Document                                                   | Covers                                         |
| ---------------------------------------------------------- | ---------------------------------------------- |
| [Architecture](doc/design/architecture.md)                 | Components, boundaries, limitations            |
| [Compatibility](doc/design/compatibility.md)               | What a release keeps for earlier deployments   |
| [Protocol](doc/design/protocol.md)                         | The crhs–crha protocol and transport security  |
| [Execution plane](doc/design/execution.md)                 | Tasks, output, connections, SSH                |
| [Privilege and authorization](doc/design/privilege.md)     | Privilege modes, authorizations, node trust    |
| [Users, ownership and audit](doc/design/access-control.md) | Users, access, rules, approvals, audit         |
| [Agent runtime](doc/design/agent-runtime.md)               | Sessions, tools, subagents, quotas             |
| [Jobs](doc/design/jobs.md)                                 | Background work, job tools, completion notices |
| [Terminals](doc/design/pty.md)                             | Interactive terminals on crha nodes            |
| [Metrics](doc/design/metrics.md)                           | Host metrics, their storage and charts         |
| [Libraries and file transfer](doc/design/library.md)       | Libraries, file plane, attachments             |
| [Scheduled tasks](doc/design/scheduling.md)                | Schedules                                      |
| [Data model](doc/design/data-model.md)                     | Storage and retention                          |
| [WebUI](doc/design/webui.md)                               | Frontend design                                |
| [Distribution and setup](doc/design/distribution.md)       | Packages, `crhs init`, `crha enroll`           |
| [Testing](doc/design/testing/README.md)                    | Test layers and how to run them                |

## Repository layout

| Path        | Contents                                                       |
| ----------- | -------------------------------------------------------------- |
| `server/`   | crhs (TypeScript, Node.js)                                     |
| `web/`      | The WebUI (React)                                              |
| `client/`   | crha and crhu (Go)                                             |
| `packages/` | Shared TypeScript packages: API types, the CRH protocol, Noise |
| `doc/`      | The guide and the design documents                             |

## License

MIT; see [LICENSE](LICENSE).
