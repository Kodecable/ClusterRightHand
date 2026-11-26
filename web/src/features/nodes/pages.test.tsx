import {
	type MetricBucketPoint,
	type MetricSeriesReading,
	metricUnit,
	type NodeMetricsResponse,
	type PublicNode,
	type User,
} from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { formatDateTimeSeconds } from "@/lib/format";
import { authStore } from "@/lib/session";
import { renderWithRouter } from "@/test/render";
import { NodeDetailPage, NodesPage } from "./pages";

// The Overview's chart cards and the Metrics tab mount ECharts, which jsdom cannot render; the cards
// and their test ids are what the page tests check.
vi.mock("echarts/core", () => {
	class FakeChart {
		setOption() {}
		resize() {}
		dispose() {}
	}
	return { init: vi.fn(() => new FakeChart()), use: vi.fn() };
});
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({
	DataZoomComponent: {},
	GridComponent: {},
	LegendComponent: {},
	TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

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
		updateAvailable: false,
		metricsWarning: null,
		userRemark: null,
		emoji: null,
		traffic: null,
		...overrides,
	};
}

const MINUTE = 60_000;
const GIB = 1024 ** 3;

/** One bucket in the current minute, so the Overview's 1-hour window contains it. */
function metricPoint(t: number, avg: number): MetricBucketPoint {
	return { t, count: 1, avg, sum: avg, min: avg, max: avg, last: avg };
}

function metricReading(name: string, avg: number): MetricSeriesReading {
	return {
		name,
		kind: "gauge",
		unit: metricUnit(name),
		lastSeenAt: new Date().toISOString(),
		summary: { min: avg, avg, max: avg, last: avg },
		buckets: [metricPoint(Math.floor(Date.now() / MINUTE) * MINUTE, avg)],
	};
}

const OVERVIEW_SERIES: MetricSeriesReading[] = [
	metricReading("uptime", 7200),
	metricReading("cpu.total", 0.25),
	metricReading("mem.total_bytes", 8 * GIB),
	metricReading("mem.available_bytes", 2 * GIB),
	metricReading("disk.root.total_bytes", 100 * GIB),
	metricReading("disk.root.used_bytes", 25 * GIB),
	metricReading("net.rx_bytes_per_sec", 16.2 * 1024),
	metricReading("net.tx_bytes_per_sec", 27.8 * 1024),
];

/** Host metrics with a sample for every Overview summary card and both chart cards. */
function nodeMetricsResponse(series: MetricSeriesReading[] = OVERVIEW_SERIES): NodeMetricsResponse {
	return { level: 1, bucketMs: MINUTE, series, traffic: null };
}

