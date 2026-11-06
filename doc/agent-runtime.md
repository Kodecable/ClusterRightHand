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
  waitForSubmission(id: SubmissionId): Promise<SubmissionResult>;
}
```

实现为 `DurableAgentRuntime`。pi 的类型不越过这层接口；WebUI 收到的会话视图由我们自己的 `SessionView` 类型描述（v1 可以直接透传 durable 的视图结构，但要经过这层转换，以后才能替换）。

## 存储

- **SQLite**：直接使用 durable 官方的 `SqliteStorage`（`SqliteStorage.open(db, { prefix: "pi_" })`），与业务表在同一个数据库文件中，用自己的连接。node:sqlite 是同步的，两条连接不能各自等锁（见 [data-model.md](data-model.md)）：两个连接共享进程内的一个语句队列，Kysely 的事务以 `BEGIN IMMEDIATE` 开始；Harness 重新打开时旧的存储会关闭。不移植，跟随上游维护。
- **PostgreSQL**：`PgStorage`（`server/src/agent/pg-storage.ts`），从官方 1.4.0 的 `storage/sqlite/storage.ts` 移植到 `pg`：记录仍以 TEXT 保存 JSON（JSONB 会拒绝孤立代理项并重排键），ID 用 BIGINT，事务内一次提交一个批次。
- 两者都在 CI 中跑官方的 `registerStorageConformance`（各 25 个用例）。
- 表名统一加 `pi_` 前缀，与业务表放在同一个库。
- durable 要求同一存储只被一个进程打开：PG 下 `PgStorage` 在独立连接上持有 `pg_try_advisory_lock`，拿不到就拒绝打开，锁连接断开后存储拒绝一切操作；SQLite 下 crhs 本身是单进程。
- durable 的提交不能和业务写入放进同一个事务。两边的一致性通过幂等保证：`requestId`、由 durable 工具任务 id 派生的 Cluster 任务 id。

## 模型配置

管理员在 WebUI 的模型页添加提供方（provider），分两类（D115）：

- **Pi 内置**（`kind = builtin`）：pi-ai 的 `builtinProviders()`（DeepSeek、Anthropic 等）。模型清单、上下文窗口、是否支持思考和档位映射都来自 pi-ai，跟随 pi-ai 的版本；crhs 只提供 API key 和可选的 `base_url` 覆盖。只支持 API key：pi-ai 里几家提供方另有 OAuth（订阅登录），crhs 不接，界面和文档都写明这一点。
- **自定义**（`kind = custom`）：任意兼容端点，取代原来的 `openai-compatible`（迁移时旧行改为 `custom`，每个模型补 `api: openai-completions`，其余不变）。

API key 用主密钥加密后存在 `secrets`；`model_providers` 只保存引用，接口从不返回 key 本身。crhs 只从数据库读配置，不读环境变量，避免部署环境的变量悄悄改变行为。

### 自定义提供方

提供方一级：

| 字段 | 说明 |
|---|---|
| `baseUrl` | http(s) 端点，例如 `https://opencode.ai/zen/v1` |
| API key | 可选（本地无鉴权的服务可以不填） |
| `headers` | 额外请求头，只放网关路由头，不放凭据（凭据放 API key） |
| `sessionId` | `{ headers?: string[], body?: string[] }`：这些请求头 / 请求体字段（点分路径，如 `metadata.session_id`）填当前请求所属的 **crh 会话 id**。例如 opencode 的 `x-opencode-session`。子会话填它自己的 id；自动复核和标题生成填被复核 / 被命名的会话 id |

每个模型：

| 字段 | 说明 |
|---|---|
| `id`、`name?` | 上游的模型 id 和显示名 |
| `api` | `openai-completions`（Chat Completions）或 `openai-responses`（Responses） |
| `contextWindow`、`maxTokens` | 上下文窗口和单次最大输出 token；自动压缩的阈值由 `contextWindow` 决定 |
| `input` | `["text"]` 或 `["text", "image"]`；图片目前只打通模型链路（pi-ai 的图片内容块），提交和输入框还没有附件 |
| `thinking?` | 不填表示不支持思考，只有 `off`；见下文 |
| `compat?` | 高级：按所选协议用 pi-ai 的 `CompatSchemasByApi[api]` 校验（例如 `maxTokensField`、`supportsDeveloperRole`），不填的字段沿用 pi-ai 按 URL 的自动判断 |

`thinking` 有两种写法，二选一：

- **格式写法** `{ mode: "format", format?, levels }`：由 pi-ai 生成思考参数。`format` 只用于 Chat Completions，取 pi-ai 的 `thinkingFormat`（OpenAI 风格 `reasoning_effort`、`deepseek`、`qwen`、`openrouter`、`chat-template` 等），不填时 pi-ai 按 URL 判断；Responses 一律是 `reasoning.effort`。`levels` 是档位映射（pi-ai 的 `thinkingLevelMap`）：`{ "<档位>": "<发给上游的值>" | null }`，null 表示不支持这一档，未列出的 `minimal`–`high` 原样发送，`xhigh` / `max` 只有列出时才可用。
- **请求体写法** `{ mode: "body", levels }`：`levels` 是 `{ "<档位>": <JSON 对象> }`，选中某档时把对应对象深合并进请求体（在 pi-ai 组好请求之后，经 payload 钩子），例如 `{ "off": { "thinking": { "type": "disabled" } }, "high": { "thinking": { "type": "enabled", "budget_tokens": 16000 } } }`。可用档位是 `off` 加上列出的键（未列出 `off` 时，`off` 不合并任何内容）；pi-ai 自己的思考参数在这种写法下不发送（实现时确认，必要时由钩子删除）。

