import type { NodeAccessGrant, User, UserGroupDetail } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/lib/session";
import { renderWithRouter } from "@/test/render";
import { UserGroupDetailPage } from "./user-group-page";

/** The route params `useParams` returns; the detail page's test sets the group id. */
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useParams: () => route.params };
});

const ADMIN: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const ALICE: User = { ...ADMIN, id: "u2", username: "alice", displayName: "Alice" };
const BOB: User = { ...ADMIN, id: "u3", username: "bob", displayName: "Bob" };

const GROUP: UserGroupDetail = {
	id: "group-1",
	name: "ops",
	createdAt: "2026-01-01T00:00:00.000Z",
	members: [{ id: ALICE.id, username: ALICE.username, displayName: ALICE.displayName }],
};

const NODE = { id: "node-1", name: "worker-01", hostname: "worker-01.example", status: "active", connected: true };
const NODE_GROUP = { id: "ng-1", name: "Ops fleet", memberIds: ["node-1"] };

function grant(overrides: Partial<NodeAccessGrant> = {}): NodeAccessGrant {
	return {
		id: "grant-1",
		granteeType: "user_group",
		granteeId: GROUP.id,
		granteeName: GROUP.name,
		targetType: "node",
		targetId: "node-1",
		targetName: "worker-01",
		createdAt: "2026-01-01T00:00:00.000Z",
		createdByUserId: ADMIN.id,
		...overrides,
	};
}

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function mockFetch(grants: NodeAccessGrant[] = []): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url: path, method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user: ADMIN });
			if (path === "/api/users") return json({ users: [ADMIN, ALICE, BOB] });
			if (path === "/api/user-groups/group-1" && method === "GET") return json({ group: GROUP });
			if (path === "/api/user-groups/group-1" && method === "PATCH")
				return json({ group: { ...GROUP, name: (body as { name: string }).name } });
			if (path === "/api/user-groups/group-1" && method === "DELETE") return json({ ok: true });
			if (/^\/api\/user-groups\/group-1\/members\/[^/]+$/.test(path)) return json({ ok: true });
			if (path === "/api/nodes") return json({ nodes: [NODE] });
			if (path === "/api/node-groups") return json({ groups: [NODE_GROUP] });
			if (path === "/api/node-access-grants" && method === "GET") {
				const granteeType = url.searchParams.get("granteeType");
				const granteeId = url.searchParams.get("granteeId");
				return json({
					grants: grants.filter(
						(grant) =>
							(granteeType === null || grant.granteeType === granteeType) &&
							(granteeId === null || grant.granteeId === granteeId),
					),
				});
			}
			if (path === "/api/node-access-grants" && method === "POST") {
				const input = body as Pick<NodeAccessGrant, "granteeType" | "granteeId" | "targetType" | "targetId">;
				const created = grant({
					id: `grant-${grants.length + 1}`,
					...input,
					targetName: input.targetType === "node" ? NODE.name : NODE_GROUP.name,
				});
				grants.push(created);
				return json({ grant: created }, 201);
			}
			const grantDelete = /^\/api\/node-access-grants\/([^/]+)$/.exec(path);
			if (grantDelete && method === "DELETE") {
				const id = decodeURIComponent(grantDelete[1] as string);
				const index = grants.findIndex((grant) => grant.id === id);
				if (index >= 0) grants.splice(index, 1);
				return json({ ok: true });
			}
			return json({});
		}),
	);
	return { calls };
}

async function renderPage(grants: NodeAccessGrant[] = []): Promise<{ calls: Call[] }> {
	route.params = { userGroupId: "group-1" };
	const { calls } = mockFetch(grants);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<UserGroupDetailPage />
		</QueryClientProvider>,
	);
	return { calls };
}

afterEach(() => {
	authStore.clear();
	route.params = {};
	vi.unstubAllGlobals();
});

