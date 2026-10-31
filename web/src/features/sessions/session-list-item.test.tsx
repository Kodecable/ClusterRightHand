import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { SessionListItem } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { SessionListItemRow } from "./session-list-item";

const item = (overrides: Partial<SessionListItem> = {}): SessionListItem => ({
	id: "s1",
	title: "Deploy the cluster",
	ownerUserId: "me",
	ownerName: "Me",
	scheduleId: null,
	shared: false,
	state: "idle",
	waitingKind: null,
	updatedAt: new Date().toISOString(),
	...overrides,
});

describe("SessionListItemRow", () => {
	test("shows the title, the status and a relative time", async () => {
		await renderWithRouter(<SessionListItemRow item={item()} selected={false} tabIndex={0} />);
		expect(screen.getByText("Deploy the cluster")).toBeInTheDocument();
		expect(screen.getByTestId("session-status-dot")).not.toHaveAttribute("title");
		expect(screen.getByRole("img", { name: "Idle" })).toBeInTheDocument();
		expect(document.querySelector("time")).not.toBeNull();
	});

	test("an awaiting row names the wait as its tooltip", async () => {
		await renderWithRouter(
			<SessionListItemRow item={item({ state: "awaiting", waitingKind: "quota" })} selected={false} tabIndex={-1} />,
		);
		expect(screen.getByTestId("session-status-dot")).toHaveAttribute("title", "Waiting for a quota decision");
		expect(screen.getByRole("img", { name: "Awaiting" })).toBeInTheDocument();
	});

	test("scheduled and shared rows carry their markers", async () => {
		await renderWithRouter(
			<SessionListItemRow item={item({ scheduleId: "sched-1", shared: true })} selected={false} tabIndex={-1} />,
		);
		expect(screen.getByRole("img", { name: "Scheduled session" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Shared with you" })).toBeInTheDocument();
		// A shared row shows no owner line; the list's scope says whose it is.
		expect(screen.queryByTestId("session-owner")).not.toBeInTheDocument();
	});

	test("the selected row is marked current", async () => {
		await renderWithRouter(<SessionListItemRow item={item()} selected tabIndex={0} />);
		const link = screen.getByTestId("session-item");
		expect(link).toHaveAttribute("aria-current", "page");
		expect(link).toHaveAttribute("data-selected", "true");
		expect(link).toHaveAttribute("href", "/sessions/s1");
	});
});
