import type { ReactNode } from "react";

/** The subtle mark used for every matched keyword (doc/design/webui.md "Session content search"). */
export const HIGHLIGHT_CLASS = "rounded-sm bg-yellow-200/60 px-0.5 text-inherit dark:bg-yellow-500/30";

interface Range {
	start: number;
	end: number;
}

/**
 * The merged, non-overlapping character ranges of `text` that contain a keyword,
 * matched case-insensitively. Overlapping keywords produce one range, so nesting
 * a mark inside a mark never happens.
 */
export function keywordRanges(text: string, keywords: readonly string[]): Range[] {
	const lower = text.toLowerCase();
	const ranges: Range[] = [];
	for (const keyword of keywords) {
		const needle = keyword.trim().toLowerCase();
		if (needle === "") continue;
		let index = lower.indexOf(needle);
		while (index !== -1) {
			ranges.push({ start: index, end: index + needle.length });
			index = lower.indexOf(needle, index + needle.length);
		}
	}
	if (ranges.length === 0) return [];
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Range[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

/**
 * `text` with every keyword wrapped in a subtle `<mark>`. The server matches the
 * same whitespace-separated keywords case-insensitively; the client only
 * highlights what the server already returned, so no extra filtering happens.
 */
export function HighlightedText({ text, keywords }: { text: string; keywords: readonly string[] }) {
	const ranges = keywordRanges(text, keywords);
	if (ranges.length === 0) return <>{text}</>;
	const parts: ReactNode[] = [];
	let cursor = 0;
	for (const [index, range] of ranges.entries()) {
		if (range.start > cursor) parts.push(text.slice(cursor, range.start));
		parts.push(
			<mark key={index} className={HIGHLIGHT_CLASS}>
				{text.slice(range.start, range.end)}
			</mark>,
		);
		cursor = range.end;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return <>{parts}</>;
}
