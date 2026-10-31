# Agent 运行时

## 选型：pi-durable

pi 的分层（基于 `earendil-works/pi` 1.4.0 / main `d5b3de22d` 调研）：

```
pi-ai           统一的 LLM API（provider、模型目录、OAuth）
  ├─ pi-agent-core    内存中的 agent loop（Agent 类）
  │    └─ pi-coding-agent  面向本地开发的完整 harness（CLI / SDK / RPC）
  └─ pi-durable       持久化 harness：会话、任务、崩溃恢复（Experimental）
       └─ pi-env      远程 ExecutionEnv（Rust 守护进程，经 SSH 部署）
```

选择 pi-durable 的原因（与需求的对应关系）：

| 需求 | pi-durable 中对应的机制 |
|---|---|
| 多会话 | 一个 Harness 管理多个 Conversation，可 fork |
| 服务端重启后继续 | 每一步先提交再展示；`harness.resume()` 继续未完成的工作；工具调用本身是持久任务 |
| subagent | 由工具任务"拥有"的子会话：abort 级联、父会话等子会话结束才算空闲 |
| 审批与风控 | `hook(ToolTask, { beforeTool })` 可以拦截或改写参数 |
| 幂等 | `submit` 带 `requestId`；工具可以声明 `replay: "safe"` |

不选 pi-coding-agent SDK：会话存储为 JSONL 文件、配置和资源从文件系统中发现、围绕单一工作目录设计、没有内置 subagent，和多用户服务端场景不匹配。它的扩展（pi packages）与 durable 的扩展 API 不兼容，选择 durable 意味着放弃这个生态。

## AgentRuntime 抽象

durable 标注为 Experimental，每个版本都有 breaking change。所以服务端其余部分只依赖我们自己的接口：

```ts
interface AgentRuntime {
  createSession(opts: { owner: UserId; title?: string; rules: RootPreset | RuleSet; // 根会话：选项；子会话：规则
                        model: ModelRef; instructions?: string }): Promise<SessionId>;
  submit(session: SessionId, input: string, requestId: string): Promise<SubmissionId>;
  abort(session: SessionId): Promise<void>;
  watch(session: SessionId, onUpdate: (view: SessionView, ops: unknown) => void): Promise<Unwatch>;
  configure(session: SessionId, change: SessionConfigChange): Promise<void>;
  // 计划任务、审批恢复等场景使用
  waitSubmission(id: SubmissionId): Promise<SubmissionResult>;
}
```

实现为 `DurableAgentRuntime`。pi 的类型不越过这层接口；WebUI 收到的会话视图由我们自己的 `SessionView` 类型描述（v1 可以直接透传 durable 的视图结构，但要经过这层转换，以后才能替换）。

## 存储

- **SQLite**：直接使用 durable 官方的 `SqliteStorage`（`openNodeSqliteStorage(path, { prefix: "pi_" })`），与业务表在同一个数据库文件中，用自己的连接（双方都设置了 busy timeout）。不移植，跟随上游维护。
- **PostgreSQL**：`PgStorage`（`server/src/agent/pg-storage.ts`），从官方 1.4.0 的 `storage/sqlite/storage.ts` 移植到 `pg`：记录仍以 TEXT 保存 JSON（JSONB 会拒绝孤立代理项并重排键），ID 用 BIGINT，事务内一次提交一个批次。
- 两者都在 CI 中跑官方的 `registerStorageConformance`（各 25 个用例）。
- 表名统一加 `pi_` 前缀，与业务表放在同一个库。
- durable 要求同一存储只被一个进程打开：PG 下 `PgStorage` 在独立连接上持有 `pg_try_advisory_lock`，拿不到就拒绝打开，锁连接断开后存储拒绝一切操作；SQLite 下 crhs 本身是单进程。
- durable 的提交不能和业务写入放进同一个事务。两边的一致性通过幂等保证：`requestId`、由 durable 工具任务 id 派生的 Cluster 任务 id。

## 模型配置

