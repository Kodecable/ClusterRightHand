# 数据表草案

同时支持 SQLite 和 PostgreSQL，因此：

- 主键统一使用 UUIDv7，以 TEXT 存储（PG 中可用 `uuid` 类型，由 Kysely 方言处理）。
- JSON 字段在两种方言中都存 `TEXT`（JSON 文本）；只在应用层解析，不依赖数据库的 JSON 查询能力。不用 `jsonb`：它会拒绝孤立代理项并重排键。
- 时间统一存 UTC，两种方言都用 ISO 8601 文本（不用 `timestamptz`）。
- 迁移用 Kysely Migrator，每个迁移对两种方言都要能跑。SQLite 的 DDL 本身是事务性的，但 Kysely 的 `SqliteAdapter` 报告不支持事务性 DDL；`server/src/storage/migrate.ts` 在这个 Kysely 实例的适配器上打开该标志，所以一批待执行的迁移（含迁移记录的写入）在同一个 `BEGIN IMMEDIATE` 事务里运行，中途失败时 schema 和迁移记录都保持原样。迁移里的表重建照常遵守 `PRAGMA foreign_keys = ON`：需要丢父表时先把依赖它的数据读入内存或暂存到没有外键的表（0036 先读出旧的组缓存，0038 暂存并重建 `node_group_members`），没有迁移需要临时关闭外键。PostgreSQL 本来就把整批迁移放在一个事务里，行为不变。

durable 的表由 `SqlStorage` 管理，统一加 `pi_` 前缀，不在本文档中列出（唯一的例外是会话内容搜索在 `pi_entries` 上加的生成列，见下节）。

SQLite 只有一个数据库文件，业务表（Kysely）和 durable 的 `pi_` 表是两条连接打开的同一个文件。node:sqlite 是同步的，两条连接不能各自等锁：写锁被别人占着时 busy handler 会阻塞必须提交那个事务的线程，而 WAL 里先读后写的延迟事务会立即得到 `SQLITE_BUSY_SNAPSHOT`（busy handler 不参与）。所以进程内所有语句走同一个队列，事务（Kysely 的以 `BEGIN IMMEDIATE` 开始）占用队列直到提交或回滚。PostgreSQL 不受影响。两条连接都使用 WAL + `synchronous = NORMAL`：进程崩溃不丢已提交的事务；断电或系统崩溃可能丢失最后几个已提交的事务，但数据库不会损坏。需要更强保证时使用 PostgreSQL。

推荐 PostgreSQL ≥ 14。crhs 每次启动检查 `pi_entries.record` 的压缩方式，不是 lz4 时设为 lz4（只影响之后写入的值，超过约 2 KB 的行才会被压缩）；PostgreSQL 低于 14 或编译时未带 lz4 时跳过并告警；已有的行保持原来的压缩方式，不自动重写。SQLite 没有透明压缩，适合调试和小规模安装，不是推荐的部署方式。

## 会话内容搜索

