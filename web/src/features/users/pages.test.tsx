import type { NodeAccessGrant, User, UserGroup } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/lib/session";
import { renderWithRouter } from "@/test/render";
import { UserDetailPage, UsersPage } from "./pages";

/** The route params `useParams` returns; the detail page's test sets the user id. */
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useParams: () => route.params };
});

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

interface Call {
	url: string;
	method: string;
	body: unknown;
}

/** Only the fields the node-target picker and the grant table read. */
interface TestNode {
	id: string;
	name: string;
	hostname: string;
	status: string;
	connected: boolean;
}

interface TestNodeGroup {
	id: string;
	name: string;
	memberIds: string[];
}

function mockFetch(
	me: User,
	{
		users = [ME, OTHER] as User[],
		groups = [] as UserGroup[],
		grants = [] as NodeAccessGrant[],
		nodes = [] as TestNode[],
		nodeGroups = [] as TestNodeGroup[],
		detail = undefined as { user: User; userGroups: { id: string; name: string }[] } | undefined,
		detailStatus = 200,
	} = {},
): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url: `${path}${url.search}`, method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user: me });
			if (path === "/api/users") return json({ users });
			if (/^\/api\/users\/[^/]+$/.test(path)) {
				if (detailStatus !== 200) return json({ error: "no such user" }, detailStatus);
				return json(detail ?? { user: OTHER, userGroups: [] });
			}
			if (path === "/api/user-groups" && method === "GET") return json({ groups });
			if (path === "/api/user-groups" && method === "POST") {
				const created: UserGroup = { ...OPS_GROUP, id: "group-2", name: (body as { name: string }).name };
				return json({ group: created }, 201);
			}
			if (/^\/api\/user-groups\/[^/]+\/members\/[^/]+$/.test(path)) return json({ ok: true });
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
				const targetName =
					input.targetType === "node"
						? (nodes.find((node) => node.id === input.targetId)?.name ?? null)
						: (nodeGroups.find((group) => group.id === input.targetId)?.name ?? null);
				const granteeName =
					input.granteeType === "user"
						? (users.find((user) => user.id === input.granteeId)?.username ?? null)
						: (groups.find((group) => group.id === input.granteeId)?.name ?? null);
				const created: NodeAccessGrant = {
					id: `grant-${grants.length + 1}`,
					...input,
					granteeName,
					targetName,
					createdAt: "2026-01-01T00:00:00.000Z",
					createdByUserId: ME.id,
				};
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
			if (path === "/api/sessions") return json({ items: [], nextCursor: null });
			if (path === "/api/tasks") return json({ items: [], nextCursor: null });
			if (path === "/api/nodes") {
				const ids = url.searchParams.get("ids");
				const q = (url.searchParams.get("q") ?? "").toLowerCase();
				const matched = nodes.filter((node) =>
					ids !== null
						? ids.split(",").includes(node.id)
						: node.name.toLowerCase().includes(q) || node.hostname.toLowerCase().includes(q),
				);
				return json({ nodes: matched });
			}
			if (path === "/api/node-groups") {
				const ids = url.searchParams.get("ids");
				const q = (url.searchParams.get("q") ?? "").toLowerCase();
				const matched = nodeGroups.filter((group) =>
					ids !== null ? ids.split(",").includes(group.id) : group.name.toLowerCase().includes(q),
				);
				return json({ groups: matched });
			}
			if (path === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
	return { calls };
}

async function renderPage(
	page: React.ReactElement,
	me: User = ME,
	options?: Parameters<typeof mockFetch>[1],
): Promise<{ calls: Call[] }> {
	const { calls } = mockFetch(me, options);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
	return { calls };
}

afterEach(() => {
	authStore.clear();
	route.params = {};
	vi.unstubAllGlobals();
});

