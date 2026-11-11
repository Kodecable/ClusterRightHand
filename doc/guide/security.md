# Security

This page is the security model for people who deploy and operate ClusterRightHand. It states what
is trusted, what is encrypted, how privilege is bounded, what the audit log does and does not
guarantee, and how to harden a deployment. It summarizes and links the full rules; the design
documents are authoritative.

## What crhs can and cannot do on a node

A task dispatched by crhs runs on a node under the identity that node gives it. That identity, not
"CRH", is the operating-system boundary.

| Node | Ordinary task (no `privileged`) | Privileged task |
|---|---|---|
| crha, `[privileged] mode = "forward"` | Runs as the unprivileged crha user. Files and commands are limited by that user's permissions. | Runs only with an authorization the privileged mode's trust configuration accepts. |
| crha, `mode = "native"` | Same as above. | crhs starts a temporary privileged helper through `sudo -n` or `doas -n`; the task runs as the target identity, subject only to crhs rules. |
| crha, `mode = "ignore"` | Same as above. | The flag is ignored; the task runs as the unprivileged crha user. If that user is root, this is root. |
| crha, `mode = "reject"` | Same as above. | Refused. |
| SSH | Runs as the SSH user, with no crha on the host. | The flag is ignored and the task runs as the SSH user. |

The consequences for an operator are:

- **On a crha node, crhs can do anything the task identity can do**: run commands, read and write
  files the identity can reach, send stdin, and look at the node's facts. It cannot open a PTY or a
  tunnel, and it has no standing shell; every action is a task with a record.
- **On a `forward` node, crhs cannot elevate on its own.** The privileged mode re-checks the
  authorization against its own `privileged.toml`, so a compromised crhs is limited to whatever the
  node's trust entries allow. A node that trusts only a user's key is not elevated by a compromised
  crhs.
- **On a `native` or `ignore` node, the node is not a privilege boundary.** crhs policy is the only
  gate, and a compromised crhs is equivalent to the identity the task runs as: the escalation target
  in `native`, the unprivileged identity in `ignore` (root if that user is root). `native` exists to
  obtain an identity non-interactively; it is not a security boundary. `ignore` is common when the
  unprivileged mode already runs as root.
- **On an SSH node, crhs holds the private key** in its encrypted secrets store. A compromised crhs
  can use it to log in as the SSH user and run anything that account can, with no node-side
  authorization. The key's custody is therefore part of the trust in crhs.
