# Operations

Installation is covered in [Install](install.md).

## Service management

A deployment has one crhs process and, on each crha node, the crha unprivileged mode plus, in `forward`
mode, the privileged mode. Example systemd units are in [Run as a service](install.md#run-as-a-service).

| Process | Stop | Reload |
|---|---|---|
| crhs | `SIGTERM`; it finishes in-flight work for up to 10 seconds | None; restart it |
| `crha run` | `SIGTERM` | `SIGHUP` re-reads `crha.toml` |
| `crha privileged run` | `SIGTERM` | `SIGHUP` re-reads `privileged.toml` |

Do not send `SIGHUP` to crhs; it terminates the process.

Run one crhs process per database. crhs keeps connections and scheduling state in memory, so a second
process on the same database is not supported.

## Reloading configuration

Each process reloads only its own file. An invalid file is not applied; the process keeps running with
the old configuration and logs the error.

- `crha run` applies changes to `server`, `tls_verify` and `notes` on reload. Other settings, such as
  `state_dir`, `[output]` and `[privileged]`, need a restart, and crha logs which ones.
- `crha privileged run` applies trust entries, aliases, guard rules and `clock_skew` on reload, and
  reports the new trust configuration to crhs. The socket, state directory and log path need a restart.

```sh
sudo systemctl reload crha
sudo systemctl reload crha-privileged
```

Changing `privileged.toml` through CRH is a privileged task (a file write followed by a reload), and
needs an authorization from a signer the node already trusts.

## Upgrades

There are no packages and no self-upgrade. An upgrade means: stop the service, update the source or
binary, rebuild, start again. Database migrations run automatically when crhs starts.

Upgrade crhs and crha together. Nodes with a different protocol major version are refused when they
connect; a different minor version is compatible.

**crhs:**

1. Back up the database and take a key export ([Backups and restore](#backups-and-restore)).
2. Stop crhs, update the checkout, run `pnpm install` and rebuild the WebUI
   (`pnpm --filter @crh/web build`).
3. Start crhs and watch its log. If a migration fails, crhs stops; restore the backup and fix the cause.

**crha:** build the new binary ([Build crha](install.md#build-crha)), install it on each node and restart
`crha-privileged` and `crha`. If you upgrade through a CRH task, schedule the restart after the task
reports (for example `systemd-run --on-active=2s systemctl restart crha`), because a restart ends every
running task, including the one doing the upgrade.

**Effect on running work.** After a crhs restart, crha nodes reconnect and their running tasks continue;
tasks on SSH nodes become `unknown`. After a crha restart, the tasks that were running on that node
become `unknown`.

**Rollback:** stop crhs, restore the database backup, check out the previous version, rebuild and start.
Migrations cannot be reversed; the backup is the rollback.

## Backups and restore

Back up three things:

| Item | Why |
|---|---|
| The database | All crhs data, including secrets in encrypted form |
| The master key file (`master_key_file`) | Decrypts the secrets |
| A key export (`crhs keys export`) | A passphrase-protected copy of the master key and crhs's own keys |

The database and the master key belong together; neither is useful alone.

**SQLite.** Stop crhs and copy the database file together with its `-wal` and `-shm` files, or back it up
online:

```sh
sqlite3 /var/lib/crhs/crhs.db ".backup '/backup/crhs-$(date +%F).db'"
```

Copying only the database file while crhs runs can miss recent transactions.

**PostgreSQL.**

```sh
pg_dump --format=custom --no-owner --file /backup/crhs-$(date +%F).dump "$DATABASE_URL"
```

**Key export.** Run it once after the first start of crhs, which creates crhs's keys:

```sh
sudo -u crhs node /opt/crh/server/src/main.ts keys export \
  --out /var/lib/crhs/crhs-keys.age --config /etc/crhs/crhs.toml
```

It asks for a passphrase and writes an [age](https://age-encryption.org/) file, which the standard `age`
tool can also decrypt. The file contains crhs's private keys: store it offline, apart from the database
backups. Node keys are not included; a node that loses its key enrolls again.

**Restore:**

1. Stop crhs.
2. Restore the database.
3. Put the master key file back (mode 0600, owned by the crhs user), or recreate it from the export:

   ```sh
   sudo -u crhs node /opt/crh/server/src/main.ts keys import \
     /var/lib/crhs/restore.age --config /etc/crhs/crhs.toml
   ```

   `keys import` checks that the export belongs to the restored database and refuses to overwrite an
   existing key file.
4. Start crhs, sign in, and check that nodes reconnect and recent data is present.

If you start from an empty database instead, crhs creates new keys. Every node must then enroll again,
and every `privileged.toml` that trusts the old crhs signing key must be updated.

Test a restore on a spare host before you need one.

## Logs

crhs and crha log to standard output; under systemd, read them with `journalctl -u crhs`,
`journalctl -u crha` and `journalctl -u crha-privileged`.

- crhs logs its listen address and key fingerprints at startup, then warnings and errors. It does not
  log requests; use the audit log in the WebUI to see who did what.
- crha logs its connection, reloads and errors. A node that crhs rejects exits with the reason.
- The privileged mode also writes every accepted and refused task to the JSON-lines file named by `log`
  in `privileged.toml`. It does not rotate the file; use `logrotate` with `copytruncate`.

## Retention and cleanup

The retention windows in the WebUI's **System settings** (administrators) set how long finished tasks,
audit events and finished agent tool records are kept (90, 180 and 7 days by default; `"off"` keeps
them forever; the minimum is one day). A change applies to the next sweep; see the
[crhs configuration reference](reference/crhs-config.md#system-settings). Tasks still in progress are
never deleted, and the most recent audit events are always kept.

Session conversations are never deleted by retention. They grow with use, so size the database for
them.

On nodes, crha deletes complete task output files after `[output].max_age` (7 days) or when they exceed
`[output].max_total` (1 GiB).

## Rotating and revoking node keys

**Revoke a node:** delete it on its page in the WebUI. Its key stops working at once. Tasks waiting for
it fail; tasks running on it become `unknown`.

**Replace a node's key:** there is no online rotation (`crha rotate-key` is not implemented). Enroll the
node again:

1. Create an enrollment token in the WebUI.
2. Stop `crha` (and `crha-privileged`).
3. Remove both `identity.key` and `server.pub` from the node's state directory.
4. Run `crha enroll` with the new token, start the services, and approve the node in the WebUI after
   comparing its fingerprint with `crha status`.
5. Delete the old node record (before enrolling, if you want to keep the name), add the new node to the
   same node groups and access grants, and update `node_id` and `aliases` in `privileged.toml`.

If the key was compromised, delete the old node first.

**crhs's identity key** cannot be rotated: every node pins it at enrollment, so replacing it means
re-enrolling every node. Back it up with a key export.

**crhs's authorization signing key** can be rotated while crhs runs. Add a key, add its public key to
each node's `privileged.toml` and reload the node when convenient, then delete the old key once no node
trusts it. crhs uses the newest key each node trusts, so nodes may be updated one at a time. Deleting a
compromised key stops crhs signing with it at once, but a node that still lists it continues to trust it;
remove the entry there as well. With no keys left crhs signs nothing and falls back to the owner's
signature or a local approval.

## Clock synchronization

Run time synchronization (chrony, systemd-timesyncd) on the crhs host and every node. Nodes check
authorization deadlines with their own clock, so a wrong clock causes refusals or lets authorizations
last longer than intended.

A **clock** warning next to a node means its clock differed from crhs's by more than `clock_warn` in
**System settings** when it connected. Fix the clock, then restart `crha` so the offset is measured
again. The warning never blocks work. It is unrelated to `clock_skew` in `privileged.toml`, which is
the tolerance for checking authorizations; do not raise `clock_skew` instead of fixing the clock.

## SQLite and PostgreSQL

Choose before installing; there is no migration between the two.

| | SQLite | PostgreSQL |
|---|---|---|
| Best for | One machine, a small team, trials | Team deployments and long conversation histories |
| Setup | A file path | A server, a role and a database (version 14 or newer recommended) |
| Durability | A power loss can drop the last few transactions | Full |
| Session search | Titles only | Titles and message text |
| Backup | Stop and copy, or `sqlite3 .backup` | `pg_dump` |

## Troubleshooting

### A node is offline

Tasks for an offline crha node wait up to 30 seconds and then fail with `node_offline`; they are not
queued. Check:

1. `systemctl status crha` and `journalctl -u crha`. A rejection reason in the log means crhs refused
   the node.
2. `crha status --config /etc/crha/crha.toml` for the server URL and keys.
3. The node page in the WebUI: pending approval, or a trust warning.
4. The network path and the reverse proxy. A proxy that does not pass WebSocket upgrades on `/agent`
   leaves nodes offline while the WebUI works.

SSH nodes have no standing connection. Use **Test connection** on the node page and check that crhs can
reach every hop.

### Login is rate-limited or the captcha fails

- `rate_limited`: 10 failed logins from one address in 15 minutes. The limit resets after 15 minutes or
  when crhs restarts.
- `login_in_progress`: another login from the same address is in progress; retry.
- `captcha_failed`: the challenge expired (after two minutes) or the client address changed between
  challenge and login. Behind a proxy, set `real_ip_header` in **System settings** and make the proxy
  overwrite that header.
- `hash_busy`: too many password checks at once; retry, or raise `auth.argon2_concurrency` in
  **System settings**.
- If you are returned to the sign-in page right after signing in, the browser did not keep the session
  cookie: on any host other than localhost the WebUI must be served over HTTPS.

### A task waits for an authorization

The rules allowed the task, but a `forward` node needs a signature or a local approval. You can:

- sign with a Passkey on the task page or the Approvals page;
- sign with an SSH key on your workstation, then paste the result into the WebUI:

  ```sh
  crha grant --key ~/.ssh/id_ed25519 --payload '<payload from the WebUI>'
  ```

- approve on the node, if your uid is in a `local` trust entry: `sudo crha pending`, then
  `sudo crha approve <task-id>`.

The wait expires after 24 hours. If nobody can authorize the command, crhs refuses the task and says
which paths it tried; check the node's trust panel. `alias_missing` means a group authorization was
used for a node whose `aliases` lack that group. `privileged_unavailable` means the node's privileged
mode is not running or has not reported its trust configuration.

### A task ended as unknown

crhs lost track of the task: the connection dropped (`connection_lost`), crha restarted
(`executor_restarted`), or the node never confirmed it received the task (`dispatch_unconfirmed`). The
command may or may not have run. Check the node before running it again; CRH never retries
automatically.

### A node stays pending

An enrolled node receives no tasks until an administrator approves it. Approve it in the WebUI after
comparing the fingerprint with `crha status`. A rejected node must enroll again.
