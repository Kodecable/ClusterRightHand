# Installing ClusterRightHand

crhs runs on the server host; crha runs on each node that is not reached over SSH.

## Prerequisites

| Requirement | For |
|---|---|
| glibc Linux, amd64 or arm64 | crhs and crha |
| The system libraries the bundled Node needs, such as `libatomic.so.1` on a minimal system | The crhs tar with Node; `install.sh` refuses when the bundled Node cannot start (`ldd node/bin/node`) |
| Node.js 24.7 or newer and npm | The crhs tar without Node |
| SQLite (built in) or PostgreSQL 14+ | The database ([choosing](operations.md#sqlite-and-postgresql)) |
| A reverse proxy with TLS | Anything beyond a local test; crhs speaks plain HTTP |
| Network from each node to crhs | crha nodes connect to crhs, never the other way |
| SSH from crhs to each SSH node and its jump hosts | SSH nodes only |

## Verify a release

The release workflow signs the checksums and the image. Verify the `SHA256SUMS` of a release before
using it:

```sh
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github.com/Kodecable/ClusterRightHand/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum -c SHA256SUMS --ignore-missing
```

`SHA256SUMS` also lists each crha binary under its path in the unpacked archive
(`crha-<version>-linux-<arch>/crha`), the hash a crha self-upgrade asks you to sign; the same command
checks it once the archive is unpacked next to `SHA256SUMS`.

`gh attestation verify <file> --repo Kodecable/ClusterRightHand` checks a download's build provenance
instead.

The container image is signed the same way:

```sh
cosign verify ghcr.io/kodecable/crhs:<version> \
  --certificate-identity-regexp '^https://github.com/Kodecable/ClusterRightHand/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Install crhs

### Tar with Node

Download `crhs-<version>-linux-<arch>.tar.gz` and the `SHA256SUMS` of the same release, then verify,
unpack and install:

```sh
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf crhs-<version>-linux-<arch>.tar.gz
cd crhs-<version>-linux-<arch>
sudo ./install.sh
```

`install.sh` installs this version under `/opt/crhs/versions/`, points `/opt/crhs/current` at it and
links `/usr/local/bin/crhs`. On a new host it runs `crhs init` on a terminal, or prints the command;
when `/etc/crhs/crhs.toml` already exists it only reminds you to restart crhs.

`install.sh` installs the files owned by root and not writable by group or others. Running it again for
a version that is already installed keeps that directory and only updates the links.

### Container image

The image (`ghcr.io/kodecable/crhs:<version>` in these examples) runs as uid 1000 and keeps all state
under `/crhs-data`, so mount one volume there that uid 1000 can write. With a host directory:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /srv/crhs
sudoedit /srv/crhs/init.json
sudo chown 1000:1000 /srv/crhs/init.json
sudo chmod 600 /srv/crhs/init.json
sudo podman run -d --name crhs -p 8080:8080 -v /srv/crhs:/crhs-data ghcr.io/kodecable/crhs:<version>
```

The first start runs `crhs init` from `/crhs-data/init.json`. Without that file, start the container with
`-it` to answer the questions. With no terminal, every question must be answered in the file, including
the listen address; `service.install` must be `false`.

```json
{
  "version": 1,
  "listen": { "host": "0.0.0.0", "port": 8080 },
  "database": { "driver": "sqlite", "path": "/crhs-data/crhs.db" },
  "public_url": "https://crh.example.com",
  "admin": {
    "username": "admin",
    "display_name": "Admin",
    "password": "change-me"
  },
  "service": { "install": false }
}
```

Delete `init.json` after the first start: it holds the administrator's password.

Run further crhs commands in the running container, or pass the command to the image:

```sh
sudo podman exec -it crhs node /opt/crhs/crhs.mjs user add alice --config /crhs-data/crhs.toml
sudo podman run --rm -it -v /srv/crhs:/crhs-data ghcr.io/kodecable/crhs:<version> user add alice --config /crhs-data/crhs.toml
```

### Tar without Node

Unpack it where it will stay and where the `crhs` user can read it, for example `/opt/crhs`, then install
the dependencies and initialize:

```sh
sudo mkdir -p /opt/crhs
sudo tar -xzf crhs-<version>.tar.gz -C /opt/crhs
cd /opt/crhs/crhs-<version>
sudo npm ci --omit=dev
sudo node crhs.mjs init
```

Serve with `sudo -u crhs node crhs.mjs serve` from that directory, or with the unit `init` installed.

## crhs init

On a host install, run it as root. It asks:

| Question | Default |
|---|---|
| Listen address | `127.0.0.1` (`0.0.0.0` in the container) |
| Listen port | `8080` |
| Database | SQLite |
| SQLite file | `/var/lib/crhs/crhs.db` |
| PostgreSQL URL | — (tested when entered) |
| Public URL | empty |
| Administrator username | `admin` |
| Administrator display name | the username |
| Administrator password | — |
| Install and start the systemd service | yes |

It shows a summary and asks before changing anything. It then creates the `crhs` system user, `/etc/crhs`
and `/var/lib/crhs`, writes `crhs.toml`, creates the master key and the administrator, prepares the
database, stores the public URL, and, unless you decline, installs and starts `crhs.service`. Every step
already done is skipped, so an interrupted run can be repeated.

### Answers files

`--answers <file>` answers the questions ahead with one strict JSON object, version 1; unknown fields and
wrong types are errors. A question the file leaves out is asked on a terminal and is an error without
one, naming every missing answer. A file holding the administrator's password must be readable only by
its owner (`chmod 600`). `--save-answers <file>` writes an interactive run's answers without the secrets.

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 8080 },
  "database": { "driver": "sqlite", "path": "/var/lib/crhs/crhs.db" },
  "public_url": "https://crh.example.com",
  "admin": {
    "username": "admin",
    "display_name": "Admin",
    "password": "change-me"
  },
  "service": { "install": true, "start": true }
}
```

For PostgreSQL, answer `"database": { "driver": "postgres", "url": "postgres://crh:secret@db.example.com/crh" }`
instead.

`crhs init` ends with three reminders: back up the master key together with the database, take a key
export ([Backups and restore](operations.md#backups-and-restore)), and put a reverse proxy with TLS in
front of crhs.

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

## Install crha

### Tar

Download `crha-<version>-linux-<arch>.tar.gz`, unpack it and run the installer:

```sh
tar -xzf crha-<version>-linux-<arch>.tar.gz
cd crha-<version>-linux-<arch>
sudo ./install.sh
```

`install.sh` puts `crha` in `/usr/local/bin`. On a new node it runs `crha enroll` on a terminal, or prints
the command; when `/etc/crha/crha.toml` already exists it only reminds you to restart crha.

### deb and rpm

The rpm packages are signed; import the key once, then install:

```sh
sudo rpm --import https://raw.githubusercontent.com/Kodecable/ClusterRightHand/main/packaging/RPM-GPG-KEY-crh
sudo apt install ./crha_<version>_<arch>.deb
sudo dnf install ./crha-<version>-1.<rpmarch>.rpm
```

A package-managed crha is updated by the package manager only. On a first install, enroll the node as below.

## Install crhu

`crhu` is the signing utility for a workstation, not for a node. Install the archive or the package for
your architecture:

```sh
tar -xzf crhu-<version>-linux-<arch>.tar.gz
sudo install -m 0755 crhu-<version>-linux-<arch>/crhu /usr/local/bin/crhu

