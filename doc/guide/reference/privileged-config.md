# Privileged mode configuration reference

`privileged.toml` configures the privileged mode (`crha privileged run --config <path>`) of a `forward`
node: its identity, its paths, and who may authorize privileged tasks. How authorizations are checked is
described in [Privilege and authorization](../../design/privilege.md).

## Configuration file

The file must be owned by the user the privileged mode runs as and must not be writable by group or
others; otherwise the privileged mode refuses it. Unknown keys and duplicate entry names are errors.

`SIGHUP` reloads the file. A file that fails to load leaves the current configuration in place. Changes
to `socket`, `socket_group`, `state_dir` and `log` need a restart.

Editing this file through CRH is itself a privileged task, which an existing trusted signer must
authorize. Deny crhs writes under `/etc/crha/` so that crhs cannot change whom the node trusts.

Durations use Go syntax (`"60s"`, `"5m"`, `"24h"`); there is no day unit.

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `node_id` | UUID | required | The node's id, as printed by `crha enroll`. |
| `aliases` | array of UUIDs | empty | Other ids the node answers to, usually the UUIDs of its node groups, so that authorizations for those groups apply here. Keep it to the groups the node actually belongs to. |
| `unprivileged_uid` | integer | required | The uid of `crha run`. Only this uid may submit tasks. |
| `socket` | path | required | The socket to listen on; must match `[privileged].socket` in `crha.toml`. |
| `socket_group` | group name | `"crha"` | Group of the socket, so that `crha run` can connect. |
| `state_dir` | path | required | Directory for the record of executed tasks, which prevents replays. |
| `log` | path | required | Log of every accepted and refused task (JSON lines, also written to standard error). It is not rotated automatically. |
| `clock_skew` | duration | `"60s"` | Tolerance when checking an authorization's issue time and deadline. Shown in the WebUI as **Authorization clock tolerance**. |

## Trust entries

Each `[[trust]]` table names one signer:

| `role` | `format` | `kinds` | Signer |
|---|---|---|---|
| `crhs` | `sshsig` | `execute`, `cosign` | crhs's signing key, shown on the node page in the WebUI |
| `user` | `sshsig` or `webauthn` | `execute`, `require-cosign` | A user's SSH key, FIDO key or Passkey |
| `local` | none | `execute` | Local users who approve with `crha approve` |

- `execute`: may authorize a task alone.
- `cosign`: crhs may confirm user authorizations that require it.
- `require-cosign`: this user's authorizations also need crhs's confirmation.

Without a `crhs` entry, crhs cannot authorize anything on this node. Without a `local` entry, nobody can
approve locally, not even root. The WebUI's **Credentials** page and node page produce ready-made
entries.

## Trust entry fields

| Field | Applies to | Meaning |
|---|---|---|
| `name` | all | A unique local name. |
| `role` | all | `crhs`, `user` or `local`. |
| `format` | `crhs`, `user` | `sshsig` or `webauthn`. |
| `key` | `sshsig`, `webauthn` | For `sshsig`, one `authorized_keys` line without options (Ed25519, ECDSA P-256, or their `sk-` FIDO forms). For `webauthn`, `cose:` and the base64url public key. |
| `credential_id`, `rp_id`, `origins` | `webauthn` | The Passkey's credential id, relying-party id and allowed origins. |
| `uids` | `local` | The uids that may approve. |
| `kinds` | all | See above. |
| `max_ttl` | all | Longest accepted lifetime of an authorization. |
| `require_exact` | all | Accept only exact command authorizations, not prefixes. Recommended for crhs. |
| `require_task` | `user` | Accept only one-shot authorizations for specific tasks. (crhs authorizations are always one-shot.) |
| `require_uv` | `user` | Require user verification (PIN or biometric). Needs a Passkey or an `sk-` key. |
| `allow`, `deny` | all | [Guard rules](#guard-rules). |
| `env_allow` | all | Environment variables a task may set. `PATH` is always fixed. |

`max_ttl`, `require_exact`, `allow` and `deny` limit what an entry may authorize; they do not apply when
crhs only cosigns a user's authorization.

## Guard rules

```toml
allow = [
  { method = "exec",       prefix = "systemctl restart " },
  { method = "exec",       regex  = "apt-get (update|upgrade -y)" },
  { method = "file.write", prefix = "/etc/nginx/" },
]
deny = [{ method = "file.write", prefix = "/etc/crha/" }]
```

- `method` is `exec`, `file.read` or `file.write`. An allowed `file.write` also allows reading.
- `prefix` matches targets starting with the string; `regex` (RE2, at most 1000 bytes) must match the
  whole target; with neither, the rule matches every target of its method.
- For `exec`, the target is the command line, and shell commands appear as `/bin/sh -c '…'`, so a
  prefix rule for a command does not match a shell script.
- `deny` is checked first. If `allow` is not empty, one of its rules must match.
- Rules see only the command or path, not input or file content.
- Use only regular expression features that both Go and RE2 support: no lookaround or backreferences.

## Examples

**crhs may run a few commands on its own:**

```toml
node_id          = "0192f000-0000-7000-8000-000000000001"
unprivileged_uid = 998
socket           = "/run/crha/privileged.sock"
state_dir        = "/var/lib/crha/privileged"
log              = "/var/log/crha/privileged.jsonl"

[[trust]]
name          = "crhs"
role          = "crhs"
format        = "sshsig"
key           = "ssh-ed25519 AAAA… crhs-signing"
kinds         = ["execute"]
require_exact = true
max_ttl       = "5m"
allow = [
  { method = "exec",       prefix = "systemctl restart " },
  { method = "file.write", prefix = "/etc/nginx/" },
]
deny = [{ method = "file.write", prefix = "/etc/crha/" }]
```

**Only a user may authorize**, for `apt-get` commands, for at most a day:

```toml
[[trust]]
name    = "alice"
role    = "user"
format  = "sshsig"
key     = "ssh-ed25519 AAAA… alice@laptop"
kinds   = ["execute"]
max_ttl = "24h"
allow   = [{ method = "exec", prefix = "apt-get " }]
```

**A user's Passkey, confirmed by crhs every time:**

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
key    = "ssh-ed25519 AAAA… crhs-signing"
kinds  = ["cosign"]
```

**Local approval by root and uid 1000:**

```toml
[[trust]]
name  = "local-admins"
role  = "local"
uids  = [0, 1000]
kinds = ["execute"]
```
