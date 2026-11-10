# ClusterRightHand 设计文档

ClusterRightHand（下称 CRH）是一个用于管理 VPS 集群的 agent 平台：服务端运行多会话 agent loop，把指令下发给各节点上的客户端执行；同时也可以不用内置 agent，直接作为 MCP 服务器把节点集群暴露给任意 coding agent。

> 状态：设计阶段，尚未开始实现。本目录记录已对齐的需求与设计决策。
>
> 仓库：<https://github.com/Kodecable/ClusterRightHand>。许可证：MIT，版权人为 "The ClusterRightHand authors"。

## 文档索引

| 文档 | 内容 |
|---|---|
| [design/architecture.md](design/architecture.md) | 总体架构、组件与职责、技术栈、仓库结构、端到端流程、扩展预留与已知限制 |
| [design/protocol.md](design/protocol.md) | crhs ↔ crha 协议的线上格式：编码规则、握手载荷、帧、版本协商、命令/事件、特权消息、传输安全、JSON 存储形式、fixture |
| [design/execution.md](design/execution.md) | 执行平面：任务模型与语义、状态机、输出、客户端连接生命周期、SSH 传输、重载与升级、配置与路径 |
| [design/privilege.md](design/privilege.md) | 提权与授权：威胁模型、特权模式、方法与目标、授权、信任配置、校验流程、本地批准、crhs 侧授权 |
| [design/access-control.md](design/access-control.md) | 用户模型、节点组与命名、归属与访问授权、授权规则与审批、API token、审计、OIDC 预留 |
| [design/agent-runtime.md](design/agent-runtime.md) | Agent 运行时：pi-durable、AgentRuntime 接口、存储、模型配置、cluster 工具、会话、subagent、配额与统计 |
| [design/scheduling.md](design/scheduling.md) | 计划任务：形态、单实例、触发与提交、审计、规则与配额、提权、生命周期 |
| [design/data-model.md](design/data-model.md) | 数据模型：存储后端、命名与标识、迁移、会话内容搜索、用户/节点/任务/规则/Agent/计划任务、审计、保留期 |
| [design/webui.md](design/webui.md) | WebUI：技术栈、前端架构、页面、Markdown 渲染、后端 API、性能目标、已知限制 |
| [design/testing/README.md](design/testing/README.md) | 测试分层、环境变量、命令与 CI；各层细节见 `design/testing/` |

## 产品定位

核心特征：

1. 服务端与客户端职责明确：服务端维护 agent loop，客户端只做"接收 → 执行 → 反馈"和"提权 → 授权"两条链路，不感知 agent。
2. 客户端可以通过多种方式接入：SSH（无需安装），或者自有客户端二进制 + 独立协议（支持断线续传、反向连接）。
3. 服务端支持多个 agent 会话、会话内 subagent、计划任务、提权管理、审计。
4. 可以只作为 MCP 服务器使用，把节点集群提供给外部 coding agent。
5. 提权授权可以完全由用户掌握：节点可以配置为"服务端无法提权，只有用户签名才能提权"。

与同类产品的区别：

| 产品 | CRH 的区别 |
|---|---|
| Cenvero Fleet | 通过 MCP 暴露给任意 coding agent；内置多会话 agent loop |
| kagent | 不是 k8s 原生，不要求 k8s |
| InfiniShell / SSH MCP Server / Cloudssh | 有独立客户端，支持断线续传和反向连接；有独立服务端，支持持续运行和计划任务 |
| Hermes Agent / OpenClaw / nanobot | 多机管理是原生功能；agent loop 是多会话而非 claw-like |
| codex / claude / AionUI / Hope Agent | 多机管理是原生功能 |
| OpenHands | agent loop 在服务端执行；客户端不在临时 docker 中运行 |
| nuomiiiii/lite | 内置多会话 agent loop |
| ServerManager.ai | 目标对标对象，希望成为其开源替代 |
