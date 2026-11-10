/**
 * SSHSIG (OpenSSH PROTOCOL.sshsig) for authorizations, in binary form: the bytes of an
 * `-----BEGIN SSH SIGNATURE-----` block after base64 decoding. See doc/design/protocol.md "Authorization object".
 *
 * Only `crh-auth-v1` signatures are accepted, always with the strict rules of the reference
 * verifier in packages/protocol/test/m4_vectors.test.ts: version 1, empty reserved field,
 * sha512 or sha256, no trailing bytes, a key blob identical to the trust entry's key, and
 * UP (user presence) required for `sk-*` keys. Nothing here falls back to a lenient parser.
 */
import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { AUTH_NAMESPACE } from "@crh/protocol";

export type SshKeyType =
	| "ssh-ed25519"
	| "ecdsa-sha2-nistp256"
	| "sk-ssh-ed25519@openssh.com"
	| "sk-ecdsa-sha2-nistp256@openssh.com";

/** The key types the verifier supports (doc/design/privilege.md "Signing methods"). */
export const SSH_KEY_TYPES: readonly SshKeyType[] = [
	"ssh-ed25519",
	"ecdsa-sha2-nistp256",
	"sk-ssh-ed25519@openssh.com",
	"sk-ecdsa-sha2-nistp256@openssh.com",
];

function isSshKeyType(value: string): value is SshKeyType {
	return (SSH_KEY_TYPES as readonly string[]).includes(value);
}

export type SshsigVerification =
	| {
			valid: true;
			keyType: SshKeyType;
			/** sk-* signatures always report presence; the others report false. */
			userPresent: boolean;
			/** sk-* only: the UV flag of the authenticator. */
			userVerified: boolean;
			/** The sshsig hash algorithm, as carried by the signature. */
			hashAlg: "sha512" | "sha256";
	  }
	| { valid: false; reason: string };

export interface ParsedAuthorizedKey {
	keyType: SshKeyType;
	/** The SSH wire-format public key blob. */
	blob: Uint8Array;
}

class Reader {
	#offset = 0;
	readonly #data: Uint8Array;

	constructor(data: Uint8Array) {
		this.#data = data;
	}

	raw(length: number): Uint8Array {
		if (this.#offset + length > this.#data.length) throw new Error("truncated");
		const out = this.#data.subarray(this.#offset, this.#offset + length);
		this.#offset += length;
		return out;
	}

	u8(): number {
		return this.raw(1)[0] ?? 0;
	}

	u32(): number {
		const bytes = this.raw(4);
		return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
	}

	string(): Uint8Array {
		return this.raw(this.u32());
	}

	text(): string {
		return Buffer.from(this.string()).toString("utf8");
	}

	end(): void {
		if (this.#offset !== this.#data.length) throw new Error("trailing bytes");
	}
}

const utf8 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));

export function sshString(data: Uint8Array | string): Uint8Array {
	const bytes = typeof data === "string" ? utf8(data) : data;
	const out = new Uint8Array(4 + bytes.length);
	new DataView(out.buffer).setUint32(0, bytes.length);
	out.set(bytes, 4);
	return out;
}

const u32 = (value: number): Uint8Array => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value);
	return out;
};

const b64url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");

