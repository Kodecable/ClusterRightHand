import { describe, expect, test } from "vitest";
import { NAV_ITEMS, navItemForPath } from "./nav";

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

	test("keeps System settings active on its own route, not Models", () => {
		expect(navItemForPath("/settings/system")?.to).toBe("/settings/system");
		expect(navItemForPath("/settings/models")?.to).toBe("/settings/models");
	});

	test("does not take a path that only shares a prefix", () => {
		expect(navItemForPath("/usersomething")).toBeUndefined();
		expect(navItemForPath("/node-groups/group-1")?.to).toBe("/node-groups");
	});
});

describe("admin navigation", () => {
	test("puts System settings beside Models and marks it administrators-only", () => {
		const admin = NAV_ITEMS.map((item) => item.to);
		const models = admin.indexOf("/settings/models");
		expect(models).toBeGreaterThanOrEqual(0);
		expect(admin[models + 1]).toBe("/settings/system");
		expect(NAV_ITEMS.find((item) => item.to === "/settings/system")?.adminOnly).toBe(true);
	});
});
