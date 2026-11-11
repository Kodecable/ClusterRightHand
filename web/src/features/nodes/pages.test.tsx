import type { PublicNode, User } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import { formatDateTimeSeconds } from "@/lib/format";
import { renderWithRouter } from "@/test/render";
import { NodeDetailPage, NodesPage } from "./pages";

/** The route params `useParams` returns; NodeDetailPage's test sets the node id. */
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
const MEMBER: User = { ...ADMIN, id: "u2", username: "alice", displayName: "Alice", kind: "member" };

function node(overrides: Partial<PublicNode> = {}): PublicNode {
	return {
		id: "node-1",
		name: "worker-01",
		transport: "client",
		status: "active",
		hostname: "worker-01.local",
		clientVersion: null,
		privilegedMode: null,
		lastSeenAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: null,
		nodeGroups: [],
		access: "granted",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
		...overrides,
	};
}

function mockFetch(
	user: User,
	nodes: PublicNode[],
	options: { deleteError?: string } = {},
): { calls: { url: string; method: string }[] } {
	const calls: { url: string; method: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			calls.push({ url: path, method });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user });
			if (path === "/api/nodes") return json({ nodes });
			const detail = /^\/api\/nodes\/([^/]+)$/.exec(path);
			if (detail && method === "DELETE") {
				return options.deleteError === undefined ? json({ ok: true }) : json({ error: options.deleteError }, 400);
			}
			if (detail) {
				return json({ node: nodes.find((candidate) => candidate.id === decodeURIComponent(detail[1] ?? "")) });
			}
			if (path.endsWith("/trust")) {
				return json({
					trust: { status: null, message: null, digest: null, updatedAt: null, stale: false, summary: null },
				});
			}
			if (path.endsWith("/tasks")) return json({ tasks: [] });
			if (path === "/api/node-groups") return json({ groups: [] });
			if (path === "/api/me/credentials") return json({ credentials: [] });
			if (path === "/api/privilege/crhs-key") {
				// The server answers with the newest key (`key`) and every key, newest first.
				return json({
					key: { authorizedKey: "ssh-ed25519 AAAANEWEST crhs-signing", fingerprint: "SHA256:newest" },
					keys: [
						{ authorizedKey: "ssh-ed25519 AAAANEWEST crhs-signing", fingerprint: "SHA256:newest" },
						{ authorizedKey: "ssh-ed25519 AAAAOLDER crhs-signing", fingerprint: "SHA256:older" },
					],
				});
			}
			if (path === "/api/directory") return json({ users: [], userGroups: [] });
			if (path.startsWith("/api/node-access-grants")) return json({ grants: [] });
			return json({});
		}),
	);
	return { calls };
}

async function renderPage(user: User, nodes: PublicNode[]): Promise<void> {
	mockFetch(user, nodes);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<NodesPage />
		</QueryClientProvider>,
	);
}

async function renderDetail(user: User, nodes: PublicNode[], options: { deleteError?: string } = {}) {
	const { calls } = mockFetch(user, nodes, options);
	route.params = { nodeId: nodes[0]?.id ?? "node-1" };
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rendered = await renderWithRouter(
		<QueryClientProvider client={client}>
			<NodeDetailPage />
		</QueryClientProvider>,
	);
	return { calls, router: rendered.router };
}

afterEach(() => {
	authStore.clear();
	route.params = {};
	vi.unstubAllGlobals();
});

