# Privileged system tests

Podman fixture for real privileged execution: one container is one node, with a root
`crha privileged run`, a uid 998 `crha run`, real `sudo` / `doas` and a real `sshd`. The crhs side is the
in-process server from `../e2e/harness.ts`.

The guide — environment, image, mounts, process control, capability matrix and failure injection — is
[doc/testing/privileged.md](../../../../doc/testing/privileged.md). It is the single source; this file only
points at the files:

- `harness.ts` — image build, containers, enrollment, trust configuration.
- `native.test.ts` — `native` with sudo / doas, `ignore`, `reject`.
- `forward.test.ts` — crhs-signed, user-only, cosign, local approval, one-shot replay, guard rules, trust changes.
- `ssh.test.ts` — SSH nodes ignore `privileged`, SFTP file tasks.
- `groups.test.ts` — task groups across two nodes.
- `Containerfile`, `entrypoint.sh`, `privctl.sh`, `fixtures/sshd_config` — the image and its process control.

```bash
CRH_TEST_PODMAN=1 pnpm test:system
```
