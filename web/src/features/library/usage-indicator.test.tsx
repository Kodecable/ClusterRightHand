import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { LibraryUsageIndicator } from "./usage-indicator";

const LIMITS = { files: 100, fileBytes: 1024, totalBytes: 100 * 1024 * 1024 };

describe("LibraryUsageIndicator", () => {
	test("shows the total size share and both limits in a tooltip", async () => {
		renderWithI18n(<LibraryUsageIndicator usage={{ files: 1, bytes: 1024 * 1024 }} limits={LIMITS} />);
		const usage = screen.getByTestId("library-usage");
		expect(usage).toHaveTextContent("1%");
		expect(usage.querySelector('[data-slot="progress"]')).not.toHaveClass("[&_[data-slot=progress-indicator]]:bg-warn");

		await userEvent.hover(usage);
		expect(await screen.findByText("File count limit: 1% (1/100)")).toBeVisible();
		expect(screen.getByText("Total size limit: 1% (1 MiB/100 MiB)")).toBeVisible();
	});

	test("turns the bar to the warning colour near a limit", () => {
		renderWithI18n(<LibraryUsageIndicator usage={{ files: 95, bytes: 10 * 1024 * 1024 }} limits={LIMITS} />);
		const progress = screen.getByTestId("library-usage").querySelector('[data-slot="progress"]');
		expect(progress?.className).toContain("bg-warn");
	});
});
