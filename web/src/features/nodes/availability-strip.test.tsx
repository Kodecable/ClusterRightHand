import { screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import {
	AvailabilityStrip,
	aggregateAvailabilityBars,
	availabilityBarCount,
	buildAvailabilityDays,
} from "./availability-strip";

const DAY = 24 * 60 * 60 * 1000;
const DAY0 = Date.UTC(2026, 5, 1);

function bucketAt(t: number, avg: number, count = 1440) {
	return { t, count, avg, sum: avg * count, min: avg, max: avg, last: avg };
}

function bucket(dayOffset: number, avg: number, count = 1440) {
	return bucketAt(DAY0 + dayOffset * DAY, avg, count);
}

/** A formatter with the same options as the strip's, for asserting its labels. */
function utcDay(value: number): string {
	return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value));
}

const originalTimeZone = process.env.TZ;
// The whole file runs west of UTC: the helpers and labels must still use UTC days.
beforeAll(() => {
	process.env.TZ = "America/New_York";
});
afterAll(() => {
	if (originalTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimeZone;
});

describe("availability strip helpers", () => {
	test("turns the bar pitch into a bar count", () => {
		expect(availabilityBarCount(280)).toBe(20);
		expect(availabilityBarCount(0)).toBe(0);
		expect(availabilityBarCount(13)).toBe(1);
	});

	test("keeps days without a bucket as a gap", () => {
		const days = buildAvailabilityDays([bucket(0, 1), bucket(2, 0.25)], DAY0, DAY0 + 3 * DAY);
		expect(days).toEqual([
			{ t: DAY0, ratio: 1, count: 1440 },
			{ t: DAY0 + DAY, ratio: null, count: 0 },
			{ t: DAY0 + 2 * DAY, ratio: 0.25, count: 1440 },
		]);
	});

	test("aggregates whole days count-weighted when the window has more days than bars", () => {
		const days = buildAvailabilityDays(
			[bucket(0, 1, 100), bucket(1, 0.5, 300), bucket(2, 0), bucket(3, 1, 50)],
			DAY0,
			DAY0 + 4 * DAY,
		);
		const bars = aggregateAvailabilityBars(days, 2);
		expect(bars).toHaveLength(2);
		// The newest day is alone; the three older days share the oldest bar.
		expect(bars[0]?.from).toBe(DAY0);
		expect(bars[0]?.to).toBe(DAY0 + 2 * DAY);
		// (1 * 100 + 0.5 * 300 + 0 * 1440) / (100 + 300 + 1440)
		expect(bars[0]?.ratio).toBeCloseTo(250 / 1840);
		expect(bars[0]?.hasData).toBe(true);
		expect(bars[1]?.from).toBe(DAY0 + 3 * DAY);
		expect(bars[1]?.to).toBe(DAY0 + 3 * DAY);
		expect(bars[1]?.ratio).toBe(1);
	});

	test("keeps one bar per day when there is room", () => {
		const days = buildAvailabilityDays([bucket(0, 1), bucket(1, 0.75)], DAY0, DAY0 + 2 * DAY);
		const bars = aggregateAvailabilityBars(days, 10);
		expect(bars).toHaveLength(2);
		expect(bars[0]?.from).toBe(DAY0);
		expect(bars[0]?.to).toBe(DAY0);
		expect(bars[1]?.from).toBe(DAY0 + DAY);
		expect(bars[1]?.to).toBe(DAY0 + DAY);
	});

	test("anchors the newest bar at the current UTC day and balances the older groups", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-11-24T21:18:00Z"));
			const now = Date.now();
			const today = Math.floor(now / DAY) * DAY;
			const days = buildAvailabilityDays([], today - 29 * DAY, now);
			expect(days).toHaveLength(30);

			const bars = aggregateAvailabilityBars(days, 12);
			expect(bars).toHaveLength(12);
			// The newest bar is exactly the current UTC day, on its own.
			expect(bars.at(-1)).toMatchObject({ from: today, to: today });
			// 29 older days in 11 bars: seven 3-day groups and four 2-day groups, oldest first, so the
			// oldest bar no longer swallows the remainder.
			expect(bars.map((bar) => (bar.to - bar.from) / DAY + 1)).toEqual([2, 3, 2, 3, 3, 2, 3, 3, 2, 3, 3, 1]);
			expect(bars[0]?.from).toBe(today - 29 * DAY);
			expect(bars[0]?.to).toBe(today - 28 * DAY);
			expect(bars[1]?.from).toBe(today - 27 * DAY);
			for (let index = 1; index < bars.length; index += 1) {
				expect(bars[index]?.from).toBe((bars[index - 1]?.to ?? 0) + DAY);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test.each([
		[365, 68],
		[90, 68],
		[30, 68],
		[91, 2],
		[365, 1],
	] as const)("balances %i days into %i bars", (n, slots) => {
		const days = buildAvailabilityDays([], DAY0, DAY0 + n * DAY);
		expect(days).toHaveLength(n);
		const bars = aggregateAvailabilityBars(days, slots);
		const expected = Math.min(slots, n);
		const startOf = (offset: number) => days[offset]?.t;
		expect(bars).toHaveLength(expected);

		// Every day is covered exactly once, oldest to newest, with no day shared between bars.
		let next = 0;
		const sizes: number[] = [];
		for (const bar of bars) {
			expect(bar.from).toBe(startOf(next));
			const size = Math.round((bar.to - bar.from) / DAY) + 1;
			expect(bar.to).toBe(startOf(next + size - 1));
			sizes.push(size);
			next += size;
		}
		expect(next).toBe(n);
		// The newest bar always ends at the newest day.
		expect(bars.at(-1)?.to).toBe(startOf(n - 1));
		if (expected === 1) {
			// One bar has to hold the whole window, newest day included.
			expect(bars[0]).toMatchObject({ from: DAY0, to: DAY0 + (n - 1) * DAY });
			return;
		}
		// The newest day also starts its own bar, alone.
		expect(bars.at(-1)?.from).toBe(startOf(n - 1));
		// The older bars are contiguous groups whose sizes differ by at most one day.
		const olderSizes = sizes.slice(0, -1);
		expect(olderSizes).toHaveLength(expected - 1);
		expect(Math.min(...olderSizes)).toBeGreaterThanOrEqual(1);
		expect(Math.max(...olderSizes) - Math.min(...olderSizes)).toBeLessThanOrEqual(1);
	});
});

describe("AvailabilityStrip", () => {
	test("colours bars by availability and greys a day without data", () => {
		const days = buildAvailabilityDays([bucket(0, 1), bucket(1, 0.75), bucket(2, 0.2)], DAY0, DAY0 + 4 * DAY);
		renderWithI18n(<AvailabilityStrip days={days} label="Availability" barCount={4} />);
		const bars = screen.getAllByTestId("availability-bar");
		expect(bars).toHaveLength(4);
		expect(bars.map((bar) => bar.getAttribute("data-tone"))).toEqual(["good", "mid", "bad", "none"]);
		expect(bars[0]?.getAttribute("title")).toContain("100%");
		expect(bars[1]?.getAttribute("title")).toContain("75%");
		expect(bars[3]?.getAttribute("title")).toContain("No data");
		expect(bars.every((bar) => bar.getAttribute("title")?.includes("(UTC)"))).toBe(true);
	});

	test("labels each day in UTC even when the browser is west of UTC", () => {
		const now = Date.UTC(2026, 10, 24, 21, 18);
		const today = Math.floor(now / DAY) * DAY;
		const days = buildAvailabilityDays([bucketAt(today, 1), bucketAt(today - DAY, 0.5)], today - 3 * DAY, now);
		expect(days).toHaveLength(4);

		// The bucket start is 00:00 UTC, which is still the previous day in New York: the local formatter
		// proves the strip's UTC formatter is not falling back to the browser's zone.
		const localDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(today));
		expect(localDay).not.toBe(utcDay(today));

		renderWithI18n(<AvailabilityStrip days={days} label="Availability" barCount={2} />);
		const bars = screen.getAllByTestId("availability-bar");
		expect(bars).toHaveLength(2);
		// The newest bar is today alone and names its UTC day.
		expect(bars[1]).toHaveAttribute("title", `${utcDay(today)} (UTC) 100%`);
		// The oldest bar covers the remaining three days, from the oldest bucket to the newest of them.
		expect(bars[0]).toHaveAttribute("title", `${utcDay(today - 3 * DAY)} – ${utcDay(today - DAY)} (UTC) 50%`);
	});

	test("uses the measured width for its bar count", () => {
		const original = window.ResizeObserver;
		class ObservingResizeObserver {
			callback: (entries: { contentRect: { width: number } }[]) => void;
			constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
				this.callback = callback;
			}
			observe() {
				this.callback([{ contentRect: { width: 280 } }]);
			}
			unobserve() {}
			disconnect() {}
		}
		window.ResizeObserver = ObservingResizeObserver as unknown as typeof ResizeObserver;
		try {
			const days = buildAvailabilityDays([], DAY0, DAY0 + 90 * DAY);
			renderWithI18n(<AvailabilityStrip days={days} label="Availability" />);
			expect(screen.getAllByTestId("availability-bar")).toHaveLength(20);
		} finally {
			window.ResizeObserver = original;
		}
	});
});
