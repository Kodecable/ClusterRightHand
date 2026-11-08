import type { CredentialView } from "@crh/api";
import { describe, expect, test } from "vitest";
import { credentialTrustSnippet, toBase64url, tomlString, trustSnippet } from "./trust";

describe("tomlString", () => {
	test("escapes quotes and backslashes", () => {
		expect(tomlString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
	});
});

describe("trustSnippet", () => {
	test("builds the crhs trust entry for privileged.toml", () => {
		const snippet = trustSnippet("ssh-ed25519 AAAAkey crhs-signing");
		expect(snippet).toContain("[[trust]]");
		expect(snippet).toContain('name          = "crhs"');
		expect(snippet).toContain('role          = "crhs"');
		expect(snippet).toContain('format        = "sshsig"');
		expect(snippet).toContain('key           = "ssh-ed25519 AAAAkey crhs-signing"');
		expect(snippet).toContain('kinds         = ["execute", "cosign"]');
		expect(snippet).toContain("require_exact = true");
		expect(snippet).toContain('max_ttl       = "5m"');
		expect(snippet).toContain('{ method = "exec", prefix = "systemctl restart " },');
		expect(snippet).toContain('{ method = "file.read", prefix = "/var/log/" },');
		expect(snippet).toContain('{ method = "file.write", prefix = "/etc/crha/" },');
		expect(snippet.endsWith("\n")).toBe(true);
	});

	test("escapes the TOML basic string", () => {
		const snippet = trustSnippet('ssh-ed25519 AA"AA\\key comment');
		expect(snippet).toContain('key           = "ssh-ed25519 AA\\"AA\\\\key comment"');
	});
});

const sshCredential: CredentialView = {
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

const passkeyCredential: CredentialView = {
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

describe("credentialTrustSnippet", () => {
	test("builds a user entry for an SSH key", () => {
		const snippet = credentialTrustSnippet(sshCredential);
		expect(snippet).toContain("[[trust]]");
		expect(snippet).toContain('name          = "laptop"');
		expect(snippet).toContain('role          = "user"');
		expect(snippet).toContain('format        = "sshsig"');
		expect(snippet).toContain('key           = "ssh-ed25519 AAAAC3Nza laptop"');
		expect(snippet).toContain('kinds         = ["execute"]');
		expect(snippet).toContain("# require_uv = true");
		expect(snippet.endsWith("\n")).toBe(true);
	});

	test("builds a webauthn entry with the COSE key and RP", () => {
		const snippet = credentialTrustSnippet(passkeyCredential);
		expect(snippet).toContain('format        = "webauthn"');
		expect(snippet).toContain('rp_id         = "crh.example.com"');
		expect(snippet).toContain('origins       = ["https://crh.example.com"]');
		expect(snippet).toContain('credential_id = "AAECAwQ"');
		expect(snippet).toContain('key           = "cose:o2NmbXRkbm9uZQ-_"');
		expect(snippet).not.toContain("o2NmbXRkbm9uZQ+/");
	});

	test("escapes names, keys and origins as TOML strings", () => {
		const snippet = credentialTrustSnippet({
			...sshCredential,
			name: 'a "b" \\c',
			publicKey: 'ssh-ed25519 AA"AA',
		});
		expect(snippet).toContain('name          = "a \\"b\\" \\\\c"');
		expect(snippet).toContain('key           = "ssh-ed25519 AA\\"AA"');
	});
});

test("toBase64url strips padding and maps +/", () => {
	expect(toBase64url("a+b/c==")).toBe("a-b_c");
});
