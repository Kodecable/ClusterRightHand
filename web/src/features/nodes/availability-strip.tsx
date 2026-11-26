import type { MetricBucketPoint } from "@crh/api";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One day of the availability strip: its bucket start and the availability ratio, or null without data. */
export interface AvailabilityDay {
	/** The UTC day bucket start, Unix epoch milliseconds. */
	t: number;
	/** Availability over the day, 0–1, or null when the level-4 `up` series has no bucket. */
	ratio: number | null;
	/** Samples behind the ratio; the weight when several days share one bar. */
	count: number;
}

/** One bar: one day, or several whole days aggregated when the window has more days than bars. */
export interface AvailabilityBar {
	from: number;
	to: number;
	ratio: number | null;
	hasData: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A bar is about 12 px wide with a 2 px gap. */
export const AVAILABILITY_BAR_PITCH = 14;

/** How many bars fit in `width` (doc/design/webui.md "Node pages"); a container not laid out yet has none. */
export function availabilityBarCount(width: number): number {
	if (!(width > 0)) return 0;
	return Math.max(1, Math.floor((width + 2) / AVAILABILITY_BAR_PITCH));
}

/**
 * The window's level-4 `up` buckets as one entry per UTC day, oldest first. A day without a bucket stays in
 * the list with `ratio: null`, so it becomes a grey bar instead of closing the gap.
 */
export function buildAvailabilityDays(
	buckets: readonly MetricBucketPoint[],
	fromMs: number,
	toMs: number,
): AvailabilityDay[] {
	const byStart = new Map(buckets.map((bucket) => [bucket.t, bucket]));
	const first = Math.floor(fromMs / DAY_MS) * DAY_MS;
	const days: AvailabilityDay[] = [];
	for (let t = first; t < toMs; t += DAY_MS) {
		const bucket = byStart.get(t);
		const count = bucket?.count ?? 0;
		days.push({ t, ratio: bucket !== undefined && count > 0 ? (bucket.avg ?? null) : null, count });
	}
	return days;
}

/**
 * Splits the days into at most `slots` bars. With enough room every day keeps its own bar; otherwise the
 * newest day is still a bar of its own, so the current UTC day never merges with yesterday, and the older
 * days are split oldest to newest into contiguous groups whose sizes differ by at most one day. Each bar's
 * ratio is weighted by its samples (`count`), so a few missing samples do not weigh like a whole day
 * (doc/design/webui.md "Node pages").
 */
export function aggregateAvailabilityBars(days: readonly AvailabilityDay[], slots: number): AvailabilityBar[] {
	if (days.length === 0 || slots <= 0) return [];
	const count = Math.min(slots, days.length);
	// A single bar has to hold the whole window, newest day included.
	if (count === 1) return [aggregateAvailabilityGroup(days, 0, days.length)];
	// The newest day always keeps a bar of its own; the `count - 1` older bars then split the remaining
	// days into contiguous groups whose sizes differ by at most one day, so no bar absorbs the remainder.
	const older = days.length - 1;
	const bars: AvailabilityBar[] = [];
	for (let index = 0; index < count - 1; index += 1) {
		const start = Math.floor((index * older) / (count - 1));
		const end = Math.floor(((index + 1) * older) / (count - 1));
		bars.push(aggregateAvailabilityGroup(days, start, end));
	}
	bars.push(aggregateAvailabilityGroup(days, older, days.length));
	return bars;
}

/** One bar over `days[start..end)`, weighted by the samples of the days that have data. */
function aggregateAvailabilityGroup(days: readonly AvailabilityDay[], start: number, end: number): AvailabilityBar {
	let weighted = 0;
	let samples = 0;
	let hasData = false;
	for (let day = start; day < end; day += 1) {
		const sample = days[day];
		if (sample === undefined || sample.ratio === null || sample.count <= 0) continue;
		hasData = true;
		weighted += sample.ratio * sample.count;
		samples += sample.count;
	}
	const first = days[start] as AvailabilityDay;
	const last = days[end - 1] as AvailabilityDay;
	return {
		from: first.t,
		to: last.t,
		ratio: samples > 0 ? weighted / samples : null,
		hasData,
	};
}

/** The colour thresholds of a status page: a short outage is amber, a long one red, no data grey. */
function toneOf(bar: AvailabilityBar): "good" | "mid" | "bad" | "none" {
	if (!bar.hasData || bar.ratio === null) return "none";
	if (bar.ratio >= 0.99) return "good";
	if (bar.ratio >= 0.5) return "mid";
	return "bad";
}

const TONE_CLASS = {
	good: "bg-ok",
	mid: "bg-warn",
	bad: "bg-danger",
	none: "bg-muted-foreground/30",
} as const;

/**
 * A status-page style availability strip (doc/design/webui.md "Node pages"): daily bars, oldest first, with
 * the last bar containing today dimmed. Plain HTML and CSS, so it stays cheap while the tab refreshes; the
 * parent loads the level-4 `up` buckets and decides the window.
 */
export function AvailabilityStrip({
	days,
	label,
	barCount,
}: {
	days: readonly AvailabilityDay[];
	/** A translated accessible name for the strip. */
	label: string;
	/** Test hook: use this many bars instead of measuring the container. */
	barCount?: number;
}) {
	const { i18n } = useLingui();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [measured, setMeasured] = useState(0);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const measure = (width?: number) => setMeasured(availabilityBarCount(width ?? container.clientWidth));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width));
		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	const slots = barCount ?? measured;
	const bars = aggregateAvailabilityBars(days, slots);
	// Levels are UTC days, so the label must format the bucket start in UTC too: a browser west of UTC
	// would otherwise show the previous local day.
	const dayFormat = new Intl.DateTimeFormat(i18n.locale, {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
	const utc = i18n._(msg`UTC`);
	const formatDay = (value: number) => dayFormat.format(new Date(value));
	const formatRatio = (ratio: number) => `${formatNumber(ratio * 100, i18n.locale, { maximumFractionDigits: 2 })}%`;

	return (
		<section ref={containerRef} className="min-w-0 w-full" data-testid="availability-strip" aria-label={label}>
			<div className="flex h-7 w-full gap-[2px]">
				{bars.map((bar, index) => {
					const tone = toneOf(bar);
					const range = bar.from === bar.to ? formatDay(bar.from) : `${formatDay(bar.from)} – ${formatDay(bar.to)}`;
					const title =
						bar.hasData && bar.ratio !== null
							? `${range} (${utc}) ${formatRatio(bar.ratio)}`
							: `${range} (${utc}) — ${i18n._(msg`No data`)}`;
					return (
						<div
							// Bucket starts are unique, so they identify a bar across a refresh.
							key={bar.from}
							role="img"
							aria-label={title}
							title={title}
							data-testid="availability-bar"
							data-tone={tone}
							className={cn("min-w-[2px] flex-1 rounded", TONE_CLASS[tone], index === bars.length - 1 && "opacity-60")}
						/>
					);
				})}
			</div>
		</section>
	);
}
