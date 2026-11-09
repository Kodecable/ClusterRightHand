import { describe, expect, test } from "vitest";
import { navItemForPath } from "./nav";

describe("navItemForPath", () => {
	test("keeps Users active for user details and user groups", () => {
		expect(navItemForPath("/users")?.to).toBe("/users");
		expect(navItemForPath("/users/u1")?.to).toBe("/users");
		expect(navItemForPath("/user-groups")?.to).toBe("/users");
		expect(navItemForPath("/user-groups/group-1")?.to).toBe("/users");
	});

	test("keeps Tasks active for a task group detail", () => {
		expect(navItemForPath("/task-groups/g1")?.to).toBe("/tasks");
	});

	test("does not take a path that only shares a prefix", () => {
		expect(navItemForPath("/usersomething")).toBeUndefined();
		expect(navItemForPath("/node-groups/group-1")?.to).toBe("/node-groups");
	});
});
