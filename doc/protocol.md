# crhs ↔ crha 协议 schema（M3.5 / M4）

[execution-plane.md](execution-plane.md#自有协议m35) 规定协议的语义；本文规定**线上格式**，TS（`packages/protocol`）和 Go（`client/internal/protocol`）都按本文手写，用 `test/interop/` 的 fixture 交叉验证。两者不一致时以本文为准；本文有歧义时先改本文。

协议版本：`protocol_major = 2`，`protocol_minor = 0`。大版本 2 是本批的不兼容修改（`file.read` 改为按行、`task.exit` 增加第 8 个元素 `result`）；大版本 1 中 `minor = 1` 是 M4 的命令集合，`minor = 0` 是 M3.5 的命令集合。Noise prologue 为 `"crh/2" ‖ 挑战`。

## 编码规则

所有字节按 `CBOR-CORE-INT-v1` 编码（见 execution-plane.md 的 CBOR profile）。在此之上：

- **结构一律是定长数组（元组）**，按本文列出的顺序；解码时长度必须完全相等。没有可选字段，只有可空字段（标 `?`，值为 CBOR `null`）。唯一的例外是 `Facts`，它是文本键的 map（见[命令与事件](#命令与事件)）。
- **联合类型**编码为 `[tag, body]`，`tag` 是文本，`body` 是该分支的类型；未知 tag 是解码错误。
- **枚举**是文本，取值列在类型旁边；其他值是解码错误。
- 基本类型：`uint`（0 ≤ n ≤ 2^53−1）、`int`（|n| ≤ 2^53−1）、`bool`、`text`（合法 UTF-8，不规范化）、`bytes`（CBOR byte string）、`[T]`（数组）、`{text: text}`（只用于 `env`，键不重复）。超出 2^53−1 的整数在协议 schema 中是解码错误（profile 层本身允许，golden vector 测试 profile 层）。
- **严格解码**：先按 profile 解码（拒绝 tag、indefinite、重复 key、尾随 bytes），再按 schema 检查类型和长度，最后把解码结果**重新编码并与原始 bytes 逐字节比较**，不同即错误。这一步统一拒绝非最短编码、float 冒充整数、非规范 map 顺序等情况，两端都必须做。
- 字段语义（包括 `0` / `""` 这类哨兵值）与 M1–M3 的 protobuf 定义相同；M3.5 只换编码，不改任务语义，除非本文另有说明。
- 一帧编码后不超过 60 KiB（`MAX_FRAME_BYTES = 61440`），放进一条 Noise 传输消息。
- **`text` 的合法性由发送方保证**：编码器遇到非法 UTF-8 必须拒绝编码，不能发出去让接收方断连。来自外部的文本（`/etc/os-release`、组名、操作系统错误信息里的路径等）在进入协议结构前清洗（Go 用 `strings.ToValidUTF8(s, "�")`）；原样保存字节的内容走 `bytes` 字段。

任何帧或 body 解码失败都是协议错误：接收方关闭连接，不回错误响应。

## 握手载荷

握手载荷不是帧，直接作为 Noise IK 两条消息的载荷。两者的**第一个元素永远是 `protocol_major`**（以后的大版本也如此），接收方先读它，不匹配时不再解析其余部分。

```text
HandshakeInit     = [protocol_major: uint, protocol_minor: uint, commands: [text],
                     crha_version: text, client_time_ms: int, enroll: Enrollment?]
Enrollment        = [token_secret: text, hostname: text, facts: Facts]

HandshakeResponse = [protocol_major: uint, protocol_minor: uint, commands: [text],
                     connection_id: text, server_time_ms: int,
                     node_state: "active" | "pending", node_id: text]
```

- `commands` 是本方实现的**全部命令名和事件名**（两个方向都算）。双方之后只发送交集中的命令/事件。
- 大版本不匹配：crhs 以 WebSocket close 1008、reason `protocol_major mismatch: server 2, client N` 拒绝；crha 收到不同大版本的响应时关闭连接并报告。两者都按握手失败处理（`HandshakeError`）。Noise prologue 是 `"crh/<大版本>" ‖ 挑战`，所以大版本不同的对端在握手本身（读第一条 Noise 消息时）就失败。
- 小版本只做增量：`protocol_minor` 不同不拒绝握手。新命令/事件都是可选的，靠 `commands` 交集协商；只有缺了本方需要的名字才拒绝。不兼容的修改升大版本，不升小版本。
- crha、它的特权模式（daemon / native helper）和 crhs 必须一起升级；不提供跨大版本的兼容层。
- 交集缺少本文列为**必需**的名字时同样拒绝握手（reason `missing required command: <name>`）。M3.5 中下文表格列出的全部名字都是必需的；M4 新增的名字是可选的，交集里没有时 crhs 视该节点不支持 `forward`（见 [M4：提权](#m4提权)）。

## 帧

```text
request  = [0, id: uint, cmd: text, body]
response = [1, id: uint, cmd: text, true,  body]
         | [1, id: uint, cmd: text, false, Error]
event    = [2, name: text, body]

Error    = [code: text, message: text]
```

- `Error` 的 `message` 由发送方保证不超过 1024 字节 UTF-8（清洗为合法 UTF-8 后按字符边界截断）；接收方不检查长度。
- 命令名和事件名（`cmd`、`name`）不超过 64 字节；解码帧时超过即协议错误（不回 `unsupported_command`）。
- `id` 由请求方分配，从 1 开始递增；两个方向的 id 空间各自独立，响应的 `id` 属于请求方。
- 响应的 `cmd` 必须等于对应请求的 `cmd`。收到未知 `id` 或 `cmd` 不符的响应是协议错误。
- 响应可以乱序到达（按 `id` 匹配）。连接关闭时所有未完成请求以连接错误结束；请求本身没有超时（连接的空闲超时兜底）。
- 收到未协商的命令：响应 `unsupported_command`。收到未协商的事件：协议错误。
- 本方 schema 认识的命令，无论是否协商、是否注册了处理函数，都先按 schema 解码 body，失败即协议错误；只有本方完全不认识的命令名才不解码 body、直接响应 `unsupported_command`。成功响应的 body 同样总是按 schema 解码校验，与调用方是否关心结果无关。
- 处理函数已返回、但成功响应无法编码（body 不合 schema、帧超过 `MAX_FRAME_BYTES` 等）时，改发 `internal_error` 错误响应，绝不静默不回；此时“响应后执行”的钩子不运行。错误响应本身也无法发出时（连接已关闭），按连接错误处理。

通用错误码：`unsupported_command`、`node_pending`（受限连接上的非允许命令）、`internal_error`。

## 命令

| 名称 | 方向 | 请求 body | 成功响应 body | 错误码 |
|---|---|---|---|---|
| `hello` | C→S | `Hello` | `Welcome` | 无（受限连接上也允许） |
| `ping` | C→S | `[seq: uint]` | `[seq: uint]`（原样返回） | |
| `task.start` | S→C | `TaskStart` | `[]` | 见下 |
| `task.input` | S→C | `[task_id: text, offset: uint, data: bytes]` | `[]` | `unknown_task`、`input_out_of_order`、`input_too_large` |
| `task.cancel` | S→C | `[task_id: text]` | `[]` | 无（未知或已结束的任务也返回成功） |
| `task.query` | S→C | `[task_id: text]` | `TaskStatus` | 无（未知任务返回 `state = "unknown"`） |

M4（1.1）新增的命令和事件见 [M4：提权](#m4提权)。

```text
Hello      = [tasks: [TaskStatus], task_kinds: [text], privileged_mode: text]
Welcome    = [acks: [OutputAck]]
OutputAck  = [task_id: text, stdout_offset: uint, stderr_offset: uint]
TaskStatus = [task_id: text, state: "running" | "exited" | "unknown", stdout_end: uint, stderr_end: uint]
```

### `task.start`

```text
TaskStart  = [task_id: text, attempt: uint, spec: TaskSpec, privileged: bool,
              authorizations: [bytes], timeout_ms: uint, kill_grace_ms: uint, output: OutputMode]

OutputMode = ["full",   [spill_bytes: uint, spill_lines: uint]]   ; 单任务：实时推送，超过阈值落盘
           | ["text",   []]                                         ; 批量 text：实时推送，总是落盘
           | ["status", []]                                         ; 批量 status：不推送输出，总是落盘

TaskSpec   = ["exec",      ExecSpec]
           | ["file.read",  [path: text, start_line: uint, line_count: uint]]
           | ["file.write", [path: text, content: InputRef, overwrite: bool, mode: uint, owner: text, group: text]]
           | ["file.edit",  [path: text, edits: [[old_text: text, new_text: text]]]]
           | ["file.stat",  [path: text]]
           | ["file.list",  [path: text, limit: uint]]

ExecSpec   = [command: Command, env: {text: text}, cwd: text, stdin: InputRef?]
Command    = ["argv", [text]] | ["shell", text]
InputRef   = [size: uint, sha256: bytes]          ; sha256 恰好 32 字节
```

- `attempt` 从 1 开始；只有授权重试（`authorization_*`）才递增。
- 成功响应就是 accepted。crha 在发出成功响应前，必须已把 `task_id` 记入**已接受集合**；先发响应再启动执行，所以该任务的事件一定在响应之后。
- 已记入已接受集合、但成功响应没能发出（连接恰好断开）的任务，crha 仍然执行：接受已经决定，crhs 不会重发，它在重连后的 `hello` 中看到这个任务并照常接收输出和 `task.exit`。
- 已接受集合在 crha 进程内保留（不随 `task.exit.ack` 删除），上限为最近 16 384 个 id；命中时返回 `already_accepted`。crhs 永远不会重发已接受的任务，这是纵深防御。
- `authorizations` 的每一项是一个 `CBOR(Authorization)`（见 [授权对象](#授权对象)）；非特权任务、`native` / `ignore` 和本地批准时为空。M4 中最多一项，多于一项返回 `authorization_invalid`。
- 错误码：
  - 可重试（任务回到 `awaiting_authorization`）：

    | 码 | 情况 |
    |---|---|
    | `authorization_required` | 没有授权，也没有可用的本地批准 |
    | `authorization_invalid` | 授权解码失败、签名无效、找不到对应信任项、节点/组不匹配、任务 id 不在 `task_ids` 中、`attempt` 不符、多于一项 |
    | `authorization_expired` | 过期、签发于未来、没有 `deadline`、超出 `max_ttl` |
    | `authorization_rejected` | 已用、不晚于已用列表水位线、指令限制不覆盖本任务、违反 `require_exact` / `require_task` / `require_uv`、防护规则/env/路径拒绝、缺联署、信任项没有 `execute` |

    `message` 写明失败的校验步骤（privilege.md 的“校验流程”编号）。规则和路径拒绝也是可重试的：crhs 签名路径被拒，不代表所有者的签名也会被拒；crhs 重试时不会再走同一条 crhs 签名路径（D83），不会循环。
  - 终态（任务结束为 `failed`，`error_code` 即此码）：`invalid_spec`（空 id、哈希长度不对等、`size` 为 0 但 `sha256` 不是空输入的 SHA-256）、`unsupported_kind`、`privileged_unsupported`（`reject` 模式；`native` 的提权工具不可用或 helper 版本不符；M3.5 的 crha）、`privileged_unavailable`（`forward` 但特权模式不可达）、`local_policy_denied`、`already_accepted`（校验第 5 步：本任务 id 已在本机执行过）。
- `forward` 时非特权模式把 `task.start` 原样转给特权模式（见 [crh-priv](#crh-priv非特权模式--特权模式)），特权模式的响应就是这里的响应。转发请求有超时（30 秒）：超时的 `task.start` 当作已接受（请求可能已在特权模式排队，之后仍会执行），非特权模式尽力请特权模式取消它，并以 `helper_lost` 结束（结果未知，crhs 不重试）。非特权模式在转发 `authorization_*` 错误之前，先向特权模式重新查询 `TrustSummary`，digest 变化时先发 `trust.summary` 事件，再发错误响应；因此 crhs 处理错误时缓存已经是最新的。
- `task.input` 只在成功响应之后发送；crhs 可以流水线发送多个分块，不必逐个等待响应；crha 按顺序处理。
- `file.read` 按行读：`start_line` 从 1 开始，任务是"从这一行起最多 `line_count` 行，整页不超过 50KB（`FileReadMaxBytes`）"。节点从文件开头扫到起始行，只发整行，遇到第一条放不下的行就停下，**不读到文件末尾**。stdout 是页面字节本身（保留文件自己的换行）；页面之外的信息放在 `task.exit` 的 `result`（见 [TaskResult](#taskresult)），不进输出流：`from` / `to` 是页面首行和末行的行号，页面为空时都是 0；`eof` 表示扫描到了文件末尾；`total` 只在 `eof` 时出现，是文件总行数；`too_long` 表示请求的首行本身就超过 50KB，此时页面为空。

## 事件

| 名称 | 方向 | body |
|---|---|---|
| `task.output` | C→S | `[task_id: text, stream: "stdout" \| "stderr", offset: uint, data: bytes]` |
| `task.exit` | C→S | `TaskExit` |
| `facts` | C→S | `Facts` |
| `node.status` | S→C | `[node_id: text, state: "pending" \| "active" \| "rejected" \| "disabled", message: text]` |
| `task.output.ack` | S→C | `OutputAck` |
| `task.exit.ack` | S→C | `[task_id: text]` |

```text
TaskExit = [task_id: text, outcome: Outcome, timed_out: bool, cancelled: bool,
            stdout_end: uint, stderr_end: uint, output_file: text, result: TaskResult?]
Outcome  = ["code", int] | ["signal", text] | ["error", Error]      ; signal 不带 SIG 前缀

TaskResult = ["file.read",  FileReadResult]
           | ["file.write", FileWriteResult]
           | ["file.edit",  FileEditResult]
           | ["file.stat",  FileStatResult]
           | ["file.list",  FileListResult]

FileReadResult  = [from: uint, to: uint, eof: bool, total: uint?, too_long: bool]
FileWriteResult = [bytes: uint, created: bool]
FileEditResult  = [replacements: uint]
FileStatResult  = [path: text, type: "file" | "dir" | "symlink" | "other", size: int, mode: text,
                   uid: int, gid: int, owner: text, group: text, mtime: text, link_target: text?]
FileListResult  = [entries: [FileListEntry], truncated: bool]
FileListEntry   = [name: text, type: "file" | "dir" | "symlink" | "other", size: int, mode: text, mtime: text]

Facts    = {text: any}                    ; CBOR map，文本键，见下表
```



`Facts` 是本协议中唯一不用定长元组的结构：它描述节点，会随版本增减条目，不参与授权、签名和哈希。规则：

| 键 | 类型 | 必需 |
|---|---|---|
| `hostname` | `text` | 是 |
| `groups` | `[text]` | 是（决定节点所属的组，进而影响规则匹配） |
| `os_id`、`os_version_id`、`os_pretty_name`、`kernel`、`arch`、`init_system`、`notes_path` | `text` | 否 |
| `package_managers`、`privilege_tools` | `[text]` | 否 |
| `clock_offset_ms` | `int` | 否 |
| `shells` | `{text: any}`：`sh: text`（必需）、`bash: text?`（缺失或 `null` 表示没有 bash） | 否；节点发现的 sh 和 bash 的绝对路径，见 [execution-plane.md](execution-plane.md#exec-的执行环境) |

- 缺失的可选键表示"未知"，不是空值；未知的文本键忽略（`shells` 内部同样）。非文本的键（例如整数键）、已知键的类型不对、缺少必需键时，整个 `Facts` 解码失败，不部分采用。
- 严格解码照常：profile 层拒绝重复键、非规范 map 顺序、非最短编码等；逐字节比较针对通用 CBOR 值的重新编码（保留未知键），而不是针对按 schema 解出的结构。
- 以后增加事实只加新的可选键，不升 `protocol_minor`；删除键或改变已有键的类型需要新的大版本。
- 线上键名用 snake_case；JSON 形式（`factsToJson` / `factsFromJson`）是 camelCase 对象，缺失的键省略。crhs 数据库中已有的 `nodes.facts`（旧的完整对象，没有 `shells`）照常可读。SSH 节点的 facts 只有 `shells`（来自连接探测，见 [execution-plane.md](execution-plane.md#执行)），不经过线上编码。

- 输入类错误码（`Outcome` 的 `error` 分支）：`input_mismatch`（输入与 `InputRef` 不符：比声明的大小长，或 SHA-256 不同；任务若在运行则被杀掉）、`input_incomplete`（连接在输入收齐前断开；任务被杀掉）。

### TaskResult

任务的结构化结果只在 `task.exit` 的 `result` 里：类型由任务种类决定，不送到输出流，`null` 表示没有结果。只有产生结构化数据的种类有分支；`exec` 没有。`size`、`uid`、`gid` 是 `int`（非 Unix 节点上 `uid` / `gid` 为 -1），`mode` 是四位八进制权限文本，`mtime` 是 RFC 3339 时间；`link_target` 只在 `path` 是符号链接时出现。结果只在任务成功结束时出现，失败的任务没有结果。

结果必须能放进一帧：`file.list` 的条目字段合计到 `FileListMaxBytes`（32 KiB）就停止列出，并把 `truncated` 置为 true，所以`task.exit` 不会因为目录很大而超出 `MAX_FRAME_BYTES`。

```text
TaskResult = ["file.read", [from: 1, to: 3, eof: true, total: 3, too_long: false]]
TaskResult = ["file.stat", [path: "/etc/hosts", type: "file", size: 220, mode: "0644",
                            uid: 0, gid: 0, owner: "root", group: "root",
                            mtime: "2026-01-01T00:00:00Z", link_target: null]]
TaskResult = ["file.list", [[[name: "a.txt", type: "file", size: 3, mode: "0644",
                              mtime: "2026-01-01T00:00:00Z"]], truncated: false]]
TaskResult = ["file.write", [bytes: 3, created: true]]
TaskResult = ["file.edit", [replacements: 1]]
```

## M4：提权

语义见 [privilege.md](privilege.md)。本节规定线上格式；Go 和 TS 同样按本文手写，用 `test/interop/` 的 fixture 交叉验证。

### 新增命令和事件（1.1，可选）

| 名称 | 方向 | 形式 | body | 成功响应 body |
|---|---|---|---|---|
| `trust.summary` | C→S | 事件 | `TrustReport` | |
| `local.request` | S→C | 命令 | `LocalRequest` | `LocalState` |
| `local.withdraw` | S→C | 命令 | `[task_id: text, attempt: uint]` | `[]` |
| `local.decision` | C→S | 事件 | `[task_id: text, attempt: uint, state: LocalState]` | |

```text
TrustReport  = ["ok", TrustSummary] | ["unavailable", [message: text]] | ["not_forward", []]
LocalRequest = [task_id: text, attempt: uint, spec: TaskSpec, note: text]
LocalState   = ["pending", []] | ["approved", []] | ["denied", [message: text]]
```

- **`trust.summary`**：crha 在 `hello` 的响应之后发送一次，之后每当报告变化（digest 变化、特权模式连上或断开）时再发送。crhs 不主动查询。`privileged_mode` 不是 `forward` 时报告 `not_forward`。
- **本地批准**只用于单任务（任务组中的任务不发送 `local.request`），且不占用 `task.start`：
  1. crhs 发送 `local.request`，特权模式把 `(task_id, attempt, spec)` 加入待批准列表，响应当前状态（同一 `(task_id, attempt)` 重复请求是幂等的，返回已有状态）；
  2. 有人执行 `crha approve` / `crha deny` 后，crha 发送 `local.decision`；
  3. 状态为 `approved` 后，crhs 用同一 `attempt` 发送 `task.start`，`authorizations` 为空；特权模式核对 `spec` 的 `spec_sha256` 与批准时相同，消耗这条批准记录。
  - 用户改在 WebUI 中签名，或任务被取消时，crhs 发送 `local.withdraw`。
  - 待批准和已批准的记录只保存在特权模式的内存中，特权模式重启后丢失。crhs 每次收到 `trust.summary`（`ok`）时，对该节点仍在等待本地批准的任务重新发送 `local.request`；记录丢失时 `task.start` 返回 `authorization_required`，按普通重试处理。
  - 这样任何时刻断线都是安全的：没有 `task.start` 就不会执行，等待期间断线不会让任务变成 `unknown`。
  - 错误码：`privileged_unavailable`、`local_not_trusted`（本机没有 `local` 信任项；终态）、`invalid_spec`。

### TrustSummary

```text
TrustSummary = [node_id: text, groups: [text], clock_skew_ms: uint,
                identities: [unprivileged: Identity, privileged: Identity],
                trust: [TrustEntry]]
Identity     = [uid: uint, gid: uint, user: text]
TrustEntry   = [name: text, source: "local", role: "crhs" | "user" | "local", key: TrustKey,
                kinds: [text], require_exact: bool, require_task: bool, require_uv: bool, max_ttl_ms: uint?,
                allow: [GuardRule], deny: [GuardRule], env_allow: [text]]
TrustKey     = ["sshsig",   [public_key: text, fingerprint: text]]   ; authorized_keys 形式；SHA256:… 指纹
             | ["webauthn", [credential_id: bytes, cose_key: bytes, rp_id: text, origins: [text]]]
             | ["local",    [uids: [uint]]]
GuardRule    = [method: "exec" | "file.read" | "file.write", match: "any" | "prefix" | "regex", pattern: text]
```

- `digest = SHA-256(CBOR(TrustSummary))`，crhs 用它判断缓存是否变化，并记入任务的授权记录。
- `kinds` 的取值为 `execute`、`cosign`、`require-cosign`（见 privilege.md）；`cose_key` 是凭据的 COSE 公钥原文；`source` 为扩展预留，v1 恒为 `local`。
- `match = "any"` 时 `pattern` 为空串。
- 两种模式的运行身份放在这里，不改 `Hello` / `Facts`。

### 授权对象

```text
Authorization        = [payload: bytes, signatures: [Signature]]       ; payload 是 CBOR(AuthorizationPayload) 的原文
AuthorizationPayload = [v: 1, nodes: [text], command: AuthCommand?,
                        issued_at_ms: int, deadline_ms: int?,
                        task_ids: [text]?, attempt: uint?, note: text]
AuthCommand          = [method: "exec" | "file.read" | "file.write", match: AuthMatch]
AuthMatch            = ["exact", [target: text, spec_sha256: bytes]]    ; spec_sha256 恰好 32 字节
                     | ["prefix", [target: text]]
Signature            = ["sshsig", [blob: bytes]]
                     | ["webauthn", [credential_id: bytes, authenticator_data: bytes,
                                     client_data_json: bytes, signature: bytes]]
```

- **授权 id** = `SHA-256(payload)`，对原文 bytes 求哈希。校验方解码 payload 后重编码，与原文逐字节比较。
- `nodes`：节点 id、`group:<name>`，或恰好 `["*"]`。不能为空。
- `command` 为 `null` 表示任意方法、任意目标。
- `task_ids` 与 `attempt` 同时为 `null`（可复用授权），或同时非 `null`（一次性授权，`task_ids` 非空、无重复，`attempt ≥ 1`）。一次性授权的 `nodes` 只能是节点 id（不能是 `group:` 或 `*`），与 `task_ids` 等长并按位置一一对应：`task_ids[i]` 只能在 `nodes[i]` 上执行。`task.start` 的 `task_id` 必须在列表中、对应位置的节点 id 等于本机 node_id，`attempt` 必须相等；不满足时为 `authorization_invalid`（第 5 步）。
- `note` 没有时为空串。
- `deadline_ms` 必须非 `null`：字段在编码上仍可空，但校验时以 `authorization_expired` 拒绝（第 4 步）。
- **`spec_sha256`** = `SHA-256(CBOR(TaskSpec))`，`TaskSpec` 即 `task.start` 中的结构（stdin 和文件内容已经是 `InputRef`）。
- **SSHSIG**：`blob` 是 OpenSSH SSHSIG 的二进制形式（去掉 `-----BEGIN SSH SIGNATURE-----` 装甲后 base64 解码的 bytes）。version 必须为 1，namespace 必须为 `crh-auth-v1`，reserved 必须为空，hash 为 `sha512`（`ssh-keygen` 默认值；`sha256` 也接受）。**被签名的 message 是 payload 原文 bytes**，由 SSHSIG 自己做哈希，不预先哈希。
- **WebAuthn**：challenge = `SHA-256("crh-auth-v1\0" ‖ payload)`（32 字节）；浏览器中的 `challenge` 是它的 base64url，`client_data_json` 里的 `challenge` 解码后必须逐字节相等。支持的 COSE 算法：ES256（`-7`）、EdDSA / Ed25519（`-8`）、RS256（`-257`）。
- 一个 `Authorization` 编码后不超过 `MAX_FRAME_BYTES` 的一半，为 `TaskStart` 其余部分留出空间；512 个任务 id 约 14 KiB。

### crh-priv：非特权模式 ↔ 特权模式

非特权模式与特权模式之间（`forward`：unix socket；`native`：helper 的 stdin/stdout）使用同一套帧、命令/事件抽象和严格解码规则，但**不是同一个协议**：

- 没有 Noise。主机内的威胁不在范围内（privilege.md 的“威胁模型”），对端身份由 `SO_PEERCRED`（socket）或进程关系（stdio）确定。
- 流式传输，每帧前加 4 字节大端长度；长度为 0 或超过 `MAX_FRAME_BYTES` 是协议错误。
- 握手是第一对帧，不经过 Noise：

```text
PrivHello   = [priv_major: 2, priv_minor: 0, commands: [text], crha_version: text,
               role: "forward" | "native" | "local"]
PrivWelcome = [priv_major: 2, priv_minor: 0, commands: [text], crha_version: text]
```

- 必需的名字：`native` 是 `task.*` 这一组；`forward` 是 `task.*`、`trust.query`、`trust.summary`，其余（`local.*`）可选，缺少时非特权模式不提供对应功能；`local` 是该角色的全部名字。之后新增的名字都是可选的，靠名字协商。
- `priv_major` 必须相等：任一方发现对端的 `priv_major` 不同就关闭连接。大版本 2 是本批的版本（`task.exit` 增加 `result`、`file.read` 改为按行）；`crha` 及其特权模式总是一起升级，所以旧的特权模式进程不会被新的非特权模式使用。`priv_minor` 只做增量（新增可选名字），不参与拒绝。
- `forward` 下非特权模式还要求 `PrivWelcome.crha_version` 与自己完全相同。不同时按特权模式不可达处理：特权任务以 `privileged_unavailable` 失败，非特权模式记一条日志，写明双方的版本。这覆盖了只换 `crha` 二进制、没有重启特权模式的升级。
- `role` 必须与对端身份一致：`forward` 要求 peer uid 等于 `unprivileged_uid`；`local` 要求 peer uid 在某个 `local` 信任项的 `uids` 中；`native` 只在 stdio 上出现，此时要求 `crha_version` 完全相等。不一致时特权侧关闭连接。

| 名称 | 方向 | role | 说明 |
|---|---|---|---|
| `task.start` / `task.input` / `task.cancel` / `task.query` | U→P | forward、native | 与 crhs ↔ crha 同结构；`native` 跳过授权校验 |
| `task.output` / `task.exit` | P→U | forward、native | 同结构；没有 ack，非特权模式写入自己的输出文件，沿用原有的落盘和续传 |
| `trust.query` | U→P | forward | 请求 `[]`，响应 `TrustSummary` |
| `trust.summary` | P→U | forward | 事件 `TrustReport`（特权模式发出的恒为 `ok`），reload 后 digest 变化时推送；非特权模式原样转给 crhs |
| `local.request` / `local.withdraw` | U→P | forward | 同上文 |
| `local.decision` | P→U | forward | 同上文 |
| `pending.list` | L→P | local | 请求 `[]`，响应 `[[task_id: text, attempt: uint, spec: TaskSpec, note: text, received_at_ms: int]]` |
| `local.approve` / `local.deny` | L→P | local | 请求 `[task_id: text, attempt: uint, spec_sha256: bytes, message: text]`（`spec_sha256` 恰好 32 字节，必须等于待批准记录的规格哈希，否则 `invalid_spec`），响应 `[]` |

- **断开**：`forward` 的连接断开时，特权模式中已 accepted 的任务继续运行到结束，结果写入本地日志；它们的输出不再回传。非特权模式以 `error`、`code = helper_lost`（“任务可能仍在运行”）结束这些任务；`task.start` 已发出但响应因断开丢失时同样按 accepted 处理并以 `helper_lost` 结束，避免 crhs 重试一个可能已执行的任务。非特权模式自身重启时不认识这些任务，crhs 照常按 `unknown` 处理。`native` 的 stdin 关闭时，helper 等当前任务结束后退出。
- **native helper** 每个进程只执行一个任务：握手、一个 `task.start`、输入、输出、`task.exit`，然后退出。stdin 是 tty 时拒绝启动。helper 在 accepted 之后、`task.exit` 之前意外退出或断开时，非特权模式以 `error`、`code = helper_lost` 结束任务（任务可能已部分执行，不重试）。

## 受限连接

`node_state = "pending"` 时，crha 只发送 `ping`、`facts`，可选 `hello`（`tasks` 为空）；crhs 对其他命令响应 `node_pending`，只推送 `node.status`。批准、拒绝、禁用的处理见 execution-plane.md 的“注册”。crha 收到 `node.status{rejected}` 后以非零状态退出 `crha run`，并打印原因；收到 `{active}` 或 `{disabled}` 后等连接关闭，按普通重连处理（disabled 会在握手时被拒）。

## JSON 形式（服务端存储）

数据库和 Web API 继续用 JSON。`TaskSpec` 与 `Facts` 的 JSON 形式由 `packages/protocol` 提供（`taskSpecToJson` / `taskSpecFromJson`、`factsToJson` / `factsFromJson`），不再使用 protobuf JSON：

```jsonc
// TaskSpec：kind 即线上 tag，其余字段 camelCase，全部出现
{ "kind": "exec", "command": { "argv": ["ls", "-l"] }, "env": {}, "cwd": "", "stdin": null }
{ "kind": "exec", "command": { "shell": "ls | wc -l" }, "env": {}, "cwd": "", "stdin": { "size": 3, "sha256": "<64 位 hex>" } }
{ "kind": "file.read", "path": "/etc/hosts", "startLine": 1, "lineCount": 100 }
{ "kind": "file.write", "path": "/tmp/x", "content": { "size": 3, "sha256": "<hex>" }, "overwrite": false, "mode": 0, "owner": "", "group": "" }
{ "kind": "file.edit", "path": "/tmp/x", "edits": [{ "oldText": "a", "newText": "b" }] }
{ "kind": "file.stat", "path": "/tmp/x" }
{ "kind": "file.list", "path": "/tmp", "limit": 0 }

// Facts：键名与原 protobuf JSON 相同（camelCase），缺失的可选键省略（下面列出全部键），数字为 number
{ "hostname": "...", "osId": "...", "osVersionId": "...", "osPrettyName": "...", "kernel": "...", "arch": "...",
  "initSystem": "...", "packageManagers": [], "privilegeTools": [], "notesPath": "...", "groups": [], "clockOffsetMs": 0 }

// TaskResult：同样的 camelCase，可空字段为 null 而不是省略；kind 即线上 tag
{ "kind": "file.read", "from": 1, "to": 3, "eof": true, "total": 3, "tooLong": false }
{ "kind": "file.stat", "path": "/etc/hosts", "type": "file", "size": 220, "mode": "0644", "uid": 0, "gid": 0,
  "owner": "root", "group": "root", "mtime": "2026-01-01T00:00:00Z", "linkTarget": null }
{ "kind": "file.list", "entries": [{ "name": "a.txt", "type": "file", "size": 3, "mode": "0644",
  "mtime": "2026-01-01T00:00:00Z" }], "truncated": false }
{ "kind": "file.write", "bytes": 3, "created": true }
{ "kind": "file.edit", "replacements": 1 }
```

`TaskResult` 的 JSON 形式由 `packages/protocol` 提供（`taskResultToJson` / `taskResultFromJson`），crhs 把它原样存在 `tasks.result` 中，Web API 作为任务的 `result` 返回。

已有数据库行中的 protobuf JSON（`tasks.spec`、`task_groups.spec`、`nodes.facts`）由一个迁移转换成上述形式；迁移自带转换代码，不引用 `packages/protocol`。protobuf JSON 中 `exec` 的 `argv` 非空时转为 `{argv}`，否则转为 `{shell}`；省略的默认值补齐；int64 字符串转 number；bytes 的 base64 转 hex；缺失的 `stdin` 为 `null`，缺失的 `file.write` `content` 为空输入（size 0、空串的 SHA-256）。`task_groups.kind` 中的 protobuf 分支名（`fileRead` 等）同时改为线上 tag（`file.read` 等），与 `tasks.kind` 一致。无法解析的行保持原样并在迁移日志中报告，不中断迁移。

## fixture

- `test/interop/cbor_core_golden_vectors.json`：profile 层正例/拒绝例，两端的 profile codec 都要通过。
- `test/interop/m4_vectors.json`（M4）：`spec_sha256`、授权 payload（正例和结构负例）、授权对象、M4 的 body（含 `TrustSummary` digest）、crh-priv 的握手和带长度前缀的帧、SSHSIG（`ssh-keygen` 签发的和按本文手工构造的，含 `sk-*`；每项注明 crha 是否接受、`ssh-keygen -Y verify` 的结果）、WebAuthn assertion（ES256 / EdDSA / RS256 正例和反例）。每次生成都用新密钥，所以测试按性质校验（重编码、哈希、参考验证器、`ssh-keygen -Y verify`），不比较字节。注意：OpenSSH 10.6 的 `ssh-keygen -Y verify` 接受不带 UP 标志的 `sk-*` 签名，crha 拒绝。
- `test/interop/m4_authz_cases.json`（M4）：授权判定的共享用例（privilege.md 的校验流程，签名抽象为"哪个信任项签了、是否有效、UV"），每例给出结果码和失败步骤；另有 `targets`（任务规格 → method / target 的渲染），server 的 `operationOf` 已用它校验。crha 的校验和 crhs 的方案计算都要跑这份用例。
- `test/interop/crh_frames.json`：由 TS 实现生成、提交进仓库的帧 fixture，每项 `{ "id", "description", "hex" }`，覆盖每一种命令、响应（成功/错误）、事件、握手载荷和每一个联合分支；另有 `"negative"` 列表（长度不符、未知 tag、未知枚举、超长命令名、非规范编码、float 冒充整数、超过 2^53−1 的整数、`sha256` 长度错、尾随 bytes 等）。Go 测试解码每个正例，与按本文**独立手写**的期望值比较，再重编码比对 hex；负例必须全部被拒绝。
