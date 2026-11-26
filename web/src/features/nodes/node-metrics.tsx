import {
	firstFilesystem,
	type MetricBucketPoint,
	type MetricSeriesReading,
	type NodeMetricsResponse,
	type NodeTraffic,
} from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowDownIcon, ArrowUpIcon, MaximizeIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { EmptyHint, EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Panel } from "@/components/section";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes, formatDuration, formatShortDateTime } from "@/lib/format";
import { useAuth } from "@/lib/session";
import { formatZonedDateTime } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { METRICS_RANGE_MS, type MetricsRange, useNodeAvailability, useNodeMetrics } from "./api";
import { AvailabilityStrip, buildAvailabilityDays } from "./availability-strip";
import { MetricChart, type MetricChartBand, type MetricChartSeries, type MetricChartUnit } from "./metric-chart";
import { LiveTraffic } from "./node-traffic";
import { UsageBar } from "./node-usage";
import { TrafficNextResetDialog, TrafficResetDialog } from "./traffic-dialogs";

interface RangeOption {
	value: MetricsRange;
	label: MessageDescriptor;
}

const RANGE_OPTIONS: RangeOption[] = [
	{ value: "1h", label: msg`1 hour` },
	{ value: "24h", label: msg`24 hours` },
	{ value: "7d", label: msg`7 days` },
	{ value: "30d", label: msg`30 days` },
	{ value: "365d", label: msg`365 days` },
];