- **crhs cannot act on an offline node.** Tasks are not queued for later: a crha node that is not
  connected fails after the 30-second `NODE_OFFLINE_GRACE`, and an SSH node fails at once if it
  cannot be reached ([Node offline](../design/execution.md#node-offline)).
- **crhs has no interface to the privileged mode's local log, cannot change a node's `aliases`, and
  cannot revoke an authorization.** The log is a file on the node, not part of crhs's database; a
  task can read it only if the task identity may. The trust configuration lives on the node and is
  owned by its root. crhs can propose a `privileged.toml` fragment for you to paste, but it cannot
  apply it without an authorized `file.write`. There is no revocation list ([Revoking
  trust](../design/privilege.md#revoking-trust)).
- **A compromised crhs can alter its own database**, including the audit log, because the
  application's database account can write every row. It can also read its master key file and
  decrypt `secrets`, which holds the SSH credentials, model API keys, server identity key and
  authorization signing key. The audit limits are discussed under [Audit](#audit); the key custody
  under [Key management](#key-management).

The mode table and the exact behavior of each mode are in [Privilege
modes](../design/privilege.md#privilege-modes).

## Threat model

CRH protects the node channel and bounds privilege; it does not protect a host from its own local
users, and it does not defend against an administrator who abuses legitimate access.

| Attacker or event | Design goal |
|---|---|
| A network man-in-the-middle who eavesdrops, tampers or replays node traffic | No attack succeeds. The node channel is end-to-end encrypted inside TLS. |
| A third party that terminates TLS for the node channel (a reverse proxy, a CDN, a tunnel) | Sees only ciphertext and cannot inject a task. |
| A stolen enrollment token | The token is single-use, lives one hour, and its registration still needs an administrator's confirmation. |
| A compromised node | Sees only the tasks sent to it; cannot impersonate another node or decrypt another node's traffic. |
| A compromised crhs | Can send ordinary tasks to reachable nodes. On a `forward` node, privilege elevation is bounded by the node's trust configuration; `native` and `ignore` nodes give it the task identity. |
| Prompt injection, agent overreach or a stolen API token | Bounded by crhs rules and approvals and, for privileged tasks, by the node's trust configuration. |
| A person acting in the WebUI | Authenticated and authorized by node access; a manual action is not constrained by the agent's rule chain. |

**In-host threats are out of scope.** Other local users or processes attacking the privileged mode,
and forgery by a compromised unprivileged mode, are not defended against. That is why the unix
socket between the two crha modes is not encrypted, the privileged mode has no identity key, and the
trust report it returns is not signed. A forged request still cannot make the privileged mode execute
anything without a valid authorization. The reasoning is in [Threat model and
scope](../design/privilege.md#threat-model-and-scope).

The following are also outside the model or explicitly accepted:

- **The WebUI and MCP are TLS, not Noise.** A proxy that terminates TLS for the console or `/mcp`
  sees the passwords, session cookies, API tokens, task output and file content in plaintext. Only
  the crhs-to-crha channel has the second, end-to-end layer. The proxy must therefore be part of your
  trusted infrastructure.
- **Model providers see what the agent sends.** Prompts, tool results and file content sent to a
  model provider are not redacted. Use a provider you trust, and keep secrets out of prompts and
  files that the agent reads unnecessarily.
- **Node notes are untrusted input.** A note is ordinary Markdown on the node that anyone with write
  access can change; an agent that reads it can be influenced by it. Treat notes as data, not as
  instructions ([Prompt injection](../design/agent-runtime.md#prompt-injection)).
- **A malicious administrator is not defended against.** An administrator can manage users, nodes,
  tokens, model providers and access grants, and can read the audit log. The model assumes
  administrators are trusted.
- **Denial of service is not solved.** A client can consume request slots and a large task can
  consume node resources; rate limits and timeouts reduce the impact, not eliminate it.

## Authentication

### Passwords and login protection

Password login is the only login method. Passkeys are not a login factor; they sign privilege
authorizations inside the console after login ([Signing
methods](../design/privilege.md#signing-methods)). A login verifies the password against an Argon2id
PHC string with `m = 65536` KiB (64 MiB), `t = 3`, `p = 1`, a 16-byte salt and a 32-byte tag. The
parser rejects out-of-range parameters, and a stored hash with old parameters is rehashed on the
next successful login. Passwords are NFKC-normalized and at most 1024 characters; a new or changed
password must also be at least 8 characters. See [Password
hashing](../design/access-control.md#password-hashing).

Every hash, from every caller, passes through one process-wide gate. By default 2 hashes run and 32
wait; a full queue answers 503 `hash_busy` with `Retry-After: 1`. Login has priority over password
changes and user creation, so a signed-in user cannot take the last slot and deny every login. The
peak memory is about the concurrency times 64 MiB; see [`[auth]`](reference/crhs-config.md#auth).

Before any Argon2id work, a login is checked by two rate-limit keys: the client address and the
address plus the lowercased username. Ten failures in 15 minutes at either key answers 429
`rate_limited`. The limiter reserves the attempt before hashing, so a burst of concurrent requests
cannot all pass. Only one login per address may verify a password at a time (429
`login_in_progress`), and a request turned away by that check is not counted as a failure. A
successful login gives back its own reservation but leaves the failures that other usernames
caused on the same address, so successes cannot be interleaved to keep guessing. A limited attempt
is not audited, so brute force cannot fill the log. The details are in [Rate
limiting](../design/access-control.md#rate-limiting).

### Captcha

With the default `[auth] captcha = "cap"`, every password login first solves an invisible Cap proof
of work. The challenge is an HMAC-signed JWT that crhs keeps no state for and that lives two
minutes; its signing secret is generated per process, so a restart invalidates outstanding
challenges. The proof binds the client address, the username and the submitted password: the tag is
`base64url(SHA-256(username || 0x00 || password))`, and the scope is an HMAC over the address, the
username and that tag. A different password therefore needs a new challenge and a new proof, while a
replayed token only repeats the same guess. A failed proof is not a login failure and runs no
Argon2id. `captcha = "none"` disables the challenge endpoint and is intended only for a controlled
environment that cannot run a browser. See [Cap proof of
work](../design/access-control.md#cap-proof-of-work).

### Sessions and request forgery

A successful login creates a `crh_session` cookie that lasts seven days. The cookie is `HttpOnly`,
`SameSite=Strict`, and `Secure` except on a loopback host; the token is stored hashed. A state-changing
request must be JSON, and when it carries an `Origin` header the host must match the request's host.
A password change signs out the user's other web sessions; it does not revoke API tokens unless the
user asks for that. The session and CSRF rules are in
[Authentication](../design/access-control.md#login-rate-limiting-and-verification) and the reference
[`[auth]`](reference/crhs-config.md#auth).

### Accounts and roles

There are two user kinds: administrator and member. There are no fine-grained roles and no
self-service registration; administrators create accounts, reset passwords and disable users. A
disabled user cannot sign in, their web sessions end, their API tokens fail and their scheduled
tasks are disabled. An administrator cannot disable or demote themselves, and the server refuses a
change that would leave the organization without an active administrator. The capability split is in
[User types](../design/access-control.md#user-types).

### API tokens

An API token is a bearer credential for MCP and automation. It has the `crh_` prefix, is stored only
as a hash, belongs to its creator and acts on that user's behalf. It carries an expiry and can be
revoked; revoking it stops new requests at once and ends waiting work that belongs to it. A token is
the root of its own rule chain and is created with **Ask** or **Yolo** only. **Ask** sends everything
except ordinary reads to its owner; **Yolo** is unrestricted. A token is as sensitive as the user's
password within its rules, so give it an expiry, prefer **Ask**, and revoke it when the client or
laptop is retired. See [API tokens](../design/access-control.md#api-tokens) and [Using CRH as an MCP
server](mcp.md).

## Transport security

The full model, including the rejected alternatives, is in [Transport
security](../design/protocol.md#transport-security).

### Two layers

The crhs-to-crha channel has an outer and an inner layer:

| Layer | Mechanism | What it protects |
|---|---|---|
| Outer | WSS over TLS 1.3 | The network path and metadata. `tls_verify` is `system` (the default) or `none`. |
| Inner | Noise `Noise_IK_25519_ChaChaPoly_BLAKE2s` | End-to-end confidentiality and authentication, including through a TLS terminator. The prologue is the protocol's major-version prefix plus a 32-byte server challenge. |

`IK` means the client already knows the server's static public key, which it pinned at enrollment.
One round trip authenticates both sides and gives forward secrecy. A connection lives at most 24
hours; the client reconnects and performs a new handshake. Frames are at most 60 KiB, one frame per
WebSocket binary message. See [WSS and Noise](../design/protocol.md#wss-and-noise).

TLS alone would not be enough: whoever terminates TLS would see the plaintext and could inject a
`task.start`, which is equivalent to ordinary-user remote code execution on every node. The inner
channel prevents this. It is why `tls_verify = "none"` does not reduce security with a self-signed
certificate: the inner channel authenticates both sides. The outer certificate still matters for the
metadata and for clients that do not pin.

**The WebUI and MCP do not use Noise.** They are ordinary HTTPS APIs; their confidentiality depends
on the TLS connection between the browser or MCP client and crhs (or the proxy in front of it). A
TLS-terminating proxy for those endpoints is inside the trust boundary.

### Enrollment and fingerprints

Enrollment is the bootstrap that makes the pinning possible:

1. An administrator creates a one-time token in the WebUI. It has the form
   `crh1.<server-fingerprint>.<secret>`, is valid for one hour and is stored only as a hash of the
   secret.
2. `crha enroll` fetches `/agent/identity`, compares the returned server public key with the
   fingerprint embedded in the token, and pins it as `server.pub`. The fingerprint is
   `base64url(SHA-256(public key))`; compare the two strings exactly. The token alone bootstraps
   trust, as kubeadm's `--discovery-token-ca-cert-hash` does.
3. The node generates its own X25519 identity key and sends the token secret, hostname and facts in
   the first Noise message. The secret travels inside the Noise channel, so a TLS terminator never
   sees it, and a replayed first message finds the token already consumed.
4. The node enters `pending`. An administrator compares the hostname and the node's public-key
   fingerprint with the WebUI and approves it. The node key fingerprint is
   `base64url(SHA-256(public key))` too; `crha status` and the approval dialog show the same form.
   Only after approval does the node receive tasks; a rejected node's key is deleted.

Until approval, a pending node has a restricted connection: it may send `hello`, `ping` and
`facts`, receives an empty `welcome`, and is pushed only `node.status`. It receives no tasks and no
trust report. Approving pushes `node.status{active}` and closes the connection, so the node
reconnects with full permissions; rejection pushes `node.status{rejected}` and deletes the key. The
steps and the allowed messages are in [Node registration](../design/protocol.md#node-registration)
and [Restricted connections](../design/protocol.md#restricted-connections).

### Replay protection

The first Noise IK message can be replayed by an attacker who captures it. The attacker cannot
decrypt the following traffic without the client's ephemeral key, but without protection could make
crhs believe a node reconnected and displace the real connection. crhs therefore sends a fresh
32-byte challenge immediately after the WebSocket is established, and puts it in the Noise prologue:
the first message is valid only on the connection that carried its challenge. A timestamp or counter
scheme was rejected because a clock correction, a dead RTC battery or a disk rollback would lock a
node out. See [Handshake and replay
protection](../design/protocol.md#handshake-and-replay-protection).

### Rotation and revocation

- **Revoke a node** by deleting it on its page in the WebUI (**Delete node**), or by rejecting it
  while it is pending. Its public key is removed, the next handshake fails, and an established
  connection is closed after `node.status{rejected}`.
- **Replace a node key** by removing `identity.key` and `server.pub` from the node's state directory
  and enrolling again. `crha rotate-key` is present but does not change the key in this release. The
  procedure is in [Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys).
- **The server identity key and the authorization signing key cannot be rotated online.** There is no
  CLI or API to install a new key. The server loads the newest stored key at startup, so replacing a
  key by hand would be a manual database operation with no supported procedure. A compromise means
  treating the deployment as compromised and planning a rebuild ([Rotation and
  revocation](../design/protocol.md#rotation-and-revocation)).

## Privilege and trust

### The four modes

The mode is set in the unprivileged mode's `crha.toml` and reported to crhs; the default is
`reject`. The Linux identity is independent of the mode: **privileged means "needs an
authorization", not "runs as root"**.

| Mode | What it does | Who can run a privileged task | Use it when |
|---|---|---|---|
| `forward` | Forwards the task to the privileged mode over its unix socket. | The node's trust configuration. | You want a real privilege boundary and per-command limits. This is the only mode that provides one. |
| `native` | Starts `crha privileged stdio` with `sudo -n` or `doas -n`; that helper executes the task. | crhs policy only. | You trust crhs with the target identity and want non-interactive escalation with a short sudoers rule. Not a boundary. |
| `ignore` | Ignores the flag and runs the task as the unprivileged identity. | crhs policy only. | The unprivileged mode already runs as the identity you want (for example root), and you accept that crhs has it. |
| `reject` | Refuses every privileged task. | Nobody. | A node that must never elevate. This is the default. |

Choose `forward` for any node where a compromised crhs must not obtain the target identity. Its
cost is operational: a privileged daemon, a `privileged.toml` with trust entries, and a person or a
key available to authorize. Choose `native` when you trust crhs and accept that its policy is the
only gate; remember that sudoers sees only the helper, not the final command. Choose `ignore` only
when the unprivileged identity is already the one you want, such as a root-owned agent. Keep
`reject` for nodes that do not need privilege at all.

A failure to escalate (`native` missing a passwordless rule, a missing helper, a version mismatch)
fails the task with `privileged_unsupported`; it never falls back to unprivileged execution. `run0`
is experimental. See [Native mode](../design/privilege.md#native-mode).

### The privileged mode

The privileged mode is a second crha process. It does not use the network; it serves the
unprivileged mode over a unix socket and executes only tasks with a valid authorization. It distinguishes peers with
`SO_PEERCRED`: the configured `unprivileged_uid` submits tasks, and a uid in a `local` trust entry
may approve locally. It accepts at most 8 `forward` connections and gives every frame write a
10-second deadline.

Its `privileged.toml` is owned by the privileged mode's user and must not be writable by others.
**Editing it is itself a privileged task**: a `file.write` on the file followed by SIGHUP to the
privileged process. The write must pass an existing trust entry, so crhs cannot bypass it. The
recommended crhs trust entry denies `file.write /etc/crha/`, which leaves trust changes to a user
authorization or a local edit on the node. See [The privileged
mode](../design/privilege.md#the-privileged-mode).

### Trust configuration

All trust entries live in one `[[trust]]` array. `role` says who signs and `format` says how:

| `role` | Allowed `format` | Allowed `kinds` | Meaning |
|---|---|---|---|
| `crhs` | `sshsig` | `execute`, `cosign` | crhs's authorization signing key. |
| `user` | `sshsig`, `webauthn` | `execute`, `require-cosign` | A user's SSH key, FIDO hardware key or Passkey. |
| `local` | none (uses `uids`) | `execute` | Local approval with `crha approve` on the node. |

`execute` means "may authorize alone". `cosign` lets a `crhs` entry add a cosignature. `require-cosign`
on a user entry means every use of that user's authorization needs a crhs cosignature; a cosignature
can only come from a `role = "crhs"` entry with `cosign`, so users cannot cosign for each other.
crhs's two capabilities are independent: an entry with only `cosign` cannot authorize alone, and a
node with no crhs entry gives crhs no part in privileged tasks. The matrix and a full sample are in
[Trust configuration](../design/privilege.md#trust-configuration).

Each entry can carry:

| Field | Effect |
|---|---|
| `kinds` | `execute`, `cosign` or `require-cosign`, as above. |
| `max_ttl` | The longest `deadline - issued_at` accepted for a signature from this signer. |
| `require_exact` | Only `exact` command limits, no `prefix`. |
| `require_task` | The authorization must carry `task_ids`, making it one-shot for specific tasks. |
| `require_uv` | A WebAuthn signature must carry the user-verification flag. |
| `allow` / `deny` | Guard rules (below). |
| `env_allow` | The environment variables a task may set; `PATH` is always fixed. |

The defaults and validation rules are in [Trust entry
fields](../design/privilege.md#trust-entry-fields) and the [`privileged.toml`
reference](reference/privileged-config.md#trust-entry-fields).

**Guard rules** are a simple filter, not a policy engine: a rule names a method (`exec`,
`file.read`, `file.write`) and a `prefix`, a `regex` (RE2's common subset) or neither, which means
any target of the method. `deny` is checked before `allow`. `allow file.write` also allows reading
the same path (the privileged mode treats write as containing read), while `deny` matches only the
write; `file.stat` and `file.list` are `file.read`, and
`file.edit` is `file.write`. Rules do not inspect stdin or written content: allowing
`{ method = "exec", prefix = "bash" }` allows any script. Environment is restricted separately by
`env_allow`. See [Guard rules](../design/privilege.md#guard-rules).

**Aliases** are UUIDs the node accepts as its own address, usually its node-group UUIDs. They are
configured by the node's root; crhs cannot change them. A reusable authorization issued to a node
group is accepted only when the node's cached aliases contain that group; otherwise crhs fails the
task with `alias_missing`. A "superfluous alias" is a real privilege risk: the node accepts a
group-addressed authorization for a group it does not belong to. Read the warning on the node page
and fix the alias list. See [Trust aliases](../design/privilege.md#trust-aliases).

### Signing

Three signers can produce an authorization:

| Signer | Format | What is signed | Where |
|---|---|---|---|
| crhs | SSHSIG, `ssh-ed25519`, namespace `crh-auth-v1`, SHA-512 | The original CBOR payload bytes | Inside crhs, with a key encrypted by the master key. |
| A user's SSH key | SSHSIG (also `sk-ssh-ed25519@openssh.com` and ECDSA forms) | The same bytes | On the user's workstation, with `crha grant` (which calls `ssh-keygen -Y sign`) or `ssh-keygen` directly. |
| A user's Passkey | WebAuthn assertion | `SHA-256("crh-auth-v1\0" ‖ payload)` | The WebUI, with `@simplewebauthn/browser`. |

The payload is canonicalized with `CBOR-CORE-INT-v1`; an SSHSIG authorization can be checked by hand
with `ssh-keygen -Y verify`. `crha grant` has two forms: `--payload` signs the payload of a waiting
task, and `--nodes ... --method ... --prefix ... --deadline ...` builds a reusable authorization
from the command line. It prints a base64 `Authorization`: the `--payload` form is pasted into the
waiting card, and a reusable authorization is submitted through the API. The full formats and checks
are in [Signing methods](../design/privilege.md#signing-methods).

**A Passkey has a specific risk.** The page that shows the authorization is served by crhs, so a
compromised crhs can ask the user to sign something different from what the page displays. A Passkey
does not protect against that, and a Passkey entry is not treated as stronger than an SSH key.
`require_uv` makes user verification mandatory; it does not make the display trustworthy.

**Cosigning** is the four-eyes control. When a user entry has `require-cosign`, every use of that
user's authorization must also carry a `crhs` cosignature on the same payload. The cosignature
confirms exactly the same nodes, command, spec hash, task ids, attempt and deadline; there is no
second payload. A user authorization under such an entry cannot run without crhs's confirmation,
and the user cannot bypass crhs policy alone. Whether crhs can also authorize alone depends on its
own entry's `execute` capability. Only the role and the `cosign` capability are checked for the
cosignature; the crhs entry's other limits do not apply to it. See
[Cosigning](../design/privilege.md#cosigning).

**Local approval** is the on-node human path. A user with a uid in a `local` trust entry runs `crha
pending`, then `crha approve <task-id>` or `crha deny` over the privileged mode's socket. The
privileged mode shows the complete spec and `spec_sha256`, and the approval is bound to that hash, so
crhs cannot replace the spec after it was seen. Pending and approved records live in memory, do not
time out, and are for single tasks only; a task group does not use this path. See [Local
approval](../design/privilege.md#local-approval).

### Validation and the server's role

Every privileged `task.start` is validated by the privileged mode in nine steps: peer uid, path
rules, signature-to-trust matching, the authorization body, one-shot constraints, the command limit,
the trust entry's kinds/rules/environment, the cosignature, and finally the used-list write,
local log and execution. A refusal is returned before acceptance, so nothing executed and the same
task id may be retried with `attempt + 1`. The full order is in [Validation
flow](../design/privilege.md#validation-flow).

crhs's own planning is only a preview. It caches the trust reports nodes push and plans a path with
RE2 for the task's owner, then signs an authorization if a crhs entry can authorize alone; the
privileged mode re-verifies everything against its current configuration. A crhs planning mistake
can cause more waiting or a refusal, never extra privilege. See [Server-side
authorization](../design/privilege.md#server-side-authorization).

## Clocks and authorization deadlines

Two different settings matter; do not confuse them:

| Setting | File | Default | Meaning |
|---|---|---|---|
| `clock_warn` | `crhs.toml` and `crha.toml` | `60s` | Warn when the measured offset between the node and crhs exceeds this. The measurement happens once per handshake and produces a log line and a WebUI notice; it never refuses work. `0s` disables the warning. |
| `clock_skew` | `privileged.toml` | `60s` | The tolerance used when the node checks an authorization's `issued_at` and `deadline`. This is the setting the WebUI calls **Authorization clock tolerance**. |

- **NTP is required.** Authorization deadlines are written by the signer's clock and checked by the
  node's clock. The only tolerance is `clock_skew`. Run a time synchronization service on crhs and
  on every node, and monitor for offsets.
- A slow node clock keeps an expired authorization usable a little longer; a fast one may judge a
  fresh authorization as issued in the future or expire it quickly. The first is an in-host problem
  (whoever can change the node clock can already do more) and outside the threat model; the second
  only causes refusals, not extra privilege.
- The measured offset (the `clock_offset_ms` fact returned by `node_info`) is diagnostic. It is taken
  once per connection, not re-measured while the connection lasts, and the WebUI's **clock** warning
  uses `clock_warn`. It is not the authorization tolerance.
- **A clock rollback does not resurrect a one-shot authorization within the retention margin.** The
  used list is persisted before execution and kept until `deadline + max(1h, clock_skew)`. A longer
  rollback can outlive that record and make a one-shot authorization usable again, because the
  watermark is memory-only. There is no monotonic-maximum time; that was rejected because a clock
  that jumps forward and is corrected would lock privileged execution.
- Every authorization must carry a `deadline`. An authorization without one is refused
  (`authorization_expired`, "authorization has no deadline"), and crhs's own signature uses a
  five-minute deadline. A user signature wait expires after 24 hours.

The rules are in [Clock](../design/privilege.md#clock) and [Handshake and replay
protection](../design/protocol.md#handshake-and-replay-protection); the operational checks are in
[Clock synchronization](operations.md#clock-synchronization).

## Approvals and rule chains

crhs rules decide whether an actor may start a task. They are not a sandbox and not the same thing as
the node's trust configuration:

- On a `forward` node, both must allow: the crhs rule chain and the node's trust configuration.
- On `native`, `ignore` and SSH nodes, crhs rules are the only gate for a privileged task (and SSH
  ignores the flag).
- A **user acting in person** in the WebUI skips the rule chain; only node access is checked. The
  rule chain governs an agent, a schedule or an API token, not a person clicking **Run**.

The chain starts at a root that acts for a user:

| Scenario | Root |
|---|---|
| Session | The root session (each subagent is its own session, with its own rules). |
| Scheduled task | The schedule, which creates a session per run. |
| MCP | The API token. |
| Manual WebUI action | None; the user acts in person. |

The root's **rule preset** supplies its `default`:

| Preset | Rules | Consequence |
|---|---|---|
| **Ask** | Ordinary reads allowed; everything else, including every privileged task, requires approval. | The safe default for a new session or token. |
| **Auto Review** | The same rules, but a request that would go to the user first goes to the review model. | A model can approve a clearly safe operation; anything risky or uncertain escalates. Not available for API tokens. |
| **Yolo** | `default = allow`. | No approval. Use only where the node and the work justify it. |

The preset's rules come before the rules added on the root. A child session gets a full rule set and
can only tighten the level above; an `allow` at a lower level cannot widen a restriction. A rule set
has a `default`; each rule has an `action` (`allow`, `deny`, `require-approval`), an optional
`method`, optional `nodes`, and an optional `exact` or `prefix`. There is no `regex` on the crhs
side, because a rule runs on the event loop and may be written by an agent. `file.write` contains
`file.read` for `allow` only. Rules match the argv or normalized path, not the environment or working
directory: a rule allowing
`systemctl status` can still be used to run arbitrary code by setting `LD_PRELOAD` or `PATH`. This is
a deliberate trade-off and the reason a `forward` node with `env_allow` is the stronger isolation.
See [Rules](../design/access-control.md#rules) and [Environment and working
directory](../design/access-control.md#environment-and-working-directory).

**Approvals** are part of the task's state, not a separate table. A task stops in
`awaiting_approval`; the decision, decider, time, reason and each level's judgment are stored on it.
The request walks up the chain to the first ancestor whose effective result is `allow`, then to the
review model for Auto Review, then to the root's owner. A one-off decision writes no rule; only
**Approve and always allow…** appends an `allow` rule to the root's rule set. A rule change
re-judges every waiting task on that chain. An approval has no deadline; a signature wait expires
after 24 hours and ends with its session or run. An API token's revocation or expiry ends its waits.
A task group is approved once, and its members are judged per node. The routing and the group cases
are in [Approvals](../design/access-control.md#approvals).

## Access control

- **Nodes and node groups belong to the organization** and are managed by administrators. A user
  reaches a node through a node access grant to the user or to a user group. Grants are one level;
  there is no read-only node grant, because the rule chain and the node's trust configuration decide
  what may run.
- **Sessions belong to their creator.** A session can be shared with a user or a user group with
  `view` or `chat` access. A session acts as its owner: the agent's task is `on_behalf_of` the
  owner, and the session's own rules and the owner's node access apply. Schedules and API tokens are
  not shareable.
- **Administrators see more but do not silently take over.** An administrator sees every node,
  session and audit event, but another user's session is read-only by default: the administrator
  cannot change its rules or decide its approvals, may chat only after an explicit `chat` share,
  and can list and revoke shares but not create one.
- **Tasks are visible by relationship**, not by node access: a user sees their own tasks, an
  administrator sees all. A task on a node the viewer cannot access is still visible if the viewer
  is its owner or an administrator.
- **Every actor is recorded.** A task or audit event carries the actor (`user`, `api_token`,
  `session`, `subagent`, `schedule` or `system`) and, when an agent or token acts for a person, the
  `on_behalf_of` user. Permission checks start from that represented user.
- **There is one organization.** Users, nodes, sessions, tasks, schedules, tokens and audit events
  belong to it; there is no multi-tenancy or cross-organization boundary.

The rules are in [Ownership, access grants and
sharing](../design/access-control.md#ownership-access-grants-and-sharing), [User
types](../design/access-control.md#user-types) and [Actors](../design/access-control.md#actors).

## Audit

Every decision and action that matters is appended to `audit_events`: authentication, users and
groups, tokens, credentials, node enrollment and approval, node groups and access grants, SSH
credentials, task creation, approval, review and finish, authorizations issued and submitted, session
and tool calls, rules, schedules, providers and presets, and configuration changes. An
administrator sees every event; everyone else sees the events recorded on their behalf. The category
table is in [Recorded events](../design/access-control.md#recorded-events).

The audit log's guarantees are limited on purpose:

- It is **append-only in the application**: crhs adds rows and never updates or deletes a single
  event. It has **no hash chain**. A hash chain without a key can be recomputed from the modification
  point by anyone who can write the database; it would catch accidental edits but not a determined
  attacker, and it would make every append read the last row.
- The database uses **one application account** for migrations, installation and runtime. A
  compromised crhs — or anyone with that account — can alter any in-database check and any audit
  row. There is no in-database tamper evidence.
- The **node's privileged mode writes its own local log** (a JSONL file and journald) for every
  privileged task. A compromised crhs cannot delete or alter that record; tampering inside the host
  is outside the threat model. The local log records the complete spec and is refused if it cannot
  be written.
- **Retention** deletes records older than `[retention].audit` (180 days by default), except the
  newest 16384 sequence numbers, which are always kept. An authorization's `deadline` uses the tasks
  window (90 days by default).

The intended way to make the audit tamper-evident is to **export it to a trust domain outside
crhs**, such as syslog or a webhook. That is a reserved extension point, not a built-in feature in
this release: there is no export hook or CLI, so plan an external copy of the audit table (or a
database-level log shipping mechanism) if you need evidence that survives a compromised crhs. The
reasoning is in [Tamper resistance](../design/access-control.md#tamper-resistance).

Three smaller limits: model calls are not audit events (their tokens and timing are session
statistics), a local approval on the node has no crhs audit action (the privileged mode's local log
records it), and `crhs keys export` writes no audit event. The key export is a local command-line
operation and its safe handling is in [Key management](#key-management).

## Key management

| Key | Holder | Algorithm | Protects | If compromised |
|---|---|---|---|---|
| Master key | crhs, in `master_key_file` | 32-byte symmetric | The `secrets` table | Decrypts the server identity key, the authorization signing key, SSH private keys, model API keys and other secrets. |
| Server identity key | crhs, in `secrets` | X25519 | The Noise channel to every node | An attacker can impersonate crhs and send ordinary tasks to nodes; privilege is still bounded by node trust. |
| Authorization signing key | crhs, in `secrets` | `ssh-ed25519` | crhs authorizations and cosignatures | An attacker can authorize on nodes whose trust entries accept this key, within their limits. |
| Node identity key | crha, at `state_dir/identity.key` (0600) | X25519 | That node's Noise channel | An attacker can impersonate that node to crhs and receive its tasks. |
| SSH credential private key | crhs, in `secrets` | ed25519 | SSH node login | An attacker can log in as the SSH user on nodes that trust the key. |

crhs reads the master key from the file named by `master_key_file`; it is never written to the
database. At startup crhs refuses a key file that does not match the database (the database records
a non-secret HMAC identifier) and a file that is accessible by the group or by other users. The file
should be mode 0600 and owned by the crhs user.

**A database backup stores the server's private keys only in encrypted form**, so it cannot be
restored without the master key. The supported backup is a database backup **plus** a key export:

```sh
crhs keys export --out crhs-keys.age
crhs keys import crhs-keys.age     # on the rebuilt deployment, with its database
```

- The export is an ASCII-armored [age](https://age-encryption.org/) file encrypted with a passphrase
  and scrypt. The passphrase is read from the terminal twice, or as one line from stdin. The standard
  `age` tool can decrypt it.
- **The export contains private keys in plaintext inside the encrypted file**: the master key, the
  server identity private key and the authorization signing private key. It does not contain node
  identity keys, SSH credentials or user credentials. Treat the file and its passphrase as the
  highest-value secret in the deployment, keep them offline and separate from the database backup,
  and limit who can run the command. The export is local only: it is never available through the
  WebUI or the API.
- `crhs keys import` checks that the export belongs to the database and that every exported server
  key still has its row in `secrets`. A restore is a database backup plus the export; a node needs no
  export, because a lost node key means re-enrollment.
- `crhs keys init` writes the key file and only then binds the database to its identifier. A failure
  to write (for example because the file already exists) leaves the database untouched, and a
  database that already belongs to another key makes the command remove the file it just wrote.
- There is **no online rotation** for the server identity key or the authorization signing key, and
  `crha rotate-key` does not change a node key. Node revocation is deletion plus re-enrollment;
  replacing a server key means rebuilding the deployment and re-enrolling its nodes. Plan for it; do
  not assume a `rotate` command works.

The key formats, storage locations and export checks are in [Keys](../design/protocol.md#keys) and
[Key export](../design/protocol.md#key-export); the commands are in the [command-line
reference](reference/cli.md#crhs).

## Hardening checklist

Use this as a review list; the sections above explain each item.

**Network and TLS**

- [ ] Keep `listen.host` at its loopback default (`127.0.0.1`) and expose crhs only through a
  reverse proxy; change the bind only when the surrounding network is otherwise protected.
- [ ] Terminate TLS at the proxy with a certificate your clients trust. The WebUI, MCP and the login
  flow depend on it; Passkey registration also needs a hostname and a secure origin.
- [ ] Make the proxy **overwrite** `real_ip_header` (for example `X-Forwarded-For`). crhs takes the
  first non-empty element and has no trusted-proxy list; a client-supplied header would let anyone
  choose the address used for rate limiting and the captcha scope.
- [ ] Allow the MCP request-body size (about 85 MiB) if you use `write_file` or large `exec` stdin,
  and set a request timeout above the `wait` you expect.
- [ ] Remember that the proxy terminates TLS for the WebUI and MCP and therefore sees their
  plaintext. Only the crha channel has the inner Noise layer.

**Accounts and tokens**

- [ ] Create one administrator account for each person; do not share one. Disable accounts that
  leave, and reset their passwords.
- [ ] Prefer **Ask** for sessions and tokens. Use **Yolo** only where the node, the command and the
  network justify it, and say so in the token's name.
- [ ] Give every API token an expiry (30, 90 or 365 days) unless it is genuinely long-lived, and
  review the token list for unused or expired entries.
- [ ] Revoke a token when its client, laptop or integration is retired. A password change does not
  revoke tokens unless the box is ticked; do both for a compromised account.
- [ ] Review who reaches the administrator-only areas (**Authorizations**, **Users**, **Models**,
  **SSH credentials**) and who holds a token; the console hides those items from members, but an
  administrator account is the real key.

**Keys and backups**

- [ ] Keep the master key file at mode 0600, owned by the crhs user, outside the database backup.
- [ ] Take a key export with a strong passphrase and store it offline, separate from the database
  backup. Test a restore on a disposable deployment.
- [ ] Treat the export as private-key material: it contains the master key and the server's private
  keys. Restrict who can read it and who can run `crhs keys export`.
- [ ] Keep SSH credential private keys in crhs; an existing SSH node's credential cannot be changed,
  so replacing one means deleting the node through the API and adding it again.
- [ ] Plan for the absence of online server-key rotation: know which nodes trust crhs's current
  signing key, and plan a rebuild with re-enrollment if it is compromised.

**Nodes and privilege**

- [ ] Leave the default `reject` on nodes that do not need privilege.
- [ ] Use `forward` wherever a compromised crhs must not obtain the target identity; treat `native`
  and `ignore` as "crhs already has this identity".
- [ ] Give each trust entry the narrowest `kinds`, `allow`/`deny`, `max_ttl` and `require_*` that
  still work. Prefer `exact` where the command is fixed, and use `require_task` for one-shot use.
- [ ] Add `deny = [{ method = "file.write", prefix = "/etc/crha/" }]` to the crhs entry (and to other
  broad entries) so crhs cannot edit the trust configuration or crha's own files.
- [ ] Use `require_uv = true` for Passkey entries and `require-cosign` where a second party must
  confirm. Remember that a compromised crhs can still show a different payload to a Passkey signer.
- [ ] Keep `aliases` limited to the node groups the node actually belongs to; a superfluous alias
  accepts a group-addressed reusable authorization for a group the node is not in.
- [ ] Run NTP on crhs and every node, keep `clock_warn` enabled, and investigate **clock** warnings.
  Keep `clock_skew` small; it is the authorization tolerance.

**Rules and approvals**

- [ ] Review the rule presets on sessions and tokens; **Ask** is the safe default, and **Yolo** is a
  deliberate exception.
- [ ] Use **Approve and always allow…** sparingly and with an `exact` rule; a `prefix` rule that is
  too broad is a standing permission.
- [ ] Do not rely on crhs rules as a sandbox: they match argv and paths, not environment or working
  directory. For strong isolation, use a `forward` node with `env_allow` and narrow guard rules.
- [ ] Keep approvals human where the operation is destructive; an approval has no deadline, so a
  forgotten request waits rather than expiring quietly.

**Audit and monitoring**

- [ ] Ship the audit log to a system outside crhs, or plan to; the in-database log has no tamper
  evidence against a compromised crhs.
- [ ] Watch for `auth.login_failed`, `node.trust_changed`, `rules.changed`, `api_token.*` and
  `authorization.*` events, and for the node-side privileged log on each node.
- [ ] Keep the retention windows as intended and never delete the newest 16384 audit sequence
  numbers; that floor is what keeps the recent history continuous.
- [ ] Monitor disk, database size and task failures; a full disk stops privileged tasks on the node
  (no local log, no execution).

**Operations**

- [ ] Run one crhs process against one database. Connection, task and scheduler state live in memory;
  a second process against the same database is not a supported way to scale.
- [ ] Restart crhs for a configuration change; send SIGHUP only to the crha processes, each of which
  reloads its own file. An invalid file keeps the running configuration.
- [ ] Upgrade crhs and crha together within a major protocol version. Treat a stale `crha` as a
  security update risk, not only a compatibility one.
- [ ] Keep the reverse proxy, the database and the operating system patched; review the crhs logs
  after an upgrade and test a restore before you need one.
