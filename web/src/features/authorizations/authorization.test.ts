import { describe, expect, test } from "vitest";
import { grantCommand, sshKeygenRecipe } from "./authorization";

describe("signing recipes", () => {
	test("grantCommand and sshKeygenRecipe sign the exact payload bytes", () => {
		expect(grantCommand("AQID", "c3BlYw==")).toBe("crhu sign --payload AQID --spec c3BlYw==");
		expect(grantCommand("AQID", "c3BlYw==", ["SHA256:one", "SHA256:two"])).toBe(
			"crhu sign --payload AQID --hint SHA256:one --hint SHA256:two --spec c3BlYw==",
		);
		const recipe = sshKeygenRecipe("AQID");
		expect(recipe).toContain("printf %s 'AQID' | base64 -d > crh-payload.bin");
		expect(recipe).toContain("ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin");
		expect(recipe).toContain("crh-payload.bin.sig");
		expect(recipe).toContain("`crhu sign` prints the base64 Authorization the API takes");
	});
});