describe("NodesPage administrator actions", () => {
	test("an administrator sees enrollment, the SSH wizard and pending-node decisions", async () => {
		await renderPage(ADMIN, [node({ status: "pending" })]);
		expect(await screen.findByRole("link", { name: "worker-01" })).toBeInTheDocument();
		expect(screen.getByTestId("add-node")).toBeInTheDocument();
		expect(screen.getByTestId("add-ssh-node")).toBeInTheDocument();
		expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
	});

	test("the node list fits the standard list width without horizontal scrolling", async () => {
		await renderPage(ADMIN, [node()]);
		await screen.findByRole("link", { name: "worker-01" });
		const table = screen.getByTestId("nodes-page").querySelector<HTMLElement>('[data-slot="data-table"]');
		if (table === null) throw new Error("no nodes table");
		// The table's computed minimum (fixed + minimum + flexible floors) stays
		// inside the ~990px a desktop leaves for the table, so it does not scroll.
		const minWidth = Number.parseInt(table.style.getPropertyValue("--dt-min-width"), 10);
		expect(minWidth).toBeGreaterThan(0);
		expect(minWidth).toBeLessThanOrEqual(960);
	});

	test("a member does not see administrator actions", async () => {
		await renderPage(MEMBER, [node({ status: "pending" })]);
		expect(await screen.findByRole("link", { name: "worker-01" })).toBeInTheDocument();
		expect(screen.queryByTestId("add-node")).not.toBeInTheDocument();
		expect(screen.queryByTestId("add-ssh-node")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
	});

	test("the node name is the row's link to the node page", async () => {
		await renderPage(ADMIN, [node()]);
		const link = await screen.findByRole("link", { name: "worker-01" });
		expect(link).toHaveAttribute("href", "/nodes/node-1");
		// The name itself is the row's single link, inside its first cell.
		expect(screen.getByText("worker-01").closest("a")).toBe(link);
		expect(link.closest('[role="cell"]')).toBe(screen.getByText("worker-01").closest('[role="cell"]'));
		// There is no page-level refresh button: the list polls.
		expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
	});

	test("a connected node's Last seen is Now, with the connection time on hover", async () => {
		const lastSeenAt = "2026-01-01T00:00:05.000Z";
		await renderPage(ADMIN, [node({ lastSeenAt, connected: true })]);
		const now = await screen.findByText("Now");
		expect(now).toHaveAttribute("title", `Connected since ${formatDateTimeSeconds(lastSeenAt, "en")}`);
	});

	test("a disconnected node's Last seen is the relative time", async () => {
		await renderPage(ADMIN, [node({ lastSeenAt: "2026-01-01T00:00:05.000Z", connected: false })]);
		await screen.findByRole("link", { name: "worker-01" });
		expect(screen.queryByText("Now")).not.toBeInTheDocument();
	});

	test("a member without grants gets the explanation, not the admin instructions", async () => {
		await renderPage(MEMBER, []);
		expect(await screen.findByText("An administrator grants access to nodes.")).toBeInTheDocument();
		expect(screen.queryByText(/Use "New node"/)).not.toBeInTheDocument();
	});

	test("a node with trust warnings is marked with the most severe tone", async () => {
		await renderPage(MEMBER, [
			node({
				trustWarnings: [
					{
						kind: "alias_missing",
						severity: "info",
						uuid: "group-1",
						nodeGroupName: "web",
						trustName: null,
						message: "missing alias",
					},
					{
						kind: "alias_superfluous",
						severity: "danger",
						uuid: "group-2",
						nodeGroupName: "db",
						trustName: null,
						message: "superfluous alias",
					},
				],
			}),
		]);
		const indicator = await screen.findByTitle("Trust warnings");
		expect(indicator).toHaveAttribute("data-tone", "danger");
		expect(indicator).toHaveTextContent("Trust");
	});
});

describe("NodeDetailPage", () => {
	test("an administrator sees the aliases line for a forward node with node groups", async () => {
		route.params = { nodeId: "node-1" };
		mockFetch(ADMIN, [
			node({
				privilegedMode: "forward",
				nodeGroups: [
					{ id: "group-1", name: "web" },
					{ id: "group-2", name: "db" },
				],
			}),
		]);
		await authStore.load();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		await renderWithRouter(
			<QueryClientProvider client={client}>
				<NodeDetailPage />
			</QueryClientProvider>,
		);

		expect(await screen.findByText('aliases = ["group-1", "group-2"]')).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Aliases for privileged.toml" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy aliases" })).toBeInTheDocument();
	});

	test("shows the newest crhs signing key, not an older one", async () => {
		route.params = { nodeId: "node-1" };
		mockFetch(ADMIN, [node()]);
		await authStore.load();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		await renderWithRouter(
			<QueryClientProvider client={client}>
				<NodeDetailPage />
			</QueryClientProvider>,
		);

		expect(await screen.findByText("ssh-ed25519 AAAANEWEST crhs-signing")).toBeInTheDocument();
		expect(screen.getByText("SHA256:newest")).toBeInTheDocument();
		expect(screen.queryByText("ssh-ed25519 AAAAOLDER crhs-signing")).not.toBeInTheDocument();
	});

	test("a connected node's Last seen is Now, with the connection time on hover", async () => {
		const lastSeenAt = "2026-01-01T00:00:05.000Z";
		route.params = { nodeId: "node-1" };
		mockFetch(MEMBER, [node({ lastSeenAt, connected: true, access: "granted" })]);
		await authStore.load();
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		await renderWithRouter(
			<QueryClientProvider client={client}>
				<NodeDetailPage />
			</QueryClientProvider>,
		);

		const now = await screen.findByText("Now");
		expect(now).toHaveAttribute("title", `Connected since ${formatDateTimeSeconds(lastSeenAt, "en")}`);
	});
});

