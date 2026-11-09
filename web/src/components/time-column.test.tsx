import { describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import type { DataTableColumn } from "./data-table";
import { DataTable } from "./data-table";
import {
	COMPACT_TIME_CELL_PADDING_PX,
	measureTimeColumnWidth,
	TIME_CELL_PADDING_PX,
	type TimeColumnDensity,
	timeColumnSample,
	useTimeColumnWidth,
} from "./time-column";

/**
 * jsdom lays nothing out: every `getBoundingClientRect` is zero, which the
 * module treats as "no measurement available" (the 180px fallback). Mock the
 * hidden probe's rect so the laid-out text width is known exactly, and collect
 * the measured element so its classes can be checked. `restoreMocks` undoes
 * this after each test.
 */
function stubTextWidth(width: number): HTMLElement[] {
	const probes: HTMLElement[] = [];
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
		probes.push(this);
		return {
			width,
			height: 20,
			top: 0,
			left: -10000,
			right: width,
			bottom: 20,
			x: -10000,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect;
	});
	return probes;
}

function TimeTable({
	density,
	columns,
}: {
	density?: TimeColumnDensity;
	columns: (width: number) => DataTableColumn<{ id: string }>[];
}) {
	const width = useTimeColumnWidth(density);
	return <DataTable label="Times" columns={columns(width)} data={[{ id: "row-1" }]} />;
}

function timeTable(density?: TimeColumnDensity) {
	return (
		<TimeTable
			density={density}
			columns={(width) => [{ id: "created", header: "Created", size: width, cell: () => "a timestamp" }]}
		/>
	);
}

describe("time column width", () => {
	test("measures the cell padding plus the sample's laid-out width", () => {
		// The hidden probe reports the text width; the column adds the cell's
		// horizontal padding, rounds up, and keeps 2px of safety.
		stubTextWidth(145.5);
		expect(measureTimeColumnWidth("en", "default")).toBe(Math.ceil(145.5 + TIME_CELL_PADDING_PX) + 2);
		expect(measureTimeColumnWidth("en", "compact")).toBe(Math.ceil(145.5 + COMPACT_TIME_CELL_PADDING_PX) + 2);
	});

	test("the probe carries the cell typography and the locale's sample", () => {
		const probes = stubTextWidth(140);
		measureTimeColumnWidth("zh-CN", "default");

		// The probe must be laid out with the classes a `DateTime` cell renders:
		// the table's text size plus the timestamp's own tabular digits.
		expect(probes[0]?.className).toBe("text-sm tabular-nums");
		expect(probes[0]?.textContent).toBe(timeColumnSample("zh-CN"));
		expect(probes[0]?.style.position).toBe("absolute");
		expect(probes[0]?.style.visibility).toBe("hidden");
		expect(probes[0]?.style.whiteSpace).toBe("nowrap");
		expect(probes[0]?.style.pointerEvents).toBe("none");
		// A probe must never linger in the document.
		expect(probes[0]?.isConnected).toBe(false);

		// A compact table measures the smaller cell font.
		measureTimeColumnWidth("zh-CN", "compact");
		expect(probes[1]?.className).toBe("text-xs tabular-nums");
	});

	test("a time column puts the measured width into the shared template", () => {
		// 147px of text (what Chromium lays out for "2026/12/28 23:58:58") plus
		// 24px of cell padding, rounded up, plus the 2px safety margin.
		stubTextWidth(147);
		const { container } = renderWithI18n(timeTable());
		const frame = container.querySelector<HTMLElement>('[data-slot="data-table"]');
		if (frame === null) throw new Error("no data table frame");

		// Header and every body row share the template, and the table's minimum
		// width counts the measured column like any other fixed one.
		expect(frame.style.getPropertyValue("--dt-columns")).toBe("173px");
		expect(frame.style.getPropertyValue("--dt-min-width")).toBe("173px");
		expect(frame.style.getPropertyValue("--dt-narrow-width")).toBe("173px");
	});

	test("falls back to 180px where layout is unavailable", () => {
		// Without the rect mock jsdom reports a zero-size probe, the same as a
		// browser before layout and a server render (which has no document).
		// The compact density is used because the measured width is cached per
		// locale and density.
		expect(measureTimeColumnWidth("en", "default")).toBeNull();
		const { container } = renderWithI18n(timeTable("compact"));
		const frame = container.querySelector<HTMLElement>('[data-slot="data-table"]');
		if (frame === null) throw new Error("no data table frame");

		expect(frame.style.getPropertyValue("--dt-columns")).toBe("180px");
		expect(frame.style.getPropertyValue("--dt-min-width")).toBe("180px");
	});
});
