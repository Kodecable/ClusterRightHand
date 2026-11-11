import type { ApprovalBody, Evaluation, TaskGroupView, TaskView } from "@crh/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ApprovalDecision } from "./approval-decision";

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
	],
};

const OPERATION = "/bin/sh -c 'cat /etc/shadow | head -n 3'";

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: OPERATION,
		operation: { method: "exec", target: OPERATION },
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

describe("ApprovalDecision", () => {
	test("shows the operation and node names on the default view, never the UUID", async () => {
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={() => {}} />,
		);
		expect(screen.getByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		const operation = screen.getByTestId("decision-operation");
		expect(operation.textContent).toBe(`exec  ${OPERATION}`);
		expect(operation).toHaveAttribute("title", `exec  ${OPERATION}`);
		expect(screen.getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		expect(screen.queryByText(/node-1/)).not.toBeInTheDocument();
		// The technical fields stay out of the default view.
		expect(screen.queryByText("Issued")).not.toBeInTheDocument();
		expect(screen.queryByText("Deadline")).not.toBeInTheDocument();
		expect(screen.queryByText("Attempt")).not.toBeInTheDocument();
	});

	test("the Approve tab is the default and approves immediately", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />,
		);
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Approve");
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "approve" });
	});

	test("the rule chain evaluation is collapsed until it is asked for", async () => {
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={() => {}} />,
		);
		const summary = screen.getByText("Rule chain evaluation");
		const details = summary.closest("details");
		expect(details).not.toBeNull();
		expect(details).not.toHaveAttribute("open");
		fireEvent.click(summary);
		expect(details).toHaveAttribute("open");
		expect(screen.getByRole("table", { name: "Rule chain evaluation" })).toBeInTheDocument();
		expect(screen.getAllByText("Require approval").length).toBeGreaterThan(0);
	});

	test("the Always allow tab builds the prefilled allow rule", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Always allow" }));
		const textarea = screen.getByLabelText("Rule to add to the caller's rule set");
		expect((textarea as HTMLTextAreaElement).value).toContain('"action": "allow"');
		expect((textarea as HTMLTextAreaElement).value).toContain('"nodes": [\n    "worker-01"');
		fireEvent.click(screen.getByRole("radio", { name: "prefix" }));
		expect((textarea as HTMLTextAreaElement).value).toContain('"prefix"');
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: {
				action: "allow",
				method: "exec",
				nodes: ["worker-01"],
				privileged: false,
				prefix: OPERATION,
			},
		});
	});

	test("Reject sends the trimmed reason through the shared Reject tab", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Reject" }));
		fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "  too risky  " } });
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "reject", reason: "too risky" });
	});

	test("a busy decision disables the decision buttons", async () => {
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} busy onDecide={() => {}} />,
		);
		expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
	});

	test("a task group lists every target by name and one evaluation per node", async () => {
		const taskGroup = {
			id: "group-1",
			kind: "exec",
			summary: "restart",
			targets: ["node-1", "node-2"],
			refs: { "node-1": { kind: "node", name: "worker-01" }, "node-2": { kind: "node", name: "worker-02" } },
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
		const { container } = await renderWithRouter(
			<ApprovalDecision
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
		expect(screen.getAllByRole("link", { name: "worker-01" }).length).toBeGreaterThan(0);
		expect(screen.getAllByRole("link", { name: "worker-02" }).length).toBeGreaterThan(0);
		fireEvent.click(screen.getByText("Rule chain evaluation"));
		const evaluations = screen.getAllByRole("table", { name: "Rule chain evaluation" });
		expect(evaluations).toHaveLength(2);
		expect(container.textContent).not.toContain("node-2");
		const group = screen.getByRole("region", { name: "Your approval is needed" });
		expect(within(group).getByText(/Targets/)).toBeInTheDocument();
	});
});
