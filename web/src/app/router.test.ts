import type { User } from "@crh/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import { router } from "./router";

const ADMIN: User = {
	id: "u-admin",
	username: "root",
	displayName: "Root",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const MEMBER: User = { ...ADMIN, id: "u-member", username: "ada", kind: "member" };

function mockSession(user: User): void {
	const json = (payload: unknown) =>
		new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			return path === "/api/me" ? json({ user }) : json({});
		}),
	);
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("administrator routes", () => {
	test("a member is redirected away from System settings", async () => {
		mockSession(MEMBER);
		await authStore.load();

		await router.navigate({ to: "/settings/system" });

		expect(router.state.location.pathname).toBe("/sessions");
	});

	test("an administrator reaches System settings", async () => {
		mockSession(ADMIN);
		await authStore.load();

		await router.navigate({ to: "/settings/system" });

		expect(router.state.location.pathname).toBe("/settings/system");
	});
});
