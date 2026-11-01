import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { QuotaCard, type QuotaDecision } from "./quota-card";

const wait = {
	sessionId: "s1",
	levelId: "lvl-root",
	title: "Nightly cluster check",
	since: "2026-01-01T00:00:00.000Z",
	budgetRemaining: -300,
	budgetUsedTokens: 12_000,
};

describe("QuotaCard", () => {
	test("shows the session, the used-up quota and the level", async () => {
		await renderWithRouter(<QuotaCard wait={wait} onDecide={() => {}} />);
		expect(screen.getByRole("link", { name: "Nightly cluster check" })).toHaveAttribute("href", "/sessions/s1");
		expect(screen.getByText(/Budget used up \(300 over\)/)).toBeInTheDocument();
		expect(screen.getByText("lvl-root")).toBeInTheDocument();
	});

	test("rejects a non-numeric amount without deciding", async () => {
		const onDecide = vi.fn<(decision: QuotaDecision) => void>();
		await renderWithRouter(<QuotaCard wait={wait} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Tokens to add"), { target: { value: "abc" } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onDecide).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number of tokens");
	});

	test("rejects zero tokens", async () => {
		const onDecide = vi.fn<(decision: QuotaDecision) => void>();
		await renderWithRouter(<QuotaCard wait={wait} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Tokens to add"), { target: { value: "0" } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onDecide).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("Enter a positive number of tokens to add.");
	});

	test("adds the typed amount", async () => {
		const onDecide = vi.fn<(decision: QuotaDecision) => void>();
		await renderWithRouter(<QuotaCard wait={wait} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Tokens to add"), { target: { value: " 100 " } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "approve", tokens: 100 });
	});

	test("stop denies the quota", async () => {
		const onDecide = vi.fn<(decision: QuotaDecision) => void>();
		await renderWithRouter(<QuotaCard wait={wait} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "deny" });
	});
});
