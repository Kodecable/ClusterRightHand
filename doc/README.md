# ClusterRightHand 设计文档

ClusterRightHand（下称 CRH）是一个用于管理 VPS 集群的 agent 平台：服务端运行多会话 agent loop，把指令下发给各节点上的客户端执行；同时也可以不用内置 agent，直接作为 MCP 服务器把节点集群暴露给任意 coding agent。

> 状态：设计阶段，尚未开始实现。本目录记录已对齐的需求与设计决策。
>
> 仓库：<https://github.com/Kodecable/ClusterRightHand>。许可证：MIT，版权人为 "The ClusterRightHand authors"。

## 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 总体架构、组件划分、技术栈、仓库结构 |
| [execution-plane.md](execution-plane.md) | 执行平面：任务模型与语义、客户端协议、通信安全（WSS + Noise）、节点注册、SSH 传输 |
| [privilege.md](privilege.md) | 提权与授权：特权任务的四种处理方式、crha 特权模式、方法与目标、授权结构、信任数组、联署、preflight |
| [agent-runtime.md](agent-runtime.md) | Agent 运行时：pi-durable 集成、cluster 工具、会话、subagent、测试策略 |
| [access-control.md](access-control.md) | 用户模型（管理员 / 普通用户、用户组）、归属与分享、授权规则、API token、审计 |
| [scheduling.md](scheduling.md) | 计划任务 |
| [mcp.md](mcp.md) | MCP 门面 |
| [data-model.md](data-model.md) | 数据表草案 |
| [roadmap.md](roadmap.md) | 里程碑 |

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

## 决策记录

