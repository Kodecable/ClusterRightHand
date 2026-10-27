# 执行平面

执行平面负责"把任务送到节点上执行并拿回结果"。它不感知 agent、会话和模型，只认识任务。

## 任务模型

任务 id 由服务端生成（UUIDv7），是执行平面里唯一的任务标识。

### 任务类型（v1）

| kind | 说明 |
|---|---|
| `exec` | 执行命令：`argv`（直接执行）或 `shell`（`sh -c`）；可选 `env`、`cwd`、`stdin`、超时 |
| `file.read` | 读文件，支持偏移和长度上限 |
| `file.write` | 原子写（临时文件 + rename）；可设置 mode/owner。默认只**创建新文件**，目标已存在时失败（`renameat2` 的 `RENAME_NOREPLACE`）；`overwrite = true` 时才覆盖 |
| `file.edit` | 按原文替换，格式与 pi 的 edit 工具相同：`edits[]`，每项 `oldText` / `newText`，`oldText` 必须在文件中出现且只出现一次，所有替换都针对原始内容匹配；保留 BOM 和换行风格；结果原子写回 |
| `file.stat` | 文件元信息 |
| `file.list` | 列目录，有条目数上限 |

编辑由 crha 在节点上完成：读取、匹配、替换、写回连续执行，中间不经过网络。不使用哈希校验，`oldText` 本身就是冲突检测：

- 别人改的是文件的其他位置：编辑照常成功，对方的修改保留。
- 别人改的正是这一段：`oldText` 匹配不到（或不再唯一），编辑失败，agent 重新读取再改。
- **审批延迟**：特权编辑的 `exact` 授权绑定 `edits` 本身，用户批准的是"把这段改成那段"。等待审批期间文件变了，只要 `oldText` 仍然唯一匹配，执行的仍然是用户批准的那个修改；不匹配就失败。
- **防覆盖**：`file.write` 默认只创建新文件，避免模型用整文件写入意外覆盖现有内容；确实需要整体替换时显式打开 `overwrite`。
- 剩余的竞态（crha 读取和 rename 之间的极短窗口）与 pi 在本地编辑时相同，接受。

PTY 交互、文件传输等后续再加。

### 通用字段

```
task_id        UUIDv7
node_id
kind, spec     见上
privileged     true | false             # true 时为特权任务，走授权链路，见 privilege.md
authorization  可选：特权任务的授权（一个授权，需要联署时再加一个联署；本地批准时为空），见 privilege.md
timeout_ms     超时后先发 SIGTERM，宽限期过后发 SIGKILL（杀整个进程组）
output_limit   客户端为该任务缓冲输出的上限
```

### 状态机（服务端视角）

```
created ──▶ awaiting_approval ──▶ dispatched ──▶ running ──▶ exited(code)
   │               │                  │             │
   │               └──▶ rejected      │             ├──▶ failed(reason)      执行器层面的错误，例如命令不存在、授权校验失败
   └──▶ denied(策略拒绝)              │             ├──▶ cancelled
                                      └─────────────┴──▶ unknown(reason)
```

`unknown` 是执行平面唯一的"结果不确定"状态，reason 取值：

| reason | 触发条件 |
|---|---|
| `connection_lost` | 已下发的任务在终态之前连接断开，且断线恢复失败（SSH 节点一断即是） |
| `executor_restarted` | 重连后查询任务，客户端不认识这个任务 id（客户端进程重启过） |
| `dispatch_unconfirmed` | `start` 已发出但未收到 `accepted`，连接就断了 |

向 agent 报告的内容是："失败，状态未知，原因是 xxx"。是否重试、重试前要不要先检查机器状态，由 agent 或使用者决定。

### 节点不在线

创建任务时节点没有连接，任务直接以 `failed(node_offline)` 结束，不排队等待节点上线：任务从未下发，不属于 `unknown`。

### 不重复执行

- 同一个任务 id 的 `start` **最多下发一次**。
- 重连后服务端只对未终结的任务发 `query`，不会重新发 `start`。
- 客户端收到不认识的 `query` 时回复 `unknown_task`。

