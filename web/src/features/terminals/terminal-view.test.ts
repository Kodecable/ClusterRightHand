import type { Terminal } from "@xterm/xterm";
import { describe, expect, test } from "vitest";
import { viewportHeightBudget } from "./fit";
import { measureCell, measureCellAt, unscrolledTop } from "./terminal-view";

const COLS = 80;
const ROWS = 24;

/** A terminal whose screen box is `(fontSize / 13) × cell`, so the measured font is visible. */
function fakeTerminal(fontSize: number | undefined): { terminal: Terminal; options: { fontSize?: number } } {
	const options: { fontSize?: number } = { fontSize };
	const element = {
		querySelector: () => ({
			getBoundingClientRect: () => {
				const scale = (options.fontSize ?? 13) / 13;
				return { width: 10 * COLS * scale, height: 20 * ROWS * scale };
			},
		}),
	};
	return { terminal: { element, cols: COLS, rows: ROWS, options } as unknown as Terminal, options };
}

describe("measureCell", () => {
	test("turns the screen box into one cell at the current font", () => {
		const { terminal } = fakeTerminal(13);
		expect(measureCell(terminal)).toEqual({ width: 10, height: 20 });
	});

	test("has no answer without a rendered screen", () => {
		const { terminal } = fakeTerminal(13);
		(terminal as unknown as { element: undefined }).element = undefined;
		expect(measureCell(terminal)).toBeUndefined();
	});
});

describe("measureCellAt", () => {
	test("measures at exactly the default font and restores the viewer's font", () => {
		// The viewer is pinned at the minimum by a huge grid; scaling that cell linearly would be wrong.
		const { terminal, options } = fakeTerminal(6);
		expect(measureCellAt(terminal, 13)).toEqual({ width: 10, height: 20 });
		expect(options.fontSize).toBe(6);
	});

	test("measures at a smaller font too, restoring afterwards", () => {
		const { terminal, options } = fakeTerminal(26);
		const cell = measureCellAt(terminal, 6);
		expect(cell?.width).toBeCloseTo(10 * (6 / 13));
		expect(cell?.height).toBeCloseTo(20 * (6 / 13));
		expect(options.fontSize).toBe(26);
	});

	test("does not touch the option when it is already at the font to measure", () => {
		const { terminal, options } = fakeTerminal(13);
		expect(measureCellAt(terminal, 13)).toEqual({ width: 10, height: 20 });
		expect(options.fontSize).toBe(13);
	});
});

describe("unscrolledTop", () => {
	/** Only the top of a client rect is read, so a partial rect is enough for these tests. */
	function rectAt(top: number): DOMRect {
		return { top } as unknown as DOMRect;
	}

	test("adds back the scroll offsets of the scrolling ancestors", () => {
		const outer = document.createElement("div");
		const page = document.createElement("div");
		const box = document.createElement("div");
		outer.append(page);
		page.append(box);
		document.body.append(outer);
		outer.scrollTop = 30;
		page.scrollTop = 120;
		// The box is 180px down the unscrolled page; after 150px of scrolling its client rect starts at 30.
		box.getBoundingClientRect = () => rectAt(30);

		expect(unscrolledTop(box)).toBe(180);

		outer.remove();
	});

	test("keeps the height budget when the page scrolls", () => {
		const page = document.createElement("div");
		const box = document.createElement("div");
		page.append(box);
		document.body.append(page);
		const unscrolledBoxTop = 236;
		const extraKeys = 36;
		const boxChrome = 18;
		const budget = () => viewportHeightBudget(window.innerHeight, unscrolledTop(box), extraKeys, boxChrome);

		box.getBoundingClientRect = () => rectAt(unscrolledBoxTop);
		const atTop = budget();
		expect(atTop).toBe(window.innerHeight - unscrolledBoxTop - extraKeys - boxChrome);

		// Scrolling moves the client rect up by exactly the scroll offset; the budget must not move.
		page.scrollTop = 150;
		box.getBoundingClientRect = () => rectAt(unscrolledBoxTop - 150);
		expect(budget()).toBe(atTop);

		page.remove();
	});
});
