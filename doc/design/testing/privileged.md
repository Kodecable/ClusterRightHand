# Privileged system tests

`server/test/system/privileged` is the only layer that exercises privileged execution against a real
operating system. Each node is one podman container running a real `crha privileged run` as root, a real
`crha run` as an unprivileged user, real `sudo` and `doas`, and an sshd for the SSH tests. crhs is the
in-process server from the end-to-end harness. The suite runs only with `CRH_TEST_PODMAN=1`; CI runs it
in the `system` job, and it is worth running before releases that touch privilege, the Go client or the
protocol.

The container image contains no Go toolchain. The host builds a static `crha` and mounts it into the
container. The image is rebuilt automatically when its files change. Node state stays inside the
container, so restarting the privileged mode keeps its used list as on a real node. Tests start, stop,
restart and reload the processes inside the container through a control script.

## Coverage

- `native` with sudo and doas, including cancellation, timeouts and a helper that the tool refuses;
- `ignore` and `reject`;
- the task environment: identity, fixed `PATH`, discovered shell;
- `forward` with crhs-signed authorizations, with user-only trust and `crhu sign`, and with required
  cosignatures: a cosign ticket for each use of a one-shot and of a reusable authorization;
- the local approval window: opening it releases a crhs-signed task the crhs entry denies, it closes
  with `crha lock` and does not survive a privileged-mode restart, and `max_window` caps it;
- one-shot replay protection and the persistent used list;
- guard rules against symlinks, unnormalized paths, shell commands hiding behind a prefix rule, and
  environment variables;
- trust digest changes, authorization syncs, and an unavailable privileged mode;
- SSH nodes ignoring the privileged flag;
- task groups signed once, a refusing node retrying alone, and groups that wait for a local window.

Two cases are provoked deliberately: a crhs authorization that expires before it arrives (to test the
fallback), and one node of a group configured with the wrong node id (to test a partial refusal).

## Self-upgrade under systemd

`server/test/system/upgrade` upgrades crha against real systemd: each node is a container whose PID 1
is systemd (`podman run --systemd=always`, rootless), set up with `crha enroll` exactly as on a host,
so the units, the crha user and the directories are the real ones. The host builds crha 1.2.0 and 1.3.0
with `-ldflags -X` version strings; the node starts on 1.2.0, and crhs (reporting 1.3.0) has the 1.3.0
archive in its release cache with downloads and verification off. It covers:

- a `forward` node upgraded through `POST /api/nodes/upgrade`, then rolled back with
  `crha upgrade rollback`, after which a second rollback is refused;
- a `native` node upgraded;
- the installer's own rollback, with a 1.3.0 built never to log its readiness line and with a 30-second
  readiness wait instead of 120 (the test-only `agent.testNeverReady` and `upgrade.testReadyTimeout`
  linker variables);
- an `ignore` node whose crha runs as root through a drop-in, upgraded with the drop-in kept;
- an `ignore` node as enroll sets it up, running as the crha user, skipped with `no_privilege`.

It also runs with `CRH_TEST_PODMAN=1`, in the same `system` job. The image is built from
`server/test/system/upgrade/Containerfile` and rebuilt when it changes.

## Limits

- Linux and rootless podman only.
- WebAuthn is tested with a software authenticator only; real platform authenticators and hardware keys
  are not.
- `crhu sign` and `crhu grant` are tested with plain Ed25519 keys, not encrypted keys, an agent or a FIDO key.
- `run0` is not tested.