这三条保证任何情况下同一个任务都不会被执行两次。客户端不持久化任务，也不做任何重放。

## 输出

- 输出按流（stdout/stderr）分开，每个分片带字节偏移 `offset`，实时推送给 crhs。
- **crhs 只保存截断后的输出**：stdout 和 stderr 各自的头部和尾部（各 2000 行或 50KB，先到为准），不保存完整输出，也没有输出保留策略。
- **过长的输出由 crha 在节点上保存为普通文件**：输出超过 2000 行或 50KB（与交给模型的截断阈值相同，因此只要模型看到的输出被截断，就一定有完整输出文件；阈值随 `TaskStart` 下发）时，crha 非特权模式把完整输出写入 `[output].dir`（默认 `/var/lib/crha/output/<task_id>.log`，stdout 和 stderr 按到达顺序交错写入，与终端里 `2>&1` 看到的一致；crha 在内存中保留分段索引，用于按流续传），`TaskExit` 中带上文件路径和总字节数。文件权限 0600，属主为非特权模式的运行用户（输出可能包含敏感内容）。agent 需要完整输出时，用普通的 `read_file` 读取。
  - 特权任务的输出本来就经由非特权模式转发，所以同样由非特权模式保存，不会因此多暴露什么。
  - 这些文件的清理由 crha 负责，按 `crha.toml` 中 `[output]` 的 `max_age` 和 `max_total` 配置（默认 7 天、1GB）。
- **断线续传**：任务运行期间，以及结束后到 crhs 确认（`OutputAck`）之前，crha 保留未确认的输出：输出较短时在内存中，已经写入文件的直接从文件中补发。所以不会因为缓冲溢出而丢失输出。
- **SSH 节点**：强制截断，只有 crhs 保存的头尾，不支持保存完整输出。

## 自有协议

### 分层

```
消息层     Protobuf 消息（proto/ 下定义）
会话层     Hello / 心跳 / 断线恢复
安全层     Noise_IK 端到端加密通道（双向认证），见"通信安全"
传输层     任意可靠有序的消息流：
           v1：WebSocket over TLS（客户端主动连服务端，即"反向连接"，默认方式）
           后续：由服务端主动连客户端（节点有公网入口、服务端在内网时使用）
```

消息层、会话层和安全层都与传输解耦，新增传输方式时不需要改协议，也不需要重新设计认证。

### 消息草案

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `Hello` | node_id、客户端版本、能力（支持的 kind、特权任务的处理方式、两种模式各自的运行身份）、运行中任务列表 `{task_id, state, stdout_end, stderr_end}` |
| S→C | `Welcome` | 附带对运行中任务的输出确认偏移，客户端从这里续传（双向认证已在 Noise 握手中完成） |
| C→S | `Facts` | 系统信息：发行版、内核、架构、init 系统、包管理器、sudo/doas/run0 是否可用；节点笔记路径；节点所属的组（配置变化时主动推送）；与 crhs 的时钟偏差 |
| S→C | `TaskStart` | 任务规格 + 授权凭证 |
| C→S | `TaskAccepted` / `TaskRejected` | 接受，或拒绝（附原因，例如不支持的 kind、授权校验失败） |
| C→S | `TaskOutput` | `{task_id, stream, offset, data}` |
| S→C | `OutputAck` | `{task_id, stream, offset}`，确认后客户端可以释放缓冲 |
| C→S | `TaskExit` | 退出码 / 信号 / 执行器错误，最终输出偏移；完整输出文件的路径（如果有） |
| S→C | `TaskCancel` | 取消（TERM → 宽限期 → KILL） |
| S→C | `TaskQuery` / C→S `TaskStatus` | 查询状态；不认识的任务回复 `unknown_task` |
| S→C | `TrustQuery` / C→S `TrustSummary` | 查询特权模式的信任配置；配置变化时客户端主动推送，见 privilege.md |
| S→C | `Preflight` / C→S `PreflightResult` | 询问特权模式哪些信任项可以授权某个任务 |
| S→C | `Revocations` | 下发吊销列表，由非特权模式转交特权模式 |
| C→S | `Ping` / S→C `Pong` | 心跳，只由 crha 发起，规则见下 |

