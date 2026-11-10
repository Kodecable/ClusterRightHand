/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2s (Noise Protocol Framework, revision 34) on node:crypto.
 * Only what crhs needs: the IK pattern, no PSK, no rekey. See doc/design/protocol.md "Transport security".
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";

export const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
export const DH_LEN = 32;
export const HASH_LEN = 32;
export const TAG_LEN = 16;
/** Maximum size of any Noise message. */
export const MAX_MESSAGE_LEN = 65535;

export class NoiseError extends Error {}

export interface KeyPair {
	privateKey: Uint8Array;
	publicKey: Uint8Array;
}

// DER prefixes for raw X25519 keys (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function privateKeyObject(raw: Uint8Array): KeyObject {
	if (raw.length !== DH_LEN) throw new NoiseError("X25519 private key must be 32 bytes");
	return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function publicKeyObject(raw: Uint8Array): KeyObject {
	if (raw.length !== DH_LEN) throw new NoiseError("X25519 public key must be 32 bytes");
	return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
	const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
	return new Uint8Array(spki.subarray(SPKI_PREFIX.length));
}

export function generateKeyPair(): KeyPair {
	const { privateKey } = generateKeyPairSync("x25519");
	const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
	const raw = new Uint8Array(pkcs8.subarray(PKCS8_PREFIX.length));
	return { privateKey: raw, publicKey: publicKeyFromPrivate(raw) };
}

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
	return { privateKey: Uint8Array.from(privateKey), publicKey: publicKeyFromPrivate(privateKey) };
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
	let shared: Buffer;
	try {
		shared = diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) });
	} catch {
		// OpenSSL refuses low-order points itself (the all-zero shared secret).
		throw new NoiseError("invalid public key (low order point)");
	}
	// Belt and braces in case the provider ever returns the all-zero secret instead of failing.
	if (shared.every((b) => b === 0)) throw new NoiseError("invalid public key (low order point)");
	return shared;
}

function hash(...parts: Uint8Array[]): Buffer {
	const h = createHash("blake2s256");
	for (const p of parts) h.update(p);
	return h.digest();
}

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Buffer {
	const h = createHmac("blake2s256", key);
	for (const p of parts) h.update(p);
	return h.digest();
}

function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Buffer, Buffer] {
	const tempKey = hmac(chainingKey, ikm);
	const out1 = hmac(tempKey, Uint8Array.of(1));
	const out2 = hmac(tempKey, out1, Uint8Array.of(2));
	return [out1, out2];
}

const MAX_NONCE = 2n ** 64n - 1n; // reserved by the spec

export class CipherState {
	#key: Buffer | undefined;
	#nonce = 0n;

	constructor(key?: Uint8Array) {
		this.#key = key ? Buffer.from(key) : undefined;
	}

	get hasKey(): boolean {
		return this.#key !== undefined;
	}

	#iv(): Buffer {
		if (this.#nonce >= MAX_NONCE) throw new NoiseError("nonce exhausted");
		const iv = Buffer.alloc(12);
		iv.writeBigUInt64LE(this.#nonce, 4);
		return iv;
	}

	encrypt(ad: Uint8Array, plaintext: Uint8Array): Buffer {
		if (!this.#key) return Buffer.from(plaintext);
		const cipher = createCipheriv("chacha20-poly1305", this.#key, this.#iv(), { authTagLength: TAG_LEN });
		cipher.setAAD(ad, { plaintextLength: plaintext.length });
		const out = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
		this.#nonce++;
		return out;
	}

	decrypt(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
		if (!this.#key) return Buffer.from(ciphertext);
		if (ciphertext.length < TAG_LEN) throw new NoiseError("ciphertext too short");
		const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
		const decipher = createDecipheriv("chacha20-poly1305", this.#key, this.#iv(), { authTagLength: TAG_LEN });
		decipher.setAAD(ad, { plaintextLength: body.length });
		decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LEN));
		let out: Buffer;
		try {
			out = Buffer.concat([decipher.update(body), decipher.final()]);
		} catch {
			throw new NoiseError("decryption failed");
		}
		// The nonce only advances on success, as the spec requires.
		this.#nonce++;
		return out;
	}
}

class SymmetricState {
	ck: Buffer;
	h: Buffer;
	cs = new CipherState();

	constructor(protocolName: string) {
		const name = Buffer.from(protocolName, "ascii");
		this.h = name.length <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)]) : hash(name);
		this.ck = Buffer.from(this.h);
	}

	mixKey(ikm: Uint8Array): void {
		const [ck, tempK] = hkdf2(this.ck, ikm);
		this.ck = ck;
		this.cs = new CipherState(tempK);
	}

	mixHash(data: Uint8Array): void {
		this.h = hash(this.h, data);
	}

	encryptAndHash(plaintext: Uint8Array): Buffer {
		const ct = this.cs.encrypt(this.h, plaintext);
		this.mixHash(ct);
		return ct;
	}

	decryptAndHash(ciphertext: Uint8Array): Buffer {
		const pt = this.cs.decrypt(this.h, ciphertext);
		this.mixHash(ciphertext);
		return pt;
	}

	split(): [CipherState, CipherState] {
		const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
		return [new CipherState(k1), new CipherState(k2)];
	}
}

export interface InitiatorOptions {
	prologue: Uint8Array;
	/** Our static key pair. */
	staticKey: KeyPair;
	/** The responder's static public key, known in advance (IK). */
	remoteStaticKey: Uint8Array;
}

export interface ResponderOptions {
	prologue: Uint8Array;
	staticKey: KeyPair;
}

export interface TransportCiphers {
	send: CipherState;
	receive: CipherState;
	/** The handshake hash; identifies this session (channel binding). */
	handshakeHash: Uint8Array;
}

