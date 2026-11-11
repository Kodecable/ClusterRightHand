# Installing ClusterRightHand

There are no packages yet: this guide builds and runs CRH from a source checkout. The examples put
the checkout at `/opt/crh` and invoke the server as `node /opt/crh/server/src/main.ts`; wherever the
text says `crhs <command>`, run that command with this prefix. The command line itself is described
in the [command-line reference](reference/cli.md#crhs).

A deployment has three parts: the server (`crhs`) with its database, the WebUI it serves, and one
agent per node (`crha`) or an SSH route to a node. The order below takes you from an empty host to a
working node.

## Prerequisites

| Requirement | Needed for |
|---|---|
| Linux on the server and on every crha node | crha has no Windows build; the server runs wherever Node.js runs. |
| Node.js 24.7 or newer | crhs. Node runs the TypeScript sources directly and provides Argon2id in `node:crypto`. |
| pnpm 12 | The workspace install and the WebUI build. The repository pins pnpm 12.15.0 in `packageManager`; `corepack enable pnpm` installs that version. |
| Go, the version named in `client/go.mod` (currently 1.27.3) | Building `crha`. |
| SQLite (built into Node.js) or PostgreSQL 14 or newer | The database. SQLite needs nothing extra; PostgreSQL is the team deployment. |
| A reverse proxy that terminates TLS | crhs speaks HTTP only. Use nginx, Caddy or equivalent for anything beyond a loopback test. |
| An sshd with the SFTP subsystem | SSH nodes only. crha nodes need no sshd. |
| Outbound HTTPS/WSS from every node to crhs | A crha node always dials crhs; the server never dials a crha node. |
| Inbound SSH from crhs to an SSH node, plus any jump hosts | SSH nodes only. |

`pnpm install` builds or downloads the native `re2` module, which crhs requires for rule matching. A
failed `re2` build is fatal; crhs never falls back to the JavaScript regular-expression engine. On
an offline host, point `RE2_DOWNLOAD_MIRROR` at a mirror before installing, or install a C++
toolchain so the module can be built.

## Install crhs

Create a service account and a place for the checkout:

```sh
sudo useradd --system --user-group --home-dir /var/lib/crhs --shell /usr/sbin/nologin crhs
sudo install -d -m 0755 /opt/crh
sudo chown "$USER": /opt/crh
```

Clone or copy the repository into `/opt/crh`, then install the workspace dependencies:

```sh
cd /opt/crh
corepack enable pnpm    # or: npm install -g pnpm@12
pnpm --version          # should print 12.x
pnpm install
```

The service account only needs read access to the checkout and its `node_modules`; the build itself
can run as any user. The examples assume `node` is on that account's `PATH` (for example
`/usr/bin/node`); use an absolute path otherwise. There is no separate build step for the server:
Node executes `server/src/main.ts` and the TypeScript sources beside it.

## Build the WebUI

The WebUI is a Vite application. Build it once after `pnpm install`, and again after any change to
`web/`:

```sh
cd /opt/crh
pnpm --filter @crh/web build
test -f web/dist/index.html
```

The build writes `web/dist`. crhs serves that directory at `/` and falls back to `index.html` for
client-side routes, so the WebUI works without a second web server. Without a build, only the API,
the agent WebSocket and the MCP endpoint answer; the browser gets a 404. The directory is selected
by `web_root` in `crhs.toml`; the default is `web/dist` next to the server sources, which is the path
this layout produces.

## Configure crhs

Create the configuration directory and the state directory, then write `crhs.toml`:

```sh
sudo install -d -o root -g crhs -m 0770 /etc/crhs
sudo install -d -o crhs -g crhs -m 0700 /var/lib/crhs
sudoedit /etc/crhs/crhs.toml
```

A minimal SQLite configuration:

```toml
# /etc/crhs/crhs.toml
master_key_file = "/etc/crhs/master.key"
web_root = "/opt/crh/web/dist"
clock_warn = "60s"

[listen]
host = "127.0.0.1"
port = 8080
real_ip_header = "X-Forwarded-For"

[database]
driver = "sqlite"
path = "/var/lib/crhs/crhs.db"

[webauthn]
rp_id = "crh.example.com"
rp_name = "ClusterRightHand"
origins = ["https://crh.example.com"]

[auth]
captcha = "cap"
```

