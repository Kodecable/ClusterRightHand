# Command-line reference

This page describes what each command is for, with common examples. Run `crhs --help`,
`crha --help` or `crha <command> --help` for every flag.

## crhs

`crhs` runs on the server host. Until there are packages, run it as
`node /opt/crh/server/src/main.ts` ([Install](../install.md)). Every command reads the configuration
file (`--config`, default `/etc/crhs/crhs.toml`) and brings the database schema up to date before it
runs.

| Command | Purpose |
|---|---|
| `serve` | Run the server. This is the default command. |
| `user add <username>` | Create a user; `--admin` makes an administrator. |
| `user passwd <username>` | Set a user's password. |
| `keys init` | Create the master key file for a new database. |
| `keys export --out <file>` | Write a passphrase-protected backup of crhs's keys. |
| `keys import <file>` | Restore the master key file from an export. |

```sh
crhs user add alice --admin --display-name "Alice Example"
printf '%s\n' "$PASSWORD" | crhs user add bob          # non-interactive
crhs keys export --out /root/crhs-keys.age
crhs keys import /root/crhs-keys.age
```

Passwords and passphrases are never taken as arguments. On a terminal they are prompted for twice;
otherwise one line is read from standard input.

`keys init` refuses to overwrite an existing key file and refuses a database that already belongs to
another key. `keys export` writes an [age](https://age-encryption.org/) file containing crhs's private
keys, so keep it offline; it is available only on the command line. `keys import` checks the export
against the restored database before writing the key file. See [Backups and restore](../operations.md#backups-and-restore).

Exit codes: 0 on success, 1 when the command is refused (for example a duplicate user or a wrong key
file), 2 when the command line or the configuration file is invalid.

## crha

`crha` runs on a node. Commands that need a configuration take `--config`; there is no default path.

| Command | Purpose |
|---|---|
| `enroll <server-url> <token>` | Enroll the node with a one-time token from the WebUI; `--replace` re-enrolls an existing node. |
| `run` | Run the unprivileged mode, which connects to crhs and runs tasks. |
| `status` | Show the server URL, the node's key fingerprint and the privilege mode. |
| `version` | Show the version. |
| `upgrade` | Not implemented yet. |

```sh
crha enroll --config /etc/crha/crha.toml https://crh.example.com 'crh1.…'
crha enroll --replace --config /etc/crha/crha.toml https://crh.example.com 'crh1.…'
crha run --config /etc/crha/crha.toml
crha status --config /etc/crha/crha.toml
```

`crha enroll` checks crhs's identity against the fingerprint in the token, creates the node's key and
prints the node id and fingerprint. It refuses to run if the node already has a key; pass `--replace`
with a Re-enroll token to replace it. `--replace` moves `identity.key` and `server.pub` aside as
`identity.key.old` and `server.pub.old` (overwriting older backups) and restores them if enrollment
fails, leaving the rest of the state directory untouched. There is no online rotation. If the
configuration file does not exist, add `--state-dir <dir>` to create a minimal one.

Errors are printed as `crha: <message>` with exit code 1.

## crha privileged

| Command | Purpose |
|---|---|
| `privileged run --config <file>` | Run the privileged mode of a `forward` node, usually as root. |
| `privileged stdio` | The helper that `native` mode starts through sudo, doas or run0. Not for direct use. |

`privileged run --no-persist-used` keeps the record of executed tasks in memory only, for devices with
limited flash endurance. After a restart, a one-shot authorization could then be used again until its
deadline.

## crha grant

`crha grant` signs an authorization with your SSH key on your workstation. It runs
`ssh-keygen -Y sign`, so encrypted keys, ssh-agent and FIDO keys work, and it never reads the private
key itself. It shows what you are about to sign and asks for confirmation.

Sign a request shown in the WebUI, then paste the output back:

```sh
crha grant --key ~/.ssh/id_ed25519 --payload '<payload from the WebUI>'
```

Sign a reusable authorization, for example for a scheduled task:

```sh
crha grant --key ~/.ssh/id_ed25519 \
  --nodes 0192f000-0000-7000-8000-000000000001 \
  --method exec --prefix "systemctl restart " --deadline 720h
```

`--nodes` takes node or node group UUIDs (shown in the WebUI) or `*`, never names. A deadline is
always required. `--exact` with `--spec-sha256` limits the authorization to one exact task; `--task`
makes it one-shot. Submit a reusable authorization through `POST /api/authorizations`.

## crha pending, approve and deny

Local approval on the node, for users listed in a `local` trust entry. These commands talk directly to
the privileged mode; crhs is not involved.

```sh
sudo crha pending
sudo crha approve 0192f000-0000-7000-8000-000000000010
sudo crha deny 0192f000-0000-7000-8000-000000000010 --message "not during business hours"
```

`approve` and `deny` show the full task and ask for confirmation (`--yes` skips it). The approval is
bound to what you saw: if the task changed meanwhile, the privileged mode refuses it.

They connect to `/run/crha/privileged.sock` unless `--socket` or `CRHA_PRIVILEGED_SOCKET` names another
socket.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CRHA_TASK_HOME`, `CRHA_TASK_USER`, `CRHA_TASK_LOGNAME`, `CRHA_TASK_SHELL` | crha | Override the account and shell given to tasks ([crha configuration](crha-config.md#environment-overrides)). |
| `CRHA_PRIVILEGED_SOCKET` | `crha pending`, `approve`, `deny` | The privileged mode's socket. |
| `CRHA_PRIVILEGED_STDIN_DIR` | `crha privileged stdio` | Where the `native` helper stages task input. |
| `UV_THREADPOOL_SIZE` | crhs | Node.js worker threads; raise it together with `auth.argon2_concurrency` in **System settings**. |
| `RE2_DOWNLOAD_MIRROR` | `pnpm install` | Mirror for the prebuilt RE2 module. |
