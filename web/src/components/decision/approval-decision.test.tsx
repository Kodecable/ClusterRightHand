import type { ApprovalBody, Evaluation, ExternalCallView, TaskGroupView, TaskView } from "@crh/api";
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
		phase: "awaiting_user",
		...overrides,
	}) as TaskView;

const taskGroup = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "group-1",
		kind: "exec",
		summary: "restart",
		targets: ["node-1", "node-2"],
		refs: {
			"node-1": { kind: "node", name: "worker-01" },
			"node-2": { kind: "node", name: "worker-02" },
		},
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
		phase: "awaiting_user",
		...overrides,
	}) as TaskGroupView;

const externalCall = (overrides: Partial<ExternalCallView> = {}): ExternalCallView =>
	({
		id: "call-1",
		extension: "github",
		tool: "create_issue",
		arguments: { title: "Bug" },
		operation: { method: "ext.write", target: "github/create_issue" },
		annotations: { readOnlyHint: false },
		state: "awaiting_approval",
		approval: { evaluation },
		actorType: "session",
		actorId: "s1",
		onBehalfOfUserId: "u1",
		rootSessionId: "root",
		handlerType: "user",
		handlerSessionId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		phase: "awaiting_user",
		...overrides,
	}) as ExternalCallView;

const apiRequestCall = (overrides: Partial<ExternalCallView> = {}): ExternalCallView =>
	externalCall({
		id: "api-1",
		extension: "crhs-api",
		tool: "api_request",
		arguments: {
			method: "POST",
			path: "/api/sessions",
			query: { scope: "mine" },
			body: { title: "Bug" },
		},
		operation: { method: "api.write", target: "POST /api/sessions" },
		annotations: null,
		...overrides,
	});

const allNodeNames = new Map([
	["node-1", "worker-01"],
	["node-2", "worker-02"],
]);
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

	test("an edited rule is validated as a JSON object before it is submitted", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "task", task: task() }} nodeNames={nodeNames} onDecide={onDecide} />,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Always allow" }));
		const textarea = screen.getByLabelText("Rule to add to the caller's rule set");
		fireEvent.change(textarea, { target: { value: "[]" } });
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Not a valid rule");
		expect(onDecide).not.toHaveBeenCalled();

		fireEvent.change(textarea, { target: { value: '{"action":"allow","method":"exec","exact":"true"}' } });
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: { action: "allow", method: "exec", exact: "true" },
		});
	});

	test("a task with no operation cannot always-allow", async () => {
		await renderWithRouter(
			<ApprovalDecision
				item={{ kind: "task", task: task({ operation: null }) }}
				nodeNames={nodeNames}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByRole("tab", { name: "Always allow" })).toHaveAttribute("aria-disabled", "true");
	});

	test("a task group always-allows only the nodes that needed approval", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision
				item={{ kind: "task_group", taskGroup: taskGroup() }}
				nodeNames={allNodeNames}
				onDecide={onDecide}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Always allow" }));
		const textarea = screen.getByLabelText("Rule to add to the caller's rule set") as HTMLTextAreaElement;
		expect(textarea.value).toContain('"nodes": [\n    "worker-01",\n    "worker-02"');
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: {
				action: "allow",
				method: "exec",
				nodes: ["worker-01", "worker-02"],
				privileged: false,
				exact: "systemctl restart nginx",
			},
		});
	});

	test("an extension tool call shows the extension summary and its always-allow candidates", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "external_call", call: externalCall() }} onDecide={onDecide} />,
		);
		expect(screen.getByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		expect(screen.getByText("github")).toBeInTheDocument();
		expect(screen.getByText("create_issue")).toBeInTheDocument();
		expect(screen.getByTestId("external-call-annotations")).toHaveTextContent("readOnlyHint");
		expect(screen.getByTestId("external-call-arguments")).toHaveTextContent("Bug");

		fireEvent.click(screen.getByRole("tab", { name: "Always allow" }));
		const textarea = screen.getByTestId("external-call-always-rule") as HTMLTextAreaElement;
		expect(textarea.value).toContain('"exact": "github/create_issue"');
		fireEvent.click(screen.getByRole("radio", { name: "The whole extension" }));
		expect(textarea.value).toContain('"prefix": "github/"');
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: { action: "allow", method: "ext.write", prefix: "github/" },
		});
	});

	test("an API request shows its method, path, query and body, and offers the route rule", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(
			<ApprovalDecision item={{ kind: "external_call", call: apiRequestCall() }} onDecide={onDecide} />,
		);
		expect(screen.getByTestId("external-call-api-request")).toHaveTextContent("POST");
		expect(screen.getByTestId("external-call-api-request")).toHaveTextContent("/api/sessions");
		expect(screen.getByTestId("external-call-query")).toHaveTextContent("scope");
		expect(screen.getByTestId("external-call-body")).toHaveTextContent("Bug");

		fireEvent.click(screen.getByRole("tab", { name: "Always allow" }));
		const textarea = screen.getByTestId("external-call-always-rule") as HTMLTextAreaElement;
		expect(textarea.value).toContain('"exact": "POST /api/sessions"');
		fireEvent.click(screen.getByRole("radio", { name: "This route" }));
		expect(textarea.value).toContain('"prefix": "POST /api/sessions"');
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: { action: "allow", method: "api.write", prefix: "POST /api/sessions" },
		});
	});

	test("a read-only external call carries the Read-only badge instead of an operation", async () => {
		await renderWithRouter(
			<ApprovalDecision
				item={{ kind: "external_call", call: externalCall({ annotations: { readOnlyHint: true } }) }}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText("Read-only")).toBeInTheDocument();
	});

	test("a reviewing request shows the notice and no decision controls", async () => {
		await renderWithRouter(
			<ApprovalDecision
				item={{ kind: "task", task: task({ phase: "reviewing" }) }}
				nodeNames={nodeNames}
				onDecide={() => {}}
			/>,
		);
		const notice = screen.getByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		expect(screen.getByTestId("decision-operation")).toHaveTextContent(/exec\s+\/bin\/sh/);
		expect(screen.queryByRole("region", { name: "Your approval is needed" })).not.toBeInTheDocument();
		expect(screen.queryByRole("tab")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("a pending review marker renders no compact verdict and does not crash", async () => {
		await renderWithRouter(
			<ApprovalDecision
				item={{
					kind: "task",
					task: task({
						approval: {
							evaluation,
							review: { status: "pending", startedAt: "2026-01-01T00:00:00.000Z" },
						},
					}),
				}}
				nodeNames={nodeNames}
				showReview
				onDecide={() => {}}
			/>,
		);
		expect(screen.queryByTestId("decision-review")).not.toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
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
		const { container } = await renderWithRouter(
			<ApprovalDecision
				item={{ kind: "task_group", taskGroup: taskGroup() }}
				nodeNames={allNodeNames}
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
