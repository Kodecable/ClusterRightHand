/**
 * Builds test/interop/m4_vectors.json: authorization objects, spec_sha256,
 * TrustSummary digests, M4 bodies, crh-priv framing, SSHSIG and WebAuthn
 * signatures. Keys are generated on every run (ECDSA signatures are not
 * deterministic anyway), so the committed file is checked by properties in
 * m4_vectors.test.ts, not by regenerating it. SSHSIG positives are also
 * signed by ssh-keygen, so the file pins OpenSSH's own output.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode as encodeCbor } from "../src/cbor.ts";
import { encodeFrame } from "../src/frame.ts";
import { taskSpecToJson } from "../src/json.ts";
import { type TaskSpec, taskSpecCodec } from "../src/messages.ts";
import {
	AUTH_NAMESPACE,
	type Authorization,
	type AuthorizationPayload,
	authorizationCodec,
	authorizationPayloadCodec,
	encodeAuthorizationPayload,
	lengthPrefixed,
	localDecisionCodec,
	localRequestCodec,
	localWithdrawCodec,
	PRIV_MAJOR,
	PRIV_MINOR,
	pendingEntryCodec,
	privHelloCodec,
	privWelcomeCodec,
	revocationsAddCodec,
	type Signature,
	type TrustSummary,
	trustReportCodec,
	trustSummaryCodec,
} from "../src/privileged.ts";
import type { Codec } from "../src/schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const sha256Of = (...parts: Uint8Array[]): Uint8Array => {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return Uint8Array.from(hash.digest());
};
const sha512Of = (data: Uint8Array): Uint8Array => Uint8Array.from(createHash("sha512").update(data).digest());
const utf8 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));
const u32 = (n: number): Uint8Array => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n);
	return out;
};
const sshString = (value: Uint8Array | string): Uint8Array => {
	const data = typeof value === "string" ? utf8(value) : value;
	return concat(u32(data.length), data);
};
const mpint = (unsigned: Uint8Array): Uint8Array => {
	let start = 0;
	while (start < unsigned.length && unsigned[start] === 0) start++;
	let body = unsigned.subarray(start);
	if (body.length > 0 && (body[0] ?? 0) & 0x80) body = concat(new Uint8Array([0]), body);
	return sshString(body);
};
const b64url = (data: Uint8Array): string => Buffer.from(data).toString("base64url");

export function specSha256(spec: TaskSpec): Uint8Array {
	return sha256Of(encodeCbor(taskSpecCodec.encode(spec)));
}

export function webauthnChallenge(payload: Uint8Array): Uint8Array {
	return sha256Of(utf8(`${AUTH_NAMESPACE}\0`), payload);
}

/** Converts Uint8Array leaves to hex so codec values can be shown as JSON. */
function jsonOf(value: unknown): unknown {
	if (value instanceof Uint8Array) return hex(value);
	if (Array.isArray(value)) return value.map(jsonOf);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(item)]));
	}
	return value;
}

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

const NOW = 1_793_016_000_000; // 2026-10-26T12:00:00Z
const ZERO32 = new Uint8Array(32);
const EMPTY_SHA = sha256Of(new Uint8Array(0));

