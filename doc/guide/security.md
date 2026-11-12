# Security

## What crhs can do on a node

A task runs on a node under the identity the node gives it. That identity is the real boundary.

| Node | Ordinary task | Privileged task |
|---|---|---|
| crha, `forward` | Runs as the crha user | Runs only with an authorization the node's trust configuration accepts |
| crha, `native` | Runs as the crha user | Runs as the target identity through `sudo` or `doas`; only crhs rules apply |
| crha, `ignore` | Runs as the crha user | Runs as the crha user |
| crha, `reject` (default) | Runs as the crha user | Refused |
| SSH | Runs as the SSH user | Runs as the SSH user |

In practice:

- On a crha node, crhs can do anything the task identity can do. There is no shell or tunnel; every
  action is a recorded task.
- On a `forward` node, a compromised crhs cannot elevate beyond what the node trusts crhs for. A node
  that trusts only users' keys cannot be elevated by crhs at all.
- On `native` and `ignore` nodes, crhs effectively has the identity tasks run as. These modes are a
  convenience, not a boundary.
- For SSH nodes, crhs holds the private key, so a compromised crhs can log in as the SSH user.
- crhs cannot change a node's trust configuration, read the privileged mode's local log, or revoke an
  authorization.

## Threat model

| Threat | Protection |
|---|---|
| Network attacker between crhs and nodes | End-to-end encryption and authentication inside TLS |
| A proxy that terminates TLS for the node channel | Sees only ciphertext and cannot inject tasks |
| Stolen enrollment token | Single use, valid one hour, and an administrator must still approve the node |
| Compromised node | Sees only its own tasks; cannot impersonate other nodes |
| Compromised crhs | Can run ordinary tasks; privileged tasks on `forward` nodes are limited by the nodes' trust |
| Prompt injection, an overreaching agent, a stolen API token | crhs rules and approvals, and node trust for privileged tasks |

Not protected against:

- **Local users and processes on a node** attacking crha.
- **A TLS-terminating proxy in front of the WebUI and MCP.** Unlike the node channel, these are plain
  HTTPS, so the proxy sees passwords, cookies, tokens and task output. It must be trusted.
- **Model providers**, which see everything the agent sends them. Nothing is redacted.
- **Content the agent reads**, including node notes, which can try to steer it. The model is not a
  security boundary; rules and node trust are.
- **Malicious administrators.**
- **Denial of service.** Rate limits and timeouts reduce it but do not prevent it.

## Authentication

