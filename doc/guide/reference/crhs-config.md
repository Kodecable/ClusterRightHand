# crhs configuration reference

## Configuration file

crhs reads one TOML file, by default `/etc/crhs/crhs.toml`; pass `-c` or `--config` to use another.
Every crhs command reads it. crhs reads the file only at startup; restart crhs to apply changes.

Durations are strings such as `"60s"`, `"5m"`, `"1h30m"` or `"1d12h"`, using the units `ms`, `s`, `m`,
`h` and `d`.

Every key, with its default (commented keys are unset by default):

```toml
master_key_file = "/etc/crhs/master.key"
# web_root = "/srv/crh/web"

[listen]
host = "127.0.0.1"
port = 8080

[database]
driver = "sqlite"
path = "/var/lib/crhs/crhs.db"
# url = "postgres://crh:secret@db.example.com/crh"

# [library]
# backend = "local"
# For the webdav backend:
# url = "https://dav.example.com/crhs/"
# username = "crhs"
# password = "secret"

# [models]
# catalog_download = true

# [crha_release]
# url = "https://github.com/Kodecable/ClusterRightHand"
# download = true
# verify = true
```

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `master_key_file` | path | `/etc/crhs/master.key` | The master key, created by `crhs init` or `crhs keys init`. Must be readable only by its owner (mode 0600) and belong to this database. |
| `web_root` | path | `web/` next to a bundled `crhs.mjs`, `web/dist` next to the server source otherwise | The built WebUI. |

## [listen]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | `"127.0.0.1"` | Address to listen on. |
| `port` | integer 0–65535 | `8080` | Port to listen on. `0` picks a free port. |

The client address header is **System settings → General → Real client IP header** (see below).

## [database]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `driver` | `"sqlite"` or `"postgres"` | `"sqlite"` | Database backend. |
| `path` | path | `/var/lib/crhs/crhs.db` | SQLite database file. Its directory must exist. |
| `url` | string | none | PostgreSQL connection string; required with `driver = "postgres"`. |

## [library]

