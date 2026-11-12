import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { type QuotaAnswer, QuotaDecision } from "./quota-decision";

const wait = {
	sessionId: "s1",
	levelId: "lvl-root",
	title: "Nightly cluster check",
	since: "2026-01-01T00:00:00.000Z",
	budgetRemaining: -300,
	budgetUsedTokens: 12_000,
};

describe("QuotaDecision", () => {
	test("shows the session and the used-up budget, and defaults to Add tokens", async () => {
		await renderWithRouter(<QuotaDecision wait={wait} onDecide={() => {}} />);
		expect(screen.getByRole("region", { name: "Token quota used up" })).toBeInTheDocument();
		expect(screen.getByText("Nightly cluster check")).toBeInTheDocument();
		expect(screen.getByText(/Budget used up \(300 over\)/)).toBeInTheDocument();
		// The level id and the request time are technical fields, not part of the decision.
		expect(screen.queryByText("lvl-root")).not.toBeInTheDocument();
		expect(screen.queryByText("Since")).not.toBeInTheDocument();
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Add tokens");
	});

	test("shows the default name when the session has no title yet", async () => {
		await renderWithRouter(<QuotaDecision wait={{ ...wait, title: null }} onDecide={() => {}} />);
		expect(screen.getByText("New Session")).toBeInTheDocument();
	});

	test("rejects a non-numeric amount without deciding", async () => {
		const onDecide = vi.fn<(decision: QuotaAnswer) => void>();
		await renderWithRouter(<QuotaDecision wait={wait} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Tokens to add"), { target: { value: "abc" } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onDecide).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number of tokens");
	});

	test("rejects zero tokens", async () => {
		const onDecide = vi.fn<(decision: QuotaAnswer) => void>();
		await renderWithRouter(<QuotaDecision wait={wait} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Tokens to add"), { target: { value: "0" } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onDecide).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("Enter a positive number of tokens to add.");
	});

	test("adds the typed amount", async () => {
		const onDecide = vi.fn<(decision: QuotaAnswer) => void>();
		await renderWithRouter(<QuotaDecision wait={wait} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Tokens to add"), { target: { value: " 100 " } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "approve", tokens: 100 });
	});

	test("the Stop tab stops the paused run", async () => {
		const onDecide = vi.fn<(decision: QuotaAnswer) => void>();
		await renderWithRouter(<QuotaDecision wait={wait} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("tab", { name: "Stop" }));
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "deny" });
	});
});