| # | 决策 | 理由 / 被否决的方案 |
|---|---|---|
| D1 | 服务端 Node.js + React，客户端 Go | Node 可直接使用 pi SDK；Go 交叉编译简单、编译快、心智负担小 |
| D2 | 数据库通过 SQL 抽象层（Kysely）同时支持 SQLite 和 PostgreSQL | 单机自用可用 SQLite，团队部署用 PG |
| D3 | Agent 运行时采用 pi-durable + pi-ai，锁定精确版本，并隔离在自有 `AgentRuntime` 接口之后 | 持久会话、崩溃恢复、subagent、工具钩子与需求对应度最高。否决 pi-coding-agent SDK：面向本地单工作目录，存储为 JSONL 文件，扩展生态无法迁移到服务端场景。否决单用 pi-agent-core：需自研持久化、压缩、subagent |
| D4 | pi-durable 使用自研存储后端，基于 D2 的 SQL 抽象层实现 | 与业务数据同库；官方只提供 SQLite/JSONL/IndexedDB 等后端，没有 PG |
| D5 | Agent 和 MCP 都只是 Cluster 核心的调用方；策略、审批、审计都在 Cluster 核心里执行 | MCP 模式不应成为绕过审计的后门 |
| D6 | 执行平面只有一种失败语义：连接中断或客户端不认识任务 id 时，任务状态为 `unknown` | SSH 与自有客户端接口统一；不重放，避免重复执行 |
| D7 | 同一个任务 id 的 `start` 最多下发一次；重连后只用 `query` 查询 | 由此保证不会重复执行；否决 boot id 方案（多余） |
| D8 | SSH 模式不上传客户端二进制 | 避免处理目标架构的分发问题；代价是 SSH 节点没有续传、反连和特权模式 |
| D9 | 提权 IPC 使用 unix socket + `SO_PEERCRED` | 零依赖；否决 D-Bus（服务器上不一定有，且无必要） |
| D10 | 每个节点的 crha 特权模式在本地配置一个信任数组，用 `role`（`crhs` / `user` / `local`）区分角色、`format`（`sshsig` / `webauthn`）区分签名格式，每项可带防护规则 | "crhs 无法单独执行特权任务"就是 crhs 信任项不含 `execute`，或者不配置 crhs 信任项 |
| D11 | 授权统一为"本体 + 可选指令限制（前缀或原文）+ 可选截止时间 + 可选任务绑定"；计划任务也用它单独签发 | crhs 的单条命令授权就是 `exact` + `task_id` + 短截止时间；任务绑定见 D50 |
| D12 | 用户模型一开始就做：单组织、多用户，表中预留 `org_id` | 当前只有一个用户，但后补的成本很高；用户类型见 D47 |
| D13 | 执行平面不加锁 | 并发冲突由 agent 和使用者自行处理；文件编辑用 `oldText` 定位，本身就能发现冲突（见 D53） |
| D14 | 优先支持 Linux | |
| D15 | v1 只做 exec 和文件操作，PTY 后置 | 先做 agent 需要的最小集合 |
| D16 | 二进制命名：`crhs`（服务端）、`crha`（客户端）。对外联网的 crha 实例称为**非特权模式**，只通过本机 socket 提供服务、执行带授权任务的实例称为**特权模式**；同一个二进制还包含用户侧子命令 | |
| D17 | 配置文件统一使用 TOML | |
| D18 | 监控、告警、仪表盘暂不实现，但设计上预留扩展点，不能被现有设计阻塞 | 见 architecture.md 的"扩展预留" |
| D19 | crhs ↔ crha 通信使用 WSS 外层 + Noise_IK 内层端到端加密 | 终结 TLS 的反代或 CDN 只能看到密文；否决只用 mTLS |
| D20 | 节点注册必须经过确认，不自动接受；由节点所有者（令牌创建者）或管理员确认 | |
| D21 | crhs 的授权签名与用户 SSH key 一样使用 SSHSIG | 特权模式只剩 SSHSIG 和 WebAuthn 两条校验路径；crhs 私钥可以交给 ssh-agent 托管 |
| D22 | 用户信任项可以要求联署（`kinds` 中加 `require-cosign`）：每次使用都必须附带 crhs 的联署，此时该 crhs 信任项除角色和 `cosign` 能力之外的限制不生效 | |
| D23 | 暂不考虑主机内威胁：特权模式没有身份密钥，socket 不加密，查询结果不签名 | 非特权模式的伪造无法让特权模式执行未授权的命令 |
| D24 | 规则判定只在特权模式里做；crhs 通过 `TrustSummary` 和 `Preflight` 查询信任配置 | 避免 JS 与 RE2 语义不一致；审批只推送给能授权的用户 |
| D25 | 信任 Passkey 即接受"crhs 被控制时 Passkey 不提供保护"，不对 Passkey 的能力单独区分 | |
| D26 | 签名信任包暂不实现，设计上预留 | 见 privilege.md 的"扩展预留" |
| D27 | `kinds`：`execute`（可以单独授权特权任务）；crhs 角色另有 `cosign`（可以联署）；user 角色另有 `require-cosign`（每次使用必须联署）。联署只能来自 crhs 角色 | 用户之间互相联署在结构上就不可能出现；crhs 的单独授权和联署是两种独立的能力 |
| D28 | crha 的特权 / 非特权模式与 Linux 用户身份解耦。非特权模式通过 `[privileged].mode` 决定如何处理特权任务：`forward`（转给特权模式）/ `native`（sudo 等）/ `ignore`（直接以自身身份执行）/ `reject` | "特权"指"需要授权才能执行"，不等于 root；非特权模式可以以 root 运行，特权模式也可以以其他用户运行 |
| D29 | 授权与防护规则只区分三种方法：`exec`、`file.read`（含 stat、list）、`file.write`（包含 read）；规则为"方法（必填）+ 可选的前缀或正则"，`allow` 和 `deny` 都必须写方法 | 只做简单过滤，不引入规则引擎；避免路径规则与命令规则互相误放行 |
| D30 | `exact` 授权同时绑定完整任务规格的哈希（env、cwd、stdin、写入内容等）；特权文件操作的路径不允许包含符号链接 | 批准"写某个文件"时，批准的是写入那一份内容；防止用符号链接绕过路径规则 |
| D31 | crhs 的授权规则沿操作者链（用户 → 会话 → 子会话 …；用户 → API token；用户 → 计划任务 → 会话）逐级收紧：用户级确定初始权限（没有命中时为 require-approval），之后每一级的有效结果 = 最严格(上一级有效结果, 本级结果)；取值为 allow / deny / require-approval（被 D62 修订） | 与 crha 的信任配置是两码事；下级的 allow 不能扩大权限。修正了早先"任一级 allow 且无人反对即放行"的算法，那会让子级扩大权限 |
| D32 | 每个 subagent 都是独立会话 | 有自己的规则和配额 |
| D33 | 原：预算是授权规则的一部分，不足时向上反馈（被 D62 修订；D76/D77 改为子会话上的配额与直接父处理） | 用量仍计入链上所有 subagent 级别；配额不再是规则的一部分，也不再向上逐级申请 |
| D34 | SSH 传输支持跳板机，每一跳分别固定主机密钥 | |
| D35 | crha 支持 reload；自更新和修改配置（包括信任配置）都是普通的特权任务 | 不需要单独的升级通道；信任配置的修改同样受信任配置约束 |
| D36 | 节点笔记是节点上的一个普通 Markdown 文件，路径可查询；`node_info` 自动返回路径和截断后的内容；读写和审计与普通文件操作相同 | |
| D37 | 需要审批时沿链向上传递：上一级对该操作为 allow 的 agent 会话可以判断（批准 / 拒绝 / 上交），否则继续向上，最终到用户（被 D62 修订） | 上一级 agent 在自己的会话中处理，见 D41 |
| D38 | 原生支持批量执行：`exec`、`read_file`、`write_file` 接受节点和组的列表，Cluster 核心以任务组管理 | |
| D39 | 节点用组组织，取代标签；组只在 crha 本地配置中定义，crhs 侧只是缓存（连接时上报、变化时推送）；特权模式本地配置的组是授权依据（发给组的授权视为发给自己） | 组成员关系以节点本地配置为准，crhs 无法绕过授权扩大授权范围；SSH 节点的组在 crhs 中维护 |
| D40 | crhs 只保存截断后的输出头尾；过长的输出由 crha 在节点上保存为普通文件并负责清理，agent 用 `read_file` 读取；SSH 节点强制截断，不保存完整输出 | 去掉 crhs 的输出存储和保留策略；断线续传可以直接从文件补发 |
| D41 | 前台 subagent 的等待可以被打断并自动转入后台，父会话处理请求后显式调用 `subagent_wait`；父会话的其他工具返回时自动提示待处理的子会话 | 父会话在自己的上下文中处理子会话的审批请求 |
| D42 | 工具和会话的默认值沿用 pi 作为 coding agent 时的默认值：输出交给模型时保留尾部 2000 行或 50KB，超过即落盘；读文件 2000 行或 50KB 分页；无默认超时；压缩与重试参数相同 | 见 agent-runtime.md 的"默认值"；落盘阈值与模型截断阈值相同，模型看到截断时一定有完整输出文件 |
| D43 | OIDC 暂不实现，设计上预留：登录方式与用户身份分开，密码可以为空，预留外部身份关联表和用户组来源字段 | 见 access-control.md 的"扩展预留：OIDC" |
| D44 | 节点和会话都明确属于一个用户，可以分享给额外的用户或用户组（节点：`view` / `operate`；会话：`view` / `chat`）；会话始终以所有者的身份行事 | 计划任务、API token 属于创建者，暂不分享 |
| D45 | 许可证：MIT | |
| D46 | crhs 提供密钥导出与导入（`crhs keys export` / `import`），导出文件为 age 口令加密，只能在本地命令行操作 | 数据库备份只含加密后的私钥，没有主密钥无法恢复 |
| D47 | 用户只有管理员和普通用户两种，不设角色和细粒度权限 | 能对节点做什么由"能否访问节点" + 操作者链上的授权规则决定 |
| D48 | 每一级规则有 `default`（`inherit` / `require-approval` / `deny`），下级可以用 `default = "deny"` + allow 写白名单（被 D62 修订） | 只能收紧，不能放宽 |
| D49 | 未知公钥只有在 IK 第一条消息的载荷中带有效注册令牌时才能完成握手；pending 节点只能建立受限连接 | 修正注册流程与"按公钥查找节点"之间的矛盾 |
| D50 | 授权可以绑定 `task_id`，成为一次性授权：特权模式先持久化已用记录再执行；crhs 签发的授权和所有联署强制绑定；用户信任项可以用 `require_task` 要求绑定 | `exact` 只约束内容，不约束次数；不绑定的授权在有效期内可重复使用是有意的（计划任务、预先签发） |
| D51 | 计划任务的触发与提交分两步：先写 `pending` 运行记录，再由执行器用稳定 id 幂等提交，启动时扫描 `pending` 恢复 | 避免"已记录但从未提交"的丢失 |
| D52 | Noise 握手防重放使用服务端挑战（WebSocket 第一帧，放入 prologue），不使用时间戳或计数器；时钟只在授权的 `issued_at` / `deadline` 检查中使用，握手时发现时钟偏差时只做警告（crha 和 crhs 日志 + WebUI） | 时间戳方案在客户端时钟回退、快照回滚时会锁死节点；挑战方案无状态、不依赖时钟，且不增加往返 |

