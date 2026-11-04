import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NodeGroup, PublicNode, TaskGroupView } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { BatchPage } from "./pages";

const NODES: PublicNode[] = [
	{
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
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
	},
];

const GROUPS: NodeGroup[] = [{ id: "group-1", name: "web", memberIds: ["node-1"] }];

const GROUP: TaskGroupView = {
	id: "group-1",
	state: "finished",
	targets: [],
	refs: {},
	nodeIds: ["node-1"],
	parallel: 10,
	failFast: false,
	outputMode: "status",
	privileged: false,
	skipped: [],
	tasks: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	finishedAt: "2026-01-01T00:01:00.000Z",
};

function mockFetch(): { calls: { url: string; method: string; body: unknown }[] } {
	const calls: { url: string; method: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url, method, body });
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url === "/api/nodes") return json({ nodes: NODES });
			if (url === "/api/node-groups") return json({ groups: GROUPS });
			if (url === "/api/api-tokens") return json({ tokens: [] });
			if (url === "/api/task-groups" && method === "POST")
				return json({ group: { ...GROUP, targets: (body as { targets: string[] }).targets } });
			if (url === "/api/task-groups/group-1") return json({ group: GROUP });
			return json({});
		}),
	);
	return { calls };
}

async function renderPage() {
	const mocked = mockFetch();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<BatchPage />
		</QueryClientProvider>,
	);
	return mocked;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("BatchPage targets", () => {
	test("All accessible nodes sends _all", async () => {
		const { calls } = await renderPage();
		await fireEvent.click(await screen.findByRole("checkbox", { name: "All accessible nodes" }));
		await waitFor(() => expect(screen.getByTestId("batch-run")).toBeEnabled());
		await fireEvent.change(screen.getByRole("textbox", { name: "Shell command" }), {
			target: { value: "uptime" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Run on all accessible nodes" }));

		await waitFor(() => {
			const created = calls.find((call) => call.url === "/api/task-groups" && call.method === "POST");
			expect((created?.body as { targets: string[] } | undefined)?.targets).toEqual(["_all"]);
		});
	});

	test("picked nodes and node groups are sent by name", async () => {
		const { calls } = await renderPage();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Choose nodes" }));
		await user.click(await screen.findByRole("checkbox", { name: /worker-01/ }));
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("button", { name: "Choose node groups" }));
		await user.click(await screen.findByRole("checkbox", { name: /web/ }));
		await user.keyboard("{Escape}");
		await user.type(screen.getByRole("textbox", { name: "Shell command" }), "uptime");
		await waitFor(() => expect(screen.getByTestId("batch-run")).toBeEnabled());
		await user.click(screen.getByRole("button", { name: /Run on 2 targets/ }));

		await waitFor(() => {
			const created = calls.find((call) => call.url === "/api/task-groups" && call.method === "POST");
			expect((created?.body as { targets: string[] } | undefined)?.targets).toEqual(["worker-01", "web"]);
		});
	});
});
