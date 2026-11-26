import { useLingui } from "@lingui/react/macro";
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { escapeHtml, formatBytes, formatDateTimeSeconds, formatNumber } from "@/lib/format";
import { useTheme } from "@/lib/theme";

// ECharts is imported on demand (doc/design/webui.md "Node pages"): only the chart type, the components the
// node metrics charts use and the canvas renderer go into the lazy chunk that the Metrics tab loads.
echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

/**
 * How a chart's values are formatted (doc/design/webui.md "Node pages"). The Metrics tab picks one per
 * chart: CPU is a ratio shown as a percentage, memory and filesystems are bytes, network is bytes per
 * second, and load is a plain number.
 */
export type MetricChartUnit = "percent" | "bytes" | "bytesPerSec" | "load" | "number";

/** One line of a chart: its legend label and one value per entry in `times` (null makes a gap). */
export interface MetricChartSeries {
	label: string;
	values: (number | null)[];
}

/** A filled band between two extra series, for a gauge's minimum and maximum. */
export interface MetricChartBand {
	label: string;
	min: (number | null)[];
	max: (number | null)[];
}

export interface MetricChartProps {
	/** The x values, Unix epoch milliseconds, ascending and without duplicates. */
	times: number[];
	series: MetricChartSeries[];
	unit: MetricChartUnit;
	/** A translated accessible name for the chart. */
	label: string;
	height?: number;
	/** Draw min/max as a band behind the first line, e.g. CPU's bucket minimum and maximum. */
	band?: MetricChartBand;
	/** A fixed y-axis upper bound, e.g. 100 for CPU or a filesystem's capacity; used exactly as the axis max. */
	yMax?: number;
	/** Draw the dataZoom slider; the zoom dialog uses it, the inline card does not. */
	zoom?: boolean;
	testId?: string;
}

const CHART_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];
const FALLBACK_COLORS = ["#2554d6", "#1b7f3b", "#a66200", "#7a5af8", "#c62828"];

/** A computed CSS token, or its fallback when the theme has not loaded yet (jsdom, first paint). */
function tokenColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
	return styles.getPropertyValue(name).trim() || fallback;
}

/** A value in the chart's unit, as the axis labels and the tooltip show it. */
export function formatMetricValue(value: number | null | undefined, unit: MetricChartUnit, locale: string): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "–";
	switch (unit) {
		case "percent":
			return `${formatNumber(value, locale, { maximumFractionDigits: 1 })}%`;
		case "bytes":
			return formatBytes(value, locale);
		case "bytesPerSec":
			return `${formatBytes(value, locale)}/s`;
		case "load":
			return formatNumber(value, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		case "number":
			return formatNumber(value, locale, { maximumFractionDigits: 2 });
	}
}

/**
 * The binary counterpart of the familiar 1, 2, 2.5, 5 axis steps: the candidates are 1, 2, 2.5 and
 * 5 × 2^k bytes, which normalize to 1, 1.25, 2 and 2.5 × 2^k and keep the same factors at every binary
 * order. A grid of only 1024^k steps would jump by 1024 between candidates and cannot give about five
 * ticks for every capacity; this one stays on round binary sizes (8 GiB is 2^33 bytes).
 */
const NICE_BYTE_FACTORS = [1, 1.25, 2, 2.5] as const;

/** Aim for five intervals, which leaves 5–6 ticks however the capacity falls between two intervals. */
const TARGET_BYTE_INTERVALS = 5;

/** The smallest nice byte interval at least `target` bytes. */
export function niceByteInterval(target: number): number {
	if (!(target > 0)) return 1;
	const exponent = Math.floor(Math.log2(target));
	let interval = Number.POSITIVE_INFINITY;
	for (const power of [exponent, exponent + 1]) {
		for (const factor of NICE_BYTE_FACTORS) {
			const candidate = factor * 2 ** power;
			if (candidate >= target && candidate < interval) interval = candidate;
		}
	}
	return Math.max(1, Math.ceil(interval));
}

/**
 * The y-axis bounds of a byte chart with a capacity: a nice interval and the capacity rounded up to a
 * multiple of it, so a 31 GiB capacity reads 0, 8 GiB, 16 GiB, 24 GiB, 32 GiB instead of an even split of
 * the raw capacity. The axis max is never below the capacity.
 */
export function niceByteAxisMax(capacity: number): { max: number; interval: number } {
	if (!Number.isFinite(capacity) || capacity <= 0) return { max: 0, interval: 1 };
	const interval = niceByteInterval(capacity / TARGET_BYTE_INTERVALS);
	return { max: Math.ceil(capacity / interval) * interval, interval };
}

/** The largest finite value across the plotted lines, or undefined when no line has one. */
function seriesDataMax(series: readonly MetricChartSeries[]): number | undefined {
	let dataMax: number | undefined;
	for (const entry of series) {
		for (const value of entry.values) {
			if (value === null || !Number.isFinite(value)) continue;
			if (dataMax === undefined || value > dataMax) dataMax = value;
		}
	}
	return dataMax;
}