## 暂不处理

- **发送给模型提供商的敏感数据**：命令输出、文件内容会原样进入模型上下文，暂不做脱敏或"禁止发给模型"的标记。
- **扩展机制**：crhs 作为 MCP 客户端接入外部工具、运维手册（runbook）等，暂不考虑。
- 监控、告警、仪表盘（D18）、签名信任包（D26）、OIDC（D43）：不实现，但设计上预留。

## 待定问题

- **pi-durable 版本**：会话订阅推送频率的修复目前只在 main 分支（1.4.0 之后），需要等下一个发布版再锁定。见 [agent-runtime.md](agent-runtime.md#版本与升级)。
| D53 | `edit_file` 采用 pi 的 edit 格式（`edits[]` 的 `oldText` / `newText`），由 crha 在节点上执行（新增 `file.edit`，归入 `file.write` 方法）；不使用 `expected_sha256`；`write_file` 默认只创建新文件，`overwrite` 打开后才覆盖 | `oldText` 唯一匹配本身就是冲突检测，别处的并发修改不受影响；默认不覆盖防止整文件写入误伤 |
| D54 | 服务端的执行核心层命名为 Cluster（Cluster API、Cluster 核心），与产品名统一 | 原名 Fleet |
| D55 | crha 的命令行用 cobra；发布用自己的 bash 脚本，不用 goreleaser | |
| D56 | 创建任务时节点不在线，任务直接 `failed(node_offline)`，不排队 | 任务从未下发，不属于 unknown；排队会让调用方长时间等一个可能不会上线的节点 |
| D57 | crhs 对每条 crha 连接做空闲检测（默认 90 秒无消息即断开） | crha 有义务至少每 45 秒 ping（推荐 30±5 秒），crhs 只回 pong 不主动 ping；否则挂起的客户端或半开连接永远不会触发断线宽限期（e2e 测试发现） |
| D58 | SSH 节点的凭证由 crhs 生成（ed25519），私钥用主密钥加密，只交出公钥；主机密钥逐跳探测、由用户核对后固定 | 不接收用户上传的私钥，避免私钥在别处另有副本 |
| D59 | SSH 执行不用 `setsid(1)`，依赖 sshd 已为命令新建会话：`exec` 保持 pid，pid 即进程组 id | `setsid` 在调用者已是组长时会 fork，退出码丢失（实测发现） |
| D60 | crhs 同时提供 WebUI 的静态文件（`web_root`，默认仓库内 `web/dist`），`/api`、`/agent` 之外的路径回退到 `index.html` | 单进程部署 |
| D61 | 数据库只用一个应用账号，拥有迁移、安装和运行所需的全部权限；审计哈希链只用于发现绕过 crhs 的改动 | 部署简单；只追加账号挡不住被攻破的 crhs 本身，真正的防护要靠把链头外送到另一个信任域 |
| D62 | 用户和组织没有长期规则；规则链的根是根会话、计划任务或 API token，用户为根选择 Ask / Auto Review / Yolo，映射为实际规则；子会话用完整规则配置，逐级收紧。用户在 WebUI 中本人操作只检查节点访问 | 规则是"授权给代理"的边界，用户本人不需要；简单选项给人用，细粒度规则给 subagent 用 |
| D63 | 审批结果是工具调用（任务 / 任务组）本身的状态，不单独建表；"以后都允许"才修改规则；规则变化后重新判定该链上所有等待中的任务 | 一次性的决定不是策略，写成规则会污染规则集 |
| D64 | 授权规则与特权解耦：规则不区分特权和普通任务，特权只由 crha 的信任配置决定 | 两套机制各管一件事 |
| D65 | 不提供 `crha mcp` stdio 桥 | 主流客户端都支持 HTTP；crha 部署在节点上，不在 MCP 客户端所在的机器上 |
| D66 | crhs 的授权规则只有 `exact` / `prefix`，没有 `regex` | 规则在 crhs 事件循环中执行，回溯严重的正则能卡住整个服务；规则可能由 agent 编写 |
| D67 | `allow file.write` 同时放行读；`deny` / `require-approval` 的 `file.write` 只匹配写 | 与 crha 的能力包含关系一致，又不让"禁止修改"变成"禁止查看" |
| D68 | 工具定义（ToolCatalog）使用 zod v4 schema；MCP 用官方 SDK v2 的无状态 `createMcpHandler` | SDK 直接接受 zod；M3 的 durable 工具可以从同一个 schema 转换 |
| D69 | 审批没有期限，不做定时清理；等待项只在用户决定、规则变化或 token 吊销时结束 | 审批是用户的决定，系统不替用户放弃；省掉定时任务 |
| D70 | durable 存储：SQLite 用官方 `SqliteStorage`（`pi_` 前缀，同一数据库文件）；PostgreSQL 用从官方 1.4.0 移植的 `PgStorage`；两者都跑官方一致性测试 | 默认后端不承担移植风险；PG 没有官方实现 |
| D71 | durable 工具全部声明 `replay: "safe"`：Cluster 任务 id 由 durable 任务 id 派生（UUIDv8），重跑时找到同一个任务；agent 的工具调用一直等待审批，默认等待结果 10 分钟 | 服务端重启后工具重跑不会重复执行命令 |
| D72 | 配额在每次模型响应后从链上每一级扣减（durable 1.4.0 没有请求前的拦截点）；全部 > 0 才继续，否则这次响应的工具不执行并以 `terminate` 结束运行；允许一次响应超出余额，余量变负 | 不依赖异步 abort 的时序 |
| D73 | M3 的 subagent 只有前台方式，子会话的审批直接交给用户；由父会话 agent 判断（D37、D41）留到后台 subagent 一起做 | 前台等待中的父会话无法处理请求；先保证规则收紧、配额和恢复正确（D75 已补上） |
| D74 | OpenAI 兼容端点可以在 provider 上配置额外请求头（`model_providers.headers`，迁移 0011）；凭据仍只放在加密的 API key 里 | 网关常要求路由头（opencode zen 的 `x-opencode-session`），但不应把密钥往头里塞 |
| D75 | subagent 的子会话是 ownerless 会话（`sessions.parent_session_id`），不用 durable 的"任务拥有的对话"；前台等待在子会话的请求交给父会话 agent 时提前返回，父会话用 `subagent_wait` / `subagent_decide` / `subagent_list` / `subagent_cancel` 处理；父会话 abort 时显式取消整棵子树 | durable 1.4.0 的前台子会话无法在工具返回后存活；ownerless + 显式取消让"打断后转后台"和重启恢复都可控 |
| D76 | 配额只用于 subagent（管理子会话、防止循环/空跑）：`sessions.quota_tokens` 是有符号 64 位剩余 token，可以不给（null 不限）；根会话固定 0 且从不扣减；只计 token，不计算货币成本；设置子会话配额即替换剩余量 | 根不需要额度；每次响应扣整条 subagent 链，负余量准确记录超支 |
| D77 | 配额不足时暂停工具调用，只向**直接父会话**报告（像审批/状态变化）：它的 agent 给这个子会话**增加** token（不按自己的剩余封顶）或拒绝；父是根时由根会话的 agent 决定；每次响应仍扣整条 subagent 链 | 不跳过层级；封顶没有意义，因为同一笔用量本来就扣整条链；增加而不是转移，避免重复扣减 |