/** OpenSSH `SHA256:…` fingerprint of an SSH public key blob, unpadded base64. */
export function sshFingerprint(publicKeyBlob: Uint8Array): string {
	const digest = createHash("sha256").update(publicKeyBlob).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * The public key blob an SSHSIG names, for matching a signature to the trust entries that might own
 * it. Only the header is read; `verifySshsig` is what decides whether the signature is good.
 */
export function sshsigKeyBlob(blob: Uint8Array): Uint8Array | null {
	try {
		const sig = new Reader(blob);
		if (Buffer.from(sig.raw(6)).toString("utf8") !== "SSHSIG") return null;
		sig.u32();
		return sig.string();
	} catch {
		return null;
	}
}

/** The `authorized_keys` line of a public key blob, with an optional comment. */
export function authorizedKeyLine(keyType: string, publicKeyBlob: Uint8Array, comment?: string): string {
	const base = `${keyType} ${Buffer.from(publicKeyBlob).toString("base64")}`;
	return comment ? `${base} ${comment}` : base;
}

/**
 * Parses an `authorized_keys` line: `type base64 [comment]`. Options in front of the type are not
 * part of the trust configuration's format (doc/design/protocol.md "Trust summary"), so they are rejected. The
 * blob must really be of the named type: a mistyped line would otherwise be stored as a credential
 * that can never verify anything, and a wrong key type in a trust entry is easier to spot here.
 */
export function parseAuthorizedKey(line: string): ParsedAuthorizedKey {
	const fields = line.trim().split(/\s+/);
	const [keyType, body] = fields;
	if (!keyType || !body) throw new Error("not an authorized_keys line");
	if (!isSshKeyType(keyType)) throw new Error(`unsupported key type ${keyType}`);
	const blob = Uint8Array.from(Buffer.from(body, "base64"));
	if (blob.length === 0) throw new Error("empty public key");
	const key = new Reader(blob);
	if (key.text() !== keyType) throw new Error(`the key blob is not of type ${keyType}`);
	switch (keyType) {
		case "ssh-ed25519":
			if (key.string().length !== 32) throw new Error("an ed25519 public key is 32 bytes");
			break;
		case "ecdsa-sha2-nistp256":
			if (key.text() !== "nistp256") throw new Error("only the P-256 curve is supported");
			if (key.string().length !== 65) throw new Error("a P-256 public key is 65 bytes");
			break;
		case "sk-ssh-ed25519@openssh.com":
			if (key.string().length !== 32) throw new Error("an ed25519 public key is 32 bytes");
			key.text(); // application
			break;
		case "sk-ecdsa-sha2-nistp256@openssh.com":
			if (key.text() !== "nistp256") throw new Error("only the P-256 curve is supported");
			if (key.string().length !== 65) throw new Error("a P-256 public key is 65 bytes");
			key.text(); // application
			break;
	}
	key.end();
	return { keyType, blob };
}

/** The SSH public key blob of an ed25519 key or P-256 point, as used inside an SSHSIG key blob. */
export function ed25519PublicBlob(publicKey: KeyObject): Uint8Array {
	const jwk = publicKey.export({ format: "jwk" });
	const raw = Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url"));
	if (raw.length !== 32) throw new Error("not an ed25519 public key");
	return concat(sshString("ssh-ed25519"), sshString(raw));
}

function signedData(namespace: string, reserved: Uint8Array, hashAlg: "sha512" | "sha256", digest: Uint8Array) {
	return concat(utf8("SSHSIG"), sshString(namespace), sshString(reserved), sshString(hashAlg), sshString(digest));
}

const digestOf = (hashAlg: "sha512" | "sha256", message: Uint8Array): Uint8Array =>
	Uint8Array.from(createHash(hashAlg).update(message).digest());

export interface SignOptions {
	namespace?: string;
	hashAlg?: "sha512" | "sha256";
	reserved?: Uint8Array;
}

/** Signs bytes with an ed25519 key and wraps them as a binary SSHSIG blob (doc/design/protocol.md "Authorization object"). */
export function signSshsig(
	privateKey: KeyObject,
	publicKeyBlob: Uint8Array,
	message: Uint8Array,
	options: SignOptions = {},
): Uint8Array {
	const namespace = options.namespace ?? AUTH_NAMESPACE;
	const hashAlg = options.hashAlg ?? "sha512";
	const reserved = options.reserved ?? new Uint8Array(0);
	const data = signedData(namespace, reserved, hashAlg, digestOf(hashAlg, message));
	// SSHSIG hashes the message itself; the key signs the signed data directly.
	const rawSignature = Uint8Array.from(sign(null, data, privateKey));
	const inner = concat(sshString("ssh-ed25519"), sshString(rawSignature));
	return concat(
		utf8("SSHSIG"),
		u32(1),
		sshString(publicKeyBlob),
		sshString(namespace),
		sshString(reserved),
		sshString(hashAlg),
		sshString(inner),
	);
}

function p256Jwk(point: Uint8Array): Record<string, string> {
	if (point.length !== 65 || point[0] !== 4) throw new Error("bad P-256 point");
	return { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) };
}

function ed25519Jwk(raw: Uint8Array): Record<string, string> {
	if (raw.length !== 32) throw new Error("bad ed25519 key");
	return { kty: "OKP", crv: "Ed25519", x: b64url(raw) };
}

/** Converts the SSH mpint r/s of an ECDSA signature to the fixed-width r‖s form node:crypto wants. */
function mpintsToP1363(blob: Uint8Array): Uint8Array {
	const reader = new Reader(blob);
	const fixed = (value: Uint8Array): Uint8Array => {
		if (value.length > 0 && value[0] === 0) value = value.subarray(1);
		if (value.length > 32) throw new Error("mpint too long");
		const out = new Uint8Array(32);
		out.set(value, 32 - value.length);
		return out;
	};
	const r = fixed(reader.string());
	const s = fixed(reader.string());
	reader.end();
	return concat(r, s);
}

