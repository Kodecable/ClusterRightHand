import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode as decodeCbor, encode as encodeCbor } from "../src/cbor.ts";
import { decodeFrame, encodeFrame } from "../src/frame.ts";
import { taskSpecFromJson } from "../src/json.ts";
import { taskSpecCodec } from "../src/messages.ts";
import {
	AUTH_NAMESPACE,
	authorizationCodec,
	authorizationPayloadCodec,
	COSIGN_NAMESPACE,
	cosignPayloadCodec,
	cosignTicketCodec,
	decodeAuthorizationPayload,
	decodeCosignPayload,
	PRIV_PTY_COMMANDS,
	PRIV_PTY_EVENTS,
	privHelloCodec,
	privPtyCloseCodec,
	privPtyExitedCodec,
	privPtyInputCodec,
	privPtyOpenCodec,
	privPtyOutputCodec,
	privPtyResizeCodec,
	privWelcomeCodec,
	trustReportCodec,
	trustSummaryCodec,
	windowOpenCodec,
	windowStateCodec,
} from "../src/privileged.ts";
import type { Codec } from "../src/schema.ts";

type JsonWebKey = Record<string, string>;

import type { M4Vectors, SshsigVector, WebauthnVector } from "./m4_vectors.ts";

const vectors = JSON.parse(
	readFileSync(new URL("../../../test/interop/m4_vectors.json", import.meta.url), "utf8"),
) as M4Vectors;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha256 = (...parts: Uint8Array[]): Uint8Array => {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return Uint8Array.from(hash.digest());
};
const utf8 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function roundTrip<T>(codec: Codec<T>, hex: string): T {
	const value = codec.decode(decodeCbor(bytesOf(hex)));
	expect(hexOf(encodeCbor(codec.encode(value)))).toBe(hex);
	return value;
}

/** The crh-priv wire name of a fixture id: `priv.pty.open` is `pty.open`. */
function commandName(id: string): string {
	return id.replace(/^priv\./, "");
}

// ---------------------------------------------------------------------------
// Reference SSHSIG verifier (independent of the generator's builder)
// ---------------------------------------------------------------------------

class Reader {
	private offset = 0;
	private readonly data: Uint8Array;
	constructor(data: Uint8Array) {
		this.data = data;
	}
	raw(n: number): Uint8Array {
		if (this.offset + n > this.data.length) throw new Error("truncated");
		const out = this.data.subarray(this.offset, this.offset + n);
		this.offset += n;
		return out;
	}
	u8(): number {
		return this.raw(1)[0] ?? 0;
	}
	u32(): number {
		return new DataView(this.raw(4).slice().buffer).getUint32(0);
	}
	string(): Uint8Array {
		return this.raw(this.u32());
	}
	text(): string {
		return Buffer.from(this.string()).toString("utf8");
	}
	end(): void {
		if (this.offset !== this.data.length) throw new Error("trailing bytes");
	}
}

const sshString = (data: Uint8Array): Uint8Array => {
	const out = new Uint8Array(4 + data.length);
	new DataView(out.buffer).setUint32(0, data.length);
	out.set(data, 4);
	return out;
};

function p256Jwk(point: Uint8Array): JsonWebKey {
	if (point.length !== 65 || point[0] !== 4) throw new Error("bad P-256 point");
	return { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) };
}

function mpintsToP1363(blob: Uint8Array): Uint8Array {
	const reader = new Reader(blob);
	const fixed = (value: Uint8Array): Uint8Array => {
		const stripped = value[0] === 0 ? value.subarray(1) : value;
		if (stripped.length > 32) throw new Error("mpint too long");
		const out = new Uint8Array(32);
		out.set(stripped, 32 - stripped.length);
		return out;
	};
	const r = fixed(reader.string());
	const s = fixed(reader.string());
	reader.end();
	return Uint8Array.from([...r, ...s]);
}