describe("UsersPage", () => {
	test("rows link to the user page and carry no edit controls", async () => {
		const { calls } = await renderPage(<UsersPage />, ME, { groups: [OPS_GROUP], grants: [] });

		const link = await screen.findByRole("link", { name: "alice" });
		expect(link).toHaveAttribute("href", "/users/u2");
		// The username itself is the row's single link, inside its first cell.
		expect(screen.getByText("alice").closest("a")).toBe(link);
		const row = screen.getByText("alice").closest('[role="row"]');
		if (!(row instanceof HTMLElement)) throw new Error("no user row");
		expect(within(row).getByText("Member")).toBeInTheDocument();
		// Editing moved to the detail page, so the list has neither a kind select nor row actions.
		expect(screen.queryByLabelText("Kind of alice")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
		expect(screen.getByTestId("new-user")).toBeInTheDocument();
		// Node access is on the user page, never as a column with edit controls.
		expect(screen.queryByRole("columnheader", { name: "Node access" })).not.toBeInTheDocument();
		expect(screen.queryByText("No node access")).not.toBeInTheDocument();

		// The group section navigates to the group page; it has no inline member editor.
		const groupLink = await screen.findByRole("link", { name: "Ops" });
		expect(groupLink).toHaveAttribute("href", "/user-groups/group-1");
		expect(screen.getByText("0 members")).toBeInTheDocument();
		expect(screen.queryByLabelText("Add member")).not.toBeInTheDocument();

		await fireEvent.click(screen.getByTestId("create-user-group"));
		const dialog = screen.getByTestId("user-group-name-dialog");
		await fireEvent.change(within(dialog).getByLabelText("User group name"), { target: { value: "db" } });
		await fireEvent.click(within(dialog).getByRole("button", { name: "New user group" }));
		await waitFor(() =>
			expect(calls.find((call) => call.url === "/api/user-groups" && call.method === "POST")?.body).toEqual({
				name: "db",
			}),
		);
	});

	test("does not render a user's node access in the list", async () => {
		const { calls } = await renderPage(<UsersPage />, ME, { grants: [grant()] });
		await screen.findByText("alice");
		expect(screen.queryByRole("columnheader", { name: "Node access" })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "worker-01" })).not.toBeInTheDocument();
		expect(screen.queryByText("No node access")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.startsWith("/api/node-access-grants"))).toBe(false);
	});
});

