import type { PublicNode, User } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
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

function mockFetch(user: User, nodes: PublicNode[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user });
			if (path === "/api/nodes") return json({ nodes });
			const detail = /^\/api\/nodes\/([^/]+)$/.exec(path);
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
				return json({ key: { authorizedKey: "ssh-ed25519 AAAA test", fingerprint: "SHA256:test" } });
			}
			if (path === "/api/directory") return json({ users: [], userGroups: [] });
			if (path.startsWith("/api/node-access-grants")) return json({ grants: [] });
			return json({});
		}),
	);
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
