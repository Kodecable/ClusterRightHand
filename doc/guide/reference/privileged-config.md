# Privileged mode configuration reference

`crha privileged run` reads one TOML file, `privileged.toml`, named with `--config`. It contains the
node's identity, the local paths of the privileged mode, and the trust entries that decide which
authorizations may run a privileged task. This page lists every key and field with its validation
and default. The rules that use the configuration — the role matrix, the validation steps, cosigning
and the used list — are in [Privilege and authorization](../../design/privilege.md); this page does
not repeat them.

## Configuration file

```sh
crha privileged run --config /etc/crha/privileged.toml
```

`--config` is required. There is no built-in path: the file can live anywhere, and the unprivileged
mode learns the socket path from its own [crha.toml](crha-config.md#privileged), not from this file.
`crha privileged stdio` reads no configuration file at all.

The file must be owned by the user that runs the privileged mode and must not be writable by group
or others. The process checks the owner and the permission bits when it loads the file and refuses
one that fails:

```text
privileged config: /etc/crha/privileged.toml: owned by uid 0, but the privileged mode runs as uid 998
privileged config: /etc/crha/privileged.toml: mode 0664 is group- or world-writable
```

Unknown fields are errors, at the top level and inside a `[[trust]]` entry, and so are duplicate
trust entry names. A file that does not load stops `crha privileged run` at startup.

`SIGHUP` re-reads the file. A file that does not load keeps the running configuration and is
recorded in the local log; a file that loads replaces it. When the trust summary's digest changed,
every connected unprivileged mode receives a fresh `trust.summary`; established connections are not
closed, even when their peer uid is no longer in a local trust entry. Changes to `socket`,
`state_dir` and `log` are accepted but only take effect after a restart, which the process logs;
`socket_group` is applied when the socket is created, so a change to it also needs a restart.
Editing the file is itself a privileged task: a `file.write` followed by SIGHUP, authorized by an
existing trust entry. The recommended crhs entry denies `file.write` below `/etc/crha/` so that crhs
cannot rewrite the trust configuration on its own. See
[The privileged mode](../../design/privilege.md#the-privileged-mode).

A `groups` key is rejected with a hint rather than treated as a generic unknown key:

```text
groups is no longer supported; use aliases = ["<node group uuid>", ...] (the WebUI shows node group UUIDs)
```

The top-level keys `node_id`, `unprivileged_uid`, `socket`, `state_dir` and `log` are required;
`aliases`, `socket_group` and `clock_skew` are optional; `trust` may be empty, in which case the
node can run no privileged task and reports an empty trust summary.

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `node_id` | UUID string, required | none | The node's id, in canonical lowercase UUID form (`0192f000-0000-7000-8000-000000000001`). Uppercase, names, `*` and `group:` are rejected. It is reported in the trust summary and used to decide whether an authorization is addressed to this node. |
| `aliases` | array of UUID strings | empty | Additional authorization addresses. An authorization is addressed to this node when its payload `nodes` contains `node_id` or any alias. Each alias must be a canonical lowercase UUID and may appear only once. Usually the node group UUIDs the node belongs to; the WebUI shows a node group's UUID for copying. crhs cannot change the list. See [Trust aliases](../../design/privilege.md#trust-aliases). |
| `unprivileged_uid` | integer 0–4294967295, required | none | The uid of the unprivileged mode. A task submission over the socket is accepted only when `SO_PEERCRED` reports this uid; a local approval needs a uid from a `local` trust entry. The value is reported as the unprivileged identity in the trust summary. |
| `socket` | absolute path string, required | none | Unix socket the privileged mode listens on. Created with mode 0660 and the group from `socket_group`. A stale socket at the path is removed; any other kind of file there is refused rather than deleted. |
| `socket_group` | group name string | `"crha"` | Group given to the socket so the unprivileged mode can connect. A group that does not exist, or a `chown` the running user may not perform, is a warning, not a startup failure: the socket keeps the running user's group and an administrator can create the group and restart. |
| `state_dir` | absolute path string, required | none | Directory of the used list, at `<state_dir>/used`. Created with mode 0700 when missing. The used list records every executed task and is written before execution; see [Used list](../../design/privilege.md#used-list). |
| `log` | absolute path string, required | none | Local JSON-lines log. The file is created with mode 0600 and its parent directory with mode 0750; each record is also written to stderr, which journald collects. Every accepted task is logged with its full spec, and every refusal with the step and error code. |
| `clock_skew` | duration string | `"60s"` | Tolerance applied to `issued_at` and `deadline` of an authorization. Must not be negative; `"0s"` means no tolerance. It also extends how long a used record is kept: until `deadline + max(1h, clock_skew)`. This is not the warning threshold `clock_warn` of [crha.toml](crha-config.md#top-level-keys). See [Clock](../../design/privilege.md#clock). |

Durations use Go's duration syntax (`"60s"`, `"5m"`, `"24h"`, `"1h30m"`); there is no `d` unit, so
seven days is `"168h"`.

## Trust entries

All trust entries live in one array. Each `[[trust]]` table is one signer. `role` selects the kind
of signer and `format` the signature form:

| `role` | Allowed `format` | Allowed `kinds` | Meaning |
|---|---|---|---|
| `crhs` | `sshsig` | `execute`, `cosign` | crhs's authorization signing key. `execute` lets crhs authorize alone; `cosign` lets it cosign a user authorization that requires it. |
| `user` | `sshsig`, `webauthn` | `execute`, `require-cosign` | A user's SSH key, FIDO hardware key or Passkey. `require-cosign` makes every use of this user's authorization need a crhs cosignature. |
| `local` | none (uses `uids`) | `execute` | Local approval on the node with `crha approve`; no key and no signature. |

A configuration may have no entry for a role. With no `crhs` entry, crhs takes no part in privileged
tasks; with no `local` entry, nobody can approve locally, root included.

Each entry needs a unique `name`. The name is local to the node: crhs matches entries by public key
or credential id, not by name. When several entries contain the same public key or credential id, a
signature matches the first of them in file order. The trust summary reports every entry with
`source = "local"`.

## Trust entry fields

| Field | Applies to | Type and default | Meaning |
|---|---|---|---|
| `name` | all, required | string | Local name of the entry; must be unique in the file. |
| `role` | all, required | `"crhs"`, `"user"` or `"local"` | Selects the signer type. |
| `format` | `crhs`, `user` | `"sshsig"` or `"webauthn"` | `crhs` accepts `sshsig` only. `user` accepts either. A `local` entry must omit `format`; setting one is an error. |
| `key` | `sshsig`, `webauthn` | string | For `sshsig`: exactly one `authorized_keys` line. Options such as `command=` or `cert-authority` are refused, a trailing comment is kept and reported. Supported types are Ed25519, ECDSA P-256 and their `sk-*` variants. For `webauthn`: `cose:` followed by the base64url COSE public key. A `local` entry must not set `key`. |
| `credential_id` | `webauthn`, required | base64url string | The Passkey credential id, with or without padding. Rejected on other entry types. |
| `rp_id` | `webauthn`, required | string | The relying-party ID the credential was registered for. Rejected on other entry types. |
| `origins` | `webauthn`, required | array of origin strings | At least one `scheme://host[:port]` origin, `http` or `https`, without a path, query, fragment or userinfo. Rejected on other entry types. |
| `uids` | `local`, required | array of integers | The uids allowed to approve locally; at least one. Duplicates are ignored. Rejected on other entry types. |
| `kinds` | all, required | array of strings | `crhs`: `execute`, `cosign`. `user`: `execute`, `require-cosign`. `local`: `execute` only. Duplicates are rejected. |
| `max_ttl` | all, optional | duration string | Requires `deadline - issued_at ≤ max_ttl`. Must be positive. Without it there is no extra limit, but every authorization still carries a `deadline`. |
| `require_exact` | all, optional | boolean, default `false` | When an authorization matches this entry, it must use `exact` matching rather than `prefix`. Used mainly on the `crhs` entry. |
| `require_task` | `user`, optional | boolean, default `false` | Accepts only one-shot authorizations that carry `task_ids`. A `crhs` entry always requires `task_ids`; setting `require_task = false` on it is an error, and `true` is accepted. A `local` entry must not set the field. |
| `require_uv` | `user`, optional | boolean, default `false` | Requires the WebAuthn user-verification flag, or for an `sshsig` entry the UV flag of an `sk-*` key signature. A plain SSH key cannot assert UV, so `require_uv = true` with a non-`sk-*` key is a configuration error. Not allowed on `crhs` or `local` entries. |
| `allow` / `deny` | all, optional | arrays of guard rules, default empty | Method and target restrictions; see [Guard rules](#guard-rules). An empty `allow` accepts any target of the allowed methods. |
| `env_allow` | all, optional | array of names, default empty | Environment variable names a task may carry. `PATH` is fixed by the privileged mode and is refused; a name that is empty or contains `=` or NUL is refused. Duplicates are ignored. |

`require_exact`, `max_ttl`, `allow` and `deny` are checked when the entry authorizes a task. They do
not apply to a cosignature: a `role = "crhs"` entry with `kinds = ["cosign"]` only needs to have the
`cosign` capability. See [Cosigning](../../design/privilege.md#cosigning).

## Guard rules

`allow` and `deny` are lists of simple filter rules. A rule is written as
`{ method = "exec", prefix = "systemctl restart " }` or `{ method = "exec", regex = "apt-get (update|upgrade -y)" }`.

| Field | Required | Meaning |
|---|---|---|
| `method` | yes | `exec`, `file.read` or `file.write`. A `file.write` rule also covers `file.read` for `allow`. |
| `prefix` | one of `prefix`, `regex`, or neither | Matches every target that starts with this string. It is sugar for `^<quoted prefix>.*$`. |
| `regex` | one of `prefix`, `regex`, or neither | RE2 pattern with an implicit full match (`^(?:…)$`). At most 1000 bytes and must compile on its own; an unbalanced pattern such as `a)\|(b` is a configuration error. |

A rule without `prefix` and without `regex` matches any target of its method. `prefix` and `regex`
are mutually exclusive. Evaluation checks `deny` first and rejects on any hit; when `allow` is not
empty, one of its rules must match. A `file.write` rule covering `file.read` holds for `allow` only:
a `deny` `file.write` rule matches writes only. Rules constrain the method and the target, not stdin
or the written content; use an `exact` authorization when the content must be constrained.

`regex` should use only the subset that Go's `regexp` and C++ RE2 share: character classes, `(?i)`
and `\p{Latin}` are fine; lookaround, backreferences, `\C`, `\p{Script=…}`, `\Z` and `\h` are not.
The privileged mode (Go) is the final authority; crhs only previews, and a pattern it cannot compile
is treated conservatively. The full rule semantics are in
[Guard rules](../../design/privilege.md#guard-rules).

## Examples

**A crhs-only node.** The complete file. crhs may authorize alone (with `exact` authorizations only)
or cosign. Authorizations last at most five minutes and cover only the listed commands; crhs cannot
write the trust configuration.

```toml
node_id          = "0192f000-0000-7000-8000-000000000001"
aliases          = ["0192f000-0000-7000-8000-0000000000a1"]
unprivileged_uid = 998
socket           = "/run/crha/privileged.sock"
socket_group     = "crha"
state_dir        = "/var/lib/crha/privileged"
log              = "/var/log/crha/privileged.jsonl"
clock_skew       = "60s"

[[trust]]
name          = "crhs"
role          = "crhs"
format        = "sshsig"
key           = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… crhs-signing"
kinds         = ["execute", "cosign"]
require_exact = true
max_ttl       = "5m"
allow = [
  { method = "exec",       prefix = "systemctl restart " },
  { method = "exec",       regex  = "apt-get (update|upgrade -y)" },
  { method = "file.read",  prefix = "/var/log/" },
  { method = "file.write", prefix = "/etc/nginx/" },
]
deny = [
  { method = "file.read",  regex  = "/etc/(shadow|gshadow|sudoers.*)" },
  { method = "file.write", prefix = "/etc/crha/" },
]
```

**A user-only node.** No crhs entry: crhs cannot authorize any privileged task. Only Alice's SSH key can, for `apt-get`
commands, for at most 24 hours per authorization.

```toml
[[trust]]
name    = "alice"
role    = "user"
format  = "sshsig"
key     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… alice@laptop"
kinds   = ["execute"]
max_ttl = "24h"
allow   = [{ method = "exec", prefix = "apt-get " }]
```

**A cosign-required node.** Every use of Alice's Passkey authorization needs a crhs cosignature. The crhs entry has only the
`cosign` capability, so crhs cannot authorize a task alone; the user's authorization cannot bypass
crhs either. Both signatures cover the same payload.

```toml
[[trust]]
name          = "alice-passkey"
role          = "user"
format        = "webauthn"
rp_id         = "crh.example.com"
origins       = ["https://crh.example.com"]
credential_id = "pQ7…"
key           = "cose:o2NrdH…"
kinds         = ["execute", "require-cosign"]
require_uv    = true

[[trust]]
name   = "crhs-cosign"
role   = "crhs"
format = "sshsig"
key    = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… crhs-signing"
kinds  = ["cosign"]
```

**A local-approval node.** uid 0 and uid 1000 may approve a waiting task on the node with `crha pending` and `crha approve`;
no key is involved. Root is not trusted implicitly: only the uids listed here may approve.

```toml
[[trust]]
name  = "local-admins"
role  = "local"
uids  = [0, 1000]
kinds = ["execute"]
```

A task approved locally still needs a `local` entry whose guard rules allow its method and target;
with no `allow` rules, any target of the allowed methods is accepted. See
[Local approval](../../design/privilege.md#local-approval).
