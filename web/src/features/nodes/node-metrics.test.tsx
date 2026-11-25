import type { MetricBucketPoint, MetricSeriesReading, NodeMetricsResponse, User } from "@crh/api";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/lib/session";
import { localDateTimeValue } from "@/lib/timezone";
import { renderWithI18n, testQueryClient } from "@/test/render";
import { METRICS_SERIES, nodeKeys } from "./api";
import { NodeMetrics, NodeMetricsSummary, NodeOverviewMetrics } from "./node-metrics";

interface FakeChart {
	option: Record<string, unknown>;
	disposed: boolean;
	resize: ReturnType<typeof vi.fn>;
}

const charts = vi.hoisted(() => [] as FakeChart[]);

vi.mock("echarts/core", () => {
	class FakeChart {
		option: Record<string, unknown> = {};
		disposed = false;
		resize = vi.fn();
		setOption(option: Record<string, unknown>) {
			this.option = option;
		}
		dispose() {
			this.disposed = true;
		}
	}
	return {
		init: vi.fn(() => {
			const chart = new FakeChart();
			charts.push(chart as never);
			return chart;
		}),
		use: vi.fn(),
	};
});
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({
	DataZoomComponent: {},
	GridComponent: {},
	LegendComponent: {},
	TooltipComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

const MINUTE = 60_000;
const GIB = 1024 * 1024 * 1024;
const base = Math.floor(Date.now() / MINUTE) * MINUTE;

const calls: URL[] = [];
const writes: { url: URL; body: unknown }[] = [];

const ADMIN: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

function bucket(
	t: number,
	avg: number,
	options: { min?: number; max?: number; count?: number } = {},
): MetricBucketPoint {
	const count = options.count ?? 1;
	return {
		t,
		count,
		avg,
		sum: avg * count,
		min: options.min ?? avg,
		max: options.max ?? avg,
		last: avg,
	};
}

function reading(
	name: string,
	buckets: MetricBucketPoint[],
	lastSeenAt = new Date().toISOString(),
): MetricSeriesReading {
	return { name, kind: "gauge", lastSeenAt, buckets };
}

function response(series: MetricSeriesReading[], bucketMs = MINUTE): NodeMetricsResponse {
	return { level: 1, bucketMs, series, traffic: null };
}

/** The server's `series`/`prefix.*` expansion: a mock must not return a series the WebUI never asked for. */
function requestedSeries(url: URL, series: MetricSeriesReading[]): MetricSeriesReading[] {
	const requested = url.searchParams.get("series");
	if (requested === null) return series;
	const entries = requested
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return series.filter((reading) =>
		entries.some((entry) =>
			entry.endsWith(".*") ? reading.name.startsWith(entry.slice(0, -1)) : reading.name === entry,
		),
	);
}

function mockMetrics(handler: (url: URL) => NodeMetricsResponse, options: { user?: User } = {}): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			if (url.pathname === "/api/me" && options.user !== undefined) return json({ user: options.user });
			if (init?.method === "POST" || init?.method === "PUT") {
				writes.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
				return json({ traffic: null });
			}
			calls.push(url);
			const body = handler(url);
			return json({ ...body, series: requestedSeries(url, body.series) });
		}),
	);
}

function mainCalls(): URL[] {
	return calls.filter((url) => !url.searchParams.has("level"));
}

interface LineOption {
	name: string;
	data: [number, number | null][];
	connectNulls?: boolean;
}

function lineOptions(chart: FakeChart | undefined): LineOption[] {
	return (chart?.option.series ?? []) as LineOption[];
}

function valueAt(series: LineOption | undefined, time: number): number | null | undefined {
	return series?.data.find((entry) => entry[0] === time)?.[1];
}

