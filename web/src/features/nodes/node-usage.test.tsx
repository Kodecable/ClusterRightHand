import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { NodeUsage } from "./node-usage";

describe("NodeUsage", () => {
	test("shows the latest CPU and memory percentages", () => {
		renderWithI18n(
			<NodeUsage
				metrics={{
					at: "2026-06-01T10:00:00.000Z",
					up: 1,
					cpu: 0.5,
					memUsed: 0.25,
					stale: false,
				}}
			/>,
		);
		const figures = screen.getByTestId("node-metrics-figures");
		expect(figures).toHaveTextContent("CPU50%");
		expect(figures).toHaveTextContent("Mem25%");
		expect(figures).not.toHaveClass("opacity-50");
	});

	test("keeps the compact bar as the default size used by the table and cards", () => {
		renderWithI18n(
			<NodeUsage metrics={{ at: "2026-06-01T10:00:00.000Z", up: 1, cpu: 0.5, memUsed: 0.25, stale: false }} />,
		);
		const bars = [...screen.getByTestId("node-metrics-figures").querySelectorAll("[data-tone]")];
		expect(bars).toHaveLength(2);
		for (const bar of bars) {
			expect(bar).toHaveAttribute("data-size", "sm");
			expect(bar.querySelector("[aria-hidden='true']")).toHaveClass("h-1.5", "w-14");
			expect(bar.lastElementChild).toHaveClass("w-8", "text-[11px]", "leading-none");
		}
	});

	test("renders nothing without a sample", () => {
		renderWithI18n(<NodeUsage metrics={undefined} />);
		expect(screen.queryByTestId("node-metrics-figures")).not.toBeInTheDocument();
	});

	test("colours the bars amber from 60 % and red from 80 %", () => {
		const view = renderWithI18n(
			<NodeUsage metrics={{ at: "2026-06-01T10:00:00.000Z", up: 1, cpu: 0.59, memUsed: 0.6, stale: false }} />,
		);
		const toneOf = () =>
			[...screen.getByTestId("node-metrics-figures").querySelectorAll("[data-tone]")].map((row) =>
				row.getAttribute("data-tone"),
			);
		expect(toneOf()).toEqual(["ok", "warn"]);
		view.unmount();

		renderWithI18n(
			<NodeUsage metrics={{ at: "2026-06-01T10:00:00.000Z", up: 1, cpu: 0.8, memUsed: 0.79, stale: false }} />,
		);
		expect(toneOf()).toEqual(["danger", "warn"]);
	});

	test("dims a stale sample and marks it as stale", () => {
		renderWithI18n(
			<NodeUsage metrics={{ at: "2026-06-01T10:00:00.000Z", up: 1, cpu: 0.1, memUsed: 0.2, stale: true }} />,
		);
		const figures = screen.getByTestId("node-metrics-figures");
		expect(figures).toHaveClass("opacity-50");
		expect(figures).toHaveAttribute("data-stale", "true");
	});
});
