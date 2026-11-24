import { describe, expect, test } from "vitest";
import {
	BASE_FONT_SIZE,
	clampFontSize,
	fitCellFont,
	fitGrid,
	fittedFontSize,
	gridOverflows,
	MAX_DIMENSION,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
	viewportHeightBudget,
} from "./fit";

describe("fittedFontSize", () => {
	// A cell measured at the default font, in CSS pixels: a monospace glyph plus xterm's line height.
	const cell = { width: 7.8, height: 15.6 };

	test("the width decides the font when the height budget has room", () => {
		const area = { width: 1000, height: 1000 };
		const fontSize = fittedFontSize(area, cell, BASE_FONT_SIZE, 80, 24);
		expect(fontSize).toBeCloseTo(20.4, 1);
		// The grid the width asks for is narrower than the area and well inside the height budget.
		if (fontSize === undefined) throw new Error("no font");
		const scale = fontSize / BASE_FONT_SIZE;
		expect(cell.width * 80 * scale).toBeLessThanOrEqual(area.width);
		expect(cell.width * 80 * scale).toBeGreaterThan(area.width * 0.95);
		expect(cell.height * 24 * scale).toBeLessThan(area.height);
	});

	test("the height budget caps the font when the grid would stand taller than it", () => {
		// A tall, narrow grid: at the width's font it would be several screens high.
		const area = { width: 1000, height: 300 };
		const fontSize = fittedFontSize(area, cell, BASE_FONT_SIZE, 20, 20);
		if (fontSize === undefined) throw new Error("no font");
		const scale = fontSize / BASE_FONT_SIZE;
		expect(cell.height * 20 * scale).toBeLessThanOrEqual(area.height);
		expect(cell.height * 20 * scale).toBeGreaterThan(area.height * 0.95);
		expect(cell.width * 20 * scale).toBeLessThan(area.width / 2);
	});

	test("scales the cell metrics from the font they were measured at", () => {
		// A cell measured at twice the default font is twice as large; the answer is the same.
		const area = { width: 1000, height: 1000 };
		expect(fittedFontSize(area, { width: 15.6, height: 31.2 }, BASE_FONT_SIZE * 2, 80, 24)).toBe(
			fittedFontSize(area, cell, BASE_FONT_SIZE, 80, 24),
		);
	});

	test("keeps the font inside MIN_FONT_SIZE..MAX_FONT_SIZE", () => {
		expect(fittedFontSize({ width: 10, height: 10 }, cell, BASE_FONT_SIZE, 80, 24)).toBe(MIN_FONT_SIZE);
		expect(fittedFontSize({ width: 100_000, height: 100_000 }, cell, BASE_FONT_SIZE, 2, 2)).toBe(MAX_FONT_SIZE);
	});

	test("has no answer without a usable measurement", () => {
		const area = { width: 800, height: 480 };
		expect(fittedFontSize({ ...area, width: 0 }, cell, BASE_FONT_SIZE, 80, 24)).toBeUndefined();
		expect(fittedFontSize(area, { ...cell, height: Number.NaN }, BASE_FONT_SIZE, 80, 24)).toBeUndefined();
		expect(fittedFontSize(area, cell, 0, 80, 24)).toBeUndefined();
		expect(fittedFontSize(area, cell, BASE_FONT_SIZE, 0, 24)).toBeUndefined();
		expect(fittedFontSize(area, cell, BASE_FONT_SIZE, 80, 1.5)).toBeUndefined();
	});
});

describe("viewportHeightBudget", () => {
	test("uses the layout viewport and removes everything above and around the grid", () => {
		// The box starts 236px down an unscrolled page: the top bar, the back link, the heading, the
		// actions and the meta line all come out of the budget, along with the extra-keys bar (36px) and
		// the box's own padding and border (18px).
		expect(viewportHeightBudget(900, 236, 36, 18)).toBe(610);
		expect(viewportHeightBudget(900, 236, 0, 18)).toBe(646);
	});

	test("has no answer without a usable viewport", () => {
		expect(viewportHeightBudget(0, 236, 0, 18)).toBeUndefined();
		expect(viewportHeightBudget(Number.NaN, 236, 0, 18)).toBeUndefined();
		expect(viewportHeightBudget(40, 236, 0, 18)).toBeUndefined();
	});

	test("a missing measurement does not shrink the budget", () => {
		expect(viewportHeightBudget(900, Number.NaN, -20, Number.NaN)).toBe(900);
	});
});

describe("clampFontSize", () => {
	test("rounds to the 0.05 steps the viewer applies", () => {
		expect(clampFontSize(12.734)).toBe(12.75);
		expect(clampFontSize(12.7)).toBe(12.7);
	});

	test("keeps the legible range", () => {
		expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
		expect(clampFontSize(64)).toBe(MAX_FONT_SIZE);
		expect(clampFontSize(Number.NaN)).toBe(MIN_FONT_SIZE);
	});
});

