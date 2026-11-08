import { describe, expect, test } from "vitest";
import { trustKeyText } from "./node-trust";

describe("trustKeyText", () => {
	test("an SSHSIG key is named by its fingerprint", () => {
		expect(trustKeyText({ kind: "sshsig", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:abc" })).toBe(
			"SHA256:abc",
		);
	});

	test("a WebAuthn key is named by its RP id", () => {
		expect(
			trustKeyText({
				kind: "webauthn",
				credentialId: new Uint8Array([1, 2, 3]),
				coseKey: new Uint8Array([4, 5, 6]),
				rpId: "cluster.local",
				origins: ["https://cluster.local"],
			}),
		).toBe("cluster.local");
	});

	test("a local key lists its uids", () => {
		expect(trustKeyText({ kind: "local", uids: [0, 1000] })).toBe("0, 1000");
	});
});