export const SPECS: Record<string, TaskSpec> = {
	"exec.argv": {
		kind: "exec",
		command: { argv: ["systemctl", "restart", "nginx"] },
		env: {},
		cwd: "",
		stdin: null,
	},
	"exec.shell.env.stdin": {
		kind: "exec",
		command: { shell: "apt-get update && apt-get upgrade -y" },
		env: { DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8" },
		cwd: "/",
		stdin: { size: 3, sha256: sha256Of(utf8("yes")) },
	},
	"file.write": {
		kind: "file.write",
		path: "/etc/nginx/nginx.conf",
		content: { size: 0, sha256: EMPTY_SHA },
		overwrite: true,
		mode: 0o644,
		owner: "root",
		group: "root",
	},
	"file.edit": {
		kind: "file.edit",
		path: "/etc/nginx/conf.d/site.conf",
		edits: [{ oldText: "listen 80;", newText: "listen 8080;" }],
	},
	"file.read": { kind: "file.read", path: "/etc/hosts", offset: 0, limit: 0 },
};

const execArgv = SPECS["exec.argv"] as TaskSpec;

// ---------------------------------------------------------------------------
// SSHSIG
// ---------------------------------------------------------------------------

interface SshKey {
	type: string;
	publicBlob: Uint8Array;
	/** Produces the inner SSH signature blob for the SSHSIG signed data. */
	signInner(signedData: Uint8Array, hashAlg: "sha256" | "sha512"): Uint8Array;
}

function rawEd25519Public(key: KeyObject): Uint8Array {
	const jwk = key.export({ format: "jwk" });
	return Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url"));
}

function rawP256Public(key: KeyObject): Uint8Array {
	const jwk = key.export({ format: "jwk" });
	return concat(
		new Uint8Array([4]),
		Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")),
		Uint8Array.from(Buffer.from(jwk.y ?? "", "base64url")),
	);
}

function ecdsaInner(privateKey: KeyObject, data: Uint8Array): Uint8Array {
	const rs = Uint8Array.from(sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" }));
	return concat(mpint(rs.subarray(0, 32)), mpint(rs.subarray(32)));
}

function ed25519Key(): SshKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const type = "ssh-ed25519";
	return {
		type,
		publicBlob: concat(sshString(type), sshString(rawEd25519Public(publicKey))),
		signInner: (data, hashAlg) => {
			// SSHSIG hashes the message itself; the key signs the signed data directly.
			void hashAlg;
			return concat(sshString(type), sshString(Uint8Array.from(sign(null, data, privateKey))));
		},
	};
}

function p256Key(): SshKey {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const type = "ecdsa-sha2-nistp256";
	return {
		type,
		publicBlob: concat(sshString(type), sshString("nistp256"), sshString(rawP256Public(publicKey))),
		signInner: (data) => concat(sshString(type), sshString(ecdsaInner(privateKey, data))),
	};
}

const SK_APPLICATION = "ssh:";

/** FIDO keys sign SHA256(application) ‖ flags ‖ counter ‖ SHA256(data) (OpenSSH PROTOCOL.u2f). */
function skMessage(data: Uint8Array, flags: number, counter: number): Uint8Array {
	return concat(sha256Of(utf8(SK_APPLICATION)), new Uint8Array([flags]), u32(counter), sha256Of(data));
}

function skEd25519Key(flags: number, counter: number): SshKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const type = "sk-ssh-ed25519@openssh.com";
	return {
		type,
		publicBlob: concat(sshString(type), sshString(rawEd25519Public(publicKey)), sshString(SK_APPLICATION)),
		signInner: (data) => {
			const sig = Uint8Array.from(sign(null, skMessage(data, flags, counter), privateKey));
			return concat(sshString(type), sshString(sig), new Uint8Array([flags]), u32(counter));
		},
	};
}

function skP256Key(flags: number, counter: number): SshKey {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const type = "sk-ecdsa-sha2-nistp256@openssh.com";
	return {
		type,
		publicBlob: concat(
			sshString(type),
			sshString("nistp256"),
			sshString(rawP256Public(publicKey)),
			sshString(SK_APPLICATION),
		),
		signInner: (data) =>
			concat(
				sshString(type),
				sshString(ecdsaInner(privateKey, skMessage(data, flags, counter))),
				new Uint8Array([flags]),
				u32(counter),
			),
	};
}

interface SshsigOptions {
	namespace?: string;
	reserved?: Uint8Array;
	hashAlg?: "sha256" | "sha512";
	version?: number;
	trailing?: Uint8Array;
}

/** OpenSSH PROTOCOL.sshsig, binary form (no armor). */
function sshsig(key: SshKey, message: Uint8Array, options: SshsigOptions = {}): Uint8Array {
	const namespace = options.namespace ?? AUTH_NAMESPACE;
	const reserved = options.reserved ?? new Uint8Array(0);
	const hashAlg = options.hashAlg ?? "sha512";
	const digest = hashAlg === "sha512" ? sha512Of(message) : sha256Of(message);
	const signedData = concat(
		utf8("SSHSIG"),
		sshString(namespace),
		sshString(reserved),
		sshString(hashAlg),
		sshString(digest),
	);
	return concat(
		utf8("SSHSIG"),
		u32(options.version ?? 1),
		sshString(key.publicBlob),
		sshString(namespace),
		sshString(reserved),
		sshString(hashAlg),
		sshString(key.signInner(signedData, hashAlg)),
		options.trailing ?? new Uint8Array(0),
	);
}

export function armor(blob: Uint8Array): string {
	const body = Buffer.from(blob)
		.toString("base64")
		.replace(/.{1,70}/g, "$&\n");
	return `-----BEGIN SSH SIGNATURE-----\n${body}-----END SSH SIGNATURE-----\n`;
}

