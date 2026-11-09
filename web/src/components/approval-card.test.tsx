import type { ApprovalBody, Evaluation, TaskGroupView, TaskView } from "@crh/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ApprovalCard, DecisionView } from "./approval-card";

const evaluation: Evaluation = {
	result: "require-approval",
	levels: [
		{
			scope: { type: "user", id: "u1" },
			own: "require-approval",
			rule: 0,
			matched: { action: "require-approval", method: "exec", prefix: "systemctl " },
			effective: "require-approval",
		},
		{ scope: { type: "api_token", id: "tok-1" }, own: "inherit", effective: "require-approval" },
	],
};

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "systemctl restart nginx",
		operation: { method: "exec", target: "systemctl restart nginx" },
		actorType: "api_token",
		actorId: "tok-1",
		onBehalfOfUserId: null,
		state: "awaiting_approval",
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		approval: { evaluation },
		...overrides,
	}) as TaskView;

const nodeNames = new Map([["node-1", "worker-01"]]);
const tokenNames = new Map([["tok-1", "deploy bot"]]);

describe("ApprovalCard", () => {
	test("shows what is asked and the rule chain", () => {
		renderWithI18n(
			<ApprovalCard
				item={{ kind: "task", task: task() }}
				nodeNames={nodeNames}
				tokenNames={tokenNames}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText(/systemctl restart nginx/)).toBeInTheDocument();
		expect(screen.getAllByText(/deploy bot/).length).toBeGreaterThan(0);
		expect(screen.getByRole("table", { name: "Rule chain evaluation" })).toBeInTheDocument();
		expect(screen.getAllByText("Require approval").length).toBeGreaterThan(0);
		// The inherited level says so in words too, not as the raw "inherit".
		expect(screen.getByText("Inherit")).toBeInTheDocument();
		expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
	});

	test("approve decides immediately", () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		renderWithI18n(<ApprovalCard item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "approve" });
	});

	test("reject sends the trimmed reason", () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		renderWithI18n(<ApprovalCard item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />);
		fireEvent.change(screen.getByLabelText("Reason (optional, used when rejecting)"), {
			target: { value: "  not now  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "reject", reason: "not now" });
	});

	test("approve and always allow builds the allow rule for the operation", () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		renderWithI18n(<ApprovalCard item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow…" }));
		const textarea = screen.getByLabelText("Rule to add to the caller's rule set");
		expect((textarea as HTMLTextAreaElement).value).toContain('"action": "allow"');
		expect((textarea as HTMLTextAreaElement).value).toContain('"nodes": [\n    "worker-01"');
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: {
				action: "allow",
				method: "exec",
				nodes: ["worker-01"],
				privileged: false,
				exact: "systemctl restart nginx",
			},
		});
	});

	test("an invalid rule is refused locally", () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		renderWithI18n(<ApprovalCard item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow…" }));
		fireEvent.change(screen.getByLabelText("Rule to add to the caller's rule set"), { target: { value: "[]" } });
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("expected a rule object");
	});

	test("a decision shows a coloured status and the asked-by actor label", () => {
		renderWithI18n(
			<DecisionView
				decision={{ decision: "approved", by: { type: "api_token", id: "tok-1" }, at: "2026-01-01T00:00:00.000Z" }}
				tokenNames={tokenNames}
			/>,
		);
		expect(screen.getByText("Approved")).toBeInTheDocument();
		expect(screen.getByText("API token deploy bot")).toBeInTheDocument();
		expect(screen.queryByText(/api_token/)).not.toBeInTheDocument();
	});

	test("a task group shows one evaluation per node and one entry", () => {
		const taskGroup = {
			id: "group-1",
			kind: "exec",
			summary: "restart",
			nodeIds: ["node-1", "node-2"],
			privileged: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			actorType: "user",
			actorId: "u1",
			operation: { method: "exec", target: "systemctl restart nginx" },
			approval: {
				nodes: [
					{ nodeId: "node-1", evaluation },
					{ nodeId: "node-2", evaluation },
				],
			},
		} as unknown as TaskGroupView;
		renderWithI18n(
			<ApprovalCard
				item={{ kind: "task_group", taskGroup }}
				nodeNames={
					new Map([
						["node-1", "worker-01"],
						["node-2", "worker-02"],
					])
				}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getAllByRole("table", { name: "Rule chain evaluation" })).toHaveLength(2);
		const card = screen.getByRole("region", { name: /Task group group-1/ });
		expect(within(card).getAllByText(/worker-01/).length).toBeGreaterThan(0);
	});
});
