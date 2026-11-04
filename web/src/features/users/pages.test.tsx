import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import type { NodeAccessGrant, User, UserGroup } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { UsersPage } from "./pages";

const ME: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const OTHER: User = { ...ME, id: "u2", username: "alice", displayName: "Alice", kind: "member" };

const OPS_GROUP: UserGroup = {
	id: "group-1",
	name: "Ops",
	source: "local",
	createdAt: "2026-01-01T00:00:00.000Z",
	memberIds: [],
};

function grant(overrides: Partial<NodeAccessGrant> = {}): NodeAccessGrant {
	return {
		id: "grant-1",
		granteeType: "user",
		granteeId: OTHER.id,
		granteeName: OTHER.username,
		targetType: "node",
		targetId: "node-1",
		targetName: "worker-01",
		createdAt: "2026-01-01T00:00:00.000Z",
		createdByUserId: ME.id,
		...overrides,
	};
}

function mockFetch(
	users: User[] = [ME, OTHER],
	{ groups = [] as UserGroup[], grants = [] as NodeAccessGrant[] } = {},
): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user: ME });
			if (path === "/api/users") return json({ users });
			if (path === "/api/user-groups") return json({ groups });
			if (path === "/api/node-access-grants" && (init?.method ?? "GET") === "GET") return json({ grants });
			return json({});
		}),
	);
}

async function renderPage(options?: { groups?: UserGroup[]; grants?: NodeAccessGrant[] }): Promise<void> {
	mockFetch([ME, OTHER], options);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<UsersPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("UsersPage self-change guards", () => {
	test("your own row cannot change kind or be disabled", async () => {
		await renderPage();

		expect(await screen.findByLabelText("Kind of ops")).toBeDisabled();
		expect(screen.getByLabelText("Kind of alice")).toBeEnabled();
		// The reason is on the disabled controls, not in a page-wide hint.
		expect(screen.queryByTestId("self-change-hint")).not.toBeInTheDocument();
		expect(screen.getByTitle("You cannot change your own kind.")).toBeInTheDocument();

		const disable = screen.getAllByRole("button", { name: "Disable" });
		expect(disable).toHaveLength(2);
		expect(disable[0]).toBeDisabled();
		expect(disable[0]).toHaveAttribute("title", "You cannot disable your own account.");
		expect(disable[1]).toBeEnabled();
	});
});

describe("UsersPage node access", () => {
	test("shows the grants a user and a user group hold", async () => {
		await renderPage({
			groups: [OPS_GROUP],
			grants: [
				grant(),
				grant({
					id: "grant-2",
					granteeType: "user_group",
					granteeId: OPS_GROUP.id,
					granteeName: OPS_GROUP.name,
					targetType: "node_group",
					targetId: "node-group-1",
					targetName: "web",
				}),
			],
		});

		const row = (await screen.findByText("alice")).closest('[role="row"]');
		if (!(row instanceof HTMLElement)) throw new Error("no user row");
		const nodeLink = await screen.findByRole("link", { name: "worker-01" });
		expect(nodeLink).toHaveAttribute("href", "/nodes/node-1");
		expect(row).toContainElement(nodeLink);
		expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "/node-groups/node-group-1");
		const groupCard = await screen.findByTestId("user-group-card");
		expect(groupCard).toContainElement(screen.getByRole("link", { name: "web" }));
		expect(screen.getAllByRole("button", { name: /Remove access/ })).toHaveLength(2);
	});
});
