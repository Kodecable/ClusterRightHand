/**
 * The geometry of fitting a terminal viewer (doc/design/webui.md "Terminals page").
 *
 * A terminal's grid is changed only by an explicit resize, never by a viewer's window. The viewer
 * scales its font so the whole grid fits instead. The width decides that font, because on a phone it
 * is the dimension that stays put; the height of the layout viewport only caps it, so a soft keyboard
 * cannot make the text jump and a height-only change matters only for a grid taller than the window.
 * That height budget is the layout viewport minus the terminal box's top in the unscrolled layout —
 * everything above the box, the app top bar included — the extra-keys bar when shown, and the viewer
 * box's own vertical padding and border.
 * "Fit to window" is that explicit resize: it asks for the grid the viewer's area would hold at the
 * default font, measured at exactly that font rather than scaled from whatever size the current grid
 * forced on the viewer. The grid fills the width while keeping the terminal's default 80:24 shape;
 * when the height budget cannot hold those rows, the height decides and the narrower grid stays
 * centred.
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
/** The default grid shape "Fit to window" keeps: 80 columns wide and 24 rows tall. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** The monospace stack every viewer renders with; the default-font measurement uses the same one. */
export const TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
/** xterm multiplies the measured glyph height by this, so a cell is taller than its glyphs. */
export const TERMINAL_LINE_HEIGHT = 1.2;

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

function positive(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

/** Keeps one dimension inside the API's 1..1000 range. */
export function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.min(MAX_DIMENSION, Math.trunc(value)));
}

/**
 * Keeps a font inside the viewer's range. The 0.05 steps keep frequent refits of a huge grid from
 * changing the text for a difference no one can see.
 */
export function clampFontSize(fontSize: number): number {
	if (!Number.isFinite(fontSize)) return MIN_FONT_SIZE;
	const rounded = Math.round(fontSize * 20) / 20;
	return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, rounded));
}

/**
 * The font that makes the full grid fit `area`: the width picks it, and the height budget only lowers
 * it when the grid would be taller than that budget at the width's font. `cell` is measured at
 * `fontSize`, and the height/width ratio scales the cell linearly; the caller measures again after
 * applying the answer, because device-pixel rounding makes the cell metrics only almost linear.
 */
export function fittedFontSize(
	area: FitArea,
	cell: CellMetrics,
	fontSize: number,
	cols: number,
	rows: number,
): number | undefined {
	if (
		!positive(area.width) ||
		!positive(area.height) ||
		!positive(cell.width) ||
		!positive(cell.height) ||
		!positive(fontSize) ||
		!Number.isInteger(cols) ||
		cols <= 0 ||
		!Number.isInteger(rows) ||
		rows <= 0
	) {
		return undefined;
	}
	const widthFont = (fontSize * area.width) / (cell.width * cols);
	const heightAtWidth = ((cell.height * widthFont) / fontSize) * rows;
	if (heightAtWidth <= area.height) return clampFontSize(widthFont * FIT_MARGIN);
	const heightFont = (fontSize * area.height) / (cell.height * rows);
	return clampFontSize(heightFont * FIT_MARGIN);
}

/**
 * The height a full grid may use: the layout viewport minus the terminal box's top in the unscrolled
 * layout — the top bar, the page content above the box and the box's own offset within the page, so
 * the last rows stay visible without scrolling — the extra-keys bar when shown, and the viewer box's
 * own vertical padding and border. The visual viewport a soft keyboard shrinks deliberately takes no
 * part, so typing cannot resize the terminal.
 */
export function viewportHeightBudget(
	viewportHeight: number,
	boxTop: number,
	extraKeysHeight: number,
	boxChromeHeight: number,
): number | undefined {
	if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return undefined;
	const height = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);
	const budget = viewportHeight - height(boxTop) - height(extraKeysHeight) - height(boxChromeHeight);
	return budget > 0 ? budget : undefined;
}