describe("UserGroupDetailPage", () => {
	test("lists members as user links and adds and removes one", async () => {
		const { calls } = await renderPage();
		expect(await screen.findByRole("heading", { name: "ops" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "All users" })).toHaveAttribute("href", "/users");
		expect(screen.getByRole("link", { name: "Alice" })).toHaveAttribute("href", "/users/u2");

		const members = screen.getByTestId("user-group-members");
		expect(within(members).getByRole("columnheader", { name: "Role" })).toBeInTheDocument();
		expect(within(members).getByRole("columnheader", { name: "Status" })).toBeInTheDocument();

		const user = userEvent.setup();
		await user.click(screen.getByTestId("add-member"));
		const dialog = await screen.findByTestId("add-member-dialog");
		await user.click(within(dialog).getByRole("combobox", { name: "User" }));
		await user.click(await screen.findByRole("option", { name: /Bob/ }));
		await user.click(within(dialog).getByRole("button", { name: "Add" }));
		await waitFor(() =>
			expect(calls.find((call) => call.method === "PUT")?.url).toBe("/api/user-groups/group-1/members/u3"),
		);

		const remove = screen.getByRole("button", { name: "Remove alice from ops" });
		expect(remove).toHaveTextContent("Remove");
		await fireEvent.click(remove);
		const confirm = screen.getByRole("dialog", { name: "Remove alice from ops?" });
		await fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(calls.find((call) => call.method === "DELETE" && call.url.includes("/members/"))?.url).toBe(
				"/api/user-groups/group-1/members/u2",
			),
		);
		// The group page has a node access section; this group holds no grants.
		expect(screen.getByTestId("grantee-node-access")).toHaveTextContent("No node access");
	});

	test("shows the group's node access and removes a grant", async () => {
		const { calls } = await renderPage([
			grant(),
			grant({ id: "grant-2", targetType: "node_group", targetId: "ng-1", targetName: "Ops fleet" }),
		]);

		const section = await screen.findByTestId("grantee-node-access");
		const nodeRow = (await within(section).findByRole("link", { name: "worker-01" })).closest('[role="row"]');
		if (!(nodeRow instanceof HTMLElement)) throw new Error("no node grant row");
		expect(within(nodeRow).getByText("Node")).toBeInTheDocument();
		expect(nodeRow).toHaveTextContent("worker-01");
		// A grant on a node group links to the node group page and carries a Node group badge.
		const groupRow = (await within(section).findByRole("link", { name: "Ops fleet" })).closest('[role="row"]');
		if (!(groupRow instanceof HTMLElement)) throw new Error("no node group grant row");
		expect(within(groupRow).getByText("Node group")).toBeInTheDocument();
		const remove = within(section).getByRole("button", { name: "Remove access to worker-01 for ops" });
		expect(remove).toHaveTextContent("Remove");

		await fireEvent.click(remove);
		const confirm = screen.getByRole("dialog");
		await fireEvent.click(within(confirm).getByRole("button", { name: "Remove access" }));
		await waitFor(() =>
			expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/node-access-grants/grant-1")).toBe(
				true,
			),
		);
		await waitFor(() => expect(within(section).queryByRole("link", { name: "worker-01" })).not.toBeInTheDocument());
		expect(within(section).getByRole("link", { name: "Ops fleet" })).toBeInTheDocument();
	});

	test("adds node access for the group through the merged node target picker", async () => {
		const { calls } = await renderPage();
		await screen.findByRole("heading", { name: "ops" });

		const section = screen.getByTestId("grantee-node-access");
		const user = userEvent.setup();
		await user.click(within(section).getByTestId("add-access"));
		const dialog = await screen.findByTestId("grantee-add-access-dialog");
		await user.click(within(dialog).getByRole("combobox", { name: "Node or node group" }));
		const groupOption = await screen.findByRole("option", { name: /Ops fleet/ });
		expect(within(groupOption).getByText("Node group")).toBeInTheDocument();
		await user.click(groupOption);
		await user.click(within(dialog).getByRole("button", { name: "Add access" }));

		await waitFor(() =>
			expect(calls.find((call) => call.method === "POST")?.body).toEqual({
				granteeType: "user_group",
				granteeId: GROUP.id,
				targetType: "node_group",
				targetId: NODE_GROUP.id,
			}),
		);
		expect(await within(section).findByRole("link", { name: "Ops fleet" })).toHaveAttribute(
			"href",
			"/node-groups/ng-1",
		);
	});

	test("renames the group", async () => {
		const { calls } = await renderPage();
		await screen.findByRole("heading", { name: "ops" });
		await fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		const dialog = screen.getByTestId("user-group-name-dialog");
		await fireEvent.change(within(dialog).getByLabelText("User group name"), { target: { value: "platform" } });
		await fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
		await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ name: "platform" }));
	});

	test("deletes the group after a confirmation", async () => {
		const { calls } = await renderPage();
		await screen.findByRole("heading", { name: "ops" });
		await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirm = screen.getByRole("dialog");
		await fireEvent.click(within(confirm).getByRole("button", { name: "Delete user group" }));
		await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
	});
});
