# crhs 配置文件

crhs 从 TOML 文件读取配置，默认路径是 `/etc/crhs/crhs.toml`（`crhs -c <path>` 覆盖）。未列出的键是错误，不会静默忽略；进程只在启动时读取一次，修改后需要重启。项目尚未发布，不保证旧配置兼容。

```toml
master_key_file = "/etc/crhs/master.key"
# web_root      = "/usr/share/crhs/web"      # 默认是仓库里的 web/dist
clock_warn      = "60s"                     # 节点时钟偏差告警阈值，0 关闭

[listen]
host           = "127.0.0.1"
port           = 8080
real_ip_header = "X-Forwarded-For"          # 不设置时使用 socket 的对端地址

[database]
driver = "sqlite"                           # 或 "postgres"
path   = "/var/lib/crhs/crhs.db"
# url  = "postgres://crh:crh@db/crh"        # driver = "postgres" 时使用

[webauthn]
rp_id   = "crh.example.com"
rp_name = "ClusterRightHand"
origins = ["https://crh.example.com"]

[retention]
tasks     = "90d"                           # 或 "off"
audit     = "180d"
pi_tasks  = "7d"

[auth]
argon2_concurrency = 2
argon2_queue       = 32
captcha            = "cap"                  # 或 "none"
```

## 顶层

| 键 | 默认值 | 说明 |
|---|---|---|
| `master_key_file` | `/etc/crhs/master.key` | 主密钥文件；`crhs keys init` 创建，`crhs keys export` / `import` 备份和恢复。 |
| `web_root` | 仓库内的 `web/dist` | 构建好的 WebUI 目录；`/api`、`/agent`、`/mcp` 之外的路径回退到 `index.html`。 |
| `clock_warn` | `"60s"` | 节点上报的时钟偏差超过该值时告警；`"0s"` 关闭。必须是带单位的字符串（`ms`/`s`/`m`/`h`/`d`，可组合，如 `"1m30s"`）。 |

## `[listen]`

| 键 | 默认值 | 说明 |
|---|---|---|
| `host` | `"127.0.0.1"` | 监听地址。默认只监听本机，通常由同一台机器上的反向代理转发。 |
| `port` | `8080` | 监听端口，0–65535。 |
| `real_ip_header` | 不设置 | 一个 HTTP 头名；设置后用它计算客户端地址。 |

`real_ip_header` 的规则**只有一条**：取该请求头的值，按 `,` 分割，去掉每段两端的空白，使用**第一个非空元素**作为客户端地址；请求头不存在或所有元素都为空时，回退到 socket 的对端地址。没有受信代理列表，也不从右向左跳过代理追加的地址。

- 谁可以设置这个头由部署者负责。反向代理必须**覆盖**（而不是追加）客户端传入的同名头；crhs 直接暴露在网络上时，任何客户端都能伪造它。默认的 `host = "127.0.0.1"` 配合防火墙或只监听内网是推荐部署。
- 不支持 RFC 7239 的 `Forwarded` 头格式（`Forwarded: for=…;proto=…`），请使用 `X-Forwarded-For`、`X-Real-IP` 或反代自定义的单值头。
- 该地址用于登录限流、Cap PoW 的 scope，以及 Web 会话记录的 IP。登录挑战和登录请求必须得到同一个地址；代理行为在两者之间发生变化时，Captcha 会以 `scope_mismatch` 失败。

## `[database]`

| 键 | 默认值 | 说明 |
|---|---|---|
| `driver` | `"sqlite"` | `"sqlite"` 或 `"postgres"`。 |
| `path` | `/var/lib/crhs/crhs.db` | SQLite 文件路径。 |
| `url` | — | PostgreSQL 连接串；`driver = "postgres"` 时必填。 |

## `[webauthn]`

Passkey 的依赖方设置。`rp_id` 与 `origins` 必须同时设置或同时省略；省略时按请求的 `Origin` 推导（适合单域名部署）。`rp_name` 是显示名，默认 `ClusterRightHand`。

## `[retention]`

保留期。值为带单位的字符串或 `"off"`（永久保留）。最短 `"1d"`：更短的窗口可能删掉崩溃后还要重新接上的 durable 工具调用。默认 `tasks = "90d"`、`audit = "180d"`、`pi_tasks = "7d"`。

## `[auth]`

| 键 | 默认值 | 说明 |
|---|---|---|
| `argon2_concurrency` | `2` | 同时运行的 Argon2id 计算数，必须 ≥ 1。 |
| `argon2_queue` | `32` | 允许排队等待的 Argon2id 计算数，必须 ≥ 0。 |
| `captcha` | `"cap"` | 密码登录是否要求 Cap 工作量证明：`"cap"` 或 `"none"`。 |

- 每个 Argon2id 哈希默认占 64 MiB（`m = 65536` KiB、`t = 3`、`p = 1`），所以**峰值内存约为 `argon2_concurrency × 64 MiB`**（默认约 128 MiB），再加上排队请求的少量开销。不要把 `argon2_concurrency` 设得超过机器愿意为登录承担的内存量。
- 哈希在 libuv 线程池中执行，默认只有 4 个线程（`UV_THREADPOOL_SIZE`）。`argon2_concurrency` 超过 2 时请同时调大 `UV_THREADPOOL_SIZE`；否则文件、DNS 等其它线程池任务会和登录哈希抢线程。
- 运行中的计算达到 `argon2_concurrency` 后，新计算进入队列；队列也满时立即返回 HTTP 503、`Retry-After: 1`、`{ "error": "the server is busy, try again", "code": "hash_busy" }`。
- 登录永远优先：`POST /api/auth/login` 的哈希可以用满 `argon2_concurrency` 个槽位和整个队列；其它哈希（修改密码、管理员重置、创建用户）最多用 `argon2_concurrency - 1` 个运行槽位（并发为 1 时就是那一个）和一半的队列长度。因此已登录用户把自己改密码的请求堆满，也不会让站点登录拿不到槽位而返回 503。登录等待者在槽位释放时先于其它哈希被唤醒。
- `captcha = "cap"` 时，`POST /api/auth/login` 必须带 `cap`；挑战由 `POST /api/auth/login/challenge` 签发，有效期 2 分钟，绑定客户端地址、用户名和密码。`"none"` 关闭该检查（只建议在不能运行浏览器的受控环境使用）。
- `POST /api/auth/password` 与登录共用失败计数器和客户端地址键：当前密码错误按失败登录计数（默认连续 10 次后 15 分钟内 429），同一账号同时只允许一个修改请求在验证密码（并发请求 429）。成功修改清除该账号的失败计数。

## 未知键与错误

每个表的未知键都是启动错误，例如 `unknown configuration key auth.unknown`。类型错误也会给出具体键名：`auth.argon2_concurrency must be an integer >= 1`、`listen.real_ip_header must be an HTTP header name such as "X-Forwarded-For"`。
