# 里程碑

排序原则：先做执行平面和 MCP，因为它们不依赖 agent 运行时，做完就能配合 Claude Code、Codex 使用；然后再做 agent 层。

## M0 骨架

- 仓库结构：`proto/`、`server/`、`web/`、`client/`。
- Kysely + 迁移（SQLite 和 PG），CI 中两种数据库都跑。
- 用户（管理员 / 普通用户）、用户组、登录（本地密码）、节点与会话的归属和分享。
- `crhs keys export` / `import`（age 口令加密）。
- LICENSE（MIT）。
- buf 生成 Go 和 TS 协议代码。

## M1 执行平面（已完成，见下文"进度"）

- crha：注册（含所有者或管理员确认）、WSS + Noise 通道、`exec` 和文件操作、输出缓冲、断线续传。
- Noise 的 TS 实现：官方测试向量 + 与 Go 实现的交叉测试。
- 服务端：ClientTransport、任务状态机、任务组（批量执行）、输出头尾存储、`unknown` 语义；节点组缓存。
- crha 输出文件：超过阈值时写入节点上的文件，断线续传从文件补发，按配置清理。
- SshTransport：exec channel、SFTP、主机密钥固定、取消、跳板机。
- crha 的 reload；升级与改配置走特权任务（M4 之前可以用 `ignore` 方式验证）。
- WebUI：节点列表，手动执行任务并查看输出。
- 测试：Go 单元测试；协议集成测试；网络故障注入（用 toxiproxy 模拟断线、延迟、半开连接）；客户端重启后任务变为 `unknown` 的场景。

**完成标志**：可以在 WebUI 中对自有客户端节点和 SSH 节点执行命令；拔网线再恢复后，输出完整续传。

## M2 MCP + 审计（已完成，见下文"进度"）

- ToolCatalog 与 MCP 门面（Streamable HTTP）。
- API token。
- 审计表（哈希链），审计查询页面。
- 授权规则（规则链从根会话 / 计划任务 / API token 开始，根的选项 Ask / Yolo 映射为规则；allow / deny / require-approval），审批结果保存在任务上，WebUI 中审批。

**完成标志**：Claude Code 通过 MCP 管理节点，所有操作都能在审计中查到。

## M3 Agent 运行时

- `SqlStorage` 实现，官方一致性测试在 SQLite 和 PG 上通过。
- `AgentRuntime` 接口与 durable 实现；cluster 工具适配；exec 的 `replay: "safe"` 与重新挂接。
- 会话管理、WebUI 聊天（流式）、模型配置。
- 预算（规则的一部分，不足时向上反馈）。
- 审批和追加预算沿会话链向上传递。
- 节点笔记（节点上的文件；`node_info` 自动返回）。
- 性能回归测试与故障注入测试（见 [agent-runtime.md](agent-runtime.md#测试策略)）。

**完成标志**：在 WebUI 中通过会话管理多台节点；服务端在工具执行中途重启后，会话能继续，结果正确。

## M4 提权

- `native` 模式（sudo/doas/run0）。
- crha 特权模式：unix socket、`SO_PEERCRED`、信任数组、目标字符串规范化与防护规则、授权与联署校验、一次性授权（已用列表）、吊销、本地日志。
- `TrustSummary` 与 `Preflight` 查询；crhs 按 preflight 选择授权路径。
- crhs 授权签名（SSHSIG，支持 ssh-agent）；auto review。
- 用户授权：`crha grant` 签发 SSHSIG；WebUI 用 Passkey 签发；`crha approve` 本地批准。

**完成标志**：同一节点可以分别配置为"信任服务端"和"只信任用户"，两条路径都能跑通，且在"只信任用户"时服务端无法提权（有专门的测试）。

## M5 计划任务与 subagent

- 调度器（触发与提交分两步，启动时恢复 `pending`）、`command` 和 `agent` 两类计划任务、为计划任务签发授权。
- subagent：独立会话，规则和预算挂在父会话的操作者链下；前台等待可以被打断并自动转入后台，父会话处理请求后再显式等待；其他工具返回时自动提示待处理的子会话。
- 通知（webhook）。

## M6 完善

- 服务端主动连接客户端的传输方式。
- PTY 与 WebUI 终端。
- 打包（bash 脚本）：deb/rpm、systemd unit（crha 非特权模式和特权模式分开）、客户端自升级。
- MCP 的"委托给会话"工具。
- 监控、告警、仪表盘：暂不安排，见 architecture.md 的"扩展预留"。

## 进度

- **M0**：完成。
- **M1**：完成。
  - crha：注册、WSS + Noise、exec 与文件任务、输出落盘与清理、断线续传、reload。
  - crhs：任务状态机与 `unknown` 语义、任务组、SSH（含跳板机）、WebUI 第一版。
  - 自动化测试：Go/TS 单元测试（SQLite + PG）、Noise 互操作 fixture、真实 crha 二进制的 e2e 套件、SSH/SFTP 测试（需要测试 sshd）。
  - 未完成：
    - `crha upgrade --apply` 留到 M4（升级本身是特权任务）；
    - toxiproxy 网络故障注入改用 e2e 中的 SIGSTOP / 杀进程 / 重启场景覆盖；
    - CI 中尚未跑 SSH 测试（需要 sshd 服务容器）。
- **M2**：完成（Claude Code 实机接入待验证）。
  - 授权规则引擎（规则链、Ask / Auto Review / Yolo 映射、逐级收紧；`exact` / `prefix`，无 `regex`，见 D66）。
  - 审批：`awaiting_approval` / `denied`，结果保存在任务和任务组上，规则变化后重新判定，不设期限，token 吊销时拒绝它的等待项；WebUI 审批页（含"以后都允许"）。
  - 审计：哈希链、查询与整链校验，覆盖认证、用户、节点、分享、SSH、任务、审批、规则、token、MCP 工具调用。
  - API token 与 `/mcp`（官方 SDK v2，无状态）；ToolCatalog（zod）供 M3 复用。
  - 测试：规则引擎、审计链、token、审批 API、审计事件；MCP e2e（MCP 客户端 + 真实 crha）；WebUI 浏览器测试（token、审批、审计）。
  - 未完成：Auto Review（需要模型，M3）；审计链头外送（后续）。
