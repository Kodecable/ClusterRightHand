# 总体架构

## 组件

```
   WebUI (React)              外部 coding agent (Claude Code / Codex …)
        │ HTTP + WebSocket                  │ MCP (Streamable HTTP)
┌───────┴───────────────────────────────────┴──────────────────┐
│ crhs  (Node.js)                                         │
│                                                               │
│  门面层   WebUI API · MCP 门面                                 │
│  Agent 层 AgentRuntime(pi-durable) · 会话 · subagent           │
│  调度     计划任务调度器                                       │
│  ──────────────── Cluster API（唯一的执行入口）─────────────── │
│  Cluster 核心  节点注册 · 任务管理 · 策略/审批 · 授权签发 · 审计│
│  传输适配   ClientTransport(自有协议) · SshTransport            │
│                                                               │
│  存储  Kysely → SQLite | PostgreSQL（业务表 + pi_* durable 表） │
└──────────┬──────────────────────────────────┬────────────────┘
   自有协议 / WSS（客户端主动连入）         SSH
           │                                  │
   crha 非特权模式 ──unix socket── crha 特权模式（不联网）
```

### 分层原则

- **Cluster API 是唯一的执行入口。** WebUI 里的手动操作、Agent 工具调用、MCP 调用、计划任务，最终都调用 Cluster API 创建任务。策略检查、审批、授权签发和审计全部在 Cluster 核心中完成，调用方无法绕过。
- **执行平面不感知 agent。** 客户端只认识任务 id；任务的"来源"（哪个会话、哪个用户、哪个计划任务）只记录在服务端。
- **Agent 层可替换。** pi-durable 隔离在 `AgentRuntime` 接口之后；Cluster 核心和门面层不直接依赖 pi 的任何类型。

### 组件职责

| 组件 | 职责 |
|---|---|
| WebUI API | 用户登录、会话聊天（流式）、节点管理、审批、计划任务、审计查询 |
| MCP 门面 | 把 cluster 工具暴露为 MCP 工具，使用 API token 鉴权，见 [mcp.md](mcp.md) |
| AgentRuntime | 会话生命周期、agent loop、subagent、上下文压缩，见 [agent-runtime.md](agent-runtime.md) |
| 计划任务调度器 | 按时间表用固定消息新建会话，见 [scheduling.md](scheduling.md) |
| Cluster 核心 | 节点注册与状态、任务状态机与输出存储、策略引擎、审批流、服务端签名、审计 |
| ClientTransport | 维护与 crha 的连接，实现自有协议，见 [execution-plane.md](execution-plane.md) |
| SshTransport | 通过 SSH 执行任务，对上层提供同样的任务接口 |
| crha 非特权模式 | 节点守护进程：主动连接 crhs，执行普通任务；特权任务按配置转给特权模式、用 sudo 执行、直接执行或拒绝 |
| crha 特权模式 | 只监听本地 unix socket，校验授权后执行特权任务；通常以 root 运行，但模式与 Linux 身份无关，见 [privilege.md](privilege.md) |
| crha 用户子命令 | `crha grant`（在用户工作站上签发授权）、`crha approve`/`crha pending`（在节点上本地批准） |

## 技术栈

| 部分 | 选型 |
|---|---|
| 服务端 | Node.js（≥ 22.19，pi 的最低要求）、TypeScript |
| 数据库访问 | Kysely；方言为 SQLite（node:sqlite 或 better-sqlite3）和 PostgreSQL（pg） |
| Agent | `@earendil-works/pi-durable`、`@earendil-works/pi-ai`（锁定精确版本） |
| WebUI | React |
| 客户端 | Go，单一静态二进制，交叉编译 linux/amd64、linux/arm64；命令行用 cobra；模块路径 `github.com/Kodecable/ClusterRightHand/client` |
| 发布 | 自己写 bash 脚本完成交叉编译、打包（deb/rpm 用 nfpm 之类的单一工具，或直接脚本）、校验和与签名；不使用 goreleaser |
| 协议 | CBOR（M3.5；完整替换原 protobuf），双向命令/事件；TS/Go 手写类型和 codec，golden vector 交叉验证 |
| SSH（服务端侧） | `ssh2`（Node） |

