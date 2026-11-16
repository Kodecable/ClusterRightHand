import type { ApprovalBody, ApprovalRequest } from "@crh/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ApprovalPanel } from "./approval-panel";

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
	source: { type: "session", sessionId: "root-1", title: "Clean up" },
	action: { type: "exec", command: COMMAND },
	nodes: ["worker-01"],
	privileged: false,
	alwaysAllow: baseAlwaysAllow,
	...overrides,
});

describe("ApprovalPanel", () => {
	test("renders the compact request in the shared card, without technical fields", async () => {
		await renderWithRouter(<ApprovalPanel request={request()} onDecide={() => {}} />);
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toHaveAttribute("data-variant", "inline");
		expect(within(card).getByTestId("decision-meta")).toHaveTextContent("Nodes: worker-01");
		expect(within(card).getByTestId("decision-detail")).toHaveTextContent(COMMAND);
		expect(within(card).queryByText(/Source:/)).not.toBeInTheDocument();
		expect(within(card).queryByText(/Issued|Deadline|Attempt/)).not.toBeInTheDocument();
	});

	test("a page card adds the source and the privileged mark; a live card shares the same layout", async () => {
		const { unmount } = await renderWithRouter(
			<ApprovalPanel request={request({ privileged: true })} variant="page" onDecide={() => {}} />,
		);
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toHaveAttribute("data-variant", "page");
		expect(within(card).getByText("Privileged")).toBeInTheDocument();
		expect(within(card).getByRole("link", { name: "Clean up" })).toHaveAttribute("href", "/sessions/root-1");
		unmount();
		await renderWithRouter(<ApprovalPanel request={request()} onDecide={() => {}} />);
		expect(screen.queryByRole("link", { name: "Clean up" })).not.toBeInTheDocument();
	});

	test("Auto Review's risk and reason sit between the meta line and the detail", async () => {
		await renderWithRouter(
			<ApprovalPanel
				request={request({ review: { risk: "medium", reason: "touches a system file" } })}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByTestId("decision-risk")).toHaveTextContent("Medium risk");
		expect(screen.getByTestId("decision-reason")).toHaveTextContent("touches a system file");
	});

	test("reveals no rule chain evaluation", async () => {
		await renderWithRouter(<ApprovalPanel request={request()} onDecide={() => {}} />);
		expect(screen.queryByText("Rule chain evaluation")).not.toBeInTheDocument();
	});

	test("the Approve tab is the default and approves immediately", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(<ApprovalPanel request={request()} onDecide={onDecide} />);
		expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Approve");
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "approve" });
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
			<ApprovalPanel
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
		await renderWithRouter(<ApprovalPanel request={request()} onDecide={onDecide} />);
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
		await renderWithRouter(<ApprovalPanel request={request({ alwaysAllow: [] })} onDecide={() => {}} />);
		expect(screen.getByRole("tab", { name: "Always allow" })).toHaveAttribute("aria-disabled", "true");
	});

	test("a reviewing request shows the notice in the same card layout and no decision controls", async () => {
		await renderWithRouter(<ApprovalPanel request={request({ phase: "reviewing" })} onDecide={() => {}} />);
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		const notice = within(card).getByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		expect(within(card).getByTestId("decision-detail")).toHaveTextContent(COMMAND);
		expect(within(card).getByTestId("decision-meta")).toHaveTextContent("Nodes: worker-01");
		expect(within(card).queryByRole("tab")).not.toBeInTheDocument();
		expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("Reject sends the trimmed reason through the shared Reject tab", async () => {
		const onDecide = vi.fn<(body: ApprovalBody) => void>();
		await renderWithRouter(<ApprovalPanel request={request()} onDecide={onDecide} />);
		fireEvent.click(screen.getByRole("tab", { name: "Reject" }));
		fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "  too risky  " } });
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(onDecide).toHaveBeenCalledWith({ decision: "reject", reason: "too risky" });
	});

	test("a busy decision disables the decision buttons", async () => {
		await renderWithRouter(<ApprovalPanel request={request()} busy onDecide={() => {}} />);
		expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
	});

	test("an inline error is shown", async () => {
		await renderWithRouter(
			<ApprovalPanel request={request()} error={new Error("the decision failed")} onDecide={() => {}} />,
		);
		expect(screen.getByText("the decision failed")).toBeInTheDocument();
	});

	test("the count and object link stay in the card header", async () => {
		await renderWithRouter(
			<ApprovalPanel
				request={request()}
				count={<span>1 of 3</span>}
				details={<a href="/tasks/task-1">Task details</a>}
				onDecide={() => {}}
			/>,
		);
		expect(screen.getByText("1 of 3")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Task details" })).toHaveAttribute("href", "/tasks/task-1");
	});
});