只有 PostgreSQL 支持消息内容搜索（`GET /api/sessions/search`，见 [webui.md](webui.md#会话内容搜索)）；SQLite 只搜标题。pg-durable 的 PostgreSQL 适配器在 schema 版本 2 中增加：

```sql
CREATE FUNCTION <prefix>entry_search_text(record text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ ... $$;
ALTER TABLE <prefix>entries ADD COLUMN search_text TEXT
  GENERATED ALWAYS AS (<prefix>entry_search_text(record)) STORED;
```

- 默认前缀 `pi_` 时函数是 `pi_entry_search_text`，列是 `pi_entries.search_text`。函数解析 `record::jsonb`，返回按 `\n` 拼接的文本：`pi.user` 条目里 role 为 `user` 的消息（`content` 是字符串时取该字符串，是数组时取 `type = "text"` 的项的 `text`），以及 `pi.assistant` 条目里的 `text` 块。thinking、toolCall、toolResult、system、compaction 都不参与；没有文本时返回 NULL。每一步都先做 `jsonb_typeof` 检查，形状不符合预期（例如 `model` 不是数组、`text` 不是字符串）时得到 NULL，而不是报错。结果截断到 32768 字符，搜索只在这段文本上进行。
- 记录本身仍以 TEXT 原样保存，这里只是在生成列里解析；不回写也不改变 `record`。生成列随 INSERT 自动计算，适配器的 INSERT 已列出显式列，因此不需要改写入路径；读取路径也不依赖它。
- 已有数据库在下一次 `PgStorage.open()` 时通过 `durable_schema` 的版本 2 迁移得到函数和列（与建库走同一批迁移）。`ADD COLUMN ... STORED` 会重写 `pi_entries` 并计算所有历史记录：大表升级需要额外的时间和磁盘，升级期间该表被锁。每条 user/assistant 记录会额外存一份最多 32768 字符的文本（UTF-8 下最多约 128 KiB，走 TOAST 压缩），这是搜索换来的空间开销。
- 搜索目前是 `lower(search_text) LIKE '%关键词%'` 的扫描；`search_text` 上没有索引。内容量变大时先评估 `pg_trgm` 扩展的 GIN 索引（`gin (search_text gin_trgm_ops)`）；仍不够再考虑 `tsvector`/FTS（会改变分词和子串匹配的语义）。

## 用户与归属

```
orgs              (id, name, created_at)
users             (id, org_id, username, display_name, email, kind[admin|member],
                   password_hash nullable, status, created_at)        -- 以后的 OIDC 用户可以没有密码
user_groups       (id, org_id, name, source, created_at)              -- source：local；以后可以是外部来源（OIDC）
user_group_members(user_group_id, user_id, created_at)
user_credentials  (id, user_id, kind[ssh|webauthn], public_key, fingerprint, label, created_at, last_used_at)
api_tokens        (id, org_id, user_id, name, token_hash, created_at, expires_at nullable, revoked_at, last_used_at)
                  -- token 为 crh_ + 32 字节随机数，只存 SHA-256；MCP 规则链的根，规则在 rule_sets
web_sessions      (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
                  -- cookie 中是随机令牌，表中只存它的 SHA-256
shares            (id, org_id, resource_type[session], resource_id,
                   grantee_type[user|user_group], grantee_id,
                   access,                                             -- 会话：view|chat
                   created_by_user_id, created_at)
                  -- unique (resource_type, resource_id, grantee_type, grantee_id)；节点不再分享，见 node_access_grants
```

以后接入 OIDC 时增加 `user_identities (user_id, provider, subject)`，见 [access-control.md](access-control.md#扩展预留oidc)。

## 节点

```
nodes             (id, org_id, name, transport[client|ssh], status[pending|active|disabled],  -- name 见 D109；在线与否由连接推出，不存表
                   public_key,                 -- client 节点
                   ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_credential_id,   -- ssh 节点；ssh_host_key 为 SHA256 指纹
                   ssh_jumps json,                                                   -- 跳板列表，每一跳带自己的主机密钥和凭证
                   privileged_mode[forward|native|ignore|reject], run_identities json,  -- 两种模式各自的运行身份
                   trust_summary json, trust_digest,                                   -- crhs 缓存的 TrustSummary；连接时查询、变化时推送
                   notes_path,                                                         -- 节点笔记路径（Facts 上报，SSH 节点手动配置）
                   facts json, client_version, last_seen_at, created_at)
node_groups       (id, org_id, name, created_at, updated_at)            -- 管理员在 crhs 中维护；crha 节点和 SSH 节点相同
node_group_members(node_group_id, node_id)
node_access_grants(id, org_id, grantee_type[user|user_group], grantee_id,
                   target_type[node|node_group], target_id,
                   created_by_user_id, created_at)
                  -- 访问授权；一个被授权方对一个目标一行，只有一个级别（查看并执行）
                  -- unique (grantee_type, grantee_id, target_type, target_id)
ssh_credentials   (id, org_id, name, public_key, secret_id, created_at)  -- 属组织、仅管理员；私钥在 secrets 中
enrollment_tokens (id, org_id, created_by_user_id, token_hash, name_hint, expires_at, used_at, used_by_node_id)
                  -- 由管理员创建；注册后的节点属于组织，先处于 pending，由管理员确认后才可用
server_meta       (key, value)                                        -- 例如 master_key_id：防止配错主密钥文件
secrets           (id, org_id, kind, ciphertext, created_at)          -- 用主密钥加密：SSH 私钥、模型 API key、
                                                                       -- crhs 身份私钥、授权签名私钥（不用 ssh-agent 时）
```

`nodes` 和 `node_groups` 共用一个名字空间：名字不区分大小写，唯一性和查找都按小写比较，显示保留原样。概念上的唯一约束是两张表合起来 `unique (lower(name))`：节点不能与节点组同名，节点之间、节点组之间也不能重名。这是跨表的约束，由应用层在写入和迁移时检查，不能只靠单表索引。名字只用于输入和显示；内部引用（`rule_sets.rules[].nodes`、`node_access_grants`、`task_groups.targets` 等）一律存 UUID，`_all` 原样保存。

## 任务

```
task_groups       (id, org_id, targets json, node_ids json, kind, parallel, fail_fast,
                   -- targets 存节点 / 节点组 UUID（或 `_all`）；node_ids 是展开后的节点 UUID
                   output_mode[status|text|head],                     -- 批量输出模式；exec 新建默认 status（M3.5 之前的组为 text），文件操作固定 head
                   node_max_lines nullable, node_max_bytes nullable,  -- 每节点输出预算（D112）；null 为默认 128 行 / 8KB
                   skipped json,                                      -- 因 fail_fast 或中断而未启动的节点
                   rule_chain json nullable, approval json nullable,  -- 一个任务组只审批一次
                   spec json nullable, timeout_ms nullable, pending_input nullable,
                                                                      -- 等待审批时暂存要执行的内容
                   root_session_id nullable,                          -- 规则链根会话，按会话树查等待项
                   handler_type[agent|user] nullable,                 -- 等审批时谁处理；user 即 on_behalf_of_user_id；
                                                                       -- null 表示不在等审批（批准后、启动/下发前的形状）
                   handler_session_id nullable,                       -- handler_type=agent 时处理的会话
                   state[awaiting_approval|awaiting_authorization|running|finished|interrupted|rejected|cancelled],
                                                                      -- interrupted：重启中断；cancelled：会话停止/工具调用中止时取消；
                                                                      -- 已创建但未下发的成员任务以 cancelled 结束
                   actor_type, actor_id, on_behalf_of_user_id, created_at, finished_at)
tasks             (id, org_id, node_id, task_group_id nullable, kind, spec json, input_size, input_sha256,
                   privileged, attempt, timeout_ms, output_mode[full|text|status|head],  -- 单任务 full；组内任务随组
                   max_lines nullable, max_bytes nullable,            -- 本任务的输出预算（D112）；组内任务随组，单任务 null 为 2000 行 / 50KB
                   state[awaiting_approval|awaiting_authorization|denied|dispatched|running|exited|failed|rejected|unknown],
                   exit_code, signal, timed_out, cancelled,
                   error_code, error_message,                         -- 执行器错误码、拒绝原因或 unknown 的原因（如 policy_denied、approval_rejected、approval_required、node_offline、node_deleted）
                   actor_type, actor_id, on_behalf_of_user_id,
                   rule_chain json nullable,                          -- 从根开始的规则链；用户本人操作时为空
                   approval json nullable,                            -- 规则判断记录（每一级），以及审批决定：结果、决定者、时间、理由
                   pending_input nullable,                            -- 等待审批/授权时暂存的输入（base64）
                   root_session_id nullable,                          -- 规则链根会话，按会话树查等待项
                   handler_type[agent|user] nullable,                 -- 等审批时谁处理；user 即 on_behalf_of_user_id；
                                                                       -- null 表示不在等审批（批准后、启动/下发前的形状）
                   handler_session_id nullable,                       -- handler_type=agent 时处理的会话
                   authorization json nullable,                       -- M4：授权状态、方案、payload id、trust digest
                   created_at, dispatched_at, accepted_at, finished_at,
                   output_bytes,                                      -- 输出只有一个流（D114，迁移前的 stdout_bytes + stderr_bytes）
                   output_head, output_tail,                          -- crhs 只保存截断后的头尾（base64）；交给模型的是尾部。迁移前的任务按 stdout 在前、stderr 在后拼接
                   notice nullable,                                   -- crhs 自己的提示（SSH 忽略特权），不进输出流
                   output_lines nullable,                             -- 合并输出的总行数（crha 在 task.exit 上报；SSH 节点由 crhs 统计）
                   output_file nullable,                              -- 完整输出在节点上的路径（crha 保存）
                   result json nullable,                              -- 文件任务的结构化结果（protocol.md TaskResult）
                   late_result nullable,                              -- 已报告 unknown 之后才到达的真实结果
                   rev)                                               -- 行版本（D118，迁移 0048）：每次写 tasks 都加一；基于较早读取的写入会比较它，不一致时不覆盖
```

crhs 不保存完整输出。批量默认 `status` 只保存状态和输出文件路径；`text` 受单节点和总预算限制。完整输出由 crha 在节点上保存为普通文件并负责清理，见 [execution-plane.md](execution-plane.md#输出)。SSH 不保存完整输出。

`tasks.node_id` 没有外键：节点行删除后任务历史仍在。删除节点时 crhs 负责结束该节点上还在 `awaiting_approval` / `awaiting_authorization` 的任务（`failed` / `error_code = node_deleted`），否则它们永远等不到下发；审批时节点已不存在也按同一错误结束（见 [execution-plane.md](execution-plane.md#状态机)）。

`tasks.spec` 和 `task_groups.spec` 是创建时的 JSON 形式，按当时的协议版本解释。协议大版本 2 把 `file.read` 的 JSON 字段从 `offset` / `limit` 改为 `startLine` / `lineCount`：升级前创建、仍在等待审批或签名的这类任务和任务组无法下发，读取时以 `stored spec cannot be read` 失败。D114 给 `file.write` 增加了 `createParentDirs`：迁移把已存的 `file.write` 规格都补上 `"createParentDirs": false`，所以旧任务照常可读。

## 规则与授权

```
authorizations    (id,                                   -- SHA-256(CBOR(payload))
                   org_id, payload blob, signatures json, -- 同一 payload 上的多个签名；用户 + crhs 联署
                   nodes json, command_match json nullable,  -- 节点 / 节点组 UUID，或 ["*"]
                   deadline nullable,                     -- ISO 8601；只有 D103 之前的旧行可能为 null
                   task_id nullable,                      -- task_id：一次性授权绑定的任务
                   attempt,                               -- 同一 task_id 的授权尝试
                   created_at)
rule_sets         (id, org_id, scope_type[session|schedule|api_token], scope_id,
                   rule_preset[ask|auto_review|yolo] nullable,     -- 规则预设（D116 前叫 preset），只有根有，决定 default 和基础规则
                   default_action[allow|inherit|require-approval|deny], rules json, updated_at)
                  -- 授权规则，见 access-control.md；rules[].nodes 存节点 / 节点组 UUID 或 `_all`；用户和组织没有规则；配额在 sessions
```

审批结果保存在工具调用（`tasks` / `task_groups`）上，不单独建表；"以后都允许"是对 `rule_sets` 的修改。等待中的审批用 `root_session_id` 归属会话树，用 `handler_type` / `handler_session_id` 记录当前处理者（agent 会话，或 `on_behalf_of_user_id` 用户），前端和重启重建都按它查询。

`authorizations` 每个 payload 一行，`signatures` 保存同一对象上的用户签名和 crhs 联署，不再有 `cosign_of`。授权只用于展示和复用：所有授权都带 `deadline`，没有吊销；需要收回权限时改节点的信任配置（见 [privilege.md](privilege.md#紧急处置)）。

## Agent

```
sessions          (id, org_id, owner_user_id, conversation_id, parent_session_id nullable,
                   title nullable,                      -- 为空时界面显示 New Session / 新会话（D116）
                   title_pending,                       -- 需要生成标题；生成成功或用户改过标题后置假
                   create_request_id nullable,          -- 创建请求的 requestId，(owner_user_id, create_request_id) 唯一（D117）
                   model json,                          -- { provider, modelId, thinkingLevel? }
                   status, created_at, updated_at, archived_at,
                   schedule_id nullable,                -- 由计划任务创建的根会话；计划任务删除后置空
                   last_submission_id nullable,         -- 最近一次输入；父会话靠它 subagent_wait
                   quota_tokens nullable,               -- 剩余 token 配额，有符号；null 不限且不扣（用户创建的根默认）
                   root_session_id,                     -- 所在会话树的根（根会话为自身），列表按树汇总状态用
                   state[idle|running|awaiting],        -- 运行状态（见 agent-runtime.md "会话状态"），启动时对账
                   waiting_kind nullable[quota|approval|authorization], -- awaiting 时在等什么
                   waiting_level_id nullable,           -- waiting_kind = quota 时：要补的那一级
                   waiting_handler_id nullable,         -- 该等待的直接父会话（处理它的 agent）；根耗尽时为空，由所有者处理
                   state_changed_at,
                   reply_at nullable,                   -- 根会话：整棵树上次从 running 变为 idle/awaiting 的时间（有新的输出给所有者）
                   owner_read_at nullable,              -- 根会话：所有者上次打开这棵树的时间；reply_at > owner_read_at 即未读
                   budget_used_tokens,                  -- 预算口径：本会话及其 subagent 的输出 token（D101）
                   usage_tokens,                        -- 统计口径：本会话及其 subagent 的输入 + 输出 token（D101）
                   context_tokens nullable,             -- 本会话最近一次主 agent 调用的输入大小；第一次调用前为 null
                   stat_turns, stat_steps,              -- 会话统计（agent-runtime.md#会话统计）：本会话的轮数和主 agent 调用数
                   stat_ttft_ms, stat_ttft_steps,       -- 首字时间总和与观察到的 step 数（平均 TTFT 的分子/分母）
                   stat_decode_ms, stat_decode_tokens,  -- 首字之后的解码时间总和与输出 token 数（解码速度的分子/分母）
                   counted_submission_id nullable,      -- 已计入 stat_turns 的最近提交；同一提交的后续 step 不再加轮
                   prompt_tokens, cache_read_tokens)    -- 整棵树的输入（input + cache read + cache write）和 cache read token
                   -- 规则在 rule_sets
model_providers   (id, org_id, provider_id, kind[builtin|custom], builtin, name, base_url,
                   secret_id, models json, headers json, session_id json nullable, enabled)
                  -- builtin = Pi 内置，custom = 自定义（D115，取代 openai-compatible）；key 在 secrets；
                  -- headers 只放网关路由头，不放凭据；session_id = { headers?, body? }：填 crh 会话 id 的字段；
                  -- models（仅 custom）：[{ id, name?, api, contextWindow, maxTokens, input, thinking?, compat? }]
model_presets     (org_id, kind[session|review|title], model json nullable, system_prompt nullable, updated_at)
                  -- 模型预设（D116），主键 (org_id, kind)；session 的 model 恒为空；取代 server_meta.review_model
```

> 两个 token 度量见 [agent-runtime.md](agent-runtime.md#配额)（D101）：`budget_used_tokens` 只计输出、决定配额何时暂停；`usage_tokens` 计输入 + 输出、只用于展示，两者都在链上累加。`context_tokens` 只由主 agent 的模型调用写入，压缩和 Auto Review 不写。上游没有上报用量时，输入按调用实际发出的请求内容估算：生成只有请求的 `messages`，压缩和 Auto Review 是系统提示加消息。`stat_*` 与 `counted_submission_id` 只描述本会话的主 agent 调用（`prompt_tokens` / `cache_read_tokens` 除外，它们和 `usage_tokens` 一样按树累加），定义与回填见 [agent-runtime.md](agent-runtime.md#会话统计)。

## 计划任务

```
schedules         (id, org_id, owner_user_id, name, prompt, model json,
                   token_budget nullable,             -- 每次运行新会话根上的配额；null 不限
                   cron, timezone, catch_up, enabled, next_run_at nullable,
                   created_at, updated_at)
                  -- 规则预设和规则在 rule_sets（scope_type = schedule）
schedule_runs     (id, schedule_id, fire_time, manual,
                   status[pending|running|succeeded|failed|preempted],
                   session_id nullable,               -- 由 run id 派生，重新提交是幂等的
                   reason nullable, created_at, started_at nullable, finished_at nullable)
                  -- unique (schedule_id, fire_time)；删除计划任务时一并删除，会话保留
```

## 审计

```
audit_events      (seq, id, org_id, ts, actor_type, actor_id, on_behalf_of_user_id,
                   action, target_type, target_id, detail json)
                  -- seq 由数据库生成（SQLite rowid / PostgreSQL identity bigint），单调递增，审计只追加写入，见 access-control.md#防篡改
```

## 保留期

`crhs.toml` 的 `[retention]` 表决定旧行何时被清理：

```toml
[retention]
tasks = "90d"    # 任务、任务组、授权；"off" 表示永久保留
audit = "180d"   # 审计事件；"off" 表示永久保留
pi_tasks = "7d"  # durable 已结束的运行记录；"off" 表示永久保留
```

- `tasks`（默认 `90d`）同时作用于 `tasks`、`task_groups` 和 `authorizations`；`audit`（默认 `180d`）作用于 `audit_events`；`pi_tasks`（默认 `7d`）作用于 pi-durable 的 `pi_tasks`。值可以是 `ms` / `s` / `m` / `h` / `d` 组合的时长（如 `1d12h`），`off` 表示不清理。
- 除 `off` 外最短 1 天，配置更短会启动失败。durable 工具调用在崩溃后重跑时按任务 id 重新挂到原来的集群任务（`cluster/task-dispatch.ts` 的 `createTask`）；如果任务行已被删掉，同一条命令会被再次下发。
- `tasks`：只删终态（`exited`、`failed`、`rejected`、`unknown`、`denied`）且 `finished_at < 截止时间`的行；非终态（等待审批/授权、已下发、运行中）和 `finished_at` 为 NULL 的行无论多老都保留。
- `task_groups`：只删终态（`finished`、`interrupted`、`rejected`、`cancelled`）且 `finished_at < 截止时间`的行。
- `authorizations`：删 `deadline < 截止时间`的行（D103 起每条授权都有截止时间）；`deadline` 为 NULL 的旧行保留。
- `audit_events`：删 `ts < 截止时间` 且 `seq <= max(seq) - 16384` 的行。保留最新 16384 个序号（按序号距离，不按行数，允许空洞）：SQLite 的 `seq` 是 rowid（没有 AUTOINCREMENT），删空表后编号会从头开始；时钟大幅前跳时也不会把整份日志清空，持有 `max(seq)` 的行永远不会被删。
- `pi_tasks`：只删 `status = 'terminal'` 且任务记录中数字 `endedAt < 截止时间`（epoch 毫秒）的行；同一事务里先删它的任务范围文档（`pi_documents` 中 `scope_kind = 'task'`、`owner_id` 为该任务的行）及其 `pi_document_revisions`，再删任务行。以下行无论多老都保留：非终态（`pending`、`running`、`waiting`、`sleeping`、`completing`，`completing` 仍是活任务）；没有数字 `endedAt` 的终态记录；仍被未结束任务引用为 `owner`、出现在等待任务 `state.on` 中、或作为某个会话的 `owner_task_id` 的终态任务。对话内容在 `pi_entries`，不在此列。
- pi-durable 没有删除接口，`pi_tasks` 这一步是在其存储约定之外的操作：它依赖“重启恢复和任务图只扫描未结束任务”“未结束任务及其会话的引用不会被终结”“1 天下限晚于 `waitForTask` 对刚取得的 id 的等待”等不变量。升级 pi-durable 时必须重新核对任务状态、记录中的 `owner` / `state.on` / `endedAt`、会话 owner 列和文档表结构；有官方删除接口就改用它。
- 清理在启动后不久运行一次，之后每小时一次；每次按 1000 行一批（先查主键，再按键删除），批间让出事件循环。关闭时在批间中止并等待当前清理结束。`pi_tasks` 按 id 游标顺序扫描，整批没有可删的行是正常的，会继续扫描下一批。