function mockFetch(
	user: User,
	nodes: PublicNode[],
	options: {
		deleteError?: string;
		remarkError?: string;
		/** The stored metrics the details page reads; an empty response by default. */
		metrics?: NodeMetricsResponse;
	} = {},
): { calls: { url: string; method: string; body?: unknown }[] } {
	const calls: { url: string; method: string; body?: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
			calls.push({ url: path, method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user });
			if (path === "/api/nodes") return json({ nodes });
			const remark = /^\/api\/nodes\/([^/]+)\/user-remark$/.exec(path);
			if (remark && method === "PUT") {
				const id = decodeURIComponent(remark[1] ?? "");
				const target = nodes.find((candidate) => candidate.id === id);
				if (!target) return json({ error: "no such node" }, 404);
				if (options.remarkError !== undefined) return json({ error: options.remarkError }, 400);
				target.userRemark = (body as { userRemark: string | null }).userRemark;
				return json({ node: target });
			}
			const emoji = /^\/api\/nodes\/([^/]+)\/emoji$/.exec(path);
			if (emoji && method === "PUT") {
				const id = decodeURIComponent(emoji[1] ?? "");
				const target = nodes.find((candidate) => candidate.id === id);
				if (!target) return json({ error: "no such node" }, 404);
				target.emoji = (body as { emoji: string | null }).emoji;
				return json({ node: target });
			}
			// The picker asks crhs for its own copy of the emoji data; a minimal valid data set is enough.
			if (path === "/emojibase/en/data.json") {
				return json([
					{
						label: "grinning face",
						hexcode: "1F600",
						emoji: "😀",
						text: "",
						type: 1,
						order: 1,
						group: 0,
						subgroup: 0,
						version: 1,
						tags: ["grin", "happy"],
					},
				]);
			}
			if (path === "/emojibase/en/messages.json") {
				return json({
					groups: [{ key: "smileys-emotion", message: "smileys & emotion", order: 0 }],
					subgroups: [{ key: "face-smiling", message: "smiling", order: 0 }],
					skinTones: [{ key: "light", message: "light skin tone" }],
				});
			}
			const detail = /^\/api\/nodes\/([^/]+)$/.exec(path);
			if (detail && method === "DELETE") {
				return options.deleteError === undefined ? json({ ok: true }) : json({ error: options.deleteError }, 400);
			}
			if (detail) {
				return json({ node: nodes.find((candidate) => candidate.id === decodeURIComponent(detail[1] ?? "")) });
			}
			if (path.endsWith("/metrics")) {
				return json(options.metrics ?? { level: 1, bucketMs: MINUTE, series: [], traffic: null });
			}
			if (path.endsWith("/trust")) {
				return json({
					trust: { status: null, message: null, digest: null, updatedAt: null, stale: false, summary: null },
				});
			}
			if (path.endsWith("/tasks")) return json({ tasks: [] });
			if (path === "/api/node-groups") return json({ groups: [] });
			if (path === "/api/me/signing-credentials") return json({ signingCredentials: [] });
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

async function renderPage(user: User, nodes: PublicNode[], options: { remarkError?: string } = {}) {
	const { calls } = mockFetch(user, nodes, options);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rendered = await renderWithRouter(
		<QueryClientProvider client={client}>
			<NodesPage />
		</QueryClientProvider>,
	);
	return { calls, ...rendered };
}

/** The table's own tests: cards are the default, so choose the table view first. */
async function renderTablePage(user: User, nodes: PublicNode[]) {
	const rendered = await renderPage(user, nodes);
	fireEvent.click(screen.getByTestId("nodes-view-table"));
	return rendered;
}

async function renderDetail(
	user: User,
	nodes: PublicNode[],
	options: { deleteError?: string; remarkError?: string; metrics?: NodeMetricsResponse; staleTime?: number } = {},
) {
	const { calls } = mockFetch(user, nodes, options);
	route.params = { nodeId: nodes[0]?.id ?? "node-1" };
	await authStore.load();
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }) },
		},
	});
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
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("NodeDetailPage metrics", () => {
	// The tab is a lazy chunk that pulls in ECharts: the first open waits for its module to load, which
	// can exceed the default limit while several test files run in parallel.
	test("opens the Metrics tab and reads the selected range", async () => {
		const { calls } = await renderDetail(ADMIN, [node()]);
		await screen.findByRole("tab", { name: "Metrics" });
		fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
		expect(await screen.findByText("No metrics yet", undefined, { timeout: 15_000 })).toBeInTheDocument();
		const request = calls.find((call) => call.url.endsWith("/metrics"));
		expect(request).toBeDefined();
	}, 20_000);

	test("the node table shows the latest CPU and memory figures", async () => {
		await renderTablePage(ADMIN, [
			node({ metrics: { at: new Date().toISOString(), up: 1, cpu: 0.42, memUsed: 0.17, stale: false } }),
		]);
		expect(await screen.findByTestId("node-metrics-figures")).toHaveTextContent("CPU42%");
		expect(screen.getByTestId("node-metrics-figures")).toHaveTextContent("Mem17%");
	});

	test("the node table has no metrics figures without a sample", async () => {
		await renderTablePage(ADMIN, [node()]);
		await screen.findByRole("link", { name: "worker-01" });
		expect(screen.queryByTestId("node-metrics-figures")).not.toBeInTheDocument();
	});
});

const CARD_METRICS: NonNullable<PublicNode["metrics"]> = {
	at: "2026-11-25T00:00:00.000Z",
	up: 1,
	cpu: 0.42,
	memUsed: 0.5,
	memUsedBytes: 4 * 1024 ** 3,
	memTotalBytes: 8 * 1024 ** 3,
	uptimeSec: 7200,
	disk: {
		name: "root",
		usedRatio: 0.2,
		usedBytes: 20 * 1024 ** 3,
		totalBytes: 100 * 1024 ** 3,
	},
	rxBytesPerSec: 2048,
	txBytesPerSec: 1024,
	stale: false,
};

const CARD_TRAFFIC: NonNullable<PublicNode["traffic"]> = {
	periodStart: "2026-11-01T00:00:00.000Z",
	nextResetAt: "2026-12-01T00:00:00.000Z",
	rxBytes: 2 * 1024 ** 3,
	txBytes: 1024 ** 3,
};