const AVAILABILITY_DAYS: { value: number; label: MessageDescriptor }[] = [
	{ value: 30, label: msg`30 days` },
	{ value: 90, label: msg`90 days` },
	{ value: 365, label: msg`365 days` },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** One chart card of the tab: its lines, optional band, y bound and whether it has anything to draw. */
interface MetricsChartView {
	key: string;
	title: string;
	unit: MetricChartUnit;
	times: number[];
	lines: MetricChartSeries[];
	band?: MetricChartBand;
	yMax?: number;
	full?: boolean;
	empty: boolean;
	/** No chart body at all: the card is its heading and (for network) the traffic footer. */
	chartless?: boolean;
}

/**
 * One of the five summary cards above the charts (doc/design/webui.md "Node pages"): a translated label,
 * either a formatted value or a usage percentage drawn with the shared bar, and only a hover title for
 * context that must not be visible text (the filesystem's name).
 */
interface SummaryItem {
	key: "uptime" | "cpu" | "memory" | "filesystem" | "traffic";
	label: string;
	value?: ReactNode;
	/** 0–100 for the three usage cards; the bar and its threshold colour are shared with the node list. */
	percent?: number;
	/** Hover text only, e.g. the filesystem the disk card describes. */
	title?: string;
}

/**
 * The WebUI never sends `fields`, so every non-`t` bucket value is present in its responses. The API
 * schema marks them optional because an agent may ask for a subset (doc/design/metrics.md "Reading").
 */
type FullMetricBucket = Required<MetricBucketPoint>;

/** The buckets of a series, with every field present. */
function bucketsOf(reading: MetricSeriesReading | undefined): FullMetricBucket[] {
	return (reading?.buckets ?? []) as FullMetricBucket[];
}

/** A bucket by its start, for one series. */
function bucketMap(reading: MetricSeriesReading | undefined): Map<number, FullMetricBucket> {
	return new Map(bucketsOf(reading).map((bucket) => [bucket.t, bucket]));
}

/**
 * The window's bucket starts, aligned to the level's width. The full grid, not just the buckets the series
 * happen to have, is what turns a missing bucket into a `null` point the chart can break at, instead of a
 * line straight across the gap.
 */
function timesOf(
	readings: readonly (MetricSeriesReading | undefined)[],
	bucketMs: number,
	fromMs: number,
	toMs: number,
): number[] {
	const observed = readings.flatMap((reading) => reading?.buckets ?? []);
	if (observed.length === 0) return [];
	const width = bucketMs > 0 ? bucketMs : (observed[1]?.t ?? 0) - (observed[0]?.t ?? 0);
	if (width <= 0) return [...new Set(observed.map((bucket) => bucket.t))].sort((left, right) => left - right);
	const first = Math.floor(fromMs / width) * width;
	const last = Math.floor(toMs / width) * width;
	const times: number[] = [];
	for (let t = first; t <= last; t += width) times.push(t);
	return times;
}

/** The newest bucket of a series, or undefined when it has none in the selected range. */
function latestBucket(reading: MetricSeriesReading | undefined): FullMetricBucket | undefined {
	return bucketsOf(reading).at(-1);
}

/** The largest single observed value in the window, e.g. the memory a node had installed. */
function windowMax(reading: MetricSeriesReading | undefined): number | undefined {
	const buckets = bucketsOf(reading);
	if (buckets.length === 0) return undefined;
	let max = buckets[0]?.max ?? 0;
	for (const bucket of buckets) if (bucket.max > max) max = bucket.max;
	return max;
}

/** One line over the chart's shared x axis; a bucket a series does not have is a gap. */
function line(
	label: string,
	times: readonly number[],
	reading: MetricSeriesReading | undefined,
	value: (bucket: FullMetricBucket) => number,
): MetricChartSeries {
	const buckets = bucketMap(reading);
	return {
		label,
		values: times.map((time) => {
			const bucket = buckets.get(time);
			return bucket === undefined ? null : value(bucket);
		}),
	};
}

/** A filesystem's name from `disk.<name>.total_bytes` / `disk.<name>.used_bytes` (doc/design/metrics.md "Metrics"). */
function filesystemOf(name: string): { name: string; kind: "total_bytes" | "used_bytes" } | undefined {
	const match = /^disk\.(.+)\.(total_bytes|used_bytes)$/.exec(name);
	if (!match) return undefined;
	return { name: match[1] as string, kind: match[2] as "total_bytes" | "used_bytes" };
}

/** At least one line has a value, so the card draws a chart instead of its empty state. */
function hasValues(lines: readonly MetricChartSeries[]): boolean {
	return lines.some((entry) => entry.values.some((value) => value !== null));
}

/** The latest value of a series, or undefined when the window has no bucket for it. */
function latestValue(byName: ReadonlyMap<string, MetricSeriesReading>, name: string): number | undefined {
	return latestBucket(byName.get(name))?.last;
}

/**
 * The five summary cards above the charts (doc/design/webui.md "Node pages"), from the newest sample:
 * uptime, CPU and memory usage, the first filesystem's usage and the live network rates. A figure the node
 * has no data for shows "–", because a missing value is not zero (doc/design/metrics.md "Metrics"). The
 * filesystem's name is only a tooltip; the traffic totals live in the Network card, not here.
 */
function buildSummary(data: NodeMetricsResponse, i18n: I18n): SummaryItem[] {
	const byName = new Map(data.series.map((reading) => [reading.name, reading]));
	const items: SummaryItem[] = [];

	const uptime = latestValue(byName, "uptime");
	items.push({
		key: "uptime",
		label: i18n._(msg`Uptime`),
		value: uptime === undefined ? "–" : formatDuration(uptime * 1000, i18n.locale),
	});

	const cpu = latestValue(byName, "cpu.total");
	items.push({
		key: "cpu",
		label: i18n._(msg`CPU usage`),
		value: "–",
		...(cpu === undefined ? {} : { percent: Math.max(0, Math.min(1, cpu)) * 100 }),
	});

	const memTotal = latestValue(byName, "mem.total_bytes");
	const memAvailable = latestValue(byName, "mem.available_bytes");
	const memory =
		memTotal !== undefined && memAvailable !== undefined && memTotal > 0
			? { total: memTotal, used: Math.max(0, memTotal - memAvailable) }
			: undefined;
	items.push({
		key: "memory",
		label: i18n._(msg`Memory usage`),
		value: "–",
		...(memory === undefined ? {} : { percent: (memory.used / memory.total) * 100 }),
	});

	const filesystems = new Map<string, { used?: number; total?: number }>();
	for (const reading of data.series) {
		const parsed = filesystemOf(reading.name);
		if (parsed === undefined) continue;
		const value = latestBucket(reading)?.last;
		if (value === undefined) continue;
		const entry = filesystems.get(parsed.name) ?? {};
		entry[parsed.kind === "total_bytes" ? "total" : "used"] = value;
		filesystems.set(parsed.name, entry);
	}
	// The same rule and order as the node list's first filesystem: report order, then `root`, then code-unit
	// order among the filesystems that have both values (doc/design/metrics.md "Reading").
	const complete = new Set(
		[...filesystems]
			.filter(([, entry]) => entry.used !== undefined && entry.total !== undefined && entry.total > 0)
			.map(([name]) => name),
	);
	const filesystemName = firstFilesystem(complete, data.diskOrder);
	const filesystem = filesystemName === undefined ? undefined : filesystems.get(filesystemName);
	const filesystemUsage =
		filesystem?.used !== undefined && filesystem.total !== undefined && filesystem.total > 0
			? { used: filesystem.used, total: filesystem.total }
			: undefined;
	items.push({
		key: "filesystem",
		label: i18n._(msg`Disk usage`),
		value: "–",
		...(filesystemUsage === undefined ? {} : { percent: (filesystemUsage.used / filesystemUsage.total) * 100 }),
		...(filesystemName === undefined ? {} : { title: filesystemName }),
	});

	// The newest rates, not the period totals; the card shapes them with the node list's live-traffic row
	// (doc/design/webui.md "Node pages").
	const rx = latestValue(byName, "net.rx_bytes_per_sec");
	const tx = latestValue(byName, "net.tx_bytes_per_sec");
	items.push({
		key: "traffic",
		label: i18n._(msg`Live traffic`),
		value: <LiveTraffic rxBytesPerSec={rx} txBytesPerSec={tx} />,
	});
	return items;
}

/**
 * Builds the tab's charts from one read (doc/design/webui.md "Node pages"): CPU with its min/max band, load,
 * memory (used, cached and free, bounded by the window's memory total), swap (used, bounded by its total),
 * one disks chart for every filesystem, and the network rates. A series that has no bucket in the range
 * leaves an empty card, not an empty chart; a card whose series the node does not have at all is omitted,
 * except the Network card, which stays for a traffic period that has no rate series yet.
 */
function buildCharts(data: NodeMetricsResponse, i18n: I18n, fromMs: number, toMs: number): MetricsChartView[] {
	const byName = new Map(data.series.map((reading) => [reading.name, reading]));
	const charts: MetricsChartView[] = [];

	const cpu = byName.get("cpu.total");
	if (cpu !== undefined) {
		const title = i18n._(msg`CPU`);
		const times = timesOf([cpu], data.bucketMs, fromMs, toMs);
		const lines = times.length === 0 ? [] : [line(title, times, cpu, (bucket) => bucket.avg * 100)];
		charts.push({
			key: "cpu",
			title,
			unit: "percent",
			times,
			yMax: 100,
			lines,
			empty: !hasValues(lines),
			band:
				lines.length === 0
					? undefined
					: {
							label: title,
							min: line(title, times, cpu, (bucket) => bucket.min * 100).values,
							max: line(title, times, cpu, (bucket) => bucket.max * 100).values,
						},
		});
	}

	const loads = [
		{ name: "load.1", label: i18n._(msg`1 minute`) },
		{ name: "load.5", label: i18n._(msg`5 minutes`) },
		{ name: "load.15", label: i18n._(msg`15 minutes`) },
	].flatMap((entry) => {
		const reading = byName.get(entry.name);
		return reading === undefined ? [] : [{ reading, label: entry.label }];
	});
	if (loads.length > 0) {
		const times = timesOf(
			loads.map((entry) => entry.reading),
			data.bucketMs,
			fromMs,
			toMs,
		);
		const lines = loads.map((entry) => line(entry.label, times, entry.reading, (bucket) => bucket.avg));
		charts.push({
			key: "load",
			title: i18n._(msg`Load`),
			unit: "load",
			times,
			lines,
			empty: !hasValues(lines),
		});
	}

	const memTotal = byName.get("mem.total_bytes");
	const memAvailable = byName.get("mem.available_bytes");
	const memCached = byName.get("mem.cached_bytes");
	const memFree = byName.get("mem.free_bytes");
	if (memTotal !== undefined || memAvailable !== undefined || memCached !== undefined || memFree !== undefined) {
		const times = timesOf([memTotal, memAvailable, memCached, memFree], data.bucketMs, fromMs, toMs);
		const totalBuckets = bucketMap(memTotal);
		const availableBuckets = bucketMap(memAvailable);
		const lines: MetricChartSeries[] = [];
		if (memTotal !== undefined && memAvailable !== undefined) {
			lines.push({
				label: i18n._(msg`Used`),
				values: times.map((time) => {
					const total = totalBuckets.get(time);
					const available = availableBuckets.get(time);
					return total === undefined || available === undefined ? null : total.avg - available.avg;
				}),
			});
		}
		if (memCached !== undefined) {
			lines.push(line(i18n._(msg`Cached`), times, memCached, (bucket) => bucket.avg));
		}
		if (memFree !== undefined) {
			lines.push(line(i18n._(msg`Free`), times, memFree, (bucket) => bucket.avg));
		}
		charts.push({
			key: "memory",
			title: i18n._(msg`Memory`),
			unit: "bytes",
			times,
			yMax: windowMax(memTotal),
			lines,
			empty: !hasValues(lines),
		});
	}

	const swapTotal = byName.get("swap.total_bytes");
	const swapFree = byName.get("swap.free_bytes");
	const swapCapacity = latestBucket(swapTotal)?.last;
	// Swap is absent on many nodes; a zero capacity has nothing to plot, so the card disappears.
	if (swapTotal !== undefined && swapFree !== undefined && swapCapacity !== undefined && swapCapacity > 0) {
		const times = timesOf([swapTotal, swapFree], data.bucketMs, fromMs, toMs);
		const totalBuckets = bucketMap(swapTotal);
		const freeBuckets = bucketMap(swapFree);
		const lines = [
			{
				label: i18n._(msg`Used`),
				values: times.map((time) => {
					const total = totalBuckets.get(time);
					const free = freeBuckets.get(time);
					return total === undefined || free === undefined ? null : total.avg - free.avg;
				}),
			},
		];
		charts.push({
			key: "swap",
			title: i18n._(msg`Swap`),
			unit: "bytes",
			times,
			yMax: swapCapacity,
			lines,
			empty: !hasValues(lines),
		});
	}

	const filesystems = new Map<string, { total?: MetricSeriesReading; used?: MetricSeriesReading }>();
	for (const reading of data.series) {
		const parsed = filesystemOf(reading.name);
		if (parsed === undefined) continue;
		const entry = filesystems.get(parsed.name) ?? {};
		entry[parsed.kind === "total_bytes" ? "total" : "used"] = reading;
		filesystems.set(parsed.name, entry);
	}
	// The chart follows the report order when the collector still knows it, so the lines match the
	// summary card and the node's own configuration; names the sample dropped sort after them.
	const diskRank = new Map((data.diskOrder ?? []).map((name, index) => [name, index]));
	const byDiskOrder = ([left]: [string, unknown], [right]: [string, unknown]): number => {
		const leftRank = diskRank.get(left);
		const rightRank = diskRank.get(right);
		if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
		if (leftRank !== undefined) return -1;
		if (rightRank !== undefined) return 1;
		return left.localeCompare(right);
	};
	const usedFilesystems = [...filesystems.entries()]
		.filter((entry): entry is [string, { used: MetricSeriesReading; total?: MetricSeriesReading }] => {
			return entry[1].used !== undefined;
		})
		.sort(byDiskOrder);
	if (usedFilesystems.length > 0) {
		const readings = usedFilesystems.flatMap(([, entry]) => [entry.used, entry.total]);
		const times = timesOf(readings, data.bucketMs, fromMs, toMs);
		const lines = usedFilesystems.map(([name, entry]) => line(name, times, entry.used, (bucket) => bucket.avg));
		const totals = usedFilesystems.flatMap(([, entry]) => (entry.total === undefined ? [] : [entry.total]));
		const capacity = totals.map(windowMax).filter((value): value is number => value !== undefined && value > 0);
		charts.push({
			key: "disks",
			title: i18n._(msg`Disks`),
			unit: "bytes",
			times,
			yMax: capacity.length === 0 ? undefined : Math.max(...capacity),
			lines,
			empty: !hasValues(lines),
		});
	}

	const rx = byName.get("net.rx_bytes_per_sec");
	const tx = byName.get("net.tx_bytes_per_sec");
	const traffic = data.traffic ?? null;
	// A node with a traffic period but no rate series still gets the Network card: its footer holds the
	// totals, and there is no chart body to draw (doc/design/webui.md "Node pages").
	if (rx !== undefined || tx !== undefined || traffic !== null) {
		const times = timesOf([rx, tx], data.bucketMs, fromMs, toMs);
		const lines = [
			...(rx === undefined ? [] : [line(i18n._(msg`Received`), times, rx, (bucket) => bucket.avg)]),
			...(tx === undefined ? [] : [line(i18n._(msg`Sent`), times, tx, (bucket) => bucket.avg)]),
		];
		charts.push({
			key: "network",
			title: i18n._(msg`Network`),
			unit: "bytesPerSec",
			times,
			lines,
			full: true,
			empty: !hasValues(lines),
			chartless: rx === undefined && tx === undefined,
		});
	}

	return charts;
}

/**
 * The traffic period below the Network chart (doc/design/webui.md "Node pages"): the totals, when the
 * period started and resets, and the administrator actions. It is separated from the chart by a border
 * and wraps as one line on wide screens, so the two times never split awkwardly.
 */
function NetworkTrafficFooter({
	traffic,
	admin,
	onReset,
	onNext,
}: {
	traffic: NodeTraffic;
	admin: boolean;
	onReset: () => void;
	onNext: () => void;
}) {
	const { i18n } = useLingui();
	return (
		<div
			className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-2 text-xs text-muted-foreground"
			data-testid="metrics-network-traffic"
		>
			<span className="flex items-center gap-1 whitespace-nowrap tabular-nums">
				<span className="font-medium text-foreground">
					<Trans>Total</Trans>
				</span>
				<ArrowDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
				{formatBytes(traffic.rxBytes, i18n.locale)}
				<span aria-hidden="true"> / </span>
				<ArrowUpIcon className="size-3.5 shrink-0" aria-hidden="true" />
				{formatBytes(traffic.txBytes, i18n.locale)}
			</span>
			<span className="whitespace-nowrap tabular-nums">
				<Trans>Since {formatZonedDateTime(traffic.periodStart, i18n.locale)}</Trans>
			</span>
			<span className="whitespace-nowrap tabular-nums">
				<Trans>Next reset {formatZonedDateTime(traffic.nextResetAt, i18n.locale)}</Trans>
			</span>
			<span className="whitespace-nowrap">
				<Trans>Resets every 30 days</Trans>
			</span>
			{admin && (
				<span className="flex flex-wrap items-center gap-1">
					<Button type="button" size="xs" variant="outline" onClick={onReset}>
						<Trans>Reset now</Trans>
					</Button>
					<Button type="button" size="xs" variant="outline" onClick={onNext}>
						<Trans>Set next reset</Trans>
					</Button>
				</span>
			)}
		</div>
	);
}

/**
 * The Network card, which is always full-width (doc/design/webui.md "Node pages"): the received and sent
 * rate chart when the node has those series, and the traffic totals below it. Without a rate series the
 * card keeps only its heading and footer; the zoom dialog still gets the chart alone, never the footer.
 */
function NetworkPanel({
	chart,
	traffic,
	admin,
	onZoom,
	onReset,
	onNext,
}: {
	chart?: MetricsChartView;
	traffic: NodeTraffic | null;
	admin: boolean;
	onZoom: (chart: MetricsChartView) => void;
	onReset: () => void;
	onNext: () => void;
}) {
	const { t, i18n } = useLingui();
	const title = chart?.title ?? i18n._(msg`Network`);
	return (
		<Panel className="grid min-w-0 content-start gap-2 md:col-span-2" data-testid="metrics-chart-network">
			<h3 className="min-w-0 text-sm font-medium">
				{chart !== undefined && !chart.chartless ? (
					<button
						type="button"
						title={t`Open large chart`}
						className="flex w-full items-center justify-between gap-2 text-left hover:text-primary"
						onClick={() => onZoom(chart)}
					>
						<span className="truncate">{title}</span>
						<MaximizeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					</button>
				) : (
					<span className="block truncate">{title}</span>
				)}
			</h3>
			{chart !== undefined &&
				!chart.chartless &&
				(chart.empty ? (
					<EmptyHint>
						<Trans>No data in this range.</Trans>
					</EmptyHint>
				) : (
					<MetricChart
						times={chart.times}
						series={chart.lines}
						unit={chart.unit}
						label={chart.title}
						yMax={chart.yMax}
						height={220}
						testId="metrics-plot-network"
					/>
				))}
			{traffic !== null && <NetworkTrafficFooter traffic={traffic} admin={admin} onReset={onReset} onNext={onNext} />}
		</Panel>
	);
}

/**
 * The five summary cards from the newest sample (doc/design/webui.md "Node pages"), shown at the top of the
 * Overview. They are built from the same read as the charts, so a figure and a chart never disagree.
 */
export function NodeMetricsSummary({ data, className }: { data: NodeMetricsResponse; className?: string }) {
	const { i18n } = useLingui();
	const summary = useMemo(() => buildSummary(data, i18n), [data, i18n]);
	if (summary.length === 0) return null;
	return (
		<Panel className={cn("min-w-0", className)} data-testid="metrics-summary">
			<dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
				{summary.map((item) => (
					<div
						key={item.key}
						className="grid min-w-0 content-start gap-1"
						title={item.title}
						data-testid={`metrics-summary-${item.key}`}
					>
						<dt className="text-xs text-muted-foreground">{item.label}</dt>
						<dd className="flex h-6 items-center text-sm font-medium tabular-nums">
							{item.percent === undefined ? item.value : <UsageBar ratio={item.percent / 100} size="md" />}
						</dd>
					</div>
				))}
			</dl>
		</Panel>
	);
}

/** One half-width chart card: its title opens the loaded data in the zoom dialog. */
function MetricChartCard({
	chart,
	spansRow,
	onZoom,
}: {
	chart: MetricsChartView;
	spansRow: boolean;
	onZoom: (chart: MetricsChartView) => void;
}) {
	const { t } = useLingui();
	return (
		<Panel
			className={cn("grid min-w-0 content-start gap-2", spansRow && "md:col-span-2")}
			data-testid={`metrics-chart-${chart.key}`}
		>
			<h3 className="min-w-0 text-sm font-medium">
				<button
					type="button"
					title={t`Open large chart`}
					className="flex w-full items-center justify-between gap-2 text-left hover:text-primary"
					onClick={() => onZoom(chart)}
				>
					<span className="truncate">{chart.title}</span>
					<MaximizeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			</h3>
			{chart.empty ? (
				<EmptyHint>
					<Trans>No data in this range.</Trans>
				</EmptyHint>
			) : (
				<MetricChart
					times={chart.times}
					series={chart.lines}
					unit={chart.unit}
					label={chart.title}
					band={chart.band}
					yMax={chart.yMax}
					height={spansRow ? 220 : 170}
					testId={`metrics-plot-${chart.key}`}
				/>
			)}
		</Panel>
	);
}

/** The large chart dialog: the already-loaded window with a dataZoom slider, never a second read. */
function MetricsZoomDialog({ chart, onClose }: { chart: MetricsChartView; onClose: () => void }) {
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-4xl" data-testid="metrics-zoom-dialog">
				<DialogHeader>
					<DialogTitle>{chart.title}</DialogTitle>
					<DialogDescription>
						<Trans>Drag the slider or scroll to zoom inside the loaded range.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="min-w-0">
					<MetricChart
						times={chart.times}
						series={chart.lines}
						unit={chart.unit}
						label={chart.title}
						band={chart.band}
						yMax={chart.yMax}
						height={420}
						zoom
						testId={`metrics-zoom-${chart.key}`}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The chart cards of a metrics read (doc/design/webui.md "Node pages"): every card by default, or the
 * requested `keys` for the Overview's CPU and memory pair. The grid, the half-width spanning rule and the
 * zoom dialog are the same in both places; the Network card keeps its traffic footer and admin actions.
 */
export function NodeMetricsCharts({
	data,
	fromMs,
	toMs,
	keys,
	traffic,
	admin = false,
	onResetTraffic,
	onNextTrafficReset,
	className,
}: {
	data: NodeMetricsResponse;
	fromMs: number;
	toMs: number;
	/** The cards to render, in build order; all charts when omitted. */
	keys?: readonly string[];
	/** The traffic period for the Network footer; the read's own traffic when omitted. */
	traffic?: NodeTraffic | null;
	admin?: boolean;
	onResetTraffic?: () => void;
	onNextTrafficReset?: () => void;
	className?: string;
}) {
	const { i18n } = useLingui();
	const [zoom, setZoom] = useState<MetricsChartView>();
	const allCharts = useMemo(() => buildCharts(data, i18n, fromMs, toMs), [data, i18n, fromMs, toMs]);
	const charts = keys === undefined ? allCharts : allCharts.filter((chart) => keys.includes(chart.key));
	// Every chart card is half-width except the network card. When the half-width cards are odd, the last
	// one would sit alone in its row with an empty cell beside it; it takes the whole row instead.
	const halfWidthCharts = charts.filter((chart) => !chart.full);
	const spanLastHalfWidth = halfWidthCharts.length % 2 === 1 ? halfWidthCharts.at(-1)?.key : undefined;
	const trafficValue = traffic === undefined ? (data.traffic ?? null) : traffic;
	return (
		<>
			<div className={cn("grid min-w-0 gap-3 md:grid-cols-2", className)}>
				{charts.map((chart) => {
					if (chart.key === "network") {
						return (
							<NetworkPanel
								key={chart.key}
								chart={chart}
								traffic={trafficValue}
								admin={admin}
								onZoom={setZoom}
								onReset={() => onResetTraffic?.()}
								onNext={() => onNextTrafficReset?.()}
							/>
						);
					}
					return (
						<MetricChartCard
							key={chart.key}
							chart={chart}
							spansRow={chart.full || chart.key === spanLastHalfWidth}
							onZoom={setZoom}
						/>
					);
				})}
			</div>
			{zoom !== undefined && <MetricsZoomDialog chart={zoom} onClose={() => setZoom(undefined)} />}
		</>
	);
}

/** The Overview's chart pair, in the same order the Metrics tab builds them. */
const OVERVIEW_CHART_KEYS = ["cpu", "memory"] as const;

/**
 * The node Overview's metrics section (doc/design/webui.md "Node pages"): the newest-sample summary and
 * the CPU and memory charts, in the Metrics tab's default 1-hour window. It shares the Metrics tab's query
 * key, so opening one after the other reuses the cached read. A node without host metrics gets nothing at
 * all: the Metrics tab keeps the empty states.
 */
export function NodeOverviewMetrics({ nodeId }: { nodeId: string }) {
	const visible = useTabVisible();
	const metrics = useNodeMetrics(nodeId, "1h", visible);
	const data = metrics.data;
	const hasHostMetrics = data?.series.some((reading) => reading.name !== "up" && reading.buckets.length > 0) ?? false;
	if (data === undefined || !hasHostMetrics) return null;
	const endMs = metrics.dataUpdatedAt || Date.now();
	const startMs = endMs - METRICS_RANGE_MS["1h"];
	return (
		<div className="grid min-w-0 gap-3" data-testid="node-overview-metrics">
			<NodeMetricsSummary data={data} />
			<NodeMetricsCharts data={data} fromMs={startMs} toMs={endMs} keys={OVERVIEW_CHART_KEYS} />
		</div>
	);
}

/** Whether the series only records reachability, so the tab explains why the host charts are missing. */
function isReachabilityOnly(data: NodeMetricsResponse): boolean {
	return data.series.length > 0 && data.series.every((reading) => reading.name === "up");
}

/** The tab is only mounted while it is open; the browser tab can still be hidden, which pauses the poll. */
function useTabVisible(): boolean {
	const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		update();
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

/**
 * The node page's Metrics tab (doc/design/webui.md "Node pages"): the range picker, one card per host
 * metric and, below them, the daily availability strip. The newest-sample summary and the CPU and memory
 * cards also head the Overview. The window slides to the current time every 30 seconds while the tab is
 * open and visible. A card title opens the same loaded data in a large dialog with a dataZoom slider,
 * without another request.
 */
export function NodeMetrics({ nodeId }: { nodeId: string }) {
	const { t, i18n } = useLingui();
	const admin = useAuth().user?.kind === "admin";
	const [range, setRange] = useState<MetricsRange>("1h");
	const [availabilityRange, setAvailabilityRange] = useState(90);
	const [trafficDialog, setTrafficDialog] = useState<"reset" | "next">();
	const visible = useTabVisible();
	const metrics = useNodeMetrics(nodeId, range, visible);
	const data = metrics.data;
	const hasUp = data?.series.some((reading) => reading.name === "up") ?? false;
	const availability = useNodeAvailability(nodeId, availabilityRange, visible && hasUp);
	const endMs = metrics.dataUpdatedAt || Date.now();
	const startMs = endMs - METRICS_RANGE_MS[range];

	const view = useMemo(() => {
		if (data === undefined) return undefined;
		return {
			onlyReachability: isReachabilityOnly(data),
			hasPoints: data.series.some((reading) => reading.buckets.length > 0),
			traffic: data.traffic ?? null,
		};
	}, [data]);

	const availabilityDays = useMemo(() => {
		if (!hasUp) return [];
		const response = availability.data;
		const up = response?.series.find((reading) => reading.name === "up");
		const to = availability.dataUpdatedAt || Date.now();
		// The strip covers whole days up to today: the selected 30, 90 or 365 days, not one extra partial day.
		const from = Math.floor(to / DAY_MS) * DAY_MS - (availabilityRange - 1) * DAY_MS;
		return buildAvailabilityDays(up?.buckets ?? [], from, to);
	}, [availability.data, availability.dataUpdatedAt, availabilityRange, hasUp]);

	// The summary and the host charts live on the Overview; this tab keeps the range picker, the full
	// chart grid and the availability strip.
	return (
		<div className="grid min-w-0 gap-3" data-testid="node-metrics">
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t`Time range`}>
					{RANGE_OPTIONS.map((option) => (
						<Button
							key={option.value}
							type="button"
							size="xs"
							variant={range === option.value ? "secondary" : "ghost"}
							aria-pressed={range === option.value}
							data-testid={`metrics-range-${option.value}`}
							onClick={() => setRange(option.value)}
						>
							{i18n._(option.label)}
						</Button>
					))}
				</div>
				{metrics.dataUpdatedAt > 0 && (
					<span className="text-xs text-muted-foreground" data-testid="metrics-updated">
						<Trans>Updated {formatShortDateTime(metrics.dataUpdatedAt, i18n.locale)}</Trans>
					</span>
				)}
			</div>

			{metrics.isError ? (
				<ErrorState error={metrics.error} retry={() => void metrics.refetch()} compact />
			) : metrics.isLoading || view === undefined ? (
				<div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
					<Spinner decorative />
					<Trans>Loading metrics…</Trans>
				</div>
			) : (
				<>
					{view.hasPoints && data !== undefined ? (
						<NodeMetricsCharts
							data={data}
							fromMs={startMs}
							toMs={endMs}
							traffic={view.traffic}
							admin={admin}
							onResetTraffic={() => setTrafficDialog("reset")}
							onNextTrafficReset={() => setTrafficDialog("next")}
						/>
					) : (
						<>
							<EmptyState
								title={
									metrics.data?.series.length === 0 ? (
										<Trans>No metrics yet</Trans>
									) : (
										<Trans>No samples in this range</Trans>
									)
								}
								description={
									metrics.data?.series.length === 0 ? (
										<Trans>
											crhs has not collected metrics for this node. Collection may be off, or the node may be offline or
											pending approval.
										</Trans>
									) : (
										<Trans>The node has metrics, but none fall in the selected range. Choose a longer range.</Trans>
									)
								}
							/>
							{view.traffic !== null && (
								<div className="grid min-w-0 gap-3 md:grid-cols-2">
									<NetworkPanel
										traffic={view.traffic}
										admin={admin}
										onZoom={() => {}}
										onReset={() => setTrafficDialog("reset")}
										onNext={() => setTrafficDialog("next")}
									/>
								</div>
							)}
						</>
					)}
					{view.onlyReachability && (
						<p className="text-sm text-muted-foreground" data-testid="metrics-reachability-only">
							<Trans>
								Only reachability is recorded for this node. Host metrics are unavailable: collection may be off, the
								node may be pending, or its crha may be too old to report them.
							</Trans>
						</p>
					)}
					{hasUp && (
						<Panel className="grid min-w-0 gap-2" data-testid="metrics-chart-availability">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<h3 className="text-sm font-medium">
									<Trans>Availability</Trans>
								</h3>
								<div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t`Availability window`}>
									{AVAILABILITY_DAYS.map((option) => (
										<Button
											key={option.value}
											type="button"
											size="xs"
											variant={availabilityRange === option.value ? "secondary" : "ghost"}
											aria-pressed={availabilityRange === option.value}
											data-testid={`availability-range-${option.value}`}
											onClick={() => setAvailabilityRange(option.value)}
										>
											{i18n._(option.label)}
										</Button>
									))}
								</div>
							</div>
							{availability.isLoading ? (
								<div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
									<Spinner decorative />
									<Trans>Loading availability…</Trans>
								</div>
							) : availability.isError ? (
								<ErrorState error={availability.error} retry={() => void availability.refetch()} compact />
							) : (
								<AvailabilityStrip days={availabilityDays} label={t`Availability`} />
							)}
						</Panel>
					)}
				</>
			)}

			{trafficDialog === "reset" && <TrafficResetDialog nodeId={nodeId} onClose={() => setTrafficDialog(undefined)} />}
			{trafficDialog === "next" && (
				<TrafficNextResetDialog
					nodeId={nodeId}
					nextResetAt={metrics.data?.traffic?.nextResetAt ?? null}
					onClose={() => setTrafficDialog(undefined)}
				/>
			)}
		</div>
	);
}
