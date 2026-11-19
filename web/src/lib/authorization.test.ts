import { describe, expect, test } from "vitest";
import {
	base64urlToBase64,
	grantCommand,
	SPEC_ARGUMENT_LIMIT,
	sshKeygenRecipe,
	sshRegistrationCommand,
	sshRegistrationRecipe,
} from "./authorization";

describe("signing recipes", () => {
	test("crhu sign carries the spec and the matching credential fingerprints as hints", () => {
		expect(grantCommand("AQID", "c3BlYw==")).toBe("crhu sign --payload AQID --spec c3BlYw==");
		expect(grantCommand("AQID", "c3BlYw==", ["SHA256:one"])).toBe(
			"crhu sign --payload AQID --hint SHA256:one --spec c3BlYw==",
		);
		// A payload with no spec command limit has nothing to check a spec against.
		expect(grantCommand("AQID")).toBe("crhu sign --payload AQID");
		expect(grantCommand("AQID", undefined, ["SHA256:one"])).toBe("crhu sign --payload AQID --hint SHA256:one");
	});

	test("a spec too large for the argument list is read from a heredoc", () => {
		const spec = "A".repeat(SPEC_ARGUMENT_LIMIT + 1);
		expect(grantCommand("AQID", spec)).toBe(`crhu sign --payload AQID --spec - <<'EOF'\n${spec}\nEOF`);
		expect(grantCommand("AQID", "A".repeat(SPEC_ARGUMENT_LIMIT))).toContain("--spec AAAA");
	});

	test("the manual payload recipe names the output the endpoint takes", () => {
		const recipe = sshKeygenRecipe("AQID");
		expect(recipe).toContain("`crhu sign` prints the base64 Authorization the API takes");
	});

	test("registration commands sign the decoded challenge bytes", () => {
		expect(sshRegistrationCommand("AQID")).toBe("crhu register AQID");
		const recipe = sshRegistrationRecipe("_-8");
		expect(base64urlToBase64("_-8")).toBe("/+8=");
		expect(recipe).toContain("printf %s '/+8=' | base64 -d > crh-register.bin");
		expect(recipe).toContain("ssh-keygen -Y sign -n crh-register-v1 -f ~/.ssh/id_ed25519 crh-register.bin");
		expect(recipe).toContain("paste crh-register.bin.sig");
	});

	test("base64url padding is restored for the shell", () => {
		expect(base64urlToBase64("YQ")).toBe("YQ==");
		expect(base64urlToBase64("YWI")).toBe("YWI=");
		expect(base64urlToBase64("YWJj")).toBe("YWJj");
	});
});
