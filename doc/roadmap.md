# 里程碑

排序原则：先做执行平面和 MCP，因为它们不依赖 agent 运行时，做完就能配合 Claude Code、Codex 使用；然后再做 agent 层。

## M0 骨架

- 仓库结构：`server/`、`web/`、`client/`（M0 时含 `proto/`；M3.5 删除）。
- Kysely + 迁移（SQLite 和 PG），CI 中两种数据库都跑。
- 用户（管理员 / 普通用户）、用户组、登录（本地密码）、节点与会话的归属和分享。
- `crhs keys export` / `import`（age 口令加密）。
- LICENSE（MIT）。
- （历史）最初用 buf 生成 Go 和 TS protobuf 协议代码；M3.5 计划改为 CBOR，见下文。

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

## M3 Agent 运行时（已完成，见下文"进度"）

- `SqlStorage` 实现，官方一致性测试在 SQLite 和 PG 上通过。
- `AgentRuntime` 接口与 durable 实现；cluster 工具适配；exec 的 `replay: "safe"` 与重新挂接。
- 会话管理、WebUI 聊天（流式）、模型配置。
- 配额（会话上的有符号 token 余量，响应后扣减，全部 > 0 才继续）。
- 审批沿会话链向上传递；配额不足时暂停工具调用，只向直接父会话报告，由它的 agent 增加或拒绝。
- 节点笔记（节点上的文件；`node_info` 自动返回）。
- 性能回归测试与故障注入测试（见 [agent-runtime.md](agent-runtime.md#测试策略)）。

**完成标志**：在 WebUI 中通过会话管理多台节点；服务端在工具执行中途重启后，会话能继续，结果正确。已完成（2026-10-27）：真实模型冒烟与浏览器走查手工执行，其余有自动化测试。

## M3.5 协议重构：protobuf → CBOR（计划中）

- 完整替换 crhs ↔ crha 的 protobuf 协议；Web API、数据库和 WebUI 继续使用 JSON。
- 不保证旧协议兼容：握手协商协议版本，版本不匹配直接拒绝；开发期内没有滚动升级负担。
- 版本协商只在握手完成；握手决定协议大版本、小版本和双方支持的命令后，后续帧不再携带单独的 `v` 字段。
- 消息抽象为“命令 → 响应”加“客户端推送”：
  - 命令和响应有稳定的命令名与固定结构；
  - 推送事件只有事件名和固定结构；
  - 大版本内不修改已有命令/响应的结构；小版本通过新增 `foo.v2` 之类的命令替换，旧命令保留到下一个大版本。
- 命令 body 使用该命令定义的固定类型（数组/元组/结构），不为兼容性塞可选 map 字段。
- 授权 payload 和任务规格哈希使用确定性 CBOR；SSHSIG/WebAuthn 签同一份 CBOR bytes，不再使用 JCS。
- 删除 `proto/`、buf、`@bufbuild/protobuf`、Go protobuf 生成代码和 CI 的 `gen:proto`；`packages/protocol` 改为手写的 TS 类型/CBOR codec，Go 侧同步手写类型，并用 golden vector 交叉验证。
- 批量执行输出改为两档：
  - `status`（批量默认）：只返回状态，完整输出留在节点文件；
  - `text`：每节点最多 8KB/128 行，所有节点共享单任务总预算，按输出到达顺序丢弃，完整输出仍留在节点；
  - SSH 不保留完整输出，遵守其余规则。
- 现有 M1/M3 的传输、任务、断线恢复、SSH 和 e2e 测试全部在 CBOR 上重跑。

**完成标志**：删掉 protobuf 后所有 M1/M3 功能、e2e、故障注入和批量输出预算测试通过；协议无旧兼容路径。

## M4 提权（计划中，见 [m4.md](m4.md)）

- `native` 模式（sudo/doas/run0）。
- crha 特权模式：unix socket、`SO_PEERCRED`、信任数组、目标字符串规范化与防护规则、授权与联署校验、一次性授权（已用列表）、吊销、本地日志。
- crhs 缓存 crha 的 `TrustSummary` 和 digest（连接时查询、变化时推送）；crhs 从自己的缓存计算授权方案，不再依赖 `Preflight`。
- 只为会话所有者（`on_behalf_of_user_id`）计算 user 信任项和凭据；crhs 用 RE2（`re2`）匹配规则，crha 执行前仍完整复验。
- 授权和联署是同一个 CBOR payload 上的多个签名，不再使用 `cosign_of`。
- crhs 授权签名（SSHSIG，支持 ssh-agent）；auto review。
- 用户授权：`crha grant` 签发 SSHSIG；WebUI 用 Passkey 签发；`crha approve` 本地批准。
- WebUI 可以导出可粘贴进 `privileged.toml` 的 trust 片段。
- SSH 节点不参与提权：`privileged` 被忽略，按 SSH 用户执行并在输出中提示；保留现有 SFTP `file.*` 任务。

**完成标志**：同一节点可以分别配置为“信任服务端”和“只信任用户”，两条路径都能跑通，且在“只信任用户”时服务端无法提权（有专门的测试）；SSH 忽略特权且不破坏 file 任务。

## M5 计划任务与 subagent

- 调度器（触发与提交分两步，启动时恢复 `pending`）、`command` 和 `agent` 两类计划任务、为计划任务签发授权。
- subagent：独立会话，规则和配额挂在父会话的操作者链下；前台等待可以被打断并自动转入后台，父会话处理请求后再显式等待；其他工具返回时自动提示待处理的子会话。
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
- **M3**：已完成（2026-10-27）。
  - durable 运行时（SQLite 官方存储、PostgreSQL `PgStorage`，均通过官方一致性测试）；会话与 cluster 工具（`replay: "safe"`，重启后重新挂接）；模型配置（内置 provider、OpenAI 兼容端点、额外请求头）；WebUI 会话页（SSE 流式）与模型设置；配额与子会话状态（根不扣减，D72、D76、D77）；subagent（前台/后台、`subagent_wait` / `list` / `cancel` / `decide`，父会话 agent 处理子会话审批，D75）；Auto Review；节点笔记；会话分享（view / chat）；停止会话时取消其任务和子会话；存储失败后重新打开 Harness；故障注入（工具执行中 SIGKILL、模型流式输出中 SIGKILL）与性能回归测试。
  - 真实模型冒烟（opencode zen `deepseek-v4.1-flash`）与 WebUI 浏览器走查手工完成，不在 CI 中。
  - 配额只管理 subagent，根会话固定 0 且不扣减；不足时暂停工具调用并只向直接父请求；durable 1.4.0 没有请求前的拦截点，检查发生在响应之后（D72）。
- **M3.5**：计划中，未开始。完整替换 crhs ↔ crha 的 protobuf 为 CBOR，版本在握手协商，命令→响应 + 客户端推送，删除 protobuf/buf/生成代码；Web API/数据库 JSON 不变。详见 [m4.md](m4.md) 和 [execution-plane.md](execution-plane.md#自有协议m35)。
- **M4**：计划中，未开始。细节、阶段和测试矩阵见 [m4.md](m4.md)。
