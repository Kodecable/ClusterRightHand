import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { DateTime, RelativeTime } from "./relative-time";

const TIMESTAMP = "2026-01-01T00:00:05.000Z";

describe("RelativeTime", () => {
	test("inherits the surrounding typography and keeps the absolute time in title", () => {
		const { container } = renderWithI18n(<RelativeTime value={TIMESTAMP} />);
		const time = container.querySelector("time");
		expect(time).not.toBeNull();
		expect(time?.getAttribute("title")).toMatch(/\d{2}:\d{2}:\d{2}/);
		expect(time).not.toHaveClass("text-muted-foreground");
		expect(time).not.toHaveClass("text-xs");
		expect(time).toHaveClass("tabular-nums");
	});
});

describe("DateTime", () => {
	test("always shows seconds, whatever the caller", () => {
		renderWithI18n(<DateTime value={TIMESTAMP} />);
		const time = screen.getByText(/\d{2}:\d{2}:\d{2}/);
		expect(time).toHaveAttribute("datetime", TIMESTAMP);
	});

	test("an empty value is an en dash", () => {
		renderWithI18n(<DateTime value={null} />);
		expect(screen.getByText("–")).toBeInTheDocument();
	});
});
