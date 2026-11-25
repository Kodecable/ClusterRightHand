import { fireEvent, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { TrafficNextResetDialog } from "./traffic-dialogs";

/**
 * The datetime control has no zone of its own: the label must name the zone of the chosen instant, which
 * across a daylight-saving change is not the zone of today (doc/design/metrics.md "Traffic totals").
 */
describe("TrafficNextResetDialog", () => {
	const previousTz = process.env.TZ;

	beforeAll(() => {
		process.env.TZ = "America/New_York";
	});
	afterAll(() => {
		process.env.TZ = previousTz;
	});
	beforeEach(() => {
		// February is EST in New York; the chosen March instant is EDT.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-02-20T17:00:00.000Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("labels the zone at the chosen instant, not today's zone", async () => {
		renderWithI18n(
			<TrafficNextResetDialog nodeId="node-1" nextResetAt="2026-03-20T16:00:00.000Z" onClose={() => {}} />,
		);
		expect(await screen.findByText(/Time \(EDT\)/)).toBeInTheDocument();
	});

	test("falls back to now for an invalid control value", async () => {
		renderWithI18n(<TrafficNextResetDialog nodeId="node-1" nextResetAt={null} onClose={() => {}} />);
		const input = await screen.findByLabelText(/Time \(/);
		fireEvent.change(input, { target: { value: "" } });
		// The empty value has no zone of its own: the label uses the current zone (EST on the frozen date).
		expect(await screen.findByText(/Time \(EST\)/)).toBeInTheDocument();
	});
});