/** Returns null when valid, otherwise the reason. Follows doc/design/protocol.md "Authorization object" */
function verifySshsig(
	publicKey: string,
	payload: Uint8Array,
	blob: Uint8Array,
	wantNamespace: string = AUTH_NAMESPACE,
): string | null {
	try {
		const sig = new Reader(blob);
		if (Buffer.from(sig.raw(6)).toString() !== "SSHSIG") return "magic";
		if (sig.u32() !== 1) return "version";
		const keyBlob = sig.string();
		const namespace = sig.text();
		const reserved = sig.string();
		const hashAlg = sig.text();
		const inner = sig.string();
		sig.end();
		if (namespace !== wantNamespace) return "namespace";
		if (reserved.length !== 0) return "reserved";
		if (hashAlg !== "sha512" && hashAlg !== "sha256") return "hash";
		const [, expectedB64] = publicKey.split(" ");
		if (Buffer.from(keyBlob).toString("base64") !== expectedB64) return "key mismatch";

		const digest = Uint8Array.from(createHash(hashAlg).update(payload).digest());
		const signedData = Uint8Array.from([
			...utf8("SSHSIG"),
			...sshString(utf8(namespace)),
			...sshString(reserved),
			...sshString(utf8(hashAlg)),
			...sshString(digest),
		]);

		const key = new Reader(keyBlob);
		const keyType = key.text();
		const s = new Reader(inner);
		if (s.text() !== keyType) return "signature type";
		const sigBytes = s.string();
		switch (keyType) {
			case "ssh-ed25519": {
				const pk = key.string();
				key.end();
				s.end();
				const ok = verify(
					null,
					signedData,
					createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(pk) }, format: "jwk" }),
					sigBytes,
				);
				return ok ? null : "signature";
			}
			case "ecdsa-sha2-nistp256": {
				if (key.text() !== "nistp256") return "curve";
				const point = key.string();
				key.end();
				s.end();
				const pub = createPublicKey({ key: p256Jwk(point), format: "jwk" });
				const ok = verify("sha256", signedData, { key: pub, dsaEncoding: "ieee-p1363" }, mpintsToP1363(sigBytes));
				return ok ? null : "signature";
			}
			case "sk-ssh-ed25519@openssh.com":
			case "sk-ecdsa-sha2-nistp256@openssh.com": {
				const ecdsa = keyType.startsWith("sk-ecdsa");
				if (ecdsa && key.text() !== "nistp256") return "curve";
				const pk = key.string();
				const application = key.string();
				key.end();
				const flags = s.u8();
				const counter = s.u32();
				s.end();
				const counterBytes = new Uint8Array(4);
				new DataView(counterBytes.buffer).setUint32(0, counter);
				const message = Uint8Array.from([...sha256(application), flags, ...counterBytes, ...sha256(signedData)]);
				const ok = ecdsa
					? verify(
							"sha256",
							message,
							{ key: createPublicKey({ key: p256Jwk(pk), format: "jwk" }), dsaEncoding: "ieee-p1363" },
							mpintsToP1363(sigBytes),
						)
					: verify(
							null,
							message,
							createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(pk) }, format: "jwk" }),
							sigBytes,
						);
				if (!ok) return "signature";
				return flags & 0x01 ? null : "user presence";
			}
			default:
				return `key type ${keyType}`;
		}
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function skFlags(blob: Uint8Array): number {
	const sig = new Reader(blob);
	sig.raw(10);
	for (let i = 0; i < 4; i++) sig.string();
	const inner = new Reader(sig.string());
	inner.string();
	inner.string();
	return inner.u8();
}

// ---------------------------------------------------------------------------
// Reference WebAuthn verifier
// ---------------------------------------------------------------------------

function coseToJwk(coseBytes: Uint8Array): { jwk: JsonWebKey; alg: number } {
	const cose = decodeCbor(coseBytes);
	if (!(cose instanceof Map)) throw new Error("COSE key is not a map");
	const get = (label: number): unknown => cose.get(label);
	const b = (label: number): string => b64url(get(label) as Uint8Array);
	const alg = get(3) as number;
	if (get(1) === 2 && alg === -7 && get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: b(-2), y: b(-3) } };
	if (get(1) === 1 && alg === -8 && get(-1) === 6) return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: b(-2) } };
	if (get(1) === 3 && alg === -257) return { alg, jwk: { kty: "RSA", n: b(-1), e: b(-2) } };
	throw new Error("unsupported COSE key");
}

function verifyWebauthn(vector: WebauthnVector): string | null {
	const payload = bytesOf(vector.payloadHex);
	const { trust, signature } = vector;
	if (signature.credentialIdHex !== trust.credentialIdHex) return "credential";
	const clientData = JSON.parse(signature.clientDataJson) as Record<string, unknown>;
	if (clientData.type !== "webauthn.get") return "type";
	const challenge = sha256(utf8(`${AUTH_NAMESPACE}\0`), payload);
	if (clientData.challenge !== b64url(challenge)) return "challenge";
	if (typeof clientData.origin !== "string" || !trust.origins.includes(clientData.origin)) return "origin";
	if (clientData.crossOrigin === true) return "crossOrigin";
	const authData = bytesOf(signature.authenticatorDataHex);
	if (authData.length < 37) return "authenticatorData";
	if (hexOf(authData.subarray(0, 32)) !== hexOf(sha256(utf8(trust.rpId)))) return "rpIdHash";
	const flags = authData[32] ?? 0;
	if (!(flags & 0x01)) return "UP";
	if (trust.requireUv && !(flags & 0x04)) return "UV";
	const { jwk, alg } = coseToJwk(bytesOf(trust.coseKeyHex));
	const key = createPublicKey({ key: jwk, format: "jwk" });
	const data = Uint8Array.from([...authData, ...sha256(utf8(signature.clientDataJson))]);
	const sig = bytesOf(signature.signatureHex);
	const ok = alg === -8 ? verify(null, data, key, sig) : verify("sha256", data, key, sig);
	return ok ? null : "signature";
}

