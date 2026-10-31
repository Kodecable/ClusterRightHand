import { describe, expect, test } from "vitest";
import { pendingCount } from "./pending";

describe("pendingCount", () => {
	test("counts a waiting task group once, whatever its node count", () => {
		expect(pendingCount(undefined)).toBe(0);
		const group = { id: "g1", nodeIds: ["n1", "n2", "n3"] };
		// The server lists a waiting group, never its member tasks: three nodes are still one entry.
		expect(
			pendingCount({ tasks: [], taskGroups: [], authorizations: { tasks: [], taskGroups: [group] }, quotas: [] }),
		).toBe(1);
		const quotas = [{ sessionId: "s1" }, { sessionId: "s2" }];
		expect(
			pendingCount({
				tasks: [{}, {}],
				taskGroups: [group],
				authorizations: { tasks: [{}], taskGroups: [group] },
				quotas,
			}),
		).toBe(7);
	});
});