两种写法下，思考内容的解析（`reasoning_content` 等）都由 pi-ai 负责，不受影响。

### 思考档位

- 档位与 pi-ai 一致：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。模型可用的档位由 pi-ai 的 `getSupportedThinkingLevels` 给出（自定义模型按上面的 `thinking` 换算成 pi-ai 的模型字段后同样由它计算）。
- 会话、子会话和计划任务的模型都是 `{ provider, modelId, thinkingLevel? }`；不填是 `off`。
- 明确给出的档位必须是该模型可用的档位，否则 400。只换模型、不给档位时保留原档位，新模型不支持就调整到最近的可用档（pi-ai 的 `clampThinkingLevel`：先往高找，再往低找）。
- 会话视图的 `model` 带 `thinkingLevel`；`GET /api/models` 的每一项带 `thinkingLevels`（可用档位）和 `input`。

## Cluster 工具

工具只定义一次（`ToolCatalog`：名称、描述、参数 JSON Schema、处理函数），分别适配为 durable 的 `defineTool` 和 MCP 工具。处理函数返回统一的工具结果（内容块、是否错误、给 UI 的 `details`），由两个适配层各自转换。

| 工具 | 类别 | 返回 | 说明 |
|---|---|---|---|
| `list_nodes` | 非任务 | JSON | 列出会话所有者能访问的节点（通过访问授权获得），以及节点组、状态、是否在线、特权任务的处理方式 |
| `node_info` | 非任务 | JSON | 节点 Facts，以及节点笔记的路径和内容（截断）：`targets` |
| `exec` | crh 任务，可后台等待 | 文本 | 执行命令：`targets`、`cmd` 或 `argv`、`cwd`、`env`、`stdin`、`privileged`、`timeout`、`wait`、`with_output`（默认 true）、`max_lines`、`max_bytes` |
| `read_file` | crh 任务，阻塞 | 文本 | 按行读文件：`targets`、`path`、`offset`（1-based，默认 1）、`limit`（默认 2000）、`max_bytes`；一页不超过 2000 行或 50KB |
| `write_file` | crh 任务，阻塞 | JSON | 写文件：`targets`、`path`、`content`、`overwrite`、`mode`（八进制字符串，如 `"0644"`）、`create_parent_dirs`；默认只创建新文件，`overwrite: true` 才覆盖；`create_parent_dirs: true` 时先创建不存在的父目录（相当于 `mkdir -p`） |
| `edit_file` | crh 任务，阻塞 | JSON | 按原文替换：`targets`、`path`、`edits[]`（每项 `old_text` / `new_text`，`old_text` 必须在文件中唯一，全部一起生效或都不生效） |
| `list_dir` | crh 任务，阻塞 | JSON | 列目录：`targets`、`path`、`limit` |
| `stat` | crh 任务，阻塞 | JSON | 文件属性（类型、大小、权限、属主、修改时间、链接目标）：`targets`、`path` |
| `task_wait` | 非任务 | 同 `exec` | 继续等待 `exec` 返回的任务或任务组 |
| `task_cancel` | 非任务 | JSON | 取消 `exec` 返回的任务 |

