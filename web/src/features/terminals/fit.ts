/**
 * The geometry of fitting a terminal viewer (doc/design/webui.md "Terminals page").
 *
 * A terminal's grid is changed only by an explicit resize, never by a viewer's window. The viewer
 * scales its font so the whole grid fits instead. "Fit to window" is that explicit resize: it asks
 * for the grid the viewer's area would hold at the default font, so the result is the same whatever
 * scale the terminal's current grid forced on the font.
 */

/** The font a viewer starts at, and the one "Fit to window" computes against. */
export const BASE_FONT_SIZE = 13;
/** The font stays legible; below this the terminal area scrolls instead of shrinking further. */
export const MIN_FONT_SIZE = 6;
/** A huge monitor with a tiny grid must not grow the text without limit. */
export const MAX_FONT_SIZE = 32;
/** A small margin keeps rounding in the cell metrics from pushing the last row or column past the edge. */
export const FIT_MARGIN = 0.98;
/** The largest rows or columns crha accepts (doc/design/pty.md "The terminal object"). */
export const MAX_DIMENSION = 1000;

/** The content-box size a viewer may fill, in CSS pixels. */
export interface FitArea {
	width: number;
	height: number;
}

/** One terminal cell in CSS pixels, measured at a particular font size. */
export interface CellMetrics {
	width: number;
	height: number;
}

/** The rows and columns of an explicit resize. */
export interface TerminalDimensions {
	rows: number;
	cols: number;
}

/** Keeps one dimension inside the API's 1..1000 range. */
export function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.min(MAX_DIMENSION, Math.trunc(value)));
}

/**
 * The grid that fills `area` at the default font. `cell` is measured at `fontSize`, so the metrics
 * are scaled back to `baseFontSize` first: the grid a viewer asks for must be the same whether its
 * current font was shrunk for a wide terminal or grown for a narrow one. Returns undefined while
 * the viewer has no usable measurement.
 */
export function fitGrid(
	area: FitArea,
	cell: CellMetrics,
	fontSize: number,
	baseFontSize: number = BASE_FONT_SIZE,
): TerminalDimensions | undefined {
	if (
		!Number.isFinite(area.width) ||
		!Number.isFinite(area.height) ||
		!Number.isFinite(cell.width) ||
		!Number.isFinite(cell.height) ||
		!Number.isFinite(fontSize) ||
		!Number.isFinite(baseFontSize) ||
		area.width <= 0 ||
		area.height <= 0 ||
		cell.width <= 0 ||
		cell.height <= 0 ||
		fontSize <= 0 ||
		baseFontSize <= 0
	) {
		return undefined;
	}
	const scale = baseFontSize / fontSize;
	return {
		rows: clampDimension(Math.floor(area.height / (cell.height * scale))),
		cols: clampDimension(Math.floor(area.width / (cell.width * scale))),
	};
}
