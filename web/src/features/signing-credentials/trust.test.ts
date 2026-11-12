import type { SigningCredentialView } from "@crh/api";
import { describe, expect, test } from "vitest";
import { buildTrustConfig, signingCredentialKeyId, toBase64url, tomlString } from "./trust";

describe("tomlString", () => {
	test("escapes quotes and backslashes", () => {
		expect(tomlString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
	});
});

test("toBase64url strips padding and maps +/", () => {
	expect(toBase64url("a+b/c==")).toBe("a-b_c");
});

const sshCredential: SigningCredentialView = {
	id: "c1",
	kind: "ssh",
	name: "laptop",
	createdAt: "2026-01-01T00:00:00.000Z",
	publicKey: "ssh-ed25519 AAAAC3Nza laptop",
	fingerprint: "SHA256:abc",
	credentialId: null,
	rpId: null,
	origins: [],
};

const passkeyCredential: SigningCredentialView = {
	id: "c2",
	kind: "webauthn",
	name: "yubikey",
	createdAt: "2026-01-01T00:00:00.000Z",
	// "/" and "+" become "_" and "-" in the trust config, and the padding goes away.
	publicKey: "o2NmbXRkbm9uZQ+/",
	fingerprint: null,
	credentialId: "AAECAwQ",
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
};

test("signingCredentialKeyId gives the SSH fingerprint or the Passkey credential id", () => {
	expect(signingCredentialKeyId(sshCredential)).toBe("SHA256:abc");
	expect(signingCredentialKeyId(passkeyCredential)).toBe("AAECAwQ");
});

describe("buildTrustConfig", () => {
	test("trusts crhs alone when no signing credential is selected", () => {
		expect(buildTrustConfig("ssh-ed25519 AAAAkey crhs-signing", [])).toBe(
			[
				"[[trust]]",
				'name          = "crhs"',
				'role          = "crhs"',
				'format        = "sshsig"',
				'key           = "ssh-ed25519 AAAAkey crhs-signing"',
				'kinds         = ["execute"]',
				"",
			].join("\n"),
		);
	});

	test("makes crhs a cosigner for selected SSH and Passkey credentials", () => {
		expect(buildTrustConfig("ssh-ed25519 AAAAkey crhs-signing", [sshCredential, passkeyCredential])).toBe(
			[
				"[[trust]]",
				'name          = "crhs"',
				'role          = "crhs"',
				'format        = "sshsig"',
				'key           = "ssh-ed25519 AAAAkey crhs-signing"',
				'kinds         = ["cosign"]',
				"",
				"[[trust]]",
				'name          = "laptop"',
				'role          = "user"',
				'format        = "sshsig"',
				'key           = "ssh-ed25519 AAAAC3Nza laptop"',
				'kinds         = ["execute", "require-cosign"]',
				"",
				"[[trust]]",
				'name          = "yubikey"',
				'role          = "user"',
				'format        = "webauthn"',
				'rp_id         = "crh.example.com"',
				'origins       = ["https://crh.example.com"]',
				'credential_id = "AAECAwQ"',
				'key           = "cose:o2NmbXRkbm9uZQ-_"',
				'kinds         = ["execute", "require-cosign"]',
				"",
			].join("\n"),
		);
	});

	test("deduplicates user entry names and never uses crhs", () => {
		const snippet = buildTrustConfig("ssh-ed25519 AAAAkey crhs-signing", [
			{ ...sshCredential, id: "c1", name: "laptop" },
			{ ...sshCredential, id: "c2", name: "laptop" },
			{ ...sshCredential, id: "c3", name: "crhs" },
			{ ...sshCredential, id: "c4", name: "crhs" },
		]);
		const names = [...snippet.matchAll(/^name\s+= "(.+)"$/gm)].map((match) => match[1]);
		expect(names).toEqual(["crhs", "laptop", "laptop-2", "crhs-2", "crhs-3"]);
	});

	test("escapes the crhs key and user fields as TOML strings", () => {
		const snippet = buildTrustConfig('ssh-ed25519 AA"AA\\key comment', [
			{ ...sshCredential, name: 'a "b" \\c', publicKey: 'ssh-ed25519 AA"AA\\key' },
		]);
		expect(snippet).toContain('key           = "ssh-ed25519 AA\\"AA\\\\key comment"');
		expect(snippet).toContain('name          = "a \\"b\\" \\\\c"');
		expect(snippet).toContain('key           = "ssh-ed25519 AA\\"AA\\\\key"');
	});
});
