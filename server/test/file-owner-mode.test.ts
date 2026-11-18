import { describe, expect, it } from "vitest";
import { modeAfterOwnerRestore } from "../src/cluster/ssh/file-task.ts";

describe("modeAfterOwnerRestore", () => {
	it("keeps setuid and setgid when the owner and group were restored", () => {
		expect(modeAfterOwnerRestore(0o6755, true, true)).toBe(0o6755);
	});

	it("clears both bits when either the owner or the group was not restored", () => {
		for (const [ownerKept, groupKept] of [
			[false, true],
			[true, false],
			[false, false],
		] as const) {
			expect(modeAfterOwnerRestore(0o6755, ownerKept, groupKept)).toBe(0o755);
		}
	});
});