describe("gridOverflows", () => {
	const area = { width: 800, height: 480 };

	test("an exact fit does not overflow", () => {
		expect(gridOverflows(area, { width: 10, height: 20 }, 80, 24)).toBe(false);
	});

	test("a rounded-up cell does overflow", () => {
		expect(gridOverflows(area, { width: 10.5, height: 20 }, 80, 24)).toBe(true);
		expect(gridOverflows(area, { width: 10, height: 20.5 }, 80, 24)).toBe(true);
	});

	test("a sub-pixel difference is rounding, not overflow", () => {
		expect(gridOverflows(area, { width: 10.001, height: 20.001 }, 80, 24)).toBe(false);
	});
});

describe("fitCellFont", () => {
	test("corrects the overflow that device-pixel rounding leaves after the first pass", () => {
		// The cell height is rounded to whole device pixels: it stays 18px until the font drops below
		// 11px. The linear first pass picks 11.3px, where the cell is still 18px tall, so the grid then
		// measures taller than the budget and the correction has to recompute from that cell.
		let fontSize = BASE_FONT_SIZE;
		const applied: number[] = [];
		const cellHeight = () => (fontSize >= 11 ? 18 : 14);
		const final = fitCellFont(810, 319, 80, 20, BASE_FONT_SIZE, {
			measure: () => ({ width: 10, height: cellHeight() }),
			applyFont: (next) => {
				applied.push(next);
				fontSize = next;
			},
		});

		expect(applied).toEqual([11.3, 9.8]);
		expect(final).toEqual({ width: 10, height: 14 });
		if (final === undefined) throw new Error("no cell");
		expect(final.height * 20).toBeLessThanOrEqual(319);
	});

	test("returns the cell measured at the font it settled on", () => {
		const applied: number[] = [];
		const final = fitCellFont(1000, 1000, 80, 24, BASE_FONT_SIZE, {
			measure: () => ({ width: 7.8, height: 15.6 }),
			applyFont: (fontSize) => {
				applied.push(fontSize);
			},
		});

		expect(applied).toEqual([20.4]);
		expect(final).toEqual({ width: 7.8, height: 15.6 });
	});

	test("has no answer while the cell cannot be measured", () => {
		const probe = {
			measure: () => undefined,
			applyFont: () => {
				throw new Error("must not apply a font without a measurement");
			},
		};
		expect(fitCellFont(800, 480, 80, 24, BASE_FONT_SIZE, probe)).toBeUndefined();
	});
});

describe("fitGrid", () => {
	test("uses the cell metrics measured at the default font", () => {
		const area = { width: 650, height: 260 };
		// The renderer measured one cell at exactly 13px, not scaled from another font.
		const cell = { width: 10, height: 20 };
		// 65 columns fill the width; the 80:24 shape would need 19 rows, more than the 13 the height
		// budget holds, so the height decides: 13 rows keep the shape at 43 columns.
		expect(fitGrid(area, cell)).toEqual({ rows: 13, cols: 43 });
	});

	test("fills the width while keeping the 80:24 shape", () => {
		const cell = { width: 8, height: 16 };
		// 100 columns ask for 30 rows; the 1000px area holds 62 rows, but none of that extra height is
		// used, so the grid keeps the default shape instead of stretching tall.
		expect(fitGrid({ width: 800, height: 1000 }, cell)).toEqual({ rows: 30, cols: 100 });
		expect(fitGrid({ width: 800, height: 480 }, cell)).toEqual({ rows: 30, cols: 100 });
	});

	test("the height decides and keeps the grid narrower when the shape would be too tall", () => {
		const cell = { width: 8, height: 16 };
		// 15 rows fit the area; the shape gives 50 columns instead of the 100 the width would hold, and
		// the viewer centres the narrower grid.
		expect(fitGrid({ width: 800, height: 240 }, cell)).toEqual({ rows: 15, cols: 50 });
		expect(fitGrid({ width: 800, height: 256 }, cell)).toEqual({ rows: 16, cols: 53 });
	});

	test("clamps both dimensions inside 1..1000 while keeping the 80:24 shape", () => {
		// A huge area proposes 10000 × 3000. Scaling both by the same factor keeps the shape instead of
		// squaring it off at 1000 × 1000.
		expect(fitGrid({ width: 10_000, height: 10_000 }, { width: 1, height: 1 })).toEqual({
			rows: 300,
			cols: MAX_DIMENSION,
		});
		// The lower bound keeps at least one row and one column.
		expect(fitGrid({ width: 1, height: 1 }, { width: 100, height: 100 })).toEqual({
			rows: 1,
			cols: 1,
		});
	});

	test("has no answer while the viewer has no usable measurement", () => {
		const area = { width: 800, height: 480 };
		const cell = { width: 8, height: 16 };
		expect(fitGrid({ ...area, width: 0 }, cell)).toBeUndefined();
		expect(fitGrid({ ...area, height: Number.NaN }, cell)).toBeUndefined();
		expect(fitGrid(area, { ...cell, width: 0 })).toBeUndefined();
		expect(fitGrid(area, { ...cell, height: Number.NaN })).toBeUndefined();
	});
});
