import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { formatDateTimeSeconds } from "@/lib/format";
import { renderWithI18n } from "@/test/render";
import { NodeLastSeen } from "./node-last-seen";

const LAST_SEEN = "2026-01-01T00:00:05.000Z";

afterEach(() => {
	vi.useRealTimers();
});

describe("NodeLastSeen", () => {
	test("a connected node shows Now, with the connection time as its title", () => {
		renderWithI18n(<NodeLastSeen lastSeenAt={LAST_SEEN} connected />);
		const now = screen.getByText("Now");
		expect(now).toHaveAttribute("title", `Connected since ${formatDateTimeSeconds(LAST_SEEN, "en")}`);
		// The value keeps the cell's normal typography, like RelativeTime.
		expect(now).not.toHaveClass("text-muted-foreground");
		expect(now).not.toHaveClass("text-xs");
	});

	test("a connected node without a last-seen time shows Now without a title", () => {
		renderWithI18n(<NodeLastSeen lastSeenAt={null} connected />);
		expect(screen.getByText("Now")).not.toHaveAttribute("title");
	});

	test("a disconnected node keeps the relative time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:05:05.000Z"));
		renderWithI18n(<NodeLastSeen lastSeenAt={LAST_SEEN} connected={false} />);
		expect(screen.queryByText("Now")).not.toBeInTheDocument();
		expect(screen.getByText("5 min. ago")).toBeInTheDocument();
	});

	test("an SSH node (connected null) keeps the relative time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:05:05.000Z"));
		renderWithI18n(<NodeLastSeen lastSeenAt={LAST_SEEN} connected={null} />);
		expect(screen.queryByText("Now")).not.toBeInTheDocument();
		expect(screen.getByText("5 min. ago")).toBeInTheDocument();
	});
});
