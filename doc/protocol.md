# crhs ↔ crha 协议 schema（M3.5）

[execution-plane.md](execution-plane.md#自有协议m35) 规定协议的语义；本文规定**线上格式**，TS（`packages/protocol`）和 Go（`client/internal/protocol`）都按本文手写，用 `test/interop/` 的 fixture 交叉验证。两者不一致时以本文为准；本文有歧义时先改本文。

协议版本：`protocol_major = 1`，`protocol_minor = 0`。Noise prologue 仍为 `"crh/1" ‖ 挑战`。

## 编码规则

所有字节按 `CBOR-CORE-INT-v1` 编码（见 execution-plane.md 的 CBOR profile）。在此之上：

- **结构一律是定长数组（元组）**，按本文列出的顺序；解码时长度必须完全相等。没有可选字段，只有可空字段（标 `?`，值为 CBOR `null`）。
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
- 大版本不匹配：crhs 以 WebSocket close 1008、reason `protocol_major mismatch: server 1, client N` 拒绝；crha 收到不同大版本的响应时关闭连接并报告。两者都按握手失败处理（`HandshakeError`）。
- 交集缺少本文列为**必需**的名字时同样拒绝握手（reason `missing required command: <name>`）。1.0 中下文表格列出的全部名字都是必需的。

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

M4 保留的名字（1.0 不声明、不实现，结构在 M4 定义）：`trust.query`、`revocations.set`（命令），`trust.summary`（事件）。

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
           | ["file.read",  [path: text, offset: uint, limit: uint]]
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
- 已接受集合在 crha 进程内保留（不随 `task.exit.ack` 删除），上限为最近 100 000 个 id；命中时返回 `already_accepted`。crhs 永远不会重发已接受的任务，这是纵深防御。
- 错误码：
  - 可重试（任务回到 `awaiting_authorization`）：`authorization_required`、`authorization_invalid`、`authorization_expired`、`authorization_rejected`。1.0 的 crha 不产生它们（M4 实现）。M3.5 的 crhs 还没有 `awaiting_authorization` 状态和授权来源，收到时按最终失败处理：任务结束为 `rejected`，`error_code` 即此码；M4 再改为重试。
  - 终态（任务结束为 `failed`，`error_code` 即此码）：`invalid_spec`（空 id、哈希长度不对等、`size` 为 0 但 `sha256` 不是空输入的 SHA-256）、`unsupported_kind`、`privileged_unsupported`（1.0 的 crha 收到 `privileged = true` 时）、`local_policy_denied`、`already_accepted`。
- `task.input` 只在成功响应之后发送；crhs 可以流水线发送多个分块，不必逐个等待响应；crha 按顺序处理。

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
            stdout_end: uint, stderr_end: uint, output_file: text]
Outcome  = ["code", int] | ["signal", text] | ["error", Error]      ; signal 不带 SIG 前缀

Facts    = [hostname: text, os_id: text, os_version_id: text, os_pretty_name: text, kernel: text,
            arch: text, init_system: text, package_managers: [text], privilege_tools: [text],
            notes_path: text, groups: [text], clock_offset_ms: int]
```

- 输入类错误码（`Outcome` 的 `error` 分支）：`input_mismatch`（输入与 `InputRef` 不符：比声明的大小长，或 SHA-256 不同；任务若在运行则被杀掉）、`input_incomplete`（连接在输入收齐前断开；任务被杀掉）。

## 受限连接

`node_state = "pending"` 时，crha 只发送 `ping`、`facts`，可选 `hello`（`tasks` 为空）；crhs 对其他命令响应 `node_pending`，只推送 `node.status`。批准、拒绝、禁用的处理见 execution-plane.md 的“注册”。crha 收到 `node.status{rejected}` 后以非零状态退出 `crha run`，并打印原因；收到 `{active}` 或 `{disabled}` 后等连接关闭，按普通重连处理（disabled 会在握手时被拒）。

## JSON 形式（服务端存储）

数据库和 Web API 继续用 JSON。`TaskSpec` 与 `Facts` 的 JSON 形式由 `packages/protocol` 提供（`taskSpecToJson` / `taskSpecFromJson`、`factsToJson` / `factsFromJson`），不再使用 protobuf JSON：

```jsonc
// TaskSpec：kind 即线上 tag，其余字段 camelCase，全部出现
{ "kind": "exec", "command": { "argv": ["ls", "-l"] }, "env": {}, "cwd": "", "stdin": null }
{ "kind": "exec", "command": { "shell": "ls | wc -l" }, "env": {}, "cwd": "", "stdin": { "size": 3, "sha256": "<64 位 hex>" } }
{ "kind": "file.read", "path": "/etc/hosts", "offset": 0, "limit": 0 }
{ "kind": "file.write", "path": "/tmp/x", "content": { "size": 3, "sha256": "<hex>" }, "overwrite": false, "mode": 0, "owner": "", "group": "" }
{ "kind": "file.edit", "path": "/tmp/x", "edits": [{ "oldText": "a", "newText": "b" }] }
{ "kind": "file.stat", "path": "/tmp/x" }
{ "kind": "file.list", "path": "/tmp", "limit": 0 }

// Facts：键名与原 protobuf JSON 相同（camelCase），全部出现，数字为 number
{ "hostname": "...", "osId": "...", "osVersionId": "...", "osPrettyName": "...", "kernel": "...", "arch": "...",
  "initSystem": "...", "packageManagers": [], "privilegeTools": [], "notesPath": "...", "groups": [], "clockOffsetMs": 0 }
```

已有数据库行中的 protobuf JSON（`tasks.spec`、`task_groups.spec`、`nodes.facts`）由一个迁移转换成上述形式；迁移自带转换代码，不引用 `packages/protocol`。protobuf JSON 中 `exec` 的 `argv` 非空时转为 `{argv}`，否则转为 `{shell}`；省略的默认值补齐；int64 字符串转 number；bytes 的 base64 转 hex；缺失的 `stdin` 为 `null`，缺失的 `file.write` `content` 为空输入（size 0、空串的 SHA-256）。`task_groups.kind` 中的 protobuf 分支名（`fileRead` 等）同时改为线上 tag（`file.read` 等），与 `tasks.kind` 一致。无法解析的行保持原样并在迁移日志中报告，不中断迁移。

## fixture

- `test/interop/cbor_core_golden_vectors.json`：profile 层正例/拒绝例，两端的 profile codec 都要通过。
- `test/interop/crh_frames.json`：由 TS 实现生成、提交进仓库的帧 fixture，每项 `{ "id", "description", "hex" }`，覆盖每一种命令、响应（成功/错误）、事件、握手载荷和每一个联合分支；另有 `"negative"` 列表（长度不符、未知 tag、未知枚举、超长命令名、非规范编码、float 冒充整数、超过 2^53−1 的整数、`sha256` 长度错、尾随 bytes 等）。Go 测试解码每个正例，与按本文**独立手写**的期望值比较，再重编码比对 hex；负例必须全部被拒绝。
