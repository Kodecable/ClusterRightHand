import { i18n } from "@lingui/core";
import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { activateLocale, renderWithI18n } from "@/test/render";
import { ClockWarning, clockWarningText } from "./clock-warning";

const AHEAD = { offsetMs: 120_000, thresholdMs: 60_000 };
const BEHIND = { offsetMs: -12_500, thresholdMs: 60_000 };

describe("clockWarningText", () => {
	test("says ahead or behind with the measured seconds", () => {
		activateLocale("en");
		expect(clockWarningText(i18n, AHEAD)).toBe(
			"The node's clock is 120 s ahead of crhs (measured once when crha connects)",
		);
		expect(clockWarningText(i18n, BEHIND)).toBe(
			"The node's clock is 12.5 s behind crhs (measured once when crha connects)",
		);
	});

	test("is translated to Chinese", () => {
		activateLocale("zh-CN");
		expect(clockWarningText(i18n, AHEAD)).toBe("节点时钟比 crhs 快 120 秒（仅在 crha 连接时测量一次）");
		expect(clockWarningText(i18n, BEHIND)).toBe("节点时钟比 crhs 慢 12.5 秒（仅在 crha 连接时测量一次）");
	});
});

describe("ClockWarning", () => {
	test("puts the localized text in the tooltip and renders nothing without a warning", () => {
		const { container, rerender } = renderWithI18n(<ClockWarning warning={BEHIND} />);
		expect(screen.getByText("clock")).toHaveAttribute(
			"title",
			"The node's clock is 12.5 s behind crhs (measured once when crha connects)",
		);
		rerender(<ClockWarning warning={null} />);
		expect(container).toBeEmptyDOMElement();
	});
});