/**
 * Verifies an SSHSIG over `message` against an `authorized_keys` line. Returns the reason instead
 * of throwing, so callers can log a rejection. Follows doc/design/protocol.md "Authorization object" and is as strict as
 * `ssh-keygen -Y verify` plus the UP requirement for `sk-*` signatures.
 */
export function verifySshsig(publicKeyLine: string, message: Uint8Array, blob: Uint8Array): SshsigVerification {
	try {
		const expected = parseAuthorizedKey(publicKeyLine);
		const sig = new Reader(blob);
		if (Buffer.from(sig.raw(6)).toString("utf8") !== "SSHSIG") return invalid("bad magic");
		if (sig.u32() !== 1) return invalid("unsupported signature version");
		const keyBlob = sig.string();
		const namespace = sig.text();
		const reserved = sig.string();
		const hashAlg = sig.text();
		const inner = sig.string();
		sig.end();
		if (!Buffer.from(keyBlob).equals(Buffer.from(expected.blob))) return invalid("signature is for another key");
		if (namespace !== AUTH_NAMESPACE) return invalid(`namespace is ${namespace}, want ${AUTH_NAMESPACE}`);
		if (reserved.length !== 0) return invalid("reserved field is not empty");
		if (hashAlg !== "sha512" && hashAlg !== "sha256") return invalid(`unsupported hash ${hashAlg}`);
		const key = new Reader(keyBlob);
		const keyType = key.text();
		if (!isSshKeyType(keyType)) return invalid(`unsupported key type ${keyType}`);
		if (keyType !== expected.keyType) return invalid("signature key type differs from the trust entry");
		const data = signedData(namespace, reserved, hashAlg, digestOf(hashAlg, message));
		const signature = new Reader(inner);
		if (signature.text() !== keyType) return invalid("signature type mismatch");
		const sigBytes = signature.string();
		switch (keyType) {
			case "ssh-ed25519": {
				const pk = key.string();
				key.end();
				signature.end();
				const keyObject = createPublicKey({ key: ed25519Jwk(pk), format: "jwk" });
				if (!verify(null, data, keyObject, sigBytes)) return invalid("signature does not verify");
				return { valid: true, keyType, userPresent: false, userVerified: false, hashAlg };
			}
			case "ecdsa-sha2-nistp256": {
				if (key.text() !== "nistp256") return invalid("unsupported ECDSA curve");
				const point = key.string();
				key.end();
				signature.end();
				const keyObject = createPublicKey({ key: p256Jwk(point), format: "jwk" });
				const ok = verify("sha256", data, { key: keyObject, dsaEncoding: "ieee-p1363" }, mpintsToP1363(sigBytes));
				if (!ok) return invalid("signature does not verify");
				return { valid: true, keyType, userPresent: false, userVerified: false, hashAlg };
			}
			case "sk-ssh-ed25519@openssh.com":
			case "sk-ecdsa-sha2-nistp256@openssh.com": {
				const ecdsa = keyType.startsWith("sk-ecdsa");
				if (ecdsa && key.text() !== "nistp256") return invalid("unsupported ECDSA curve");
				const pk = key.string();
				const application = key.string();
				key.end();
				const flags = signature.u8();
				const counter = signature.u32();
				signature.end();
				// OpenSSH PROTOCOL.u2f: the authenticator signs SHA256(application) ‖ flags ‖ counter ‖ SHA256(data).
				const messageToVerify = concat(
					createHash("sha256").update(application).digest(),
					new Uint8Array([flags]),
					u32(counter),
					createHash("sha256").update(data).digest(),
				);
				const ok = ecdsa
					? verify(
							"sha256",
							messageToVerify,
							{ key: createPublicKey({ key: p256Jwk(pk), format: "jwk" }), dsaEncoding: "ieee-p1363" },
							mpintsToP1363(sigBytes),
						)
					: verify(null, messageToVerify, createPublicKey({ key: ed25519Jwk(pk), format: "jwk" }), sigBytes);
				if (!ok) return invalid("signature does not verify");
				// protocol.md requires UP; unlike ssh-keygen, crha does not accept a signature without it.
				if (!(flags & 0x01)) return invalid("user presence is not asserted");
				return { valid: true, keyType, userPresent: true, userVerified: (flags & 0x04) !== 0, hashAlg };
			}
		}
		return invalid(`unsupported key type ${keyType}`);
	} catch (err) {
		return invalid(err instanceof Error ? err.message : String(err));
	}
}

function invalid(reason: string): SshsigVerification {
	return { valid: false, reason };
}
