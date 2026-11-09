import type { NodeGroup, PublicNode, User } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import { renderWithRouter } from "@/test/render";
import { NodeGroupDetailPage, NodeGroupsPage } from "./pages";

/** The route params `useParams` returns; the detail page's test sets the node group id. */
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
const MEMBER: User = { ...ADMIN, id: "u2", username: "alice", kind: "member" };

function node(id: string, name: string): PublicNode {
	return {
		id,
		name,
		transport: "client",
		status: "active",
		hostname: `${name}.local`,
		clientVersion: null,
		privilegedMode: null,
		lastSeenAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: null,
		nodeGroups: [{ id: "group-1", name: "web" }],
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
	};
}

const GROUP: NodeGroup = { id: "group-1", name: "web", memberIds: ["node-2"] };

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function mockFetch(user: User): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url, method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (url === "/api/me") return json({ user });
			if (url === "/api/directory") return json({ users: [], userGroups: [] });
			if (url === "/api/nodes") return json({ nodes: [node("node-1", "worker-01"), node("node-2", "worker-02")] });
			if (url === "/api/node-groups" && method === "GET") return json({ groups: [GROUP] });
			if (url === "/api/node-groups" && method === "POST")
				return json({ group: { id: "group-2", name: (body as { name: string }).name, memberIds: [] } }, 201);
			const members = /^\/api\/node-groups\/([^/]+)\/members$/.exec(url);
			if (members && method === "PUT")
				return json({ group: { ...GROUP, memberIds: (body as { nodeIds: string[] }).nodeIds } });
			const one = /^\/api\/node-groups\/([^/]+)$/.exec(url);
			if (one && method === "PATCH") return json({ group: { ...GROUP, name: (body as { name: string }).name } });
			if (one && method === "DELETE") return json({ ok: true });
			if (url.startsWith("/api/node-access-grants")) return json({ grants: [] });
			return json({});
		}),
	);
	return { calls };
}

async function renderPage(user: User, page: React.ReactElement = <NodeGroupsPage />) {
	const { calls } = mockFetch(user);
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

describe("NodeGroupsPage", () => {
	test("an administrator creates a node group and every row links to its detail page", async () => {
		const { calls } = await renderPage(ADMIN);
		const link = await screen.findByRole("link", { name: "web" });
		expect(link).toHaveAttribute("href", "/node-groups/group-1");
		// The name is the row's link, inside its first cell.
		expect(screen.getByText("web").closest("a")).toBe(link);
		// Members keep their own links to their node pages.
		expect(screen.getByRole("link", { name: "worker-02" })).toHaveAttribute("href", "/nodes/node-2");
		// The UUID is shown with a copy button for trust aliases.
		expect(screen.getByText("group-1")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy node group id of web" })).toBeInTheDocument();
		// Rename, delete and member edits live on the detail page, not in the list.
		expect(screen.queryByRole("button", { name: "Edit members" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

		await fireEvent.click(screen.getByTestId("create-node-group"));
		const create = screen.getByTestId("node-group-name-dialog");
		const name = within(create).getByLabelText("Node group name");
		await fireEvent.change(name, { target: { value: "_system" } });
		await fireEvent.click(within(create).getByRole("button", { name: "New node group" }));
		expect(within(create).getByRole("alert")).toHaveTextContent(/must not start with "_"/);
		expect(calls.some((call) => call.url === "/api/node-groups" && call.method === "POST")).toBe(false);

		await fireEvent.change(name, { target: { value: "db" } });
		await fireEvent.click(within(create).getByRole("button", { name: "New node group" }));
		await waitFor(() =>
			expect(calls.find((call) => call.url === "/api/node-groups" && call.method === "POST")?.body).toEqual({
				name: "db",
			}),
		);
	});

	test("a non-administrator sees the list read-only", async () => {
		await renderPage(MEMBER);
		await screen.findByRole("link", { name: "web" });
		expect(screen.getByRole("link", { name: "worker-02" })).toHaveAttribute("href", "/nodes/node-2");
		expect(screen.queryByTestId("create-node-group")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Edit members" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
	});
});

describe("NodeGroupDetailPage", () => {
	test("an administrator gets member editing, rename and delete there", async () => {
		route.params = { nodeGroupId: "group-1" };
		await renderPage(ADMIN, <NodeGroupDetailPage />);
		const page = await screen.findByTestId("node-group-detail");
		// One Edit members button, in the members section header; rename and delete stay in the page header.
		expect(within(page).getAllByRole("button", { name: "Edit members" })).toHaveLength(1);
		const members = within(page).getByRole("table", { name: "Members of web" });
		const member = within(members).getByRole("link", { name: "worker-02" });
		expect(member).toHaveAttribute("href", "/nodes/node-2");
		expect(within(members).getByRole("columnheader", { name: "Hostname" })).toBeInTheDocument();
		expect(within(members).getByText("worker-02.local")).toBeInTheDocument();
		expect(within(page).getByRole("button", { name: "Rename" })).toBeInTheDocument();
		expect(within(page).getByRole("button", { name: "Delete" })).toBeInTheDocument();
	});

	test("member editing and deletion happen on the detail page", async () => {
		route.params = { nodeGroupId: "group-1" };
		const { calls } = await renderPage(ADMIN, <NodeGroupDetailPage />);
		const page = await screen.findByTestId("node-group-detail");

		await fireEvent.click(within(page).getByRole("button", { name: "Edit members" }));
		const members = screen.getByTestId("node-group-members-dialog");
		const user = userEvent.setup();
		await user.click(within(members).getByRole("button", { name: /node selected/ }));
		await user.click(await screen.findByRole("checkbox", { name: /worker-01/ }));
		await user.click(within(members).getByRole("button", { name: "Save members" }));
		await waitFor(() => {
			const put = calls.find((call) => call.url === "/api/node-groups/group-1/members" && call.method === "PUT");
			expect((put?.body as { nodeIds: string[] } | undefined)?.nodeIds?.sort()).toEqual(["node-1", "node-2"]);
		});

		await fireEvent.click(within(page).getByRole("button", { name: "Delete" }));
		await fireEvent.click(screen.getByRole("button", { name: "Delete node group" }));
		await waitFor(() =>
			expect(calls.some((call) => call.url === "/api/node-groups/group-1" && call.method === "DELETE")).toBe(true),
		);
	});
});
