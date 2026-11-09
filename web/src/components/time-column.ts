/**
 * The width of an absolute-time column (`DateTime` cells).
 *
 * A column's width is one px track shared by the header and every body row
 * (doc/webui.md "DataTable"). Absolute timestamps outgrow the 165px the table
 * used to reserve: Chromium lays out "2026/12/28 23:58:58" at ~147px, so with
 * the cell's 24px of padding the column needs ~171px and the seconds were
 * truncated. A `max-content` track cannot fix it — the header
 * and each body row are separate grids, so every row would resolve its own
 * width (and the virtualiser renders only some rows) — so the width is
 * measured once, in the DOM, with the cell's own classes, and every time
 * column uses it as its fixed `size`.
 *
 * The measurement is a hidden element laid out by the browser rather than
 * canvas text metrics: `getComputedStyle(cell).font` is empty in Chromium for
 * a cell with `font-variant-numeric: tabular-nums` (the `font` shorthand cannot
 * serialize it), so a canvas silently fell back to 10px sans-serif and
 * measured far too narrow. A real element measures the real glyphs, with
 * `tabular-nums` and the app font applied, at the cost of one layout query.
 */
import { useEffect, useState } from "react";
import { DATE_TIME_CLASS } from "@/components/relative-time";
import { formatDateTimeSeconds } from "@/lib/format";
import { useLocale } from "@/lib/i18n";

/** The table an absolute-time column lives in: the default one or a compact (nested) one. */
export type TimeColumnDensity = "default" | "compact";

/** A cell's horizontal padding (`px-3` either side): a grid track covers the padded box. */
export const TIME_CELL_PADDING_PX = 24;

/** A compact cell's horizontal padding (`px-2` either side). */
export const COMPACT_TIME_CELL_PADDING_PX = 16;

/**
 * The typography of a `DateTime` cell, per density: the font size `DataTable`
 * puts on the cell plus the timestamp's own `tabular-nums` classes. The probe
 * must carry both, or it would measure a different font than the one rendered.
 */
const CELL_CLASS: Record<TimeColumnDensity, string> = {
	default: `text-sm ${DATE_TIME_CLASS}`,
	compact: `text-xs ${DATE_TIME_CLASS}`,
};

/** A cell's horizontal padding, per density. */
const CELL_PADDING_PX: Record<TimeColumnDensity, number> = {
	default: TIME_CELL_PADDING_PX,
	compact: COMPACT_TIME_CELL_PADDING_PX,
};

/**
 * The timestamp whose width stands for every value of a time column: every
 * field of {@link formatDateTimeSeconds} is two digits and, with
 * `tabular-nums`, every digit has the same advance, so any instant fits. Its
 * digits are wide ones (8, 5), so even a proportional fallback font is
 * measured near its widest.
 */
const SAMPLE_INSTANT = new Date(2026, 11, 28, 23, 58, 58);

/**
 * The width used where text cannot be measured (jsdom tests, server
 * rendering): about what a 14px sans timestamp needs, so the column stays
 * readable instead of collapsing to zero.
 */
const FALLBACK_WIDTH_PX = 180;

/** Room for a fractional advance that rounds the last glyph past the track. */
const SAFETY_MARGIN_PX = 2;

/** The sample timestamp formatted the way a `DateTime` cell shows it. */
export function timeColumnSample(locale: string): string {
	return formatDateTimeSeconds(SAMPLE_INSTANT, locale);
}

/**
 * A hidden element carrying a cell's classes and the sample timestamp, appended
 * so the browser lays it out with the app font, or null where there is no DOM
 * (server rendering). It is absolutely positioned off to the left so it cannot
 * widen the page, and invisible so it never paints.
 */
function createProbe(locale: string, density: TimeColumnDensity): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const host = document.body ?? document.documentElement;
	if (!host) return null;
	const probe = document.createElement("span");
	probe.className = CELL_CLASS[density];
	probe.textContent = timeColumnSample(locale);
	probe.style.position = "absolute";
	probe.style.top = "0";
	probe.style.left = "-10000px";
	probe.style.visibility = "hidden";
	probe.style.whiteSpace = "nowrap";
	probe.style.pointerEvents = "none";
	host.appendChild(probe);
	return probe;
}

/**
 * The column width: the cell's horizontal padding plus the sample's laid-out
 * width, rounded up, with a little safety margin. Null where the DOM cannot
 * lay text out (jsdom reports a zero-size rect, server rendering has no
 * document): the caller uses {@link FALLBACK_WIDTH_PX} instead.
 */
export function measureTimeColumnWidth(locale: string, density: TimeColumnDensity): number | null {
	const probe = createProbe(locale, density);
	if (probe === null) return null;
	let textWidth: number;
	try {
		textWidth = probe.getBoundingClientRect().width;
	} finally {
		probe.remove();
	}
	if (!(textWidth > 0)) return null;
	return Math.ceil(CELL_PADDING_PX[density] + textWidth) + SAFETY_MARGIN_PX;
}

/** Measured widths, keyed by locale, density and font state: stable across tables and renders. */
const widths = new Map<string, number>();

/**
 * Whether the app web fonts have finished loading. The first render often
 * happens while a font is still loading, and measuring then sizes the column
 * for the fallback face, so the width is measured again once fonts are ready.
 */
function fontsAreLoaded(): boolean {
	return typeof document !== "undefined" && document.fonts !== undefined && document.fonts.status === "loaded";
}

/** The column width for a locale and density, measured once per font state. */
function measuredWidth(locale: string, density: TimeColumnDensity, fontsLoaded: boolean): number {
	const key = `${locale}|${density}|${fontsLoaded ? "fonts" : "initial"}`;
	const cached = widths.get(key);
	if (cached !== undefined) return cached;
	const width = measureTimeColumnWidth(locale, density) ?? FALLBACK_WIDTH_PX;
	widths.set(key, width);
	return width;
}

/**
 * The `size` of an absolute-time column: exactly what a full timestamp needs in
 * the table's cell font, so the fixed track never truncates it and the header
 * stays above its values. Pass the table's density — a compact table has a
 * smaller cell font and padding. Memoized per locale, density and font state
 * (via {@link measuredWidth}); it re-measures when the locale changes and once
 * `document.fonts.ready` resolves, updating only if the width changed.
 *
 * Because the value is a concrete px `size`, `--dt-min-width` counts it like
 * every other fixed column.
 */
export function useTimeColumnWidth(density: TimeColumnDensity = "default"): number {
	const { locale } = useLocale();
	const [width, setWidth] = useState(() => measuredWidth(locale, density, fontsAreLoaded()));

	useEffect(() => {
		let cancelled = false;
		const settle = (fontsLoaded: boolean) => {
			if (cancelled) return;
			const next = measuredWidth(locale, density, fontsLoaded);
			setWidth((previous) => (previous === next ? previous : next));
		};
		// A locale or density change re-renders with a different sample: settle
		// it right away, then again after the web fonts have loaded.
		settle(fontsAreLoaded());
		if (typeof document === "undefined" || document.fonts === undefined) return;
		void document.fonts.ready.then(() => settle(true));
		return () => {
			cancelled = true;
		};
	}, [locale, density]);

	return width;
}
