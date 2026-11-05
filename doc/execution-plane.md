# 执行平面

执行平面负责"把任务送到节点上执行并拿回结果"。它不感知 agent、会话和模型，只认识任务。

## 任务模型

任务 id 由服务端生成（UUIDv7），是执行平面里唯一的任务标识。

### 任务类型（v1）

| kind | 说明 |
|---|---|
| `exec` | 执行命令：`argv`（直接执行）或 `shell`（`sh -c`）；可选 `env`、`cwd`、`stdin`、超时 |
| `file.read` | 按行读文件：从第 `start_line` 行起最多 `line_count` 行，整页不超过 50KB；节点从文件开头扫描，发完整行，不读到文件末尾；页面字节走输出流，页面的行范围和文件末尾信息在 `task.exit` 的 `result` 里（见 [protocol.md](protocol.md#taskresult)） |
| `file.write` | 原子写（临时文件 + rename）；可设置 mode/owner。默认只**创建新文件**，目标已存在时失败（`renameat2` 的 `RENAME_NOREPLACE`）；`overwrite = true` 时才覆盖。结果（写入字节数、是否新建）在 `task.exit` 的 `result` 里 |
| `file.edit` | 按原文替换，格式与 pi 的 edit 工具相同：`edits[]`，每项 `oldText` / `newText`，`oldText` 必须在文件中出现且只出现一次，所有替换都针对原始内容匹配；保留 BOM 和换行风格；结果原子写回。结果（替换数量）在 `task.exit` 的 `result` 里 |
| `file.stat` | 文件元信息，作为 `task.exit` 的 `result` 返回 |
| `file.list` | 列目录，有条目数上限，条目作为 `task.exit` 的 `result` 返回 |

文件任务的结构化结果不写进输出流：`file.read` 的输出只有页面本身，`file.stat`、`file.list`、`file.write`、`file.edit` 没有输出。见 [protocol.md](protocol.md#taskresult)。

编辑由 crha 在节点上完成：读取、匹配、替换、写回连续执行，中间不经过网络。不使用哈希校验，`oldText` 本身就是冲突检测：

- 别人改的是文件的其他位置：编辑照常成功，对方的修改保留。
- 别人改的正是这一段：`oldText` 匹配不到（或不再唯一），编辑失败，agent 重新读取再改。
- **审批延迟**：特权编辑的 `exact` 授权绑定 `edits` 本身，用户批准的是"把这段改成那段"。等待审批期间文件变了，只要 `oldText` 仍然唯一匹配，执行的仍然是用户批准的那个修改；不匹配就失败。
- **防覆盖**：`file.write` 默认只创建新文件，避免模型用整文件写入意外覆盖现有内容；确实需要整体替换时显式打开 `overwrite`。
- **符号链接**：非特权的 `file.write` / `file.edit` 经过符号链接时写链接指向的目标并保留链接本身（`file.write` 遇到悬空链接会创建目标）；特权任务仍拒绝任何一级符号链接（`symlink_not_allowed`，见 privilege.md）。
- 剩余的竞态（crha 读取和 rename 之间的极短窗口）与 pi 在本地编辑时相同，接受。

PTY 交互、文件传输等后续再加。

### 通用字段

```
task_id        UUIDv7
node_id
kind, spec     见上
privileged     true | false             # true 时为特权任务，走授权链路，见 privilege.md
attempt        1, 2, 3, ...             # 同一 task id 的授权尝试；payload 和 task.start 都带
authorization  可选：特权任务的一个授权对象（payload + signatures[]）；本地批准时为空，见 privilege.md
timeout_ms     仅 exec：超时后先发 SIGTERM，宽限期过后发 SIGKILL（杀整个进程组）；file.* 任务没有超时，只能由取消结束
output_mode    full | text | status：单任务为 full（头尾 + 超阈值落盘）；任务组为 text 或 status，默认 status
```

### exec 的执行环境

crha 节点上的 exec（非特权模式、特权模式、native helper）不原样传递 crha 进程自己的环境，而是按下表构造；SSH 节点见[执行](#执行)。

| 变量 | 非特权模式 | 特权模式 / native helper |
|---|---|---|
| `PATH` | 继承 crha 进程的 `PATH`；为空时用固定 PATH | 固定 PATH，任务不能覆盖 |
| `HOME`、`USER`、`LOGNAME` | 运行账户（`os/user.Current()`） | root（`os/user.LookupId("0")`） |
| `SHELL` | 发现到的 sh（见下） | 发现到的 sh |
| `LANG`、`LC_ALL` | `C.UTF-8` | `C.UTF-8` |
| 任务的 `env` | 追加，可以覆盖上面所有变量，包括 `PATH` | 可以覆盖上面除 `PATH` 外的变量；`forward` 时只允许信任项 `env_allow` 中的名字，native helper 没有信任配置，不做这项限制（native 不是安全边界） |

固定 PATH 是 `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。crha 进程的其他环境变量都不传给任务。

**覆盖**：`CRHA_TASK_HOME`、`CRHA_TASK_USER`、`CRHA_TASK_LOGNAME`、`CRHA_TASK_SHELL` 是对应进程（`crha run`、`crha privileged run`、`crha privileged stdio`）自己的环境变量，非空时取代解析结果，`CRHA_TASK_SHELL` 同时决定执行 `shell` 命令用的 sh。`CRHA_TASK_SHELL` 必须是存在且可执行的绝对路径，否则进程启动失败。名字以 `CRHA_TASK_` 开头的变量一律不传给任务，任务的 `env` 中带了也会被丢弃。

- 解析在进程启动时完成（native helper 每次拉起时）。没有覆盖且解析失败时进程启动失败：`crha run` 退出；特权模式退出；native helper 失败时该节点的特权任务以 `privileged_unsupported` 失败，非特权任务不受影响。
- crha 是 `CGO_ENABLED=0` 静态编译的，`os/user` 只读 `/etc/passwd`，不经过 NSS（LDAP、SSSD 中的账户查不到）。`user.Current()` 查不到时会退回 `$HOME` / `$USER`；`LookupId("0")` 没有这个退路。账户不在 `/etc/passwd` 中时用 `CRHA_TASK_*` 覆盖。
- native helper 由 sudo / doas 拉起，`env_reset` 默认会去掉 `CRHA_TASK_*`；需要覆盖时在 sudoers 中 `env_keep += "CRHA_TASK_*"`，或在 doas 中用 `setenv`。

**sh 的发现**：进程启动时依次尝试：`CRHA_TASK_SHELL`；`/etc/shells` 中第一个文件名为 `sh` 的绝对路径（文件存在且可执行）；在 PATH 中查找 `sh`（非特权模式用自己的 `PATH`，特权模式和 native helper 用固定 PATH；PATH 中的空项和相对路径跳过，结果必须是绝对路径）。都失败时进程启动失败。`shell` 命令以 `<sh> -c <cmd>` 执行。

- **授权和显示**：签名、规则匹配（`exact` / `prefix` / RE2）、`spec_sha256` 和界面显示中，`shell` 命令仍渲染为 `/bin/sh -c '<cmd>'`。这里的 `/bin/sh` 表示"节点发现的 sh"，不是字面路径；crhs 和 crha 的渲染不因节点而变。
- 同样的方法（`/etc/shells` 中文件名为 `bash` 的第一个路径，然后在 PATH 中查找 `bash`）发现 bash，找不到不算错误。两者都由非特权模式在 `facts` 的 `shells` 中上报（见 [protocol.md](protocol.md#命令与事件)），agent 用它判断能否 `bash -c`。
- `C.UTF-8` 在 glibc 2.35 起内置；更老的系统可能没有这个 locale，程序会退回 C locale 并可能在 stderr 打印警告。crha 不检测。

### 状态机（服务端视角）

```
created ──▶ awaiting_approval ──▶ awaiting_authorization ──▶ dispatched ──▶ running ──▶ exited(code)
   │               │                        │  ▲                 │             │
   │               └──▶ rejected            │  └── auth retry ───┘             ├──▶ failed(reason)
   ├──▶ awaiting_authorization ─────────────┘                                   ├──▶ cancelled
   └──▶ denied(策略拒绝)                                                        └──▶ unknown(reason)
```

- 没有规则链（用户本人在 WebUI 中操作）的任务直接进入授权/下发。
- 没有待审批策略、但特权任务还需要签名的，`created` 直接进入 `awaiting_authorization`。
- 策略已通过但特权任务还需要用户或本地签名时，任务进入 `awaiting_authorization`；拿到授权后下发。
- crha 在 `task.start` 成功响应（accepted）**之前**因授权拒绝时，明确允许用 `attempt + 1` 重试：任务回到 `awaiting_authorization`，不是终态；不会重发已接受的任务。
- `awaiting_authorization` 没有自动超时；由用户拒绝、取消任务或规则变化结束。
- `denied` 的 `error_code` 为 `policy_denied`；审批被拒绝（包括 token 吊销）时为 `rejected`，`error_code` 为 `approval_rejected`。
- `awaiting_authorization` 最终失败时为 `rejected`，error code 取 `authorization_required`、`authorization_invalid`、`authorization_expired` 或 `authorization_rejected`（用户/本地最终拒绝）。
- 按节点组 UUID 签发的可复用授权在缺少别名的 `forward` 节点上不下发：该节点的任务直接以 `failed`/`error_code = alias_missing` 结束（D110，见 [privilege.md](privilege.md#授权路径)）。
- 等待审批的任务把输入（stdin、写入内容）暂存在 `tasks.pending_input`，下发时取出并清空；批准时节点不在线，按下文"节点不在线"的宽限期等待重连，之后以 `failed(node_offline)` 结束，不再排队等节点。
- 特权任务没有等待就直接用所有者已有的可复用授权下发时，输入取自创建时的内存，不经过 `pending_input`；`task.start` 被拒绝、任务回到 `awaiting_authorization` 时再写入 `pending_input`，供下一次尝试使用。
- 任务组需要审批时整组等待（`task_groups.state = awaiting_approval`），还没有创建任务，规格和输入暂存在任务组上；被规则拒绝的节点立即得到一个 `denied` 任务。批准后剩余节点照常按并发数执行。
- 任务组中的任务彼此独立：部分节点已执行、部分节点在 `awaiting_authorization` 时，已执行的任务不回滚；任务组最终可以是混合结果。若所有未完成任务都在等授权，任务组显示 `awaiting_authorization`，否则保持 `running`。
- 允许下发的任务在创建时先写成 `awaiting_approval`、随即下发；这段极短的时间里它的 `handler_type` 为空，并不是在等审批。真正等审批的任务总有处理者（`handler_type` 非空）。下发这一步抛错时任务以 `failed`、`error_code = internal_error` 结束，不会把这个中间状态留在表里。
- `fail_fast` 只影响尚未启动的节点，不回滚已启动/已完成的任务；可重试的授权拒绝不算最终失败。
- crhs 重启时仍在运行的任务组标记为 `interrupted`：没有创建任务的节点记入 `skipped`，已创建但还没有下发的成员任务（`awaiting_approval` / `awaiting_authorization`）以 `rejected`、`error_code = cancelled` 结束，原因写明任务组被重启中断。`finished`、`interrupted`、`rejected` 的组不再下发任何成员。
- 任务组在运行中抛错（例如创建成员时存储失败）时同样以 `interrupted` 结束，而不是 `finished`：没有创建任务的节点记入 `skipped`，已创建但还没有下发的成员以同样的方式取消，原因写成 `the task group failed: …`。没有单独的"失败"组状态：组不会重试，`interrupted` 就是"没有跑完"的那个状态。

`unknown` 是执行平面唯一的"结果不确定"状态，reason 取值：

| reason | 触发条件 |
|---|---|
| `connection_lost` | 已下发的任务在终态之前连接断开，且断线恢复失败（SSH 节点一断即是） |
| `executor_restarted` | 重连后查询任务，客户端不认识这个任务 id（客户端进程重启过） |
| `dispatch_unconfirmed` | `task.start` 已发出但未收到响应，连接就断了 |

向 agent 报告的内容是："失败，状态未知，原因是 xxx"。是否重试、重试前要不要先检查机器状态，由 agent 或使用者决定。

### 节点不在线

crhs 要向节点发送 `task.start` 而节点没有连接时（D113），最多等待 `NODE_OFFLINE_GRACE`（30 秒）让它重连；期间重连上（`forward` 节点还要等到新的信任报告）就照常下发，否则任务以 `failed(node_offline)` 结束。任务从未下发，不属于 `unknown`。

- 适用于每一个"现在要下发"的时刻：创建后直接下发、审批通过后、签名到达后、本地批准后、任务组启动下一个节点时、计划任务触发时。所有工具和接口都一样，不再有因为节点离线而一直挂着的任务。
- 等待签名或审批的任务本身不受影响：它们等的是人，不是节点；只有放行之后要下发时才检查节点是否在线。
- 宽限期覆盖 crhs 重启后节点重连的那几秒和短暂的网络抖动；更长的离线就是失败，由调用方决定是否重试。
- 任务组里的离线节点同样按宽限期处理，失败计入 `fail_fast`。
- SSH 节点没有常驻连接：没有可用的 SSH 路由时立即失败，不等待；连接失败按任务失败处理。

### 不重复执行与授权重试

- 同一个任务 id 最多被 **accepted/executed 一次**，不是“start 最多发送一次”。
- 只有一种重试：crha 在发出 `task.start` 成功响应（accepted）**之前**明确拒绝了授权（`authorization_*`），任务回到 `awaiting_authorization`，下一次用 `attempt + 1` 重新下发；旧授权不能用于新 attempt。
- 如果 `task.start` 已发出但连接断开、没收到明确拒绝，**绝不重试**，按 `dispatch_unconfirmed` / `connection_lost` 处理，避免重复执行。
- 已 accepted 的任务即使之后失败/unknown，也不重发；重连后只发 `task.query`。
- 客户端收到不认识 task id 的 `task.query` 时，正常响应（`ok = true`）状态 `unknown`；这不是错误。
- 客户端不持久化任务，也不做任何重放；task id 的 accepted/executed 记录只在客户端内存中，重启后靠 `query` 得到 `unknown(executor_restarted)`。

## 输出

- **输出只有一个流**（D114）：crha 把命令的 stdout 和 stderr 接到同一个管道（相当于 `2>&1`），交错顺序由写入顺序决定；特权模式（`forward` 的守护进程和 `native` helper）同样只用一个管道。SSH 节点在远端 wrapper 里先输出 pid，再 `exec 2>&1`（见下文"SSH 传输"）。区分两个流没有明确的用途：模型、完整输出文件和 WebUI 都只看合并后的输出；确实需要分开时，命令自己重定向（`2>/dev/null`、`2>err.log`）。
- 每个分片带字节偏移 `offset`；单任务和批量带输出时实时推送给 crhs，不带输出（`status`）时不推送。
- **crhs 只保存截断后的输出**：单任务保存输出的头部和尾部（`output_head` / `output_tail`，各 2000 行或 50KB，尾部从整行开始），交给模型的是尾部，WebUI 任务页显示两者；批量带输出时每节点只保留尾部（默认 8KB/128 行），批量 `head`（文件操作）每节点只保留**头部**（默认 8KB/128 行），两者受同一个全局 50KB/2000 行预算；都不保存完整输出。不带输出（`status`）时完全不保存输出，只保存状态和节点文件路径。
- **crhs 自己的提示不进输出流**：SSH 节点忽略特权时 crhs 写的那一行提示保存在任务的 `notice` 字段，不混进输出，所以 `read_file` 的页面仍是文件原样；工具结果把它作为一行放进说明块，WebUI 在输出上方单独显示。文件任务的结果在 `task.exit` 的 `result` 里，不占输出预算。
- **完整输出由 crha 在节点上保存为普通文件**：单任务文本模式下，输出超过 2000 行或 50KB 时落盘；批量 `text` 和 `status` 模式**总是**落盘。crha 非特权模式把完整输出写入 `[output].dir`（未设置时是 `crha.toml` 的 `state_dir` 下的 `output/`，例如 `state_dir = "/var/lib/crha"` 时是 `/var/lib/crha/output/<task_id>.log`；内容就是这一个输出流，与终端里 `2>&1` 看到的一致；crha 在内存中保留分段索引，用于续传），`task.exit` 中带上文件路径、总字节数和总行数（`output_lines`）。文件权限 0600，属主为非特权模式的运行用户（输出可能包含敏感内容）。agent 需要完整输出时，用普通的 `read_file` 读取。
  - 特权任务的输出本来就经由非特权模式转发，所以同样由非特权模式保存，不会因此多暴露什么。
  - 这些文件的清理由 crha 负责，按 `crha.toml` 中 `[output]` 的 `max_age` 和 `max_total` 配置（默认 7 天、1GB）。
- **断线续传**：任务运行期间，以及结束后到 crhs 确认（`task.output.ack` / `task.exit.ack`）之前，crha 保留未确认的输出：输出较短时在内存中，已经写入文件的直接从文件中补发。所以不会因为缓冲溢出而丢失输出。
- **批量执行**：
  - 一个任务组最多 **512 个节点**（target 展开、去重后计数，离线节点也算）；超过时创建失败并提示拆分，不截断执行。这限制的是返回给模型的任务组结果（每节点的状态信息不受输出预算约束），也使每节点一行的常见批量命令在 `text` 预算内能全部看到（D85）。
  - `status`（`exec` 的 `with_output: false`，单任务和批量都可用）：只返回状态、退出码和完整输出文件路径；不向 crhs 发送输出，完整输出留在节点文件。
  - `text`（`exec` 批量默认）：每个节点保留**尾部** 8KB/128 行；所有节点共享单任务总预算（50KB/2000 行）；按**输出到达顺序**分配，预算耗尽后忽略后续节点，允许整个节点被丢弃；完整输出仍然留在节点文件。
  - `head`（文件操作固定使用，不能选）：每个节点保留输出的**头部** 8KB/128 行，所有节点共享同一个总预算（50KB/2000 行），同样按**输出到达顺序**分配；`file.read` 的每个节点因此可以从**它自己的**下一行继续（`Use offset=<n> to continue.`），节点之间没有共同的偏移或行数限制。预算耗尽时允许整个节点被丢弃，工具结果里会指出这一点。`write_file`、`list_dir` 没有页面，它们和 `read_file` 的行范围一样来自 `task.exit` 的 `result`，不受这个预算影响。
  - **预算组件**（D112）：单任务的头部和尾部、批量 `text` 和批量 `head` 共用一个预算组件。它管两层额度（每节点上限和整组总预算）、两种保留方式（头部或尾部），并记下保留的是哪几行，供工具结果写"第 X–Y 行"；渲染器只读它的结果，不再自己截断。每节点上限默认 8KB/128 行，调用方可以用 `max_lines` / `max_bytes` 改（不超过总预算 50KB/2000 行）；上限在创建时写入 `task_groups.node_max_lines` / `node_max_bytes` 和每个任务的 `tasks.max_lines` / `max_bytes`，crhs 重启后节点重发输出时按存下的上限重新发放额度。单任务的总预算就是它自己的上限（默认 50KB/2000 行）。单任务设了 `max_lines` / `max_bytes` 时，`task.start` 的 `full` 模式落盘阈值（`spill_lines` / `spill_bytes`）也取同样的值，所以只要交给模型的尾部被截断，节点上就有完整输出文件。
  - 预算在接收端 append 时检查，不能先把每个任务收满再裁剪；内存上限固定为总预算加少量元数据，不随节点数增长。`head` 与 `text` 用同一套额度记账：节点的输出到达时给它追加额度，直到达到单节点上限或总预算耗尽，额度只增不减。
  - 预算按**额度**发放：节点的输出到达时，从剩余总预算中给它追加额度，直到达到单节点上限（8KB/128 行）或总预算耗尽。额度只增不减：尾部滚动挤掉的旧字节不退回总预算。
  - 总预算耗尽后，已经拿到额度的节点继续接收输出，在自己的额度内滚动保留尾部；没有额度的节点输出全部丢弃。所以内存上限就是已发放额度之和，不会超过总预算。
  - 即使某个节点的输出被丢弃，crhs 仍按已收到的偏移发送 `task.output.ack`/`task.exit.ack`，让 crha 释放缓冲。
  - 不为失败节点预留额外预算：失败节点也按到达顺序参与；需要完整错误输出时使用节点文件，或对单个任务改用完整输出模式。这是内存上限优先的已知取舍。
  - SSH 节点不保存完整输出：`status` 只返回状态，`text` 只返回受单节点和总预算限制的尾部输出。
  - `text` 的尾部按行计：滚动时保留最多“额度行数”个换行符之后的内容。
  - 预算只在 crhs 内存中按任务组维护。crhs 重启后，未结束任务的输出由 crha 从偏移 0 重发，按新的到达顺序重新发放额度；已结束任务的尾部已经存库，不再参与。内存上限不变。
  - `status` 模式下 crha 不发送 `task.output`，所以 crhs 收到 `task.exit` 时不检查输出是否收全（只有 `full`/`text`/`head` 检查）；`task.exit` 中的字节数和文件路径照常记录。
  - 任务组的输出模式在创建时确定，写入 `task_groups.output_mode` 和其下每个任务的 `tasks.output_mode`：`exec` 组由调用方选 `text`（默认）或 `status`（Web API `outputMode`；工具的 `with_output`）；文件操作的任务组固定为 `head`，Web API 传其他值会被拒绝，文件工具没有这个参数。`head` 是 crhs 侧的模式：下发时任务仍用 `full`（节点实时推送输出，是否落盘由节点按阈值决定），crhs 按上面的预算保留头部。单任务的 `tasks.output_mode` 为 `full`，`with_output: false` 时为 `status`。

## 自有协议（M3.5）

M3.5 完整替换原来的 protobuf 消息层。Web API、数据库和 WebUI 仍使用 JSON；协议不保证旧版本兼容。

### 分层

```
消息层     CBOR（确定性编码；授权 payload 也使用 CBOR）
会话层     版本协商 / hello / 心跳 / 断线恢复
抽象       双向命令 / 事件
安全层     Noise_IK 端到端加密通道
传输层     任意可靠有序的消息流（v1：WebSocket over TLS）
```

### 版本协商

- 版本只在握手时协商：`protocol_major`、`protocol_minor` 和双方支持的命令集合。
- 大版本不匹配直接拒绝并说明；Noise prologue 含大版本（`"crh/<大版本>"`），所以旧的一方在握手本身失败。
- 不兼容的修改升大版本。本批是大版本 2（`major = 2`, `minor = 0`），有改变语义的修改——`file.read` 从字节偏移改为按行，`task.exit` 增加 `result`——旧的一方会静默误读。
- `protocol_minor` 只做增量：小版本不同不拒绝握手，新增命令/事件靠 `commands` 交集协商。
- crha、它的特权模式（daemon / native helper）和 crhs 一起升级；不提供跨大版本的兼容层。
- 升级前创建、仍在等待审批或签名的 `file.read` 任务和任务组无法下发：它们的 `spec` 仍是旧的 `offset` / `limit` 字段，读取时以 `stored spec cannot be read` 失败。
- 同一大版本内只允许新增命令/事件，不修改、不删除已有结构；需要替换时新增 `task.start.v2`。
- 握手完成后，后续帧**不再携带** `v` 字段；命令名和固定结构已经由协商结果约束。
- 新命令只有在双方握手都声明支持时才使用；否则回退到旧命令或返回 `unsupported_command`。

### 帧

帧使用固定元组，不使用可选的兼容 map：

```text
request   = [0, id, cmd, body]
response  = [1, id, cmd, ok, body]
event     = [2, event, body]
```

- `id`：发送方分配的整数，响应用同一个 `id`；事件没有 `id`。
- `ok = false` 时 `body = [code, message]`；`ok = true` 时 body 是该命令定义的固定结构。
- 命令/事件 body 使用该命令自己的固定类型（数组、元组或必要的结构 map），不再为“以后可能加字段”保留可选字段。
- 命令/事件名是稳定的；新版本使用新名字，不原地改结构。
- 连接关闭时，所有未完成命令以连接错误结束。
- 两个方向都会发请求，`id` **按方向各自独立**：响应中的 `id` 属于发出该请求的一方。
- 握手中的 `commands` 集合同时包含命令名和事件名。收到未协商的命令返回 `unsupported_command`；事件没有响应，收到未协商或无法解码的事件按协议错误断开连接。

### 命令与事件

| 方向 | 形式 | 名称 | 说明 |
|---|---|---|---|
| C→S | command | `hello` | 版本后的第一帧：节点、能力、运行中任务；响应 `welcome` |
| C→S | command | `ping` | 心跳；响应 `pong` |
| S→C | command | `task.start` | 任务规格 + attempt + 授权；响应接受/拒绝 |
| S→C | command | `task.input` | 输入分块；响应 ack |
| S→C | command | `task.cancel` | 取消；响应结果 |
| S→C | command | `task.query` | 查询任务状态；响应当前状态 |
| S→C | command | `local.request` / `local.withdraw` | 请求 / 撤回节点本地批准；不触发执行（M4） |
| S→C | event | `task.output.ack` | 确认已收到的输出偏移；客户端可用它释放缓冲 |
| S→C | event | `task.exit.ack` | 确认任务结束，可释放输出 |
| C→S | event | `task.output` | `{task_id, stream, offset, data}` |
| C→S | event | `task.exit` | 退出码/信号/错误、最终偏移、输出文件路径 |
| C→S | event | `facts` | 系统信息、时钟偏差、特权模式信息 |
| C→S | event | `trust.summary` | 握手后推送一次，信任摘要变化或特权模式连上/断开时再推送（M4） |
| C→S | event | `local.decision` | 本地批准或拒绝的结果（M4） |
| S→C | event | `node.status` | pending/active 等状态变化 |

标“M4”的命令/事件是 M4 新增的可选名字；交集里没有它们的节点不支持 `forward`。线上格式见 [protocol.md](protocol.md)。

命令响应的语义：

- **`task.start`**：`ok = true` 就是 accepted。crha 发出成功响应前，必须已在内存中把这个 task id 记为 accepted；该任务的 `task.output`/`task.exit` 一定排在这个响应之后（crha 先发响应再启动进程，消息流有序）。`ok = false` 的错误码分两类：
  - `authorization_*`：可重试。crha 不记录这个 task id，crhs 把任务转回 `awaiting_authorization`，之后用 `attempt + 1` 重新下发。
  - 其他（`unsupported_kind`、`local_policy_denied`、`invalid_spec` 等）：终态，任务结束为 `failed`。
  - 同一 task id 已经 accepted 过时返回 `already_accepted`，按协议 bug 处理，绝不再次执行。
- **`task.cancel`**：响应只表示已收到并发出信号（任务已结束也返回 ok）；最终结果以 `task.exit`（`cancelled = true`）为准。
- **`task.query`**：`ok = true`，状态为 `running` / `exited` / `unknown`（客户端不认识这个 task id）；`ok = false` 只用于格式错误等真正的错误。

`task.start` 的接受/拒绝、`task.query` 的状态、`hello`/`welcome` 的断线恢复都是命令响应；任务输出、退出、facts、trust summary、node status 和两个 ack 都是事件。抽象是“双向命令/事件”，不是只有客户端推送。

### 心跳

- crha 有义务至少每 45 秒发一次 `ping`，推荐间隔为 30 秒加 ±5 秒的随机波动（避免大量节点同时 ping）。crhs 只回 `pong`。
- 任何一方超过 90 秒（两个最大间隔）收不到对方的任何消息，就断开连接并进入断线处理。
- 心跳走 Noise 通道内的应用层命令，不用 WebSocket 控制帧：它能证明整条会话路径还在工作，也不受中间代理自行处理控制帧的影响。

### 断线恢复

- 网络中断时客户端进程还在，任务继续运行，输出继续缓冲。
- 客户端以指数退避重连，在 `hello` 中带上运行中的任务列表；crhs 在 `welcome` 中回复各任务的确认偏移，客户端从这里补发输出。
- crhs 发现有未终结的任务不在客户端的列表中，就发 `task.query`；客户端返回不认识的 task id，任务标记为 `unknown(executor_restarted)`。
- crhs 重启后内存中的输出已经丢失，`welcome` 中的确认偏移为 0，crha 从头补发（crha 在收到 `task.exit.ack` 之前一直保留输出），所以 crhs 重启也不会丢输出。
- 大的输入（exec 的 stdin、文件内容）在 `task.start` 被 **accepted** 之后以 `task.input` 分块发送，`task.start` 中只带大小和 SHA-256。这样授权拒绝时不必传输输入；同一 task id 的授权重试（`attempt + 1`）也会重新发送输入。输入发送途中断线无法续传，crha 发现输入不完整，任务失败。
- 断线超过一定时间（默认 2 分钟），服务端先把这些任务对上层报告为 `unknown(connection_lost)`（尚未确认接受的为 `unknown(dispatch_unconfirmed)`）；如果之后客户端重连并报告了结果，再以“迟到结果”补记到审计和任务记录中，但不会改变已经返回给 agent 的结论。
- crhs 重启时对遗留的 `dispatched` / `running` 任务做同样的处理：客户端节点的任务从重启起算这段宽限期（期间重连则由 `hello` / `task.query` 恢复），SSH 节点的任务立即为 `unknown(connection_lost)`，连接已随进程消失。
- 为迟到结果保留在内存中的输出有上限（`UNKNOWN_OUTPUT_KEEP_MS`，10 分钟）；节点重连后查询到它也不认识该任务时立即释放，不必等满时限。

## 通信安全

### 威胁模型

| 攻击者 | 设计目标 |
|---|---|
| 网络中间人：窃听、篡改、重放 | 什么都做不到 |
| 终结 TLS 的第三方：反代、CDN、Cloudflare Tunnel 等 | 只能看到密文，无法注入消息 |
| 被盗的注册令牌 | 一次性、有效期短，且注册必须经过确认 |
| 被攻破的节点 | 只能看到发给自己的任务，也只能操作这些任务；无法冒充其他节点 |
| 被攻破的 crhs | 可以向节点下发普通命令；提权受 crha 特权模式的信任配置约束，见 privilege.md |

如果只用 TLS，终结 TLS 的一方就能看到全部明文，还能注入 `task.start`，等于拿到所有节点的普通用户 RCE。所以在 TLS 之内再加一层端到端加密。

### 两层结构

- **外层：WSS（TLS 1.3）**。只负责穿透网络和隐藏元数据。证书验证方式 `tls_verify` 可选 `system`（默认）或 `none`；服务端用自签证书时设为 `none` 不会降低安全性。
- **内层：Noise 通道**。`Noise_IK_25519_ChaChaPoly_BLAKE2s`，prologue 为 `"crh/2" ‖ 服务端挑战`（见下文"防重放"）。IK 表示客户端事先知道服务端的静态公钥（注册时固定下来）。1 个往返完成双向认证，具备前向保密。

### 握手

0. WebSocket 建立后，crhs 立即发送第一帧：32 字节随机**挑战**。它和 101 响应一起到达，不增加往返。
1. crha → crhs：携带客户端静态公钥（加密传输），载荷是固定 CBOR：`{protocol_major, protocol_minor, commands, crha_version, client_time_ms, enroll?}`。crhs 按公钥查找节点：
   - 找到已批准的节点：正常连接。
   - 找到 pending 的节点：建立**受限连接**，不接收任务，规则见下文"注册"。
   - 找不到，且载荷带有 `enroll`（注册令牌密钥、主机名、facts）、令牌有效：消耗令牌，创建绑定这把公钥的 pending 节点，同样建立受限连接。见下文"注册"。
   - 其余情况断开。
2. crhs → crha：载荷是固定 CBOR：`{protocol_major, protocol_minor, commands, connection_id, server_time_ms, node_state, node_id}`。crha 据此算出与服务端的时钟偏差，之后在 `facts` 中上报；偏差过大时双方都写警告日志，WebUI 显示警告（见 [privilege.md](privilege.md#时钟)）。之后进入 `hello` 和断线恢复流程。

- **防重放**：IK 的第一条消息本身可以被重放。被重放时攻击者没有客户端的临时私钥，解不开后续流量，但可以让 crhs 以为节点重新连上了（例如顶掉真实连接）。CRH 把服务端挑战放进 prologue：prologue 参与握手哈希，并作为载荷加密的附加数据，所以第一条消息只在发出它的那条连接上有效，换一条连接重放时载荷解密失败。
  - 不使用 WireGuard 的时间戳方案（crhs 记住每个节点最后一次握手的时间戳，拒绝不更新的）。那个方案只比较客户端自己前后两次的时间，不受双方时钟差影响，但依赖客户端时钟不回退：NTP 向后校正、RTC 电池失效、虚拟机快照回滚都会让节点在追上旧时间之前无法连接；时钟一旦误跳到未来再校正回来，节点会被锁定到那个未来时间。改用持久化计数器则在磁盘回滚、身份密钥被复制到新机器时出现同样的问题。另外 crhs 还要为每个节点持久化状态。
  - 挑战方案的代价：握手前必须先收到服务端的一帧。由于连接总是 crha 发起，这一帧随 101 响应到达，实际不增加延迟。服务端主动连接客户端的传输方式（M6）由 crha 一侧发送挑战，规则对称。
  - 握手中的客户端时间只用于诊断，不参与认证。
- **分帧**：一个 WebSocket 二进制消息承载一个 Noise 传输消息。Noise 单条消息上限 64KB，所以输出分片不超过 60KB。
- **密钥更新**：连接最长存活 24 小时，到期后主动重连并重新握手。断线恢复本来就很便宜，所以不单独实现 rekey。

### CBOR profile

协议和授权 payload 使用 `CBOR-CORE-INT-v1`：

- RFC 8949 **§4.2.1 Core Deterministic Encoding**（不是 §4.2.3 length-first）；
- TS 用 `cborg` 6.x 的 `rfc8949EncodeOptions`；Go 用 `fxamacker/cbor/v2` 的 `CoreDetEncOptions()`；
- 禁止 float、tag、indefinite-length、undefined 和自定义 simple value；
- 整数只允许 CBOR major 0/1 的原生范围，不用 bignum tag；
- map 的键只能是文本或整数（CBOR major 0/1/3）；其他类型的键在编码和解码时都是错误。
- 时间统一为 Unix epoch **毫秒整数**，不使用 ISO 字符串、`Date`、`time.Time` 自动编码或 tag 1；
- 严格解码（重复 key、非最短编码、未知字段、尾随 bytes 都拒绝），授权 payload 解码后重编码对比原始 bytes；
- 两端共用 `test/interop/cbor_core_golden_vectors.json` 的正例和拒绝例；
- 文本字符串必须是合法 UTF-8，不做 Unicode 规范化（不强制 NFC），原样保留：Linux 路径是字节序列，规范化可能指向另一个文件；签名覆盖原始 bytes，规则按精确字节匹配。非 UTF-8 路径暂不支持，需要时新增以 byte string 传路径的 `.v2` 命令。

### 实现

- Go：`flynn/noise`。
- TS：基于 Node 内置的 `crypto`（x25519、chacha20-poly1305、blake2s256）实现握手状态机，用 Noise 官方测试向量验证，并在 CI 中与 Go 实现交叉测试。
- 删除 protobuf、buf 和生成代码；TS/Go 类型手写，用 golden CBOR fixture 保证一致。

### 密钥

| 持有方 | 密钥 | 算法 | 用途 | 泄露后果 |
|---|---|---|---|---|
| crhs | 服务端身份密钥 | X25519 | Noise 通道 | 冒充 crhs，向节点下发普通命令（不能提权） |
| crhs | 授权签名密钥 | ssh-ed25519 | 签发授权与联署，见 privilege.md | 在信任 crhs 的节点上，在其信任项允许的范围内提权 |
| crhs | 主密钥 | 32 字节对称密钥 | 加密 `secrets` 表 | SSH 私钥、模型 API key 等泄露 |
| crha | 节点身份密钥 | X25519 | Noise 通道 | 冒充这个节点 |

- 节点身份密钥存放在配置的 `state_dir` 下的 `identity.key`，权限 0600，属主为 crha 用户（例如 `state_dir = "/var/lib/crha"` 时是 `/var/lib/crha/identity.key`）。
- crhs 的主密钥从 `crhs.toml` 中 `master_key_file` 指定的文件读取，不写进数据库。
- crhs 的身份私钥（轮换期间包括新旧两把）和授权签名私钥（不使用 ssh-agent 时）用主密钥加密后存放在 `secrets` 表中。

### 密钥导出

数据库备份只包含加密后的私钥，没有主密钥就无法恢复。所以 crhs 从一开始就提供密钥导出和导入：

- `crhs keys init`：生成主密钥文件（0600），并把主密钥的标识（HMAC 派生，不泄露密钥）记入数据库；之后 crhs 启动时发现密钥文件与数据库不匹配就拒绝启动，密钥文件对组或其他用户可读时也拒绝启动。
- `crhs keys export --out crhs-keys.age`：导出主密钥、crhs 身份私钥（含轮换中的旧密钥）、授权签名私钥。签名密钥由 ssh-agent 托管时只导出公钥，并在导出结果中注明。
- 导出文件用 [age](https://age-encryption.org/) 格式（ASCII armor）、口令加密（scrypt），口令在导出时交互输入（也可从 stdin 读入一行）。可以用标准的 `age` 工具解密核对，不依赖 crhs。
- `crhs keys import crhs-keys.age`：在新部署（或重建）时导入，配合数据库备份完成恢复。导入时检查数据库中的公钥与导出文件一致。
- 只提供本地命令行，不通过 WebUI 或 API 导出：需要能读取 `crhs.toml` 和主密钥文件，也就是能登录 crhs 所在的主机。每次导出都写入审计。
- 恢复 = 数据库备份 + 密钥导出文件。crha 节点不需要导出：节点身份密钥丢失时重新注册即可。

### 注册

crha 的源码不内置任何自身配置、状态、日志或 socket 的路径，全部由命令行 `--config` 和配置文件给出；唯一例外是节点上手动批准用的 `crha pending/approve/deny` 默认连接 `/run/crha/privileged.sock`（可用 `CRHA_PRIVILEGED_SOCKET` 或 `--socket` 覆盖）。WebUI 给出的 `/etc/crha/crha.toml`、`/var/lib/crha` 只是建议布局。

1. 管理员在 WebUI 创建注册令牌（节点属于组织），格式为 `crh1.<服务端身份公钥指纹>.<随机密钥>`。令牌只能使用一次，有效期默认 1 小时，可以限定节点名。
2. 在节点上执行 `crha enroll --config /etc/crha/crha.toml --state-dir /var/lib/crha https://crh.example.com crh1.xxxx.yyyy`：
   - `--config` 必填。配置文件已存在时必须已经写好 `server` 和 `state_dir`；文件不存在时，`--state-dir` 让 enroll 写一个只含 `server` 和 `state_dir` 的最小配置。省略 `--state-dir` 时 enroll 报错；文件已经存在时再给 `--state-dir` 也是错误。
   - 上面的 `/etc/crha/crha.toml` 和 `/var/lib/crha` 只是建议布局，不是 crha 的默认值。
   - 通过 HTTPS 获取服务端身份公钥，**检查它与令牌中的指纹一致**，然后固定下来。令牌本身就完成了信任引导，做法与 kubeadm 的 `--discovery-token-ca-cert-hash` 相同。
   - 生成节点身份密钥，发起 Noise IK 握手，在第一条消息的载荷中带上 `enroll`（令牌密钥、主机名和 facts）。这是唯一允许未知公钥完成握手的情况。令牌密钥在 Noise 通道内传输，终结 TLS 的一方看不到；第一条消息即使被重放，令牌也已经被消耗。
3. crhs 校验令牌后，节点进入 **pending** 状态。**注册必须经过确认**：管理员在 WebUI 核对主机名和节点公钥指纹（节点上可以用 `crha status --config <crha.toml>` 查看指纹）后批准，节点才能接收任务。在此之前，节点用自己的公钥重连时只能建立受限连接；被拒绝时删除这把公钥。
4. **受限连接**：握手响应的 `node_state = pending` 已经告诉 crha 自己的状态，不另设“查询注册状态”的命令，状态变化全部由 crhs 推送。
   - 只允许 C→S 的 `hello`（任务列表为空）、`ping`、`facts` 和 S→C 的 `node.status`；其他命令由 crhs 返回 `node_pending`。
   - 批准：crhs 推送 `node.status{active}` 后关闭连接；crha 不退避立即重连，握手得到完整连接。不在已有连接上原地切换权限，与普通重连走同一条路径。
   - 拒绝：crhs 删除公钥，推送 `node.status{rejected}` 后关闭连接；crha 停止重连，`crha status --config <crha.toml>` 显示被拒绝。
   - 已批准节点被禁用（active → disabled）同样先推送 `node.status{disabled}` 再断开，之后握手失败。

### 轮换与吊销

- **吊销节点**：crhs 删除它的公钥，下次握手即失败；已建立的连接立即断开。
- **轮换节点密钥**：执行 `crha rotate-key`，在已认证的连接上提交新公钥，crhs 切换后旧密钥作废。
- **轮换服务端身份密钥**：crhs 可以同时持有新旧两把密钥。通过已认证的连接把新公钥推送给所有节点，节点同时固定新旧两把；过渡期结束后移除旧密钥。过渡期内一直不在线的节点需要重新注册。

### crha 本地策略（可选）

`crha.toml`（`--config` 指定的文件）中可以配置节点自己的限制，例如 `allow_kinds`、`read_only`，用来约束 crhs 能让 crha 非特权模式做什么。即使 crhs 被攻破，这些限制依然有效。

尚未实现：crha 1.0 不读取这些设置，也从不返回 `local_policy_denied`。

## crha 的重载与升级

- **reload**：每个进程都在收到 SIGHUP 时重新读取自己的配置文件：`crha run` 重读 `crha.toml`，`crha privileged run` 重读 `privileged.toml`（重载后向 crhs 推送新的 `TrustSummary`）。crha 不提供自己的 reload 命令，通常由服务管理器发送信号，例如 systemd 的 `ExecReload=/bin/kill -HUP $MAINPID`（OpenRC 的 `reload` 同理）。
  - 新配置无效时，进程继续使用正在运行的配置，并在日志中记录错误（`reload failed, keeping the current configuration`）。
  - 笔记路径变化：重新上报 `facts`；服务端地址、`tls_verify` 变化：重新连接；`state_dir`、`[output]`、`[privileged]` 的变化要重启才生效（会记录警告）。节点组不经过 crha，由管理员在 crhs 中调整。
- **修改配置**：就是普通的特权任务：`file.write` 写配置文件，再向对应的进程发 SIGHUP（通常通过服务管理器的 reload）。
- **升级**：同样是普通的特权任务：
  1. `file.write` 写入新的二进制（或者 `exec` 调用包管理器安装）；
  2. `exec crha upgrade --apply <路径>`：校验新二进制能运行并报告版本，原子替换，然后通过 `systemd-run --on-active=2s` 延迟重启服务。这样当前任务可以先上报结果，再被重启打断。
- 重启会让节点上正在运行的任务变为 `unknown(executor_restarted)`。crhs 在下发升级任务前提示还有哪些任务在运行，并可以选择等它们结束。

## SSH 传输

SSH 节点不安装任何东西，服务端通过 SshTransport 执行，对上层提供与自有客户端相同的任务接口。

SSH 的 `privileged` 语义：crhs 仍按特权任务做规则/审批（方便 agent 批量下发提权命令），执行时忽略特权，以 SSH 用户运行，并在任务输出中提示。这一行提示保存在 `tasks.notice`，不进输出流（D114），`status` 模式下也一样保留。若 SSH 用户本身是 root，这是实际 root 执行；不能描述成“已拒绝提权”。

| 能力 | 自有客户端 | SSH |
|---|---|---|
| exec / 文件操作 | ✅ | ✅（exec 走 exec channel；文件操作走 SFTP，语义、JSON 输出和错误码与 crha 一致，差异见下文） |
| 断线续传 | ✅ | ❌ 连接一断，任务即为 `unknown(connection_lost)` |
| 反向连接 | ✅ | ❌ 服务端必须能访问节点的 SSH 端口 |
| 特权任务 | 四种处理方式（见 privilege.md） | 不参与提权：`privileged` 被忽略，按 SSH 用户执行，并在任务输出中提示；保留 SFTP `file.*` |
| 节点本地日志 | 特权模式本地日志 + journald | 只有系统自带日志（sshd、sudo） |

### 跳板机

SSH 节点可以配置一个或多个跳板（等价于 OpenSSH 的 `ProxyJump`）：

- 每一跳单独配置主机、端口、用户、凭证，并**分别固定主机密钥**；
- v1 中所有跳使用同一个凭证；
- 实现上用 `ssh2` 在上一跳上 `forwardOut` 出到下一跳的 TCP 通道，逐级建立连接；
- 任何一跳断开，都等同于连接中断，任务为 `unknown(connection_lost)`。

### 添加 SSH 节点

1. **凭证**：crhs 生成 ed25519 密钥对，私钥用主密钥加密存入 `secrets`，只把公钥交给用户，由用户加到每一跳目标用户的 `authorized_keys`。凭证属于组织，只有管理员可以创建、查看、删除和绑定。
2. **探测主机密钥**：`POST /api/ssh-nodes/probe` 每次返回第一个尚未固定的跳的主机密钥指纹（`SHA256:…`，与 `ssh-keygen -lf` 一致），只握手、不认证；用户在那台主机上核对后固定，再探测下一跳。
3. **创建**：每一跳都已固定主机密钥才能创建。SSH 节点没有 crha，它和 crha 节点一样通过 crhs 的节点组组织。
4. **测试连接**（可选，创建前后都可以）：`POST /api/ssh-nodes/test`（未保存的路由）或 `POST /api/nodes/:id/ssh-test`（已保存的节点，仅管理员）按固定的主机密钥逐跳认证，并在目标上执行 `true`，能发现公钥没装好、账户不能执行命令（`ForceCommand`、nologin）等问题。
5. **之后**：管理员在节点页面看到完整路由和固定的主机密钥，并可以用 `PUT /api/nodes/:id/node-groups` 调整它所属的节点组（crha 节点和 SSH 节点一样，成员关系都在 crhs 中维护）。SSH 节点的"最后在线"是最后一次到达节点的任务的时间；它没有常驻连接，所以不显示在线/离线。

### 对节点的要求

- 登录 shell 能解析 POSIX 风格的 `cd … || exit 127; exec …`：bash、zsh、dash、ash、ksh 可以；fish、nushell、csh 系列，以及设置了 `ForceCommand`、受限 shell（`rbash`）或 `command=` 限制的账户不支持。
- 有 sh 和 `env`；取消要用 shell 内建或 `/bin/kill` 的 `kill -<SIG> -- -<pgid>`。
- 文件任务要求 sshd 启用 SFTP 子系统。
- 不分配 pty，环境就是非交互 SSH 会话的环境：bash 作为登录 shell 时会读 `~/.bashrc`，其他 shell 基本不读任何配置文件，所以 `PATH` 等可能与交互登录时不同。`HOME`、`USER`、`LOGNAME`、`SHELL` 由 sshd 按账户设置；crhs 只额外设置 `LANG=C.UTF-8`、`LC_ALL=C.UTF-8`（任务的 `env` 可以覆盖）。需要的变量请在任务的 `env` 中给出，或使用绝对路径。名字以 `CRHA_TASK_` 开头的变量与 crha 节点一样被丢弃。
- 不参与特权任务：`privileged` 标志被忽略，按 SSH 用户执行；SSH 没有 `native`/`forward`/信任配置。

### 执行

- **sh 的发现**：每条新建的连接（连接池换新连接时也一样）先执行一次探测，按与 crha 相同的顺序找 sh 和 bash：`/etc/shells` 中第一个文件名为 `sh` / `bash` 的存在且可执行的绝对路径，然后 `command -v`。结果写入节点 `facts` 的 `shells`（SSH 节点的 facts 只有这一项），之后这条连接上的任务都用探测到的 sh；探测不到 sh 时用 `/bin/sh`。授权和显示的渲染与 crha 节点相同，仍是 `/bin/sh -c '<cmd>'`。
- **进程组**：sshd 启动命令时已经为它新建会话，命令所在 shell 的 pid 就是进程组 id。远端命令是 `cd <cwd> || exit 127; exec env -- LANG=C.UTF-8 LC_ALL=C.UTF-8 [K=V…] <sh> -c '<wrapper>' crh <argv…>`（`shell` 命令的 argv 是 `<sh> -c <cmd>`），wrapper 先在 stderr 第一行输出 `$$`（crhs 解析后剥掉），然后 `exec 2>&1` 把之后的 stderr 并入 stdout（D114），再 `exec` 真正的命令；所以 SSH 节点的输出同样只有一个流，crhs 不需要自己合并。不用 `setsid(1)`：调用者已经是进程组组长时它会 fork，退出码就丢了。
- **取消与超时**：另开 exec channel 执行 `kill -TERM -- -<pgid>`，宽限期后 `kill -KILL`；与 crha 相同，结果报告为 signal。在建立连接或探测 shell 期间取消的任务从未执行，以 `exited`、`cancelled = true` 结束，不会补发命令。
- **退出状态**：短命令的输出和退出状态可能与 channel 打开确认在同一个包里到达，监听器必须在 channel 打开的回调中同步挂上。
- **连接**：每个节点复用一条连接（keepalive 10 秒、3 次），任何一跳断开都关闭整条连接。池中的连接已失效而任务尚未开始时，换新连接重试一次。
- **结果**：连接失败（远端还没开始执行）为 `failed(connect_failed | host_key_mismatch)`；远端开始执行后连接断开为 `unknown(connection_lost)`。输出只有 crhs 保存的头尾，没有输出文件。

### SFTP 文件操作与 crha 的差异

- `file.read` 与 crha 一样按行分页：从文件开头流式读取，页面读完就停，只有页面到达文件末尾时才继续读到结尾；没有内存中的完整文件，读深页要重新扫描前面的行（见 [roadmap.md](roadmap.md) 的已知问题）。
- 不支持按名称设置属主（`owner`/`group` 非空时为 `invalid_spec`）；`stat` 只返回数字 uid/gid。
- 非覆盖写入是"先检查再 rename"，不像 `RENAME_NOREPLACE` 那样原子；覆盖写入使用 `posix-rename@openssh.com`，服务端不支持时退化为 unlink + rename。
- 不做 fsync；mtime 只有秒级精度。
