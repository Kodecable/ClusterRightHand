import { describe, expect, test } from "vitest";
import { grantCommand, sshKeygenRecipe } from "./authorization";

describe("signing recipes", () => {
	test("grantCommand and sshKeygenRecipe sign the exact payload bytes", () => {
		expect(grantCommand("AQID")).toBe("crhu sign --payload AQID");
		expect(grantCommand("AQID", ["SHA256:one", "SHA256:two"])).toBe(
			"crhu sign --payload AQID --hint SHA256:one --hint SHA256:two",
		);
		const recipe = sshKeygenRecipe("AQID");
		expect(recipe).toContain("printf %s 'AQID' | base64 -d > crh-payload.bin");
		expect(recipe).toContain("ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin");
		expect(recipe).toContain("crh-payload.bin.sig");
		expect(recipe).toContain("base64 Authorization that `crhu sign` prints");
	});
});
