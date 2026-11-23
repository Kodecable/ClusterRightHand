import { describe, expect, test } from "vitest";
import { BASE_FONT_SIZE, fitGrid, MAX_DIMENSION } from "./fit";

describe("fitGrid", () => {
	test("uses the area and the cell metrics scaled to the default font size", () => {
		const area = { width: 650, height: 260 };
		// The viewer scaled to twice the default font has twice the cell metrics.
		const cell = { width: 10, height: 20 };
		expect(fitGrid(area, cell, BASE_FONT_SIZE * 2)).toEqual({ rows: 26, cols: 130 });
		// Using the current font's metrics as if they were the default would ask for half the grid.
		expect(fitGrid(area, cell, BASE_FONT_SIZE)).toEqual({ rows: 13, cols: 65 });
	});

	test("the area size decides the whole grid", () => {
		const cell = { width: 8, height: 16 };
		expect(fitGrid({ width: 800, height: 480 }, cell, BASE_FONT_SIZE)).toEqual({ rows: 30, cols: 100 });
		expect(fitGrid({ width: 400, height: 480 }, cell, BASE_FONT_SIZE)).toEqual({ rows: 30, cols: 50 });
		expect(fitGrid({ width: 800, height: 240 }, cell, BASE_FONT_SIZE)).toEqual({ rows: 15, cols: 100 });
	});

	test("keeps rows and columns inside 1..1000", () => {
		expect(fitGrid({ width: 10_000, height: 10_000 }, { width: 1, height: 1 }, BASE_FONT_SIZE)).toEqual({
			rows: MAX_DIMENSION,
			cols: MAX_DIMENSION,
		});
		expect(fitGrid({ width: 1, height: 1 }, { width: 100, height: 100 }, BASE_FONT_SIZE)).toEqual({
			rows: 1,
			cols: 1,
		});
	});

	test("has no answer while the viewer has no usable measurement", () => {
		const area = { width: 800, height: 480 };
		const cell = { width: 8, height: 16 };
		expect(fitGrid({ ...area, width: 0 }, cell, BASE_FONT_SIZE)).toBeUndefined();
		expect(fitGrid({ ...area, height: Number.NaN }, cell, BASE_FONT_SIZE)).toBeUndefined();
		expect(fitGrid(area, { ...cell, width: 0 }, BASE_FONT_SIZE)).toBeUndefined();
		expect(fitGrid(area, cell, 0)).toBeUndefined();
	});
});
