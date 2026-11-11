# Operations

This page covers the day-two work on a running deployment: services and signals, configuration
reloads, upgrades, backups, logs, retention, node keys, clocks and the database choice. It ends with
the failure modes you are most likely to meet. Installation itself is in
[Installing ClusterRightHand](install.md).

## Service management

A deployment has one `crhs` process and, on each crha node, one or two `crha` processes: the
unprivileged mode always, and the privileged mode when `[privileged].mode = "forward"`. Example
systemd units for all three are in [Run as a service](install.md#run-as-a-service); this section
covers what the processes do when you signal them.

```sh
sudo systemctl status crhs crha crha-privileged
sudo systemctl restart crhs
sudo systemctl reload crha            # ExecReload sends SIGHUP
sudo systemctl restart crha crha-privileged
```

- **crhs.** `SIGTERM` and `SIGINT` start a graceful shutdown: crhs stops accepting requests, ends
  open streams and waits for in-flight work, then closes the database. It allows 10 seconds; after
  that it exits 1, and a second signal during shutdown also exits 1. There is no reload signal:
  `systemctl restart crhs` applies a configuration edit. Do not send `SIGHUP` to crhs; it is not
  handled, and the default action terminates the process.
- **crha, unprivileged mode.** `SIGTERM` and `SIGINT` stop it gracefully. `SIGHUP` re-reads
  `crha.toml`; see [Reloading configuration](#reloading-configuration).
- **crha, privileged mode.** `SIGTERM` and `SIGINT` stop it gracefully. `SIGHUP` re-reads
  `privileged.toml` and, when the trust digest changed, pushes a new trust summary to crhs.

Run one `crhs` process against one database. Connection, task and scheduler state live in memory, so
a second process against the same database is not a supported way to scale.

## Reloading configuration

Each process reads its own file. There is no cross-process reload and no `crha reload` command; a
service manager sends the signal, usually through `ExecReload=/bin/kill -HUP $MAINPID`.

| Process | File | Signal | What a reload changes |
|---|---|---|---|
| `crhs serve` | `crhs.toml` | none | Nothing. Restart the process. |
| `crha run` | `crha.toml` | `SIGHUP` | `server` and `tls_verify` reconnect; `notes` re-reports facts. Everything else needs a restart. |
| `crha privileged run` | `privileged.toml` | `SIGHUP` | Trust entries, aliases, `clock_skew` and guard rules apply to the next decision; a changed digest is pushed to crhs. |

An invalid new file is not applied: the process keeps the running configuration and logs
`reload failed, keeping the current configuration`. For `crha run`, a changed `state_dir`,
`clock_warn`, `[output]` or `[privileged]` is accepted into the configuration but only takes effect
after a restart, and the process logs a warning naming those keys. For `crha privileged run`, a
changed `socket`, `state_dir` or `log` also needs a restart; a changed `socket_group` is accepted but
is only applied when the socket is created, so restart the process to change the socket's group.

```sh
sudo systemctl reload crha
sudo systemctl reload crha-privileged
# without a unit (both crha processes; each reloads its own file):
sudo pkill -HUP -x crha
```

On a `forward` node, editing `privileged.toml` is itself a privileged task: a `file.write` on the
file, then a reload of the privileged process. The recommended crhs trust entry denies writes under
`/etc/crha/`, so the edit needs a user authorization or a local edit on the node. See [Reload and
upgrade](../design/execution.md#reload-and-upgrade).

## Upgrades

There are no packages and no self-upgrade command. An upgrade is: stop the service, update the
source or binary, rebuild what changed, start it again. Schema migrations run automatically at the
start of the next `crhs` command.

`crhs` and `crha` must be upgraded together within a protocol major version. The current protocol
major is 3. A peer with a different major is refused during the Noise handshake and the WebSocket is
closed with code 1008 and `protocol_major mismatch: server 3, client N`; there is no compatibility
layer. A different minor version is compatible: new commands and events are negotiated through the
common set.

**Upgrade crhs.**

1. Take a database backup and a key export ([Backups and restore](#backups-and-restore)).
2. Stop the server: `sudo systemctl stop crhs`.
3. Update the checkout and rebuild:

   ```sh
   cd /opt/crh
   git pull                  # or unpack the new source over the checkout
   pnpm install
   pnpm --filter @crh/web build
   ```

4. Start it and watch the log: `sudo systemctl start crhs && journalctl -u crhs -f`.
   Migrations run before the server listens. A migration failure stops the process; restore the
   backup and fix the cause before retrying.

**Upgrade crha.** Rebuild the binary on the build host, copy it to each node, and restart the units:

```sh
cd /opt/crh/client
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o crha ./cmd/crha
sudo install -m 0755 crha /usr/local/bin/crha
sudo systemctl restart crha-privileged crha
```

`crha upgrade --apply` is present in the command tree but is not implemented; it fails with
`crha: not implemented`. Replace the binary and restart the service as an ordinary privileged task,
or from outside a task. A restart stops every task running on the node, including the task that
performs the upgrade, so schedule the restart so the task can report its result first, for example
with `systemd-run --on-active=2s`, or restart from outside the task.

**What an upgrade does to running work.**

- A `crhs` restart loses the in-memory output buffers and the connections. A crha node reconnects
  with `hello`, and crhs recovers its unfinished tasks through `task.query` within the 2-minute
  reconnect grace. An SSH node's tasks become `unknown/connection_lost` immediately because their
  connection died with the process. Tasks still between their claim and their dispatch end as
  `failed/dispatch_interrupted`.
- A `crha` restart makes its running tasks `unknown/executor_restarted`: the client keeps no task
  across a restart, so after reconnecting crhs queries the tasks the client no longer reports.

Plan a maintenance window; there is no rolling upgrade across a protocol major.

**Rollback.** Stop crhs, restore the database backup, check out the previous source, rebuild the
WebUI and start it. There is no downgrade command for migrations, so the database backup is the
rollback.

## Backups and restore

Back up three things together:

| Item | Why |
|---|---|
| The database | Users, nodes, sessions, tasks, schedules, audit and the encrypted `secrets` rows. |
| The master key file (`master_key_file`, default `/etc/crhs/master.key`) | Decrypts `secrets`. Without it the database cannot use its server keys, SSH credentials or provider keys. |
| A key export (`crhs keys export`) | An encrypted copy of the master key and the server keys, for restoring the key file. |

The database and the master key are a pair. A backup of only one of them cannot be restored into a
working server.

**SQLite.** The database is one file in WAL mode. Either stop crhs and copy the database together
with any `-wal` and `-shm` files beside it, or take an online backup with the SQLite CLI:

```sh
sudo systemctl stop crhs
sudo cp -a /var/lib/crhs/crhs.db /backup/
sudo cp -a /var/lib/crhs/crhs.db-wal /var/lib/crhs/crhs.db-shm /backup/ 2>/dev/null || true
sudo systemctl start crhs
```

```sh
sqlite3 /var/lib/crhs/crhs.db ".backup '/backup/crhs-$(date +%F).db'"
```

Copying only `crhs.db` while the server is running can miss committed transactions still in the WAL.
A stopped server or `.backup` is the safe path.

**PostgreSQL.** Use `pg_dump`:

```sh
pg_dump --format=custom --no-owner --file /backup/crhs-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" /backup/crhs-2026-01-01.dump
```

Keep the dump and the master key in separate offline locations. The dump contains the encrypted
`secrets` rows; the key file is what makes them usable.

**Key export and import.**

```sh
sudo -u crhs node /opt/crh/server/src/main.ts keys export \
  --out /var/lib/crhs/crhs-keys.age --config /etc/crhs/crhs.toml
```

The command asks for an export passphrase twice on a terminal, writes an ASCII-armored age file with
mode 0600 and refuses to overwrite an existing file. The export contains the master key and the
decrypted values of the server identity key and the authorization signing key; node identity keys,
SSH credentials and user credentials are not in it. Run it after the first `serve`, because the
server keys are created on first start, and again after any server-key change. Store it offline; the
passphrase is the only protection.

To restore the key file, make the export readable by the service account (it is normally stored
root-only), move the old key aside, and import:

```sh
sudo mv /etc/crhs/master.key /etc/crhs/master.key.old
sudo install -m 0600 -o crhs -g crhs /root/crhs-keys.age /var/lib/crhs/restore.age
sudo -u crhs node /opt/crh/server/src/main.ts keys import \
  /var/lib/crhs/restore.age --config /etc/crhs/crhs.toml
sudo rm /var/lib/crhs/restore.age
```

`keys import` decrypts the export, checks that the master key id matches the database and that every
exported server key still exists there with the same value, then writes the key file. It creates the
file exclusively, so an existing file must be moved away first. It does not insert server keys into
the database: restore the database before importing, or the check fails. The export is not a database
backup.

**Restore procedure.**

1. Stop crhs.
2. Restore the database (copy the SQLite file and its WAL files, or `pg_restore`).
3. Restore the master key file: copy the backed-up file into place with mode 0600 and the service
   account as owner, or run `keys import` as above.
4. Start crhs and check the startup line and the log.
5. Sign in, check that nodes reconnect and that recent sessions and audit events are present.

If the database was rebuilt from scratch instead of restored, its server identity key and
authorization signing key are new. Every node that pinned the old identity key fails the handshake
and must enroll again, and every `privileged.toml` that trusts the old crhs signing key must be
updated. Restoring the database preserves both keys and the node rows, so nodes reconnect without
re-enrollment.

Test a restore on a spare host before you need one. A backup that has never been restored is a
guess.

## Logs

crhs and the unprivileged crha mode log to stdout and stderr and write no log file of their own.
Under systemd, journald collects them:

```sh
journalctl -u crhs -f
journalctl -u crha -f
journalctl -u crha-privileged -f
journalctl -u crhs --since "1 hour ago"
```

- **crhs.** The startup line names the listen address, the server identity fingerprint and the
  authorization signing-key fingerprint. Later lines are warnings and errors: a node whose clock
  differs, a failed sweep, an MCP error, a shutdown problem. crhs does not log individual requests.
  The audit log is in the database and in the WebUI, not in the process log.
- **crha, unprivileged mode.** It logs `crha starting` with the WebSocket URL and node key
  fingerprint, reload results, connection errors and task-level warnings. A node that crhs rejects
  exits with the reason.
- **crha, privileged mode.** Every accepted task is written with its full spec, and every refusal
  with the step and error code, to the JSON-lines file named by `log` in `privileged.toml` and to
  stderr (so journald has the same records). The file is created with mode 0600 and its directory
  with mode 0750. It has no built-in rotation: use `logrotate` with `copytruncate`, because the
  process keeps the file open and has no reopen signal.

The WebUI audit page is the place to see who did what; the process logs are for diagnosing the
process itself.

## Retention and cleanup

`[retention]` in `crhs.toml` decides when old rows are deleted. Defaults:

```toml
[retention]
tasks = "90d"     # terminal tasks, terminal task groups, expired authorizations
audit = "180d"    # audit events
pi_tasks = "7d"   # finished durable agent tasks and their task-scoped documents
```

Each value is a duration string or `"off"` to keep the rows forever. The minimum is `"1d"`: a shorter
window could delete a task whose durable tool call reruns after a crash and would otherwise reattach
to the existing row. A shorter value is a configuration error.

The sweep runs 5 seconds after startup and then once an hour. It deletes only terminal rows:
`tasks` keeps a row without `finished_at` however old it is, and `task_groups` keeps a non-terminal
group. `audit` deletes events older than the cutoff but always keeps the newest 16384 sequence
numbers, so a large forward clock jump cannot wipe the log. `pi_tasks` deletes terminal durable task
rows and the task-scoped documents and revisions that belong to them; it depends on pi-durable
invariants and must be rechecked when that dependency is upgraded. The rules are in [Data model:
retention](../design/data-model.md#retention).

Retention does not delete session conversations. The durable conversation records (`pi_entries`) are
what make long sessions readable, and they grow with use; size the database for them separately from
the task and audit windows.

Two other cleanups happen on the nodes, not in crhs:

- crha deletes complete output files under `[output].dir` after `[output].max_age` (default 7 days)
  or when their total exceeds `[output].max_total` (default 1 GiB).
- The privileged mode keeps its used-list records until `deadline + max(1h, clock_skew)`, or 24 hours
  for a local approval without a deadline.

## Rotating and revoking node keys

**Revoke a node.** Delete it on its page in the WebUI (**Delete node**). Its public key is removed,
the next handshake fails, and an established connection is closed after `node.status{rejected}`.
Tasks of that node that are still waiting end as `failed/node_deleted`; tasks already running lose
their connection and end as `unknown`. The node's groups and access grants go with the node record.

**Rotate a node key.** `crha rotate-key` is present in the command tree but is not implemented; it
fails with `crha: not implemented`. There is no online rotation. Replace the key by re-enrolling:

1. Create a new enrollment token in the WebUI.
2. Stop the agent: `sudo systemctl stop crha`, and `sudo systemctl stop crha-privileged` when that
   unit exists.
3. Remove **both** identity files. `crha enroll` refuses to overwrite either one, and removing only
   `identity.key` is not enough:

   ```sh
   sudo rm /var/lib/crha/identity.key /var/lib/crha/server.pub
   ```

4. Enroll again with the new token and start the agent:

   ```sh
   sudo -u crha crha enroll --config /etc/crha/crha.toml https://crh.example.com 'crh1.…'
   sudo systemctl start crha
   sudo systemctl start crha-privileged   # only when the unit exists
   ```

5. Approve the new node in the WebUI, comparing the new fingerprint from `crha status`.
6. Delete the old node record. If you want the same name, delete the old node before enrolling;
   otherwise the new node gets a `-2` suffix.
7. Restore the node's organization: add it to the same node groups, recreate its node access grants,
   and update `privileged.toml`: `node_id` must be the new id, and any entry in `aliases` that named
   the old node id must be corrected. Then restart `crha-privileged`.

If the key was compromised, delete the old node first so its key stops working, then enroll the
replacement.

**Rotate the server identity key.** crhs keeps one server identity key, and every node pins the key
it saw at enrollment. There is no online rotation: replacing it requires every node to enroll again.
Treat the server key as long-lived and back it up.

## Clock synchronization

Run a time synchronization service such as chrony or systemd-timesyncd on the crhs host and on every
node. Authorization deadlines are checked by the node's clock, so a node whose clock is wrong can
reject a valid authorization as expired or accept one for longer than intended.

Two different settings are involved:

- `clock_skew` in `privileged.toml` (default `"60s"`) is the tolerance applied to an authorization's
  `issued_at` and `deadline`. It is the setting that decides whether a signature is accepted.
- `clock_warn` in `crhs.toml` and `crha.toml` (default `"60s"`) is a warning threshold. crha measures
  the offset from crhs during the handshake and reports it in the node's facts; crha writes a warning
  log, and crhs writes a warning and shows a triangle with **clock** beside the node's status in the
  WebUI. Nothing is refused because of this warning.

The offset is measured once per connection and is not re-measured while the connection lasts. After
you fix the clock, restart `crha` so the node reconnects and the warning clears. `clock_warn = "0s"`
disables the warning but not the requirement to keep clocks synchronized.

A clock rollback does not break communication. It can make an expired authorization look valid
again; the used list still prevents a one-shot authorization from being reused until its record is
cleaned up, which is `deadline + max(1h, clock_skew)`. See [Clock](../design/privilege.md#clock).

## SQLite and PostgreSQL

Both backends use one schema and run the same migrations. Choose before you install: there is no
built-in export/import between them.

| | SQLite | PostgreSQL |
|---|---|---|
| Best for | One machine, a small team, debugging | A team deployment with many users and long conversations |
| Setup | Built into Node.js; a file path | A server, a role and a database |
| Version | The one bundled with Node.js | 14 or newer recommended |
| Concurrency | One writer; WAL and a per-file queue | MVCC, many readers and writers |
| Content search | Session titles only; the API reports `contentSearch: false` and returns no message hits | Titles and message text, through a generated search column |
| Compression | None | lz4 for large conversation records when the server supports it |
| Backup | Stop and copy, or `sqlite3 .backup` | `pg_dump` / `pg_restore` |

SQLite is a single file and suits a single administrator or a small installation. Its WAL mode
survives a process crash without losing committed transactions, but a power loss or system crash can
drop the last few committed transactions. Use PostgreSQL when you need stronger durability or
conversation content search. The storage details are in [Storage
backends](../design/data-model.md#storage-backends) and [Conversation content
search](../design/data-model.md#conversation-content-search).

## Troubleshooting

### A node is offline

A crha node's status is derived from its connection. If it is offline, tasks that need it wait up to
30 seconds for it to reconnect and then fail with `node_offline`; they are not queued for later. A
task waiting for an approval or a signature is not affected until it is released for dispatch.

Check, in this order:

1. `systemctl status crha` and `journalctl -u crha -n 100`. A process that exits with a rejection
   reason was refused by crhs; the reason is in the log.
2. `crha status --config /etc/crha/crha.toml` — the derived server URL, the node key and the pinned
   server key.
3. The node's WebUI page: pending approval, a trust warning, or a clock warning.
4. The network path: DNS, the TLS certificate, and the reverse proxy's `/agent` location. A proxy
   that does not forward the WebSocket upgrade leaves the node offline while the WebUI works.
5. The node's clock; a large offset does not cause `node_offline` by itself, but it can make
   authorization fail later.

An SSH node has no standing connection, so it is not shown as online or offline. A task fails at
once with `node_offline` when no route is configured; with a route, the SSH connection failure is the
task's own failure. Use **Test connection** on the node page and check that crhs can reach the SSH
port of every hop.

### The clock warning appears

The triangle and **clock** label beside a node mean the measured offset exceeded `clock_warn`; it is
diagnostic only. Check `timedatectl` or `chronyc tracking` on the node, wait for synchronization,
then restart `crha` so the offset is measured again. If the node's clock cannot be synchronized, the
authorization tolerance `clock_skew` in `privileged.toml` bounds the damage, but do not raise it
instead of fixing the clock.

### Login is rate-limited or the captcha fails

- `429` with code `rate_limited`: 10 failed logins from one address in 15 minutes. The limiter is in
  memory and resets when crhs restarts. Wait out the window or restart crhs.
- `429` with code `login_in_progress`: another login from the same address is already verifying a
  password. Retry after it finishes.
- `403` with code `captcha_failed`: the Cap proof-of-work challenge was rejected. A challenge is
  valid for two minutes and is bound to the client address, the username and the password. Behind a
  proxy, a missing or changing `real_ip_header` makes the address at challenge time differ from the
  address at login time. Set `real_ip_header` and make the proxy overwrite the header.
- `503` with code `hash_busy`: all Argon2id slots and the queue are full. Retry, or raise
  `[auth].argon2_concurrency` and `UV_THREADPOOL_SIZE` together.
- A login that appears to succeed but immediately returns to the sign-in page usually means the
  `crh_session` cookie was not stored: it is `Secure` on a non-loopback host, so the WebUI must be
  served over HTTPS.

`[auth].captcha = "none"` disables the proof of work for controlled environments that cannot run a
browser; it is not a fix for a proxy address problem.

### A task waits for an authorization

`awaiting_authorization` means the rule chain allowed the task but a `forward` node still needs a
signature or a local approval. The Approvals page lists the tasks and task groups waiting for the
signed-in user's signature; the session's tool card links to the same place. The task ends as
`rejected` with `authorization_wait_expired` after 24 hours.

Ways to release it:

- Sign in the WebUI with a registered Passkey.
- Sign the payload with an SSH key on your workstation and submit it:

  ```sh
  crha grant --key ~/.ssh/id_ed25519 --payload '<base64 payload>'
  ```

  The payload is shown in the WebUI's signature area and is available at
  `GET /api/tasks/<id>/authorization` (or `GET /api/task-groups/<id>/authorization`).
- Approve locally on the node, when a `local` trust entry allows your uid:

  ```sh
  sudo crha pending
  sudo crha approve <task-id>
  ```

If no trust entry can authorize the command, crhs refuses the task and names the paths it tried.
Check the node's trust panel: the crhs signing key must appear in a `role = "crhs"` entry, a user
entry must match your credential, and a reusable authorization issued to a node group needs the
group's UUID in `aliases`. A missing alias ends the task as `failed/alias_missing`. A `forward` node
whose trust report is stale or unavailable fails privileged tasks with `privileged_unavailable`.

### A task ended as unknown

`unknown` is the only "outcome not known" state, and it is reported as a failure. The reason says
what happened:

- `connection_lost` — the connection dropped before a terminal state and recovery failed. An SSH
  task is unknown as soon as its connection drops.
- `executor_restarted` — after reconnecting, the client did not know the task id because `crha`
  restarted.
- `dispatch_unconfirmed` — `task.start` was sent but no response arrived before the connection
  broke.

Inspect the node before retrying: the command may have run. There is no automatic retry; the agent or
the user decides. See [State machine](../design/execution.md#state-machine).

### A node connection is restricted

A node that has enrolled but not been approved keeps a restricted connection: it can complete the
handshake but receives no tasks. Approve it in the WebUI after comparing the fingerprint from
`crha status`. A node whose approval was rejected had its key deleted and must enroll again.