- **Passwords** are the only way to sign in. Passwords are hashed with Argon2id, and the number of
  concurrent hash computations is limited so that logins cannot exhaust memory
  ([System settings](reference/crhs-config.md#system-settings)).
- **Login protection.** Failed logins are limited per client address and per address and username
  (10 failures in 15 minutes). By default each login also solves an invisible proof-of-work captcha
  bound to the address, username and password. Set `captcha = "none"` only where no browser is used.
- **WebUI sessions** last seven days in an `HttpOnly`, `SameSite=Strict` cookie, `Secure` except on
  localhost. A password change signs out the user's other sessions; it revokes API tokens only if you
  choose to.
- **API tokens** are bearer credentials for MCP. They act for their owner within their own rules (Ask
  or Yolo). Give each token an expiry, prefer Ask, and revoke it when its client is retired.
- **Passkeys and SSH keys** are not login methods. They sign authorizations for privileged tasks.

## Transport security

The connection between crha and crhs has two layers: WebSocket over TLS, and inside it a Noise channel
that authenticates both ends and encrypts every message end to end. A proxy, CDN or tunnel that
terminates TLS sees only ciphertext. For the same reason `tls_verify = "none"` is acceptable with a
self-signed certificate: the Noise layer still authenticates crhs.

**Enrollment** bootstraps that trust. The enrollment token contains crhs's key fingerprint; `crha enroll`
checks crhs's key against it and pins the key. The node then appears as pending. Before approving it,
compare the hostname and the key fingerprint shown in the WebUI with `crha status` on the node. A
pending node receives no tasks.

**Revoking a node** means deleting it in the WebUI, which closes its connection and refuses its key.
To replace a node's key, re-enroll it from its page (`crha enroll` asks to re-enroll): the node keeps
its record and its access, and the old key stops authenticating at once.

crhs's identity key cannot be rotated online. If it is compromised, treat the deployment as compromised:
rebuild it and re-enroll the nodes with Re-enroll tokens, which keeps their records. The authorization
signing key is different: it can be rotated by adding a key, adding its public key to the nodes at
their own pace, then deleting the old one. Deleting a compromised signing key stops crhs using it at
once, but nodes still trust it until their `privileged.toml` no longer lists it.

## Privilege

### Choosing a privilege mode

| Mode | Choose it when |
|---|---|
| `reject` | The node never needs privileged tasks. This is the default. |
| `forward` | A compromised crhs must not obtain the target identity. This is the only mode that is a security boundary. It needs a privileged daemon, a trust configuration, and someone or something to authorize tasks. |
| `native` | You trust crhs with the target identity and want non-interactive escalation through sudo or doas. Sudoers sees only the crha helper, not the command. |
| `ignore` | crha already runs as the identity you want, for example root. |

A failed escalation fails the task; it never falls back to running unprivileged. Setup is described in
[Install](install.md) and the configuration in the [`privileged.toml` reference](reference/privileged-config.md).

### Trust configuration

On a `forward` node, `privileged.toml` lists who may authorize privileged tasks: crhs's signing keys,
users' SSH keys or Passkeys, and local users who approve with `crha approve`. Only the node's root can
change it. Changing it through CRH is itself a privileged task that needs an existing trusted signer, so
crhs cannot add itself.

- Give each entry the narrowest scope that works: guard rules for the commands and paths it may
  authorize, `require_exact` for fixed commands, a short `max_ttl`, and `require_task` for one-shot use.
- Deny crhs writes under `/etc/crha/`, so crhs cannot edit crha's configuration.
- Use `require-cosign` on a user entry when crhs's rules should also confirm every use of that user's
  signature.
- Guard rules match the command or path only, not input or file content: allowing `bash` allows any
  script. Use exact authorizations when the content matters.
- Keep `aliases` limited to the node groups the node actually belongs to. An extra alias lets the node
  accept authorizations meant for another group; the node page warns about it.

**Passkeys.** The page that asks you to sign is served by crhs, so a compromised crhs could show you one
thing and ask you to sign another. A Passkey is therefore not stronger than an SSH key here. Signing with
`crha grant` on your own workstation shows you the payload locally.

**Local approval.** A local approver sees the full task on the node with `crha pending`, and approves
exactly that task; crhs cannot change it afterwards.

## Clocks

| Setting | Where | Meaning |
|---|---|---|
| `clock_warn` | System settings (crhs), `crha.toml` | Warn when a node's clock differs from crhs's by more than this, measured once per connection. Warning only. |
| `clock_skew` | `privileged.toml` | Tolerance when a node checks an authorization's issue time and deadline. Shown in the WebUI as **Authorization clock tolerance**. |

Authorization deadlines are written by the signer's clock and checked by the node's, so run time
synchronization on crhs and every node. A wrong node clock causes refusals; a node clock set back far
enough can let an expired authorization be used again.

## Rules and approvals

crhs rules govern agents, schedules and API tokens; a person running a task in the WebUI needs only node
access. On a `forward` node, a privileged task must pass both crhs rules and the node's trust.

crhs rules are not a sandbox. They match the command or path, not the environment: a rule allowing
`systemctl status` can be abused by setting `LD_PRELOAD`. Use a `forward` node, whose trust entries
restrict the environment, where isolation matters. Use **Approve and always allow** sparingly, with
exact rules where possible: a broad prefix rule is a standing permission.

## Audit

crhs records authentication, user and node management, tasks, approvals, authorizations, sessions, tool
calls and configuration changes. Its guarantees are limited:

- The log is append-only in crhs but has no tamper evidence: anyone who controls crhs or its database
  can change it. Copy it to a system outside crhs if you need evidence that survives a compromise; there
  is no built-in export.
- On each `forward` node, the privileged mode keeps its own log of every privileged task, which crhs
  cannot change. If that log cannot be written, the task is refused.
- Local approvals and `crhs keys export` are not in the crhs audit log.

## Key management

| Key | Where | If compromised |
|---|---|---|
| Master key | `master_key_file` on the crhs host | Decrypts every secret crhs stores |
| crhs identity key | Encrypted in the database | Impersonates crhs to nodes; can run ordinary tasks |
| crhs signing key | Encrypted in the database | Authorizes privileged tasks on nodes that trust crhs, within their limits |
| SSH credential keys | Encrypted in the database | Logs in to SSH nodes |
| Node key | `identity.key` in the node's state directory | Impersonates that node |

The master key file must be readable only by the crhs user; crhs refuses to start otherwise. A database
backup alone cannot be restored, because the keys in it are encrypted. Back up the database together
with a key export (`crhs keys export`), and keep the export and its passphrase offline and separate from
the database backup: it contains crhs's private keys. See [Backups and restore](operations.md#backups-and-restore).

## Hardening checklist

**Network**

- [ ] Keep crhs listening on loopback and expose it through a reverse proxy with TLS.
- [ ] If you set `real_ip_header` in **System settings**, make the proxy overwrite that header;
  otherwise clients choose the address used for rate limiting.
- [ ] Treat the proxy as trusted: it sees WebUI and MCP traffic in plain text.

**Accounts and tokens**

- [ ] One account per person; disable accounts of people who leave.
- [ ] Prefer Ask for sessions and tokens; use Yolo only deliberately.
- [ ] Give API tokens expiries, review them, and revoke unused ones.

**Keys and backups**

- [ ] Keep the master key file at mode 0600.
- [ ] Keep a key export offline, separate from database backups, and test a restore.

**Nodes**

- [ ] Leave `reject` on nodes that do not need privilege; use `forward` where crhs must not hold the
  identity.
- [ ] Keep trust entries narrow, deny crhs writes under `/etc/crha/`, and keep aliases accurate.
- [ ] Run time synchronization everywhere and investigate clock warnings.

**Audit and operations**

- [ ] Copy the audit log outside crhs if you need tamper evidence.
- [ ] Watch for failed logins, trust changes, rule changes, token and authorization events.
- [ ] Upgrade crhs and crha together, and keep the proxy, database and operating systems patched.