## 仓库结构

```
ClusterRightHand/
├── doc/                设计文档
├── packages/
│   ├── protocol/       @crh/protocol：CBOR 协议类型、codec 和 golden vectors
│   └── noise/          @crh/noise：Noise IK 的 TS 实现
├── server/             @crh/server：crhs
│   ├── src/cluster/        Cluster 核心、传输适配
│   ├── src/agent/          AgentRuntime 接口与 durable 实现、cluster 工具
│   ├── src/storage/        Kysely 封装（含 node:sqlite 适配）、迁移、durable SqlStorage
│   ├── src/api/            WebUI API、MCP 门面
│   └── src/scheduler/
├── web/                @crh/web：WebUI（Vite + React）
├── client/             Go 模块 github.com/Kodecable/ClusterRightHand/client
│   ├── cmd/crha/           单一二进制（cobra）
│   └── internal/           cli、config、transport、noise、executor、privileged、protocol（CBOR）
└── scripts/            发布等 bash 脚本
```

- TS 部分是一个 pnpm workspace，Node 直接运行 `.ts`（类型剥离），`tsc --noEmit` 只做类型检查；lint 与格式化用 Biome，测试用 Vitest。
- M3.5 后不再有 protobuf/buf/生成代码；CBOR 类型和 codec 手写，golden vector 提交进仓库，CI 运行双端一致性测试。
- 根目录命令：`pnpm check`（Biome、tsc、gofmt、go vet）、`pnpm test`（Vitest、go test；设置 `CRH_TEST_PG_URL` 时同时测试 PostgreSQL）。

## 关键流程：agent 执行一条特权命令

1. 会话中的模型调用 `exec(node="web-1", cmd="systemctl restart nginx", privileged=true)`。
2. 工具处理函数调用 Cluster API 创建任务，Cluster 核心记录来源（会话 S，代表用户 U）。
3. 策略引擎判断：U 能否访问 web-1（自己的节点，或被分享了 `operate`）；再沿规则链（根会话 S → …）逐级判定授权规则，结果为 allow / deny / require-approval。
4. 根据 web-1 的非特权模式如何处理特权任务（`[privileged].mode`）决定授权路径：
   - `native` / `ignore`：只需要 crhs 策略放行；`reject`：直接拒绝；
   - `forward`：crhs 从缓存的特权模式 `TrustSummary` 计算授权方案——
     - crhs 信任项可以单独授权：auto review 通过后，crhs 签发单条命令授权；
     - 只有所有者的用户信任项可以：使用该所有者已签发的有效授权，或者等待 Passkey / SSH key 签名或本地批准；要求联署时，crhs 在同一 payload 上追加签名；
     - 只用 `on_behalf_of_user_id`，不考虑共享用户或其他管理员。
5. 任务连同授权下发给 crha 非特权模式 → 转给特权模式校验 → 执行 → 输出经非特权模式流式返回 → crhs 按单任务/批量输出模式保存或只留文件路径。SSH 节点忽略特权标志，按 SSH 用户执行并在输出中提示。
6. 审计记录：crhs 写入 Cluster 审计表（哈希链）；特权模式写入节点本地日志。

## 扩展预留：监控、告警、仪表盘

暂不实现，但现有设计不能阻塞它们：

- **协议**：消息用固定结构的 CBOR 命令/事件承载；新功能用新命令（例如 `metrics.batch`），旧命令不原地改结构。握手协商双方支持的命令集合。
- **采集**：crha 内部按"采集器"组织（v1 只有 `Facts`），以后加入周期性指标采集时不需要改执行链路。
- **存储**：指标不放进业务表；以后通过独立的存储接口接入时序库（或 PG/SQLite 中的降采样表），不影响现有数据模型。
- **告警**：Cluster 核心内部的事件（节点上下线、任务结束、审批）统一经过一个事件总线发出；告警规则、通知和"告警触发 agent 会话"以后都作为它的订阅者实现。
