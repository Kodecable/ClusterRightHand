import type { Evaluation, ExternalCallView, TaskGroupView, TaskView } from "@crh/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import { RequestDetails } from "./request-details";

const evaluation = (result: Evaluation["result"] = "require-approval"): Evaluation => ({
	result,
	levels: [
		{
			scope: { type: "user", id: "u1" },
			own: "require-approval",
			rule: 0,
			matched: { action: "require-approval", method: "exec", prefix: "systemctl " },
			effective: result,
		},
	],
});

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		kind: "exec",
		summary: "systemctl restart nginx",
		operation: { method: "exec", target: "systemctl restart nginx" },
		approval: {
			evaluation: evaluation(),
			review: { decision: "escalate", risk: "high", reason: "sends a credential", model: "test/reviewer" },
		},
		...overrides,
	}) as TaskView;

const group = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "group-1",
		state: "awaiting_approval",
		targets: ["node-1", "node-2"],
		nodeIds: ["node-1", "node-2"],
		approval: {
			nodes: [
				{ nodeId: "node-1", evaluation: evaluation() },
				{ nodeId: "node-2", evaluation: evaluation("allow") },
			],
			review: { decision: "escalate", risk: "medium", reason: "production change", model: "test/reviewer" },
		},
		operation: { method: "exec", target: "systemctl restart nginx" },
		tasks: [],
		...overrides,
	}) as TaskGroupView;

const extensionCall = (overrides: Partial<ExternalCallView> = {}): ExternalCallView =>
	({
		id: "call-1",
		extension: "github",
		tool: "create_issue",
		arguments: { title: "Bug" },
		operation: { method: "ext.write", target: "github/create_issue" },
		annotations: { readOnlyHint: false },
		state: "awaiting_approval",
		approval: { evaluation: evaluation() },
		...overrides,
	}) as ExternalCallView;

const apiCall = (overrides: Partial<ExternalCallView> = {}): ExternalCallView =>
	extensionCall({
		id: "api-1",
		extension: "crhs-api",
		tool: "api_request",
		arguments: { method: "POST", path: "/api/sessions", query: { scope: "mine" }, body: { title: "Bug" } },
		operation: { method: "api.write", target: "POST /api/sessions" },
		annotations: null,
		...overrides,
	});

describe("RequestDetails", () => {
	test("shows Auto Review's full verdict in the same section as the folded rule chain", async () => {
		renderWithI18n(<RequestDetails source={{ kind: "task", task: task() }} />);
		const details = screen.getByRole("region", { name: "Request details" });
		expect(details).toHaveAttribute("data-testid", "request-details");
		const review = within(details).getByTestId("request-review");
		expect(review).toHaveTextContent("Escalated");
		expect(review).toHaveTextContent("High");
		expect(review).toHaveTextContent("sends a credential");
		expect(review).toHaveTextContent("test/reviewer");

		const summary = within(details).getByText("Rule chain evaluation");
		const folded = summary.closest("details");
		expect(folded).not.toBeNull();
		expect(folded).not.toHaveAttribute("open");
		fireEvent.click(summary);
		expect(folded).toHaveAttribute("open");
		expect(within(details).getByRole("table", { name: "Rule chain evaluation" })).toBeInTheDocument();
	});

	test("renders the task operation as a JSON block", async () => {
		renderWithI18n(<RequestDetails source={{ kind: "task", task: task() }} />);
		const content = screen.getByTestId("request-content");
		expect(content).toHaveTextContent("Operation");
		expect(content.querySelector("pre")?.textContent).toContain('"method": "exec"');
		expect(content.querySelector("pre")?.textContent).toContain('"target": "systemctl restart nginx"');
	});

	test("a task group folds one rule chain table per node behind its name", async () => {
		renderWithI18n(
			<RequestDetails
				source={{ kind: "task_group", taskGroup: group() }}
				nodeNames={
					new Map([
						["node-1", "worker-01"],
						["node-2", "worker-02"],
					])
				}
			/>,
		);
		fireEvent.click(screen.getByText("Rule chain evaluation"));
		expect(screen.getAllByRole("table", { name: "Rule chain evaluation" })).toHaveLength(2);
		expect(screen.getByRole("heading", { name: "worker-01" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "worker-02" })).toBeInTheDocument();
		expect(screen.getByTestId("request-review")).toHaveTextContent("production change");
	});

	test("an API request shows its query and body as JSON, and no old label/code block", async () => {
		renderWithI18n(<RequestDetails source={{ kind: "external_call", call: apiCall() }} />);
		const blocks = screen.getAllByTestId("request-content");
		expect(blocks).toHaveLength(2);
		expect(screen.getByText("Query")).toBeInTheDocument();
		expect(screen.getByText("Body")).toBeInTheDocument();
		expect(blocks[0]?.querySelector("pre")?.textContent).toContain('"scope": "mine"');
		expect(blocks[1]?.querySelector("pre")?.textContent).toContain('"title": "Bug"');
		expect(screen.queryByTestId("external-call-details")).not.toBeInTheDocument();
	});

	test("an extension call shows its annotations and arguments as JSON", async () => {
		renderWithI18n(<RequestDetails source={{ kind: "external_call", call: extensionCall() }} />);
		expect(screen.getByText("Annotations")).toBeInTheDocument();
		expect(screen.getByText("Arguments")).toBeInTheDocument();
		expect(screen.getByText("Arguments").closest("section")).toHaveTextContent('"title": "Bug"');
	});

	test("a pending Auto Review marker shows no verdict but keeps the rest", async () => {
		renderWithI18n(
			<RequestDetails
				source={{
					kind: "task",
					task: task({
						approval: {
							evaluation: evaluation(),
							review: { status: "pending", startedAt: "2026-01-01T00:00:00.000Z" },
						},
					}),
				}}
			/>,
		);
		expect(screen.queryByTestId("request-review")).not.toBeInTheDocument();
		expect(screen.getByText("Rule chain evaluation")).toBeInTheDocument();
	});

	test("renders nothing when the request has no details", () => {
		const { container } = renderWithI18n(
			<RequestDetails source={{ kind: "task", task: task({ approval: null, operation: null }) }} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