`task_wait`、`task_cancel` 只作用于本会话或本 API token 发起的 `exec` 任务与任务组，以及本会话子树（subagent）发起的那些；同一用户的其他会话的任务不可见（与"任务属于发起它的操作者"一致，见 [access-control.md](access-control.md#操作者)）。文件工具的任务不对模型暴露，`task_wait` 不接受它们。

### 工具层的分类与复用组件（D111）

分类只在工具层：task 层不变，文件工具在内部照样是 crh 任务，审计、授权规则、审批、特权授权和重启后的重新挂接都和以前一样。

- **crh 任务工具**：每次调用都会创建一个 crh 任务或任务组（`exec`、`read_file`、`write_file`、`edit_file`、`list_dir`、`stat`）。它们共用一个组件：解析 `targets`，决定单任务还是任务组，用调用 id 派生任务 id，等待，并把任务交给渲染器。组件按工具声明分两种等待方式：
  - **可后台等待**（只有 `exec`）：等待不超过 `wait`；超过后返回"仍在运行"或"等待审批 / 签名"以及 `task_id` / `task_group_id`，之后用 `task_wait` 跟进、`task_cancel` 取消。
  - **阻塞**（文件工具）：一直等到任务结束，等待审批和签名时也阻塞；没有 `wait` 参数，没有超时，也不向模型暴露任务 id。文件操作通常在秒级完成，暴露 id 只会让模型多一轮 `task_wait`。中止只能取消整个工具调用（agent 被 abort、MCP 请求被关闭时，组件取消它的任务）。
- **非任务工具**：`list_nodes`、`node_info`、`task_wait`、`task_cancel`。`node_info` 读取节点笔记时在内部用一个只读任务，但只在规则直接允许时才读，从不留下审批请求，对外仍是非任务工具。
- **渲染器**也是复用组件，分文本和 JSON 两种，见下文"交给模型的输出"。
- 两种等待方式都通过 `onStatus` 把任务 id 和等待状态推送给 UI（WebUI 用它跟进工具卡片，见 [webui.md](webui.md#会话界面)）；这些 id 只给 UI，不进入模型看到的内容。

### 命名

- 参数和 JSON 字段一律 snake_case，包括 `node_groups`、`edits[].old_text` / `new_text`，以及 `node_info` 返回的 `facts`（与协议 `Facts` 的键名相同，见 [protocol.md](protocol.md#事件)）。
- 所有作用于节点的工具都用 `targets`，解析方式相同（D114）；没有单独的 `node` 参数。
- `write_file` 的 `mode` 是八进制权限字符串（如 `"0644"`），与 `stat` 返回的 `mode` 相同；不合法时以 `invalid_argument` 拒绝。JSON 没有八进制写法，十进制整数容易写错（`644` 实际是 `0o1204`）。
- 错误码用 snake_case，与任务的 `error_code` 共用一套（例如 `node_offline`、`not_found`、`permission_denied`、`line_too_long`、`offset_out_of_range`）；工具层自己的错误有 `invalid_argument`（参数组合不对）、`no_such_node`（看不到这个节点）、`no_such_task`。

### 批量执行

`node_info`、`exec`、`read_file`、`write_file`、`edit_file`、`list_dir`、`stat` 原生支持多个目标：`targets` 参数是节点和节点组的列表，写名字或 UUID，例如 `["web-1", "prod"]`。

- **结果形状只由输入决定，与解析出多少节点无关**：
  - 恰好一个条目，且它不是节点组 → 单个任务，返回单个任务的结果；
  - 多于一个条目，或任何节点组条目（即使只解析到一个节点）→ 一个**任务组**，每个节点一项结果。
  - 批量参数（`parallel`、`fail_fast`）在单任务时被忽略。
- 可选参数：`parallel`（并发数，默认 10）、`fail_fast`（出现失败后不再启动剩余节点）。
- Cluster 核心为一次批量调用创建一个**任务组**，每个节点一个任务，审计中可以按任务组查询。
- `exec` 默认带输出（`with_output: true`，D114）：每节点保留尾部，默认 8KB/128 行；所有节点共享单任务 50KB/2000 行预算；按输出到达顺序分配，预算耗尽后忽略后续节点，允许整个节点被丢弃；完整输出仍在节点文件。
- `exec` 的 `with_output: false`：单任务和批量都只返回状态、退出码和完整输出文件路径（JSON），不返回输出；节点总是把输出落盘。
- 文件操作的任务组固定保留每个节点的**头部**：每节点默认 8KB/128 行，共享同一个 50KB/2000 行预算。`read_file` 的每个节点带自己的行范围和继续偏移，节点之间没有共同的偏移或行数限制；预算耗尽而没有保留内容的节点会在结果里说明，让它单独重读。`write_file`、`edit_file`、`list_dir`、`stat` 没有页面可保留，它们的结果来自任务的 `result`，不受这个预算影响。
- `edit_file` 批量时每个节点各自判断：`old_text` 在某个节点的文件里找不到或不唯一，只有那个节点失败，其余节点照常完成；同一个节点上的多处修改仍然全部生效或都不生效。
- `node_info` 批量时每个节点一项；节点笔记按每节点预算保留开头（默认 8KB/128 行，共享 50KB/2000 行总预算），单个节点时仍是 8KB。
- `read_file` 的继续偏移是 `Use offset=<n> to continue.`：单个任务里它是节点返回的页面的下一行；批量时它是该节点**保留下来的**最后一行的下一行。
- 预算在接收端追加时检查，内存不随节点数增长；被丢弃节点仍会收到 output/exit ack。不优先保留失败节点，失败输出通过节点文件查看。
- **每节点预算**（D112）：`exec` 的 `max_lines` / `max_bytes` 取代默认的每节点 8KB/128 行，可以调小也可以调大，但不超过总预算 50KB/2000 行；例如 `max_lines: 1` 让每个节点只回最后一行，512 个节点也放得下。单任务时它们限制该任务交给模型的尾部，同样不超过 50KB/2000 行。`read_file` 不另设行数参数：`limit` 就是每个节点在节点上读的行数，任务组里同时作为每节点的行数预算（没给时仍是 128 行）；字节用 `max_bytes`。`with_output: false` 又给预算参数时以 `invalid_argument` 拒绝。调大每节点上限时，先输出的节点可能占掉更多总预算，仍按到达顺序分配。
- 离线节点：派发时等待重连的宽限期过后以 `node_offline` 失败（见 [execution-plane.md](execution-plane.md#节点不在线)），并计入 `fail_fast`。
- 部分节点通过、部分授权拒绝时任务独立：已执行任务不回滚，`fail_fast` 只影响尚未启动节点。
- 授权规则逐节点判定；需要审批时，同一个任务组合并成一个审批请求。

### exec 工具的语义

- **长任务**：等待超过 `wait`（agent 默认 10 分钟，MCP 默认 30 秒，最长 10 分钟）时，工具返回目前的输出和"仍在运行，task_id = X"，agent 之后用 `task_wait` 跟进，不会长时间占着一轮工具调用。
- **重启后重新挂接**：所有 crh 任务工具都声明 `replay: "safe"`。Cluster 任务 id 由 durable 工具任务 id 确定性派生，所以服务端重启后工具重跑时，会找到同一个 Cluster 任务（可能仍在运行或已经结束），而不会新建一个。
- **结果为 `unknown` 时**：错误结果，说明"执行失败，状态未知，原因：connection_lost / executor_restarted / dispatch_unconfirmed"。
- **等待审批或签名时**：agent 一直等待，同时通过 `api.details` 把等待状态和链接推送给 UI；MCP 在 `wait` 内等待，超时返回等待状态、链接和 `task_id`。文件工具在两边都一直等待。
- **第一次等待前先推送 id**：任务或任务组创建后、开始等待前，先推送一次 `{ task_id, state }` / `{ task_group_id, state }`，之后等待审批、等待签名时再推送带链接的状态。WebUI 用这个 id 跟进任务的最终状态，工具调用没有结果时也能停下加载圈。MCP 调用者没有 `onStatus`，不推送，也不多读一次任务。

### 交给模型的输出（D112）

**文本返回**用于原文：`exec`（以及跟进它的 `task_wait`）的输出、`read_file` 的页面。结果由两种内容块组成：

- **原文块**：输出或页面的原始文本，不转义、不包在 JSON 里；为空时省略。
- **说明块**：一小段固定格式的文本，说明节点、状态和怎样继续。每一行都用方括号包住，字段之间用 `, `（逗号前无空格、后有一个空格）分隔，不用 `·`（D114），这样客户端把多个块拼在一起显示时也能分清哪些是合成的。例如：
  - `[web-1, exit 0]`
  - `[web-1, exit 2]`、`[web-1, timed out after 30 s]`、`[web-1, killed by SIGKILL]`
  - `[Showing lines 1201-3200 of 3200. Full output: /var/lib/crha/output/<task_id>.log (read it with read_file).]`
  - `[web-1, still running, task_id <id>. Call task_wait with this task_id.]`
  - `[web-1, waiting for approval: <url>, task_id <id>. Call task_wait with this task_id.]`
  - `[web-1:/etc/hosts, lines 1-20 of 20 (end of file)]`、`[web-1:/var/log/syslog, lines 1-2000. Use offset=2001 to continue.]`
  - `[error not_found: open /nonexistent: no such file or directory]`
  - `[task group <id>, 4 nodes, 4 succeeded, 0 failed]`
  - 任务的 `notice`（例如 SSH 节点忽略特权的提示）同样作为一行放进说明块。
- 任务组每个节点各有一个说明块和一个原文块（不把多个节点拼进同一块，节点输出里出现什么文字都不会和分隔混淆），最前面有一个任务组的说明块（任务组 id、节点数、成功和失败数）。

**JSON 返回**用于列表和事实：`list_nodes`、`node_info`、`write_file`、`edit_file`、`list_dir`、`stat`、`task_cancel`，以及 `exec` 的 `with_output: false`。JSON 不缩进。

**`exec` 的输出**：

- 任务的输出只有一个流（D114）：crha 把命令的 stdout 和 stderr 接到同一个管道（即 `2>&1`），SSH 节点在远端 wrapper 里同样重定向；交给模型的是这个流的**尾部** 2000 行或 50KB（先到为准），从整行开始。
- 截断提示以行数为主：输出被截断时，说明块写"第 X–Y 行，共 N 行，完整输出：<路径>"（`Showing lines X-Y of N. Full output: <path>`）。总行数 N 由 crha 在 `task.exit` 中上报（`output_lines`，见 [protocol.md](protocol.md#事件)），X–Y 是 crhs 保留的尾部所在的行。SSH 节点由 crhs 自己数行，没有完整输出文件，说明块写明这一点。没有截断时不写行号。
- 批量带输出时每个节点同样写"第 X–Y 行，共 N 行"。

**`read_file` 的页面**原样返回（保留文件自己的换行）；说明块写页面的行范围；文件总行数只在页面到达文件末尾时报告；没到末尾时写 `Use offset=<n> to continue.`。

**错误结果**：

- 下列情况的结果标记为错误（agent 的 `isError`，MCP 的 `isError: true`），仍然带着已有的输出：工具参数或目标不对、任务失败（`error_code`）、被拒绝、`exec` 退出码非 0、超时、被信号终止、状态为 `unknown`。
- 文本返回的工具在说明块里写 `[error <code>: <message>]`；JSON 返回的工具返回 `{"error": {"code": …, "message": …}}`。工具层自己的错误（参数、目标）也一样带错误码。
- 任务组只要有一个节点失败，整个结果就标记为错误；每个节点的说明块或 JSON 项各自写明成功还是失败。

**给 UI 的 `details`**：agent 的工具结果另外带一个 `details` 对象（`task_id` / `task_group_id`、状态、每个节点的任务 id 和状态、错误码），WebUI 的工具卡片用它链接任务页、判断成功与失败，不再解析模型看到的内容。`details` 不发给模型。MCP 只返回内容块。

## 会话

- 会话属于创建它的用户。会话能做什么，由操作者链上的授权规则决定；设了配额的级别（子会话、计划任务的会话）还受 token 配额限制，见 [access-control.md](access-control.md#授权规则)。
- 会话记录在业务表 `sessions` 中，`conversation_id` 关联 durable 的 Conversation。
- 会话在发送第一条消息时才创建（D117）：`POST /api/sessions { requestId, model, rulePreset, budgetRemaining?, title?, message }` 在一个请求里建会话、提交消息并返回会话。`requestId` 由客户端为每个草稿生成（UUID），同一用户重复提交同一个 `requestId` 返回已建的会话，不再建第二个；提交消息失败时删除刚建的会话和对话，接口返回错误。没有 `message` 的创建请求是 400。
- 标题见下文"模型预设"中的标题生成。
- WebUI 通过 `watch` 订阅会话视图，经 SSE（`/api/sessions/:id/events`）推送增量。
- 开启自动压缩，阈值由模型的上下文窗口决定（参数见下文"默认值"）。
- 用户也可以手动压缩：WebUI 输入框中输入 `/compact [指令]`，或调用 `POST /api/sessions/:id/compact`（`{ instructions? }`，需要 chat 权限）；调用 durable 的 `compact()`，摘要在后台生成，空闲时立即放入、否则在下一轮边界放入；同样计入配额，配额耗尽时拒绝；写审计 `session.compacted`。接口最多等 2 秒返回 `outcome`：`started`（已开始或已完成摘要）、`nothing`（没有可压缩的内容：最近约 2 万 token 的对话消息始终原样保留）、`failed`；WebUI 只在 `nothing` 和 `failed` 时提示。
- 会话可以分享给其他用户或用户组（`view` / `chat`）。被分享的用户发消息时，会话仍以所有者的身份行事，见 [access-control.md](access-control.md#归属访问授权与分享)；实际发消息的用户记录在审计中。

## 模型预设

模型页除了提供方，还列出三项**模型预设**（D116），存在 `model_presets`（每个组织每项一行）：

| 预设 | 模型 | 系统提示词 | 固定附加的协议说明 |
|---|---|---|---|
| 会话 | 不设（每个会话自己选） | 可选 | 工具说明 |
| 自动复核 | 可选，含思考档位；未设时用根会话（或计划任务）的模型和档位，API token 根没有模型时上交给用户（与现在相同） | 可选 | 判定工具 `submit_review` 的定义，以及"必须调用它作答" |
| 标题生成 | 可选；未设时用该会话的模型。思考档位固定为最低：模型支持 `off` 就关闭，否则用它可用的最低一档 | 可选 | 标题的输出格式 |

- 系统提示词 = （自定义提示词，没有时用默认提示词）+ 协议说明。代码里把现在的提示词拆成两段：默认提示词（会话的身份和风格；自动复核的判定标准；标题生成的要求）和协议说明（会话的工具用法；复核的判定工具；标题的输出格式）。协议说明不可编辑。
- 会话的系统提示词之后仍是会话自己的 `instructions`（子会话的委派说明等）。
- 改动从下一次模型请求起对所有会话生效：crhs 把预设缓存在内存，改动时刷新。
- 自动复核用强制工具调用作答：请求带唯一的工具 `submit_review({ decision: "approve" | "escalate", reason: string })` 并以 `toolChoice` 强制调用，判定取自工具参数（按 schema 校验，`reason` 截到 300 字符）。上游忽略 `toolChoice`、没有调用工具时，退回解析正文里的一行 JSON；仍然读不出来就上交给用户。只有明确的 `approve` 才批准。请求带上所用模型的思考档位。
- 原来的 `/settings/review-model`（`server_meta.review_model`）迁到"自动复核"预设，接口改为 `GET/PUT /api/model-presets/:kind`（`kind` = `session` / `review` / `title`，管理员）。

### 标题生成

- `sessions.title` 可以为空，界面显示为 New Session / 新会话（按界面语言，不写进库）。`sessions.title_pending` 表示"需要生成标题"。
- 用户创建的根会话：创建时没给标题则为真，给了则为假。子会话（标题是委派任务的开头）和计划任务的会话（标题是计划任务名）为假。
- 每次运行结束（会话回到空闲，且这次运行有最终正文）而 `title_pending` 为真时，在后台生成标题，不阻塞会话：
  - 输入只有最新一轮的用户输入和模型的最终正文，只取文字（去掉思考、工具调用和工具结果），各截取前 2000 个字符。
  - 输出取第一行，去掉首尾引号和标点，最长 60 个字符；为空视为失败。语言跟随用户输入。
  - 写入时在同一个事务里再检查 `title_pending`：仍为真才写标题并置假，同时更新 `updated_at` 并推送会话更新；用户在生成期间改过标题时丢弃结果。
  - 失败（模型错误、输出为空、配额已耗尽时不生成）只记日志，标记保持为真，下一轮结束后再试。同一会话同时只有一个生成在进行；不持久化，重启后由下一轮触发。
  - token 照自动复核的做法计到该会话（预算和用量都沿链累加），不写 `context_tokens`。
- 用户改标题（`PATCH /sessions/:id { title }`）时 `title_pending` 置假；把标题改成空也置假（显示为默认名，不再自动生成）。
- 迁移时已有会话的 `title_pending` 一律为假（不给旧会话补标题）；标题是旧默认值 `New session` 的改为空。

## subagent

基于 durable 的"由任务拥有的子会话"（参考官方 `test/examples/21-subagent-foreground.ts` 和 `22-subagent-background.ts`）：

- 每个 subagent 都是独立的会话，有自己的授权规则、配额和状态（`idle` / `running` / `awaiting`，见"会话状态"），挂在父会话的操作者链下面。父会话可以给子会话加规则来收紧权限；按照链上"取最严格"的判定方式，子会话无论如何都无法超出父会话的权限。
- 父会话可以给子会话一个 token 配额（防止循环、空跑），不按父级剩余封顶，因为每次响应本来就扣整条链。
- 嵌套深度有上限（默认 2）。最深一级的对话不再向模型提供 `subagent` 工具；已有会话在下一次尝试创建或重跑创建时也会被移除该工具。
- 父会话 abort 时，子会话一并 abort，它们正在运行的任务被取消、等待审批的任务被拒绝。

**当前实现（M3）**：

- `subagent(task, rules?, quota?, background?)` 建立独立会话（`sessions.parent_session_id`），对话是 **ownerless** 的，因此父会话停止等待不会连带终止它；父会话 abort 时由运行时显式取消整棵子树（D75）。
- 前台方式等待答案；子会话的请求交给父会话的 agent 时，等待提前返回，父会话处理后再 `subagent_wait`。`background: true` 立即返回会话 id。
- `subagent_wait(id)`、`subagent_list()`、`subagent_cancel(id)`、`subagent_decide(request_id, decision, reason?, tokens?)` 都已实现；配额请求用 `tokens` 给出要增加的 token 数。
- 工具 `replay: "safe"`：重启后按 durable 任务 id 找回同一个子会话和提交（`sessions.last_submission_id`）。
- 规则是完整的非根规则集，只能收紧；配额是父会话给的管理额度；嵌套最多两层。
- 状态见下文"会话状态"。子会话运行结束（正常完成、拒绝、abort 都一样，不区分原因，看最后一条消息即可）置为 `idle`；只有**新的输入**能把它改回 `running`：输入写入时同时更新 `last_submission_id`，只有最新一次输入结束时才会写 `idle`；读取或重算永远不能把 `idle` 改回 `running` 或 `awaiting`。父会话的提示和打断都以 `sessions.state` 为准。

### 会话状态

根会话和子会话使用同一组状态（`sessions.state`），持久化在数据库中：

| 状态 | 含义 | 进入 | 离开 |
|---|---|---|---|
| `idle` | 没有正在进行的运行 | 创建；最新一次输入的运行结束（完成、拒绝、abort） | 新的输入 → `running` |
| `running` | 有运行在进行 | 输入写入；等待结束 | 运行结束 → `idle`；工具调用开始等待 → `awaiting` |
| `awaiting` | 运行被阻塞，等别人决定 | 配额耗尽暂停（`waiting_kind = quota`，`waiting_level_id` 指向那一级）；本会话的工具调用卡在等审批（`approval`）或等签名（`authorization`）的任务上 | 决定作出 → `running`；运行被拒绝或中止 → `idle` |

- `waiting_kind` 只在 `awaiting` 时有值；配额相关的判断一律看 `waiting_kind = quota`，不能只看 `awaiting`。同一会话同时有多个等待时，配额优先，其次审批、签名；某个等待结束后按剩下的重算。
- 手动压缩（`/compact`）也算一次运行：会话空闲时请求压缩会置为 `running`，压缩任务结束且摘要放入后（或被停止）回到 `idle`；条件更新（`state` 和 `last_submission_id` 都没变时才写）保证不会覆盖期间的新输入或停止；会话本来就在运行时不改状态，由那次运行自己结束。crhs 中途重启时由启动对账置回 `idle`，压缩本身在 durable 中继续。
- 审批和签名的等待由 cluster 的任务状态变化驱动：本会话发起的任务进入 `awaiting_approval` / `awaiting_authorization` 时会话进入 `awaiting`，任务离开这些状态且没有其他等待时回到 `running`。只有真正在等审批的任务才算：`awaiting_approval` 但没有处理者（`handler_type` 为空）只是下发前的瞬间，不是审批等待（见 [execution-plane.md](execution-plane.md#状态机服务端视角)）。
- 同一会话的状态重算串行执行并合并：重算进行中再有请求时只标记"需要再算一次"，当前一次结束后基于最新数据重算，保证最后写入的是最新状态（否则特权任务"进入等待签名 → crhs 自签后立即离开"的两次重算可能乱序，留下过期的 `awaiting`）。
- `root_session_id` 指向会话树的根，用于 WebUI 会话列表按整棵树汇总状态（见 [webui.md](webui.md) 的 API 约定）。树里任何会话的状态变化都会推送它的根会话。
- **启动对账**：crhs 启动时（durable 恢复运行之后、开始接受请求之前）逐个修正状态缓存：
  - 记为 `running` / `awaiting` 的会话，如果 durable 中它最新一次输入已经结束，置为 `idle`；
  - 有未结束输入的会话，按配额等待、任务表中仍在 `awaiting_approval` / `awaiting_authorization` 的任务重算为 `awaiting`，否则为 `running`；
  - 记为 `idle` 但 durable 中仍有未结束输入的，置为 `running`。

  对账的每次修正都写日志，不写审计。
- **没人处理的等待**：会话停止或运行结束后，它留下的审批等待和签名等待已经没有工具调用在等，必须结束：
  - **停止会话**（含子会话树）：
    - 审批等待按拒绝处理，签名等待按取消处理；
    - 已下发、运行中的任务一并取消；
    - 原因写 "the session was stopped"；
    - 停止期间运行结束时，不再按"运行结束"重复处理。
  - **运行结束**（最新一次输入的运行结束时）：工具调用可能已经不在了（被 durable 中止，或重启后被放弃），但它的任务仍在等待。此时结束这些等待，原因写 "the session's run ended"。
  - **启动时**：在上面的状态对账之后，找出发起者是会话、且会话已经 `idle` 的 `awaiting_approval` / `awaiting_authorization` 任务和任务组（包括运行中任务组里等待签名的成员），用同样的方式结束。这一步只读取处于等待状态的行。
  - **Harness 重新打开后**：失败的 Harness 丢弃了所有等待，重新打开后先做同样的状态对账，再按启动时的方式结束这些等待。
  - 不属于任何会话的任务（用户本人或 API token 发起）不受影响，签名等待只按 24 小时期限结束（见 [privilege.md](privilege.md#等待签名的期限)）。

### 前台与后台

- `subagent(task, rules?, quota?, model?)` 以前台方式启动子会话，等待它完成并返回答案。
- 前台等待**可以被打断**，打断后子会话自动转入后台继续运行（或暂停等待处理），工具立即返回子会话 id 和打断原因。打断的原因包括：
  - 子会话需要父会话处理的请求（审批）；
  - 用户在 WebUI 中打断；
  - 等待超过时限。
- 父会话处理完之后，显式调用 `subagent_wait(id)` 继续等待。

### 处理子会话的请求

- 任务开始等待审批后，运行时从直接父会话起沿规则链向上找第一个"对这一操作的有效结果是 allow"的祖先会话，请求交给它的 agent（`approval.agent = { session, state: "pending" }`，并记入 `handler_type` / `handler_session_id`）。根会话的 agent 同样是这条链上普通的一级；祖先都不是 allow，或者 agent `escalate` 时，请求才到用户。
- 处理请求的 agent 用 `subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?)` 处理：批准/拒绝直接落到任务上（审计里 actor 是处理它的会话）；`escalate` 把请求交还用户，审批页照常显示。
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
| 命令输出交给模型 | stdout 和 stderr 合并，尾部 2000 行或 50KB，先到为准；原文直接交给模型，截断说明另给 | 相同；输出本来就只有一个流（D114），截断时写"第 X–Y 行，共 N 行，完整输出：<路径>"（D112） |
| 完整输出落盘 | 超过上述阈值时写入系统临时目录（`pi-bash-*.log`，0600），不自动清理 | 超过相同阈值时由 crha 写入 `crha.toml` 配置的输出目录 `<state_dir>/output/`（`[output].dir` 未设置时的默认；示例布局为 `/var/lib/crha/output/`，0600），按 7 天、1GB 清理 |
| 命令超时 | 无默认超时 | 相同（`timeout` 可选）；另有 `wait`（默认 10 分钟）只决定工具何时返回，不终止任务 |
| 读文件 | 从头 2000 行或 50KB，用 `offset` / `limit`（行号）分页 | 相同；节点按行分页（一次 `file.read` 从第 `offset` 行起读 `limit` 行，整页不超过 50KB），结果原样返回页面字节（保留文件自己的换行），截断时给出 `Use offset=<n> to continue.`；总行数只在页面到达文件末尾时报告；起始行本身超过 50KB 时报错并指向 `exec`（例如 `sed -n '<N>p' <路径> \| head -c 51200`）；起始行超过文件末尾也是错误，并给出总行数 |
| 列目录 | 500 项或 50KB | 相同 |
| grep / find | 100 条匹配（单行 500 字符）/ 1000 条结果 | 暂不提供专门工具，用 `exec` |
| 自动压缩 | `reserveTokens` 16384，`keepRecentTokens` 20000 | 相同 |
| 模型请求重试 | 3 次，基础间隔 2 秒，服务端要求的等待最长 60 秒 | 相同 |

节点笔记在 `node_info` 中截断到 8KB（pi 没有对应项），因为每次调用都会返回。

## 配额

- 配额（预算的上限）是管理会话用量（防止循环、空跑、无人值守的运行失控）的手段：`sessions.quota_tokens` 是有符号 64 位整数，表示剩余 token；任何一级都可以不设（`null` 不限，也不扣减）。用户创建的根会话默认 `null`；计划任务创建的会话在根上设为 `token_budget`（见 [scheduling.md](scheduling.md#授权规则与配额)）；子会话由父会话在创建时给出（D92，修订 D76）。
- **两个度量，名字分开**（D101）：会话上有两个 token 计量，含义不同，名字也必须不同。
  - **预算**（`sessions.budget_used_tokens`，API 的 `budgetUsedTokens`）：只计模型的**输出 token**（含推理），不计输入和缓存。计入的调用包括会话的每次响应、上下文压缩（durable 的 `CompactionTask`）和 Auto Review（计入被审查任务所属的会话；没有会话的根，例如 API token，不计）。预算因此约束的是"做事量"而不是成本：输入（上下文、工具返回）不受限制。
  - **统计用量**（`sessions.usage_tokens`，API 的 `usageTokens`）：计每一次模型调用的**输入 + 输出**，输入包含 cache read 和 cache write。同样包括会话自己的调用、它的 subagent、压缩和 Auto Review。它在链上逐级累加，所以根显示整棵树。
  - 上游没有上报用量时，两个度量用同一个估算常数：输出按输出内容（文本、可见的推理文本、工具调用名和参数 JSON）的 UTF-8 字节数 × 0.3 估算，向上取整；统计用量的输入按**这次调用实际发出的请求内容**的 JSON 字节数 × 0.3 估算。生成（durable 的 `GenerationTask`）只拿得到请求的 `messages`，估算的就是它的序列化字节，**不包含**系统提示的 sections 和工具定义；压缩和 Auto Review 走 `completeSimple`，估算的是交给它的请求，即系统提示加消息。常数 `ESTIMATED_TOKENS_PER_BYTE = 0.3` 只在一个模块里定义（`server/src/agent/tokens.ts`），两个估算都从这里取。
  - **上下文填充**（`sessions.context_tokens`，API 的 `contextTokens`）：本会话**最近一次主 agent 模型调用**的输入大小（input + cache read + cache write）；压缩和 Auto Review 不写它，第一次调用前为 `null`。WebUI 用会话模型的 `contextWindow` 算百分比。上游没有上报时同样按这次调用实际发出的请求内容估算（生成只有 `messages`，压缩和评审是系统提示 + 消息，基准与统计用量相同）。
  - 两个度量互不影响：预算决定何时暂停，统计用量只用于展示，永远不阻止运行。
- 每次模型调用之后（durable 1.4.0 没有请求前的拦截点，D72），把这次调用按预算口径计得的 token 从该会话以及链上**每一个设了配额的级别**（含根）扣减；同一笔调用的统计用量累加到同样的那些级别。配额可以为负，负值准确记录这次超出。`budget_used_tokens` 和 `usage_tokens` 在所有级别累计。
- 已有数据：迁移只改列名并新增两列（预算值原样保留，统计用量从 0 开始）。统计用量在下次启动时用 durable 每个对话持久化的 `pi.usage` 回填（代数求和，再按会话树累加；只升不降），一次性标记写在 `server_meta`。durable 没有记录的调用（Auto Review 自己的请求，以及已经被丢弃的文档）无法回填，只能从 0 起算。
- 验收与查看：`server/test/token-measures.test.ts` 覆盖两个度量独立累加、估算常数和上下文只来自主调用；WebUI 会话页的输入框页脚显示剩余预算、上下文百分比和总用量。审批页的"额度用尽"项（`GET /api/approvals` 的 `quotas[]`）也用 `budgetRemaining` / `budgetUsedTokens` 两个名字。
- 所有设了配额的级别剩余都 **> 0** 才继续。任何一级不满足，下一次工具调用**暂停**，会话的状态变为 **`awaiting`**（`sessions.state`，`waiting_kind = quota`，`waiting_level_id` 指向那一级），并**只向那一级的直接上级**报告（不跳过任何一级）：
  - 耗尽的是子会话：由它的直接父会话的 agent 用 `subagent_decide(request_id, "approve", tokens: N)` **增加** N（加法；**不按父级剩余封顶**——每次响应本来就扣整条链，封顶没有意义），或者 `deny` 结束暂停的运行。父会话是根时，由根会话的 agent 决定。
  - 耗尽的是根：由会话所有者在 WebUI 处理（审批页的"额度用尽"，计入顶部待办数；以及会话页），同样是增加 N 或拒绝；处理记入审计（actor 是用户）。
- 拒绝后暂停的工具调用立即结束，运行结束后会话置为 `idle`，读取或重算不会把它改回 `awaiting`；每次重新耗尽都是新的一次暂停，会再次通知那一级的处理者（状态定义见"会话状态"）。
- 配额可以在创建时给出（`POST /api/sessions { budgetRemaining }`、`subagent(..., quota)`），也可以由所有者用 `PATCH /api/sessions/:id { budgetRemaining }` 替换剩余量（含根，`null` 取消限制）。
- 只计算 token，不计算任何货币成本；不设用户级或组织级配额。

## 节点笔记

节点笔记就是**节点上的一个普通 Markdown 文件**，人和 LLM 都可以直接读写。

- 位置在 crha 配置中设置（`crha.toml` 的 `notes`；未设置时是配置的 `state_dir` 下的 `NOTES.md`，示例布局为 `/var/lib/crha/NOTES.md`，属主为非特权模式的运行用户），通过 `Facts` 上报；SSH 节点在 crhs 的节点配置中设置路径。
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
