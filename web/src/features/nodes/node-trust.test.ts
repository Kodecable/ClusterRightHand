import { describe, expect, test } from "vitest";
import { trustKeyText } from "./node-trust";

describe("trustKeyText", () => {
	test("an SSHSIG key is named by its fingerprint", () => {
		expect(trustKeyText({ kind: "sshsig", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:abc" })).toBe(
			"SHA256:abc",
		);
	});

	test("a WebAuthn key is named by its credential id in base64url, as privileged.toml writes it", () => {
		expect(
			trustKeyText({
				kind: "webauthn",
				// The API's standard base64 of bytes fb ff 0e 72 → base64url "-_8Ocg".
				credentialId: "+/8Ocg==",
				coseKey: "BAUG",
				rpId: "cluster.local",
				origins: ["https://cluster.local"],
			}),
		).toBe("-_8Ocg");
	});

	test("a local key lists its uids", () => {
		expect(trustKeyText({ kind: "local", uids: [0, 1000] })).toBe("0, 1000");
	});
});
