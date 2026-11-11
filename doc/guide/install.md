# Installing ClusterRightHand

There are no packages yet; CRH runs from a source checkout. The examples put the checkout at
`/opt/crh` and run the server as `node /opt/crh/server/src/main.ts`. Wherever this guide says
`crhs <command>`, use that prefix.

## Prerequisites

| Requirement | For |
|---|---|
| Linux | crhs and every crha node |
| Node.js 24.7 or newer, pnpm 12 | crhs and the WebUI build |
| Go (version in `client/go.mod`) | Building `crha` |
| SQLite (built into Node.js) or PostgreSQL 14+ | The database ([choosing](operations.md#sqlite-and-postgresql)) |
| A reverse proxy with TLS | Anything beyond a local test; crhs speaks plain HTTP |
| Network from each crha node to crhs | crha nodes connect to crhs, never the other way |
| SSH from crhs to each SSH node and its jump hosts | SSH nodes only |

## Install crhs

```sh
sudo useradd --system --user-group --home-dir /var/lib/crhs --shell /usr/sbin/nologin crhs
sudo install -d -m 0755 /opt/crh
sudo chown "$USER": /opt/crh
# clone or copy the repository into /opt/crh, then:
cd /opt/crh
corepack enable pnpm
pnpm install
```

`pnpm install` builds or downloads the native `re2` module, which crhs requires. On an offline host,
set `RE2_DOWNLOAD_MIRROR` or install a C++ toolchain first.

## Build the WebUI

```sh
cd /opt/crh
pnpm --filter @crh/web build
```

crhs serves the result from `web/dist` (the `web_root` setting). Rebuild after every update.

## Configure crhs

```sh
sudo install -d -o root -g crhs -m 0770 /etc/crhs
sudo install -d -o crhs -g crhs -m 0700 /var/lib/crhs
sudoedit /etc/crhs/crhs.toml
sudo chown root:crhs /etc/crhs/crhs.toml && sudo chmod 0640 /etc/crhs/crhs.toml
```

A minimal configuration behind a reverse proxy on the same host:

```toml
# /etc/crhs/crhs.toml
master_key_file = "/etc/crhs/master.key"
web_root = "/opt/crh/web/dist"

[listen]
host = "127.0.0.1"
port = 8080

[database]
driver = "sqlite"
path = "/var/lib/crhs/crhs.db"
```

All settings are in the [crhs configuration reference](reference/crhs-config.md). Unknown keys are
errors.

After the first start, sign in as an administrator and set `public_url`, `real_ip_header` and the
WebAuthn relying party in the WebUI's **System settings** page; those settings apply without a restart.
crhs imports them from an older `crhs.toml` once and asks you to remove them from the file.

## Prepare the database

**SQLite** needs only a writable directory; the file is created on first use.

**PostgreSQL**: create a role and a database it owns, then point crhs at it. Do not use a superuser.

```sh
sudo -u postgres createuser --pwprompt crh
sudo -u postgres createdb --owner crh crh
```

```toml
[database]
driver = "postgres"
url = "postgres://crh:secret@db.example.com/crh"
```

Migrations run automatically whenever a crhs command starts.

## Initialize the master key

The master key encrypts the secrets crhs stores. Create it once:

```sh
sudo -u crhs node /opt/crh/server/src/main.ts keys init --config /etc/crhs/crhs.toml
```

This writes `/etc/crhs/master.key` (mode 0600) and binds the database to it. The key file and the
database belong together; back up both. After crhs has started once, also take a key export, as
described in [Backups and restore](operations.md#backups-and-restore).

## Create the first administrator

```sh
sudo -u crhs node /opt/crh/server/src/main.ts user add alice \
  --admin --display-name "Alice Example" --config /etc/crhs/crhs.toml
```

The command asks for the password twice, or reads one line from standard input when it is not a
terminal. Further users can be created in the WebUI.

## Start crhs

```sh
sudo -u crhs node /opt/crh/server/src/main.ts serve --config /etc/crhs/crhs.toml
```

It prints its address and key fingerprints. Sign in through the reverse proxy (or at
`http://127.0.0.1:8080` for a local test). To run it permanently, see [Run as a service](#run-as-a-service).

## Reverse proxy and TLS

crhs does not terminate TLS. An nginx example:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name crh.example.com;
    ssl_certificate     /etc/letsencrypt/live/crh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crh.example.com/privkey.pem;

    client_max_body_size 96m;          # tasks may carry up to 64 MiB of input

    location /agent {                  # crha connections (WebSocket)
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;           # live session updates
        proxy_read_timeout 1h;
    }
}
```

- The proxy must **overwrite** the header named by `real_ip_header` in **System settings** (here
  `X-Forwarded-For`); crhs trusts its first value for rate limiting.
- Passkeys need HTTPS and a hostname, not an IP address. The `rp_id` and `origins` in **System
  settings** must match the public hostname.
- The session cookie requires HTTPS on any host other than localhost.
- `public_url` in **System settings** makes links in MCP results use the public address.

## Build crha

```sh
cd /opt/crh/client
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o crha ./cmd/crha
# for another architecture:
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o crha-linux-arm64 ./cmd/crha
```

`CGO_ENABLED=0` produces a static binary that runs on any Linux. Install it on the node and create its
account and directories:

```sh
sudo install -m 0755 crha /usr/local/bin/crha
sudo groupadd --system crha
sudo useradd --system --gid crha --home-dir /var/lib/crha --shell /usr/sbin/nologin crha
sudo install -d -o crha -g crha -m 0700 /var/lib/crha
sudo install -d -o root -g crha -m 0750 /etc/crha
```

Ordinary tasks run as the `crha` user.

## Enroll a node

1. In the WebUI, open **Nodes** and choose **New node**. Copy the one-time enrollment token (valid for
   one hour).
2. On the node, create the configuration:

   ```sh
   sudo install -m 0640 -o root -g crha /dev/null /etc/crha/crha.toml
   sudoedit /etc/crha/crha.toml
   ```

   ```toml
   server = "https://crh.example.com"
   state_dir = "/var/lib/crha"
   ```

3. Enroll and start the agent:

   ```sh
   sudo -u crha crha enroll --config /etc/crha/crha.toml https://crh.example.com 'crh1.…'
   sudo -u crha crha run --config /etc/crha/crha.toml
   ```

   `crha enroll` checks crhs's identity against the fingerprint in the token, creates the node's key and
   prints the node id and key fingerprint. If `crha.toml` does not exist yet, add
   `--state-dir /var/lib/crha` and enroll writes a minimal file.

If the node was enrolled before, use **Re-enroll** on its page instead of **New node**:
`crha enroll --replace` keeps the node record (id, name, node groups and access grants) while replacing
its key ([Rotating and revoking node keys](operations.md#rotating-and-revoking-node-keys)).

Without a `[privileged]` table the node refuses privileged tasks. To enable them, see
[Privileged tasks](#privileged-tasks).

## Approve a node

The node appears in **Nodes** as pending. Run `crha status --config /etc/crha/crha.toml` on the node and
compare its hostname and key fingerprint with the WebUI, then choose **Approve**. A rejected node must
enroll again.

## Privileged tasks

Choose a mode in `crha.toml` ([choosing a mode](security.md#choosing-a-privilege-mode)):

```toml
[privileged]
mode = "forward"                      # forward | native | ignore | reject
socket = "/run/crha/privileged.sock"  # forward only
```

For `native`, allow the crha user to start the helper without a password:

```text
crha ALL=(root) NOPASSWD: /usr/local/bin/crha privileged stdio
```

For `forward`, run the privileged mode as root with a `privileged.toml` that lists who may authorize
tasks:

```toml
# /etc/crha/privileged.toml
node_id = "0192f000-0000-7000-8000-000000000001"   # printed by crha enroll
unprivileged_uid = 998                              # id -u crha
socket = "/run/crha/privileged.sock"
state_dir = "/var/lib/crha/privileged"
log = "/var/log/crha/privileged.jsonl"

[[trust]]
name = "crhs"
role = "crhs"
format = "sshsig"
key = "ssh-ed25519 AAAA…"            # crhs's signing key, shown on the node page
kinds = ["execute"]
deny = [{ method = "file.write", prefix = "/etc/crha/" }]
```

The file must be owned by root and not writable by others. The node page in the WebUI shows crhs's
signing key and can build trust entries for you. All fields are in the
[privileged configuration reference](reference/privileged-config.md).

## Add an SSH node

1. Open **SSH credentials** and create a credential. Add the public key it shows to the target user's
   `authorized_keys` on the target and on every jump host.
2. On **Nodes**, choose **New SSH node**, select the credential, enter the route (jump hosts first, then
   the target), and pin each hop's host key after checking its fingerprint on that host
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
3. Use **Test connection** on the node page to check the route.

The target account needs a POSIX login shell (bash, zsh, dash, ash or ksh) and the SFTP subsystem.
Tasks run as that account; SSH nodes cannot run privileged tasks.

## Configure a model provider

Open **Models** (administrators only) and choose **New provider**:

- **Pi built-in**: choose a known provider and enter its API key.
- **Custom**: enter the base URL and API key of any endpoint that speaks the Chat Completions or
  Responses protocol, then add its models.

The model presets on the same page are optional.

## Run as a service

Example systemd units; adjust the paths.

```ini
# /etc/systemd/system/crhs.service
[Unit]
Description=ClusterRightHand server
After=network-online.target
Wants=network-online.target

[Service]
User=crhs
Group=crhs
WorkingDirectory=/opt/crh
ExecStart=/usr/bin/node /opt/crh/server/src/main.ts serve --config /etc/crhs/crhs.toml
Restart=on-failure
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=-/var/lib/crhs

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/crha.service
[Unit]
Description=ClusterRightHand node agent
After=network-online.target crha-privileged.service
Wants=network-online.target

[Service]
User=crha
Group=crha
ExecStart=/usr/local/bin/crha run --config /etc/crha/crha.toml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/crha-privileged.service — forward mode only
[Unit]
Description=ClusterRightHand node agent (privileged)
Before=crha.service

[Service]
User=root
RuntimeDirectory=crha
RuntimeDirectoryMode=0755
ExecStart=/usr/local/bin/crha privileged run --config /etc/crha/privileged.toml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
```

The privileged mode creates its socket in `/run/crha` with the `crha` group, which is how the
unprivileged mode reaches it.

## Troubleshooting the installation

| Symptom | Cause |
|---|---|
| `ENOENT` for `crhs.toml` | Wrong path; pass `--config`. |
| `cannot create /etc/crhs/master.key` | The directory does not exist. crhs also does not create the SQLite directory. |
| `must not be accessible by group or others` | `chmod 600` the master key file and make the crhs user its owner. |
| `the master key file does not belong to this database` | The key and the database come from different installations. Restore the matching key file. |
| The WebUI returns 404 | The WebUI is not built, or `web_root` points elsewhere. |
| `pnpm install` fails on `re2` | Install a C++ toolchain or set `RE2_DOWNLOAD_MIRROR`; crhs does not start without it. |
| crha reports a missing `identity.key` | The node is not enrolled, or `state_dir` is wrong. |
| `protocol_major mismatch` | crhs and crha come from incompatible versions; upgrade both. |
| PostgreSQL authentication or permission errors | The role must own the database and be allowed to create tables. |