afterEach(() => {
	calls.length = 0;
	writes.length = 0;
	charts.length = 0;
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("NodeMetrics", () => {
	test("requests the selected range and shows the empty state when the node has no metrics", async () => {
		mockMetrics(() => response([]));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		expect(await screen.findByText("No metrics yet")).toBeInTheDocument();
		expect(mainCalls()).toHaveLength(1);
		const first = mainCalls()[0] as URL;
		expect(first.pathname).toBe("/api/nodes/node-1/metrics");
		expect(first.searchParams.get("series")).toContain("mem.free_bytes");
		expect(first.searchParams.get("series")).not.toContain("cpu.core.*");
		expect(first.searchParams.get("series")).toContain("uptime");
		expect(first.searchParams.get("series")).toContain("disk.*");
		expect(Number(first.searchParams.get("to")) - Number(first.searchParams.get("from"))).toBeGreaterThanOrEqual(
			59 * 60 * 1000,
		);
		expect(Number(first.searchParams.get("to")) - Number(first.searchParams.get("from"))).toBeLessThanOrEqual(
			61 * 60 * 1000,
		);

		fireEvent.click(screen.getByRole("button", { name: "24 hours" }));
		await waitFor(() => expect(mainCalls()).toHaveLength(2));
		const second = mainCalls()[1] as URL;
		expect(second.searchParams.get("series")).toBe(first.searchParams.get("series"));
		expect(Number(second.searchParams.get("to")) - Number(second.searchParams.get("from"))).toBeGreaterThanOrEqual(
			23 * 60 * 60 * 1000,
		);
	});

	test("asks for every series a chart draws, including the memory Free line", () => {
		expect(METRICS_SERIES).toContain("mem.free_bytes");
		expect(METRICS_SERIES).toContain("mem.cached_bytes");
		expect(METRICS_SERIES).not.toContain("cpu.core.*");
	});

	test("renders exactly the five summary labels from the newest sample", async () => {
		const data: NodeMetricsResponse = {
			...response([
				reading("uptime", [bucket(base - MINUTE, 7200)]),
				reading("cpu.total", [bucket(base - MINUTE, 0.25)]),
				reading("mem.total_bytes", [bucket(base - MINUTE, 8 * GIB)]),
				reading("mem.available_bytes", [bucket(base - MINUTE, 2 * GIB)]),
				reading("disk.data.total_bytes", [bucket(base - MINUTE, 100 * GIB)]),
				reading("disk.data.used_bytes", [bucket(base - MINUTE, 25 * GIB)]),
				reading("disk.root.total_bytes", [bucket(base - MINUTE, 50 * GIB)]),
				reading("disk.root.used_bytes", [bucket(base - MINUTE, 25 * GIB)]),
				reading("net.rx_bytes_per_sec", [bucket(base - MINUTE, 16.2 * 1024)]),
				reading("net.tx_bytes_per_sec", [bucket(base - MINUTE, 27.8 * 1024)]),
			]),
			// The first filesystem is data even though root sorts first.
			diskOrder: ["data", "root"],
		};
		renderWithI18n(<NodeMetricsSummary data={data} />);
		const summary = await screen.findByTestId("metrics-summary");
		const labels = [...summary.querySelectorAll("dt")].map((label) => label.textContent);
		expect(labels).toEqual(["Uptime", "CPU usage", "Memory usage", "Disk usage", "Live traffic"]);
		// Every value shares one fixed-height, vertically centred row, so the five columns line up; the
		// usage values use the larger bar and percentage that match the plain-text values next to them.
		const values = [...summary.querySelectorAll("dd")];
		expect(values).toHaveLength(5);
		for (const value of values) expect(value).toHaveClass("flex", "h-6", "items-center");
		const bars = [...summary.querySelectorAll("dd [data-size]")];
		expect(bars.map((bar) => bar.getAttribute("data-size"))).toEqual(["md", "md", "md"]);
		for (const bar of bars) {
			expect(bar.querySelector("[aria-hidden='true']")).toHaveClass("h-2", "w-24");
			expect(bar.lastElementChild).toHaveClass("text-sm", "font-medium", "leading-none");
		}
		expect(summary).toHaveTextContent("Uptime2h 00m");
		expect(summary).not.toHaveTextContent("GiB /");
		expect(summary).not.toHaveTextContent("data:");
		expect(summary).not.toHaveTextContent("Resets every 30 days");
		expect(within(summary).queryByRole("button")).not.toBeInTheDocument();
		expect(within(screen.getByTestId("metrics-summary-cpu")).getByText("25%")).toBeInTheDocument();
		expect(within(screen.getByTestId("metrics-summary-memory")).getByText("75%")).toBeInTheDocument();
		const filesystem = screen.getByTestId("metrics-summary-filesystem");
		expect(filesystem).toHaveTextContent("Disk usage25%");
		expect(filesystem).not.toHaveTextContent("data");
		expect(filesystem).toHaveAttribute("title", "data");
		const traffic = screen.getByTestId("metrics-summary-traffic");
		expect(traffic).toHaveTextContent("Live traffic16.2 KiB / 27.8 KiB");
		expect(traffic.querySelector("dd")).toHaveClass("flex", "h-6", "items-center");
		const live = within(traffic).getByTitle("Received 16.2 KiB/s, sent 27.8 KiB/s");
		expect(live).toHaveAttribute("aria-label", "Received 16.2 KiB/s, sent 27.8 KiB/s");
		expect(live.querySelector(".lucide-arrow-down")).toHaveClass("size-3.5");
		expect(live.querySelector(".lucide-arrow-up")).toHaveClass("size-3.5");
		expect(live.querySelectorAll("svg")).toHaveLength(2);
	});

	test("keeps the summary out of the Metrics tab", async () => {
		mockMetrics(() => response([reading("cpu.total", [bucket(base - MINUTE, 0.25)])]));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("metrics-chart-cpu");
		expect(screen.queryByTestId("metrics-summary")).not.toBeInTheDocument();
	});

	test("falls back to root, then the alphabetically first filesystem, for the summary", async () => {
		const root = renderWithI18n(
			<NodeMetricsSummary
				data={response([
					reading("disk.alpha.total_bytes", [bucket(base - MINUTE, 1000)]),
					reading("disk.alpha.used_bytes", [bucket(base - MINUTE, 100)]),
					reading("disk.root.total_bytes", [bucket(base - MINUTE, 2000)]),
					reading("disk.root.used_bytes", [bucket(base - MINUTE, 200)]),
				])}
			/>,
		);
		const rootCard = await screen.findByTestId("metrics-summary-filesystem");
		expect(rootCard).toHaveTextContent("10%");
		expect(rootCard).toHaveAttribute("title", "root");
		root.unmount();

		renderWithI18n(
			<NodeMetricsSummary
				data={response([
					reading("disk.beta.total_bytes", [bucket(base - MINUTE, 1000)]),
					reading("disk.beta.used_bytes", [bucket(base - MINUTE, 100)]),
					reading("disk.alpha.total_bytes", [bucket(base - MINUTE, 2000)]),
					reading("disk.alpha.used_bytes", [bucket(base - MINUTE, 200)]),
				])}
			/>,
		);
		const alpha = await screen.findByTestId("metrics-summary-filesystem");
		expect(alpha).toHaveTextContent("10%");
		expect(alpha).toHaveAttribute("title", "alpha");
	});

	test("shows a dash for every missing summary figure", async () => {
		renderWithI18n(<NodeMetricsSummary data={response([reading("up", [bucket(base - MINUTE, 1)])])} />);
		const summary = await screen.findByTestId("metrics-summary");
		expect([...summary.querySelectorAll("dt")]).toHaveLength(5);
		expect(summary).toHaveTextContent("Uptime–");
		expect(screen.getByTestId("metrics-summary-cpu")).toHaveTextContent("–");
		expect(screen.getByTestId("metrics-summary-memory")).toHaveTextContent("–");
		expect(screen.getByTestId("metrics-summary-filesystem")).toHaveTextContent("–");
		expect(screen.getByTestId("metrics-summary-traffic")).toHaveTextContent("Live traffic–");
	});

	test("has no traffic footer or Network card without a traffic period", async () => {
		mockMetrics(() => response([reading("cpu.total", [bucket(base - MINUTE, 0.1)])]));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("metrics-chart-cpu");
		expect(screen.queryByTestId("metrics-network-traffic")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-chart-network")).not.toBeInTheDocument();
	});

	test("shows a Network card with only the traffic footer when the node has no network series", async () => {
		mockMetrics(() => ({
			...response([reading("cpu.total", [bucket(base - MINUTE, 0.2)])]),
			traffic: {
				periodStart: new Date(base - 5 * 24 * 60 * MINUTE).toISOString(),
				nextResetAt: new Date(base + 25 * 24 * 60 * MINUTE).toISOString(),
				rxBytes: 1024,
				txBytes: 2048,
			},
		}));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const network = await screen.findByTestId("metrics-chart-network");
		expect(within(network).getByRole("heading", { name: "Network" })).toBeInTheDocument();
		const footer = within(network).getByTestId("metrics-network-traffic");
		expect(footer).toHaveTextContent("Total");
		expect(footer).toHaveTextContent("1 KiB / 2 KiB");
		expect(footer).toHaveTextContent("Since");
		expect(footer).toHaveTextContent("Next reset");
		expect(footer).toHaveTextContent("Resets every 30 days");
		expect(within(footer).queryByRole("button")).not.toBeInTheDocument();
		expect(within(network).queryByTestId("metrics-plot-network")).not.toBeInTheDocument();
		expect(within(network).queryByText("No data in this range.")).not.toBeInTheDocument();
	});

	test("keeps the traffic footer when no samples fall in the selected range", async () => {
		mockMetrics(() => ({
			...response([reading("net.rx_bytes_per_sec", [])]),
			traffic: {
				periodStart: new Date(base - 5 * 24 * 60 * MINUTE).toISOString(),
				nextResetAt: new Date(base + 25 * 24 * 60 * MINUTE).toISOString(),
				rxBytes: 1024,
				txBytes: 2048,
			},
		}));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		expect(await screen.findByText("No samples in this range")).toBeInTheDocument();
		expect(await screen.findByTestId("metrics-network-traffic")).toBeInTheDocument();
	});

	test("draws CPU as a full-window grid with nulls in the gaps and a min/max band", async () => {
		mockMetrics(() =>
			response([
				reading("cpu.total", [
					bucket(base - 3 * MINUTE, 0.1, { min: 0.05, max: 0.15 }),
					bucket(base - MINUTE, 0.3, { min: 0.25, max: 0.35 }),
				]),
			]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("metrics-plot-cpu");
		const option = charts.at(-1)?.option as Record<string, unknown>;
		const lines = lineOptions(charts.at(-1));
		expect((option.legend as { data: string[] }).data).toEqual(["CPU"]);
		expect(lines[0]?.connectNulls).toBe(false);
		expect(valueAt(lines[0], base - 3 * MINUTE)).toBeCloseTo(10);
		expect(valueAt(lines[0], base - 2 * MINUTE)).toBeNull();
		expect(valueAt(lines[0], base - MINUTE)).toBeCloseTo(30);
		expect(lines[1]?.name).toBe("__band_min");
		expect(valueAt(lines[1], base - 3 * MINUTE)).toBeCloseTo(5);
		expect(lines[2]?.name).toBe("__band_max");
		expect(valueAt(lines[2], base - 3 * MINUTE)).toBeCloseTo(10);
		expect((option.yAxis as { max: number }).max).toBe(100);
	});

	test("draws memory used, cached and free, bounded by the window's memory total and no total line", async () => {
		mockMetrics(() =>
			response([
				reading("mem.total_bytes", [bucket(base - MINUTE, 1000, { max: 1200 })]),
				reading("mem.available_bytes", [bucket(base - MINUTE, 250)]),
				reading("mem.cached_bytes", [bucket(base - MINUTE, 100)]),
				reading("mem.free_bytes", [bucket(base - MINUTE, 50)]),
			]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("metrics-plot-memory");
		const chart = charts.at(-1);
		const lines = lineOptions(chart);
		expect(lines.map((line) => line.name)).toEqual(["Used", "Cached", "Free"]);
		expect(valueAt(lines[0], base - MINUTE)).toBe(750);
		expect(valueAt(lines[1], base - MINUTE)).toBe(100);
		expect(valueAt(lines[2], base - MINUTE)).toBe(50);
		expect(((chart?.option.yAxis ?? {}) as { max?: number }).max).toBe(1280);
	});

	test("hides swap when its total is zero", async () => {
		mockMetrics(() =>
			response([
				reading("swap.total_bytes", [bucket(base - MINUTE, 0)]),
				reading("swap.free_bytes", [bucket(base - MINUTE, 0)]),
			]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("node-metrics");
		expect(screen.queryByTestId("metrics-chart-swap")).not.toBeInTheDocument();
	});

	test("draws every filesystem in one disks chart in report order, bounded by the largest total", async () => {
		mockMetrics(() => ({
			...response([
				reading("disk.alpha.used_bytes", [bucket(base - MINUTE, 300)]),
				reading("disk.alpha.total_bytes", [bucket(base - MINUTE, 1000)]),
				reading("disk.beta.used_bytes", [bucket(base - MINUTE, 500)]),
				reading("disk.beta.total_bytes", [bucket(base - MINUTE, 2000)]),
			]),
			diskOrder: ["beta", "alpha"],
		}));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("metrics-plot-disks");
		const chart = charts.at(-1);
		expect(lineOptions(chart).map((line) => line.name)).toEqual(["beta", "alpha"]);
		expect(((chart?.option.yAxis ?? {}) as { max?: number }).max).toBe(2048);
		expect(screen.queryByTestId("metrics-chart-disk-alpha")).not.toBeInTheDocument();
	});

	test("draws network as the full-row bytes/s chart", async () => {
		mockMetrics(() =>
			response([
				reading("net.rx_bytes_per_sec", [bucket(base - MINUTE, 1024)]),
				reading("net.tx_bytes_per_sec", [bucket(base - MINUTE, 2048)]),
			]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const card = await screen.findByTestId("metrics-chart-network");
		expect(card.className).toContain("md:col-span-2");
		expect(lineOptions(charts.at(-1)).map((line) => line.name)).toEqual(["Received", "Sent"]);
		// The response has no traffic row, so the chart card has no totals footer.
		expect(within(card).queryByTestId("metrics-network-traffic")).not.toBeInTheDocument();
	});

	test("spans the last half-width card across the row when it would be alone", async () => {
		mockMetrics(() =>
			response([
				reading("cpu.total", [bucket(base - MINUTE, 0.2)]),
				reading("load.1", [bucket(base - MINUTE, 1)]),
				reading("disk.root.used_bytes", [bucket(base - MINUTE, 300)]),
			]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const disks = await screen.findByTestId("metrics-chart-disks");
		expect(disks.className).toContain("md:col-span-2");
		expect(screen.getByTestId("metrics-chart-cpu").className).not.toContain("md:col-span-2");
		expect(screen.getByTestId("metrics-chart-load").className).not.toContain("md:col-span-2");
	});

	test("keeps half-width cards in their halves when the count is even", async () => {
		mockMetrics(() =>
			response([reading("cpu.total", [bucket(base - MINUTE, 0.2)]), reading("load.1", [bucket(base - MINUTE, 1)])]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const load = await screen.findByTestId("metrics-chart-load");
		expect(load.className).not.toContain("md:col-span-2");
		expect(screen.getByTestId("metrics-chart-cpu").className).not.toContain("md:col-span-2");
	});

	test("labels the charts and their lines in the interface language", async () => {
		const data = response([
			reading("mem.total_bytes", [bucket(base - MINUTE, 1000)]),
			reading("mem.available_bytes", [bucket(base - MINUTE, 250)]),
			reading("mem.cached_bytes", [bucket(base - MINUTE, 100)]),
			reading("mem.free_bytes", [bucket(base - MINUTE, 50)]),
		]);
		mockMetrics(() => data);
		renderWithI18n(
			<>
				<NodeMetricsSummary data={data} />
				<NodeMetrics nodeId="node-1" />
			</>,
			"zh-CN",
		);
		await screen.findByTestId("metrics-plot-memory");
		expect(screen.getByText("内存")).toBeInTheDocument();
		expect(lineOptions(charts.at(-1)).map((line) => line.name)).toEqual(["已用", "缓存", "空闲"]);
		const labels = [...screen.getByTestId("metrics-summary").querySelectorAll("dt")].map((label) => label.textContent);
		expect(labels).toEqual(["运行时间", "CPU 使用率", "内存使用率", "磁盘占用率", "实时流量"]);
	});

	test("keeps the availability strip and explains a node sampled as up only", async () => {
		const availability = response([reading("up", [bucket(base - 2 * 24 * 60 * MINUTE, 0.99, { count: 1440 })])]);
		mockMetrics((url) =>
			url.searchParams.has("level") ? availability : response([reading("up", [bucket(base - MINUTE, 1)])]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		expect(await screen.findByTestId("metrics-chart-availability")).toBeInTheDocument();
		expect(screen.getByTestId("metrics-reachability-only")).toHaveTextContent("Only reachability is recorded");
		expect(screen.queryByTestId("metrics-chart-cpu")).not.toBeInTheDocument();
		expect(calls.some((url) => url.searchParams.get("level") === "4")).toBe(true);
	});

	test("labels the availability card as availability, not a range, in zh-CN", async () => {
		const availability = response([reading("up", [bucket(base - MINUTE, 1, { count: 1440 })])]);
		mockMetrics((url) =>
			url.searchParams.has("level") ? availability : response([reading("up", [bucket(base - MINUTE, 1)])]),
		);
		renderWithI18n(<NodeMetrics nodeId="node-1" />, "zh-CN");
		const card = await screen.findByTestId("metrics-chart-availability");
		expect(within(card).getByRole("heading", { name: "可用性" })).toBeInTheDocument();
		expect(within(card).getByRole("toolbar")).toHaveAttribute("aria-label", "可用性范围");
	});

	test("offers the traffic actions to administrators only in the network footer", async () => {
		const responseWithTraffic = () => ({
			...response([reading("net.rx_bytes_per_sec", [bucket(base - MINUTE, 1024)])]),
			traffic: {
				periodStart: new Date(base - 5 * 24 * 60 * MINUTE).toISOString(),
				nextResetAt: new Date(base + 25 * 24 * 60 * MINUTE).toISOString(),
				rxBytes: 1024,
				txBytes: 2048,
			},
		});
		mockMetrics(responseWithTraffic);
		const view = renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const footer = await screen.findByTestId("metrics-network-traffic");
		expect(within(footer).queryByRole("button", { name: "Reset now" })).not.toBeInTheDocument();
		expect(within(footer).queryByRole("button", { name: "Set next reset" })).not.toBeInTheDocument();
		view.unmount();

		mockMetrics(responseWithTraffic, { user: ADMIN });
		await act(async () => {
			await authStore.load();
		});
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const network = await screen.findByTestId("metrics-chart-network");
		const adminFooter = within(network).getByTestId("metrics-network-traffic");
		expect(within(adminFooter).getByRole("button", { name: "Reset now" })).toBeInTheDocument();
		expect(within(adminFooter).getByRole("button", { name: "Set next reset" })).toBeInTheDocument();
	});

	test("resets the traffic total now after a confirmation", async () => {
		mockMetrics(
			() => ({
				...response([reading("net.rx_bytes_per_sec", [bucket(base - MINUTE, 1024)])]),
				traffic: {
					periodStart: new Date(base - 5 * 24 * 60 * MINUTE).toISOString(),
					nextResetAt: new Date(base + 25 * 24 * 60 * MINUTE).toISOString(),
					rxBytes: 1024,
					txBytes: 2048,
				},
			}),
			{ user: ADMIN },
		);
		await act(async () => {
			await authStore.load();
		});
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const footer = await screen.findByTestId("metrics-network-traffic");
		fireEvent.click(within(footer).getByRole("button", { name: "Reset now" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Reset traffic now?")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Reset now" }));
		await waitFor(() => expect(writes.some((write) => write.url.pathname.endsWith("/traffic/reset"))).toBe(true));
	});

	test("converts the datetime-local value from the browser's zone to a UTC instant", async () => {
		mockMetrics(
			() => ({
				...response([reading("net.rx_bytes_per_sec", [bucket(base - MINUTE, 1024)])]),
				traffic: {
					periodStart: new Date(base - 5 * 24 * 60 * MINUTE).toISOString(),
					nextResetAt: new Date(base + 25 * 24 * 60 * MINUTE).toISOString(),
					rxBytes: 1024,
					txBytes: 2048,
				},
			}),
			{ user: ADMIN },
		);
		await act(async () => {
			await authStore.load();
		});
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		const footer = await screen.findByTestId("metrics-network-traffic");
		fireEvent.click(within(footer).getByRole("button", { name: "Set next reset" }));
		const dialog = await screen.findByTestId("traffic-next-reset-dialog");
		// The label names the zone the value is read in, never "your time zone".
		const input = within(dialog).getByLabelText(/Time \(/) as HTMLInputElement;
		expect(input.type).toBe("datetime-local");
		expect(within(dialog).getByText(/^Time \(/)).toBeInTheDocument();
		const target = new Date(Date.now() + 10 * 24 * 60 * MINUTE);
		target.setSeconds(0, 0);
		const local = localDateTimeValue(target);
		fireEvent.change(input, { target: { value: local } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Set next reset" }));
		await waitFor(() => expect(writes.some((write) => write.url.pathname.endsWith("/traffic/next-reset"))).toBe(true));
		const write = writes.find((entry) => entry.url.pathname.endsWith("/traffic/next-reset"));
		expect(write?.body).toEqual({ nextResetAt: target.toISOString() });
	});

	test("refreshes with a sliding window every 30 seconds and stops while hidden", async () => {
		vi.useFakeTimers();
		try {
			mockMetrics(() => response([reading("cpu.total", [bucket(base - MINUTE, 0.1)])]));
			const view = renderWithI18n(<NodeMetrics nodeId="node-1" />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(mainCalls()).toHaveLength(1);
			const firstTo = Number(mainCalls()[0]?.searchParams.get("to"));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(30_000);
			});
			expect(mainCalls()).toHaveLength(2);
			expect(Number(mainCalls()[1]?.searchParams.get("to")) - firstTo).toBe(30_000);

			const state = Object.getOwnPropertyDescriptor(document, "visibilityState");
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
			try {
				act(() => {
					document.dispatchEvent(new Event("visibilitychange"));
				});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(60_000);
				});
				expect(mainCalls()).toHaveLength(2);
			} finally {
				if (state === undefined) delete (document as { visibilityState?: string }).visibilityState;
				else Object.defineProperty(document, "visibilityState", state);
			}
			view.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	test("opens the zoom dialog with a dataZoom slider without refetching", async () => {
		mockMetrics(() => response([reading("cpu.total", [bucket(base - MINUTE, 0.1)])]));
		renderWithI18n(<NodeMetrics nodeId="node-1" />);
		await screen.findByTestId("metrics-plot-cpu");
		const before = mainCalls().length;
		fireEvent.click(screen.getByRole("button", { name: "CPU" }));
		expect(await screen.findByTestId("metrics-zoom-dialog")).toBeInTheDocument();
		const zoomChart = charts.at(-1) as FakeChart;
		const dataZoom = (zoomChart.option as { dataZoom: { type: string }[] }).dataZoom;
		expect(dataZoom.map((entry) => entry.type)).toEqual(["inside", "slider"]);
		expect(mainCalls()).toHaveLength(before);
	});
});

describe("NodeOverviewMetrics", () => {
	test("renders no summary or host charts for a node sampled as reachability only", async () => {
		// An SSH node whose host metrics are unavailable: the read holds only the reachability series,
		// and it does have a bucket. The Overview must not mistake that for host metrics.
		mockMetrics(() => response([reading("up", [bucket(base - MINUTE, 1)])]));
		const client = testQueryClient();
		renderWithI18n(<NodeOverviewMetrics nodeId="node-1" />, "en", client);
		// Wait for the read to settle, not just for the request: the section renders nothing, so the
		// query cache is the only signal that the data reached the component.
		await waitFor(() => expect(client.getQueryState(nodeKeys.metrics("node-1", "1h"))?.status).toBe("success"));
		expect(screen.queryByTestId("node-overview-metrics")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-summary")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-chart-cpu")).not.toBeInTheDocument();
		expect(screen.queryByTestId("metrics-chart-memory")).not.toBeInTheDocument();
	});
});
