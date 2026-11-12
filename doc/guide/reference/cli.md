# Command-line reference

This page describes what each command is for, with common examples. Run `crhs --help`,
`crha --help` or `crha <command> --help` for every flag.

## crhs

`crhs` runs on the server host. Until there are packages, run it as
`node /opt/crh/server/src/main.ts` ([Install](../install.md)). Every command except `init` reads the
configuration file (`--config`, default `/etc/crhs/crhs.toml`) and brings the database schema up to
date before it runs.

| Command | Purpose |
|---|---|
| `serve` | Run the server. This is the default command. |
| `init [--answers <file>] [--save-answers <file>]` | Set up this host: user, directories, configuration, key, database, administrator and systemd unit. |
| `user add <username>` | Create a user; `--admin` makes an administrator. |
| `user passwd <username>` | Set a user's password. |
| `keys init` | Create the master key file for a new database. |
| `keys export --out <file>` | Write a passphrase-protected backup of crhs's keys. |
| `keys import <file>` | Restore the master key file from an export. |

```sh
crhs init
crhs init --answers /root/crhs-init.json --save-answers /root/crhs-init.without-secrets.json
crhs user add alice --admin --display-name "Alice Example"
printf '%s\n' "$PASSWORD" | crhs user add bob          # non-interactive
crhs keys export --out /root/crhs-keys.age
crhs keys import /root/crhs-keys.age
```

`crhs init` asks its questions on the terminal, showing each default (Enter takes it), then prints a
summary and asks before changing anything. `--answers <file>` answers questions ahead with one JSON
object; `--save-answers <file>` writes an interactive run's answers without the secrets. Without a
terminal, every question must be answered by the file.

Passwords and passphrases are never taken as arguments. On a terminal they are prompted for twice;
otherwise one line is read from standard input.

`keys init` refuses to overwrite an existing key file and refuses a database that already belongs to
another key. `keys export` writes an [age](https://age-encryption.org/) file containing crhs's private
keys, so keep it offline; it is available only on the command line. `keys import` checks the export
against the restored database before writing the key file. See [Backups and restore](../operations.md#backups-and-restore).

Exit codes: 0 on success, 1 when the command is refused (for example a duplicate user or a wrong key
file), 2 when the command line or the configuration file is invalid.

## crha

`crha` runs on a node. `crha enroll` defaults to `/etc/crha/crha.toml`; the other commands that need a
configuration take `--config` and have no default path.

| Command | Purpose |
|---|---|
| `enroll [--config <path>] [--answers <file>] [--save-answers <file>]` | Set up and enroll this node; run as root. |
| `register --config <path> [--replace]` | Enroll using an existing `crha.toml`; the token is read from standard input. |
| `run` | Run the unprivileged mode, which connects to crhs and runs tasks. |
| `status` | Show the server URL, the node's key fingerprint and the privilege mode. |
| `version` | Show the version. |
| `upgrade` | Not implemented yet. |

```sh
sudo crha enroll
sudo crha enroll --answers /root/crha-enroll.json --save-answers /root/crha-enroll.without-token.json
sudo crha enroll --config /etc/crha/crha.toml
printf '%s\n' "$TOKEN" | crha register --config /etc/crha/crha.toml
crha run --config /etc/crha/crha.toml
crha status --config /etc/crha/crha.toml
```

`crha enroll` sets up the node: it creates the `crha` user and group, `/etc/crha`, `/var/lib/crha`,
`crha.toml`, the enrolled keys, `privileged.toml` for `forward` mode and the systemd units. It asks its
questions on the terminal, showing each default; `--answers <file>` answers them ahead with one JSON
object (a file holding the token must be readable only by its owner), and `--save-answers <file>` writes
an interactive run's answers without the token. Without a terminal every question must be answered by
the file. Each step that is already done is skipped, so an interrupted run can be repeated.

`crha enroll` checks crhs's identity against the fingerprint in the token and prints the node id and
key fingerprint. When the node already has a key it asks first whether to re-enroll, keeping the node's
id, name, node groups and grants. Answering no keeps the existing enrollment: the server, TLS setting
and privileged mode come from the existing `crha.toml`, no token is needed and the enrollment step is
skipped (for `forward`, `privileged.toml` must already exist). Re-enrollment moves `identity.key` and
`server.pub` aside as `.old` files (overwriting older backups) and restores them if enrollment fails.
There is no online rotation.

`crha register` is the enrollment step alone, for a manual layout: it reads the token from standard
input (or prompts without echo on a terminal), uses the server and paths of an existing `crha.toml`,
and creates no user, file or unit. `--replace` re-enrolls an existing node. `crha enroll` calls the same
code rather than running `crha register`.

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
