/**
 * Software authenticators for the M4.4 tests: an SSH public key of every supported type, and a
 * WebAuthn authenticator (P-256/ES256 or Ed25519/EdDSA) that builds attestation objects and
 * assertions the way a browser and a real authenticator do.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { AUTH_NAMESPACE, encode as encodeCbor } from "@crh/protocol";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { authorizedKeyLine, ed25519PublicBlob, type SshKeyType, sshFingerprint } from "../../src/privilege/sshsig.ts";

const utf8 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array): Uint8Array => Uint8Array.from(createHash("sha256").update(data).digest());
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));
const u16 = (n: number): Uint8Array => {
	const out = new Uint8Array(2);
	new DataView(out.buffer).setUint16(0, n);
	return out;
};
const u32 = (n: number): Uint8Array => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n);
	return out;
};
const sshString = (value: Uint8Array | string): Uint8Array => {
	const data = typeof value === "string" ? utf8(value) : value;
	return concat(u32(data.length), data);
};

export interface TestSshKey {
	type: SshKeyType;
	/** The authorized_keys line to paste into the WebUI. */
	line: string;
	/** OpenSSH `SHA256:…` fingerprint of the public key blob. */
	fingerprint: string;
	/** The SSH wire-format public key blob. */
	blob: Uint8Array;
	privateKey: KeyObject;
}

/** A valid SSH public key of the given type, with its private key for signing. */
export function createSshKey(type: SshKeyType = "ssh-ed25519"): TestSshKey {
	let blob: Uint8Array;
	let privateKey: KeyObject;
	if (type === "ssh-ed25519" || type === "sk-ssh-ed25519@openssh.com") {
		const pair = generateKeyPairSync("ed25519");
		privateKey = pair.privateKey;
		const raw = Uint8Array.from(Buffer.from(pair.publicKey.export({ format: "jwk" }).x ?? "", "base64url"));
		blob =
			type === "ssh-ed25519"
				? ed25519PublicBlob(pair.publicKey)
				: concat(sshString(type), sshString(raw), sshString("ssh:"));
	} else {
		const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		privateKey = pair.privateKey;
		const jwk = pair.publicKey.export({ format: "jwk" });
		const point = concat(
			new Uint8Array([4]),
			Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")),
			Uint8Array.from(Buffer.from(jwk.y ?? "", "base64url")),
		);
		blob =
			type === "ecdsa-sha2-nistp256"
				? concat(sshString(type), sshString("nistp256"), sshString(point))
				: concat(sshString(type), sshString("nistp256"), sshString(point), sshString("ssh:"));
	}
	return { type, line: authorizedKeyLine(type, blob), fingerprint: sshFingerprint(blob), blob, privateKey };
}

export type SoftwareAlg = "ES256" | "EdDSA";

/** The flags of authenticator data: UP, UV and AT (attested credential data present). */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface SoftwareAuthenticatorOptions {
	alg?: SoftwareAlg;
	rpId?: string;
	origin?: string;
	credentialId?: Uint8Array;
	counter?: number;
}

/**
 * A WebAuthn authenticator with one credential. `registration` builds the CBOR attestation object
 * (`fmt = none`), `assertion` signs `authenticatorData ‖ SHA-256(clientDataJSON)` like a browser.
 */
export class SoftwareAuthenticator {
	readonly alg: SoftwareAlg;
	readonly rpId: string;
	readonly origin: string;
	readonly credentialId: Uint8Array;
	readonly coseKey: Uint8Array;
	readonly counter: number;
	readonly #privateKey: KeyObject;

	constructor(options: SoftwareAuthenticatorOptions = {}) {
		this.alg = options.alg ?? "ES256";
		this.rpId = options.rpId ?? "crh.example.com";
		this.origin = options.origin ?? "https://crh.example.com";
		this.credentialId = options.credentialId ?? Uint8Array.from(randomBytes(16));
		this.counter = options.counter ?? 0;
		if (this.alg === "ES256") {
			const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
			this.#privateKey = pair.privateKey;
			const jwk = pair.publicKey.export({ format: "jwk" });
			this.coseKey = encodeCbor(
				new Map<number, unknown>([
					[1, 2],
					[3, -7],
					[-1, 1],
					[-2, Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url"))],
					[-3, Uint8Array.from(Buffer.from(jwk.y ?? "", "base64url"))],
				]),
			);
		} else {
			const pair = generateKeyPairSync("ed25519");
			this.#privateKey = pair.privateKey;
			const raw = Uint8Array.from(Buffer.from(pair.publicKey.export({ format: "jwk" }).x ?? "", "base64url"));
			this.coseKey = encodeCbor(
				new Map<number, unknown>([
					[1, 1],
					[3, -8],
					[-1, 6],
					[-2, raw],
				]),
			);
		}
	}

	/** The browser's creation response; `challenge` is the base64url challenge from the options. */
	registrationResponse(challenge: string, options: { origin?: string; flags?: number } = {}): RegistrationResponseJSON {
		const clientDataJson = JSON.stringify({
			type: "webauthn.create",
			challenge,
			origin: options.origin ?? this.origin,
			crossOrigin: false,
		});
		const authData = concat(
			sha256(utf8(this.rpId)),
			new Uint8Array([options.flags ?? FLAG_UP | FLAG_UV | FLAG_AT]),
			u32(0),
			new Uint8Array(16), // aaguid
			u16(this.credentialId.length),
			this.credentialId,
			this.coseKey,
		);
		const attestationObject = encodeCbor(
			new Map<string, unknown>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", authData],
			]),
		);
		const id = b64url(this.credentialId);
		return {
			id,
			rawId: id,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: b64url(utf8(clientDataJson)),
				attestationObject: b64url(attestationObject),
			},
		};
	}

	/**
	 * An assertion over an authorization payload: the challenge is the protocol's
	 * SHA-256("crh-auth-v1\0" ‖ payload). Overrides exist for negative tests.
	 */
	assertionResponse(
		payload: Uint8Array,
		options: { challengePayload?: Uint8Array; origin?: string; type?: string; flags?: number; counter?: number } = {},
	): AuthenticationResponseJSON {
		const challenge = b64url(sha256(concat(utf8(`${AUTH_NAMESPACE}\0`), options.challengePayload ?? payload)));
		const clientDataJson = JSON.stringify({
			type: options.type ?? "webauthn.get",
			challenge,
			origin: options.origin ?? this.origin,
			crossOrigin: false,
		});
		const authData = concat(
			sha256(utf8(this.rpId)),
			new Uint8Array([options.flags ?? FLAG_UP | FLAG_UV]),
			u32(options.counter ?? this.counter),
		);
		const data = concat(authData, sha256(utf8(clientDataJson)));
		const signature =
			this.alg === "ES256"
				? Uint8Array.from(sign("sha256", data, { key: this.#privateKey, dsaEncoding: "der" }))
				: Uint8Array.from(sign(null, data, this.#privateKey));
		const id = b64url(this.credentialId);
		return {
			id,
			rawId: id,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: b64url(utf8(clientDataJson)),
				authenticatorData: b64url(authData),
				signature: b64url(signature),
			},
		};
	}
}
