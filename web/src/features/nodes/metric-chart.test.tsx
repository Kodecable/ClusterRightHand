import { describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { MetricChart, niceByteAxisMax } from "./metric-chart";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

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

interface LineOption {
	name: string;
	id?: string;
	data: [number, number | null][];
	connectNulls?: boolean;
	stack?: string;
	areaStyle?: { opacity?: number };
}

function lineOptions(chart: FakeChart): LineOption[] {
	return chart.option.series as LineOption[];
}

function tooltipOption(chart: FakeChart): {
	trigger: string;
	formatter: (params: unknown) => string;
} {
	return chart.option.tooltip as { trigger: string; formatter: (params: unknown) => string };
}

describe("niceByteAxisMax", () => {
	test("rounds a 31 GiB capacity up to 8 GiB ticks and a 32 GiB bound", () => {
		expect(niceByteAxisMax(31 * GIB)).toEqual({ max: 32 * GIB, interval: 8 * GIB });
	});

	test("keeps 4–6 ticks with the max at or above the capacity", () => {
		for (const capacity of [1.5 * GIB, 8 * GIB, 31 * GIB, 100 * GIB, 512 * GIB, 744 * GIB, 3.5 * 1024 * GIB]) {
			const { max, interval } = niceByteAxisMax(capacity);
			expect(max).toBeGreaterThanOrEqual(capacity);
			expect(max % interval).toBe(0);
			expect(max / interval + 1).toBeGreaterThanOrEqual(4);
			expect(max / interval + 1).toBeLessThanOrEqual(6);
		}
	});
});

describe("MetricChart", () => {
	test("draws the shared time axis with null gaps and an axis tooltip", () => {
		const times = [Date.UTC(2026, 5, 1, 10, 0), Date.UTC(2026, 5, 1, 10, 5), Date.UTC(2026, 5, 1, 10, 10)];
		renderWithI18n(
			<MetricChart
				times={times}
				series={[
					{ label: "CPU", values: [12.5, null, 45.5] },
					{ label: "Load", values: [1, 2, 3] },
				]}
				unit="percent"
				label="CPU"
			/>,
		);
		const chart = charts.at(-1);
		expect(chart).toBeDefined();
		const lines = lineOptions(chart as FakeChart);
		expect(lines[0]?.name).toBe("CPU");
		expect(lines[0]?.data).toEqual([
			[times[0], 12.5],
			[times[1], null],
			[times[2], 45.5],
		]);
		expect(lines[0]?.connectNulls).toBe(false);
		expect(lines[1]?.data).toEqual([
			[times[0], 1],
			[times[1], 2],
			[times[2], 3],
		]);
		const option = (chart as FakeChart).option;
		expect(option.animation).toBe(false);
		expect(option.legend).toMatchObject({ data: ["CPU", "Load"] });
		expect((option.xAxis as { type: string }).type).toBe("time");
		expect(tooltipOption(chart as FakeChart).trigger).toBe("axis");
		expect(lineOptions(chart as FakeChart)[0]?.name).toBe("CPU");
	});

	test("formats tooltip values in the chart's unit", () => {
		const at = Date.UTC(2026, 5, 1, 10, 0);
		renderWithI18n(
			<MetricChart times={[at]} series={[{ label: "CPU", values: [12.34] }]} unit="percent" label="CPU" />,
		);
		const html = tooltipOption(charts.at(-1) as FakeChart).formatter([
			{ axisValue: at, seriesId: "line-0", seriesName: "CPU", value: [at, 12.34], marker: "<span></span>" },
		]);
		expect(html).toContain("12.3%");
		expect(html).toContain("CPU");
	});

	test("escapes a series name in the tooltip HTML instead of injecting it", () => {
		const at = Date.UTC(2026, 5, 1, 10, 0);
		const name = "<img src=x onerror=alert(1)>";
		renderWithI18n(<MetricChart times={[at]} series={[{ label: name, values: [12.34] }]} unit="percent" label="CPU" />);
		const html = tooltipOption(charts.at(-1) as FakeChart).formatter([
			{ axisValue: at, seriesId: "line-0", seriesName: name, value: [at, 12.34], marker: "<span></span>" },
		]);
		// The name arrives from a node's filesystem; ECharts writes the formatter's result with innerHTML.
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img src=x");
	});

	test("draws a min/max band as a stacked pair behind the line and honours yMax", () => {
		const times = [1, 2];
		renderWithI18n(
			<MetricChart
				times={times}
				series={[{ label: "CPU", values: [10, 20] }]}
				unit="percent"
				label="CPU"
				band={{ label: "CPU", min: [5, 15], max: [15, 25] }}
				yMax={100}
			/>,
		);
		const chart = charts.at(-1) as FakeChart;
		const lines = lineOptions(chart);
		expect(lines).toHaveLength(3);
		expect(lines[1]?.id).toBe("__band_min");
		expect(lines[1]?.data).toEqual([
			[1, 5],
			[2, 15],
		]);
		expect(lines[2]?.id).toBe("__band_max");
		expect(lines[2]?.data).toEqual([
			[1, 10],
			[2, 10],
		]);
		expect(lines[2]?.stack).toBe("metric-band");
		expect(lines[2]?.areaStyle?.opacity).toBe(0.18);
		const yAxis = chart.option.yAxis as { max?: number; interval?: number };
		expect(yAxis.max).toBe(100);
		expect(yAxis.interval).toBeUndefined();
	});

	test("uses a capacity as the exact byte axis max and leaves the ticks to ECharts", () => {
		const capacity = 27.9 * GIB;
		renderWithI18n(
			<MetricChart
				times={[1, 2]}
				series={[{ label: "Used", values: [GIB, 2 * GIB] }]}
				unit="bytes"
				label="Disks"
				yMax={capacity}
			/>,
		);
		const yAxis = (charts.at(-1) as FakeChart).option.yAxis as { max?: number; interval?: number };
		expect(yAxis.max).toBe(capacity);
		expect(yAxis.interval).toBeUndefined();
	});

	test("gives a byte axis without a capacity ticks from the data's own maximum", () => {
		const times = [1, 2, 3];
		renderWithI18n(
			<MetricChart
				times={times}
				series={[
					{ label: "Received", values: [300 * KIB, null, 512 * KIB] },
					{ label: "Sent", values: [200 * KIB, Number.NaN, 100 * KIB] },
				]}
				unit="bytesPerSec"
				label="Network"
				// The band reaches higher than every line; it must not set the scale.
				band={{ label: "Network", min: [0, 0, 0], max: [2 * MIB, 2 * MIB, 2 * MIB] }}
			/>,
		);
		const expected = niceByteAxisMax(512 * KIB);
		expect(expected).toEqual({ max: 512 * KIB, interval: 128 * KIB });
		const yAxis = (charts.at(-1) as FakeChart).option.yAxis as { min?: number; max?: number; interval?: number };
		expect(yAxis).toMatchObject({ min: 0, max: expected.max, interval: expected.interval });

		renderWithI18n(
			<MetricChart times={[1, 2]} series={[{ label: "Used", values: [GIB, 3 * GIB] }]} unit="bytes" label="Disks" />,
		);
		const bytesAxis = (charts.at(-1) as FakeChart).option.yAxis as { max?: number; interval?: number };
		expect(bytesAxis).toMatchObject(niceByteAxisMax(3 * GIB));
	});

	test("keeps a given capacity's exact axis on a rate chart", () => {
		const capacity = 1.5 * MIB;
		renderWithI18n(
			<MetricChart
				times={[1, 2]}
				series={[{ label: "Received", values: [300 * KIB, 512 * KIB] }]}
				unit="bytesPerSec"
				label="Network"
				yMax={capacity}
			/>,
		);
		const yAxis = (charts.at(-1) as FakeChart).option.yAxis as { max?: number; interval?: number };
		// The capacity (and not the 512 KiB the data reaches) bounds the axis, without a rounded max.
		expect(yAxis.max).toBe(capacity);
		expect(yAxis.interval).toBeUndefined();
	});

	test("leaves an empty or all-zero byte chart to ECharts", () => {
		renderWithI18n(
			<MetricChart
				times={[1, 2]}
				series={[{ label: "Received", values: [0, 0] }]}
				unit="bytesPerSec"
				label="Network"
			/>,
		);
		const zero = (charts.at(-1) as FakeChart).option.yAxis as { max?: number; interval?: number };
		expect(zero.max).toBeUndefined();
		expect(zero.interval).toBeUndefined();

		renderWithI18n(
			<MetricChart times={[1, 2]} series={[{ label: "Received", values: [null, null] }]} unit="bytes" label="Disks" />,
		);
		const empty = (charts.at(-1) as FakeChart).option.yAxis as { max?: number; interval?: number };
		expect(empty.max).toBeUndefined();
		expect(empty.interval).toBeUndefined();
	});

	test("adds the inside and slider dataZoom only when zoom is requested", () => {
		renderWithI18n(
			<MetricChart times={[1, 2]} series={[{ label: "CPU", values: [10, 20] }]} unit="percent" label="CPU" />,
		);
		const inline = charts.at(-1) as FakeChart;
		expect((inline.option as { dataZoom?: unknown }).dataZoom).toBeUndefined();

		renderWithI18n(
			<MetricChart times={[1, 2]} series={[{ label: "CPU", values: [10, 20] }]} unit="percent" label="CPU" zoom />,
		);
		const zoomed = charts.at(-1) as FakeChart;
		const dataZoom = (zoomed.option as { dataZoom: { type: string }[] }).dataZoom;
		expect(dataZoom.map((entry) => entry.type)).toEqual(["inside", "slider"]);
	});

	test("disposes the chart on unmount", () => {
		const view = renderWithI18n(
			<MetricChart times={[1]} series={[{ label: "CPU", values: [10] }]} unit="percent" label="CPU" />,
		);
		const chart = charts.at(-1) as FakeChart;
		expect(chart.disposed).toBe(false);
		view.unmount();
		expect(chart.disposed).toBe(true);
	});
});