/** A time label in the interface language and the browser's time zone, at the span's natural precision. */
function timeLabel(value: number, spanMs: number, locale: string): string {
	const date = new Date(value);
	if (spanMs <= 5 * 60_000) {
		return new Intl.DateTimeFormat(locale, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).format(date);
	}
	if (spanMs <= 2 * 24 * 60 * 60_000) {
		return new Intl.DateTimeFormat(locale, {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(date);
	}
	if (spanMs <= 60 * 24 * 60 * 60_000) {
		return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit" }).format(date);
	}
	return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

interface TooltipEntry {
	axisValue?: unknown;
	seriesId?: string;
	seriesName?: string;
	value?: unknown;
	marker?: string;
}

/**
 * A `echarts` wrapper for one node metric chart (doc/design/webui.md "Node pages"): a time axis in the
 * interface language and the browser's time zone, gaps where a bucket is missing, a legend that toggles
 * each line, an axis tooltip that formats every value in the chart's unit, and theme colours read from the
 * design tokens. The chart resizes with its container and is disposed on unmount; an optional zoom adds the
 * slider the large dialog uses, which only re-frames the loaded data.
 */
export function MetricChart({
	times,
	series,
	unit,
	label,
	height = 160,
	band,
	yMax,
	zoom = false,
	testId,
}: MetricChartProps) {
	const { i18n } = useLingui();
	const { resolved } = useTheme();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const chartRef = useRef<EChartsType | null>(null);
	const locale = i18n.locale;
	const spanMs = (times[times.length - 1] ?? 0) - (times[0] ?? 0);

	// One instance for the component's life: changes only replace its option, so a 30 s refresh does not
	// rebuild the canvas and a theme switch recolours it at once.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const chart = echarts.init(container);
		chartRef.current = chart;
		const observer =
			typeof ResizeObserver === "undefined"
				? undefined
				: new ResizeObserver(() => {
						chart.resize();
					});
		observer?.observe(container);
		return () => {
			observer?.disconnect();
			chart.dispose();
			chartRef.current = null;
		};
	}, []);

	useEffect(() => {
		const chart = chartRef.current;
		if (!chart) return;
		// The resolved theme is not read directly: the tokens it selects are, and naming it here makes a
		// theme switch rebuild the option with the other palette's colours.
		void resolved;
		const styles = getComputedStyle(document.documentElement);
		const colors = CHART_COLORS.map((name, index) => tokenColor(styles, name, FALLBACK_COLORS[index] ?? "#2554d6"));
		const foreground = tokenColor(styles, "--muted-foreground", "#667085");
		const border = tokenColor(styles, "--border", "#d8dde4");
		const background = tokenColor(styles, "--popover", "#ffffff");
		const seriesColors = series.map((_entry, index) => colors[index % colors.length] as string);
		const bandColor = seriesColors[0] ?? FALLBACK_COLORS[0] ?? "#2554d6";
		const format = (value: number | null | undefined) => formatMetricValue(value, unit, locale);
		// Without a capacity, a byte axis is bounded by the largest plotted value, so rates read
		// 0/128/256/384/512 KiB/s rather than ECharts's decimal steps. A capacity given as `yMax` is used
		// exactly as the axis max, and ECharts chooses the ticks: rounding it up would hide the real
		// headroom. An empty or all-zero chart has no positive value to round, and keeps letting ECharts
		// choose its own ticks.
		const byteUnit = unit === "bytes" || unit === "bytesPerSec";
		const dataMax = byteUnit && yMax === undefined ? seriesDataMax(series) : undefined;
		const byteAxis = dataMax !== undefined && dataMax > 0 ? niceByteAxisMax(dataMax) : undefined;

		const tooltip = (raw: unknown): string => {
			const entries = (Array.isArray(raw) ? raw : [raw]) as TooltipEntry[];
			const first = entries[0];
			const at = Number(first?.axisValue);
			const header = formatDateTimeSeconds(Number.isFinite(at) ? at : times[0], locale);
			const lines = entries
				.filter((entry) => entry.seriesId !== "__band_min" && entry.seriesId !== "__band_max")
				.map((entry) => {
					const value = Array.isArray(entry.value) ? entry.value[1] : entry.value;
					const numeric =
						typeof value === "number" ? value : value === undefined || value === null ? null : Number(value);
					// ECharts writes the formatter's result with innerHTML, and a series name can come from a
					// node's filesystem (doc/design/metrics.md "Limits"), so every text is escaped.
					const name = escapeHtml(entry.seriesName ?? "");
					const label = escapeHtml(format(Number.isFinite(numeric) ? numeric : null));
					return `<div style="display:flex;align-items:center;gap:6px;line-height:1.6">${entry.marker ?? ""}<span>${name}</span><span style="margin-left:auto;padding-left:12px;font-variant-numeric:tabular-nums">${label}</span></div>`;
				});
			return `<div style="font-weight:500;margin-bottom:2px">${escapeHtml(header)}</div>${lines.join("")}`;
		};

		const lineSeries = series.map((entry, index) => ({
			id: `line-${index}`,
			name: entry.label,
			type: "line" as const,
			data: times.map((time, point) => [time, entry.values[point] ?? null]),
			showSymbol: false,
			symbol: "none",
			connectNulls: false,
			lineStyle: { width: 1.5 },
			itemStyle: { color: seriesColors[index] },
			emphasis: { focus: "series" as const },
			z: 3,
		}));

		const bandSeries = [];
		if (band !== undefined) {
			// A stacked pair draws the band: the invisible minimum is the baseline and the visible maximum
			// carries the difference, so the filled area spans min..max at every bucket and a missing bucket
			// stays a gap.
			const min = band.min.map((value, index) => [times[index], value]);
			const span = band.max.map((value, index) => {
				const low = band.min[index];
				return [
					times[index],
					value === null || value === undefined || low === null || low === undefined ? null : value - low,
				];
			});
			bandSeries.push(
				{
					id: "__band_min",
					name: "__band_min",
					type: "line" as const,
					data: min,
					stack: "metric-band",
					showSymbol: false,
					symbol: "none",
					silent: true,
					connectNulls: false,
					lineStyle: { opacity: 0 },
					areaStyle: { opacity: 0 },
					z: 1,
				},
				{
					id: "__band_max",
					name: "__band_max",
					type: "line" as const,
					data: span,
					stack: "metric-band",
					showSymbol: false,
					symbol: "none",
					silent: true,
					connectNulls: false,
					lineStyle: { opacity: 0 },
					areaStyle: { color: bandColor, opacity: 0.18 },
					z: 1,
				},
			);
		}

		const option: EChartsCoreOption = {
			animation: false,
			textStyle: { color: foreground, fontSize: 11 },
			color: seriesColors,
			grid: {
				left: 8,
				right: 16,
				top: series.length > 0 ? 30 : 12,
				bottom: zoom ? 64 : 4,
				containLabel: true,
			},
			legend:
				series.length === 0
					? undefined
					: {
							top: 0,
							left: 0,
							icon: "roundRect",
							itemWidth: 10,
							itemHeight: 10,
							textStyle: { color: foreground, fontSize: 11 },
							data: series.map((entry) => entry.label),
						},
			tooltip:
				series.length === 0
					? undefined
					: {
							trigger: "axis",
							axisPointer: { type: "line", lineStyle: { color: border } },
							backgroundColor: background,
							borderColor: border,
							textStyle: { color: foreground, fontSize: 11 },
							formatter: tooltip,
						},
			xAxis: {
				type: "time",
				boundaryGap: false,
				splitNumber: 5,
				axisLine: { lineStyle: { color: border } },
				axisTick: { lineStyle: { color: border } },
				axisLabel: {
					color: foreground,
					fontSize: 10,
					hideOverlap: true,
					formatter: (value: number) => timeLabel(value, spanMs, locale),
				},
				splitLine: { show: false },
			},
			yAxis: {
				type: "value",
				min: 0,
				...(byteAxis !== undefined
					? { max: byteAxis.max, interval: byteAxis.interval }
					: yMax === undefined
						? {}
						: { max: yMax }),
				axisLine: { show: false },
				axisTick: { show: false },
				axisLabel: {
					color: foreground,
					fontSize: 10,
					formatter: (value: number) => format(value),
				},
				splitLine: { lineStyle: { color: border, opacity: 0.6 } },
			},
			dataZoom: zoom
				? [
						{
							type: "inside",
							xAxisIndex: 0,
							filterMode: "none",
							zoomOnMouseWheel: true,
							moveOnMouseMove: true,
							moveOnMouseWheel: false,
						},
						{
							type: "slider",
							xAxisIndex: 0,
							filterMode: "none",
							height: 26,
							bottom: 6,
							start: 0,
							end: 100,
							borderColor: border,
							fillerColor: `${bandColor}22`,
							backgroundColor: "transparent",
							handleStyle: { color: foreground },
							textStyle: { color: foreground, fontSize: 10 },
							labelFormatter: (value: number) => formatDateTimeSeconds(value, locale),
						},
					]
				: undefined,
			series: [...lineSeries, ...bandSeries],
		};
		chart.setOption(option, { notMerge: true });
	}, [band, locale, resolved, series, spanMs, times, unit, yMax, zoom]);

	return (
		<div
			ref={containerRef}
			role="img"
			aria-label={label}
			className="min-w-0 w-full"
			style={{ height }}
			data-testid={testId}
			data-metric-chart={unit}
		/>
	);
}
