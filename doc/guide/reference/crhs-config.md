# crhs configuration reference

`crhs` reads one TOML file. This page lists every key, its type, its default and what it changes,
then describes how the parser reports mistakes. For the commands that use the file, see the
[command-line reference](cli.md#crhs); for the reasons behind the login and retention settings, see
[Password hashing](../../design/access-control.md#password-hashing) and
[Retention](../../design/data-model.md#retention).

## Configuration file

The default path is `/etc/crhs/crhs.toml`. Override it with `-c <path>` or `--config <path>`; the
option can appear before or after the command. The file is read once, before the command runs, and
is never re-read: a running server keeps the configuration it started with, so restart `crhs serve`
to apply an edit.

Every command loads the configuration first, including `crhs keys init` and `crhs user add`. A file
that cannot be read or parsed therefore stops those commands too, with exit code 2.

Durations are TOML strings made of one or more `<number><unit>` groups, where the unit is `ms`, `s`,
`m`, `h` or `d`: `"60s"`, `"5m"`, `"1h30m"`, `"1d12h"`. Fractions, bare numbers and spaces between
groups are rejected. A value of `"0s"` is zero; negative values cannot be written.

A complete file with every key at its default (commented keys are optional and shown with the value
they take when omitted):

```toml
# /etc/crhs/crhs.toml

# Master key file: 32 bytes of base64, mode 0600. `crhs keys init` creates it.
master_key_file = "/etc/crhs/master.key"

# Built WebUI served at /. Default: the web/dist directory next to the server source.
# web_root = "/usr/share/crhs/web"

# Warn when a node's clock differs from crhs by more than this; "0s" disables the warning.
clock_warn = "60s"

[listen]
host = "127.0.0.1"
port = 8080
# real_ip_header = "X-Forwarded-For"   # unset: use the socket peer address

[database]
driver = "sqlite"
path = "/var/lib/crhs/crhs.db"
# url = "postgres://crh:secret@db.example.com/crh"   # required when driver = "postgres"

[webauthn]
# rp_id and origins are set together, or both omitted to derive them from the request's Origin.
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

Only the eight top-level entries `listen`, `database`, `master_key_file`, `web_root`, `clock_warn`,
`webauthn`, `retention` and `auth` exist. `master_key_file`, `web_root` and `clock_warn` are keys;
the other five are tables.

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `master_key_file` | string, non-empty | `/etc/crhs/master.key` | File holding the master key that encrypts the `secrets` table. Created by `crhs keys init`, backed up with `crhs keys export`. The file must contain exactly 32 bytes of base64 and must not grant any permission to group or others (mode 0600); otherwise crhs refuses to use it. A file whose key id does not match the database is refused as well. |
| `web_root` | string, non-empty | the `web/dist` directory next to the server source | Directory of the built WebUI. Its files are served at `/`; a request that is not under `/api/`, `/agent` or `/mcp` and does not name a file falls back to `index.html`, so client-side routes work. If the directory is missing, only the API, agent and MCP endpoints answer. |
| `clock_warn` | duration string | `"60s"` | Warn when a node reports a clock offset larger than this. `"0s"` disables the warning. The warning only writes a log line and shows a notice in the WebUI; it never refuses work. The measured offset is taken during the handshake, once per connection. This is not the authorization tolerance, which is `clock_skew` in [privileged.toml](privileged-config.md#top-level-keys). See [Clock](../../design/privilege.md#clock). |

The value names both the file `crhs keys init` creates and the file every command that touches
encrypted data reads.

## [listen]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `host` | string, non-empty | `"127.0.0.1"` | Address to bind. The default listens on loopback only, which assumes a reverse proxy on the same host. |
| `port` | integer 0–65535 | `8080` | Port to bind. `0` lets the operating system choose a free port; the startup line prints the port actually used. |
| `real_ip_header` | HTTP header name | unset | Header whose first non-empty element becomes the client address. Unset means the socket's peer address. |

`real_ip_header` follows one rule only: read the request header, split its value on `,`, trim each
element and use the first non-empty element. A missing or empty header falls back to the socket peer
address. There is no trusted-proxy list and no walk from right to left.

The deployer is responsible for the header: a reverse proxy must overwrite a same-named header sent
by the client, not append to it. When crhs is reachable directly, any client can forge the header;
the loopback default and a firewall are the intended protection. The RFC 7239 `Forwarded` format is
not supported; use `X-Forwarded-For`, `X-Real-IP` or a single-value header of your own.

The address is used for login rate limiting, for the Cap challenge scope and for the IP stored on a
WebUI session. A login challenge and the login request must see the same address; if the proxy
behaviour changes between them, the Cap check fails with HTTP 403 and code `captcha_failed`, with a
reason from the verifier. See [Client address](../../design/access-control.md#client-address).

The header name must be an RFC 9110 token: letters, digits and the punctuation RFC 9110 allows. A
value with a space, such as `"X Forwarded For"`, is a configuration error.

## [database]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `"sqlite"` or `"postgres"` | `"sqlite"` | Storage backend. |
| `path` | string, non-empty | `/var/lib/crhs/crhs.db` | SQLite database file. Read only when `driver = "sqlite"`. |
| `url` | string, non-empty | none | PostgreSQL connection string. Required when `driver = "postgres"`. |

Both `path` and `url` are accepted in either mode, but only the key that belongs to the selected
driver is read; the other is ignored. For SQLite, the directory holding the file must exist and the
process must be able to write it; the database uses WAL mode and waits up to five seconds for
another process's lock. For PostgreSQL, crhs opens a connection pool from `url`.

Schema migrations run automatically at startup, before the command runs, for both drivers. A single
application account is enough for migrations, installation and runtime. See
[Schema migrations](../../design/data-model.md#schema-migrations) and
[Storage backends](../../design/data-model.md#storage-backends).

## [webauthn]

Passkey registration and assertion settings. WebAuthn is used for authorizations, not for password
login; see [Signing methods](../../design/privilege.md#signing-methods).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rp_id` | string, non-empty, no `/` | unset | Relying-party ID a Passkey is registered for, normally the site's hostname such as `crh.example.com`. |
| `rp_name` | string, non-empty | `"ClusterRightHand"` | Name shown by the authenticator during registration. |
| `origins` | array of origin strings, non-empty | unset | Origins a registration or assertion may come from, for example `["https://crh.example.com"]`. Each entry must be exactly `scheme://host[:port]`; a path, query, fragment or userinfo is rejected, and so is an explicit default port (`:443`), because the comparison uses the parsed origin. |

`rp_id` and `origins` must be set together or both omitted. When both are omitted, crhs derives them
from each request's `Origin` header, which suits a single-domain deployment. The empty table
`[webauthn]` is valid and means "derive per request".

## [retention]

How long rows are kept before the hourly retention sweep deletes them. Each value is a duration
string or the literal `"off"`, which keeps the rows forever. The minimum is `"1d"`: a shorter window
could delete a task whose durable tool call reruns after a crash and would otherwise reattach to the
existing row. A value below one day is a configuration error.

| Key | Type | Default | Rows |
|---|---|---|---|
| `tasks` | duration or `"off"` | `"90d"` | Terminal tasks, terminal task groups and authorizations whose deadline has passed. |
| `audit` | duration or `"off"` | `"180d"` | Audit events. The newest 16384 audit sequence numbers are always kept, regardless of age. |
| `pi_tasks` | duration or `"off"` | `"7d"` | Terminal durable agent tasks (`pi_tasks` and the documents and revisions that belong to them). |

The sweep runs five seconds after startup and then once an hour; a slow sweep is not started twice.
Rows still in a non-terminal state are never deleted. The audit floor, the `pi_tasks` rules and the
authorization window are described in [Retention](../../design/data-model.md#retention) and
[Trust cache](../../design/privilege.md#trust-cache).

## [auth]

Login hashing and proof-of-work settings. All Argon2id work in the process, including `crhs user
add` and `crhs user passwd`, passes through one gate configured here.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `argon2_concurrency` | integer ≥ 1 | `2` | Argon2id computations allowed to run at once. |
| `argon2_queue` | integer ≥ 0 | `32` | Argon2id computations allowed to wait; when the queue is full a request fails at once with HTTP 503 and code `hash_busy`. |
| `captcha` | `"cap"` or `"none"` | `"cap"` | Whether password login requires a Cap proof-of-work challenge. |

Each hash uses Argon2id with 64 MiB of memory, three passes, parallelism 1, a 16-byte salt and a
32-byte tag, so peak memory is roughly `argon2_concurrency × 64 MiB` (about 128 MiB with the
default). Hashing runs on libuv's thread pool, which has four threads by default; if you raise
`argon2_concurrency` above 2, raise `UV_THREADPOOL_SIZE` as well, or file and DNS work will queue
behind logins.

The gate treats a login differently from every other hash. A login may use all running slots and the
whole queue. Other hashes (password change, administrator reset, user creation) may use at most
`argon2_concurrency - 1` slots when there are at least two, and at most half the queue (but at least
one waiter when the queue is non-empty), so a logged-in user cannot take the last slot and make
site-wide login answer 503. With `argon2_concurrency = 1` there is no spare slot and both kinds
share the one. Waiting logins are woken before other hashes. When nothing is free, the response is
503 with `Retry-After: 1` and
`{"error": "the server is busy, try again", "code": "hash_busy"}`.

With `captcha = "cap"`, `POST /api/auth/login` must carry a Cap solution. The challenge is issued by
`POST /api/auth/login/challenge`, is valid for two minutes and is bound to the client address, the
username and the password. `"none"` disables the check and is intended only for controlled
environments that cannot run a browser.

A wrong current password in a password change counts as a failed login under the same address key,
and only one password-change verification per account may run at a time. See
[Rate limiting](../../design/access-control.md#rate-limiting),
[Password hashing](../../design/access-control.md#password-hashing) and
[Cap proof of work](../../design/access-control.md#cap-proof-of-work).

## Unknown keys and errors

Every table is strict. An unknown key, an unknown table, a key in the wrong table and a value of the
wrong type are all startup errors; nothing is silently ignored. This is deliberate: a top-level key
written after a table header belongs to that table, and ignoring it would hide a configuration
mistake.

The process prints one line, `crhs: <path>: <message>`, and exits with code 2. Typical messages:

| Input | Message |
|---|---|
| `[auth]` with `unknown = 1` | `unknown configuration key auth.unknown` |
| `master_key_file` written after `[database]` | `unknown configuration key database.master_key_file` |
| `listne = 1` at top level | `unknown configuration key listne` |
| `listen = 1` | `[listen] must be a table` |
| `[listen] port = 70000` | `listen.port must be an integer between 0 and 65535` |
| `[listen] real_ip_header = "X Forwarded For"` | `listen.real_ip_header must be an HTTP header name such as "X-Forwarded-For"` |
| `[auth] argon2_concurrency = 0` | `auth.argon2_concurrency must be an integer >= 1` |
| `[auth] argon2_queue = -1` | `auth.argon2_queue must be an integer >= 0` |
| `[auth] captcha = "sometimes"` | `auth.captcha must be "cap" or "none"` |
| `[database] driver = "mysql"` | `database.driver must be "sqlite" or "postgres", got "mysql"` |
| `[database] driver = "postgres"` without `url` | `database.url must be a non-empty string` |
| `clock_warn = 90` (a number) | `clock_warn must be a duration string such as "60s", "5m" or "1d"` |
| `clock_warn = "90"` | `clock_warn must be a duration such as "60s", "5m" or "1d", got 90` |
| `[retention] tasks = "23h"` | `retention.tasks must be "off" or at least "1d": a shorter window could delete a task whose durable tool call reruns after a crash` |
| `[webauthn]` with only `rp_id` | `webauthn.rp_id and webauthn.origins must be set together` |
| `[webauthn] origins = ["https://crh.example.com/app"]` | `webauthn.origins: "https://crh.example.com/app" must be an origin (scheme://host[:port])` |

TOML syntax errors come from the TOML parser and are prefixed the same way, for example
`crhs: /etc/crhs/crhs.toml: Invalid TOML document: ...`. A missing file produces the operating
system's read error in the same line. In every case the command does not run.

Errors found after the file is accepted, such as a master key file with the wrong permissions or a
key that does not belong to the database, are reported as `crhs: <message>` with exit code 1. See
[the crhs command reference](cli.md#crhs).