export function unarmor(text: string): Uint8Array {
	const match = /-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)-----END SSH SIGNATURE-----/.exec(text);
	if (!match?.[1]) throw new Error("not an armored SSH signature");
	return Uint8Array.from(Buffer.from(match[1].replaceAll("\n", ""), "base64"));
}

const authorizedKey = (key: { type: string; publicBlob: Uint8Array }): string =>
	`${key.type} ${Buffer.from(key.publicBlob).toString("base64")}`;

export interface SshsigVector {
	id: string;
	description: string;
	publicKey: string;
	payloadHex: string;
	blobHex: string;
	/** Whether a crha verifier following protocol.md must accept the signature. */
	valid: boolean;
	/** What `ssh-keygen -Y verify -n crh-auth-v1` reports; null when protocol.md is stricter than OpenSSH. */
	sshKeygen: "ok" | "fail" | null;
	/** sk-* only: user presence and user verification flags in the signature. */
	userPresent?: boolean;
	userVerified?: boolean;
}

/** Signs with ssh-keygen; returns the authorized_keys line and the SSHSIG blob. */
function sshKeygenSign(
	dir: string,
	keyType: "ed25519" | "ecdsa",
	payload: Uint8Array,
): { publicKey: string; blob: Uint8Array } {
	const keyFile = join(dir, `id_${keyType}`);
	execFileSync("ssh-keygen", [
		"-q",
		"-t",
		keyType,
		...(keyType === "ecdsa" ? ["-b", "256"] : []),
		"-N",
		"",
		"-C",
		"",
		"-f",
		keyFile,
	]);
	const payloadFile = join(dir, `payload-${keyType}`);
	writeFileSync(payloadFile, payload);
	execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", AUTH_NAMESPACE, "-f", keyFile, payloadFile], {
		stdio: "ignore",
	});
	const publicKey = readFileSync(`${keyFile}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
	return { publicKey, blob: unarmor(readFileSync(`${payloadFile}.sig`, "utf8")) };
}

function buildSshsig(payload: Uint8Array, otherPayload: Uint8Array): SshsigVector[] {
	const vectors: SshsigVector[] = [];
	const add = (
		id: string,
		description: string,
		key: { type: string; publicBlob: Uint8Array },
		blob: Uint8Array,
		valid: boolean,
		sshKeygen: SshsigVector["sshKeygen"],
		extra: Partial<SshsigVector> = {},
	): void => {
		vectors.push({
			id,
			description,
			publicKey: authorizedKey(key),
			payloadHex: hex(payload),
			blobHex: hex(blob),
			valid,
			sshKeygen,
			...extra,
		});
	};

	const dir = mkdtempSync(join(tmpdir(), "crh-m4-vectors-"));
	try {
		for (const keyType of ["ed25519", "ecdsa"] as const) {
			const signed = sshKeygenSign(dir, keyType, payload);
			vectors.push({
				id: `sshsig.ssh-keygen.${keyType}`,
				description: `signed by ssh-keygen -Y sign (${keyType}, default sha512)`,
				publicKey: signed.publicKey,
				payloadHex: hex(payload),
				blobHex: hex(signed.blob),
				valid: true,
				sshKeygen: "ok",
			});
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const ed = ed25519Key();
	add(
		"sshsig.node.ed25519",
		"crhs-style ed25519 signature built with node:crypto",
		ed,
		sshsig(ed, payload),
		true,
		"ok",
	);
	add(
		"sshsig.node.ed25519.sha256",
		"hash algorithm sha256 is also accepted",
		ed,
		sshsig(ed, payload, { hashAlg: "sha256" }),
		true,
		"ok",
	);
	const ec = p256Key();
	add("sshsig.node.ecdsa-p256", "ecdsa-sha2-nistp256 with mpint r, s", ec, sshsig(ec, payload), true, "ok");

	const skUp = skEd25519Key(0x01, 7);
	add("sshsig.sk-ed25519.up", "sk-ssh-ed25519, user present", skUp, sshsig(skUp, payload), true, "ok", {
		userPresent: true,
		userVerified: false,
	});
	const skUv = skEd25519Key(0x05, 8);
	add("sshsig.sk-ed25519.up-uv", "sk-ssh-ed25519, user present and verified", skUv, sshsig(skUv, payload), true, "ok", {
		userPresent: true,
		userVerified: true,
	});
	const skNoUp = skEd25519Key(0x00, 9);
	// ssh-keygen -Y verify (OpenSSH 10.6) accepts this; protocol.md requires UP, like x/crypto/ssh.
	add(
		"sshsig.sk-ed25519.no-up",
		"sk-ssh-ed25519 without user presence: crha rejects, ssh-keygen -Y verify accepts",
		skNoUp,
		sshsig(skNoUp, payload),
		false,
		"ok",
		{ userPresent: false, userVerified: false },
	);
	const skEc = skP256Key(0x01, 3);
	add("sshsig.sk-ecdsa.up", "sk-ecdsa-sha2-nistp256, user present", skEc, sshsig(skEc, payload), true, "ok", {
		userPresent: true,
		userVerified: false,
	});

	add(
		"sshsig.wrong-namespace",
		"signed for namespace file",
		ed,
		sshsig(ed, payload, { namespace: "file" }),
		false,
		"fail",
	);
	add("sshsig.other-payload", "valid signature over a different payload", ed, sshsig(ed, otherPayload), false, "fail");
	add(
		"sshsig.reserved",
		"non-empty reserved field (protocol.md requires it empty)",
		ed,
		sshsig(ed, payload, { reserved: utf8("x") }),
		false,
		null,
	);
	add("sshsig.version-2", "SSHSIG version 2", ed, sshsig(ed, payload, { version: 2 }), false, null);
	add(
		"sshsig.trailing",
		"trailing bytes after the signature",
		ed,
		sshsig(ed, payload, { trailing: new Uint8Array([0]) }),
		false,
		null,
	);
	const tampered = sshsig(ed, payload);
	tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
	add("sshsig.bad-signature", "last signature byte flipped", ed, tampered, false, "fail");
	return vectors;
}

// ---------------------------------------------------------------------------
// WebAuthn
// ---------------------------------------------------------------------------

const RP_ID = "crh.example.com";
const ORIGIN = "https://crh.example.com";
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

interface WebauthnKey {
	alg: "ES256" | "EdDSA" | "RS256";
	coseKey: Uint8Array;
	sign(data: Uint8Array): Uint8Array;
}

function webauthnKey(alg: WebauthnKey["alg"]): WebauthnKey {
	if (alg === "ES256") {
		const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const jwk = publicKey.export({ format: "jwk" });
		const cose = new Map<number, unknown>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url"))],
			[-3, Uint8Array.from(Buffer.from(jwk.y ?? "", "base64url"))],
		]);
		return { alg, coseKey: encodeCbor(cose), sign: (data) => Uint8Array.from(sign("sha256", data, privateKey)) };
	}
	if (alg === "EdDSA") {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const cose = new Map<number, unknown>([
			[1, 1],
			[3, -8],
			[-1, 6],
			[-2, rawEd25519Public(publicKey)],
		]);
		return { alg, coseKey: encodeCbor(cose), sign: (data) => Uint8Array.from(sign(null, data, privateKey)) };
	}
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = publicKey.export({ format: "jwk" });
	const cose = new Map<number, unknown>([
		[1, 3],
		[3, -257],
		[-1, Uint8Array.from(Buffer.from(jwk.n ?? "", "base64url"))],
		[-2, Uint8Array.from(Buffer.from(jwk.e ?? "", "base64url"))],
	]);
	return { alg, coseKey: encodeCbor(cose), sign: (data) => Uint8Array.from(sign("sha256", data, privateKey)) };
}

export interface WebauthnVector {
	id: string;
	description: string;
	trust: { credentialIdHex: string; coseKeyHex: string; rpId: string; origins: string[]; requireUv: boolean };
	payloadHex: string;
	signature: { credentialIdHex: string; authenticatorDataHex: string; clientDataJson: string; signatureHex: string };
	valid: boolean;
}

interface AssertionOptions {
	flags?: number;
	counter?: number;
	type?: string;
	origin?: string;
	crossOrigin?: boolean;
	rpId?: string;
	challengePayload?: Uint8Array;
	requireUv?: boolean;
	tamper?: boolean;
	otherCredential?: boolean;
}

function buildWebauthn(payload: Uint8Array, otherPayload: Uint8Array): WebauthnVector[] {
	const keys = { ES256: webauthnKey("ES256"), EdDSA: webauthnKey("EdDSA"), RS256: webauthnKey("RS256") };
	const credentialIds = {
		ES256: Uint8Array.from(randomBytes(16)),
		EdDSA: Uint8Array.from(randomBytes(16)),
		RS256: Uint8Array.from(randomBytes(16)),
	};
	const vectors: WebauthnVector[] = [];
	const add = (
		id: string,
		description: string,
		alg: WebauthnKey["alg"],
		valid: boolean,
		o: AssertionOptions = {},
	): void => {
		const key = keys[alg];
		const authenticatorData = concat(
			sha256Of(utf8(o.rpId ?? RP_ID)),
			new Uint8Array([o.flags ?? FLAG_UP | FLAG_UV]),
			u32(o.counter ?? 1),
		);
		const clientData: Record<string, unknown> = {
			type: o.type ?? "webauthn.get",
			challenge: b64url(webauthnChallenge(o.challengePayload ?? payload)),
			origin: o.origin ?? ORIGIN,
			crossOrigin: o.crossOrigin ?? false,
		};
		const clientDataJson = JSON.stringify(clientData);
		const signature = key.sign(concat(authenticatorData, sha256Of(utf8(clientDataJson))));
		if (o.tamper) signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0x01;
		const credentialId = credentialIds[alg];
		vectors.push({
			id,
			description,
			trust: {
				credentialIdHex: hex(credentialId),
				coseKeyHex: hex(key.coseKey),
				rpId: RP_ID,
				origins: [ORIGIN],
				requireUv: o.requireUv ?? false,
			},
			payloadHex: hex(payload),
			signature: {
				credentialIdHex: hex(o.otherCredential ? Uint8Array.from(randomBytes(16)) : credentialId),
				authenticatorDataHex: hex(authenticatorData),
				clientDataJson,
				signatureHex: hex(signature),
			},
			valid,
		});
	};

	add("webauthn.es256", "ES256 (DER signature), UP and UV", "ES256", true, { requireUv: true });
	add("webauthn.eddsa", "EdDSA / Ed25519, UP and UV", "EdDSA", true, { requireUv: true });
	add("webauthn.rs256", "RS256 (PKCS#1 v1.5), UP only, UV not required", "RS256", true, { flags: FLAG_UP });
	add("webauthn.synced", "synced passkey: BE and BS set, counter 0", "ES256", true, {
		flags: FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS,
		counter: 0,
	});
	add("webauthn.no-uv", "UV required by the trust entry but missing", "ES256", false, {
		flags: FLAG_UP,
		requireUv: true,
	});
	add("webauthn.no-up", "UP missing", "ES256", false, { flags: FLAG_UV });
	add("webauthn.wrong-origin", "origin not in the trust entry's list", "ES256", false, {
		origin: "https://evil.example.com",
	});
	add("webauthn.cross-origin", "crossOrigin true is rejected by default", "ES256", false, { crossOrigin: true });
	add("webauthn.wrong-rp", "rpIdHash of another RP ID", "ES256", false, { rpId: "example.com" });
	add("webauthn.wrong-type", "type webauthn.create", "ES256", false, { type: "webauthn.create" });
	add("webauthn.other-payload", "challenge computed from a different payload", "EdDSA", false, {
		challengePayload: otherPayload,
	});
	add("webauthn.bad-signature", "last signature byte flipped", "EdDSA", false, { tamper: true });
	add("webauthn.other-credential", "credential id does not match the trust entry", "EdDSA", false, {
		otherCredential: true,
	});
	return vectors;
}

// ---------------------------------------------------------------------------
// Payloads, authorizations, bodies, crh-priv
// ---------------------------------------------------------------------------

export interface HexVector {
	id: string;
	description: string;
	hex: string;
}

export interface PayloadVector extends HexVector {
	payload: unknown;
	authorizationIdHex: string;
}

function payloadVectors(): { payloads: PayloadVector[]; negative: HexVector[] } {
	const cases: [string, string, AuthorizationPayload][] = [
		[
			"payload.crhs-exact",
			"crhs single-command authorization: exact + one task + short deadline",
			{
				v: 1,
				nodes: ["01JB0000000000000000000001"],
				command: {
					method: "exec",
					match: { kind: "exact", target: "systemctl restart nginx", specSha256: specSha256(execArgv) },
				},
				issuedAtMs: NOW,
				deadlineMs: NOW + 300_000,
				taskIds: ["0192f000-0000-7000-8000-000000000001"],
				attempt: 1,
				note: "",
			},
		],
		[
			"payload.group-one-shot",
			"one user signature covering three nodes of a task group, attempt 2",
			{
				v: 1,
				nodes: ["01JB0000000000000000000001", "01JB0000000000000000000002", "01JB0000000000000000000003"],
				command: {
					method: "exec",
					match: { kind: "exact", target: "systemctl restart nginx", specSha256: specSha256(execArgv) },
				},
				issuedAtMs: NOW,
				deadlineMs: NOW + 3_600_000,
				taskIds: [
					"0192f000-0000-7000-8000-000000000011",
					"0192f000-0000-7000-8000-000000000012",
					"0192f000-0000-7000-8000-000000000013",
				],
				attempt: 2,
				note: "重启 nginx 以加载新证书",
			},
		],
		[
			"payload.reusable-prefix",
			"reusable prefix authorization for a group, no task ids",
			{
				v: 1,
				nodes: ["group:web"],
				command: { method: "file.write", match: { kind: "prefix", target: "/etc/nginx/" } },
				issuedAtMs: NOW,
				deadlineMs: NOW + 86_400_000,
				taskIds: null,
				attempt: null,
				note: "",
			},
		],
		[
			"payload.any",
			'any command on every node that trusts the signer ("*"), no deadline',
			{ v: 1, nodes: ["*"], command: null, issuedAtMs: NOW, deadlineMs: null, taskIds: null, attempt: null, note: "" },
		],
	];
	const payloads = cases.map(([id, description, payload]) => {
		const bytes = encodeAuthorizationPayload(payload);
		return { id, description, hex: hex(bytes), payload: jsonOf(payload), authorizationIdHex: hex(sha256Of(bytes)) };
	});

	const base = cases[0]?.[2] as AuthorizationPayload;
	const raw = (value: unknown): string => hex(encodeCbor(value));
	const encoded = authorizationPayloadCodec.encode(base) as unknown[];
	const withField = (index: number, value: unknown): string => {
		const copy = [...encoded];
		copy[index] = value;
		return raw(copy);
	};
	const negative: HexVector[] = [
		{ id: "payload.v2", description: "version 2", hex: withField(0, 2) },
		{ id: "payload.empty-nodes", description: "nodes is empty", hex: withField(1, []) },
		{
			id: "payload.star-and-node",
			description: '"*" together with a node id',
			hex: withField(1, ["*", "01JB0000000000000000000001"]),
		},
		{ id: "payload.duplicate-nodes", description: "duplicate node id", hex: withField(1, ["n1", "n1"]) },
		{ id: "payload.task-ids-without-attempt", description: "taskIds set, attempt null", hex: withField(6, null) },
		{ id: "payload.attempt-without-task-ids", description: "attempt set, taskIds null", hex: withField(5, null) },
		{ id: "payload.empty-task-ids", description: "taskIds is empty", hex: withField(5, []) },
		{ id: "payload.duplicate-task-ids", description: "duplicate task id", hex: withField(5, ["t", "t"]) },
		{ id: "payload.attempt-0", description: "attempt 0", hex: withField(6, 0) },
		{
			id: "payload.short-sha",
			description: "spec_sha256 of 31 bytes",
			hex: withField(2, ["exec", ["exact", ["x", new Uint8Array(31)]]]),
		},
		{
			id: "payload.unknown-method",
			description: "method file.edit (not a method)",
			hex: withField(2, ["file.edit", ["prefix", ["/"]]]),
		},
		{ id: "payload.extra-element", description: "nine elements", hex: raw([...encoded, ""]) },
		{ id: "payload.note-null", description: "note is null instead of an empty string", hex: withField(7, null) },
		{
			id: "payload.non-canonical",
			description: "attempt 1 encoded as 0x1801 instead of 0x01",
			// The payload ends with attempt (0x01) and the empty note (0x60).
			hex: `${hex(encodeAuthorizationPayload(base)).slice(0, -4)}180160`,
		},
	];
	return { payloads, negative };
}

function authorizationVectors(
	payloads: PayloadVector[],
	sshsigBlob: Uint8Array,
	webauthn: WebauthnVector,
): HexVector[] {
	const bytesOf = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
	const make = (id: string, description: string, payloadHex: string, signatures: Signature[]): HexVector => {
		const value: Authorization = { payload: bytesOf(payloadHex), signatures };
		return { id, description, hex: hex(encodeCbor(authorizationCodec.encode(value))) };
	};
	const first = payloads[0]?.hex ?? "";
	const sshsigSig: Signature = { kind: "sshsig", blob: sshsigBlob };
	const webauthnSig: Signature = {
		kind: "webauthn",
		credentialId: bytesOf(webauthn.signature.credentialIdHex),
		authenticatorData: bytesOf(webauthn.signature.authenticatorDataHex),
		clientDataJson: utf8(webauthn.signature.clientDataJson),
		signature: bytesOf(webauthn.signature.signatureHex),
	};
	return [
		make("authorization.sshsig", "one SSHSIG signature (payload = sshsig vectors' payload)", first, [sshsigSig]),
		make("authorization.cosigned", "user WebAuthn signature plus crhs SSHSIG cosign on the same payload", first, [
			webauthnSig,
			sshsigSig,
		]),
		make("authorization.unsigned", "no signatures (verifier answers authorization_invalid)", first, []),
	];
}

const TRUST: TrustSummary = {
	nodeId: "01JB0000000000000000000001",
	groups: ["web", "prod"],
	clockSkewMs: 60_000,
	identities: { unprivileged: { uid: 998, gid: 998, user: "crha" }, privileged: { uid: 0, gid: 0, user: "root" } },
	trust: [
		{
			name: "crhs",
			source: "local",
			role: "crhs",
			key: {
				kind: "sshsig",
				publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				fingerprint: "SHA256:aaaa",
			},
			kinds: ["execute", "cosign"],
			requireExact: true,
			requireTask: true,
			requireUv: false,
			maxTtlMs: 300_000,
			allow: [
				{ method: "exec", match: "prefix", pattern: "systemctl restart " },
				{ method: "exec", match: "regex", pattern: "apt-get (update|upgrade -y)" },
				{ method: "file.write", match: "prefix", pattern: "/etc/nginx/" },
				{ method: "file.read", match: "any", pattern: "" },
			],
			deny: [
				{ method: "file.read", match: "regex", pattern: "/etc/(shadow|gshadow|sudoers.*)" },
				{ method: "file.write", match: "prefix", pattern: "/etc/crha/" },
			],
			envAllow: [],
		},
		{
			name: "ktren-passkey",
			source: "local",
			role: "user",
			key: {
				kind: "webauthn",
				credentialId: new Uint8Array([1, 2, 3, 4]),
				coseKey: new Uint8Array([0xa0]),
				rpId: RP_ID,
				origins: [ORIGIN],
			},
			kinds: ["execute", "require-cosign"],
			requireExact: false,
			requireTask: false,
			requireUv: true,
			maxTtlMs: null,
			allow: [],
			deny: [],
			envAllow: ["DEBIAN_FRONTEND"],
		},
		{
			name: "local-admins",
			source: "local",
			role: "local",
			key: { kind: "local", uids: [0, 1000] },
			kinds: ["execute"],
			requireExact: false,
			requireTask: false,
			requireUv: false,
			maxTtlMs: null,
			allow: [],
			deny: [],
			envAllow: [],
		},
	],
};

function bodyVectors(): (HexVector & { codec: string; digestHex?: string })[] {
	const body = <T>(id: string, description: string, codecName: string, codec: Codec<T>, value: T) => ({
		id,
		description,
		codec: codecName,
		hex: hex(encodeCbor(codec.encode(value))),
	});
	const summary = body(
		"trust.summary",
		"TrustSummary with crhs, passkey and local entries",
		"TrustSummary",
		trustSummaryCodec,
		TRUST,
	);
	return [
		{ ...summary, digestHex: hex(sha256Of(Uint8Array.from(Buffer.from(summary.hex, "hex")))) },
		body("trust.report.ok", "TrustReport ok", "TrustReport", trustReportCodec, { kind: "ok", summary: TRUST }),
		body("trust.report.unavailable", "TrustReport unavailable", "TrustReport", trustReportCodec, {
			kind: "unavailable",
			message: "connect /run/crha/privileged.sock: no such file or directory",
		}),
		body("trust.report.not-forward", "TrustReport not_forward", "TrustReport", trustReportCodec, {
			kind: "not_forward",
		}),
		body("revocations.add", "two revocations, one without deadline", "RevocationsAdd", revocationsAddCodec, {
			entries: [
				{ authorizationId: new Uint8Array(32).fill(0xaa), deadlineMs: NOW + 300_000 },
				{ authorizationId: new Uint8Array(32).fill(0xbb), deadlineMs: null },
			],
		}),
		body("local.request", "local approval request", "LocalRequest", localRequestCodec, {
			taskId: "0192f000-0000-7000-8000-000000000021",
			attempt: 2,
			spec: execArgv,
			note: "crhs signature was rejected; falling back to local approval",
		}),
		body("local.withdraw", "withdraw a local approval request", "LocalWithdraw", localWithdrawCodec, {
			taskId: "0192f000-0000-7000-8000-000000000021",
			attempt: 2,
		}),
		body("local.decision.approved", "approved", "LocalDecision", localDecisionCodec, {
			taskId: "0192f000-0000-7000-8000-000000000021",
			attempt: 2,
			state: { kind: "approved" },
		}),
		body("local.decision.denied", "denied with a message", "LocalDecision", localDecisionCodec, {
			taskId: "0192f000-0000-7000-8000-000000000021",
			attempt: 2,
			state: { kind: "denied", message: "denied by uid 1000" },
		}),
		body("pending.entry", "one crha pending entry", "PendingEntry", pendingEntryCodec, {
			taskId: "0192f000-0000-7000-8000-000000000021",
			attempt: 2,
			spec: execArgv,
			note: "",
			receivedAtMs: NOW,
		}),
	];
}

function privVectors(authorization: HexVector): HexVector[] {
	const commands = [
		"task.start",
		"task.input",
		"task.cancel",
		"task.query",
		"task.output",
		"task.exit",
		"trust.query",
		"trust.summary",
	];
	const hello = encodeCbor(
		privHelloCodec.encode({
			privMajor: PRIV_MAJOR,
			privMinor: PRIV_MINOR,
			commands,
			crhaVersion: "0.4.0",
			role: "forward",
		}),
	);
	const welcome = encodeCbor(
		privWelcomeCodec.encode({ privMajor: PRIV_MAJOR, privMinor: PRIV_MINOR, commands, crhaVersion: "0.4.0" }),
	);
	const start = encodeFrame({
		kind: "request",
		id: 1,
		cmd: "task.start",
		body: {
			taskId: "0192f000-0000-7000-8000-000000000001",
			attempt: 1,
			spec: execArgv,
			privileged: true,
			authorizations: [Uint8Array.from(Buffer.from(authorization.hex, "hex"))],
			timeoutMs: 60_000,
			killGraceMs: 5_000,
			output: { kind: "full", spillBytes: 51_200, spillLines: 2_000 },
		},
	});
	return [
		{ id: "priv.hello", description: "PrivHello, length-prefixed", hex: hex(lengthPrefixed(hello)) },
		{ id: "priv.welcome", description: "PrivWelcome, length-prefixed", hex: hex(lengthPrefixed(welcome)) },
		{
			id: "priv.task.start",
			description: "task.start request frame carrying one authorization, length-prefixed",
			hex: hex(lengthPrefixed(start)),
		},
	];
}

export interface M4Vectors {
	comment: string;
	specs: { id: string; spec: unknown; hex: string; sha256Hex: string }[];
	payloads: PayloadVector[];
	payloadNegative: HexVector[];
	authorizations: HexVector[];
	bodies: (HexVector & { codec: string; digestHex?: string })[];
	priv: HexVector[];
	sshsig: SshsigVector[];
	webauthn: WebauthnVector[];
}

export function buildVectors(): M4Vectors {
	const specs = Object.entries(SPECS).map(([id, spec]) => ({
		id,
		spec: taskSpecToJson(spec),
		hex: hex(encodeCbor(taskSpecCodec.encode(spec))),
		sha256Hex: hex(specSha256(spec)),
	}));
	const { payloads, negative } = payloadVectors();
	const payload = Uint8Array.from(Buffer.from(payloads[0]?.hex ?? "", "hex"));
	const otherPayload = Uint8Array.from(Buffer.from(payloads[1]?.hex ?? "", "hex"));
	const sshsigVectors = buildSshsig(payload, otherPayload);
	const webauthnVectors = buildWebauthn(payload, otherPayload);
	const crhsSig = sshsigVectors.find((v) => v.id === "sshsig.node.ed25519");
	const es256 = webauthnVectors.find((v) => v.id === "webauthn.es256");
	if (!crhsSig || !es256) throw new Error("missing base signatures");
	const authorizations = authorizationVectors(payloads, Uint8Array.from(Buffer.from(crhsSig.blobHex, "hex")), es256);
	return {
		comment:
			"Generated by packages/protocol/test/generate-m4-vectors.ts with fresh keys; checked by m4_vectors.test.ts. Format: doc/protocol.md#m4提权.",
		specs,
		payloads,
		payloadNegative: negative,
		authorizations,
		bodies: bodyVectors(),
		priv: privVectors(authorizations[0] as HexVector),
		sshsig: sshsigVectors,
		webauthn: webauthnVectors,
	};
}

export { ZERO32 };