describe("NodesPage card view", () => {
	test("cards are the default view", async () => {
		await renderPage(ADMIN, [node()]);
		expect(await screen.findByTestId("nodes-cards")).toBeInTheDocument();
		expect(screen.getByTestId("nodes-view-cards")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("nodes-page").querySelector('[data-slot="data-table"]')).toBeNull();
	});

	test("a card shows the status, groups, every figure and the traffic totals", async () => {
		await renderPage(ADMIN, [
			node({
				nodeGroups: [{ id: "group-1", name: "web", emoji: null }],
				metrics: CARD_METRICS,
				traffic: CARD_TRAFFIC,
			}),
		]);
		const card = await screen.findByTestId("node-card");
		expect(within(card).getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		expect(within(card).getByRole("link", { name: "web" })).toHaveAttribute("href", "/node-groups/group-1");
		expect(card).toHaveTextContent("Connected");

		const figures = within(card).getByTestId("node-card-figures");
		expect(figures).toHaveTextContent("CPU usage42%");
		expect(figures).toHaveTextContent("Memory usage50%");
		expect(figures).toHaveTextContent("Disk usage20%");
		// The used and total bytes are tooltip text only; the card shows the bar and percentage.
		expect(figures).not.toHaveTextContent("4 GiB / 8 GiB");
		expect(figures).not.toHaveTextContent("20 GiB / 100 GiB");
		expect(within(figures).queryByText("4 GiB / 8 GiB")).not.toBeInTheDocument();
		expect(within(figures).getByText("CPU usage").closest("[title]")).toBeNull();
		expect(within(figures).getByText("Memory usage").closest("[title]")).toHaveAttribute("title", "4 GiB / 8 GiB");
		expect(within(figures).getByText("Disk usage").closest("[title]")).toHaveAttribute(
			"title",
			"root: 20 GiB / 100 GiB",
		);

		const total = within(card).getByTestId("total-traffic");
		expect(total).toHaveTextContent("2 GiB / 1 GiB");
		expect(total.getAttribute("title")).toMatch(/^Since .+ · Next reset .+$/);

		// Live traffic moved to the Metrics tab; the card keeps the traffic totals and uptime.
		expect(card).not.toHaveTextContent("Live traffic");
		expect(within(card).queryByTestId("live-traffic")).not.toBeInTheDocument();
		expect(card).toHaveTextContent("Total traffic");
		expect(card).toHaveTextContent("Uptime2h 00m");
	});

	test("missing figures show – and an SSH node keeps its badge", async () => {
		await renderPage(ADMIN, [node({ transport: "ssh", connected: null })]);
		const card = await screen.findByTestId("node-card");
		expect(within(card).getByText("SSH")).toBeInTheDocument();
		expect(within(card).getByTestId("node-card-figures")).toHaveTextContent("CPU usage–Memory usage–Disk usage–");
		expect(within(card).getAllByText("–").length).toBeGreaterThanOrEqual(4);
		expect(card).toHaveTextContent("Last seen");
	});

	test("the toggle persists the table view across a remount", async () => {
		await renderPage(ADMIN, [node()]);
		await screen.findByTestId("node-card");
		fireEvent.click(screen.getByTestId("nodes-view-table"));
		await waitFor(() =>
			expect(screen.getByTestId("nodes-page").querySelector('[data-slot="data-table"]')).not.toBeNull(),
		);
		expect(localStorage.getItem("crh.nodes.view")).toBe("table");

		cleanup();
		await renderPage(ADMIN, [node()]);
		await waitFor(() =>
			expect(screen.getByTestId("nodes-page").querySelector('[data-slot="data-table"]')).not.toBeNull(),
		);
		expect(screen.getByTestId("nodes-view-table")).toHaveAttribute("aria-pressed", "true");
	});

	test("the view still switches when localStorage throws", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("storage blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("storage blocked");
		});
		await renderPage(ADMIN, [node()]);
		await screen.findByTestId("node-card");
		fireEvent.click(screen.getByTestId("nodes-view-table"));
		await waitFor(() =>
			expect(screen.getByTestId("nodes-page").querySelector('[data-slot="data-table"]')).not.toBeNull(),
		);
		fireEvent.click(screen.getByTestId("nodes-view-cards"));
		expect(await screen.findByTestId("node-card")).toBeInTheDocument();
	});

	test("the card header wraps the actions only when an administrator decides a pending node", async () => {
		await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		// An active node has nothing to decide, so the header holds only its left column: an always
		// rendered wrapper would add the header's 8px gap and push the status off the card's edge.
		expect(within(card).queryByTestId("node-card-actions")).not.toBeInTheDocument();
		expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

		cleanup();
		await renderPage(MEMBER, [node({ status: "pending" })]);
		const memberCard = await screen.findByTestId("node-card");
		// A member cannot decide, so a pending node gets no wrapper either.
		expect(within(memberCard).queryByTestId("node-card-actions")).not.toBeInTheDocument();

		cleanup();
		await renderPage(ADMIN, [node({ status: "pending" })]);
		const pendingCard = await screen.findByTestId("node-card");
		const actions = within(pendingCard).getByTestId("node-card-actions");
		expect(within(actions).getByRole("button", { name: "Approve" })).toBeInTheDocument();
		expect(within(actions).getByRole("button", { name: "Reject" })).toBeInTheDocument();
	});

	test("an action click opens its dialog without opening the node page", async () => {
		const { router } = await renderPage(ADMIN, [node({ status: "pending" })]);
		const card = await screen.findByTestId("node-card");
		fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
		expect(await screen.findByRole("dialog", { name: "Approve node" })).toBeInTheDocument();
		expect(router.state.location.pathname).toBe("/");
	});

	test("clicking the card opens the node page", async () => {
		const { router } = await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		fireEvent.click(card);
		await waitFor(() => expect(router.state.location.pathname).toBe("/nodes/node-1"));
	});

	test("a click on a link inside the card follows the link, not the card", async () => {
		const { router } = await renderPage(ADMIN, [node({ nodeGroups: [{ id: "group-1", name: "web", emoji: null }] })]);
		const card = await screen.findByTestId("node-card");
		const groupLink = within(card).getByRole("link", { name: "web" });
		const navigate = vi.spyOn(router, "navigate");
		// A middle click opens the link in a new tab and is left to the browser: the link does not
		// cancel it, so only the card's interactive-element check keeps the card from opening the
		// node page as well.
		fireEvent.click(groupLink, { button: 1 });
		expect(navigate).not.toHaveBeenCalled();
		expect(router.state.location.pathname).toBe("/");
		// A primary click follows the link to the node group, and only there.
		fireEvent.click(groupLink);
		await waitFor(() => expect(router.state.location.pathname).toBe("/node-groups/group-1"));
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(navigate.mock.calls[0]?.[0]).toMatchObject({
			to: "/node-groups/$nodeGroupId",
			params: { nodeGroupId: "group-1" },
		});
	});

	test("an offline node's sample uptime does not replace Last seen", async () => {
		await renderPage(ADMIN, [node({ connected: false, metrics: CARD_METRICS })]);
		const card = await screen.findByTestId("node-card");
		expect(card).toHaveTextContent("Last seen");
		expect(card).not.toHaveTextContent("Uptime");
		expect(card).not.toHaveTextContent("2h 00m");
	});

	test("Enter on the focused card opens the node page", async () => {
		const { router } = await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		fireEvent.keyDown(card, { key: "Enter" });
		await waitFor(() => expect(router.state.location.pathname).toBe("/nodes/node-1"));
	});

	test("a stale sample dims the card's figures", async () => {
		await renderPage(ADMIN, [node({ metrics: { ...CARD_METRICS, stale: true } })]);
		const card = await screen.findByTestId("node-card");
		expect(card).toHaveAttribute("data-stale", "true");
		expect(within(card).getByTestId("node-card-figures")).toHaveClass("opacity-50");
	});
});