The library object store, shared by every user and user group library
([Libraries](../webui.md#libraries)). The whole table is optional; without it, `backend` is `"local"`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `backend` | `"local"` or `"webdav"` | `"local"` | Where file objects are stored. |
| `url` | absolute http(s) URL | none | The WebDAV collection; required with `backend = "webdav"`. A trailing `/` is optional. |
| `username` | string | none | The WebDAV user; required with `backend = "webdav"`. |
| `password` | string | none | The WebDAV password; required with `backend = "webdav"`. |

With `local`, objects live in the `library/` directory of crhs's data directory: the directory
containing the SQLite database, or the directory containing `master_key_file` with PostgreSQL. crhs
owns the store exclusively; nothing else may read or write it. Changing the backend does not move
existing objects, so keep the old store available until its files are removed.

## [models]

The model catalogue used to fill a custom provider's discovered models
([Model discovery](../../design/agent-runtime.md#model-discovery)). The whole table is optional.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `catalog_download` | boolean | `true` | Whether crhs may download `https://models.dev/api.json` (at most once a day) into `models-dev/api.json` under its data directory. With `false`, a file stored earlier is still used; when there is none, pi-ai's bundled catalogue is used. |

## [crha_release]

Where crhs fetches the crha it upgrades nodes to: the release of its own version, tagged `v<version>`
([crha self-upgrade](../../design/distribution.md#crha-self-upgrade)). The whole table is optional.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | URL | `https://github.com/Kodecable/ClusterRightHand` | The repository. The assets are read from `<url>/releases/download/v<version>/`. A trailing `/` or `.git` is dropped. |
| `download` | boolean | `true` | Whether crhs may download missing assets into `crha-releases/<version>/` under its data directory. With `false`, copy `crha-<version>-linux-<arch>.tar.gz` (and, to keep a check, `SHA256SUMS`) there yourself, and crhs never deletes a file there. With `true`, a file that fails a check is deleted and downloaded again, whoever put it there. Either way, the directories of other versions are removed when crhs starts. |
| `verify` | boolean | `true` | Whether the Sigstore signature of `SHA256SUMS` is checked, with the release workflow of `url` at the tag as the identity. It needs a `github.com` repository and access to GitHub and `tuf-repo-cdn.sigstore.dev` at every upgrade; there is no offline fallback. With `false`, `SHA256SUMS` is still checked when present. A crhs whose version is not a release (`dev`, or a build between tags, `+…`) cannot upgrade nodes. |

## System settings

The low-frequency settings below are **not** in `crhs.toml`. Administrators edit them in the WebUI's
[**System settings**](../webui.md#system-settings) page, and a change applies without restarting crhs.

| Group → item | Type | Default | Meaning |
|---|---|---|---|
| **General → Public URL** | absolute http(s) URL | unset | The public address of the WebUI, used for links crhs returns (for example in MCP results). A path prefix is allowed; no query or fragment. Unset: links use the address of the request. |
| **General → Real client IP header** | header name | unset | Take the client address from the first value of this header, for example `X-Forwarded-For`. Unset: the connection's peer address. |
| **General → Clock warning threshold** | duration | `"60s"` | Warn when a node's clock differs from crhs's by more than this. `"0s"` disables the warning. Not the authorization tolerance, which is `clock_skew` in [`privileged.toml`](privileged-config.md#top-level-keys). |
| **Sign-in → Captcha** | `"cap"` or `"none"` | `"cap"` | Whether sign-in requires the proof-of-work check. Use `"none"` only where no browser is involved. |
| **Sign-in → Argon2 concurrency** | integer ≥ 1 | `2` | Password hashes computed at once. Each uses 64 MiB of memory. |
| **Sign-in → Argon2 queue** | integer ≥ 0 | `32` | Password hashes allowed to wait; beyond that, requests fail with `hash_busy`. |
| **Passkeys → Relying party ID** | hostname | unset | The hostname Passkeys are registered for, such as `crh.example.com`. |
| **Passkeys → Display name** | string | `"ClusterRightHand"` | Name shown by the authenticator. |
| **Passkeys → Allowed origins** | array of origins | unset | Origins allowed to use Passkeys, as `scheme://host[:port]` without a default port, for example `["https://crh.example.com"]`. |
| **Data retention → Tasks** | duration of at least `"1d"`, or `"off"` | `"90d"` | Finished tasks and task groups, and authorizations past their deadline. |
| **Data retention → Audit events** | duration of at least `"1d"`, or `"off"` | `"180d"` | Audit events; the most recent events are always kept. |
| **Data retention → Agent tool records** | duration of at least `"1d"`, or `"off"` | `"7d"` | Internal records of finished agent tool calls. |
| **Library defaults → Files for new users** | integer ≥ 0 | `256` | Files a new user library may hold. |
| **Library defaults → One file for new users** | integer ≥ 0 | `33554432` | Largest single file in a new user library, in bytes (32 MiB). |
| **Library defaults → Total size for new users** | integer ≥ 0 | `268435456` | Total size of a new user library, in bytes (256 MiB). |
| **Library defaults → Files for new groups** | integer ≥ 0 | `0` | Files a new user group library may hold; `0` allows none. |
| **Library defaults → One file for new groups** | integer ≥ 0 | `0` | Largest single file in a new user group library, in bytes. |
| **Library defaults → Total size for new groups** | integer ≥ 0 | `0` | Total size of a new user group library, in bytes. |
| **Chat attachments → Largest file to inline** | integer ≥ 0 | `32768` | Largest attachment whose text content is included in the message (32 KiB). |
| **Chat attachments → Most inlined per message** | integer ≥ 0 | `65536` | Most attachment text included over one message (64 KiB). |
| **Image cache → Cache size on disk** | integer ≥ 0 | `1073741824` | Image cache size on crhs's local disk (1 GiB). |
| **Image cache → Time to live** | duration | `"7d"` | Drop an image cache entry unused for this long. Must be greater than zero. |
| **Directory copies and skills → Most files in one directory copy** | integer ≥ 0 | `256` | Most files one `copy_file` with `recursive: true` copies into a library. |
| **Directory copies and skills → Most bytes in one directory copy** | integer ≥ 0 | `268435456` | Most bytes one directory copy takes (256 MiB). |
| **Directory copies and skills → Most skills listed per user** | integer ≥ 0 | `64` | Most skills a session's system prompt lists. A library with more `skills/<name>/SKILL.md` files lists none, and the prompt tells the model to browse `skills/` itself. |
| **Terminals → Enable terminals** | boolean | `true` | Whether terminals exist. Turning it off closes every terminal, hides the Terminals page and removes the agent tools from the next request. |
| **Terminals → Terminals per node** | integer ≥ 0 | `8` | Most terminals held on one node, opening, running or exited. |
| **Terminals → Terminals in total** | integer ≥ 0 | `64` | Most terminals held across all nodes. |
| **Terminals → Terminals per session** | integer ≥ 0 | `4` | Most terminals one session may have created or be associated with. |
| **Terminals → Longest agent idle timeout** | duration | `"1h"` | Largest idle timeout an agent's `pty_open` may ask for. |
| **Terminals → Longest watch timeout** | duration | `"10m"` | Longest `pty_watch` an agent may ask for. |
| **Terminals → Scrollback per terminal** | integer, 64 KiB..16 MiB | `1048576` | crha's ring buffer per terminal, in bytes (1 MiB). |
| **Jobs → Completion notice wakes** | integer ≥ 0 | `10` | Most times completion notices may wake a session since its last user-authored message. Past it, notices wait for the next tool result or the next user turn. `0` disables notice wakes. |
| **Jobs → Jobs per session** | integer ≥ 0 | `32` | Most unsettled jobs a session, or an API token over MCP, may have at once. A tool that would start another fails with `job_limit`. `0` allows no jobs. |
| **Metrics → Collect host metrics** | boolean | `true` | Whether crhs samples host metrics from its nodes. Turning it off stops the samples; stored metrics stay until retention removes them. |
| **Metrics → Sample interval** | `15`, `20`, `30` or `60` | `60` | Seconds between samples. A changed interval applies from the next tick. |
| **Metrics → Keep 1-minute buckets** | duration, at least 10 minutes | `"24h"` | How long 1-minute buckets are kept. |
| **Metrics → Keep 5-minute buckets** | duration, at least 50 minutes | `"7d"` | How long 5-minute buckets are kept. |
| **Metrics → Keep 1-hour buckets** | duration, at least 10 hours | `"30d"` | How long 1-hour buckets are kept. |
| **Metrics → Keep 1-day buckets** | duration, at least 10 days | `"365d"` | How long 1-day buckets are kept. |

In the **Metrics** group, each retention must be at least ten buckets of its
level and at least as long as the level before it.

The library defaults are copied when a user or user group is created; changing them does not touch an
existing library. Administrators change an existing library's limits on its user or user group page.

The attachment limits control what the agent sees directly in a chat message; the rest is described by
its library path, and the agent can copy it to a node to read. The image cache holds the bytes behind
`view_image` results in a disposable local directory, independent of the library backend and not backed
up; it counts toward no library's limits, evicts least recently used entries and drops entries unused for
the time to live.

A directory copy goes only into a library, from a node or another library; a larger directory, or one
bound for nodes, is packed into one archive on a node and copied as a file. Skills are directories under
`skills/` in a user's own library, each with a `SKILL.md` whose YAML frontmatter has `name` (the
directory's name, in kebab-case) and `description`.

Set **Passkeys → Relying party ID** and **Allowed origins** together, or leave both unset to take them from each
request's origin.

The retention sweep runs shortly after startup and then hourly. Each value is a duration of at least
`"1d"`, or `"off"` to keep records forever. Finished jobs follow **Data retention → Tasks**, but are kept at least
one day after they settle. Session conversations are not affected.

**Jobs → Completion notice wakes** caps how many times completion notices may wake an idle session since
the last message a user typed; the count is stored on the session, so a restart does not reset it. A
session that reaches its **Jobs → Jobs per session** limit of unsettled jobs refuses a tool that would
start another with `job_limit`, and an API token is limited the same way over MCP.

The terminal limits count a terminal from its open until it is closed, including the five minutes an
exited terminal stays visible. crha clamps **Terminals → Scrollback per terminal** to its own
64 KiB..16 MiB range; the setting itself is validated in that range, so what crhs asks for is what crha
keeps.

Each metric level's retention must be at least ten buckets of that level, and each level at least as long
as the one before it, so a read always has a coarser level to fall back to. Shortening a retention takes
effect at the next hourly sweep; a bucket is deleted only once it ended before its level's window.

Cleanup and the client address use the values read at the time they run. Logins can always use every
hashing slot, while password changes and user creation are held back, so signed-in users cannot block
others from signing in. If you raise **Sign-in → Argon2 concurrency** above 2, also raise the `UV_THREADPOOL_SIZE`
environment variable (default 4).

The client address is used for login rate limiting and the login captcha. If you set
**General → Real client IP header**, your reverse proxy must overwrite that header, and crhs must not be reachable
directly; otherwise clients can choose their own address. The `Forwarded` header is not supported.

## Unknown keys and errors

Unknown keys, keys in the wrong table, and values of the wrong type are errors. crhs prints
`crhs: <path>: <message>` and exits with code 2. A key written after a table header belongs to that
table, so a top-level key placed after `[database]` is reported as `database.<key>`.
