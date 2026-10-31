# 计划任务

调度器是服务端自己的模块（`server/src/scheduler/`），基于数据库表，不依赖 durable 的定时机制。

## 形态

计划任务只有一种：按时间表，用一段固定的用户消息**新建一个会话**并提交。要定时执行的固定命令也由会话里的 agent 执行，规则链、审批、提权、配额都与普通会话相同，调度器只对接 AgentRuntime，不直接创建任务。

字段：

| 字段 | 说明 |
|---|---|
| `name` | 名称 |
| `prompt` | 每次运行提交给新会话的用户消息 |
| `model` | 会话使用的模型 |
| `preset` | 规则预设（Ask / Auto Review / Yolo），计划任务是规则链的根，见下文 |
| `token_budget` | 每次运行的 token 上限，写入新会话根上的配额；`null` 不限 |
| `cron` / `timezone` | 5 字段 cron 表达式（精度到分钟，用 `croner` 解析），IANA 时区；夏令时按 croner 的处理 |
| `catch_up` | 停机期间错过的触发是否补跑一次 |
| `enabled` | 启用状态 |

每次运行产生的会话属于计划任务的所有者，`sessions.schedule_id` 指向计划任务，会话列表可按计划任务筛选；运行历史就是这些会话。

## 同时只有一个实例

同一个计划任务同时只有一个运行中的实例。新的运行（定时或手动）开始时，如果上一个实例还没结束，就先**强制结束**它：走会话的停止流程，取消它的任务和 subagent 子树，运行记为 `preempted`，再启动新的。

上一个实例停在等待审批、等待签名或等待配额也一样会被结束；周期短于用户处理所需的时间时，每次都会在处理前被结束。这是有意的：计划任务的每次运行只在下一次触发之前有效。正在节点上执行的任务会被取消，可能留下做了一半的状态。

## 调度

触发和提交分成两步，中间崩溃也不会丢失或重复：

1. **触发**：调度循环在最早的 `next_run_at` 醒来（最长 60 秒醒一次，防止时钟跳变；计划任务被修改时立即重算），在一个事务中写入 `schedule_runs`（状态 `pending`，`(schedule_id, fire_time)` 唯一）并计算下一次运行时间（按旧的 `next_run_at` 条件更新），提交后立即写审计（审计有自己的哈希链连接，不能加入这个事务；两者之间崩溃只丢这一条 `schedule.fired`，运行记录本身一致）。重复触发会被唯一约束挡住。
2. **提交**：执行器用条件更新领取 `pending` 的记录，先按上一节结束上一个实例，再新建会话并提交 `prompt`，成功后改为 `running`。提交使用由运行记录派生的**稳定 id**，重复提交是幂等的：会话 id 由 run id 派生，`requestId = schedule:<id>:<fire_time>`，durable 按它去重。
3. **恢复**：crhs 启动时先停止仍在运行的 `preempted` 实例的会话（强制结束时先标记 `preempted` 再停止会话，两者之间崩溃会留下这种会话），再提交遗留的 `pending`，然后开始调度。提交后、写 `running` 之前崩溃的情况，也由幂等提交覆盖。运行中的会话由 durable 在重启后继续。
4. **结束**：会话的这次运行正常结束记 `succeeded`；出错、被中止或停止记 `failed`，`reason` 说明原因（例如等待配额时被拒绝）。被下一次运行强制结束的记 `preempted`。agent 自己判断"巡检发现了问题"不算失败，状态只表示执行层面。启动时核对 `running` 的记录，补上停机期间结束的运行。

**错过的触发**：启动时（或时钟跳变后）`next_run_at` 已经过去超过容差（60 秒）时，`catch_up = false` 跳过错过的时间点；`catch_up = true` 只补最近错过的那一次。两种情况都写审计并从当前时间重新计算 `next_run_at`。已经写入 `pending` 的记录一定会被提交，与 `catch_up` 无关。

**手动运行**：WebUI 的"立即运行"与定时触发走同一条路径，`schedule_runs.manual = true`，`fire_time` 为点击时间，发起方是点击的用户；有实例在运行时先确认"会结束当前运行"。停用的计划任务也可以手动运行（停用只停止定时触发）。

## 审计

调度器的每个决策都写审计（actor 为 `system`，手动运行和配置修改为用户，target 是计划任务）：

| 事件 | 内容 |
|---|---|
| `schedule.created` / `schedule.updated` / `schedule.deleted` / `schedule.enabled` / `schedule.disabled` | 配置变化 |
| `schedule.fired` | 定时或手动触发，带 run id、`fire_time`、`manual` |
| `schedule.skipped` | 没有触发及原因：停机期间错过（`catch_up = false`）、计划任务已停用、所有者已停用 |
| `schedule.run_started` | 带 run id 和会话 id |
| `schedule.run_preempted` | 上一个实例被强制结束，带被结束的 run id 和会话 id |
| `schedule.run_finished` | `succeeded` / `failed`，带原因 |

## 授权规则与配额

计划任务是操作者链上的一级（用户 → 计划任务 → 会话 → subagent …），由所有者选择规则预设并可以追加规则，见 [access-control.md](access-control.md#授权规则)。选择 Ask 时每次运行的审批都要等所有者处理，无人值守时会一直等到下一次触发，WebUI 创建时提示这一点。选择 Auto Review 而没有单独配置审查模型时，用计划任务自己的模型审查。`token_budget` 为空（不限）或至少 1。

`token_budget` 就是每次运行新会话根上的配额，按模型输出 token 计，不含输入（口径见 [agent-runtime.md](agent-runtime.md#配额)）：用尽时照常暂停并请所有者处理（增加或拒绝）；无人处理时由下一次触发强制结束。修改预算只影响之后的运行。

## 提权

会话中的特权任务照常走 M4 的授权路径（见 [privilege.md](privilege.md#授权路径)），授权等待只交给所有者：

- crhs 信任项可以单独授权，且规则与 auto review 放行：自动执行。
- 只有所有者的 user 信任项可以授权：crhs 先查找所有者已经签发、仍然有效、覆盖本次任务的可重复使用授权（按 nodes、指令限制、deadline 匹配，与任务由谁发起无关），没有就进入 `awaiting_authorization`，出现在所有者的"等待你签名"里。
- 因此，要让固定命令无人值守地提权，所有者可以为这条命令预先签发不带 `task_ids` 的授权（`command.exact`、目标节点、视需要设置 `deadline`），并在提示词中要求 agent 原样执行这条命令；命令写法稍有不同就不会匹配，会进入签名等待。计划任务页给出这一说明和签名入口的链接，不单独管理授权。
- 特权模式不检查调度时间：在截止时间之前，持有授权的一方可以随时执行这条命令。需要每次都经过 crhs 策略时，给用户信任项加上 `require-cosign`。

## 生命周期

- 所有者被停用或删除时，停用其计划任务（写 `schedule.disabled`）。
- 修改 `cron` / `timezone` 后重新计算 `next_run_at`；修改 `prompt` / `model` / `preset` / `token_budget` 只影响之后的运行。
- 停用计划任务不结束正在运行的实例；删除计划任务时结束它，删除它的运行记录，已有会话的 `schedule_id` 置空。这些会话原本是计划任务下面的一级（不带预设、继承上级），删除时把它们的规则集提升为根，带上计划任务的预设和规则，实际生效的规则不变；计划任务的规则集保留，以便已有任务记录中的规则链仍能解析。
- 计划任务不支持分享；MCP 和 agent 工具不能管理计划任务（只有 WebUI 和 API）。