- 管理员在 WebUI 的模型设置里添加 provider：pi-ai 内置的 provider（DeepSeek、Anthropic 等），或任意 OpenAI 兼容端点（`base_url` + 模型列表）。
- API key 用主密钥加密后存在 `secrets`；`model_providers` 只保存引用，接口从不返回 key 本身。
- OpenAI 兼容端点可以配置额外请求头（`model_providers.headers`，迁移 0011），用于网关必需的路由头，例如 opencode zen 的 `x-opencode-session`；凭据仍放在 API key 字段。
- crhs 只从数据库读配置，不读环境变量，避免部署环境的变量悄悄改变行为。

## Cluster 工具

工具只定义一次（`ToolCatalog`：名称、描述、参数 JSON Schema、处理函数），分别适配为 durable 的 `defineTool` 和 MCP 工具。

| 工具 | 说明 |
|---|---|
| `list_nodes` | 列出会话所有者能访问的节点（自己的、分享给自己的）和组，以及节点状态、特权任务的处理方式 |
| `node_info` | 节点 Facts，以及节点笔记的路径和内容（截断） |
| `exec` | 执行命令；参数：`node`、`cmd` 或 `argv`、`cwd`、`env`、`privileged`、`timeout`、`wait`（最长等待时间）；批量时 `text` 控制是否返回文本输出 |
| `read_file` / `write_file` / `edit_file` / `list_dir` | 文件操作；`edit_file` 的参数与 pi 的 edit 工具相同（`edits[]`，每项 `oldText` / `newText`，`oldText` 必须在文件中唯一），由 crha 在节点上完成；`write_file` 默认只创建新文件，`overwrite: true` 才覆盖 |
| `task_wait` | 继续等待一个仍在运行的任务，返回当前的输出尾部 |
| `task_cancel` | 取消任务 |

### 批量执行

`exec`、`read_file`、`write_file` 原生支持多个目标：`targets` 参数是节点和组的列表，例如 `["web-1", "group:prod"]`。

- 可选参数：`parallel`（并发数，默认 10）、`fail_fast`（出现失败后不再启动剩余节点）、`text`（是否返回文本输出）。
- Cluster 核心为一次批量调用创建一个**任务组**，每个节点一个任务，审计中可以按任务组查询。
- 默认 `status`：只返回状态、退出码、task_id 和完整输出文件路径；不返回 stdout/stderr。完整输出留在节点文件。
- `text: true`：每节点保留尾部 8KB/128 行；所有节点共享单任务 50KB/2000 行预算；按输出到达顺序分配，预算耗尽后忽略后续节点，允许整个节点被丢弃；完整输出仍在节点文件。
- 预算在接收端追加时检查，内存不随节点数增长；被丢弃节点仍会收到 output/exit ack。不优先保留失败节点，失败输出通过节点文件查看。
- 部分节点通过、部分授权拒绝时任务独立：已执行任务不回滚，`fail_fast` 只影响尚未启动节点。
- 授权规则逐节点判定；需要审批时，同一个任务组合并成一个审批请求。特权任务组第一阶段不做，先支持单任务特权。

### exec 工具的语义

- **长任务**：等待超过 `wait`（默认 10 分钟）时，工具返回"仍在运行，task_id = X"，agent 之后用 `task_wait` 跟进，不会长时间占着一轮工具调用。
- **重启后重新挂接**：exec 声明 `replay: "safe"`。Cluster 任务 id 由 durable 工具任务 id 确定性派生，所以服务端重启后工具重跑时，会找到同一个 Cluster 任务（可能仍在运行或已经结束），而不会新建一个。
- **结果为 `unknown` 时**：返回错误结果，文本为"执行失败，状态未知，原因：connection_lost / executor_restarted / dispatch_unconfirmed"。
- **等待审批时**：工具一直等待，同时通过 `api.details` 把"等待审批"的状态推送给 UI。

### 交给模型的输出

