# Privileged system tests (podman)

`server/test/system/privileged` is the only layer that runs privileged execution against a real operating
system: a real `crha privileged run` as root, a real `crha run` as a non-privileged user, real `sudo` /
`doas`, and a real `sshd`. The crhs side is the in-process server from `server/test/e2e/harness.ts`.

The suite is gated by `CRH_TEST_PODMAN=1` and skips cleanly when podman is unavailable. It is **not** part
of CI.

## What one container is

One container is one node:

- a real `crha privileged run` as root, listening on `/run/crha/privileged.sock`;
- a real `crha run` as uid/gid 998 (`crha`), connecting out to the in-process crhs;
- an `sshd` on loopback for the SSH-node tests, enabled per test.

The image is `ubuntu:24.04` plus `openssh-server`, `sudo`, `opendoas`, `ca-certificates` and `util-linux`.
It contains no Go toolchain: the host builds a static `crha` with `CGO_ENABLED=0` and the harness
bind-mounts it at `/usr/local/bin/crha`, so the sudoers/doas rules can name the final path:

```text
crha ALL=(root) NOPASSWD: /usr/local/bin/crha privileged stdio
permit nopass crha as root cmd /usr/local/bin/crha args privileged stdio
```

The image tag is the SHA-256 prefix of `Containerfile`, `entrypoint.sh`, `privctl.sh` and
`fixtures/sshd_config`, so editing any of them rebuilds the image once. The image is left in the local
store afterwards; containers are removed by each test file.

### Mounts

| Host | Container | Purpose |
|---|---|---|
| `<temp>/config` | `/etc/crha` (rw) | `crha.toml`, `privileged.toml`, `.ready`; written by the test |
| `<temp>/ssh` | `/opt/crh/ssh` (ro) | sshd host key, `authorized_keys`, client key |
| the built `crha` | `/usr/local/bin/crha` (ro) | one binary for both modes |

Node state (identity key, `used` / `revoked` lists, output files, logs) stays inside the container. That is
why restarting the privileged mode does not lose the authorization state.

### Network and boot

The container runs with `--network=host` and `--init`. The container's crha connects to
`127.0.0.1:<crhs port>`; the in-process crhs connects to the container's sshd. The sshd port defaults to
2222 and the harness picks a free port on the host, passing it as `PRIV_SSH_PORT`; tests that do not need
sshd start the container with `PRIV_NO_SSHD=1`.

`entrypoint.sh` starts sshd, then waits for `/etc/crha/.ready` (written by the test after `crha enroll` and
after `privileged.toml` exists), then starts the privileged mode and the non-privileged crha. On SIGTERM it
stops them in reverse order. There is no systemd.

Tests control the processes through `podman exec /usr/local/bin/privctl.sh`:

```text
start-priv | stop-priv | restart-priv | hup-priv
start-crha | stop-crha | restart-crha
start-sshd | stop-sshd | start-all | stop-all
reset-priv-state     # delete used / revoked, back to a clean authorization state
wait-priv-socket | status
```

## Running

```bash
# the whole matrix (rootless podman and Go required)
CRH_TEST_PODMAN=1 GOCACHE=$PWD/.gocache pnpm test:system

# one file
CRH_TEST_PODMAN=1 pnpm --filter @crh/server exec vitest run test/system/privileged/forward.test.ts
```

Without `CRH_TEST_PODMAN=1`, or when `podman version` fails, every file in the suite is skipped. The four
files run serially (`--no-file-parallelism`), because each one creates containers and enrolls nodes. A full
run takes about a minute once the image exists; the first run also builds the image.

Each file creates its own containers, enrolls the node, approves it, writes the trust configuration and
removes the containers in `afterAll`. The image is kept for the next run.

## What it covers

The suite is the system-level counterpart of the unit tests in `server/test/privilege-*.test.ts`. The
capability matrix is:

| Capability | Where |
|---|---|
| `native` with sudo: exec and file as root, cancel, timeout, helper failure | `native.test.ts` "native with sudo" |
| `native` with doas: exec as root, `privileged_unsupported` when doas does not allow the helper | `native.test.ts` "native with doas" |
| `ignore` / `reject`: privileged tasks run as the caller or are refused before acceptance; ordinary tasks unaffected | `native.test.ts` "ignore", "reject" |
| exec environment: the account's identity, fixed `PATH`, discovered shell, `HOME` override | `native.test.ts`, `forward.test.ts` |
| `forward` with a crhs-signed authorization: exec and file as root; ordinary tasks stay on the non-privileged path | `forward.test.ts` "crhs-signed authorizations" |
| A node that only trusts the user: nothing runs without the owner's signature; `crha grant` makes it run; an unregistered key is refused | `forward.test.ts` "a node that only trusts the user" |
| `require-cosign`: a user signature must carry crhs's cosignature | `forward.test.ts` "require-cosign" |
| Local approval: `crha pending` / `approve` / `deny`; re-registration after a privileged-mode restart; survival across a non-privileged disconnect; fallback from a refused crhs signature with `attempt + 1` | `forward.test.ts` "local approval" |
| Revocation, one-shot replay, persistent `used` list, local `revoke` | `forward.test.ts` "revocation, one-shot replay and the used list" |
| Guard rules: symlink read refused, unnormalized path refused, shell command cannot hide behind a prefix rule, `env_allow` honoured | `forward.test.ts` "path, env and prefix attempts" |
| Trust digest: changes on reload, a waiting task is re-planned, `privileged_unavailable` while the daemon is away | `forward.test.ts` "trust digest, re-planning and privileged_unavailable" |
| SSH nodes: `privileged` is ignored, a notice goes to stderr, SFTP file tasks still work, the SSH user's identity is kept | `ssh.test.ts` |
| Task groups: one user signature covers several nodes; a refused node retries alone; a group whose only path is local approval fails | `groups.test.ts` |

## Failure injection

Two paths need a deliberately broken state:

- **crhs signature refused by crha**: the crhs trust entry uses `max_ttl = "1ms"` and `clock_skew = "0s"`;
  the test SIGSTOPs the privileged mode for 300 ms, so the authorization has expired when it arrives
  (`authorization_expired`), and crhs falls back to local approval with `attempt + 1`.
- **One node of a group refuses**: node B's `privileged.toml` names a `node_id` that is not its real id.
  The shared payload is built from crhs's real ids, so A accepts and B is refused at the validation step.
  B then waits alone with `attempt + 1`; after the id is fixed, only B is re-signed.

## Limits

- Linux and rootless podman only; `--network=host`, uid 998 and a free sshd port are assumed.
- Not in CI. Run it before a release that touches privilege, the Go client, or the protocol.
- WebAuthn is covered at the API/unit level with a software authenticator; no real device is used here.
- `crha grant` is exercised with plain ed25519 keys, not encrypted keys, ssh-agent or a FIDO key.
- `run0` is experimental and not part of the matrix.
- Containers are per test file and removed afterwards; the image is not.
