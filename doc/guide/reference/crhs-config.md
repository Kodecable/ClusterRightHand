# crhs configuration reference

## Configuration file

crhs reads one TOML file, by default `/etc/crhs/crhs.toml`; pass `-c` or `--config` to use another.
Every crhs command reads it. crhs reads the file only at startup; restart crhs to apply changes.

Durations are strings such as `"60s"`, `"5m"`, `"1h30m"` or `"1d12h"`, using the units `ms`, `s`, `m`,
`h` and `d`.

Every key with its default (commented keys are unset by default):

```toml
master_key_file = "/etc/crhs/master.key"
# web_root = "/opt/crh/web/dist"
# public_url = "https://crh.example.com"
clock_warn = "60s"

[listen]
host = "127.0.0.1"
port = 8080
# real_ip_header = "X-Forwarded-For"

[database]
driver = "sqlite"
path = "/var/lib/crhs/crhs.db"
# url = "postgres://crh:secret@db.example.com/crh"

[webauthn]
# rp_id = "crh.example.com"
rp_name = "ClusterRightHand"
# origins = ["https://crh.example.com"]

[retention]
tasks = "90d"
audit = "180d"
pi_tasks = "7d"

[auth]
argon2_concurrency = 2
argon2_queue = 32
captcha = "cap"
```

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `master_key_file` | path | `/etc/crhs/master.key` | The master key, created by `crhs keys init`. Must be readable only by its owner (mode 0600) and belong to this database. |
| `web_root` | path | `web/dist` next to the server source | The built WebUI. |
| `public_url` | absolute http(s) URL | unset | The public address of the WebUI, used for links crhs returns (for example in MCP results). A path prefix is allowed; no query or fragment. Unset: links use the address of the request. |
| `clock_warn` | duration | `"60s"` | Warn when a node's clock differs from crhs's by more than this. `"0s"` disables the warning. Not the authorization tolerance, which is `clock_skew` in [`privileged.toml`](privileged-config.md#top-level-keys). |

## [listen]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | `"127.0.0.1"` | Address to listen on. |
| `port` | integer 0–65535 | `8080` | Port to listen on. `0` picks a free port. |
| `real_ip_header` | header name | unset | Take the client address from the first value of this header, for example `X-Forwarded-For`. Unset: the connection's peer address. |

The client address is used for login rate limiting and the login captcha. If you set
`real_ip_header`, your reverse proxy must overwrite that header, and crhs must not be reachable
directly; otherwise clients can choose their own address. The `Forwarded` header is not supported.

## [database]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `"sqlite"` or `"postgres"` | `"sqlite"` | Database backend. |
| `path` | path | `/var/lib/crhs/crhs.db` | SQLite database file. Its directory must exist. |
| `url` | string | none | PostgreSQL connection string; required with `driver = "postgres"`. |

## [webauthn]

Settings for Passkeys, which are used to sign privileged-task authorizations.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rp_id` | hostname | unset | The hostname Passkeys are registered for, such as `crh.example.com`. |
| `rp_name` | string | `"ClusterRightHand"` | Name shown by the authenticator. |
| `origins` | array of origins | unset | Origins allowed to use Passkeys, as `scheme://host[:port]` without a default port, for example `["https://crh.example.com"]`. |

Set `rp_id` and `origins` together, or leave both unset to take them from each request's origin.

## [retention]

How long to keep old records. Each value is a duration of at least `"1d"`, or `"off"` to keep records
forever.

| Key | Default | Records |
|---|---|---|
| `tasks` | `"90d"` | Finished tasks and task groups, and authorizations past their deadline |
| `audit` | `"180d"` | Audit events; the most recent events are always kept |
| `pi_tasks` | `"7d"` | Internal records of finished agent tool calls |

Cleanup runs shortly after startup and then hourly. Session conversations are not affected.

## [auth]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `argon2_concurrency` | integer ≥ 1 | `2` | Password hashes computed at once. Each uses 64 MiB of memory. |
| `argon2_queue` | integer ≥ 0 | `32` | Password hashes allowed to wait; beyond that, requests fail with `hash_busy`. |
| `captcha` | `"cap"` or `"none"` | `"cap"` | Whether sign-in requires the proof-of-work check. Use `"none"` only where no browser is involved. |

Logins can always use every hashing slot, while password changes and user creation are held back, so
signed-in users cannot block others from signing in. If you raise `argon2_concurrency` above 2, also
raise the `UV_THREADPOOL_SIZE` environment variable (default 4).

## Unknown keys and errors

Unknown keys, keys in the wrong table, and values of the wrong type are errors. crhs prints
`crhs: <path>: <message>` and exits with code 2. A key written after a table header belongs to that
table, so a top-level key placed after `[database]` is reported as `database.<key>`.