describe("UserDetailPage", () => {
	test("an administrator edits the role, status and password on the page", async () => {
		route.params = { userId: OTHER.id };
		const { calls } = await renderPage(<UserDetailPage />, ME, {
			detail: { user: OTHER, userGroups: [{ id: "group-1", name: "Ops" }] },
			groups: [OPS_GROUP],
		});

		expect(await screen.findByRole("heading", { name: "Alice" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "All users" })).toHaveAttribute("href", "/users");
		expect(screen.getByText("alice")).toBeInTheDocument();
		expect(screen.getByText("Member")).toBeInTheDocument();
		expect(screen.getByText("Active")).toBeInTheDocument();
		// The memberships are a table; the name is the row link and the count comes from the group list.
		const groupsTable = screen.getByRole("table", { name: "User groups of alice" });
		expect(within(groupsTable).getByRole("link", { name: "Ops" })).toHaveAttribute("href", "/user-groups/group-1");
		expect(within(groupsTable).getByText("0 members")).toBeInTheDocument();

		// This row is not the administrator's own, so the kind is editable.
		const kind = screen.getByLabelText("Kind of alice");
		expect(kind).toBeEnabled();
		await userEvent.click(kind);
		await userEvent.click(screen.getByRole("option", { name: "Administrator" }));
		await waitFor(() =>
			expect(calls.find((call) => call.url === "/api/users/u2" && call.method === "PATCH")?.body).toEqual({
				kind: "admin",
			}),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		const confirm = screen.getByRole("dialog");
		expect(within(confirm).getByText("Disable alice?")).toBeInTheDocument();
		await fireEvent.click(within(confirm).getByRole("button", { name: "Disable user" }));
		await waitFor(() =>
			expect(calls.filter((call) => call.url === "/api/users/u2" && call.method === "PATCH").at(-1)?.body).toEqual({
				status: "disabled",
			}),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
		expect(screen.getByRole("dialog", { name: /Reset the password of alice/ })).toBeInTheDocument();
	});

	test("an administrator adds the user to a group and removes a membership", async () => {
		route.params = { userId: OTHER.id };
		const DEV_GROUP: UserGroup = {
			...OPS_GROUP,
			id: "group-2",
			name: "Dev",
			memberIds: [OTHER.id],
		};
		const { calls } = await renderPage(<UserDetailPage />, ME, {
			detail: { user: OTHER, userGroups: [{ id: "group-2", name: "Dev" }] },
			groups: [OPS_GROUP, DEV_GROUP],
		});
		await screen.findByRole("heading", { name: "Alice" });

		const section = screen.getByTestId("user-detail-groups");
		const user = userEvent.setup();
		await user.click(within(section).getByTestId("add-to-group"));
		const dialog = await screen.findByTestId("add-to-group-dialog");
		await user.click(within(dialog).getByRole("combobox", { name: "User group" }));
		// The group the user is already in is not offered.
		expect(await screen.findByRole("option", { name: /Ops/ })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /Dev/ })).not.toBeInTheDocument();
		await user.click(screen.getByRole("option", { name: /Ops/ }));
		await user.click(within(dialog).getByRole("button", { name: "Add" }));
		await waitFor(() =>
			expect(calls.find((call) => call.method === "PUT")?.url).toBe("/api/user-groups/group-1/members/u2"),
		);

		// Each membership row has a confirmed remove action.
		const table = screen.getByRole("table", { name: "User groups of alice" });
		await user.click(within(table).getByRole("button", { name: "Remove from Dev" }));
		const confirm = await screen.findByRole("dialog", { name: "Remove alice from Dev?" });
		await user.click(within(confirm).getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/user-groups/group-2/members/u2")).toBe(
				true,
			),
		);
	});

	test("an administrator grants this user access to a node and a node group", async () => {
		route.params = { userId: OTHER.id };
		const node: TestNode = {
			id: "node-1",
			name: "worker-01",
			hostname: "worker-01.example",
			status: "active",
			connected: true,
		};
		const nodeGroup: TestNodeGroup = { id: "ng-1", name: "Ops fleet", memberIds: [node.id] };
		const { calls } = await renderPage(<UserDetailPage />, ME, {
			detail: { user: OTHER, userGroups: [] },
			nodes: [node],
			nodeGroups: [nodeGroup],
		});

		const section = await screen.findByTestId("grantee-node-access");
		const user = userEvent.setup();
		await user.click(within(section).getByTestId("add-access"));
		let dialog = await screen.findByTestId("grantee-add-access-dialog");
		await user.click(within(dialog).getByRole("combobox", { name: "Node or node group" }));
		const nodeOption = await screen.findByRole("option", { name: /worker-01/ });
		expect(within(nodeOption).getByText("worker-01.example")).toBeInTheDocument();
		expect(within(nodeOption).getByText("Node")).toBeInTheDocument();
		await user.click(nodeOption);
		await user.click(within(dialog).getByRole("button", { name: "Add access" }));
		await waitFor(() =>
			expect(calls.find((call) => call.method === "POST")?.body).toEqual({
				granteeType: "user",
				granteeId: OTHER.id,
				targetType: "node",
				targetId: node.id,
			}),
		);
		expect(await within(section).findByRole("link", { name: "worker-01" })).toBeInTheDocument();

		// The same picker also grants a node group.
		await user.click(within(section).getByTestId("add-access"));
		dialog = await screen.findByTestId("grantee-add-access-dialog");
		await user.click(within(dialog).getByRole("combobox", { name: "Node or node group" }));
		const groupOption = await screen.findByRole("option", { name: /Ops fleet/ });
		expect(within(groupOption).getByText("1 member")).toBeInTheDocument();
		expect(within(groupOption).getByText("Node group")).toBeInTheDocument();
		await user.click(groupOption);
		await user.click(within(dialog).getByRole("button", { name: "Add access" }));
		await waitFor(() =>
			expect(calls.filter((call) => call.method === "POST").at(-1)?.body).toEqual({
				granteeType: "user",
				granteeId: OTHER.id,
				targetType: "node_group",
				targetId: nodeGroup.id,
			}),
		);
	});

	test("an administrator sees only this user's node access and removes a grant", async () => {
		route.params = { userId: OTHER.id };
		const { calls } = await renderPage(<UserDetailPage />, ME, {
			detail: { user: OTHER, userGroups: [] },
			grants: [
				grant(),
				grant({ id: "grant-2", granteeId: "u3", granteeName: "bob", targetId: "node-2", targetName: "worker-02" }),
			],
		});

		const section = await screen.findByTestId("grantee-node-access");
		expect(within(section).getByRole("heading", { name: "Node access" })).toBeInTheDocument();
		const row = (await within(section).findByRole("link", { name: "worker-01" })).closest('[role="row"]');
		if (!(row instanceof HTMLElement)) throw new Error("no node grant row");
		// The target is a node, and the badge says so beside its link.
		expect(within(row).getByText("Node")).toBeInTheDocument();
		// The section shows the grants of this user only, not another grantee's.
		expect(within(section).queryByText("worker-02")).not.toBeInTheDocument();

		const remove = within(section).getByRole("button", { name: "Remove access to worker-01 for alice" });
		expect(remove).toHaveTextContent("Remove");
		await fireEvent.click(remove);
		const confirm = screen.getByRole("dialog");
		expect(within(confirm).getByText("Remove access for alice?")).toBeInTheDocument();
		await fireEvent.click(within(confirm).getByRole("button", { name: "Remove access" }));
		await waitFor(() =>
			expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/node-access-grants/grant-1")).toBe(
				true,
			),
		);
		expect(await screen.findByText("No node access")).toBeInTheDocument();
	});

	test("your own page is read-only for a non-administrator", async () => {
		route.params = { userId: OTHER.id };
		const { calls } = await renderPage(<UserDetailPage />, OTHER, { detail: { user: OTHER, userGroups: [] } });

		expect(await screen.findByRole("heading", { name: "Alice" })).toBeInTheDocument();
		expect(screen.getByText("Member")).toBeInTheDocument();
		expect(screen.queryByLabelText("Kind of alice")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
		// An empty membership section is the table's own small empty line, not a separate block.
		expect(within(screen.getByTestId("user-detail-groups")).getByText("No user groups")).toBeInTheDocument();
		// The grant list is administrator-only, so a member sees no node access section.
		expect(screen.queryByRole("heading", { name: "Node access" })).not.toBeInTheDocument();
		expect(screen.queryByTestId("grantee-node-access")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.startsWith("/api/node-access-grants"))).toBe(false);
		// Only the recent-activity sections remain, with the compact in-table empty line.
		const sessions = screen.getByTestId("user-sessions");
		expect(await within(sessions).findByText("No sessions yet")).toHaveAttribute("data-slot", "table-empty");
		const tasks = screen.getByTestId("user-tasks");
		expect(await within(tasks).findByText("No tasks yet")).toHaveAttribute("data-slot", "table-empty");
		// The recent tasks link to the tasks page filtered to this user.
		expect(within(tasks).getByRole("link", { name: "View all tasks" })).toHaveAttribute("href", "/tasks?user=u2");
		// Both recent lists ask for only their first ten rows.
		expect(calls.some((call) => call.url === "/api/sessions?scope=visible&ownerId=u2&limit=10")).toBe(true);
		expect(calls.some((call) => call.url === "/api/tasks?userId=u2&limit=10")).toBe(true);
	});

	test("a missing user and a user you may not read show one no-access message", async () => {
		route.params = { userId: "u3" };
		await renderPage(<UserDetailPage />, { ...ME, kind: "member" }, { detailStatus: 404 });
		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toHaveTextContent("This user doesn't exist or you don't have access.");
	});
});
