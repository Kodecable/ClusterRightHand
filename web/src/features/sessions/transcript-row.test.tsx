import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { SessionListItem } from "@/lib/api/types";
import { renderWithI18n, renderWithRouter } from "@/test/render";
import { SessionChildrenProvider } from "./child-sessions";
import type { TranscriptItem } from "./sessionState";
import { TranscriptRow, toolSummary } from "./transcript-row";
import { TranscriptStreams } from "./transcript-streams";

function renderRow(item: TranscriptItem, streams = new TranscriptStreams()) {
	return renderWithI18n(<TranscriptRow item={item} streams={streams} />);
}

describe("TranscriptRow", () => {
	test("a user message is shown as plain text", () => {
		renderRow({ kind: "user", key: "u1", text: "**not markdown**" });
		expect(screen.getByText("**not markdown**")).toBeInTheDocument();
		expect(screen.queryByText("not markdown")).not.toBeInTheDocument();
	});

	test("assistant text renders through SafeMarkdown", () => {
		renderRow({ kind: "text", key: "a1", text: "Hello **world**", streaming: false });
		expect(screen.getByText("world").tagName).toBe("STRONG");
	});

	test("a streaming block reads its text from the row's store", () => {
		const streams = new TranscriptStreams();
		const store = streams.text("live/1/0");
		store.setText("Streamed *text*");
		store.flush();
		renderRow({ kind: "text", key: "live/1/0", text: "", streaming: true, live: true }, streams);
		expect(screen.getByTestId("streaming-text")).toHaveTextContent("Streamed text");
	});

	test("a streamed row keeps its rendered Markdown when it is committed", () => {
		const streams = new TranscriptStreams();
		const store = streams.text("live/1/0");
		store.setText("Hello **wor");
		store.flush();
		const { rerender } = renderRow({ kind: "text", key: "live/1/0", text: "", streaming: true, live: true }, streams);
		const strong = screen.getByText("wor");
		store.finish();
		rerender(
			<TranscriptRow
				item={{ kind: "text", key: "live/1/0", text: "Hello **world**", streaming: false, live: true }}
				streams={streams}
			/>,
		);
		expect(screen.queryByTestId("streaming-text")).toBeNull();
		// The committed text replaced the streamed one in the very same element.
		expect(screen.getByText("world")).toBe(strong);
	});

	test("thinking is collapsible and muted", () => {
		renderRow({ kind: "thinking", key: "t1", text: "quiet reasoning", streaming: false });
		const toggle = screen.getByTestId("thinking-toggle");
		expect(toggle).toHaveTextContent("Thinking");
		expect(screen.getByText("quiet reasoning")).toBeInTheDocument();
	});

	test("a tool card starts collapsed and shows arguments and result when expanded", () => {
		renderRow({
			kind: "tool",
			key: "a1/0",
			callId: "call-1",
			name: "exec",
			args: { node: "n1", shell: "uname -a" },
			status: "done",
			output: "",
			details: undefined,
			result: { text: '{"state":"exited","exit_code":0}', isError: false, details: undefined },
		});
		const toggle = screen.getByTestId("tool-toggle");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId("tool-output")).not.toBeInTheDocument();
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByTestId("tool-output")).toHaveTextContent("uname -a");
		expect(screen.getByTestId("tool-output")).toHaveTextContent("exit_code");
	});

	test("a collapsed tool card names what it runs and where", () => {
		renderRow({
			kind: "tool",
			key: "a1/0",
			callId: "call-1",
			name: "exec",
			args: { node: "n1", shell: "uname -a" },
			status: "done",
			output: "",
			details: undefined,
			result: { text: '{"state":"exited","exit_code":0}', isError: false, details: undefined },
		});
		const toggle = screen.getByTestId("tool-toggle");
		expect(toggle).toHaveTextContent("exec");
		expect(toggle).toHaveTextContent("uname -a · n1");
		expect(toggle).toHaveTextContent("Done");
	});

	test("a subagent card follows the child session's live state", async () => {
		const subagent: TranscriptItem = {
			kind: "tool",
			key: "a1/0",
			callId: "call-subagent",
			name: "subagent",
			args: { task: "restart nginx on web-1", background: true },
			status: "done",
			output: "",
			details: { sessionId: "child-1", requests: [] },
			result: {
				text: "Subagent started in the background (session child-1).",
				isError: false,
				details: { sessionId: "child-1", requests: [] },
			},
		};
		const child = (state: "idle" | "running" | "awaiting"): SessionListItem => ({
			id: "child-1",
			title: "restart nginx",
			ownerUserId: "u1",
			ownerName: "Ada",
			scheduleId: null,
			shared: false,
			state,
			waitingKind: null,
			parentSessionId: "s1",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const card = (state: "idle" | "running" | "awaiting") => (
			<SessionChildrenProvider items={[child(state)]}>
				<TranscriptRow item={subagent} streams={new TranscriptStreams()} />
			</SessionChildrenProvider>
		);

		// The call returned at once; the card shows what the child does now, not "Done".
		const running = await renderWithRouter(card("running"));
		expect(screen.getByTestId("tool-toggle")).toHaveTextContent("Running");
		expect(screen.queryByText("Done")).not.toBeInTheDocument();
		running.unmount();

		// The child went idle: the card follows it instead of staying at the state it was drawn with.
		await renderWithRouter(card("idle"));
		expect(screen.getByTestId("tool-toggle")).toHaveTextContent("Idle");
	});

	test("a subagent card without its child in the list keeps the call's own status", async () => {
		const item: TranscriptItem = {
			kind: "tool",
			key: "a1/0",
			callId: "call-subagent",
			name: "subagent",
			args: { task: "restart nginx on web-1" },
			status: "done",
			output: "",
			details: { sessionId: "child-2", requests: [] },
			result: { text: "Subagent started.", isError: false, details: { sessionId: "child-2", requests: [] } },
		};
		await renderWithRouter(
			<SessionChildrenProvider items={[]}>
				<TranscriptRow item={item} streams={new TranscriptStreams()} />
			</SessionChildrenProvider>,
		);
		expect(screen.getByTestId("tool-toggle")).toHaveTextContent("Done");
	});

	test("toolSummary picks the telling argument of each tool", () => {
		expect(toolSummary({ cmd: "systemctl restart nginx" })).toBe("systemctl restart nginx");
		expect(toolSummary({ argv: ["bash", "-c", "true"] })).toBe("bash -c true");
		expect(toolSummary({ path: "/etc/hosts", node: "web-1" })).toBe("/etc/hosts · web-1");
		expect(toolSummary({ cmd: "uptime", targets: ["a", "b"] })).toBe("uptime · a, b");
		expect(toolSummary({ cmd: "df -h /var" })).toBe("df -h /var");
		expect(toolSummary({})).toBe("");
		expect(toolSummary({ timeout: 5 })).toBe("timeout");
	});

	test("a running tool shows its live output store", () => {
		const streams = new TranscriptStreams();
		const store = streams.tool("call-2");
		store.setText("line one");
		store.flush();
		renderRow(
			{
				kind: "tool",
				key: "a2/0",
				callId: "call-2",
				name: "exec",
				args: {},
				status: "running",
				output: "",
				details: undefined,
				result: undefined,
			},
			streams,
		);
		fireEvent.click(screen.getByTestId("tool-toggle"));
		expect(screen.getByTestId("tool-output")).toHaveTextContent("line one");
	});

	test("a compaction entry is a divider, not a user bubble", () => {
		renderRow({ kind: "compaction", key: "c1", text: "Summary of earlier work" });
		expect(screen.getByText("Context compacted")).toBeInTheDocument();
		expect(screen.getByText("Summary of earlier work")).toBeInTheDocument();
	});

	test("an aborted run and a failed run are errors", () => {
		const { rerender } = renderRow({ kind: "error", key: "e1", reason: "aborted", message: null });
		expect(screen.getByRole("alert")).toHaveTextContent("The run was stopped.");
		rerender(
			<TranscriptRow
				item={{ kind: "error", key: "e2", reason: "failed", message: "boom" }}
				streams={new TranscriptStreams()}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("The run failed.");
		expect(screen.getByRole("alert")).toHaveTextContent("boom");
	});
});

describe("TranscriptRow tool failure badge", () => {
	const toolItem = (result: string): TranscriptItem => ({
		kind: "tool",
		key: "a1/0",
		callId: "call-1",
		name: "exec",
		args: { cmd: "true" },
		status: "done",
		output: "",
		details: undefined,
		result: { text: result, isError: false, details: undefined },
	});

	const failure = () => screen.queryByTestId("tool-failure");

	test("a read_file result has no exit_code and no badge", () => {
		renderRow(toolItem('{"task_id":"t1","node":"web-1","state":"exited","lines":{"from":1,"to":5}}'));
		expect(failure()).not.toBeInTheDocument();
	});

	test("an exited task with exit code 0 has no badge", () => {
		renderRow(toolItem('{"task_id":"t1","node":"web-1","state":"exited","exit_code":0}'));
		expect(failure()).not.toBeInTheDocument();
	});

	test("a running result has no badge", () => {
		renderRow(toolItem('{"task_id":"t1","node":"web-1","state":"running"}'));
		expect(failure()).not.toBeInTheDocument();
	});

	test("a task group whose nodes all succeeded has no badge", () => {
		renderRow(
			toolItem(
				'{"task_group_id":"g1","state":"finished","nodes":[{"task_id":"a","state":"exited","exit_code":0},{"task_id":"b","state":"exited","exit_code":0}]}',
			),
		);
		expect(failure()).not.toBeInTheDocument();
	});

	test("a group with one failed node is partly failed", () => {
		renderRow(
			toolItem(
				'{"task_group_id":"g1","state":"finished","nodes":[{"task_id":"a","state":"exited","exit_code":0},{"task_id":"b","state":"exited","exit_code":1}]}',
			),
		);
		expect(failure()).toHaveTextContent("Partly failed");
	});

	test("a cancelled task shows the Cancelled badge", () => {
		renderRow(toolItem('{"task_id":"t1","state":"exited","exit_code":0,"cancelled":true}'));
		expect(failure()).toHaveTextContent("Cancelled");
	});

	test("a non-zero exit code shows the code", () => {
		renderRow(toolItem('{"task_id":"t1","state":"exited","exit_code":2}'));
		expect(failure()).toHaveTextContent("Exit 2");
	});

	test("a failed task shows Failed, next to the call status badge", () => {
		renderRow(toolItem('{"task_id":"t1","state":"failed","error":{"code":"exec_failed"}}'));
		expect(failure()).toHaveTextContent("Failed");
		expect(screen.getByTestId("tool-toggle")).toHaveTextContent("Done");
	});
});
