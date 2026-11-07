/**
 * Test-only Noise handshake factories. A fixed ephemeral key makes the handshake reproducible, which the
 * Noise test vectors and the interop fixture need. This module is not part of the package entry point:
 * production code uses `HandshakeState.initiator` and `HandshakeState.responder`, which always generate keys.
 */
import {
	DH_LEN,
	HandshakeState,
	type InitiatorOptions,
	type KeyPair,
	NoiseError,
	type ResponderOptions,
} from "./index.ts";

/** Test-only initiator options, including the fixed ephemeral key. */
export interface FixedInitiatorOptions extends InitiatorOptions {
	ephemeralKey?: KeyPair;
}

/** Test-only responder options, including the fixed ephemeral key. */
export interface FixedResponderOptions extends ResponderOptions {
	ephemeralKey?: KeyPair;
}

class TestHandshakeState extends HandshakeState {
	constructor(initiator: boolean, prologue: Uint8Array, staticKey: KeyPair, rs?: Uint8Array, ephemeralKey?: KeyPair) {
		super(initiator, prologue, staticKey, rs, ephemeralKey);
	}
}

/** Creates an initiator with the given (or generated) ephemeral key. */
export function initiatorForTest(options: FixedInitiatorOptions): HandshakeState {
	if (options.remoteStaticKey.length !== DH_LEN) throw new NoiseError("remote static key must be 32 bytes");
	return new TestHandshakeState(
		true,
		options.prologue,
		options.staticKey,
		Uint8Array.from(options.remoteStaticKey),
		options.ephemeralKey,
	);
}

/** Creates a responder with the given (or generated) ephemeral key. */
export function responderForTest(options: FixedResponderOptions): HandshakeState {
	return new TestHandshakeState(false, options.prologue, options.staticKey, undefined, options.ephemeralKey);
}