sudo apt install ./crhu_<version>_<arch>.deb
sudo dnf install ./crhu-<version>-1.<rpmarch>.rpm
```

It uses the workstation's `ssh-keygen` and ssh-agent, so no key material is stored by `crhu`:

- `crhu sign --payload '<payload from the WebUI>' [--hint SHA256:…]…` signs an authorization request;
- `crhu grant --nodes … --deadline … [--method … --exact/--prefix …]` builds and signs an offline
  authorization for a scheduled or repeated task;
- `crhu register '<challenge from Signing credentials>'` signs the proof that registers an SSH signing
  credential; the WebUI takes the printed signature.

`--key` names the key file exactly; without it `crhu` considers ssh-agent, `~/.ssh/*.pub`,
`~/.crhu/keys/*.pub`, the directories in `CRHU_KEY_DIRS` and each `--key-dir`, and `--hint` picks
one by fingerprint. See the
[command-line reference](reference/cli.md#crhu) for every flag.

## Enroll a node

1. In the WebUI, open **Nodes** and choose **New node**; it shows `sudo crha enroll`, the crhs address,
   the one-time token and when the token expires.
2. On the node, run:

   ```sh
   sudo crha enroll
   ```

   It asks:

   | Question | Default |
   |---|---|
   | Enroll again with a new key (only when already enrolled) | no |
   | crhs address (not when keeping the enrollment) | the current one, if any |
   | Enrollment token (not when keeping the enrollment) | — |
   | Check the TLS certificate against the system CAs | the current setting, else yes (the token authenticates crhs either way) |
   | Privileged mode (`ignore` or `forward`) | the current mode, else `ignore` |
   | Keep the current trust entries (forward, `privileged.toml` exists) | yes |
   | Let local root open the local approval window (forward, new trust entries) | yes |
   | Trust entries (forward, new trust entries) | empty, configured later |
   | Start the services | yes |

   For `forward`, paste the entries from **Signing credentials** → **Generate trust config**, ending
   with a line `.`; an empty answer leaves them for later. Local root approval lets uid 0 open the
   local approval window with `crha approve --for`; add other uids to the `local` entry later.

   It creates the `crha` user and group, `/etc/crha`, `/var/lib/crha`, `crha.toml`, the enrolled keys
   and, for `forward`, `privileged.toml` and `/var/lib/crha-privileged`; writes and starts
   `crha.service`, plus `crha-privileged.service` for `forward`; and prints the node id and key
   fingerprint.
3. Approve the node (below), comparing the fingerprint.

If the node was enrolled before, `crha enroll` asks first whether to enroll again with a new key:
answering no keeps the enrollment and needs no token. To give it a new key, use **Re-enroll** on the
node's page, not **New node** ([Rotating and revoking node
keys](operations.md#rotating-and-revoking-node-keys)).

Run again on a node set up before, `crha enroll` offers the current settings as defaults, and a
different answer switches the node: it edits `/etc/crha/crha.toml` in place, keeping your comments, and
writes or removes `crha-privileged.service`. With `privileged.toml` present, it asks whether to keep the
current trust entries, naming them; answering no replaces them with pasted ones and leaves the rest of
the file as it is. The crhs address changes only by enrolling again with a token from the new crhs.
When anything changes, it stops the services first, backs the files up to
`/var/lib/crha-upgrade/backups/enroll-<time>/` (printing the directory) and starts the services again
afterwards; a failed run starts them again too.

`--answers` and `--save-answers` work as in `crhs init`; a file holding the token must be readable only by
its owner. On an enrolled node the `replace` answer is also required, and `forward` adds
`privileged.local_root` and `privileged.trust` when `privileged.toml` does not exist yet. The file's
values switch the node as the answers to the questions do.

```json
{
  "version": 1,
  "server": "https://crh.example.com",
  "token": "…",
  "tls_verify": "system",
  "privileged": { "mode": "ignore" },
  "service": { "start": true }
}
```

For a manual layout, `crha register --config <file>` only registers the node: the token is read from
standard input, and `--replace` re-enrolls.

## Approve a node

The node appears in **Nodes** as pending. Run `crha status --config /etc/crha/crha.toml` on the node and
compare its hostname and key fingerprint with the WebUI, then choose **Approve**. A rejected node must
enroll again.

## Privileged tasks

`crha enroll` offers `ignore` and `forward`; `native` and `reject` are set by editing `[privileged] mode`
in `/etc/crha/crha.toml` and restarting `crha` ([choosing a mode](security.md#choosing-a-privilege-mode)).
`native` also needs this sudoers rule, with the path the crha binary was installed to (`/usr/bin/crha`
for deb and rpm, `/usr/local/bin/crha` for the tar):

```text
crha ALL=(root) NOPASSWD: /usr/bin/crha privileged stdio
```

For `forward`, `crha enroll` writes `/etc/crha/privileged.toml` with the trust entries you pasted. To
switch an enrolled `ignore` node to `forward`, re-enroll it with a **Re-enroll** token and answer
`forward`: `crha enroll` edits `crha.toml`, asks the local root and trust questions and writes
`privileged.toml` (it needs the node id, which only enrollment returns) and `crha-privileged.service`.
A node whose `privileged.toml` already exists switches without re-enrolling.
To change the trust entries later, edit the file and reload the privileged mode:

```sh
sudoedit /etc/crha/privileged.toml
sudo systemctl reload crha-privileged
```

The privileged mode keeps its used list in `/var/lib/crha-privileged` (root, 0700), outside crha's own
state directory, and refuses a state directory below a directory crha can modify.

The **Signing credentials** page generates trust entries. All fields are in the
[privileged configuration reference](reference/privileged-config.md).

## Add an SSH node

1. Open **SSH credentials** and create a credential for each account the route reaches (or reuse one).
   Install its public key in the target user's `authorized_keys` on the hops that use it.
2. On **Nodes**, choose **New SSH node**, enter the route (jump hosts first, then the target), pick
   each hop's credential, and pin each hop's host fingerprint after checking it on that host
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
3. Use **Test connection** on the node page to check the route.
4. To change the route or a hop's credential later, use **Edit route** on the node page. Changed hops
   must be probed and confirmed again; after a host is reinstalled (`host_key_mismatch`), use
   **Re-probe** on that hop.

The target account needs a POSIX login shell (bash, zsh, dash, ash or ksh) and the SFTP subsystem.
Tasks run as that account; SSH nodes cannot run privileged tasks.

## Configure a model provider

Open **Models** (administrators only) and choose **New provider**:

- **Pi built-in**: choose a known provider and enter its API key.
- **Custom**: enter the base URL and API key of any endpoint that speaks the Chat Completions or
  Responses protocol, then add its models.

The model presets on the same page are optional.

## Run as a service

`crhs init` and `crha enroll` write the units and mark them managed. Do not edit them; customize them
with drop-ins:

```sh
sudo systemctl edit crhs          # or crha, crha-privileged
```

The units are `crhs.service`, `crha.service` and `crha-privileged.service` (forward mode only). Restart a
service after changing its configuration or unit.

## Outbound proxy

crhs reads `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, and their lower-case forms, at startup; there is
no `crhs.toml` option. When both forms are set the lower-case name wins, as in Node. `HTTP_PROXY` covers
`http://` targets, `HTTPS_PROXY` covers `https://` and `wss://` targets, so set both when crhs talks to
both kinds. `NO_PROXY` is a comma-separated list: `*` bypasses every proxy, `example.com` matches that
host, `.example.com` and `*.example.com` match its subdomains, `example.com:8080` adds a port, and
`localhost` and `127.0.0.1` are different entries.

For a systemd install, set them in a drop-in:

```sh
sudo systemctl edit crhs
```

```ini
[Service]
Environment=HTTPS_PROXY=http://proxy.internal:3128
Environment=NO_PROXY=llm.internal,.svc.cluster.local,localhost,127.0.0.1
```

For the container, pass the same variables to `podman run` with `-e`, or put them in the unit that
starts it. A restart applies a change.

At startup crhs logs one line with the effective proxy URLs and the `NO_PROXY` list; credentials in a
proxy URL are removed. An invalid proxy URL stops startup.

crhs applies the proxy to the HTTP clients it creates:

| Traffic | Proxied |
|---|---|
| pi-ai model providers, and model discovery on `GET <base>/models` | Yes; the Bedrock adapter reads the variables itself |
| models.dev catalogue download | Yes |
| crha release download and the Sigstore TUF repository | Yes |
| MCP extensions (streamable HTTP and SSE) | Yes |
| Telegram Bot API | Yes |
| Satori API and its WebSocket | Yes |
| WebDAV library backend | Yes |
| crha to crhs control and data connections | On the node, through Go's `ProxyFromEnvironment` |

Not covered:

- **SOCKS and PAC proxies.** Node's built-in proxy support accepts an `http://` or `https://` proxy URL
  only.
- **AWS credential-chain lookups.** With Bedrock profile or role credentials, the AWS SDK resolves
  SSO, STS and instance credentials with its own HTTP agents, which do not read these variables; the
  Bedrock API call itself is proxied. Static credentials or a bearer token avoid those lookups.
- **Inbound traffic and SSH.** Connections from crha nodes and browsers to crhs, and crhs's SSH
  connections, do not use these variables.

Put internal services in `NO_PROXY` so they are not sent to the proxy: an internal model gateway, a
WebDAV backend, a Satori gateway on localhost. The node's `crha` service reads the same variables for
its connection to crhs, so give it the same `NO_PROXY` entry for crhs's address; a proxy between crha
and crhs must support `CONNECT` for the WebSocket.

## Building from source

For development, from a checkout:

```sh
pnpm install
pnpm build:crhs
pnpm package
cd client && CGO_ENABLED=0 go build -o crha ./cmd/crha
```

`pnpm package` writes the archives and the deb and rpm packages to `dist/release`. See
[Distribution and setup](../design/distribution.md).

## Troubleshooting the installation

| Symptom | Cause |
|---|---|
| `ENOENT` for `crhs.toml` | Wrong path; pass `--config`. |
| `install.sh: the bundled Node cannot start on this system` | A missing system library; check `ldd node/bin/node` and install what is missing, such as `libatomic1`. |
| The container exits with `crhs.toml is missing` | The first start found neither `/crhs-data/init.json` nor a terminal. Provide the answers file or start with `-it`. |
| `missing answers for …` | The answers file leaves questions out and there is no terminal. Add the named fields. |
| `contains a secret and must not be accessible by group or others` | `chmod 600` the answers file. |
| `the master key file does not belong to this database` | The key and the database come from different installations. Restore the matching key file. |
| The WebUI returns 404 | `web_root` points elsewhere; a packaged crhs serves the bundled WebUI without it. |
| `npm ci` fails on `re2` | Install a C++ toolchain or set `RE2_DOWNLOAD_MIRROR`. |
| `does not verify: no signature` from `dnf` | The rpm signing key is not imported; import it as in [deb and rpm](#deb-and-rpm). |
| crha reports a missing `identity.key` | The node is not enrolled, or `state_dir` is wrong. |
| `protocol_major mismatch`, or crha logs `crhs does not serve protocol major` | crhs and crha come from incompatible versions. Upgrade crhs first; it upgrades nodes of a major it still serves. A node outside that window is upgraded by hand. |
| PostgreSQL authentication or permission errors | The role must own the database and be allowed to create tables. |