describe("NodesPage card layout", () => {
	test("the name row puts the warnings before the status and right-aligns the group", async () => {
		await renderPage(ADMIN, [
			node({
				clockWarning: { offsetMs: 120_000, thresholdMs: 60_000 },
				trustWarnings: [
					{
						kind: "alias_missing",
						severity: "info",
						uuid: "group-1",
						nodeGroupName: "web",
						trustName: null,
						message: "missing alias",
					},
				],
				metricsWarning: { reason: "no sample by the deadline", since: "2026-01-01T00:00:00.000Z" },
			}),
		]);
		const card = await screen.findByTestId("node-card");
		const group = within(card).getByTestId("node-card-status");
		// The warnings read before the status they explain, and the group ends the row.
		expect(Array.from(group.children).map((child) => child.textContent)).toEqual([
			"clock",
			"Trust",
			"Metrics",
			"Connected",
		]);
		expect(group).toHaveClass("ml-auto");
		expect(group.parentElement?.lastElementChild).toBe(group);
	});

	test("the body rows are CPU, memory, disk, uptime and total traffic, without live traffic", async () => {
		await renderPage(ADMIN, [node({ metrics: CARD_METRICS, traffic: CARD_TRAFFIC })]);
		const card = await screen.findByTestId("node-card");
		const figures = within(card).getByTestId("node-card-figures");
		const uptime = within(card).getByTestId("node-card-uptime");
		const total = within(card).getByTestId("total-traffic");
		expect(figures).toHaveTextContent("CPU usage42%Memory usage50%Disk usage20%");
		expect(figures.compareDocumentPosition(uptime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(uptime.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(uptime).toHaveTextContent("Uptime2h 00m");
		expect(card).not.toHaveTextContent("Live traffic");
		expect(within(card).queryByTestId("live-traffic")).not.toBeInTheDocument();
	});

	test("the three usage bars fill their row", async () => {
		await renderPage(ADMIN, [node({ metrics: CARD_METRICS })]);
		const figures = within(await screen.findByTestId("node-card")).getByTestId("node-card-figures");
		const bars = Array.from(figures.querySelectorAll<HTMLElement>('[data-size="fill"]'));
		expect(bars).toHaveLength(3);
		for (const bar of bars) {
			expect(bar).toHaveClass("w-full");
			expect(bar.querySelector('[aria-hidden="true"]')).toHaveClass("flex-1", "min-w-0", "h-1.5");
		}
	});
});

describe("Node card user remark", () => {
	/** Clicks the user remark row open and returns the single-line input it turns into. */
	async function openUserRemarkEditor(card: HTMLElement, text: string): Promise<HTMLInputElement> {
		fireEvent.click(within(card).getByText(text));
		return (await within(card).findByTestId("node-user-remark-input")) as HTMLInputElement;
	}

	test("an administrator gets a muted placeholder that turns into the user remark input", async () => {
		const { router } = await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		expect(within(card).getByText("Click to edit remark")).toBeInTheDocument();
		const input = await openUserRemarkEditor(card, "Click to edit remark");
		expect(input.value).toBe("");
		expect(input).toHaveFocus();
		// A click inside the user remark must not open the node page.
		expect(router.state.location.pathname).toBe("/");
	});

	test("Enter saves the user remark and the card shows it without a reload", async () => {
		const { calls } = await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		const input = await openUserRemarkEditor(card, "Click to edit remark");
		fireEvent.change(input, { target: { value: "rack 4, lab" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(calls.find((call) => call.url === "/api/nodes/node-1/user-remark")?.method).toBe("PUT"));
		expect(calls.find((call) => call.url === "/api/nodes/node-1/user-remark")?.body).toEqual({
			userRemark: "rack 4, lab",
		});
		await waitFor(() => expect(within(card).queryByTestId("node-user-remark-input")).not.toBeInTheDocument());
		expect(within(card).getByText("rack 4, lab")).toHaveAttribute("title", "rack 4, lab");
	});

	test("Escape cancels the edit without a request", async () => {
		const { calls, router } = await renderPage(ADMIN, [node({ userRemark: "keep me" })]);
		const card = await screen.findByTestId("node-card");
		const input = await openUserRemarkEditor(card, "keep me");
		// Space and Enter are the card's own open keys; inside the user remark they stay in it.
		fireEvent.keyDown(input, { key: " " });
		expect(router.state.location.pathname).toBe("/");
		fireEvent.change(input, { target: { value: "changed" } });
		fireEvent.keyDown(input, { key: "Escape" });
		await waitFor(() => expect(within(card).queryByTestId("node-user-remark-input")).not.toBeInTheDocument());
		expect(within(card).getByText("keep me")).toBeInTheDocument();
		expect(calls.some((call) => call.method === "PUT")).toBe(false);
		expect(router.state.location.pathname).toBe("/");
	});

	test("Enter on an unchanged user remark closes the editor without a request", async () => {
		const { calls } = await renderPage(ADMIN, [node({ userRemark: "abc" })]);
		const card = await screen.findByTestId("node-card");

		// The user remark already says "abc": saving it again must not reach the API.
		const input = await openUserRemarkEditor(card, "abc");
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(within(card).queryByTestId("node-user-remark-input")).not.toBeInTheDocument());
		expect(calls.filter((call) => call.url === "/api/nodes/node-1/user-remark")).toHaveLength(0);

		// Whitespace around the user remark trims back to the same value, so that is not saved either.
		const sameInput = await openUserRemarkEditor(card, "abc");
		fireEvent.change(sameInput, { target: { value: "abc  " } });
		fireEvent.keyDown(sameInput, { key: "Enter" });
		await waitFor(() => expect(within(card).queryByTestId("node-user-remark-input")).not.toBeInTheDocument());
		expect(calls.filter((call) => call.url === "/api/nodes/node-1/user-remark")).toHaveLength(0);
		expect(within(card).getByText("abc")).toBeInTheDocument();
	});

	test("blurring the input saves a changed user remark once", async () => {
		const { calls } = await renderPage(ADMIN, [node({ userRemark: "abc" })]);
		const card = await screen.findByTestId("node-card");
		const input = await openUserRemarkEditor(card, "abc");
		fireEvent.change(input, { target: { value: "rack 4, lab" } });
		fireEvent.blur(input);
		await waitFor(() => expect(within(card).queryByTestId("node-user-remark-input")).not.toBeInTheDocument());
		const requests = calls.filter((call) => call.url === "/api/nodes/node-1/user-remark");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("PUT");
		expect(requests[0]?.body).toEqual({ userRemark: "rack 4, lab" });
		expect(within(card).getByText("rack 4, lab")).toHaveAttribute("title", "rack 4, lab");
	});

	test("the input stops at 50 Unicode code points and counts an emoji as one", async () => {
		const { calls } = await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		const input = await openUserRemarkEditor(card, "Click to edit remark");
		const fifty = "😀".repeat(50);
		fireEvent.change(input, { target: { value: fifty } });
		expect(input.value).toBe(fifty);
		// A 51st code point (here a whole emoji, two UTF-16 units) is refused.
		fireEvent.change(input, { target: { value: `${fifty}😀` } });
		expect(input.value).toBe(fifty);
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(calls.some((call) => call.url === "/api/nodes/node-1/user-remark")).toBe(true));
		expect(calls.find((call) => call.url === "/api/nodes/node-1/user-remark")?.body).toEqual({ userRemark: fifty });
	});

	test("the input refuses bidi controls and line separators too", async () => {
		const { calls } = await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		const input = await openUserRemarkEditor(card, "Click to edit remark");
		fireEvent.change(input, { target: { value: "safe" } });
		expect(input.value).toBe("safe");
		for (const bad of ["safe\u202Eevil", "a\u2028b", "a\u2067b", "a\u200Fb", "a\u061Cb"]) {
			fireEvent.change(input, { target: { value: bad } });
			expect(input.value, JSON.stringify(bad)).toBe("safe");
		}
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(calls.some((call) => call.url === "/api/nodes/node-1/user-remark")).toBe(true));
		expect(calls.find((call) => call.url === "/api/nodes/node-1/user-remark")?.body).toEqual({ userRemark: "safe" });
	});

	test("a member reads the user remark and gets nothing when it is empty", async () => {
		await renderPage(MEMBER, [node({ access: "granted", userRemark: "rack 4, lab" })]);
		const card = await screen.findByTestId("node-card");
		const remark = within(card).getByTestId("node-user-remark");
		expect(remark).toHaveTextContent("rack 4, lab");
		expect(within(remark).queryByRole("button")).not.toBeInTheDocument();
		expect(within(remark).queryByTestId("node-user-remark-input")).not.toBeInTheDocument();

		cleanup();
		await renderPage(MEMBER, [node({ access: "granted" })]);
		const emptyCard = await screen.findByTestId("node-card");
		expect(within(emptyCard).queryByTestId("node-user-remark")).not.toBeInTheDocument();
		expect(within(emptyCard).queryByText("Click to edit remark")).not.toBeInTheDocument();
	});

	test("a failed save keeps the input open and shows the error inline", async () => {
		await renderPage(ADMIN, [node()], {
			remarkError: "user remark: must be a single line without control characters",
		});
		const card = await screen.findByTestId("node-card");
		const input = await openUserRemarkEditor(card, "Click to edit remark");
		fireEvent.change(input, { target: { value: "bad" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(
			await within(card).findByText("user remark: must be a single line without control characters"),
		).toBeInTheDocument();
		expect(within(card).getByTestId("node-user-remark-input")).toBeInTheDocument();
	});
});

describe("Node emoji", () => {
	test("the table shows the emoji left of the name", async () => {
		await renderTablePage(ADMIN, [node({ emoji: "🚀" })]);
		const glyph = await screen.findByTestId("node-emoji");
		expect(glyph).toHaveTextContent("🚀");
		expect(glyph).toHaveAttribute("aria-hidden", "true");
		// The emoji stands before the name, inside the row's name cell.
		expect(glyph.nextElementSibling).toHaveTextContent("worker-01");
	});

	test("the card shows the emoji left of the name", async () => {
		await renderPage(ADMIN, [node({ emoji: "🚀" })]);
		const card = await screen.findByTestId("node-card");
		const link = within(card).getByRole("link", { name: "worker-01" });
		const glyph = within(link).getByTestId("node-emoji");
		expect(glyph).toHaveTextContent("🚀");
		expect(glyph).toHaveAttribute("aria-hidden", "true");
		expect(glyph.nextElementSibling).toHaveTextContent("worker-01");
	});

	test("nothing is shown when the emoji is null", async () => {
		await renderPage(ADMIN, [node()]);
		const card = await screen.findByTestId("node-card");
		expect(within(card).queryByTestId("node-emoji")).not.toBeInTheDocument();

		cleanup();
		await renderTablePage(ADMIN, [node()]);
		await screen.findByRole("columnheader", { name: /^Name$/ });
		expect(screen.queryByTestId("node-emoji")).not.toBeInTheDocument();
	});

	test("the node page heading shows the emoji for a member, without any editing", async () => {
		await renderDetail(MEMBER, [node({ emoji: "🚀" })]);
		const heading = await screen.findByRole("heading", { name: "worker-01" });
		const glyph = within(heading).getByTestId("node-emoji");
		expect(glyph).toHaveTextContent("🚀");
		expect(glyph).toHaveAttribute("aria-hidden", "true");
		expect(screen.queryByRole("button", { name: "Set emoji" })).not.toBeInTheDocument();
	});

	test("an administrator opens the picker and removes the emoji", async () => {
		const { calls } = await renderDetail(ADMIN, [node({ emoji: "🚀" })]);
		const heading = await screen.findByRole("heading", { name: "worker-01" });
		const button = within(heading).getByTestId("node-emoji-button");
		expect(button).toHaveTextContent("🚀");
		expect(button).toHaveAccessibleName("Set emoji");

		fireEvent.click(button);
		// The picker is a lazy chunk, so its controls arrive asynchronously.
		const remove = await screen.findByTestId("remove-emoji", undefined, { timeout: 15_000 });
		expect(await screen.findByTestId("emoji-picker")).toBeInTheDocument();
		expect(screen.getByLabelText("Search emoji")).toBeInTheDocument();
		fireEvent.click(remove);
		await waitFor(() =>
			expect(calls.find((call) => call.url === "/api/nodes/node-1/emoji" && call.method === "PUT")?.body).toEqual({
				emoji: null,
			}),
		);
	}, 20_000);
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

	test("the node table fits the standard list width without horizontal scrolling", async () => {
		await renderTablePage(ADMIN, [node()]);
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

	test("the node name is the table row's link to the node page", async () => {
		await renderTablePage(ADMIN, [node()]);
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

	test("the node list marks a failing metrics collection and an older crha", async () => {
		await renderPage(MEMBER, [
			node({
				metricsWarning: { reason: "no sample by the deadline", since: "2026-01-01T00:00:00.000Z" },
				updateAvailable: true,
			}),
		]);
		const metrics = await screen.findByTestId("metrics-warning-indicator");
		expect(metrics).toHaveAttribute("title", "Metrics collection failing: no sample by the deadline");
		expect(metrics).toHaveTextContent("Metrics");
		const update = screen.getByTestId("update-available-indicator");
		expect(update).toHaveAttribute("title", "Update available");
		expect(update).toHaveTextContent("Update available");
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
		const indicator = await screen.findByTestId("trust-warning-indicator");
		expect(indicator).toHaveAttribute("data-tone", "danger");
		expect(indicator).toHaveTextContent("Trust");
	});
});

describe("NodeDetailPage", () => {
	test("shows the metrics failure details and the update notice", async () => {
		await renderDetail(MEMBER, [
			node({
				metricsWarning: { reason: "no sample by the deadline", since: "2026-01-01T00:00:00.000Z" },
				updateAvailable: true,
			}),
		]);
		const warning = await screen.findByTestId("metrics-warning");
		expect(warning).toHaveTextContent("Metrics collection failing");
		expect(warning).toHaveTextContent("no sample by the deadline");
		expect(screen.getByTestId("update-available")).toHaveTextContent("Update available");
	});

	test("an SSH node's badge sits in the title, not the status line", async () => {
		await renderDetail(MEMBER, [node({ transport: "ssh", hostname: "edge.example", connected: null })]);
		const heading = await screen.findByRole("heading", { name: "worker-01" });
		expect(within(heading).getByText("SSH")).toBeInTheDocument();
		expect(heading).toHaveTextContent("worker-01SSH");
		const description = heading.parentElement?.querySelector("p");
		expect(description).toHaveTextContent("Active");
		expect(description).not.toHaveTextContent("SSH");
	});

	test("moves hostname, privileged mode and the upgrade log to Technical details", async () => {
		const facts = {
			hostname: "worker-01.local",
			platform: "linux, amd64, Ubuntu 24.04",
			upgradeLogPath: "/var/log/crha/upgrade.jsonl",
		};
		await renderDetail(MEMBER, [node({ hostname: "worker-01.local", privilegedMode: "forward", facts })]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.getByText("Platform")).toBeInTheDocument();
		for (const removed of ["Transport", "Hostname", "Privileged mode", "Upgrade log"]) {
			expect(screen.queryByText(removed), removed).not.toBeInTheDocument();
		}

		fireEvent.click(screen.getByRole("tab", { name: "Technical details" }));
		const hostname = await screen.findByText("Hostname");
		expect(hostname.nextElementSibling).toHaveTextContent("worker-01.local");
		expect(screen.getByText("Privileged mode").nextElementSibling).toHaveTextContent("forward");
		expect(screen.getByText("Upgrade log").nextElementSibling).toHaveTextContent("/var/log/crha/upgrade.jsonl");
	});

	test("an SSH node's Technical details keeps the ignored privileged mode", async () => {
		await renderDetail(MEMBER, [node({ transport: "ssh", hostname: "edge.example", connected: null })]);
		await screen.findByRole("heading", { name: "worker-01" });
		fireEvent.click(screen.getByRole("tab", { name: "Technical details" }));
		const hostname = await screen.findByText("Hostname");
		expect(hostname.nextElementSibling).toHaveTextContent("edge.example");
		expect(screen.getByText("Privileged mode").nextElementSibling).toHaveTextContent("ignored (SSH)");
		expect(screen.queryByText("Upgrade log")).not.toBeInTheDocument();
	});

	test("the overview facts use one column on narrow screens and two from lg", async () => {
		await renderDetail(MEMBER, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		const list = screen.getByText("Platform").closest("dl");
		expect(list).toHaveClass("grid-cols-1", "lg:grid-cols-[auto_1fr_auto_1fr]");
		expect(list).not.toHaveClass("sm:grid-cols-[auto_1fr_auto_1fr]");
	});

	test("puts the metrics summary and CPU/memory charts between the facts and access grants", async () => {
		await renderDetail(ADMIN, [node({ facts: { platform: "linux, amd64" } })], {
			metrics: nodeMetricsResponse(),
		});
		await screen.findByRole("heading", { name: "worker-01" });
		const facts = screen.getByText("Platform").closest("dl");
		if (facts === null) throw new Error("no overview facts list");
		const summary = await screen.findByTestId("metrics-summary", undefined, { timeout: 15_000 });
		const cpu = await screen.findByTestId("metrics-chart-cpu", undefined, { timeout: 15_000 });
		const memory = await screen.findByTestId("metrics-chart-memory", undefined, { timeout: 15_000 });
		const access = await screen.findByTestId("node-access");

		expect(facts.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(summary.compareDocumentPosition(cpu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(cpu.compareDocumentPosition(memory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(memory.compareDocumentPosition(access) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(within(summary).getByTestId("metrics-summary-cpu")).toHaveTextContent("25%");
		expect(within(cpu).getByTestId("metrics-plot-cpu")).toHaveAttribute("role", "img");
		expect(within(memory).getByTestId("metrics-plot-memory")).toHaveAttribute("role", "img");
		// The Overview uses the default range silently; the picker belongs to the Metrics tab.
		expect(screen.queryByRole("toolbar", { name: "Time range" })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
		await screen.findByTestId("node-metrics");
		expect(screen.queryByTestId("node-overview-metrics")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-summary")).not.toBeInTheDocument();
		expect(screen.getByTestId("metrics-chart-cpu")).toBeInTheDocument();
	});

	test("shows no metrics section when the node has no host metrics", async () => {
		const { calls } = await renderDetail(MEMBER, [node()], { metrics: nodeMetricsResponse([]) });
		await screen.findByRole("heading", { name: "worker-01" });
		await waitFor(() => expect(calls.some((call) => call.url.endsWith("/metrics"))).toBe(true));
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.queryByTestId("node-overview-metrics")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-summary")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-chart-cpu")).not.toBeInTheDocument();
		expect(screen.queryByText("No metrics yet")).not.toBeInTheDocument();
	});

	test("shows no metrics section for a node sampled as reachability only", async () => {
		await renderDetail(MEMBER, [node()], { metrics: nodeMetricsResponse([metricReading("up", 1)]) });
		await screen.findByRole("heading", { name: "worker-01" });
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.queryByTestId("metrics-summary")).not.toBeInTheDocument();
		expect(screen.queryByText("Uptime")).not.toBeInTheDocument();
	});

	test("reuses the Overview metrics read when the Metrics tab opens", async () => {
		const { calls } = await renderDetail(ADMIN, [node()], {
			metrics: nodeMetricsResponse(),
			staleTime: 60_000,
		});
		await screen.findByTestId("metrics-summary");
		const metricsCalls = () => calls.filter((call) => call.url.endsWith("/metrics"));
		expect(metricsCalls()).toHaveLength(1);
		fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
		await screen.findByTestId("node-metrics");
		await act(async () => {
			await Promise.resolve();
		});
		expect(metricsCalls()).toHaveLength(1);
	});

	test("shows the node's user remark on the overview only when one is set", async () => {
		await renderDetail(MEMBER, [node({ userRemark: "rack 4, lab" })]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.getByText("User remark")).toBeInTheDocument();
		expect(screen.getByText("rack 4, lab")).toBeInTheDocument();

		cleanup();
		await renderDetail(MEMBER, [node()]);
		await screen.findByRole("heading", { name: "worker-01" });
		expect(screen.queryByText("User remark")).not.toBeInTheDocument();
	});

	test("an administrator sees the aliases line for a forward node with node groups", async () => {
		route.params = { nodeId: "node-1" };
		mockFetch(ADMIN, [
			node({
				privilegedMode: "forward",
				nodeGroups: [
					{ id: "group-1", name: "web", emoji: null },
					{ id: "group-2", name: "db", emoji: null },
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

		// The aliases sit with the trust report on the Technical details tab.
		fireEvent.click(await screen.findByRole("tab", { name: "Technical details" }));
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
