# ClusterRightHand

[English](README.md) | **简体中文**

ClusterRightHand（CRH）是一个自托管的多节点 Agent 平台，带有严格 Agent 规则，特权信任授权和审计功能。

![桌面上的 Agent 会话，以及在手机上用 Passkey 为 db-1 的特权命令签名](doc/images/hero.zh-CN.png)

## 特性

**核心功能**

- **原生多节点的 Agent Runtime。** 节点和节点组是 Agent 工具的直接参数，一次调用即可在整组节点上执行命令或操作文件，并按节点返回结果。
- **规则、审批与审计。** Agent 发起的每个任务先经规则判定为放行、拒绝或待审批，所有任务均记入审计。
- **特权由节点决定。** 节点可要求特权任务持有用户的 SSH 密钥或 Passkey 签名，或经本地批准；良好的配置下，中心服务器被攻破也无法单独取得 root。
- **两种接入方式。** 安装主动连接的 `crha` 客户端，或直接通过 SSH 接入，节点上无需任何 CRH 组件。
- **管理 CRH 自身，兼作 MCP 服务器。** Agent 可依据文档调用 crhs 的 API；Claude Code、Codex 等 MCP 客户端可接入使用同一套集群工具，并受相同约束。

**辅助功能**

- **交互式终端。** 在 WebUI 中打开 crha 节点上的终端，人与 Agent 可共用同一终端。
- **主机指标。** crhs 直接从节点采集 CPU、内存、磁盘和网络等指标，无需另装监控代理。
- **聊天渠道。** 通过 Telegram 或 Satori 在聊天应用中使用会话、处理审批。
- **计划任务。** 按 cron 表达式定时启动会话，执行预设的提示词。
- **部署简便。** 单个 Node.js 进程，数据存储于 SQLite 或 PostgreSQL。

| 节点指标                                                                                  | 节点信任                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ![db-1 的指标：近一小时的 CPU、负载、内存、磁盘和网络](doc/images/node-metrics.zh-CN.png) | ![db-1 只信任 admin 的 SSH key、Passkey 和本机 root](doc/images/node-trust.zh-CN.png) |

## 工作方式

```text
 WebUI · MCP 客户端
        │
      crhs ── Agent 会话、调度器、规则、审批、签名、审计
        │
   ┌────┴─────────────┐
 crha（WSS，主动连接）  SSH
   │
 crha 特权模式（无网络，只执行已授权的任务）
```

无论来自会话、计划任务、WebUI 还是 MCP 客户端，每个操作都通过同一个 API 变成任务，任何入口都绕不过这些检查。详见
[Architecture](doc/design/architecture.md)。

## 快速开始

以下步骤在一台 glibc Linux 主机（amd64 或 arm64）上跑起 crhs 和第一个节点，暂不需要域名和 TLS，其余工作交给 Agent。您可以把本文档步骤发给 AI 或 Coding Agent，请它协助完成；更多细节/选项见 [Install](doc/guide/install.md)，节点、任务、规则、审批和特权这些概念见 [Concepts](doc/guide/concepts.md)。

1. 通过 SSH 连接主机，并保持一个端口转发：

   ```sh
   ssh -L 8080:127.0.0.1:8080 you@host
   ```

