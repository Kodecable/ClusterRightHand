# Interop fixtures

The TypeScript and Go implementations of the protocol, Noise and authorization payloads are written
independently and must agree byte for byte. A change that only one side accepts is a protocol bug. The
fixtures in `test/interop/` turn such a disagreement into an ordinary test failure on either side,
without running both processes together. The end-to-end and privileged system tests then check the same
bytes through a real `crha`.

The fixtures cover the CBOR profile, every frame with malformed variants, a Noise handshake as CRH uses
it, authorization material (payloads, spec hashes, trust digests, SSHSIG and WebAuthn signatures), and
shared authorization decision cases that crhs's planner and crha's validator must both pass.

## Regenerating

Each generated fixture has a generator under `packages/protocol/test/`. Never edit a generated fixture by
hand: change the generator, run it, and run both the TypeScript and Go tests in the same change. The
authorization vectors use fresh keys on every run, so regenerating them produces a large diff; commit it
only when the change is intended. The CBOR profile vectors have no generator: changing them is a change
of the specification, and both implementations must follow.

The keys in the fixtures are test material only.
