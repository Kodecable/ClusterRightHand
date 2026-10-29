import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_NAMESPACE } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import {
	authorizedKeyLine,
	ed25519PublicBlob,
	parseAuthorizedKey,
	signSshsig,
	sshFingerprint,
	verifySshsig,
} from "../src/privilege/sshsig.ts";

interface SshsigVector {
	id: string;
	description: string;
	publicKey: string;
	payloadHex: string;
	blobHex: string;
	valid: boolean;
	userVerified?: boolean;
}

const vectors = JSON.parse(readFileSync(new URL("../../test/interop/m4_vectors.json", import.meta.url), "utf8")) as {
	sshsig: SshsigVector[];
};

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const utf8 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "utf8"));

/** The armored SSHSIG file ssh-keygen -Y verify expects. */
function armor(blob: Uint8Array): string {
	const body = Buffer.from(blob)
		.toString("base64")
		.replace(/.{1,70}/g, "$&\n");
	return `-----BEGIN SSH SIGNATURE-----\n${body}-----END SSH SIGNATURE-----\n`;
}

const sshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe("SSHSIG verifier", () => {
	it.each(vectors.sshsig.map((v) => [v.id, v] as const))("%s matches the shared vectors", (_id, vector) => {
		const result = verifySshsig(vector.publicKey, bytesOf(vector.payloadHex), bytesOf(vector.blobHex));
		expect(result.valid, result.valid ? "" : result.reason).toBe(vector.valid);
		if (result.valid && vector.userVerified !== undefined) {
			expect(result.userVerified).toBe(vector.userVerified);
		}
	});

	it("rejects a valid signature over a different payload", () => {
		const valid = vectors.sshsig.find((v) => v.valid && v.id === "sshsig.node.ed25519");
		if (!valid) throw new Error("vector missing");
		const result = verifySshsig(valid.publicKey, utf8("another payload"), bytesOf(valid.blobHex));
		expect(result).toEqual({ valid: false, reason: "signature does not verify" });
	});

	it("rejects a signature checked against a different key", () => {
		const valid = vectors.sshsig.find((v) => v.valid && v.id === "sshsig.node.ed25519");
		if (!valid) throw new Error("vector missing");
		const other = generateKeyPairSync("ed25519").publicKey;
		const line = authorizedKeyLine("ssh-ed25519", ed25519PublicBlob(other));
		expect(verifySshsig(line, bytesOf(valid.payloadHex), bytesOf(valid.blobHex))).toEqual({
			valid: false,
			reason: "signature is for another key",
		});
	});

	it.each([
		["garbage", new Uint8Array([1, 2, 3])],
		["empty", new Uint8Array(0)],
	])("fails closed on %s input", (_name, blob) => {
		const valid = vectors.sshsig.find((v) => v.valid && v.id === "sshsig.node.ed25519");
		if (!valid) throw new Error("vector missing");
		const result = verifySshsig(valid.publicKey, bytesOf(valid.payloadHex), blob);
		expect(result.valid).toBe(false);
	});

	it("rejects a malformed trust key line", () => {
		expect(verifySshsig("not a key", new Uint8Array(0), new Uint8Array(0))).toEqual({
			valid: false,
			reason: "unsupported key type not",
		});
		expect(verifySshsig("ssh-ed25519", new Uint8Array(0), new Uint8Array(0))).toEqual({
			valid: false,
			reason: "not an authorized_keys line",
		});
	});
});

describe("SSHSIG signer", () => {
	const payload = utf8("the payload bytes, not a pre-hash");
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyBlob = ed25519PublicBlob(publicKey);
	const line = authorizedKeyLine("ssh-ed25519", publicKeyBlob, "crhs-signing");

	it("produces a signature that the verifier accepts", () => {
		const blob = signSshsig(privateKey, publicKeyBlob, payload);
		expect(verifySshsig(line, payload, blob)).toEqual({
			valid: true,
			keyType: "ssh-ed25519",
			userPresent: false,
			userVerified: false,
			hashAlg: "sha512",
		});
	});

	it("produces a deterministic key blob with an OpenSSH fingerprint", () => {
		const parsed = parseAuthorizedKey(line);
		expect(parsed.keyType).toBe("ssh-ed25519");
		expect(Buffer.from(parsed.blob).toString("base64")).toBe(Buffer.from(publicKeyBlob).toString("base64"));
		expect(sshFingerprint(publicKeyBlob)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
		expect(sshFingerprint(publicKeyBlob)).not.toMatch(/=$/);
	});

	it.skipIf(!sshKeygen)("interoperates with ssh-keygen -Y verify", () => {
		const dir = mkdtempSync(join(tmpdir(), "crh-sshsig-"));
		try {
			const blob = signSshsig(privateKey, publicKeyBlob, payload);
			const allowed = join(dir, "allowed_keys");
			const sig = join(dir, "payload.sig");
			writeFileSync(allowed, `test@crh ${line}\n`);
			writeFileSync(sig, armor(blob));
			expect(() =>
				execFileSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "test@crh", "-n", AUTH_NAMESPACE, "-s", sig], {
					input: Buffer.from(payload),
					stdio: ["pipe", "ignore", "ignore"],
				}),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!sshKeygen)("ssh-keygen rejects the signature over a different payload", () => {
		const dir = mkdtempSync(join(tmpdir(), "crh-sshsig-"));
		try {
			const blob = signSshsig(privateKey, publicKeyBlob, payload);
			const allowed = join(dir, "allowed_keys");
			const sig = join(dir, "payload.sig");
			writeFileSync(allowed, `test@crh ${line}\n`);
			writeFileSync(sig, armor(blob));
			expect(() =>
				execFileSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "test@crh", "-n", AUTH_NAMESPACE, "-s", sig], {
					input: Buffer.from(utf8("other")),
					stdio: ["pipe", "ignore", "ignore"],
				}),
			).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
