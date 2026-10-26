# 数据表草案

同时支持 SQLite 和 PostgreSQL，因此：

- 主键统一使用 UUIDv7，以 TEXT 存储（PG 中可用 `uuid` 类型，由 Kysely 方言处理）。
- JSON 字段在 PG 中用 `jsonb`，在 SQLite 中用 `TEXT`；只在应用层解析，不依赖数据库的 JSON 查询能力。
- 时间统一存 UTC，PG 用 `timestamptz`，SQLite 用 ISO 8601 文本。
- 迁移用 Kysely Migrator，每个迁移对两种方言都要能跑。

durable 的表由 `SqlStorage` 管理，统一加 `pi_` 前缀，不在本文档中列出。

## 用户与归属

```
orgs              (id, name, created_at)
users             (id, org_id, username, display_name, email, kind[admin|member],
                   password_hash nullable, status, created_at)        -- 以后的 OIDC 用户可以没有密码
user_groups       (id, org_id, name, source, created_at)              -- source：local；以后可以是外部来源（OIDC）
user_group_members(group_id, user_id, created_at)
user_credentials  (id, user_id, kind[ssh|webauthn], public_key, fingerprint, label, created_at, last_used_at)
api_tokens        (id, user_id, name, token_hash, expires_at, revoked_at, last_used_at)  -- 规则和预算在 rule_sets
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
nodes             (id, org_id, owner_user_id, name, transport[client|ssh], status[pending|online|offline|disabled],
                   public_key,                 -- client 节点
                   ssh_host, ssh_port, ssh_user, ssh_host_key, ssh_credential_id,   -- ssh 节点
                   ssh_jumps json,                                                   -- 跳板列表，每一跳带自己的主机密钥和凭证
                   privileged_mode[forward|native|ignore|reject], run_identities json,          -- 两种模式各自的运行身份
                   trust_summary json, trust_digest,                                   -- 特权模式上报
                   notes_path,                                                         -- 节点笔记路径（Facts 上报，SSH 节点手动配置）
                   facts json, client_version, last_seen_at, created_at)
node_groups       (node_id, group_name, refreshed_at)  -- crha 节点：crha 上报的缓存；SSH 节点：在 crhs 中维护
enrollment_tokens (id, org_id, created_by_user_id, token_hash, name_hint, expires_at, used_at, used_by_node_id)
                  -- 节点归令牌创建者所有；注册后先处于 pending 状态，由所有者或管理员确认后才变为可用
server_meta       (key, value)                                        -- 例如 master_key_id：防止配错主密钥文件
secrets           (id, org_id, kind, ciphertext, created_at)          -- 用主密钥加密：SSH 私钥、模型 API key、
                                                                       -- crhs 身份私钥、授权签名私钥（不用 ssh-agent 时）
```

## 任务

```
task_groups       (id, org_id, targets json, spec json, parallel, fail_fast,
                   actor_type, actor_id, on_behalf_of_user_id, created_at)
tasks             (id, org_id, node_id, task_group_id nullable, kind, spec json, spec_sha256, privileged,
                   state, exit_code, signal, reason,                 -- reason：unknown/failed/denied 等的原因
                   actor_type, actor_id, on_behalf_of_user_id,
                   approval_id nullable, authorization json nullable,
                   created_at, dispatched_at, started_at, finished_at,
                   stdout_bytes, stderr_bytes,
                   output_head bytes, output_tail bytes,              -- crhs 只保存截断后的头尾
                   output_file nullable)                              -- 完整输出在节点上的路径（crha 保存）
```

crhs 不保存完整输出。过长的输出由 crha 在节点上保存为普通文件并负责清理，见 [execution-plane.md](execution-plane.md#输出)。

## 审批与授权

```
approvals         (id, org_id, subject[task|task_group|budget], task_id nullable, task_group_id nullable,
                   schedule_id nullable, kind[crhs|user|local],                -- 由谁完成授权
                   current_level, escalation json,                           -- 当前在链上的哪一级；每一级的判断记录
                   requested_by_actor_type, requested_by_actor_id, on_behalf_of_user_id,
                   status[pending|approved|rejected|expired], decided_by_user_id, decided_at,
                   review json nullable,                                -- auto review 结论
                   created_at, expires_at)
authorizations    (id,                                   -- SHA-256(JCS(payload))
                   org_id, issuer[server|user], user_id nullable, credential_fingerprint,
                   payload json, signature, format[sshsig|webauthn],
                   nodes json, command_match json nullable, deadline nullable,
                   cosign_of nullable, task_id nullable,              -- task_id：一次性授权绑定的任务
                   schedule_id nullable,
                   revoked_at nullable, created_at)
rule_sets         (id, org_id, scope_type[org|user|session|schedule|api_token], scope_id,
                   default_action[inherit|require-approval|deny], rules json, budget json nullable, updated_at)
                  -- 授权规则与预算，见 access-control.md
```

`authorizations` 同时记录 crhs 签发的单条命令授权、联署，以及用户签发的授权。吊销时设置 `revoked_at`，并把授权 id 推送给相关节点的 crha 特权模式（见 [privilege.md](privilege.md#吊销)）；离线节点在重连后收到。

## Agent

```
sessions          (id, org_id, owner_user_id, conversation_id, parent_session_id nullable,
                   actor_chain json,                    -- 从用户到本会话的完整链
                   title, model_ref, status, created_at, archived_at)   -- 规则和预算在 rule_sets
usage_ledger      (id, org_id, session_id, chain json, input_tokens, output_tokens, cost, created_at)
                  -- 按链逐级汇总，用于预算检查
model_providers   (id, org_id, provider, config json, secret_id, enabled)
```

## 计划任务

```
schedules         (id, org_id, owner_user_id, name, kind[command|agent],
                   spec json,                         -- command：任务规格 + 目标（节点和组）；agent：提示词 + 会话策略
                   cron, timezone, misfire[skip|run_once], overlap[skip|allow],
                   authorization_id nullable, enabled, next_run_at, created_at)
schedule_runs     (id, schedule_id, fire_time, status[pending|submitted|succeeded|failed],
                   task_group_id nullable, submission_id nullable, submitted_at, finished_at)
                  -- 任务组和任务 id 由 (id, node_id) 确定性派生，重新提交是幂等的
                  -- unique (schedule_id, fire_time)
```

## 审计

```
audit_events      (seq, id, org_id, ts, actor_type, actor_id, on_behalf_of_user_id,
                   action, target_type, target_id, detail json, prev_hash, hash)
                  -- seq 单调递增；应用账号只有 INSERT/SELECT 权限
```
