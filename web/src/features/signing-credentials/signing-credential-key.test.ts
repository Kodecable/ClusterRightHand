import type { SigningCredentialView } from "@crh/api";
import { expect, test } from "vitest";
import { signingCredentialKeyId } from "@/lib/signing-credential-key";

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
