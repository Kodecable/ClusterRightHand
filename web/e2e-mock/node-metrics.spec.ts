import { expect, test } from "@playwright/test";
import { login, mockApi, nodeMetricsResponse, nodeView } from "./helpers";

/**
 * The Overview's CPU and memory cards and the Metrics tab mount ECharts, which jsdom cannot exercise. This
 * spec runs the real browser and checks that the summary, the charts, the network traffic footer, the
 * availability strip and the zoom dialog actually render (doc/design/webui.md "Node pages").
 */
test("the node page renders the summary and charts on the Overview, and charts in the Metrics tab", async ({
	page,
}) => {
	const api = await mockApi(page, {
		state: {
			nodes: [
				nodeView({
					metrics: { at: new Date().toISOString(), up: 1, cpu: 0.42, memUsed: 0.17, stale: false },
				}),
			],
			nodeMetrics: { "node-1": nodeMetricsResponse() },
		},
	});
	await login(page);
	await page.goto("/nodes");
	await page.getByRole("link", { name: "worker-01", exact: true }).click();
	await expect(page.getByTestId("node-detail")).toBeVisible();

	// The summary and the CPU and memory cards head the Overview, below the facts and above access.
	await expect(page.getByTestId("metrics-summary")).toBeVisible();
	const summary = page.getByTestId("metrics-summary");
	await expect(summary).not.toContainText("GiB /");
	await expect(summary).not.toContainText("Resets every 30 days");
	await expect(page.getByTestId("metrics-summary-uptime")).toContainText("Uptime");
	await expect(page.getByTestId("metrics-summary-uptime")).toContainText("2h 00m");
	await expect(page.getByTestId("metrics-summary-cpu")).toContainText("%");
	await expect(page.getByTestId("metrics-summary-memory")).toContainText("63%");
	const disk = page.getByTestId("metrics-summary-filesystem");
	await expect(disk).toContainText("Disk usage");
	await expect(disk).toContainText("20%");
	await expect(disk).toHaveAttribute("title", "root");
	const liveTraffic = page.getByTestId("metrics-summary-traffic");
	await expect(liveTraffic).toContainText("2 KiB / 1 KiB");
	await expect(liveTraffic.locator(".lucide-arrow-down")).toHaveCount(1);
	await expect(liveTraffic.locator(".lucide-arrow-up")).toHaveCount(1);
	await expect(liveTraffic.getByTitle("Received 2 KiB/s, sent 1 KiB/s")).toHaveAttribute(
		"aria-label",
		"Received 2 KiB/s, sent 1 KiB/s",
	);
	await expect(page.getByTestId("metrics-chart-cpu").locator("canvas")).toBeVisible();
	await expect(page.getByTestId("metrics-chart-memory").locator("canvas")).toBeVisible();
	// The Overview has no range picker; it always uses the Metrics tab's 1-hour default.
	await expect(page.getByRole("toolbar", { name: "Time range" })).toHaveCount(0);

	// A crash in ECharts or the card would show the shared error state instead of the charts.
	await expect(page.getByText("Something went wrong")).toHaveCount(0);

	// The Overview card's expand button opens the same chart in the zoom dialog.
	await page.getByTestId("metrics-chart-cpu").getByRole("button", { name: "CPU" }).click();
	const overviewZoom = page.getByTestId("metrics-zoom-dialog");
	await expect(overviewZoom).toBeVisible();
	await expect(overviewZoom.locator("canvas")).toBeVisible();
	await page.keyboard.press("Escape");

	await page.getByRole("tab", { name: "Metrics" }).click();
	await expect(page.getByTestId("node-metrics")).toBeVisible();
	// The summary moved to the Overview rather than being copied: the Metrics tab has no summary.
	await expect(page.getByTestId("metrics-summary")).toHaveCount(0);
	await expect(page.getByTestId("node-overview-metrics")).toHaveCount(0);
	await expect(page.getByTestId("metrics-plot-cpu").locator("canvas")).toBeVisible();
	await expect(page.getByTestId("availability-strip")).toBeVisible();
	await expect(page.getByTestId("availability-bar").first()).toBeVisible();

	// The totals belong to the Network card, below its chart, and only in the Metrics tab.
	const network = page.getByTestId("metrics-chart-network");
	const traffic = network.getByTestId("metrics-network-traffic");
	await expect(traffic).toContainText("Total");
	await expect(traffic).toContainText("1.2 GiB");
	await expect(traffic).toContainText("567 MiB");
	await expect(traffic).toContainText("Since");
	await expect(traffic).toContainText("Next reset");
	await expect(traffic).toContainText("Resets every 30 days");
	await expect(traffic.getByRole("button", { name: "Set next reset" })).toBeVisible();

	// The availability card is about availability, not a time range, and its newest bar is the current UTC day.
	const availability = page.getByTestId("metrics-chart-availability");
	await expect(availability.getByRole("heading", { name: "Availability" })).toHaveText("Availability");
	const newestBar = page.getByTestId("availability-bar").last();
	const newestTitle = await newestBar.getAttribute("title");
	const utcDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
		new Date(),
	);
	expect(newestTitle).toContain(utcDay);
	expect(newestTitle).toContain("UTC");
	expect(newestTitle).not.toContain("–");

	// Administrators can reset the period from the traffic footer; the fake server updates what the
	// invalidated metrics read then shows.
	await traffic.getByRole("button", { name: "Reset now" }).click();
	const confirm = page.getByRole("dialog");
	await expect(confirm).toContainText("Reset traffic now?");
	await confirm.getByRole("button", { name: "Reset now" }).click();
	await expect(traffic).toContainText("0 B / 0 B");
	expect(api.state.requests.some((request) => request.url.endsWith("/traffic/reset"))).toBe(true);
});

