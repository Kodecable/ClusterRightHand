import { describe, expect, test } from "vitest";
import { grantCommand, sshKeygenRecipe } from "./authorization";

describe("signing recipes", () => {
	test("grantCommand and sshKeygenRecipe sign the exact payload bytes", () => {
		expect(grantCommand("AQID")).toBe("crha grant --payload AQID --key ~/.ssh/id_ed25519");
		const recipe = sshKeygenRecipe("AQID");
		expect(recipe).toContain("printf %s 'AQID' | base64 -d > crh-payload.bin");
		expect(recipe).toContain("ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin");
		expect(recipe).toContain("crh-payload.bin.sig");
	});
});