/**
 * The IK handshake: initiator writes message 1, responder reads it, writes message 2, initiator reads it.
 *
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 */
export class HandshakeState {
	readonly #initiator: boolean;
	readonly #ss: SymmetricState;
	readonly #s: KeyPair;
	#e: KeyPair | undefined;
	#rs: Uint8Array | undefined;
	#re: Uint8Array | undefined;
	#step = 0;
	#unusable = false;
	readonly #fixedEphemeral: KeyPair | undefined;

	/**
	 * Subclasses only: the test-only factories in testing.ts pin an ephemeral key to reproduce Noise vectors.
	 * Production callers use `initiator` or `responder`.
	 */
	protected constructor(initiator: boolean, prologue: Uint8Array, s: KeyPair, rs?: Uint8Array, e?: KeyPair) {
		this.#initiator = initiator;
		this.#s = s;
		this.#rs = rs;
		this.#fixedEphemeral = e;
		this.#ss = new SymmetricState(PROTOCOL_NAME);
		this.#ss.mixHash(prologue);
		// Pre-message: the responder's static key.
		this.#ss.mixHash(initiator ? (rs as Uint8Array) : s.publicKey);
	}

	static initiator(options: InitiatorOptions): HandshakeState {
		if (options.remoteStaticKey.length !== DH_LEN) throw new NoiseError("remote static key must be 32 bytes");
		return new HandshakeState(true, options.prologue, options.staticKey, Uint8Array.from(options.remoteStaticKey));
	}

	static responder(options: ResponderOptions): HandshakeState {
		return new HandshakeState(false, options.prologue, options.staticKey);
	}

	/** The peer's static public key; for the responder, available after reading message 1. */
	get remoteStaticKey(): Uint8Array | undefined {
		return this.#rs;
	}

	get isComplete(): boolean {
		return this.#step === 2;
	}

	#assertUsable(): void {
		if (this.#unusable) throw new NoiseError("handshake is unusable after a decryption failure");
	}

	#newEphemeral(): KeyPair {
		return this.#fixedEphemeral ?? generateKeyPair();
	}

	/** A failed authentication tag invalidates the whole state: the cipher state has already advanced. */
	#decryptAndHash(ciphertext: Uint8Array): Buffer {
		try {
			return this.#ss.decryptAndHash(ciphertext);
		} catch (err) {
			this.#unusable = true;
			throw err;
		}
	}

	writeMessage(payload: Uint8Array): Buffer {
		this.#assertUsable();
		const ss = this.#ss;
		let out: Buffer;
		if (this.#step === 0 && this.#initiator) {
			const e = this.#newEphemeral();
			this.#e = e;
			const rs = this.#rs as Uint8Array;
			ss.mixHash(e.publicKey);
			ss.mixKey(dh(e.privateKey, rs));
			const encS = ss.encryptAndHash(this.#s.publicKey);
			ss.mixKey(dh(this.#s.privateKey, rs));
			out = Buffer.concat([e.publicKey, encS, ss.encryptAndHash(payload)]);
		} else if (this.#step === 1 && !this.#initiator) {
			const e = this.#newEphemeral();
			this.#e = e;
			ss.mixHash(e.publicKey);
			ss.mixKey(dh(e.privateKey, this.#re as Uint8Array));
			ss.mixKey(dh(e.privateKey, this.#rs as Uint8Array));
			out = Buffer.concat([e.publicKey, ss.encryptAndHash(payload)]);
		} else {
			throw new NoiseError("writeMessage called out of turn");
		}
		if (out.length > MAX_MESSAGE_LEN) throw new NoiseError("handshake message too large");
		this.#step++;
		return out;
	}

	readMessage(message: Uint8Array): Buffer {
		this.#assertUsable();
		if (message.length > MAX_MESSAGE_LEN) throw new NoiseError("handshake message too large");
		const ss = this.#ss;
		let payload: Buffer;
		if (this.#step === 0 && !this.#initiator) {
			if (message.length < DH_LEN + DH_LEN + TAG_LEN + TAG_LEN) throw new NoiseError("message 1 too short");
			const re = message.subarray(0, DH_LEN);
			this.#re = Uint8Array.from(re);
			ss.mixHash(re);
			ss.mixKey(dh(this.#s.privateKey, re));
			const rs = this.#decryptAndHash(message.subarray(DH_LEN, DH_LEN * 2 + TAG_LEN));
			ss.mixKey(dh(this.#s.privateKey, rs));
			payload = this.#decryptAndHash(message.subarray(DH_LEN * 2 + TAG_LEN));
			this.#rs = Uint8Array.from(rs);
		} else if (this.#step === 1 && this.#initiator) {
			if (message.length < DH_LEN + TAG_LEN) throw new NoiseError("message 2 too short");
			const re = message.subarray(0, DH_LEN);
			this.#re = Uint8Array.from(re);
			ss.mixHash(re);
			const e = this.#e as KeyPair;
			ss.mixKey(dh(e.privateKey, re));
			ss.mixKey(dh(this.#s.privateKey, re));
			payload = this.#decryptAndHash(message.subarray(DH_LEN));
		} else {
			throw new NoiseError("readMessage called out of turn");
		}
		this.#step++;
		return payload;
	}

	/** After both messages: the transport ciphers for this side. */
	split(): TransportCiphers {
		this.#assertUsable();
		if (!this.isComplete) throw new NoiseError("handshake not complete");
		const [c1, c2] = this.#ss.split();
		return this.#initiator
			? { send: c1, receive: c2, handshakeHash: Uint8Array.from(this.#ss.h) }
			: { send: c2, receive: c1, handshakeHash: Uint8Array.from(this.#ss.h) };
	}
}