### 心跳

- crha 有义务至少每 45 秒发一次 `Ping`，推荐间隔为 30 秒加 ±5 秒的随机波动（避免大量节点同时 ping）。crhs 不主动 ping，只回 `Pong`。
- 任何一方超过 90 秒（两个最大间隔）收不到对方的任何消息，就断开连接并进入断线处理。crhs 靠这条规则发现挂起的 crha 和不会送达关闭的半开连接；crha 靠 `Pong` 发现 crhs 已失联。
- 心跳走 Noise 通道内的应用层消息，不用 WebSocket 控制帧：它能证明整条会话路径（解密、分发、回包）还在工作，也不受中间代理自行处理控制帧的影响。

### 断线恢复

- 网络中断时客户端进程还在，任务继续运行，输出继续缓冲。
- 客户端以指数退避重连，在 `Hello` 中带上运行中的任务列表；服务端回复各任务的确认偏移，客户端从该偏移补发输出。
- 服务端发现有未终结的任务不在客户端的列表中，就发 `TaskQuery` 确认；客户端回复 `unknown_task` 后，任务标记为 `unknown(executor_restarted)`。
- crhs 重启后内存中的输出已经丢失，Welcome 中的确认偏移为 0，crha 从头补发（crha 在收到 `TaskExitAck` 之前一直保留输出），所以 crhs 重启也不会丢输出。
- 大的输入（exec 的 stdin、文件内容）在 `TaskStart` 之后以 `TaskInput` 分块发送，`TaskStart` 中只带大小和 SHA-256；输入发送途中断线无法续传（`TaskStart` 只发一次），crha 发现输入不完整，任务失败。
- 断线超过一定时间（默认 2 分钟），服务端先把这些任务对上层报告为 `unknown(connection_lost)`（尚未确认接受的为 `unknown(dispatch_unconfirmed)`）；如果之后客户端重连并报告了结果，再以"迟到结果"补记到审计和任务记录中，但不会改变已经返回给 agent 的结论。

## 通信安全

### 威胁模型

| 攻击者 | 设计目标 |
|---|---|
| 网络中间人：窃听、篡改、重放 | 什么都做不到 |
| 终结 TLS 的第三方：反代、CDN、Cloudflare Tunnel 等 | 只能看到密文，无法注入消息 |
| 被盗的注册令牌 | 一次性、有效期短，且注册必须经过确认 |
| 被攻破的节点 | 只能看到发给自己的任务，也只能操作这些任务；无法冒充其他节点 |
| 被攻破的 crhs | 可以向节点下发普通命令；提权受 crha 特权模式的信任配置约束，见 privilege.md |

如果只用 TLS，终结 TLS 的一方就能看到全部明文，还能注入 `TaskStart`，等于拿到所有节点的普通用户 RCE。所以在 TLS 之内再加一层端到端加密。

### 两层结构

- **外层：WSS（TLS 1.3）**。只负责穿透网络和隐藏元数据。证书验证方式 `tls_verify` 可选 `system`（默认）或 `none`；服务端用自签证书时设为 `none` 不会降低安全性。
- **内层：Noise 通道**。`Noise_IK_25519_ChaChaPoly_BLAKE2s`，prologue 为 `"crh/1" ‖ 服务端挑战`（见下文"防重放"）。IK 表示客户端事先知道服务端的静态公钥（注册时固定下来）。1 个往返完成双向认证，具备前向保密。

### 握手

0. WebSocket 建立后，crhs 立即发送第一帧：32 字节随机**挑战**。它和 101 响应一起到达，不增加往返。
1. crha → crhs：携带客户端静态公钥（加密传输），载荷为 `{crha 版本, 客户端时间, enroll?}`。crhs 按公钥查找节点：
   - 找到已批准的节点：正常连接。
   - 找到 pending 的节点：建立**受限连接**，只能上报 Facts 和查询注册状态，不接收任务。
   - 找不到，且载荷带有 `enroll`（注册令牌密钥、主机名、Facts）、令牌有效：消耗令牌，创建绑定这把公钥的 pending 节点，同样建立受限连接。见下文"注册"。
   - 其余情况断开。