test("the Network card keeps only its footer when the node has no rate series", async ({ page }) => {
	const base = nodeMetricsResponse();
	const series = base.series.filter((reading) => !reading.name.startsWith("net."));
	const api = await mockApi(page, {
		state: {
			nodes: [
				nodeView({
					metrics: { at: new Date().toISOString(), up: 1, cpu: 0.42, memUsed: 0.17, stale: false },
				}),
			],
			nodeMetrics: { "node-1": nodeMetricsResponse({ series }) },
		},
	});
	await login(page);
	await page.goto("/nodes");
	await page.getByRole("link", { name: "worker-01", exact: true }).click();
	// The summary is on the Overview now; its traffic card shows a dash without rate series.
	await expect(page.getByTestId("metrics-summary-traffic")).toContainText("–");
	await page.getByRole("tab", { name: "Metrics" }).click();

	const network = page.getByTestId("metrics-chart-network");
	await expect(network.getByRole("heading", { name: "Network" })).toBeVisible();
	await expect(network.getByTestId("metrics-network-traffic")).toContainText("Total");
	await expect(network.locator("canvas")).toHaveCount(0);
	await expect(network.getByText("No data in this range.")).toHaveCount(0);
	expect(api.state.nodeMetrics["node-1"]?.series.some((reading) => reading.name.startsWith("net."))).toBe(false);
});

test("omits the traffic footer when the node has no traffic period", async ({ page }) => {
	await mockApi(page, {
		state: {
			nodes: [
				nodeView({
					metrics: { at: new Date().toISOString(), up: 1, cpu: 0.42, memUsed: 0.17, stale: false },
				}),
			],
			nodeMetrics: { "node-1": nodeMetricsResponse({ traffic: null }) },
		},
	});
	await login(page);
	await page.goto("/nodes");
	await page.getByRole("link", { name: "worker-01", exact: true }).click();
	await page.getByRole("tab", { name: "Metrics" }).click();

	await expect(page.getByTestId("metrics-chart-network")).toBeVisible();
	await expect(page.getByTestId("metrics-network-traffic")).toHaveCount(0);
});
