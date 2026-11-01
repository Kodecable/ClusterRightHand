# 数据表草案

同时支持 SQLite 和 PostgreSQL，因此：

- 主键统一使用 UUIDv7，以 TEXT 存储（PG 中可用 `uuid` 类型，由 Kysely 方言处理）。
- JSON 字段在两种方言中都存 `TEXT`（JSON 文本）；只在应用层解析，不依赖数据库的 JSON 查询能力。不用 `jsonb`：它会拒绝孤立代理项并重排键。
- 时间统一存 UTC，两种方言都用 ISO 8601 文本（不用 `timestamptz`）。
- 迁移用 Kysely Migrator，每个迁移对两种方言都要能跑。

durable 的表由 `SqlStorage` 管理，统一加 `pi_` 前缀，不在本文档中列出。

SQLite 只有一个数据库文件，业务表（Kysely）和 durable 的 `pi_` 表是两条连接打开的同一个文件。node:sqlite 是同步的，两条连接不能各自等锁：写锁被别人占着时 busy handler 会阻塞必须提交那个事务的线程，而 WAL 里先读后写的延迟事务会立即得到 `SQLITE_BUSY_SNAPSHOT`（busy handler 不参与）。所以进程内所有语句走同一个队列，事务（Kysely 的以 `BEGIN IMMEDIATE` 开始）占用队列直到提交或回滚。PostgreSQL 不受影响。

## 用户与归属

```
orgs              (id, name, created_at)
users             (id, org_id, username, display_name, email, kind[admin|member],
                   password_hash nullable, status, created_at)        -- 以后的 OIDC 用户可以没有密码
user_groups       (id, org_id, name, source, created_at)              -- source：local；以后可以是外部来源（OIDC）
user_group_members(group_id, user_id, created_at)
user_credentials  (id, user_id, kind[ssh|webauthn], public_key, fingerprint, label, created_at, last_used_at)
api_tokens        (id, org_id, user_id, name, token_hash, created_at, expires_at nullable, revoked_at, last_used_at)
                  -- token 为 crh_ + 32 字节随机数，只存 SHA-256；MCP 规则链的根，规则在 rule_sets
web_sessions      (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
                  -- cookie 中是随机令牌，表中只存它的 SHA-256
shares            (id, org_id, resource_type[node|session], resource_id,
                   grantee_type[user|user_group], grantee_id,
                   access,                                             -- 节点：view|operate；会话：view|chat
                   created_by_user_id, created_at)
                  -- unique (resource_type, resource_id, grantee_type, grantee_id)
```

