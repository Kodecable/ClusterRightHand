# 提权与授权

## 术语

| 术语 | 含义 |
|---|---|
| crha 非特权模式 | 对外联网、与 crhs 通信的 crha 实例。普通任务直接以它自身的 Linux 身份执行 |
| crha 特权模式 | 不联网、只通过本机 unix socket 为非特权模式提供服务的 crha 实例。只执行带有效授权的任务，以它自身的 Linux 身份执行 |
| 特权任务 | 任务规格中 `privileged = true` 的任务，需要走授权链路 |

**模式与 Linux 用户身份解耦。** "特权"的含义是"需要授权才能执行"，与是否为 root 无关：

- 常见部署：非特权模式以普通用户运行，特权模式以 root 运行；
- 非特权模式也可以以 root 运行（例如配合 `ignore` 方式，见下文）；
- 特权模式也可以以其他用户运行，例如以 `deploy` 运行，把"以 deploy 身份执行"变成需要授权的操作。

两种模式是同一个二进制，由 systemd 分别启动。对 crhs 来说，它们是同一个节点。

## 威胁模型与范围

| 关注 | 说明 |
|---|---|
| crhs 被攻破 | 在只信任用户的节点上，crhs 无法单独执行特权任务 |
| 网络攻击 | 由 crhs ↔ crha 的 Noise 通道防护，见 [execution-plane.md](execution-plane.md#通信安全) |
| 提示注入、agent 越权、被盗的 API token | 由 crhs 策略和特权模式的信任配置共同约束 |

**暂不考虑主机内的威胁**，即本机其他用户或进程攻击特权模式，以及非特权模式被攻破后的伪造。因此：

- 特权模式没有身份密钥；两种模式之间的 unix socket 不加密；
- 特权模式的 TrustSummary 查询结果不签名。

非特权模式即使伪造请求，没有有效授权也无法让特权模式执行任何命令。

## 非特权模式如何处理特权任务

在非特权模式的配置中设置，由节点通过 `Facts` 上报（同时上报两种模式各自的运行身份），在 crhs 展示：

```toml
# /etc/crha/crha.toml（非特权模式）
[privileged]
mode   = "forward"                        # forward | native | ignore | reject
socket = "/run/crha/privileged.sock"      # mode = "forward" 时使用
native = "sudo"                           # mode = "native" 时使用：sudo | doas | run0
```

| mode | 行为 | 谁能让特权任务执行 |
|---|---|---|
| `forward` | 转给特权模式 | 由特权模式的信任配置决定 |
| `native` | 用 `sudo -n` / `doas -n` / `run0`（非交互）执行 | crhs（受 crhs 策略和 sudoers 等约束） |
| `ignore` | 忽略特权标记，直接以非特权模式自身的身份执行 | crhs（只受 crhs 策略约束） |
| `reject` | 拒绝所有特权任务 | 没有人 |

- `native` 的非交互执行要求 NOPASSWD 或 polkit 规则放行，**等于 crhs 已经拥有目标身份**。它的价值在于接入系统原生的日志和 sudoers 的精细限制，它**不是安全边界**。
- `ignore` 常见于非特权模式本身以 root 运行的部署，此时等于 crhs 直接拥有 root。
- 真正的安全边界是 `forward`。

## 特权模式

```
crha 非特权模式（对外联网）
   │  unix socket：/run/crha/privileged.sock（属组 crha，权限 0660）
   │  特权模式通过 SO_PEERCRED 区分对端：unprivileged_uid 提交任务，local 信任项中的 uid 做本地批准
   ▼
crha 特权模式（不联网）
   ├── 配置：/etc/crha/privileged.toml（属主为特权模式的运行用户，其他用户不可写）
   ├── 吊销列表：/var/lib/crha/privileged/revoked
   └── 本地日志：/var/log/crha/privileged.jsonl + journald
```

非特权模式把特权任务连同授权原样转给特权模式；特权模式校验后执行，并把输出经 socket 回传给非特权模式。

**修改信任配置本身就是特权任务**（对 `/etc/crha/privileged.toml` 的 `file.write`，然后 reload），需要现有信任项授权。crhs 无法绕过授权修改它。建议 crhs 信任项默认 deny `file.write /etc/crha/`，让信任配置只能由用户授权修改，或者在节点上本地修改。

## 方法与目标

每个任务有一个**方法**（method）和一个规范化的**目标**（target）。授权的指令限制和信任项的防护规则，都是"方法 + 对目标的匹配"。

| method | 覆盖的任务 | target |
|---|---|---|
| `exec` | `exec` | 渲染后的 argv：每个参数如果含有 `[A-Za-z0-9_@%+=:,./-]` 以外的字符，就用 POSIX 单引号包起来（内部的 `'` 写成 `'\''`），再用一个空格连接。shell 模式的任务按 argv `["/bin/sh", "-c", 脚本]` 渲染 |
| `file.read` | `file.read`、`file.stat`、`file.list` | 绝对路径 |
| `file.write` | `file.write`、`file.edit`，**并包含 `file.read` 的全部能力** | 绝对路径 |

- argv 的渲染方式是唯一的，后面的参数无法伪装成前面参数的一部分。shell 模式的目标以 `/bin/sh -c` 开头，所以 `prefix = "systemctl restart "` 这类规则**不会匹配 shell 模式**，也就无法用 `;`、`&&`、`$()` 绕过。要放行 shell 脚本，必须显式写针对 `/bin/sh -c` 的规则。
- 特权文件操作的路径必须是绝对路径、已规范化（不含 `.`、`..`、重复的 `/`），且**任何一级都不能是符号链接**。用 `openat2(RESOLVE_NO_SYMLINKS)` 打开，不满足就拒绝。否则 `/etc/nginx/x` 可能是指向 `/etc/shadow` 的链接，绕过基于路径的规则。

## 授权

所有授权都使用同一种结构：**本体 + 可选的指令限制 + 可选的截止时间**。

授权本体是 CBOR payload，签名和联署是同一对象上的 `signatures` 数组：

```json
{
  "payload": {
    "v": 1,
    "nodes": ["01JB…", "group:web"],        // 节点 id 和组；或 "*"：签名者被信任的所有节点
    "command": {                            // 可选；省略 = 任意方法、任意目标
      "method": "exec",
      "exact": "systemctl restart nginx",   // 或 "prefix": "…"
      "spec_sha256": "…"                    // exact 时必填，见下文
    },
    "issued_at": "2026-10-26T12:00:00Z",
    "deadline":  "2026-10-26T12:05:00Z",    // 可选；省略 = 不过期（受信任项的 max_ttl 约束）
    "task_id":   "01JB…",                   // 可选；设置后只能用于这一个任务，且只能使用一次
    "attempt":   0,                           // 同一 task_id 的授权尝试；重试时递增
    "note": "重启 nginx 以加载新证书"         // 可选，人类可读，也在签名范围内
  },
  "signatures": [
    { "format": "sshsig", "signature": "…" },
    { "format": "webauthn", "credential_id": "…", "assertion": { "…": "…" } }
  ]
}
```

- **授权 id** = `SHA-256(CBOR(payload))`，用于吊销、审计和引用。
- 用户签名和 crhs 联署签的是**同一份 CBOR payload**，不再使用 `cosign_of`，也不存在两个 payload 字段不一致的问题。
- `require-cosign` 只要求同一对象上同时存在合格的 user 签名和 `role=crhs` 的 cosign 签名。
- **发给组的授权**：特权模式在本机配置了这个组（`privileged.toml` 中的 `groups`）时，就认为这个授权是发给自己的。组成员关系只以本机配置为准（crhs 侧只是缓存），crhs 无法绕过授权改变它。对组签一次授权覆盖组内节点属于 M4 后段；第一阶段只做单任务特权，群组特权任务推迟。
- **`exact`**：方法和目标完全相等，并且 `spec_sha256` 必须等于完整任务规格的规范化哈希。完整规格包括 env、cwd、stdin 哈希，文件写入还包括内容哈希、mode、owner 和 `overwrite`，文件编辑还包括全部 `edits`。也就是说，批准"写 `/etc/nginx/nginx.conf`"时，批准的是写入这一份内容；批准一次编辑时，批准的是这几处替换，而不是任意内容。
- **`prefix`**：方法匹配（`file.write` 包含 `file.read`），目标前缀相等。只约束目标，不约束 stdin 和写入内容。cwd 固定为 `/`，env 受信任项的 `env_allow` 约束。
- **`task_id`（一次性授权）**：授权只对这个任务 id 有效。特权模式在执行之前把它记入本地的已用列表（`/var/lib/crha/privileged/used`，先持久化再执行），同一个授权不能再用第二次，同一个任务 id 也不能再执行第二次。带 `task_id` 的授权必须有 `deadline`，已用记录保留到 `deadline` 之后 7 天再清理（留出时钟回退的余量，见"时钟"）。
- `exact` 只约束"执行什么"，不约束"执行几次"。不带 `task_id` 的授权在有效期内可以重复使用，这是有意的（例如计划任务、`crha grant` 预先签发的授权）。
- crhs 签发的"单条命令授权"就是 `exact` + `task_id` + 很短的 `deadline`。特权模式对 `role = "crhs"` 的授权和所有联署**强制要求 `task_id`**；`require_exact` 和 `max_ttl` 由 crhs 信任项配置。
- 用户在审批某个具体任务时（WebUI 中用 Passkey，或 `crha grant --task`），签发的授权同样带 `task_id`，是一次性的。
- 计划任务的授权也是同一种结构：`exact` + `deadline`，不带 `task_id`，以便每次触发都能使用。特权模式不检查调度时间，所以在截止时间之前，持有它的一方可以随时使用；需要逐次约束时用联署（联署带 `task_id`，每次触发一个）。

### 签名方式

| 签名方 | 格式 | 被签名的内容 | 在哪里签 |
|---|---|---|---|
| crhs | SSHSIG（`ssh-ed25519`，namespace `crh-auth-v1`，哈希 sha512） | `CBOR(payload)` | crhs 内部；私钥可以放在 ssh-agent 托管的设备中（gpg-agent、PKCS#11、HSM），crhs 进程本身不接触私钥 |
| 用户 SSH key | SSHSIG（同上；支持 `ssh-ed25519`、`sk-ssh-ed25519@openssh.com`、`ecdsa-sha2-nistp256` 及其 sk 版本） | `CBOR(payload)` | 用户工作站：`crha grant`，或者直接用 `ssh-keygen -Y sign -n crh-auth-v1` |
| 用户 Passkey | WebAuthn assertion | `challenge = SHA-256("crh-auth-v1\0" ‖ CBOR(payload))` | WebUI |

- 规范化使用 `CBOR-CORE-INT-v1`（RFC 8949 §4.2.1、最短整数、无 indefinite length、禁 float/tag、时间整数毫秒）。`crha grant` 会把 CBOR 解码成 JSON 展示给用户确认后再签。
- 用 SSHSIG 签名的授权，都可以用 `ssh-keygen -Y verify` 人工核验。
- WebAuthn 的校验项：`type = webauthn.get`、challenge、origin 在白名单中、rpIdHash、UP 标志（UV 可配置为必须）、签名（ES256 或 EdDSA）。签名计数器忽略（同步型 passkey 的计数恒为 0）。
- 信任 Passkey 即接受这样的风险：crhs 被控制时，审批页面可以诱导用户签下与显示内容不同的授权。

## 信任配置

所有信任项放在同一个数组里，用 `role` 区分角色，用 `format` 区分签名格式：

| role | 可用的 format | 可用的 kinds | 说明 |
|---|---|---|---|
| `crhs` | `sshsig` | `execute`、`cosign` | crhs 的授权签名密钥 |
| `user` | `sshsig`、`webauthn` | `execute`、`require-cosign` | 用户的 SSH key、FIDO 硬件 key、Passkey |
| `local` | —（用 `uids`） | `execute` | 在节点上执行 `crha approve` 本地批准 |

| kind | 含义 |
|---|---|
| `execute` | 可以单独授权特权任务 |
| `cosign` | 可以为要求联署的用户授权签发联署 |
| `require-cosign` | 这个用户的授权每次使用都必须附带联署 |

联署只能来自 `role = "crhs"` 且 `kinds` 含 `cosign` 的信任项。因此**用户之间互相联署在结构上就不可能出现**。crhs 的 `execute` 和 `cosign` 是两种独立的能力，可以只给其中一种：

| crhs 信任项的 kinds | 效果 |
|---|---|
| `["execute", "cosign"]` | crhs 可以单独授权，也可以联署 |
| `["cosign"]` | crhs 不能单独授权，只能为要求联署的用户授权签发联署 |
| 不配置 crhs 信任项 | crhs 完全不参与特权任务 |

```toml
# /etc/crha/privileged.toml
node_id          = "01JB…"
groups           = ["web", "prod"]          # 授权依据：发给这些组的授权视为发给本机
unprivileged_uid = 998
clock_skew       = "60s"

[[trust]]
name          = "crhs"                      # 名字只在本地有意义；crhs 按公钥指纹识别信任项
role          = "crhs"
format        = "sshsig"
key           = "ssh-ed25519 AAAA… crhs-signing"
kinds         = ["execute", "cosign"]
require_exact = true                        # 单独授权时只接受 exact
max_ttl       = "5m"                        # deadline 必填，且 deadline - issued_at ≤ 5m
allow = [
  { method = "exec",       prefix = "systemctl restart " },
  { method = "exec",       regex  = 'apt-get (update|upgrade -y)' },
  { method = "file.write", prefix = "/etc/nginx/" },   # 同时放行这些路径的读取
  { method = "file.read" },                            # 不写 prefix / regex = 该方法的任意目标
]
deny  = [
  { method = "file.read",  regex  = '/etc/(shadow|gshadow|sudoers.*)' },
  { method = "file.write", prefix = "/etc/crha/" },        # crhs 不能修改 crha 的配置和信任
]

[[trust]]
name    = "ktren-yubikey"
role    = "user"
format  = "sshsig"
key     = "sk-ssh-ed25519@openssh.com AAAA…"
kinds   = ["execute"]
max_ttl = "24h"

[[trust]]
name          = "ktren-passkey"
role          = "user"
format        = "webauthn"
rp_id         = "crh.example.com"
origins       = ["https://crh.example.com"]
credential_id = "…"
key           = "cose:…"
require_uv    = true
kinds         = ["execute", "require-cosign"]

[[trust]]
name  = "local-admins"
role  = "local"
uids  = [0, 1000]
kinds = ["execute"]
```

### 字段

| 字段 | 适用 | 说明 |
|---|---|---|
| `kinds` | 全部 | 见上表 |
| `max_ttl` | 全部 | 设置后 `deadline` 必填，且 `deadline - issued_at ≤ max_ttl`；不设置则允许不过期的授权 |
| `require_exact` | 全部（主要用于 crhs） | 单独授权时只接受 `exact` |
| `require_task` | `user` | 只接受带 `task_id` 的一次性授权（`crhs` 角色始终要求） |
| `allow` / `deny` | 全部 | 防护规则，见下文 |
| `env_allow` | 全部 | 允许任务携带的环境变量名，默认为空 |

### 防护规则

规则只做简单的过滤，不是规则引擎。每条规则写成 `{ method = …, prefix = … }` 或 `{ method = …, regex = … }`：

- `method` 必填（`allow` 和 `deny` 都是），取值为 `exec`、`file.read`、`file.write`。`file.write` 规则同时覆盖 `file.read`。
- `prefix` 和 `regex` 二选一，都不写表示该方法的任意目标。`prefix` 是语法糖，编译为 `^<转义后的前缀>.*$`；`regex` 使用 RE2 语法，隐式全匹配。
- 判定顺序：先看 `deny`，命中任何一条就拒绝；`allow` 非空时必须命中其中一条。
- 规则只约束方法和目标，不约束 stdin 和写入内容。例如放行 `{ method = "exec", prefix = "bash" }` 就等于放行任意脚本。需要约束内容时，用 `exact` 授权。
- 环境变量：任务只能携带 `env_allow` 中列出的变量，PATH 由特权模式固定。否则 `LD_PRELOAD`、`PATH` 之类的变量可以绕过基于命令行的规则。

### 联署

用户信任项的 `kinds` 中包含 `require-cosign` 时，这个用户的授权**每次使用都必须附带一个 crhs 联署**：

- 联署是同一 payload 的 `signatures` 中的另一个签名，由 `role = "crhs"` 且 `kinds` 含 `cosign` 的信任项签发。
- 两个签名覆盖完全相同的 nodes、command、spec hash、task_id 和 deadline，不存在第二个 payload。
- **该 crhs 信任项的其他限制（require_exact、max_ttl、allow/deny）在联署时不生效**，只检查角色和 `cosign` 能力。
- 效果：用户授权和 crhs 的单次确认都齐备时才能执行。crhs 无法单独执行特权任务，用户授权也不能绕过 crhs 的策略单独使用。

## 校验流程

1. 用 `SO_PEERCRED` 检查对端 uid：提交任务必须是 `unprivileged_uid`；本地批准必须在某个 `local` 信任项的 `uids` 中。
2. 检查任务本身：文件操作的路径满足"方法与目标"一节的要求。
3. 对 payload 上的每个签名，按公钥（或 credential id）找到信任项并验证签名。
4. 检查授权本体：`nodes` 包含本机的 node_id 或本机配置的某个组（或为 `"*"`）；`attempt` 等于 `task.start` 的 attempt；`issued_at ≤ now + skew`；`deadline`（如果有）`≥ now - skew`；`max_ttl` 和 `require_exact`。这里的 `now` 是节点时钟，见下文"时钟"。
5. 检查一次性约束：授权带 `task_id` 时必须等于本任务 id，且授权 id 不在已用列表中；`role = "crhs"` 的授权和联署必须带 `task_id`；信任项有 `require_task` 时同样必须带。任何情况下，本任务 id 都不能已经执行过。
6. 检查授权中的指令限制：`exact` 时方法、目标和 `spec_sha256` 都相等；`prefix` 时方法匹配（`file.write` 包含 `file.read`）且目标前缀相等。
7. 检查信任项：`kinds` 包含 `execute`；`deny` 和 `allow`；`env_allow`。
8. 如果用户信任项包含 `require-cosign`：在同一 payload 上找 `role = "crhs"` 且含 `cosign` 的签名并验证。
9. 检查 payload 的授权 id 不在吊销列表中。
10. 把任务 id 和一次性授权 id 记入已用列表（持久化）→ 写本地日志 → 执行 → 写结果日志。

任何一步失败都通过 `task.start` 的错误响应返回：`[1, id, "task.start", false, [code, message]]`。`code` 区分授权失败、授权过期、联署缺失、路径/规则拒绝等；本地批准走 socket 的独立响应，不走 `task.start`。

特权模式必须在发送 `task.accepted` **之前**完成授权验证；拒绝时任务没有执行、没有写 used、没有副作用，所以同一 task id 可以用更高的 attempt 重试。`task.input` 只在 accepted 后接收。

**执行环境**：
- 以特权模式自身的 Linux 身份执行；
- 环境变量只保留 `env_allow` 中允许、且任务提供了的，PATH 固定；
- 非 `exact` 授权时 cwd 固定为 `/`；
- 进程放进新的进程组；
- 特权模式自己执行超时控制。

### 时钟

授权的 `issued_at` 和 `deadline` 由签名方的时钟写入，由节点的时钟检查，这是信任配置中唯一依赖双方时钟一致的地方（通信握手不依赖，见 [execution-plane.md](execution-plane.md#握手)）。让步如下：

- 节点必须运行 NTP 等时间同步；容差由 `clock_skew` 配置（默认 60 秒）。
- 节点时钟偏慢时，过期的授权会多可用一段时间；偏快时，新签的授权可能被判为"签发于未来"或很快过期。前者属于主机内问题（能改节点时钟的人已经能做更多事），不在威胁模型内；后者只造成拒绝，不造成越权。
- crha 每次握手时算出与 crhs 的时钟偏差，在 `Facts` 中上报。偏差超过阈值（默认 60 秒，`crha.toml` 和 `crhs.toml` 中的 `clock_warn` 各自配置）时：crha 写警告日志（同时进 journald），crhs 写警告日志并在 WebUI 中显示警告。除此之外不做别的处理。
- **时钟回退**：通信不受影响。授权检查方面，回退期间已经过期的授权会重新变得"未过期"，直到时钟校正。一次性授权的重复使用由已用列表防止，不依赖时钟；已用记录在 `deadline` 之后还保留 7 天，回退不超过 7 天时不会因为记录已被清理而被再次使用。
- 不采用"特权模式记住见过的最大时间，用它代替系统时间"的做法：它能挡住回退，但时钟误跳到未来再校正回来时，所有授权都会被判为过期，特权执行被锁死，与握手时间戳方案的问题相同。

## 本地批准

用户 SSH 登录节点后执行 `crha pending` 查看待批准的任务，再执行 `crha approve <task-id>` 放行。CLI 直接连接特权模式的 socket，由匹配的 `local` 信任项按上面的流程校验（第 3、4、6 步不适用；任务 id 同样不能重复执行）。这条路径不经过 crhs，也不需要任何密钥。

待批准任务由特权模式持有；不自动超时，取消、拒绝或特权模式重启结束。

## 吊销

- 吊销只会减少权限，所以特权模式接受经非特权模式转发的吊销列表，不要求签名；本地也可以执行 `crha privileged revoke <授权 id>`。
- crhs 在用户吊销授权后，把吊销列表推送给相关节点。
- 吊销列表持久化保存；带 `deadline` 的授权过期后，对应的吊销记录可以清理；不过期的授权，其吊销记录永久保留。
- 节点离线期间，吊销无法送达。所以长期有效的授权要谨慎签发，建议用 `max_ttl` 限制。

## crhs 侧

### 信任缓存

crhs 在 `nodes` 中缓存特权模式上报的 `TrustSummary`、`trust_digest` 和 `run_identities`：

- 节点连接后查询一次 TrustSummary；
- 特权模式 reload 导致配置变化时主动推送；
- crhs 收到后更新缓存、写审计；
- WebUI 展示"这个节点信任谁"，并可以导出 `privileged.toml` 片段；
- 任务授权时记录使用的 digest；等待期间 digest 变化就重新计算。

crhs 从缓存计算授权方案：用 RE2（Node 包 `re2`）匹配信任项的 `allow`/`deny`、`exact`/`prefix`、`max_ttl`、`require_exact`、`require_task` 等。**只考虑任务所有者**（`on_behalf_of_user_id`）的 `user` 信任项和凭据；共享用户、其他管理员不参与。

crhs 的选择不是最终放行：crha 特权模式在执行前仍按当前配置完整复验；crhs 的规则匹配失败只会导致多等用户或拒绝，不会越权。

### 授权路径

收到一个特权任务后：

1. **crhs 授权规则**：沿规则链判定（见 [access-control.md](access-control.md#授权规则)；用户本人在 WebUI 中操作时跳过），再加可选的 auto review。deny 就直接结束；需要审批则先按链向上完成审批。
2. **非特权模式的处理方式**：`native` / `ignore` 只需要第 1 步放行；`reject` 直接拒绝；SSH 节点按 `ignore` 处理并加输出提示；`forward` 继续第 3 步。
3. **用缓存的 TrustSummary 计算授权方案**（只为任务所有者）：
   - crhs 信任项可以单独授权：crhs 签发 `exact` + `task_id` + 短 `deadline` 的授权，放进同一 payload 的 `signatures`，下发；
   - 所有者的 user 信任项可以授权：
     - 先查找这个所有者已经签发、仍然有效、并且覆盖本次任务的授权（按 nodes、指令限制、deadline 匹配）；
     - 没有就创建授权等待，只给所有者显示（WebUI Passkey 或 `crha grant`），或等待节点本地批准；
     - 如果需要联署，crhs 在同一 payload 上再追加自己的签名；
   - 有 `local` 信任项可以授权：在授权等待中提示"也可以在节点上执行 `crha approve`"；
   - 没有任何信任项可以授权：直接拒绝，并告诉调用方"这个节点上没有人能授权这条命令"。

授权等待与规则审批分开：策略已经通过但尚未拿到签名时，任务处于 `awaiting_authorization`，不是 `awaiting_approval`。

**预演与 fallback**：crhs 的规则计算只是预演，不是最终授权。若 crha 在 `task.accepted` 之前拒绝授权：

1. 使该节点的 TrustSummary 缓存失效并重新查询；
2. 用 `attempt + 1` 重新计算方案，但不再重复尝试相同的 crhs 签名路径，优先回退到所有者的 user/local 路径；
3. 没有可用的 user/local 路径时，任务最终 `rejected`，error code 为 `authorization_required` / `authorization_invalid` / `authorization_expired`；
4. 已 accepted 的任务、已执行的其他节点任务不回滚。

crhs 误判“没有路径”时不会创建任务，因此也无法被 crha 拒绝后的 fallback 修复；Go/TS 必须共用同一套授权判定用例，覆盖规则匹配、prefix/RE2、env、组、trust digest 和边界时间。

### 授权签名密钥

- `ssh-ed25519`。可以通过 ssh-agent 签名（`crhs.toml` 中配置 agent socket），也可以使用由主密钥加密存储的密钥文件。
- 轮换：在各节点的信任配置中加入新公钥 → crhs 切换到新密钥 → 移除旧公钥。每个节点的信任配置修改都是一个需要用户授权的特权任务（或者在节点上本地修改）。

## 扩展预留

暂不实现，但现有设计不能阻塞它们。

### 签名信任包

- 设想：一把离线保管的管理员密钥签发信任包（一组信任项 + 单调递增的版本 + 有效期），经 crhs 和非特权模式分发给特权模式，用于在大量节点上统一管理用户。crhs 只负责分发，无法伪造。
- 预留：
  - 特权模式的信任项按"来源"加载（v1 只有 `privileged.toml`），以后可以增加信任包作为第二个来源；
  - `role` 字段是开放的，以后可以增加只能签发信任包的角色；
  - `TrustSummary` 中每一项带上来源字段（v1 恒为 `local`）。
