# Privileged system tests

`server/test/system/privileged` is the only layer that exercises privileged execution against a real
operating system. Each node is one podman container running a real `crha privileged run` as root, a real
`crha run` as an unprivileged user, real `sudo` and `doas`, and an sshd for the SSH tests. crhs is the
in-process server from the end-to-end harness. The suite runs only with `CRH_TEST_PODMAN=1` and is not
in CI; run it before releases that touch privilege, the Go client or the protocol.

The container image contains no Go toolchain. The host builds a static `crha` and mounts it into the
container. The image is rebuilt automatically when its files change. Node state stays inside the
container, so restarting the privileged mode keeps its used list as on a real node. Tests start, stop,
restart and reload the processes inside the container through a control script.

## Coverage

- `native` with sudo and doas, including cancellation, timeouts and a helper that the tool refuses;
- `ignore` and `reject`;
- the task environment: identity, fixed `PATH`, discovered shell;
- `forward` with crhs-signed authorizations, with user-only trust and `crha grant`, and with required
  cosignatures;
- local approval, including recovery after the privileged mode restarts and fallback after a refused
  crhs signature;
- one-shot replay protection and the persistent used list;
- guard rules against symlinks, unnormalized paths, shell commands hiding behind a prefix rule, and
  environment variables;
- trust digest changes, re-planning, and an unavailable privileged mode;
- SSH nodes ignoring the privileged flag;
- task groups signed once, a refusing node retrying alone, and groups that only local approval could
  authorize.

Two cases are provoked deliberately: a crhs authorization that expires before it arrives (to test the
fallback), and one node of a group configured with the wrong node id (to test a partial refusal).

## Limits

- Linux and rootless podman only.
- WebAuthn is tested with a software authenticator only; real platform authenticators and hardware keys
  are not.
- `crha grant` is tested with plain Ed25519 keys, not encrypted keys, an agent or a FIDO key.
- `run0` is not tested.
