import type { ApprovalBody, ApprovalRequest, Evaluation } from "@crh/api";
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

const COMMAND = "/bin/sh -c 'cat /etc/shadow | head -n 3'";

const baseAlwaysAllow: ApprovalRequest["alwaysAllow"] = [
	{
		option: "exact",
		rule: { action: "allow", method: "exec", nodes: ["worker-01"], privileged: false, exact: COMMAND },
	},
	{
		option: "prefix",
		rule: { action: "allow", method: "exec", nodes: ["worker-01"], privileged: false, prefix: COMMAND },
	},
];

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "task",
	id: "task-1",
	phase: "awaiting_user",
	requester: { type: "session", sessionId: "root-1", title: "Clean up" },
	action: { type: "exec", command: COMMAND },
	nodes: ["worker-01"],
	privileged: false,
	alwaysAllow: baseAlwaysAllow,
	...overrides,
});

const nodeNames = new Map([["node-1", "worker-01"]]);

describe("ApprovalDecision", () => {
	test("shows the server-built requester and exec action, never a UUID summary", async () => {
		await renderWithRouter(<ApprovalDecision request={request()} nodeNames={nodeNames} onDecide={() => {}} />);
		expect(screen.getByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		const requester = screen.getByTestId("approval-requester");
		expect(requester).toHaveTextContent("From session “Clean up”");
		expect(within(requester).getByRole("link", { name: "Clean up" })).toHaveAttribute("href", "/sessions/root-1");
		const action = screen.getByTestId("approval-action");
		expect(action).toHaveTextContent("Run command");
		expect(action.querySelector("code")?.textContent).toBe(COMMAND);
		expect(action.querySelector("code")).toHaveAttribute("title", COMMAND);
		expect(screen.getByTestId("approval-nodes")).toHaveTextContent("Nodes: worker-01");
		// The old per-kind summaries and their technical fields stay off the panel.
		expect(screen.queryByTestId("decision-operation")).not.toBeInTheDocument();
		expect(screen.queryByText("Issued")).not.toBeInTheDocument();
		expect(screen.queryByText("Deadline")).not.toBeInTheDocument();
		expect(screen.queryByText("Attempt")).not.toBeInTheDocument();
	});

	test("renders a file action with its operation and line range", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({
					action: { type: "file", operation: "read", path: "/etc/hosts", lines: { start: 5, end: 7 } },
				})}
				onDecide={() => {}}
			/>,
		);
		const action = screen.getByTestId("approval-action");
		expect(action).toHaveTextContent("Read file");
		expect(action).toHaveTextContent("/etc/hosts");
		expect(action).toHaveTextContent("lines 5-7");
	});

	test("renders an API request action as its method and path", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({
					action: { type: "api_request", method: "POST", path: "/api/sessions" },
					nodes: undefined,
				})}
				onDecide={() => {}}
			/>,
		);
		const action = screen.getByTestId("approval-action");
		expect(action).toHaveTextContent("Call API");
		expect(action).toHaveTextContent("POST /api/sessions");
		expect(screen.queryByTestId("approval-nodes")).not.toBeInTheDocument();
	});

	test("renders an extension tool action as extension and tool", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({
					kind: "external_call",
					action: { type: "extension_tool", extension: "github", tool: "create_issue" },
					nodes: undefined,
				})}
				onDecide={() => {}}
			/>,
		);
		const action = screen.getByTestId("approval-action");
		expect(action).toHaveTextContent("Call extension");
		expect(action).toHaveTextContent("github/create_issue");
	});

	test("renders every requester type, and an empty session title uses the untitled wording", async () => {
		const cases: { requester: ApprovalRequest["requester"]; text: string }[] = [
			{ requester: { type: "api_token", tokenId: "t1", name: "deploy" }, text: "From API token “deploy”" },
			{ requester: { type: "user", userId: "u1", username: "alice" }, text: "From user alice" },
			{
				requester: { type: "session", sessionId: "root-1", title: "" },
				text: "From session “New Session”",
			},
		];
		for (const item of cases) {
			const { unmount } = await renderWithRouter(
				<ApprovalDecision request={request({ requester: item.requester })} onDecide={() => {}} />,
			);
			expect(screen.getByTestId("approval-requester")).toHaveTextContent(item.text);
			unmount();
		}
	});

	test("shows the capped node list, the remaining count and the privileged badge", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({ nodes: ["worker-01", "db-1"], moreNodes: 3, privileged: true })}
				onDecide={() => {}}
			/>,
		);
		const nodes = screen.getByTestId("approval-nodes");
		expect(nodes).toHaveTextContent("Nodes: worker-01, db-1");
		expect(nodes).toHaveTextContent("and 3 more");
		expect(within(nodes).getByText("Privileged")).toBeInTheDocument();
	});

	test("shows the privileged badge even when the operation has no node", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({
					nodes: undefined,
					privileged: true,
					action: { type: "file", operation: "write", path: "/etc/hosts" },
				})}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByTestId("approval-nodes")).toHaveTextContent("Privileged");
	});

	test("shows Auto Review's settled risk and reason from the model", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({ review: { risk: "medium", reason: "touches a system file" } })}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByTestId("approval-review")).toHaveTextContent("Auto Review: Medium risk · touches a system file");
	});

	test("a request without a settled review renders no review line", async () => {
		await renderWithRouter(<ApprovalDecision request={request()} onDecide={() => {}} />);
		expect(screen.queryByTestId("approval-review")).not.toBeInTheDocument();
	});

	test("the Approve tab is the default and approves immediately", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(<ApprovalDecision request={request()} onDecide={onDecide} />);
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Approve");
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "approve" });
	});

	test("the rule chain evaluation is collapsed until it is asked for", async () => {
		await renderWithRouter(<ApprovalDecision request={request()} evaluations={[{ evaluation }]} onDecide={() => {}} />);
		const summary = screen.getByText("Rule chain evaluation");
		const details = summary.closest("details");
		expect(details).not.toBeNull();
		expect(details).not.toHaveAttribute("open");
		fireEvent.click(summary);
		expect(details).toHaveAttribute("open");
		expect(screen.getByRole("table", { name: "Rule chain evaluation" })).toBeInTheDocument();
		expect(screen.getAllByText("Require approval").length).toBeGreaterThan(0);
	});

	test("a task group's per-node evaluations are folded behind their node names", async () => {
		await renderWithRouter(
			<ApprovalDecision
				request={request({ kind: "task_group", nodes: ["worker-01", "worker-02"] })}
				evaluations={[
					{ label: "worker-01", evaluation },
					{ label: "worker-02", evaluation },
				]}
				onDecide={() => {}}
			/>,
		);
		fireEvent.click(screen.getByText("Rule chain evaluation"));
		expect(screen.getAllByRole("table", { name: "Rule chain evaluation" })).toHaveLength(2);
		expect(screen.getByRole("heading", { name: "worker-02" })).toBeInTheDocument();
	});

	test("Always allow uses the server's candidates, and an edited rule is submitted", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		const candidates: ApprovalRequest["alwaysAllow"] = [
			{
				option: "request",
				rule: { action: "allow", method: "api.write", exact: "POST /api/sessions" },
			},
			{
				option: "route",
				rule: { action: "allow", method: "api.write", prefix: "POST /api/sessions" },
			},
		];
		await renderWithRouter(
			<ApprovalDecision
				request={request({
					kind: "external_call",
					action: { type: "api_request", method: "POST", path: "/api/sessions" },
					alwaysAllow: candidates,
				})}
				onDecide={onDecide}
			/>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Always allow" }));
		const textarea = screen.getByLabelText("Rule to add to the caller's rule set") as HTMLTextAreaElement;
		expect(textarea.value).toContain('"exact": "POST /api/sessions"');
		fireEvent.click(screen.getByRole("radio", { name: "This route" }));
		expect(textarea.value).toContain('"prefix": "POST /api/sessions"');
		fireEvent.click(screen.getByRole("button", { name: "Approve and always allow" }));
		expect(onDecide).toHaveBeenCalledWith({
			decision: "approve",
			always: { action: "allow", method: "api.write", prefix: "POST /api/sessions" },
		});
	});

	test("an edited rule is validated as a JSON object before it is submitted", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(<ApprovalDecision request={request()} onDecide={onDecide} />);
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

	test("no always-allow candidates disables the Always allow tab", async () => {
		await renderWithRouter(<ApprovalDecision request={request({ alwaysAllow: [] })} onDecide={() => {}} />);
		expect(screen.getByRole("tab", { name: "Always allow" })).toHaveAttribute("aria-disabled", "true");
	});

	test("a reviewing request shows the notice and no decision controls", async () => {
		await renderWithRouter(
			<ApprovalDecision request={request({ phase: "reviewing" })} nodeNames={nodeNames} onDecide={() => {}} />,
		);
		const notice = screen.getByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		expect(screen.getByTestId("approval-action")).toHaveTextContent(/Run command/);
		expect(screen.queryByRole("region", { name: "Your approval is needed" })).not.toBeInTheDocument();
		expect(screen.queryByRole("tab")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("Reject sends the trimmed reason through the shared Reject tab", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(<ApprovalDecision request={request()} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("tab", { name: "Reject" }));
		fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "  too risky  " } });
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "reject", reason: "too risky" });
	});

	test("a busy decision disables the decision buttons", async () => {
		await renderWithRouter(<ApprovalDecision request={request()} busy onDecide={() => {}} />);
		expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
	});

	test("an inline error is shown", async () => {
		await renderWithRouter(
			<ApprovalDecision request={request()} error={new Error("the decision failed")} onDecide={() => {}} />,
		);
		expect(screen.getByText("the decision failed")).toBeInTheDocument();
	});
});