单任务文本模式与 pi 的 bash 工具一致：只返回**尾部** 2000 行或 50KB（先到为准），并注明"显示的是第 X–Y 行，共 N 行，完整输出：<路径>"。输出被截断时，crha 已经把完整输出保存在节点上（见 [execution-plane.md](execution-plane.md#输出)），结果中附上文件路径，agent 需要时用 `read_file` 分段读取。批量默认只返回状态和文件路径；显式 `text` 时按每节点和总预算截断。SSH 节点没有完整输出。

## 会话

- 会话属于创建它的用户。会话能做什么，由操作者链上的授权规则决定；设了配额的级别（子会话、计划任务的会话）还受 token 配额限制，见 [access-control.md](access-control.md#授权规则)。
- 会话记录在业务表 `sessions` 中，`conversation_id` 关联 durable 的 Conversation。
- WebUI 通过 `watch` 订阅会话视图，经 SSE（`/api/sessions/:id/events`）推送增量。
- 开启自动压缩，阈值由模型的上下文窗口决定（参数见下文"默认值"）。
- 会话可以分享给其他用户或用户组（`view` / `chat`）。被分享的用户发消息时，会话仍以所有者的身份行事，见 [access-control.md](access-control.md#归属与分享)；实际发消息的用户记录在审计中。

## subagent

基于 durable 的"由任务拥有的子会话"（参考官方 `test/examples/21-subagent-foreground.ts` 和 `22-subagent-background.ts`）：

- 每个 subagent 都是独立的会话，有自己的授权规则、配额和状态（`active` / `awaiting` / `stopped`），挂在父会话的操作者链下面。父会话可以给子会话加规则来收紧权限；按照链上"取最严格"的判定方式，子会话无论如何都无法超出父会话的权限。
- 父会话可以给子会话一个 token 配额（防止循环、空跑），不按父级剩余封顶，因为每次响应本来就扣整条链。
- 嵌套深度有上限（默认 2）。最深一级的对话不再向模型提供 `subagent` 工具；已有会话在下一次尝试创建或重跑创建时也会被移除该工具。
- 父会话 abort 时，子会话一并 abort，它们正在运行的任务被取消、等待审批的任务被拒绝。

**当前实现（M3）**：

- `subagent(task, rules?, quota?, background?)` 建立独立会话（`sessions.parent_session_id`），对话是 **ownerless** 的，因此父会话停止等待不会连带终止它；父会话 abort 时由运行时显式取消整棵子树（D75）。
- 前台方式等待答案；子会话的请求交给父会话的 agent 时，等待提前返回，父会话处理后再 `subagent_wait`。`background: true` 立即返回会话 id。
- `subagent_wait(id)`、`subagent_list()`、`subagent_cancel(id)`、`subagent_decide(request_id, decision, reason?, tokens?)` 都已实现；配额请求用 `tokens` 给出要增加的 token 数。
- 工具 `replay: "safe"`：重启后按 durable 任务 id 找回同一个子会话和提交（`sessions.last_submission_id`）。
- 规则是完整的非根规则集，只能收紧；配额是父会话给的管理额度；嵌套最多两层。
- 状态：`active` 在跑，`awaiting` 有工具调用在等审批或配额，`stopped` 运行已结束、等下一次输入。`active ↔ awaiting` 由工具调用状态和配额重算；`stopped` 在运行结束时写入（正常完成、拒绝、abort 都一样，不区分原因，看最后一条消息即可）。只有**新的输入**能把它改回 `active`：输入写入时同时更新 `last_submission_id`，只有最新一次输入结束时才会写 `stopped`；读取或重算永远不能复活 `stopped`。`sessions.state` 是缓存，父会话的提示和打断都以它为准。

### 前台与后台

- `subagent(task, rules?, quota?, model?)` 以前台方式启动子会话，等待它完成并返回答案。
- 前台等待**可以被打断**，打断后子会话自动转入后台继续运行（或暂停等待处理），工具立即返回子会话 id 和打断原因。打断的原因包括：
  - 子会话需要父会话处理的请求（审批）；
  - 用户在 WebUI 中打断；
  - 等待超过时限。
- 父会话处理完之后，显式调用 `subagent_wait(id)` 继续等待。

### 处理子会话的请求

- 任务开始等待审批后，运行时沿规则链向上找第一个"对这一操作的有效结果是 allow"的祖先会话；若它本身也是 subagent（不是根），请求交给它的 agent（`approval.agent = { session, state: "pending" }`，并记入 `handler_type` / `handler_session_id`）。
- 父会话的 agent 用 `subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?)` 处理：批准/拒绝直接落到任务上（审计里 actor 是父会话）；`escalate` 把请求交还用户，审批页照常显示。
- **任何工具调用返回时**，只要还有属于它的待处理请求，结果末尾会附上提示（任务/任务组 id、摘要），所以父会话不会错过；实现用 durable 的 `afterTool` 钩子。待处理请求按 handler 索引，运行时按 handler 维护内存 inbox，并在审批/配额变化时使其失效，不再遍历所有后代。用户审批、规则重判也会通过同一个变化回调刷新 actor 的缓存状态。
- 父会话空闲（没有正在进行的运行）时，以 follow-up 输入的方式提交一条提示并唤醒它；如果父会话正在运行，提示只随下一批工具结果附带，若这一轮结束仍未处理，运行结束（`Conversation.waitForIdle`）时再投递一次，不会 300ms 轮询。配额等待由 grant/deny/abort/配额修改唤醒，`subagent_wait` 的 attention 也由 inbox 通知，不再轮询。
- 配额不足时子会话的工具调用暂停，请求只交它的直接父会话的 agent；父会话是根时由根会话的 agent 决定，不再向上（根自己耗尽时交给所有者，见[配额](#配额)）。

### 后台与生命周期

- 子会话是 ownerless 对话：父会话的 abort 不会自动到达它们。`AgentRuntime.abort` 遍历 `parent_session_id` 子树，取消任务并 abort 各自的对话。
- 前台等待被打断后，子会话继续运行；父会话可以在同一轮里先 `subagent_decide`，再 `subagent_wait`。
- 重启后，父会话的 `subagent` 工具重跑（`replay: "safe"`），按同一个 `requestId` 重新挂到已有提交；`subagent_wait` 用 `sessions.last_submission_id` 找回它。

## 默认值

工具和会话的默认值沿用 pi 作为 coding agent 时的默认值（`packages/coding-agent`），只在需要时偏离：

| 项目 | pi 的默认值 | CRH |
|---|---|---|
| 命令输出交给模型 | 尾部 2000 行或 50KB，先到为准 | 相同 |
| 完整输出落盘 | 超过上述阈值时写入系统临时目录（`pi-bash-*.log`，0600），不自动清理 | 超过相同阈值时由 crha 写入 `/var/lib/crha/output/`（0600），按 7 天、1GB 清理 |
| 命令超时 | 无默认超时 | 相同（`timeout` 可选）；另有 `wait`（默认 10 分钟）只决定工具何时返回，不终止任务 |
| 读文件 | 从头 2000 行或 50KB，用 `offset` / `limit` 分页 | 相同 |
| 列目录 | 500 项或 50KB | 相同 |
| grep / find | 100 条匹配（单行 500 字符）/ 1000 条结果 | 暂不提供专门工具，用 `exec` |
| 自动压缩 | `reserveTokens` 16384，`keepRecentTokens` 20000 | 相同 |
| 模型请求重试 | 3 次，基础间隔 2 秒，服务端要求的等待最长 60 秒 | 相同 |

节点笔记在 `node_info` 中截断到 8KB（pi 没有对应项），因为每次调用都会返回。

## 配额

- 配额是管理会话用量（防止循环、空跑、无人值守的运行失控）的手段：`sessions.quota_tokens` 是有符号 64 位整数，表示剩余 token；任何一级都可以不设（`null` 不限，也不扣减）。用户创建的根会话默认 `null`；计划任务创建的会话在根上设为 `token_budget`（见 [scheduling.md](scheduling.md#授权规则与配额)）；子会话由父会话在创建时给出（D92，修订 D76）。
- **口径**：只计模型的**输出 token**（含推理），不计输入和缓存。计入的调用包括会话的每次响应、上下文压缩（durable 的 `CompactionTask`）和 Auto Review（计入被审查任务所属的会话；没有会话的根，例如 API token，不计）。上游没有上报用量（`usage` 缺失，或 `output = 0` 而响应有内容）时，按输出内容（文本、可见的推理文本、工具调用名和参数 JSON）的 UTF-8 字节数 × 0.3 估算，向上取整。预算因此约束的是"做事量"而不是成本：输入（上下文、工具返回）不受限制。M5 之前的 `used_tokens` 按旧口径（输入 + 输出 + 缓存）累计，只用于展示，不迁移。
- 每次模型调用之后（durable 1.4.0 没有请求前的拦截点，D72），把这次调用按上述口径计得的 token 从该会话以及链上**每一个设了配额的级别**（含根）扣减。配额可以为负，负值准确记录这次超出。`used_tokens` 在所有级别累计，只用于展示。
- 所有设了配额的级别剩余都 **> 0** 才继续。任何一级不满足，下一次工具调用**暂停**，会话的状态变为 **`awaiting`**（`sessions.state`，`waiting_level_id` 指向那一级），并**只向那一级的直接上级**报告（不跳过任何一级）：
  - 耗尽的是子会话：由它的直接父会话的 agent 用 `subagent_decide(request_id, "approve", tokens: N)` **增加** N（加法；**不按父级剩余封顶**——每次响应本来就扣整条链，封顶没有意义），或者 `deny` 结束暂停的运行。父会话是根时，由根会话的 agent 决定。
  - 耗尽的是根：由会话所有者在 WebUI 处理（审批页的"额度用尽"，计入顶部待办数；以及会话页），同样是增加 N 或拒绝；处理记入审计（actor 是用户）。
- 子会话的状态只有 `active`、`awaiting`、`stopped`；运行结束（正常完成、拒绝配额或 abort）都置为 `stopped`，等下一次输入；根会话除因配额等待时为 `awaiting` 外始终 `active`。拒绝后暂停的工具调用立即结束，读取或重算不会把 `stopped` 改回 `awaiting`；每次重新耗尽都是新的一次暂停，会再次通知那一级的处理者。
- 配额可以在创建时给出（`POST /api/sessions { quota }`、`subagent(..., quota)`），也可以由所有者用 `PATCH /api/sessions/:id { quota }` 替换剩余量（含根，`null` 取消限制）。
- 只计算 token，不计算任何货币成本；不设用户级或组织级配额。

## 节点笔记

节点笔记就是**节点上的一个普通 Markdown 文件**，人和 LLM 都可以直接读写。

- 位置在 crha 配置中设置（`crha.toml` 的 `notes`，默认 `/var/lib/crha/NOTES.md`，属主为非特权模式的运行用户），通过 `Facts` 上报；SSH 节点在 crhs 的节点配置中设置路径。
- `node_info` 自动返回笔记的路径和内容（超过 8KB 截断，并提示用 `read_file` 读取全文）。
- 读写就用普通的 `read_file` / `edit_file`，审计与普通文件操作相同，没有专门的工具。
- 人可以直接在节点上编辑，也可以在 WebUI 中通过同样的文件操作编辑。
- 风险：被注入的内容可能经由 agent 写进笔记，进而影响以后的会话。审计记录了每一次修改是谁做的，可以据此追溯。

## 提示注入

节点上的日志、文件内容、命令输出都可能被攻击者控制，并进入模型上下文。因此：

- "能执行什么、能否提权"完全由 Cluster 核心的策略决定，不依赖模型的判断。
- 会话的节点范围是硬限制。
- 高风险操作（提权、写系统文件、跨节点批量操作）走审批。
- Auto review 的 LLM 只能看到命令本身和最少的上下文，避免同一段注入内容同时影响执行者和审查者。

## 版本与升级

- 锁定精确版本（`package.json` 中不带 `^`）。
- 会话订阅推送频率的修复（v1.4.0 约 1.5 秒推送一次，main 约 100ms 一次）只在 1.4.0 之后的 main 分支中，需要等下一个发布版。
- 每次升级的检查清单：阅读 CHANGELOG 中的 Breaking Changes（尤其是 `Storage` 接口）→ 修改 `SqlStorage` → 跑一致性测试套件 → 跑性能回归 → 跑故障注入测试。

## 测试策略

durable 还很年轻（1.0.0 于 2026-10-01 发布），运行时测试要下功夫。

### 1. 存储一致性

CI 中用官方的 `registerStorageConformance`（`@earendil-works/pi-durable/testing`），对 `SqlStorage` 的 SQLite 和 PG 两种方言都跑一遍。PG 用容器启动。

### 2. 性能和内存回归

基于调研时写的压测脚本移植（假模型 faux + 真实存储），断言：

- 运行结束后堆内存回到基线（`contextRetentionMs: 0`、`documentRetentionMs: 0`）；
- 带自动压缩的长会话，单轮延迟不随轮数增长；
- 会话订阅推送频率 ≥ 5 次/秒；
- 重启后打开存储的耗时，以及老会话第一轮的延迟。

调研时的基线（SQLite、faux、单核）：

| 场景 | 结果 |
|---|---|
| 20 会话 × 25 轮，每轮 2 个工具各输出 64KB | 146 轮/s；默认缓存下堆内存 74MiB，关闭缓存后回到 24MiB |
| 单会话 300 轮，200k 窗口，压缩 37 次 | 单轮约 8ms，前后不变；堆内存稳定在 22MiB 左右 |
| 500 会话后重启 | 打开 2ms，老会话第一轮 12–15ms |
| 256KB 工具参数按 4000 tok/s 流式输出（约 18s） | CPU 约占单核 5–7% |

结论：没有泄漏；每轮框架开销约 7ms，相对于 LLM 延迟可以忽略。默认 10 分钟的上下文和文档缓存会让内存与"最近 10 分钟内活跃的数据量"成正比，可以按部署规模调整。

PG 存储需要单独用官方的 `storage-benchmark` 测试，因为每次提交都有网络往返。

实现：`server/test/perf/agent.perf.test.ts`（`pnpm --filter @crh/server test:perf`，不在常规测试中运行）。M3 完成时的结果：20 会话 × 10 轮 161 轮/s，关闭缓存后堆内存 38→46 MiB；单会话 120 轮单轮 8.0→10.4 ms；重启打开 3 ms，老会话第一轮 15 ms。

### 3. 故障注入

- 工具执行中杀掉服务端进程，重启后验证：exec 重新挂接到同一个 Cluster 任务；结果正确写回会话。（`test/e2e/crash.e2e.test.ts`：真实 crhs 进程 SIGKILL，模型是 OpenAI 兼容的假服务器；`agent-session.e2e.test.ts`：进程内关闭再打开）
- 模型流式输出中杀进程，验证会话可以继续，且最终只有一个答案（`test/e2e/crash.e2e.test.ts`：假 OpenAI 服务器先发一段再停顿，SIGKILL 后重启，等待恢复出的答案）。
- 存储写入失败，验证 Harness 关闭并由我们的监督逻辑重新打开。（`agent-session.e2e.test.ts`，注入一次提交失败）

### 4. 真实模型冒烟

用便宜的模型跑少量端到端用例，覆盖 faux 测不到的真实 provider 流式和解析路径。changelog 中"500KB 工具参数耗 20 秒 CPU"的问题在 faux 下无法复现，需要在这里验证。

2026-10-27 用 opencode zen 的 `deepseek-v4.1-flash` 手工跑过：在 WebUI 里新建会话、模型调用 `list_nodes`、读回工具结果并作答，流式输出、思考块和工具卡片都正常；网关要求的 `x-opencode-session` 请求头通过 provider 的额外请求头配置（迁移 0011）发送。冒烟不在 CI 中运行（需要外部 key）。
