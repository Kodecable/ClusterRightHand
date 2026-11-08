import type { SessionListItem } from "@crh/api";
import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
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
	test("shows only the title, with no owner and no relative time", async () => {
		await renderWithRouter(<SessionListItemRow item={item()} selected={false} tabIndex={0} />);
		expect(screen.getByText("Deploy the cluster")).toBeInTheDocument();
		expect(document.querySelector("time")).toBeNull();
		expect(screen.queryByTestId("session-owner")).not.toBeInTheDocument();
		// The dot's slot is reserved so titles line up, but an idle row has no dot.
		const slot = screen.getByTestId("session-status-dot");
		expect(slot).toBeInTheDocument();
		expect(slot.querySelector("[role='img']")).toBeNull();
	});

	test("a session with no title yet shows the default name", async () => {
		await renderWithRouter(<SessionListItemRow item={item({ title: null })} selected={false} tabIndex={-1} />);
		expect(screen.getByText("New Session")).toBeInTheDocument();
	});

	test("a running row shows the dot", async () => {
		await renderWithRouter(<SessionListItemRow item={item({ state: "running" })} selected={false} tabIndex={-1} />);
		expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
	});

	test("an awaiting row shows the dot and names the wait in its tooltip and to screen readers", async () => {
		await renderWithRouter(
			<SessionListItemRow item={item({ state: "awaiting", waitingKind: "quota" })} selected={false} tabIndex={-1} />,
		);
		expect(screen.getByRole("img", { name: "Awaiting" })).toBeInTheDocument();
		expect(screen.getByTestId("session-item")).toHaveAttribute("title", "Waiting for a quota decision");
		expect(screen.getByTestId("session-status-dot")).toHaveTextContent("Waiting for a quota decision");
	});

	test("scheduled and shared sessions get grey badges at the end of the line", async () => {
		await renderWithRouter(
			<SessionListItemRow
				item={item({ scheduleId: "sched-1", shared: true, ownerName: "Ada" })}
				selected={false}
				tabIndex={-1}
			/>,
		);
		const markers = screen.getByTestId("session-markers");
		expect(markers).toHaveTextContent("Scheduled");
		expect(markers).toHaveTextContent("Shared");
		expect(screen.getByTitle("Shared with you by Ada")).toBeInTheDocument();
		expect(screen.getByTestId("session-item")).not.toHaveAttribute("title");
	});

	test("an own, unscheduled session has no badges", async () => {
		await renderWithRouter(<SessionListItemRow item={item()} selected={false} tabIndex={-1} />);
		expect(screen.queryByTestId("session-markers")).not.toBeInTheDocument();
	});

	test("the selected row is marked current", async () => {
		await renderWithRouter(<SessionListItemRow item={item()} selected tabIndex={0} />);
		const link = screen.getByTestId("session-item");
		expect(link).toHaveAttribute("aria-current", "page");
		expect(link).toHaveAttribute("data-selected", "true");
		expect(link).toHaveAttribute("href", "/sessions/s1");
	});
});