/**
 * Whether the grid measured at `cell` still overflows the area or the height budget. A sub-pixel
 * difference is not an overflow: the renderer rounds cell metrics to device pixels.
 */
export function gridOverflows(area: FitArea, cell: CellMetrics, cols: number, rows: number): boolean {
	return cell.width * cols > area.width + 0.5 || cell.height * rows > area.height + 0.5;
}

/** The live viewer's font and cell, as the pure fit procedure sees them. */
export interface FitProbe {
	/** One cell at the font currently applied to the viewer. */
	measure(): CellMetrics | undefined;
	/** Applies a font size to the viewer. */
	applyFont(fontSize: number): void;
}

/**
 * Applies the font that makes a `rows × cols` grid fit `width × budget`, and returns the cell measured
 * at the font it settled on. The first pass scales the cell linearly, which device-pixel rounding makes
 * only almost true; when the cell measured at that font still overflows, one correction pass recomputes
 * from the measured cell instead of trusting the scaled one.
 */
export function fitCellFont(
	width: number,
	budget: number,
	cols: number,
	rows: number,
	fontSize: number,
	probe: FitProbe,
): CellMetrics | undefined {
	if (!positive(width) || !positive(budget)) return undefined;
	const area = { width, height: budget };
	const cell = probe.measure();
	if (cell === undefined) return undefined;
	const target = fittedFontSize(area, cell, fontSize, cols, rows);
	if (target === undefined) return undefined;
	if (Math.abs(fontSize - target) >= 0.05) probe.applyFont(target);
	let chosen = probe.measure();
	if (chosen === undefined) return undefined;
	if (gridOverflows(area, chosen, cols, rows)) {
		const corrected = fittedFontSize(area, chosen, target, cols, rows);
		if (corrected !== undefined && corrected < target) {
			probe.applyFont(corrected);
			const correctedCell = probe.measure();
			if (correctedCell !== undefined) chosen = correctedCell;
		}
	}
	return chosen;
}

/**
 * Clamps a proposed grid to the API's 1..1000 range. When either dimension is over the limit, both
 * are scaled down by the same factor, so an oversized 80:24 proposal stays 80:24 instead of becoming
 * a square; rounding every dimension down keeps the result inside the range.
 */
function clampGrid(cols: number, rows: number): TerminalDimensions {
	const scale = Math.min(1, MAX_DIMENSION / Math.max(1, cols), MAX_DIMENSION / Math.max(1, rows));
	return {
		cols: clampDimension(Math.floor(cols * scale)),
		rows: clampDimension(Math.floor(rows * scale)),
	};
}

/**
 * The grid that fills `area` at the default font while keeping the terminal's default 80:24 shape.
 * The width sets the columns and the shape sets the rows; when those rows are taller than the area's
 * height budget, the height sets the rows instead and the narrower grid keeps the same shape (the
 * viewer centres it). `cell` is measured at exactly `BASE_FONT_SIZE`, so the answer is the same
 * whatever font the current grid forced on the viewer. Returns undefined while the viewer has no
 * usable measurement.
 */
export function fitGrid(area: FitArea, cell: CellMetrics): TerminalDimensions | undefined {
	if (!positive(area.width) || !positive(area.height) || !positive(cell.width) || !positive(cell.height)) {
		return undefined;
	}
	const maxCols = Math.floor(area.width / cell.width);
	const maxRows = Math.floor(area.height / cell.height);
	// Fill the width first: the 80:24 shape gives the rows, so extra height never stretches the grid.
	let cols = maxCols;
	let rows = Math.floor((cols * DEFAULT_ROWS) / DEFAULT_COLS);
	if (rows > maxRows) {
		// The height is the constraint, so keep the shape and leave the free width on both sides.
		rows = maxRows;
		cols = Math.floor((rows * DEFAULT_COLS) / DEFAULT_ROWS);
	}
	return clampGrid(cols, rows);
}
