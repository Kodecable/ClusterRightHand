import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithRouter } from "@/test/render";
import { DecisionCard } from "./decision";

/** The DOM order of two elements: true when `left` precedes `right`. */
function precedes(left: Element, right: Element): boolean {
	return (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("DecisionCard", () => {
	test("renders every slot in the chat card's order", async () => {
		await renderWithRouter(
			<DecisionCard
				title="Your approval is needed"
				privileged
				meta={<span>Nodes: worker-01</span>}
				metaText="Nodes: worker-01"
				risk="medium"
				reason="touches a system file"
				detail="systemctl restart nginx"
				count={<span>1 of 2</span>}
				details={<a href="/tasks/task-1">Task details</a>}
				kind="approval"
				variant="page"
			>
				<div>the tabs</div>
			</DecisionCard>,
		);
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toHaveAttribute("data-kind", "approval");
		expect(card).toHaveAttribute("data-variant", "page");
		expect(within(card).getByText("Privileged")).toBeInTheDocument();
		expect(within(card).getByText("1 of 2")).toBeInTheDocument();
		expect(within(card).getByRole("link", { name: "Task details" })).toHaveAttribute("href", "/tasks/task-1");

		const title = within(card).getByRole("heading", { name: "Your approval is needed" });
		const meta = within(card).getByTestId("decision-meta");
		const risk = within(card).getByTestId("decision-risk");
		const detail = within(card).getByTestId("decision-detail");
		const tabs = within(card).getByText("the tabs");
		expect(meta).toHaveAttribute("title", "Nodes: worker-01");
		expect(risk).toHaveTextContent("Medium risk");
		expect(within(risk).getByText("Medium risk").closest("[data-tone]")).toHaveAttribute("data-tone", "warn");
		expect(within(card).getByTestId("decision-reason")).toHaveTextContent("touches a system file");
		expect(within(card).getByTestId("decision-reason")).toHaveAttribute("title", "touches a system file");
		expect(detail).toHaveTextContent("systemctl restart nginx");
		expect(detail).toHaveAttribute("title", "systemctl restart nginx");
		expect(precedes(title, meta)).toBe(true);
		expect(precedes(meta, risk)).toBe(true);
		expect(precedes(risk, detail)).toBe(true);
		expect(precedes(detail, tabs)).toBe(true);
		// The divider sits between the summary and the tabs, with room on both sides.
		const tabsRegion = tabs.closest("[data-slot=decision-tabs]");
		expect(tabsRegion).toHaveClass("border-t", "pt-3");
		expect(card).toHaveClass("gap-3");
	});

	test("every slot except the title and children is optional", async () => {
		await renderWithRouter(
			<DecisionCard title="Token quota used up">
				<div>Add tokens</div>
			</DecisionCard>,
		);
		const card = screen.getByRole("region", { name: "Token quota used up" });
		expect(card).toHaveAttribute("data-variant", "inline");
		expect(within(card).queryByText("Privileged")).not.toBeInTheDocument();
		expect(within(card).queryByTestId("decision-meta")).not.toBeInTheDocument();
		expect(within(card).queryByTestId("decision-risk")).not.toBeInTheDocument();
		expect(within(card).queryByTestId("decision-reason")).not.toBeInTheDocument();
		expect(within(card).queryByTestId("decision-detail")).not.toBeInTheDocument();
	});

	test("a low risk stays neutral and a high risk is dangerous", async () => {
		const { unmount } = await renderWithRouter(
			<DecisionCard title="Low" risk="low" reason="a read">
				<div />
			</DecisionCard>,
		);
		expect(screen.getByTestId("decision-risk").textContent).toBe("Low risk");
		expect(screen.getByText("Low risk").closest("[data-tone]")).toHaveAttribute("data-tone", "muted");
		unmount();
		await renderWithRouter(
			<DecisionCard title="High" risk="high">
				<div />
			</DecisionCard>,
		);
		expect(screen.getByText("High risk").closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
	});
});
