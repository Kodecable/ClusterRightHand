# ClusterRightHand 设计文档

ClusterRightHand（下称 CRH）是一个用于管理 VPS 集群的 agent 平台：服务端运行多会话 agent loop，把指令下发给各节点上的客户端执行；同时也可以不用内置 agent，直接作为 MCP 服务器把节点集群暴露给任意 coding agent。

> 状态：设计阶段，尚未开始实现。本目录记录已对齐的需求与设计决策。
>
> 仓库：<https://github.com/Kodecable/ClusterRightHand>。许可证：MIT，版权人为 "The ClusterRightHand authors"。

## 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 总体架构、组件划分、技术栈、仓库结构 |
| [execution-plane.md](execution-plane.md) | 执行平面：任务模型与语义、CBOR 客户端协议（M3.5）、通信安全（WSS + Noise）、节点注册、SSH 传输、批量输出 |
| [protocol.md](protocol.md) | crhs ↔ crha 协议的线上格式（M3.5）：CBOR 元组 schema、握手载荷、帧、命令/事件、JSON 存储形式、fixture |
| [privilege.md](privilege.md) | 提权与授权：特权任务的四种处理方式、crha 特权模式、方法与目标、授权结构、信任缓存、联署 |
| [agent-runtime.md](agent-runtime.md) | Agent 运行时：pi-durable 集成、cluster 工具、会话、subagent、测试策略 |
| [access-control.md](access-control.md) | 用户模型（管理员 / 普通用户、用户组）、归属与分享、授权规则、API token、审计 |
| [scheduling.md](scheduling.md) | 计划任务 |
| [webui.md](webui.md) | WebUI 重构：技术栈、架构、API 约定、分期 |
| [mcp.md](mcp.md) | MCP 门面 |
| [data-model.md](data-model.md) | 数据表草案 |
| [testing/README.md](testing/README.md) | 测试分层、环境、命令与 CI 覆盖；各层细节见 `testing/` |
| [m4.md](m4.md) | M4 提权的实现计划与阶段（测试见 [testing/privileged.md](testing/privileged.md)） |
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
| D7 | 同一个任务 id 最多 accepted/executed 一次；accepted 前的明确授权拒绝可用 `attempt + 1` 重试；重连后只用 `query` 查询（被 D83 修订） | 由此保证不会重复执行；否决 boot id 方案（多余） |
| D8 | SSH 模式不上传客户端二进制 | 避免处理目标架构的分发问题；代价是 SSH 节点没有续传、反连和特权模式 |
| D9 | 提权 IPC 使用 unix socket + `SO_PEERCRED` | 零依赖；否决 D-Bus（服务器上不一定有，且无必要） |
| D10 | 每个节点的 crha 特权模式在本地配置一个信任数组，用 `role`（`crhs` / `user` / `local`）区分角色、`format`（`sshsig` / `webauthn`）区分签名格式，每项可带防护规则 | "crhs 无法单独执行特权任务"就是 crhs 信任项不含 `execute`，或者不配置 crhs 信任项 |
| D11 | 授权统一为"本体 + 可选指令限制（前缀或原文）+ 截止时间（D103 起必有）+ 可选任务绑定"；计划任务也用它单独签发 | crhs 的单条命令授权就是 `exact` + `task_id` + 短截止时间；任务绑定见 D50 |
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
| D24 | crha 特权模式上报 `TrustSummary`，crhs 缓存并据此计算授权方案；执行前 crha 仍完整复验（被 D78/D79 修订） | crhs 不再为每条任务发 Preflight；缓存与命令版本由 M3.5 协议承载 |
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
| D40 | crhs 只保存截断后的输出头尾；过长的输出由 crha 在节点上保存为普通文件并负责清理，agent 用 `read_file` 读取；SSH 节点强制截断，不保存完整输出（被 D82 修订：批量 `status` 模式不保存输出，批量 `text` 受共享预算） | 去掉 crhs 的输出存储和保留策略；断线续传可以直接从文件补发 |
| D41 | 前台 subagent 的等待可以被打断并自动转入后台，父会话处理请求后显式调用 `subagent_wait`；父会话的其他工具返回时自动提示待处理的子会话 | 父会话在自己的上下文中处理子会话的审批请求 |
| D42 | 工具和会话的默认值沿用 pi 作为 coding agent 时的默认值：输出交给模型时保留尾部 2000 行或 50KB，超过即落盘；读文件 2000 行或 50KB 分页；无默认超时；压缩与重试参数相同（被 D82 修订：批量 `text`/`status` 总是保留完整输出文件） | 见 agent-runtime.md 的"默认值"；落盘阈值与模型截断阈值相同，模型看到截断时一定有完整输出文件 |
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
| D61 | 数据库只用一个应用账号，拥有迁移、安装和运行所需的全部权限 | 部署简单；单一账号挡不住被攻破的 crhs 本身，真正的防护要把审计外送到另一个信任域（D104） |
| D62 | 用户和组织没有长期规则；规则链的根是根会话、计划任务或 API token，用户为根选择 Ask / Auto Review / Yolo，映射为实际规则；子会话用完整规则配置，逐级收紧。用户在 WebUI 中本人操作只检查节点访问 | 规则是"授权给代理"的边界，用户本人不需要；简单选项给人用，细粒度规则给 subagent 用 |
| D63 | 审批结果是工具调用（任务 / 任务组）本身的状态，不单独建表；"以后都允许"才修改规则；规则变化后重新判定该链上所有等待中的任务 | 一次性的决定不是策略，写成规则会污染规则集 |
| D64 | 授权规则与特权解耦：规则不区分特权和普通任务，特权只由 crha 的信任配置决定（被 D86 修订） | 两套机制各管一件事 |
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
| D76 | （被 D92 修订）配额只用于 subagent（管理子会话、防止循环/空跑）：`sessions.quota_tokens` 是有符号 64 位剩余 token，可以不给（null 不限）；根会话固定 0 且从不扣减；只计 token，不计算货币成本；设置子会话配额即替换剩余量 | 根不需要额度；每次响应扣整条 subagent 链，负余量准确记录超支 |
| D77 | 子会话状态只有 `active` / `awaiting` / `stopped`，是缓存：`active ↔ awaiting` 由工具调用状态（等审批）和配额状态重算，`stopped` 在运行结束时写入（正常完成、拒绝、abort 都一样，不区分原因；最后一条消息说明发生了什么），等待下一次输入。配额不足时暂停工具调用，只向**直接父会话**报告；它的 agent 给这个子会话**增加** token（不按自己的剩余封顶）或拒绝；父是根时由根会话的 agent 决定；每次响应仍扣整条 subagent 链 | 不跳过层级；封顶没有意义，因为同一笔用量本来就扣整条链；父会话的提示/打断只看子会话状态，细节从工具调用和配额里取 |
| D78 | （被 D99 修订）M3.5 完整替换 crhs ↔ crha 的 protobuf 为 CBOR；Web API/数据库继续 JSON；不保证旧协议兼容。版本只在握手协商（大/小版本和支持的命令集合），之后帧不再带 `v`；抽象为双向命令/事件；大版本内命令/事件结构固定，小版本只允许新增命令（如 `task.start.v2`），兼容性看命令集合交集而非 minor 数字。CBOR 用 `CBOR-CORE-INT-v1`：RFC 8949 §4.2.1、cborg/fxamacker、禁 float/tag/indefinite、时间整数毫秒；ack 是事件 | 去掉 protobuf/buf 依赖；CBOR 有确定编码规范；版本化命令比 oneof 字段演进更可控 |
| D79 | M4 的 crhs 只缓存 `TrustSummary`，据此计算授权方案；只用 `on_behalf_of_user_id` 的凭据，不考虑共享用户或其他管理员；规则匹配用 RE2（Node 包 `re2`），crha 执行前仍完整复验 | 去掉 Preflight 往返；所有者和 RE2 使 crhs 判断与 crha 语义一致；缓存不是授权 |
| D80 | 授权和联署是同一 CBOR payload 上的多个签名（`signatures[]`），不再使用 `cosign_of` 或两个 payload | 两个签名覆盖完全相同的 nodes/command/task_id/attempt/deadline；少一次一致性校验，授权 id 也只有一个 |
| D81 | SSH 节点不参与提权：`privileged` 被忽略，按 SSH 用户执行并在任务输出中提示；保留现有 SFTP `file.*` 任务，不做 SSH native/forward | SSH 没有可验证的特权边界；忽略而不是假装拒绝/提权；file 任务仍有价值 |
| D82 | 批量执行默认 `status`：只返回状态，完整输出留在节点；显式 `text`：每节点保留尾部 8KB/128 行，所有节点共享单任务 50KB/2000 行预算，按输出到达顺序丢弃；预算在接收端 append 时检查；丢弃仍发 ack；不优先保留失败节点 | 不在内存里先收完再裁；节点数增长不增加内存；完整输出仍可读文件；失败输出可见性是可接受的取舍 |
| D83 | 任务 id 最多 accepted/executed 一次；只有 crha 在 `task.start` 成功响应（accepted）之前明确拒绝授权时，允许同一 task id 用 `attempt + 1` 重试。部分节点通过、部分拒绝时任务彼此独立，不回滚已执行任务；`fail_fast` 只影响未启动节点；授权等待不自动超时。crhs 的规则引擎只是预演，crha 授权拒绝后优先回退到所有者 user/local 路径 | 保留 durable task id 和工具重放；明确拒绝前无副作用可安全重试；网络 unknown 绝不重试；避免把部分成功伪装成整体成功 |
| D84 | M3.5 协议语义补全：`task.start` 成功响应即 accepted（取代独立的 accepted/rejected 消息），失败码分可重试的 `authorization_*` 与终态错误；`task.query` 对未知 id 正常响应 `unknown`；请求 id 按方向独立；未协商事件断开连接。pending 受限连接不设查询命令，靠 `node.status` 推送，批准后断开重连。批量 `text` 预算按只增不减的额度发放，已获额度的节点在额度内滚动尾部。文本只校验 UTF-8，不做 NFC 规范化 | 消除命令/响应抽象下的命名残留；状态切换走普通重连路径；内存上限等于已发额度之和、实现只需环形缓冲 + 计数器；路径是字节序列，规范化会改变目标 |
| D85 | 一个任务组最多 512 个节点（target 展开去重后计数，含离线节点），超过时拒绝创建并提示拆分 | 每节点的状态信息不受输出预算约束，节点多时返回给模型的结果会线性膨胀；512 × 80B 一行 < 50KB，常见批量命令在 `text` 预算内能全部看到；被否决：静默截断到前 512 个（调用方会误以为全部执行了） |
| D86 | 授权规则增加 `privileged` 匹配维度，MCP / agent 工具暴露 `privileged`（修订 D64） | `native` / `ignore` 下 crhs 策略是唯一关口，不能区分特权就无法单独收紧特权任务；`forward` 的最终决定仍在 crha 信任配置 |
| D87 | `native` 用 `sudo -n` / `doas -n` 拉起同一二进制 `crha privileged stdio` 作为 helper，exec 和 `file.*` 都由它执行，走 crh-priv 协议、不校验授权；`run0` 为实验性后端 | 非特权进程无法给提权后的进程发信号（kill(2) 的 uid 检查），SIGKILL 发给 sudo / doas 后 root 目标进程成为孤儿（2026-10-29 podman 实测）；`env_reset` 让 env 白名单无法传递；被否决：exec 直接 `sudo -n -- argv`（保留 sudoers 按命令限制，但强杀和超时不可靠） |
| D88 | 授权 payload 是定长数组；一次性约束为 `task_ids` 列表，一个用户签名覆盖任务组的多个节点；已用列表的键为 `(授权 id, 任务 id)` | 任务组的用户签名只需一次；`task_ids` 固定具体任务，签发时把组展开成节点 id，签名后范围不变 |
| D89 | 本地批准只用于单任务，不占用 `task.start`：`local.request` 登记、`local.decision` 通知、批准后再发 `task.start`。任务组不走本地批准，没有其他路径时直接失败；crhs 签名被拒后回退到 local 时用 `attempt + 1` 登记，流程相同 | 长时间挂起的 `task.start` 一断线就是 `unknown`；分开后执行只由 `task.start` 触发，等待期间断线安全；逐节点登录批准与批量执行相悖，排除后 crhs 不必为任务组跟踪本地状态 |
| D90 | crhs ↔ crha 只推送 `trust.summary`，不查询；非特权模式转发 `authorization_*` 前先刷新摘要。吊销用幂等的 `revocations.add`，摘要可用时重发全部未过期项（吊销被 D103 移除） | 推送 + 拒绝前刷新保证 crhs 处理拒绝时缓存最新；幂等追加让离线节点重连后自然补齐 |
| D91 | crhs 签名用 `node:crypto` ed25519 + 手写 SSHSIG；`crha grant` 调用 `ssh-keygen -Y sign`；crha 用 `x/crypto/ssh` + 手写 SSHSIG codec 验证，WebAuthn 手写验证（ES256 / EdDSA / RS256）；crhs 的 WebAuthn 用 `@simplewebauthn`；ssh-agent 签名为可选项目 | 不引入新的 Go 模块；OpenSSH 负责加密私钥、agent 和 FIDO 触摸；RS256 用标准库验证成本很低，避免注册出无法校验的凭据 |
| D92 | 配额统一：任何一级会话都可以设 token 配额或不设（`null` 不限、不扣减）；用户创建的根默认不设，计划任务的会话在根上设 `token_budget`；每次模型调用（含压缩和 Auto Review）只计输出 token，上游不上报时按输出 UTF-8 字节 × 0.3 估算，扣链上所有设了配额的级别；耗尽时只报告给那一级的直接上级，根由所有者在审批页增加或拒绝 | 计划任务需要无人值守的用量上限，复用同一套暂停/处理流程，不另做预算机制；只计输出让口径不随上下文长度和缓存命中变化，输入不受预算约束 |
| D93 | 计划任务只有一种：按 cron 用固定消息新建会话；同一计划任务同时只有一个实例，新运行强制结束上一个；调度的每个决策写审计；可以手动运行，错过的触发可选补跑一次；webhook 通知移到 M6 | 固定命令也交给 agent，规则、审批、提权、配额全部复用会话；强制结束让每次运行只在下一次触发前有效，不会堆积等待 |
| D94 | WebUI 技术栈：Tailwind CSS v4 + shadcn/ui（底层 Base UI）+ lucide；Lingui 做 i18n（原文英语，加简体中文）；TanStack Router / Query / Table；react-hook-form + zod；virtua 做虚拟列表；Markdown 用 react-markdown + remark-gfm，配合自写的增量切块；代码高亮用 Shiki（JS 正则引擎，增量分词）。版本见 [webui.md](webui.md) | 依据生态调研和两轮 POC：Streamdown 在长文本下卡顿严重且安全配置不足；Markstream 默认会加载外链图片，长文档流式结果不正确；只有 react-markdown 方案同时满足安全和正确性，它的性能问题可以通过增量切块等写法解决；virtua 在流式场景下的帧表现优于 TanStack Virtual |
| D95 | WebUI 改为路径路由（`/sessions/:id`），旧的 `#/...` 链接在前端转换；服务端生成的链接一并改为路径形式 | crhs 已经把非 API 路径回退到 `index.html`；路径路由支持按页面拆包，链接也更规范 |
| D96 | 列表接口统一使用 keyset 游标（`{ items, nextCursor }`），删除 offset 分页；会话事件流的 snapshot 只带最近 100 条记录，更早的记录通过 `entries` 接口分页加载；会话列表通过 SSE 推送增量变化 | 按超多会话、超多消息设计：offset 分页在插入新数据时会错位且越翻越慢，全量 snapshot 在 2 万条消息时代价过高 |
| D97 | `sessions.state` 重定义为 `idle` / `running` / `awaiting`，根会话和子会话通用，持久化并在启动时与 durable、任务表对账；`waiting_kind` 区分配额、审批、签名等待；`root_session_id` 让列表按会话树汇总状态 | 状态点、过滤和排序直接走 SQL；原来根会话几乎总是 `active`，看不出是否在运行；子会话的 `stopped` 与"空闲"语义相同，合并为 `idle` |
| D98 | 等待签名的任务 24 小时后自动结束（`authorization_wait_expired`；有审批时从审批决定起算）；会话停止或运行结束时，它留下的审批和签名等待一并结束，启动时对发起者会话已空闲的等待做同样的清理 | 没人处理的等待原来会一直挂着：会话停止时只清理了审批和运行中的任务，漏掉了 M4 新增的签名等待；用户直接发起的特权任务没人签名时也没有终点 |
| D99 | 不兼容的协议修改升大版本并改变 Noise prologue（`"crh/<major>" ‖ 挑战`），大版本不同的对端在握手本身失败、被明确拒绝；`protocol_minor` 只做增量，靠 `commands` 交集协商（D78）；crh-priv 也按大版本拒绝；crha 与它的特权模式必须运行同一个 `crha_version` | 只有大版本能让旧对端在解析任何载荷之前就停下来；minor 保持增量，同一个大版本内加命令不用升级；crh-priv 的 `task.exit` 改动跨 forward 链路，同样必须升大版本；版本不一致的 daemon 仍按不可达处理，覆盖只换二进制不重启的升级 |
| D100 | 审批沿 [用户]→[根会话 agent]→[子会话]… 向上找第一个对该操作 allow 的 agent 会话，根会话 agent 同样可以判断（D37 的本意）；都不 allow 或 agent 上交时到用户；配额路由不变（只交直接父会话） | 子会话额外加的限制是 agent 自己的护栏，不是给用户的审批单；根会话的选项（如 Ask）仍然界定根 agent 可以批准什么 |
| D101 | 两个 token 度量按名字严格分开：预算口径（`budget_used_tokens` / `budgetUsedTokens`，只计输出，含压缩和 Auto Review，决定配额何时暂停，D92 的口径不变）与统计口径（`usage_tokens` / `usageTokens`，输入 + 输出、含缓存读写，链上累加，只用于展示）；另有 `context_tokens` / `contextTokens`，只取本会话最近一次主 agent 调用的输入大小。两个度量共用一个估算常数 `0.3 token/字节`，没有上报用量时按调用实际发出的请求内容的字节估算输入（生成只有 `messages`，压缩和评审是系统提示 + 消息） | 一个数不能既是"扣配额的量"又是"总花费"：只计输出才能不随上下文长度和缓存命中漂移，而用户想看的总用量必须包含输入。名字必须能区分，否则调用方早晚把两者混用；上下文填充单独存，才能算百分比且不被压缩或评审改写 |
| D102 | crha 的源码不内置任何自身配置、状态、日志或 socket 路径，全部由命令行 `--config` 和配置文件给出；唯一例外是手动本地批准的 `crha pending/approve/deny` 默认连接 `/run/crha/privileged.sock`（`CRHA_PRIVILEGED_SOCKET` 或 `--socket` 覆盖）。`crha enroll --state-dir` 在配置不存在时写最小配置 | 没有默认路径就不会出现 native 节点放着无人读取的 `privileged.toml`、被误以为规则生效；WebUI 给出的路径只是建议布局 |
| D103 | 移除授权吊销；所有授权必须带 `deadline`；特权模式已用列表内存上限 8192 条，按 `deadline + max(1h, clock_skew)`（本地批准 24 小时）保留，淘汰未过期记录时抬高内存水位线、拒绝更早签发的授权，文件只追加并按 2 倍有效记录数重建，可用 `--no-persist-used` 只放内存；授权页只对管理员可见 | 吊销由 crhs 推送，crhs 被攻破时帮不上忙，也送不到离线节点、对 native / SSH 节点没有作用；一次性授权不能重放，可复用的授权受指令限制和 `deadline` 约束；内存和磁盘上限让小设备也能用 |
| D104 | 移除审计哈希链；审计只追加写入，防篡改依赖外送到 crhs 之外的信任域（后续） | 哈希不带密钥，能改库的人可以从修改点重算整条链，只能发现手工误改或损坏；却让每次追加都要读最后一行、每行多存两个哈希、校验要走全表，删除旧记录还需要额外的锚点 |
| D105 | crhs 按保留期清理已结束的任务、任务组、过期授权（`tasks`，默认 90 天）与审计（`audit`，默认 180 天），可设 `off`，最短 1 天；审计保留最新 16384 个序号 | 这些表只增不减；会话记录（durable）需要长期保存，不在此列。1 天下限防止崩溃后重跑的工具调用因任务行已被删而重复下发；审计序号下限保证 SQLite 不复用序号，也防止时钟跳变清空审计 |