The default `[listen]` binds loopback only, which assumes a reverse proxy on the same host. The
`real_ip_header` line belongs with that proxy; leave it out when crhs is reached directly. The
`[webauthn]` values are the public hostname and origin of the WebUI; they must be set together, or
both omitted to derive them from each request's `Origin` header. Every key, its type, its default and
its validation are in the [crhs configuration reference](reference/crhs-config.md). A misspelled key
is a startup error, not a silently ignored line.

Keep the file readable by the service account but not by everyone, because a PostgreSQL URL
contains its password:

```sh
sudo chown root:crhs /etc/crhs/crhs.toml
sudo chmod 0640 /etc/crhs/crhs.toml
```

## Prepare the database

**SQLite.** The default database is `/var/lib/crhs/crhs.db`. The directory must exist and be
writable by the user that runs crhs; the file is created by the first command. SQLite runs in WAL
mode and is intended for one machine and a small team. Back it up as described in
[Backups and restore](operations.md#backups-and-restore).

**PostgreSQL.** Create one application role and one database owned by it; do not run crhs as a
superuser:

```sh
sudo -u postgres createuser --pwprompt crh
sudo -u postgres createdb --owner crh crh
```

Then configure the connection:

```toml
[database]
driver = "postgres"
url = "postgres://crh:secret@db.example.com/crh"
```

PostgreSQL 14 or newer is recommended. On every start crhs checks the compression of the
conversation records and enables lz4 when the server supports it; an older server logs a warning and
continues uncompressed.

Schema migrations run automatically at the start of every command, including `keys init` and
`user add`; there is no separate migrate command. Run one crhs process against one database: the
server keeps connection, task and scheduler state in memory.

## Initialize the master key

The master key encrypts the `secrets` table (the server identity key, the authorization signing key,
SSH credentials and model provider keys). It lives in a file, never in the database. Create it once,
on a fresh database:

```sh
sudo -u crhs node /opt/crh/server/src/main.ts keys init --config /etc/crhs/crhs.toml
```

The command writes `/etc/crhs/master.key` as 32 bytes of base64 with mode 0600 and prints:

```text
created /etc/crhs/master.key; back it up with "crhs keys export"
```

The key file must match the database. `keys init` writes the file first and binds the database to its
key id only after that; if the file already exists, the database is left untouched. If the database
already belongs to another key, the command removes the file it just wrote and fails. Restore the
file that matches the database, or start from a fresh database.

Back up the key as soon as the server has created its own keys. Start crhs once (see [Start
crhs](#start-crhs)), then export:

```sh
sudo -u crhs node /opt/crh/server/src/main.ts keys export \
  --out /var/lib/crhs/crhs-keys.age --config /etc/crhs/crhs.toml
sudo mv /var/lib/crhs/crhs-keys.age /root/
```

The export is an ASCII-armored age file encrypted with a passphrase you enter twice on a terminal.
It contains the master key and the decrypted values of the server identity key and the authorization
signing key, so keep it offline and treat it like the database itself. The command refuses to
overwrite an existing file and refuses an empty passphrase. Exporting before the first `serve` is
possible but contains no server keys yet, because they do not exist.

The master key file and the database are a pair: the database is useless without the key, and the
key is useless without the database. Back up both.

## Create the first administrator

There is no WebUI bootstrap page. Create the first administrator with the command line:

```sh
sudo -u crhs node /opt/crh/server/src/main.ts user add alice \
  --admin --display-name "Alice Example" --config /etc/crhs/crhs.toml
```

The password is read from the terminal with echo disabled and asked twice. When stdin is not a
terminal, one line is read instead, which is the scripting path:

```sh
printf '%s\n' "$PASSWORD" | sudo -u crhs node /opt/crh/server/src/main.ts user add alice --admin
```

A password must be at least 8 characters. Without `--admin` the user is a regular member. The
username is trimmed and lowercased and must match `^[a-z0-9][a-z0-9._-]{0,63}$`. The command prints
the kind, the username and the new user id:

```text
created admin alice (0192f000-0000-7000-8000-000000000002)
```

## Start crhs

Run the server in the foreground once to check the configuration:

```sh
sudo -u crhs node /opt/crh/server/src/main.ts serve --config /etc/crhs/crhs.toml
```

On success it prints one line with the address, the server identity fingerprint and the
authorization signing-key fingerprint:

```text
crhs listening on http://127.0.0.1:8080 (identity <base64url fingerprint>, signing key SHA256:…)
```

Open the WebUI through the reverse proxy (or `http://127.0.0.1:8080` for a local test) and sign in
as the administrator. `SIGINT` and `SIGTERM` start a graceful shutdown: crhs stops accepting
requests, ends open streams and waits for in-flight work, then closes the database. Shutdown is given
10 seconds; after that the process exits 1, and so does a second signal during shutdown. The process
does not reload `crhs.toml`; restart it to apply an edit.

## Reverse proxy and TLS

crhs does not terminate TLS. Put a reverse proxy in front of it, keep the default
`listen.host = "127.0.0.1"`, and let the proxy hold the certificate. The WebSocket connection from
crha still carries the Noise protocol end to end inside TLS, so a proxy that terminates TLS sees only
ciphertext for protocol frames; it cannot inject or read them.

An nginx example, with the `map` in the `http` block and the server block for the public hostname:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name crh.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name crh.example.com;

    ssl_certificate     /etc/letsencrypt/live/crh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crh.example.com/privkey.pem;

    # A task may carry 64 MiB of stdin or file content; the API accepts the
    # base64 form of that input, about 85 MiB.
    client_max_body_size 96m;

    location /agent {
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
        # Session events are server-sent events; buffering delays them.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

- **Real IP.** Set `real_ip_header = "X-Forwarded-For"` in `[listen]` so login rate limiting and the
  Cap challenge see the client address instead of the proxy. crhs uses the first non-empty element
  of the header and has no trusted-proxy list, so the proxy must overwrite a client-supplied header
  (`proxy_set_header X-Forwarded-For $remote_addr;` above). See
  [`[listen]`](reference/crhs-config.md#listen).
- **WebAuthn.** Passkeys require a secure context: serve the WebUI over HTTPS, or use
  `http://localhost` for a local test. `webauthn.rp_id` is a hostname, not a URL and not an IP
  address; `webauthn.origins` lists exact `scheme://host[:port]` origins, with the default port
  omitted. Set both or neither. A deployment reached by IP address cannot use Passkeys.
- **Cookies.** The `crh_session` cookie is `Secure` whenever the request's `Host` is not a loopback
  host, so a plain-HTTP public hostname cannot keep a login. Terminate TLS at the proxy and pass the
  public `Host` through.
- **Links.** Set `public_url` to the public base URL, such as `"https://crh.example.com"`, so that
  absolute links such as the approval and task links in MCP tool results use the public scheme and
  host. Without it crhs builds them from the request URL; behind a TLS-terminating proxy those links
  use `http://<Host>`, so keep the HTTP-to-HTTPS redirect for that case. See
  [`public_url`](reference/crhs-config.md#top-level-keys).
- **Long waits.** Session event streams send a ping every 15 seconds, and crha heartbeats at least
  every 45 seconds. The timeouts above leave room for both.

## Build crha

`crha` is one Go binary. Build it with CGO disabled so it is statically linked and runs on a node
without a matching libc:

```sh
cd /opt/crh/client
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o crha ./cmd/crha
file crha
```

`file` should say `statically linked`. `-trimpath` and `-s -w` are optional; `CGO_ENABLED=0` is the
flag that makes the binary static. To cross-compile for another architecture:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o crha-linux-arm64 ./cmd/crha
```

A development build reports `dev` and `unknown` in `crha version`. To stamp a release, add:

```sh
-ldflags "-s -w \
  -X github.com/Kodecable/ClusterRightHand/client/internal/version.Version=1.0.0 \
  -X github.com/Kodecable/ClusterRightHand/client/internal/version.Commit=0123abc"
```

Build on the node itself, or copy the resulting binary to it, then install it and create the node's
service account and directories:

```sh
sudo install -m 0755 crha /usr/local/bin/crha
sudo groupadd --system crha
sudo useradd --system --gid crha --home-dir /var/lib/crha --shell /usr/sbin/nologin crha
sudo install -d -o crha -g crha -m 0700 /var/lib/crha
sudo install -d -o root -g crha -m 0750 /etc/crha
```

## Enroll a node

1. In the WebUI open **Nodes** and choose **New node**. Give the node a name hint. crhs shows a
   one-time enrollment token and the command to run on the node. The token has the form
   `crh1.<server-key-fingerprint>.<secret>`, is valid for one hour and can be used once; it is shown
   only at creation.
2. Create the configuration file as root, so `/etc/crha` can stay owned by root and hold the
   privileged mode's file safely:

   ```sh
   sudo install -m 0640 -o root -g crha /dev/null /etc/crha/crha.toml
   sudoedit /etc/crha/crha.toml
   ```

   ```toml
   server = "https://crh.example.com"
   state_dir = "/var/lib/crha"
   ```

   Then run the enrollment as the user that will run tasks (the `crha` account above):

   ```sh
   sudo -u crha crha enroll --config /etc/crha/crha.toml \
     https://crh.example.com 'crh1.<fingerprint>.<secret>'
   ```

   `--config` is required. If the file does not exist, the WebUI's suggested command adds
   `--state-dir` and enroll writes a minimal file containing only `server` and `state_dir`; that
   works only when the `crha` user may write the directory. With the layout above the file already
   exists, so omit `--state-dir` (passing it for an existing file is an error). The command fetches
   the server's identity key over HTTPS, accepts it only when its fingerprint equals the one in the
   token, generates the node's identity key and writes `identity.key` and `server.pub` under the
   state directory. It prints the node id and the node key fingerprint:

   ```text
   enrolled as node 0192f000-0000-7000-8000-000000000001, waiting for approval
   node key fingerprint: <base64url fingerprint>
   ```

3. Start the agent. Until an administrator approves the node it keeps a restricted connection and
   receives no tasks:

   ```sh
   sudo -u crha crha run --config /etc/crha/crha.toml
   ```

   The `crha.toml` above has no `[privileged]` table, which means `reject`. Ordinary tasks work;
   privileged tasks are refused. Add the table for the mode you want; see
   [`crha.toml`](reference/crha-config.md#privileged).

4. On a `forward` node, also run the privileged mode as root:

   ```sh
   sudo crha privileged run --config /etc/crha/privileged.toml
   ```

   It needs `[privileged].mode = "forward"` and a `privileged.toml` with a trust entry; the
   [service section](#run-as-a-service) has a unit and a minimal file. Skip this process for
   `native`, `ignore` and `reject`.

## Approve a node

The new node appears in **Nodes** as **Pending approval**. On the node, read the fingerprint:

```sh
crha status --config /etc/crha/crha.toml
```

It prints the derived server URL, the node key fingerprint and the privileged mode. Compare the
hostname and the fingerprint with the pending node in the WebUI, then choose **Approve**.
Approving is administrator-only. A rejected node's key is deleted, and the node must enroll again.

Approval is the only gate: after it the node is active and can receive tasks. Deleting the node
later removes its public key; the next handshake fails and an established connection is closed. See
[Node registration](../design/protocol.md#node-registration).

## Add an SSH node

An SSH node needs no `crha`; crhs connects to it over SSH. The server must be able to reach the
target's SSH port, and any jump host's.

1. **Create a credential.** Open **SSH credentials** and create one. crhs generates an ed25519 key
   pair, keeps the private key encrypted with the master key and shows the public key. Add that
   public key to the target user's `authorized_keys` on every hop, including jump hosts.
2. **Create the node.** On **Nodes**, choose **New SSH node** and follow the wizard: select the
   credential, describe the route (jump hosts first, then the target address, port and user), then
   pin each hop's host key. The wizard shows the fingerprint of the first hop that is not pinned yet
   in the `SHA256:…` form of `ssh-keygen -lf`; verify it on that host before you pin it, then probe
   the next hop. Every hop must be pinned before the node can be created.
3. **Test the route.** The saved node's page has **Test connection**, which authenticates hop by hop
   against the pinned keys and runs `true` on the target. It catches a public key that was not
   installed and an account that cannot run commands (`ForceCommand`, `nologin`, a restricted
   shell).
4. **Organize it.** Add the node to node groups on its page, exactly as for a crha node, and grant
   access to users or user groups.

The remote account needs a POSIX-style login shell (bash, zsh, dash, ash or ksh), `sh`, `env` and
the SFTP subsystem for file tasks. A task runs as the SSH user; the `privileged` flag is ignored and
there is no trust configuration. See [Adding an SSH
node](../design/execution.md#adding-an-ssh-node).

## Configure a model provider

The agent needs at least one model. Model settings are administrator-only.

1. Open **Admin → Models**.
2. Choose **New provider**.
3. Pick a kind:
   - **Pi built-in** selects one of the providers the agent library knows. Enter its API key and,
     optionally, a base URL. Only API-key authentication is supported.
   - **Custom** takes a base URL, an API key, optional extra request headers and session-id fields.
     Add each model in the nested dialog: id, display name, protocol (Chat Completions or
     Responses), context window, maximum output tokens, image understanding, thinking levels and a
     `compat` object.
4. Save. The provider's models appear in the session composer and in the model presets.

The three model presets — Session, Auto Review and Title generation — are on the same page. They are
optional: without them the session uses its own model, and Auto Review falls back to the session's or
schedule's model. See [Models page](../design/webui.md#models-page) and [Model
presets](../design/agent-runtime.md#model-presets).

## Run as a service

The units below are examples, not shipped with the repository. Adjust the paths, the Node.js path
and the binary paths to your installation, then `systemctl daemon-reload` and enable them.

**crhs.**

```ini
# /etc/systemd/system/crhs.service
[Unit]
Description=ClusterRightHand server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=crhs
Group=crhs
WorkingDirectory=/opt/crh
ExecStart=/usr/bin/node /opt/crh/server/src/main.ts serve --config /etc/crhs/crhs.toml
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=-/var/lib/crhs

[Install]
WantedBy=multi-user.target
```

crhs has no reload signal; `systemctl restart crhs` applies a configuration edit.

**crha, unprivileged mode.**

```ini
# /etc/systemd/system/crha.service
[Unit]
Description=ClusterRightHand node agent (unprivileged)
After=network-online.target crha-privileged.service
Wants=network-online.target
# Requires=crha-privileged.service   # only when [privileged].mode = "forward"

[Service]
Type=simple
User=crha
Group=crha
ExecStart=/usr/local/bin/crha run --config /etc/crha/crha.toml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

**crha, privileged mode.** Only for `[privileged].mode = "forward"`; skip it for `native`, `ignore`
and `reject`.

```ini
# /etc/systemd/system/crha-privileged.service
[Unit]
Description=ClusterRightHand node agent (privileged)
After=network-online.target
Wants=network-online.target
Before=crha.service

[Service]
Type=simple
User=root
RuntimeDirectory=crha
RuntimeDirectoryMode=0755
ExecStart=/usr/local/bin/crha privileged run --config /etc/crha/privileged.toml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
LimitNOFILE=65536
UMask=0077

[Install]
WantedBy=multi-user.target
```

The privileged unit runs as root, so its `privileged.toml`, `state_dir` and `log` paths must be
root-owned and not writable by others. `RuntimeDirectory=crha` creates `/run/crha` owned by
root with mode 0755; the socket is created there with mode 0660 and the group from `socket_group`
(default `crha`), which is how the unprivileged mode connects. Create the `crha` group before
starting it.

A minimal `privileged.toml` for `forward`:

```toml
# /etc/crha/privileged.toml
node_id = "0192f000-0000-7000-8000-000000000001"   # the id printed by crha enroll
unprivileged_uid = 998                              # id -u crha
socket = "/run/crha/privileged.sock"
state_dir = "/var/lib/crha/privileged"
log = "/var/log/crha/privileged.jsonl"
clock_skew = "60s"

[[trust]]
name = "crhs"
role = "crhs"
format = "sshsig"
key = "ssh-ed25519 AAAA…"        # the crhs signing key shown in the WebUI
kinds = ["execute"]
```

The trust entry is what makes crhs able to authorize a task on this node. The WebUI's node page
shows the signing key and can export a trust fragment; every field is in the
[privileged configuration reference](reference/privileged-config.md).

## Troubleshooting the installation

- **`crhs: /etc/crhs/crhs.toml: ENOENT`** — the configuration path is wrong or the file was not
  created. The default is `/etc/crhs/crhs.toml`; pass `--config` before or after the command.
- **`cannot create /etc/crhs/master.key: the directory does not exist`** — create `/etc/crhs` first.
  The same applies to the SQLite directory: crhs creates the database file, not its parent.
- **`master key file … must not be accessible by group or others`** — `chmod 600` the key file, and
  make sure the service account owns it.
- **`the master key file does not belong to this database`** — the key file and the database come
  from different installations. Restore the matching key file, or start from a fresh database; do
  not run `keys init` again on the same database.
- **The WebUI is blank or returns 404** — `web/dist` is missing or `web_root` points elsewhere. Run
  `pnpm --filter @crh/web build` and check `web_root`.
- **`pnpm install` fails on `re2`** — the native module could not be downloaded or built. Install a
  C++ toolchain or set `RE2_DOWNLOAD_MIRROR`, then run `pnpm install` again. crhs will not start
  without it.
- **`crha: … identity.key …`** — the node is not enrolled, or the state directory is wrong. Run
  `crha enroll`, or point `state_dir` at the directory that holds `identity.key`.
- **`protocol_major mismatch`** — crhs and crha were built from different protocol majors. Rebuild
  and redeploy both; there is no compatibility layer across majors.
- **A PostgreSQL URL fails with an authentication or schema error** — check that the role owns the
  database, that the URL's database exists, and that the role may create tables. Migrations run on
  the first command and need DDL rights.