以后接入 OIDC 时增加 `user_identities (user_id, provider, subject)`，见 [access-control.md](access-control.md#扩展预留oidc)。

## 节点

```
nodes             (id, org_id, owner_user_id, name, transport[client|ssh], status[pending|active|disabled],  -- 在线与否由连接推出，不存表
                   public_key,                 -- client 节点
                   ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_credential_id,   -- ssh 节点；ssh_host_key 为 SHA256 指纹
                   ssh_jumps json,                                                   -- 跳板列表，每一跳带自己的主机密钥和凭证
                   privileged_mode[forward|native|ignore|reject], run_identities json,  -- 两种模式各自的运行身份
                   trust_summary json, trust_digest,                                   -- crhs 缓存的 TrustSummary；连接时查询、变化时推送
                   notes_path,                                                         -- 节点笔记路径（Facts 上报，SSH 节点手动配置）
                   facts json, client_version, last_seen_at, created_at)
node_groups       (node_id, group_name, refreshed_at)  -- crha 节点：crha 上报的缓存；SSH 节点：在 crhs 中维护
ssh_credentials   (id, org_id, owner_user_id, name, public_key, secret_id, created_at)  -- 私钥在 secrets 中
enrollment_tokens (id, org_id, created_by_user_id, token_hash, name_hint, expires_at, used_at, used_by_node_id)
                  -- 节点归令牌创建者所有；注册后先处于 pending 状态，由所有者或管理员确认后才变为可用
server_meta       (key, value)                                        -- 例如 master_key_id：防止配错主密钥文件
secrets           (id, org_id, kind, ciphertext, created_at)          -- 用主密钥加密：SSH 私钥、模型 API key、
                                                                       -- crhs 身份私钥、授权签名私钥（不用 ssh-agent 时）
```

## 任务

```
task_groups       (id, org_id, targets json, node_ids json, kind, parallel, fail_fast,
                   output_mode[status|text|head],                     -- 批量输出模式；exec 新建默认 status（M3.5 之前的组为 text），文件操作固定 head
                   skipped json,                                      -- 因 fail_fast 或中断而未启动的节点
                   rule_chain json nullable, approval json nullable,  -- 一个任务组只审批一次
                   spec json nullable, timeout_ms nullable, pending_input nullable,
                                                                      -- 等待审批时暂存要执行的内容
                   root_session_id nullable,                          -- 规则链根会话，按会话树查等待项
                   handler_type[agent|user] nullable,                 -- 等审批时谁处理；user 即 on_behalf_of_user_id
                   handler_session_id nullable,                       -- handler_type=agent 时处理的会话
                   state[awaiting_approval|awaiting_authorization|running|finished|interrupted|rejected],
                                                                      -- interrupted：重启中断；已创建但未下发的成员任务以 cancelled 结束
                   actor_type, actor_id, on_behalf_of_user_id, created_at, finished_at)
tasks             (id, org_id, node_id, task_group_id nullable, kind, spec json, input_size, input_sha256,
                   privileged, attempt, timeout_ms, output_mode[full|text|status|head],  -- 单任务 full；组内任务随组
                   state[awaiting_approval|awaiting_authorization|denied|dispatched|running|exited|failed|rejected|unknown],
                   exit_code, signal, timed_out, cancelled,
                   error_code, error_message,                         -- 执行器错误码、拒绝原因或 unknown 的原因
                   actor_type, actor_id, on_behalf_of_user_id,
                   rule_chain json nullable,                          -- 从根开始的规则链；用户本人操作时为空
                   approval json nullable,                            -- 规则判断记录（每一级），以及审批决定：结果、决定者、时间、理由
                   pending_input nullable,                            -- 等待审批/授权时暂存的输入（base64）
                   root_session_id nullable,                          -- 规则链根会话，按会话树查等待项
                   handler_type[agent|user] nullable,                 -- 等审批时谁处理；user 即 on_behalf_of_user_id
                   handler_session_id nullable,                       -- handler_type=agent 时处理的会话
                   authorization json nullable,                       -- M4：授权状态、方案、payload id、trust digest
                   created_at, dispatched_at, accepted_at, finished_at,
                   stdout_bytes, stderr_bytes,
                   stdout_head, stdout_tail, stderr_head, stderr_tail, -- crhs 只保存截断后的头尾（base64）
                   output_file nullable,                              -- 完整输出在节点上的路径（crha 保存）
                   result json nullable,                              -- 文件任务的结构化结果（protocol.md TaskResult）
                   late_result nullable)                              -- 已报告 unknown 之后才到达的真实结果
```

crhs 不保存完整输出。批量默认 `status` 只保存状态和输出文件路径；`text` 受单节点和总预算限制。完整输出由 crha 在节点上保存为普通文件并负责清理，见 [execution-plane.md](execution-plane.md#输出)。SSH 不保存完整输出。

`tasks.spec` 和 `task_groups.spec` 是创建时的 JSON 形式，按当时的协议版本解释。协议大版本 2 把 `file.read` 的 JSON 字段从 `offset` / `limit` 改为 `startLine` / `lineCount`：升级前创建、仍在等待审批或签名的这类任务和任务组无法下发，读取时以 `stored spec cannot be read` 失败。

## 规则与授权

```
authorizations    (id,                                   -- SHA-256(CBOR(payload))
                   org_id, payload blob, signatures json, -- 同一 payload 上的多个签名；用户 + crhs 联署
                   nodes json, command_match json nullable, deadline nullable,
                   task_id nullable,                      -- task_id：一次性授权绑定的任务
                   attempt,                               -- 同一 task_id 的授权尝试
                   revoked_at nullable, created_at)
rule_sets         (id, org_id, scope_type[session|schedule|api_token], scope_id,
                   preset[ask|auto_review|yolo] nullable,          -- 只有根有，决定 default 和基础规则
                   default_action[allow|inherit|require-approval|deny], rules json, updated_at)
                  -- 授权规则，见 access-control.md；用户和组织没有规则；配额在 sessions
```

审批结果保存在工具调用（`tasks` / `task_groups`）上，不单独建表；"以后都允许"是对 `rule_sets` 的修改。等待中的审批用 `root_session_id` 归属会话树，用 `handler_type` / `handler_session_id` 记录当前处理者（agent 会话，或 `on_behalf_of_user_id` 用户），前端和重启重建都按它查询。

`authorizations` 每个 payload 一行，`signatures` 保存同一对象上的用户签名和 crhs 联署，不再有 `cosign_of`。吊销时设置 `revoked_at`，并把授权 id 推送给相关节点的 crha 特权模式（见 [privilege.md](privilege.md#吊销)）；离线节点在重连后收到。

## Agent

```
sessions          (id, org_id, owner_user_id, conversation_id, parent_session_id nullable,
                   title, model json, status, created_at, updated_at, archived_at,
                   schedule_id nullable,                -- 由计划任务创建的根会话；计划任务删除后置空
                   last_submission_id nullable,         -- 最近一次输入；父会话靠它 subagent_wait
                   quota_tokens nullable,               -- 剩余 token 配额，有符号；null 不限且不扣（用户创建的根默认）
                   root_session_id,                     -- 所在会话树的根（根会话为自身），列表按树汇总状态用
                   state[idle|running|awaiting],        -- 运行状态（见 agent-runtime.md "会话状态"），启动时对账
                   waiting_kind nullable[quota|approval|authorization], -- awaiting 时在等什么
                   waiting_level_id nullable,           -- waiting_kind = quota 时：要补的那一级
                   waiting_handler_id nullable,         -- 该等待的直接父会话（处理它的 agent）；根耗尽时为空，由所有者处理
                   state_changed_at,
                   budget_used_tokens,                  -- 预算口径：本会话及其 subagent 的输出 token（D101）
                   usage_tokens,                        -- 统计口径：本会话及其 subagent 的输入 + 输出 token（D101）
                   context_tokens nullable)             -- 本会话最近一次主 agent 调用的输入大小；第一次调用前为 null
                   -- 规则在 rule_sets
usage_ledger      (id, org_id, session_id, chain json, input_tokens, output_tokens, cost, created_at)
                  -- 按链逐级汇总，用于配额检查
model_providers   (id, org_id, provider_id, kind[builtin|openai-compatible], builtin, name, base_url,
                   secret_id, models json, headers json, enabled)
                  -- key 在 secrets；headers 只放网关路由头，不放凭据
```

> 两个 token 度量见 [agent-runtime.md](agent-runtime.md#配额)（D101）：`budget_used_tokens` 只计输出、决定配额何时暂停；`usage_tokens` 计输入 + 输出、只用于展示，两者都在链上累加。`context_tokens` 只由主 agent 的模型调用写入，压缩和 Auto Review 不写。上游没有上报用量时，输入按调用实际发出的请求内容估算：生成只有请求的 `messages`，压缩和 Auto Review 是系统提示加消息。

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
                   action, target_type, target_id, detail json, prev_hash, hash)
                  -- seq 单调递增；哈希链用于发现绕过 crhs 的改动，见 access-control.md#防篡改
```