describe("NodeDetailPage deletion", () => {
	test("an administrator sees Delete node", async () => {
		await renderDetail(ADMIN, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.getByRole("button", { name: "Delete node" })).toBeInTheDocument();
	});

	test("a member does not see Delete node", async () => {
		await renderDetail(MEMBER, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.queryByRole("button", { name: "Delete node" })).not.toBeInTheDocument();
	});

	test("confirming deletes the node and returns to the node list", async () => {
		const { calls, router } = await renderDetail(ADMIN, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Delete node worker-01?")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete node" }));
		await waitFor(() =>
			expect(calls.some((call) => call.url === "/api/nodes/node-1" && call.method === "DELETE")).toBe(true),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/nodes"));
	});

	test("cancelling closes the dialog without a request", async () => {
		const { calls, router } = await renderDetail(ADMIN, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
		const dialog = screen.getByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
		expect(router.state.location.pathname).toBe("/");
	});

	test("a failed delete stays in the dialog and shows the error", async () => {
		const { router } = await renderDetail(ADMIN, [node()], { deleteError: "node is still connected" });
		await screen.findByRole("heading", { name: "worker-01" });
		fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
		const dialog = screen.getByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete node" }));
		expect(await within(dialog).findByText("node is still connected")).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/");
	});

	test("an SSH node explains that no crha runs on the host", async () => {
		await renderDetail(ADMIN, [node({ transport: "ssh", hostname: null, connected: false })]);
		await screen.findByRole("heading", { name: "worker-01" });
		fireEvent.click(screen.getByRole("button", { name: "Delete node" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(/No crha runs on the host/)).toBeInTheDocument();
		expect(within(dialog).getByText(/credential stays in SSH credentials/)).toBeInTheDocument();
		expect(within(dialog).queryByText(/identity\.key/)).not.toBeInTheDocument();
	});
});

describe("NodeDetailPage re-enrollment", () => {
	test("an administrator sees Re-enroll for a crha node", async () => {
		await renderDetail(ADMIN, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.getByRole("button", { name: "Re-enroll" })).toBeInTheDocument();
	});

	test("a member does not see Re-enroll", async () => {
		await renderDetail(MEMBER, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.queryByRole("button", { name: "Re-enroll" })).not.toBeInTheDocument();
	});

	test("an SSH node has no Re-enroll action", async () => {
		await renderDetail(ADMIN, [node({ transport: "ssh", hostname: null, connected: false })]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.queryByRole("button", { name: "Re-enroll" })).not.toBeInTheDocument();
	});
});