// ---------------------------------------------------------------------------

describe("test/interop/m4_vectors.json", () => {
	it("has unique ids", () => {
		const ids = [
			...vectors.specs,
			...vectors.payloads,
			...vectors.payloadNegative,
			...vectors.authorizations,
			...vectors.cosignTickets,
			...vectors.cosignNegative,
			...vectors.bodies,
			...vectors.priv,
			...vectors.sshsig,
			...vectors.webauthn,
		].map((v) => v.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("spec_sha256 is SHA-256 of CBOR(TaskSpec)", () => {
		for (const vector of vectors.specs) {
			const spec = roundTrip(taskSpecCodec, vector.hex);
			expect(spec).toEqual(taskSpecFromJson(vector.spec));
			expect(hexOf(sha256(bytesOf(vector.hex)))).toBe(vector.sha256Hex);
		}
	});

	it("payloads decode strictly and their id is SHA-256 of the bytes", () => {
		for (const vector of vectors.payloads) {
			const payload = decodeAuthorizationPayload(bytesOf(vector.hex));
			expect(hexOf(encodeCbor(authorizationPayloadCodec.encode(payload)))).toBe(vector.hex);
			expect(hexOf(sha256(bytesOf(vector.hex)))).toBe(vector.authorizationIdHex);
		}
	});

	it.each(vectors.payloadNegative.map((v) => [v.id, v] as const))("rejects %s", (_id, vector) => {
		expect(() => decodeAuthorizationPayload(bytesOf(vector.hex))).toThrow();
	});

	it("authorization objects carry the payload bytes verbatim", () => {
		for (const vector of vectors.authorizations) {
			const authorization = roundTrip(authorizationCodec, vector.hex);
			expect(hexOf(authorization.payload)).toBe(vectors.payloads[0]?.hex);
		}
	});

	it.each(vectors.cosignTickets.map((v) => [v.id, v] as const))(
		"cosign ticket %s decodes strictly and verifies only in the cosign namespace",
		(_id, vector) => {
			const ticket = roundTrip(cosignTicketCodec, vector.hex);
			expect(hexOf(ticket.payload)).toBe(vector.payloadHex);
			const payload = decodeCosignPayload(ticket.payload);
			expect(hexOf(encodeCbor(cosignPayloadCodec.encode(payload)))).toBe(vector.payloadHex);
			expect(hexOf(payload.authorizationId)).toBe(vector.authorizationIdHex);
			const signature = ticket.signatures[0];
			if (signature?.kind !== "sshsig") throw new Error("expected an SSHSIG signature");
			const result = verifySshsig(vector.publicKey, ticket.payload, signature.blob, COSIGN_NAMESPACE);
			expect(result === null).toBe(vector.valid);
		},
	);

	it.each(vectors.cosignNegative.map((v) => [v.id, v] as const))("rejects cosign payload %s", (_id, vector) => {
		expect(() => decodeCosignPayload(bytesOf(vector.hex))).toThrow();
	});

	it("M4 bodies round-trip and the TrustSummary digest matches", () => {
		const codecs: Record<string, Codec<unknown>> = {
			TrustSummary: trustSummaryCodec as Codec<unknown>,
			TrustReport: trustReportCodec as Codec<unknown>,
			WindowState: windowStateCodec as Codec<unknown>,
			WindowOpen: windowOpenCodec as Codec<unknown>,
		};
		for (const vector of vectors.bodies) {
			const codec = codecs[vector.codec];
			if (!codec) throw new Error(`no codec ${vector.codec}`);
			roundTrip(codec, vector.hex);
			if (vector.digestHex) expect(hexOf(sha256(bytesOf(vector.hex)))).toBe(vector.digestHex);
		}
	});

	it("crh-priv frames are length-prefixed", () => {
		const unframe = (hex: string): Uint8Array => {
			const bytes = bytesOf(hex);
			const length = new DataView(bytes.buffer).getUint32(0);
			expect(length).toBe(bytes.length - 4);
			return bytes.subarray(4);
		};
		const byId = new Map(vectors.priv.map((vector) => [vector.id, vector]));
		const body = (id: string): Uint8Array => unframe(byId.get(id)?.hex ?? "");
		roundTrip(privHelloCodec, hexOf(body("priv.hello")));
		roundTrip(privWelcomeCodec, hexOf(body("priv.welcome")));
		const frame = decodeFrame(body("priv.task.start"));
		expect(frame.kind).toBe("request");
		expect(hexOf(encodeFrame(frame))).toBe(hexOf(body("priv.task.start")));
		expect([...PRIV_PTY_COMMANDS]).toEqual(["pty.open", "pty.input", "pty.resize", "pty.close"]);
		expect([...PRIV_PTY_EVENTS]).toEqual(["pty.output", "pty.exited"]);
		// The optional terminal names are not in the crhs <-> crha registry: their bodies are the
		// crh-priv codecs, framed here directly (doc/design/pty.md "Protocol additions").
		const requests: [string, Codec<unknown>][] = [
			["priv.pty.open", privPtyOpenCodec as Codec<unknown>],
			["priv.pty.input", privPtyInputCodec as Codec<unknown>],
			["priv.pty.resize", privPtyResizeCodec as Codec<unknown>],
			["priv.pty.close", privPtyCloseCodec as Codec<unknown>],
		];
		for (const [id, codec] of requests) {
			const [kind, requestId, cmd, requestBody] = decodeCbor(body(id)) as [number, number, string, unknown];
			expect(kind, id).toBe(0);
			expect(commandName(id), id).toBe(cmd);
			const value = codec.decode(requestBody);
			expect(hexOf(encodeCbor([kind, requestId, cmd, codec.encode(value)]))).toBe(hexOf(body(id)));
		}
		const events: [string, Codec<unknown>][] = [
			["priv.pty.output", privPtyOutputCodec as Codec<unknown>],
			["priv.pty.exited", privPtyExitedCodec as Codec<unknown>],
		];
		for (const [id, codec] of events) {
			const [kind, name, eventBody] = decodeCbor(body(id)) as [number, string, unknown];
			expect(kind, id).toBe(2);
			expect(name, id).toBe(commandName(id));
			const value = codec.decode(eventBody);
			expect(hexOf(encodeCbor([kind, name, codec.encode(value)]))).toBe(hexOf(body(id)));
		}
	});

	it.each(vectors.sshsig.map((v) => [v.id, v] as const))(
		"SSHSIG %s matches the reference verifier",
		(_id, vector: SshsigVector) => {
			const result = verifySshsig(vector.publicKey, bytesOf(vector.payloadHex), bytesOf(vector.blobHex));
			expect(result === null).toBe(vector.valid);
			if (vector.userVerified !== undefined) {
				expect((skFlags(bytesOf(vector.blobHex)) & 0x04) !== 0).toBe(vector.userVerified);
			}
		},
	);

	const sshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;
	it.skipIf(!sshKeygen)("SSHSIG vectors agree with ssh-keygen -Y verify", () => {
		const dir = mkdtempSync(join(tmpdir(), "crh-m4-verify-"));
		try {
			for (const vector of vectors.sshsig) {
				if (vector.sshKeygen === null) continue;
				const allowed = join(dir, `${vector.id}.allowed`);
				const sig = join(dir, `${vector.id}.sig`);
				writeFileSync(allowed, `test@crh ${vector.publicKey}\n`);
				const blob = bytesOf(vector.blobHex);
				const body = Buffer.from(blob)
					.toString("base64")
					.replace(/.{1,70}/g, "$&\n");
				writeFileSync(sig, `-----BEGIN SSH SIGNATURE-----\n${body}-----END SSH SIGNATURE-----\n`);
				let ok = true;
				try {
					execFileSync(
						"ssh-keygen",
						["-Y", "verify", "-f", allowed, "-I", "test@crh", "-n", AUTH_NAMESPACE, "-s", sig],
						{
							input: bytesOf(vector.payloadHex),
							stdio: ["pipe", "ignore", "ignore"],
						},
					);
				} catch {
					ok = false;
				}
				expect({ id: vector.id, ok }).toEqual({ id: vector.id, ok: vector.sshKeygen === "ok" });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each(vectors.webauthn.map((v) => [v.id, v] as const))(
		"WebAuthn %s matches the reference verifier",
		(_id, vector) => {
			expect(verifyWebauthn(vector) === null).toBe(vector.valid);
		},
	);
});