2. crhs → crha：载荷为 `{连接 id, 服务端时间}`。crha 据此算出与服务端的时钟偏差，之后在 `Facts` 中上报；偏差过大时双方都写警告日志，WebUI 显示警告（见 [privilege.md](privilege.md#时钟)）。之后进入 `Hello` 和断线恢复流程。

- **防重放**：IK 的第一条消息本身可以被重放。被重放时攻击者没有客户端的临时私钥，解不开后续流量，但可以让 crhs 以为节点重新连上了（例如顶掉真实连接）。CRH 把服务端挑战放进 prologue：prologue 参与握手哈希，并作为载荷加密的附加数据，所以第一条消息只在发出它的那条连接上有效，换一条连接重放时载荷解密失败。
  - 不使用 WireGuard 的时间戳方案（crhs 记住每个节点最后一次握手的时间戳，拒绝不更新的）。那个方案只比较客户端自己前后两次的时间，不受双方时钟差影响，但依赖客户端时钟不回退：NTP 向后校正、RTC 电池失效、虚拟机快照回滚都会让节点在追上旧时间之前无法连接；时钟一旦误跳到未来再校正回来，节点会被锁定到那个未来时间。改用持久化计数器则在磁盘回滚、身份密钥被复制到新机器时出现同样的问题。另外 crhs 还要为每个节点持久化状态。
  - 挑战方案的代价：握手前必须先收到服务端的一帧。由于连接总是 crha 发起，这一帧随 101 响应到达，实际不增加延迟。服务端主动连接客户端的传输方式（M6）由 crha 一侧发送挑战，规则对称。
  - 握手中的客户端时间只用于诊断，不参与认证。
- **分帧**：一个 WebSocket 二进制消息承载一个 Noise 传输消息。Noise 单条消息上限 64KB，所以输出分片不超过 60KB。
- **密钥更新**：连接最长存活 24 小时，到期后主动重连并重新握手。断线恢复本来就很便宜，所以不单独实现 rekey。

### 实现

- Go：`flynn/noise`。
- TS：基于 Node 内置的 `crypto`（x25519、chacha20-poly1305、blake2s256）实现握手状态机，用 Noise 官方测试向量验证，并在 CI 中与 Go 实现交叉测试。

### 密钥

| 持有方 | 密钥 | 算法 | 用途 | 泄露后果 |
|---|---|---|---|---|
| crhs | 服务端身份密钥 | X25519 | Noise 通道 | 冒充 crhs，向节点下发普通命令（不能提权） |
| crhs | 授权签名密钥 | ssh-ed25519 | 签发授权与联署，见 privilege.md | 在信任 crhs 的节点上，在其信任项允许的范围内提权 |
| crhs | 主密钥 | 32 字节对称密钥 | 加密 `secrets` 表 | SSH 私钥、模型 API key 等泄露 |
| crha | 节点身份密钥 | X25519 | Noise 通道 | 冒充这个节点 |

- 节点身份密钥存放在 `/var/lib/crha/identity.key`，权限 0600，属主为 crha 用户。
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

1. 用户在 WebUI 创建注册令牌（节点将归这个用户所有），格式为 `crh1.<服务端身份公钥指纹>.<随机密钥>`。令牌只能使用一次，有效期默认 1 小时，可以限定节点名。
2. 在节点上执行 `crha enroll https://crh.example.com crh1.xxxx.yyyy`：
   - 通过 HTTPS 获取服务端身份公钥，**检查它与令牌中的指纹一致**，然后固定下来。令牌本身就完成了信任引导，做法与 kubeadm 的 `--discovery-token-ca-cert-hash` 相同。
   - 生成节点身份密钥，发起 Noise IK 握手，在第一条消息的载荷中带上 `enroll`（令牌密钥、主机名和 Facts）。这是唯一允许未知公钥完成握手的情况。令牌密钥在 Noise 通道内传输，终结 TLS 的一方看不到；第一条消息即使被重放，令牌也已经被消耗。
3. crhs 校验令牌后，节点进入 **pending** 状态。**注册必须经过确认**：令牌的创建者（节点所有者）或管理员在 WebUI 核对主机名和节点公钥指纹（节点上可以用 `crha status` 查看指纹）后批准，节点才能接收任务。在此之前，节点用自己的公钥重连时只能建立受限连接；被拒绝时删除这把公钥。

### 轮换与吊销

- **吊销节点**：crhs 删除它的公钥，下次握手即失败；已建立的连接立即断开。
- **轮换节点密钥**：执行 `crha rotate-key`，在已认证的连接上提交新公钥，crhs 切换后旧密钥作废。
- **轮换服务端身份密钥**：crhs 可以同时持有新旧两把密钥。通过已认证的连接把新公钥推送给所有节点，节点同时固定新旧两把；过渡期结束后移除旧密钥。过渡期内一直不在线的节点需要重新注册。

### crha 本地策略（可选）

`/etc/crha/crha.toml` 中可以配置节点自己的限制，例如 `allow_kinds`、`read_only`，用来约束 crhs 能让 crha 非特权模式做什么。即使 crhs 被攻破，这些限制依然有效。

## crha 的重载与升级

- **reload**：`crha reload`（或者给进程发 SIGHUP）让两种模式重新读取配置。特权模式重载信任配置后，向 crhs 推送新的 `TrustSummary`。
  - `crha reload` 先校验配置文件，有错误就直接报告给执行者，不发信号；`crha run` 写 `<state_dir>/crha.pid` 供它查找。
  - 运行中的进程收到 SIGHUP 但新配置无效时，继续使用旧配置并记录错误。
  - 组、笔记路径变化：重新上报 `Facts`；服务端地址、`tls_verify` 变化：重新连接；`state_dir`、`[output]`、`[privileged]` 的变化要重启才生效（会记录警告）。
- **修改配置**：就是普通的特权任务：`file.write` 写配置文件，再执行 `crha reload`。
- **升级**：同样是普通的特权任务：
  1. `file.write` 写入新的二进制（或者 `exec` 调用包管理器安装）；
  2. `exec crha upgrade --apply <路径>`：校验新二进制能运行并报告版本，原子替换，然后通过 `systemd-run --on-active=2s` 延迟重启服务。这样当前任务可以先上报结果，再被重启打断。
- 重启会让节点上正在运行的任务变为 `unknown(executor_restarted)`。crhs 在下发升级任务前提示还有哪些任务在运行，并可以选择等它们结束。

## SSH 传输

SSH 节点不安装任何东西，服务端通过 SshTransport 执行，对上层提供与自有客户端相同的任务接口。

| 能力 | 自有客户端 | SSH |
|---|---|---|
| exec / 文件操作 | ✅ | ✅（exec 走 exec channel；文件操作走 SFTP，语义、JSON 输出和错误码与 crha 一致，差异见下文） |
| 断线续传 | ✅ | ❌ 连接一断，任务即为 `unknown(connection_lost)` |
| 反向连接 | ✅ | ❌ 服务端必须能访问节点的 SSH 端口 |
| 特权任务 | 四种处理方式（见 privilege.md） | 只支持 `native`（`sudo -n` / `doas -n` / `run0`，非交互）、`ignore`（SSH 用户本身就是目标身份时）、`reject` |
| 节点本地日志 | 特权模式本地日志 + journald | 只有系统自带日志（sshd、sudo） |

### 跳板机

SSH 节点可以配置一个或多个跳板（等价于 OpenSSH 的 `ProxyJump`）：

- 每一跳单独配置主机、端口、用户、凭证，并**分别固定主机密钥**；
- v1 中所有跳使用同一个凭证；
- 实现上用 `ssh2` 在上一跳上 `forwardOut` 出到下一跳的 TCP 通道，逐级建立连接；
- 任何一跳断开，都等同于连接中断，任务为 `unknown(connection_lost)`。

### 添加 SSH 节点

1. **凭证**：crhs 生成 ed25519 密钥对，私钥用主密钥加密存入 `secrets`，只把公钥交给用户，由用户加到每一跳目标用户的 `authorized_keys`。凭证属于创建者，管理员可以使用任何凭证。
2. **探测主机密钥**：`POST /api/ssh-nodes/probe` 每次返回第一个尚未固定的跳的主机密钥指纹（`SHA256:…`，与 `ssh-keygen -lf` 一致），只握手、不认证；用户在那台主机上核对后固定，再探测下一跳。
3. **创建**：每一跳都已固定主机密钥才能创建。SSH 节点没有 crha，它的组在 crhs 中直接维护。
4. **测试连接**（可选，创建前后都可以）：`POST /api/ssh-nodes/test`（未保存的路由）或 `POST /api/nodes/:id/ssh-test`（已保存的节点，需要 operate 权限）按固定的主机密钥逐跳认证，并在目标上执行 `true`，能发现公钥没装好、账户不能执行命令（`ForceCommand`、nologin）等问题。
5. **之后**：节点的所有者和管理员在节点页面看到完整路由和固定的主机密钥，并可以用 `PUT /api/nodes/:id/groups` 修改组（crha 节点的组来自 crha 配置，不能这样改）。SSH 节点的"最后在线"是最后一次到达节点的任务的时间；它没有常驻连接，所以不显示在线/离线。

### 对节点的要求

- 登录 shell 能解析 POSIX 风格的 `cd … || exit 127; exec …`：bash、zsh、dash、ash、ksh 可以；fish、nushell、csh 系列，以及设置了 `ForceCommand`、受限 shell（`rbash`）或 `command=` 限制的账户不支持。
- 有 `/bin/sh` 和 `env`；取消要用 shell 内建或 `/bin/kill` 的 `kill -<SIG> -- -<pgid>`。
- 文件任务要求 sshd 启用 SFTP 子系统。
- 不分配 pty，环境就是非交互 SSH 会话的环境：bash 作为登录 shell 时会读 `~/.bashrc`，其他 shell 基本不读任何配置文件，所以 `PATH` 等可能与交互登录时不同。需要的变量请在任务的 `env` 中给出，或使用绝对路径。
- 特权任务（`native`）要求 `sudo -n` / `doas -n` 免密可用，见 privilege.md。

### 执行

- **进程组**：sshd 启动命令时已经为它新建会话，命令所在 shell 的 pid 就是进程组 id。远端命令是 `cd <cwd> || exit 127; exec [env -- K=V…] /bin/sh -c '<wrapper>' crh <argv…>`，wrapper 先在 stderr 第一行输出 `$$`（crhs 解析后剥掉），再 `exec` 真正的命令。不用 `setsid(1)`：调用者已经是进程组组长时它会 fork，退出码就丢了。
- **取消与超时**：另开 exec channel 执行 `kill -TERM -- -<pgid>`，宽限期后 `kill -KILL`；与 crha 相同，结果报告为 signal。
- **退出状态**：短命令的输出和退出状态可能与 channel 打开确认在同一个包里到达，监听器必须在 channel 打开的回调中同步挂上。
- **连接**：每个节点复用一条连接（keepalive 10 秒、3 次），任何一跳断开都关闭整条连接。池中的连接已失效而任务尚未开始时，换新连接重试一次。
- **结果**：连接失败（远端还没开始执行）为 `failed(connect_failed | host_key_mismatch)`；远端开始执行后连接断开为 `unknown(connection_lost)`。输出只有 crhs 保存的头尾，没有输出文件。

### SFTP 文件操作与 crha 的差异

- 不支持按名称设置属主（`owner`/`group` 非空时为 `invalid_spec`）；`stat` 只返回数字 uid/gid。
- 非覆盖写入是"先检查再 rename"，不像 `RENAME_NOREPLACE` 那样原子；覆盖写入使用 `posix-rename@openssh.com`，服务端不支持时退化为 unlink + rename。
- 不做 fsync；mtime 只有秒级精度。