2. 安装 Docker（Podman 用法相同），并选择数据库。推荐 PostgreSQL：SQLite 只能搜索会话标题，且两者之后无法互相迁移（[SQLite and PostgreSQL](doc/guide/operations.md#sqlite-and-postgresql)）。
3. 写好 `/srv/crhs/init.json` 并启动 crhs。它监听主机的 `127.0.0.1:8080`，只能经 SSH 转发访问；`public_url` 暂时留空。

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

   依据您的数据库安装方式，您可能需要通过网络或 Unix socket 来让容器内的 crhs 访问数据库，如果不确定，您可以将本文档和您的情况提供给 AI 或 Coding Agent 寻求帮助/建议。

   ```sh
   sudo install -d -o 1000 -g 1000 -m 0700 /srv/crhs
   sudoedit /srv/crhs/init.json
   sudo chown 1000:1000 /srv/crhs/init.json && sudo chmod 600 /srv/crhs/init.json
   sudo docker run -d --name crhs --restart unless-stopped --network host \
     -v /srv/crhs:/crhs-data ghcr.io/kodecable/crhs:<version>
   ```

   首次启动时按 `init.json` 初始化；之后删除该文件，它含有管理员密码。
4. 在你自己的电脑上经转发打开 <http://localhost:8080> WebUI，登录，添加模型提供方并试着对话。
5. 在 **节点** → **新建节点** 中复制令牌。在同一台主机上用发布包安装 crha 并注册：

   ```sh
   tar -xzf crha-<version>-linux-<arch>.tar.gz && cd crha-<version>-linux-<arch>
   sudo ./install.sh   # 会运行 sudo crha enroll
   ```

   地址填 `http://127.0.0.1:8080` 并粘贴令牌，特权模式选 `forward`，允许本机 root 打开本地批准窗口，信任条目留空。之后特权任务会等待，直到你在主机上运行 `sudo crha approve --for 10m`；`sudo crha lock` 可提前关闭窗口。
6. 核对 enroll 打印的密钥指纹后，在 **节点** 中批准该节点。
7. 此后的部署和修改都可以直接在 WebUI 会话中询问：配置域名、TLS 和 `public_url`，注册 Passkey 并加入节点的信任配置，改用 Docker Compose，引入其他机器，等等。其他 crha 节点从别的机器连接，需要先配好域名和 TLS；SSH 节点不需要。需要特权任务时，按上面的方法临时打开本地窗口。示例提示词：

   > 检查各节点和 crhs 的状态。阅读 crhs 的文档，然后问我接下来想配置什么：域名和 TLS、Passkey 签名与节点信任配置、Docker Compose，或引入更多机器。先给出方案，等我确认后再动手。需要本地批准窗口的特权任务请提前告诉我。
## 文档

**使用指南**

| 页面                                                                 | 内容                               |
| -------------------------------------------------------------------- | ---------------------------------- |
| [Concepts](doc/guide/concepts.md)                                    | 节点、任务、会话、规则、审批、特权 |
| [Install](doc/guide/install.md)                                      | 安装 crhs、节点和模型              |
| [Using the WebUI](doc/guide/webui.md)                                | 控制台导览                         |
| [MCP server](doc/guide/mcp.md)                                       | 接入外部编程 Agent                 |
| [Security](doc/guide/security.md)                                    | 信任、特权模式、加固               |
| [Operations](doc/guide/operations.md)                                | 升级、备份、日志、故障排查         |
| [crhs configuration](doc/guide/reference/crhs-config.md)             | `crhs.toml` 和系统设置             |
| [crha configuration](doc/guide/reference/crha-config.md)             | `crha.toml`                        |
| [Privileged configuration](doc/guide/reference/privileged-config.md) | `privileged.toml`                  |
| [Command line](doc/guide/reference/cli.md)                           | `crhs` 和 `crha` 命令              |

**设计文档**

| 文档                                                       | 内容                                 |
| ---------------------------------------------------------- | ------------------------------------ |
| [Architecture](doc/design/architecture.md)                 | 组件、边界、限制                     |
| [Compatibility](doc/design/compatibility.md)               | 发布版本之间的兼容承诺               |
| [Protocol](doc/design/protocol.md)                         | crhs 与 crha 的协议和传输安全        |
| [Execution plane](doc/design/execution.md)                 | 任务、输出、连接、SSH                |
| [Privilege and authorization](doc/design/privilege.md)     | 特权模式、授权、节点信任             |
| [Users, ownership and audit](doc/design/access-control.md) | 用户、访问、规则、审批、审计         |
| [Agent runtime](doc/design/agent-runtime.md)               | 会话、工具、子 Agent、配额           |
| [Jobs](doc/design/jobs.md)                                 | 后台工作、job 工具、完成通知         |
| [Terminals](doc/design/pty.md)                             | crha 节点上的交互式终端              |
| [Metrics](doc/design/metrics.md)                           | 主机指标、存储和图表                 |
| [Scheduled tasks](doc/design/scheduling.md)                | 计划任务                             |
| [Data model](doc/design/data-model.md)                     | 存储和数据保留                       |
| [WebUI](doc/design/webui.md)                               | 前端设计                             |
| [Distribution and setup](doc/design/distribution.md)       | 打包分发、`crhs init`、`crha enroll` |
| [Testing](doc/design/testing/README.md)                    | 测试分层和运行方法                   |

## 仓库结构

| 路径        | 内容                                            |
| ----------- | ----------------------------------------------- |
| `server/`   | crhs（TypeScript，Node.js）                     |
| `web/`      | WebUI（React）                                  |
| `client/`   | crha（Go）                                      |
| `packages/` | 共享的 TypeScript 包：API 类型、CRH 协议、Noise |
| `doc/`      | 使用指南和设计文档                              |

## 许可证

MIT，见 [LICENSE](LICENSE)。
