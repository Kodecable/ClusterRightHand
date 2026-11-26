import type { SessionOutlinePage, SessionOutlineTurn } from "@crh/api";

/** The number of code points an outline preview keeps (doc/design/webui.md "Turn rail"). */
export const OUTLINE_TEXT_CODE_POINTS = 50;

export interface OutlineText {
	/** Whitespace collapsed and trimmed, at most {@link OUTLINE_TEXT_CODE_POINTS} code points. */
	text: string;
	/** Whether the collapsed text is longer than {@link OUTLINE_TEXT_CODE_POINTS} code points. */
	truncated: boolean;
}

/**
 * The rail's one-line preview of a user message: whitespace collapsed and trimmed, cut at 50 Unicode code
 * points (not UTF-16 units, so an emoji or a CJK character counts once). The server applies the same rule to
 * `GET /api/sessions/:id/outline`, so a loaded message and an outline turn render the same preview.
 */
export function outlineText(text: string): OutlineText {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const points = Array.from(collapsed);
	if (points.length <= OUTLINE_TEXT_CODE_POINTS) return { text: collapsed, truncated: false };
	return { text: points.slice(0, OUTLINE_TEXT_CODE_POINTS).join(""), truncated: true };
}

export interface TurnRailItem {
	/** The user message's entry id, as a string like every transcript item's. */
	entryId: string;
	/** The preview text, already cut to the outline length. */
	text: string;
	truncated: boolean;
	/** Whether the transcript has the message already; outline turns are the unloaded ones. */
	loaded: boolean;
}

/** The transcript fields the rail needs from a user item. */
export interface RailUserItem {
	entryId?: string;
	text: string;
}

/**
 * Every outline page's turns, oldest first. A page holds the user messages before its `before` cursor, and
 * the first page starts at the transcript's history cursor (the newest of the older turns), so the pages
 * arrive newest chunk first and have to be read backwards.
 */
export function outlineTurnsFromPages(pages: readonly SessionOutlinePage[] | undefined): SessionOutlineTurn[] {
	if (pages === undefined) return [];
	const turns: SessionOutlineTurn[] = [];
	for (let index = pages.length - 1; index >= 0; index -= 1) {
		turns.push(...(pages[index]?.turns ?? []));
	}
	return turns;
}

/**
 * The rail's items (doc/design/webui.md "Turn rail"): the outline turns the transcript has not loaded yet,
 * oldest first, then the loaded user items in transcript order. Outline turns are always older than every
 * loaded item, so the two lists simply concatenate; only duplicate entry ids are dropped.
 */
export function buildTurnRailItems(
	outline: readonly SessionOutlineTurn[],
	loaded: readonly RailUserItem[],
): TurnRailItem[] {
	const items: TurnRailItem[] = [];
	const seen = new Set<string>();
	const loadedIds = new Set(loaded.flatMap((item) => (item.entryId === undefined ? [] : [item.entryId])));
	for (const turn of outline) {
		const entryId = String(turn.entryId);
		// A turn the transcript already carries is rendered from the transcript, with its loaded flag.
		if (loadedIds.has(entryId) || seen.has(entryId)) continue;
		seen.add(entryId);
		items.push({ entryId, text: turn.text, truncated: turn.truncated, loaded: false });
	}
	for (const item of loaded) {
		if (item.entryId === undefined || seen.has(item.entryId)) continue;
		seen.add(item.entryId);
		const preview = outlineText(item.text);
		items.push({ entryId: item.entryId, text: preview.text, truncated: preview.truncated, loaded: true });
	}
	return items;
}
