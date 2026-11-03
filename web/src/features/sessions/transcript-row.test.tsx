import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { taskKeys } from "@/features/tasks/api";
import type { TaskGroupView, TaskView } from "@/lib/api/types";
import { renderWithI18n, testQueryClient } from "@/test/render";
import type { Json, TranscriptItem } from "./sessionState";
import { callStillOpen, TranscriptRow, toolLine } from "./transcript-row";
import { TranscriptStreams } from "./transcript-streams";

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderRow(
	item: TranscriptItem,
	streams = new TranscriptStreams(),
	client: QueryClient = testQueryClient(),
	sessionActive = true,
) {
	return renderWithI18n(<TranscriptRow item={item} streams={streams} sessionActive={sessionActive} />, "en", client);
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
				sessionActive
			/>,
		);
		expect(screen.queryByTestId("streaming-text")).toBeNull();
		// The committed text replaced the streamed one in the very same element.
		expect(screen.getByText("world")).toBe(strong);
	});

	test("thinking is collapsible, shows its first line when settled and hides the preview when open", () => {
		renderRow({ kind: "thinking", key: "t1", text: "first line\nsecond line", streaming: false });
		const toggle = screen.getByTestId("thinking-toggle");
		expect(toggle).toHaveTextContent("Thinking");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByTestId("thinking-preview")).toHaveTextContent("first line");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.queryByTestId("thinking-preview")).not.toBeInTheDocument();
		expect(screen.getByTestId("safe-markdown")).toHaveTextContent("first line");
		expect(screen.getByTestId("safe-markdown")).toHaveTextContent("second line");
	});

	test("thinking shows the latest line while streaming", () => {
		const streams = new TranscriptStreams();
		const store = streams.text("live/1/0");
		store.setText("first line\nlatest line");
		store.flush();
		renderRow({ kind: "thinking", key: "live/1/0", text: "", streaming: true, live: true }, streams);
		expect(screen.getByTestId("thinking-preview")).toHaveTextContent("latest line");
	});

	test("a tool row opens a dialog with arguments and result", async () => {
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
		expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
		expect(screen.queryByTestId("tool-output")).not.toBeInTheDocument();
		fireEvent.click(toggle);
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(screen.getByTestId("tool-output")).toHaveTextContent("uname -a");
		expect(screen.getByTestId("tool-output")).toHaveTextContent("exit_code");
	});

	test("a collapsed tool card names what it runs and where, with its status on the icon", () => {
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
		expect(toggle).toHaveTextContent("exec · n1 · uname -a");
		// The status is the leading icon's accessible name, not a text badge.
		expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool-status", "done");
		expect(screen.getByTestId("tool-status-icon")).toHaveAccessibleName("Done");
		expect(toggle).not.toHaveTextContent("Done");
	});

	test("a returned subagent call is Done even while the child runs, with no child-state badge", () => {
		renderRow({
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
		});
		// Only whether the call returned decides the icon: a background child does not keep it spinning.
		expect(screen.getByTestId("tool-card")).toHaveAttribute("data-tool-status", "done");
		expect(screen.getByTestId("tool-status-icon")).toHaveAccessibleName("Done");
		expect(screen.getByTestId("tool-toggle")).not.toHaveTextContent(/Idle|Running/);
	});

	test("toolLine is name · node · subject, without status or extra options", () => {
		expect(toolLine("exec", { cmd: "echo only-on-stderr >&2", targets: ["db-1"] })).toBe(
			"exec · db-1 · echo only-on-stderr >&2",
		);
		expect(
			toolLine("read_file", {
				path: "/var/lib/crha/output/bb2a1eb5-305c-8a8a-80c3-49dc0b2598a5.log",
				targets: ["db-1"],
			}),
		).toBe("read_file · db-1 · /var/lib/crha/output/bb2a1eb5-305c-8a8a-80c3-49dc0b2598a5.log");
		expect(toolLine("subagent", { task: "restart nginx", background: true })).toBe("subagent · restart nginx");
		expect(toolLine("task_wait", { task_id: "d33dae4a-c1a3-8a94-9cf7-099289eb5dc2", wait: 30 })).toBe(
			"task_wait · d33dae4a-c1a3-8a94-9cf7-099289eb5dc2",
		);
		expect(toolLine("task_wait", { task_group_id: "g1" })).toBe("task_wait · g1");
		expect(toolLine("exec", { argv: ["bash", "-c", "true"], targets: ["a", "b"] })).toBe("exec · a, b · bash -c true");
		expect(toolLine("node_info", { node: "app-1" })).toBe("node_info · app-1");
		expect(toolLine("list_nodes", {})).toBe("list_nodes");
	});

	test("a running tool shows its live output store", async () => {
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
		expect(await screen.findByTestId("tool-output")).toHaveTextContent("line one");
	});

	test("a compaction entry is a collapsible note row with the summary's first line", () => {
		renderRow({ kind: "compaction", key: "c1", text: "First summary line\nsecond summary line" });
		const toggle = screen.getByTestId("compaction-toggle");
		expect(toggle).toHaveTextContent("Context compacted");
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByTestId("compaction-preview")).toHaveTextContent("First summary line");
		expect(screen.queryByTestId("safe-markdown")).not.toBeInTheDocument();
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.queryByTestId("compaction-preview")).not.toBeInTheDocument();
		expect(screen.getByTestId("safe-markdown")).toHaveTextContent("First summary line");
		expect(screen.getByTestId("safe-markdown")).toHaveTextContent("second summary line");
	});

	test("a running compaction is a non-expandable row with the running spinner", () => {
		renderRow({ kind: "compacting", key: "compacting/1" });
		const row = screen.getByTestId("compacting-row");
		expect(row).toHaveTextContent("Compacting context");
		expect(row.querySelector(".animate-spin")).not.toBeNull();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	test("an aborted run and a failed run are errors", () => {
		const { rerender } = renderRow({ kind: "error", key: "e1", reason: "aborted", message: null });
		expect(screen.getByRole("alert")).toHaveTextContent("The run was stopped.");
		rerender(
			<TranscriptRow
				item={{ kind: "error", key: "e2", reason: "failed", message: "boom" }}
				streams={new TranscriptStreams()}
				sessionActive
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("The run failed.");
		expect(screen.getByRole("alert")).toHaveTextContent("boom");
	});
});

describe("TranscriptRow tool status icon", () => {
	const toolItem = (
		result?: { text: string; isError?: boolean },
		status: "pending" | "running" | "done" = "done",
		details?: Json,
	): TranscriptItem => ({
		kind: "tool",
		key: "a1/0",
		callId: "call-1",
		name: "exec",
		args: { cmd: "true" },
		status,
		output: "",
		details,
		result:
			result === undefined ? undefined : { text: result.text, isError: result.isError ?? false, details: undefined },
	});

	const card = () => screen.getByTestId("tool-card");
	const icon = () => screen.getByTestId("tool-status-icon");

	test("a call that has not returned spins and is labelled Running", () => {
		const { rerender } = renderRow(toolItem(undefined, "running"));
		expect(card()).toHaveAttribute("data-tool-status", "running");
		expect(icon()).toHaveAccessibleName("Running");
		expect(icon()).toHaveAttribute("title", "Running");
		expect(icon().querySelector(".animate-spin")).not.toBeNull();

		// A call still preparing and a call with no state at all are in the same not-returned state.
		rerender(<TranscriptRow item={toolItem(undefined, "pending")} streams={new TranscriptStreams()} sessionActive />);
		expect(card()).toHaveAttribute("data-tool-status", "preparing");
		expect(icon()).toHaveAccessibleName("Running");
		expect(icon().querySelector(".animate-spin")).not.toBeNull();
	});

	test("a returned call with no task failure keeps the wrench and is labelled Done", () => {
		const { rerender } = renderRow(
			toolItem({ text: '{"task_id":"t1","node":"web-1","state":"running"}', isError: false }),
		);
		expect(card()).toHaveAttribute("data-tool-status", "done");
		expect(icon()).toHaveAccessibleName("Done");
		expect(icon()).not.toHaveClass("text-danger");
		expect(icon().querySelector(".animate-spin")).toBeNull();
		rerender(
			<TranscriptRow
				item={toolItem({ text: '{"task_id":"t1","node":"web-1","state":"exited","lines":{"from":1,"to":5}}' }, "done")}
				streams={new TranscriptStreams()}
				sessionActive
			/>,
		);
		expect(card()).toHaveAttribute("data-tool-status", "done");
	});

	test("an exited task with exit code 0 and a fully succeeded group show the wrench", () => {
		const { rerender } = renderRow(
			toolItem({ text: '{"task_id":"t1","node":"web-1","state":"exited","exit_code":0}' }),
		);
		expect(card()).toHaveAttribute("data-tool-status", "done");
		rerender(
			<TranscriptRow
				item={toolItem({
					text: '{"task_group_id":"g1","state":"finished","nodes":[{"task_id":"a","state":"exited","exit_code":0},{"task_id":"b","state":"exited","exit_code":0}]}',
				})}
				streams={new TranscriptStreams()}
				sessionActive
			/>,
		);
		expect(card()).toHaveAttribute("data-tool-status", "done");
		expect(icon()).toHaveAccessibleName("Done");
	});

	test("a failed task marks the card failed and names the reason on the icon", () => {
		renderRow(toolItem({ text: '{"task_id":"t1","state":"failed","error":{"code":"exec_failed"}}' }));
		expect(card()).toHaveAttribute("data-tool-status", "failed");
		expect(icon()).toHaveAccessibleName("Failed");
		expect(icon()).toHaveClass("text-danger");
	});

	test("a non-zero exit code and a cancelled task use their specific labels", () => {
		const { rerender } = renderRow(toolItem({ text: '{"task_id":"t1","state":"exited","exit_code":2}' }));
		expect(card()).toHaveAttribute("data-tool-status", "failed");
		expect(icon()).toHaveAccessibleName("Exit 2");
		expect(screen.queryByTestId("tool-failure")).toBeNull();
		rerender(
			<TranscriptRow
				item={toolItem({ text: '{"task_id":"t1","state":"exited","exit_code":0,"cancelled":true}' })}
				streams={new TranscriptStreams()}
				sessionActive
			/>,
		);
		expect(icon()).toHaveAccessibleName("Cancelled");
		expect(card()).toHaveAttribute("data-tool-status", "failed");
	});

	test("a group with one failed member is partly failed", () => {
		renderRow(
			toolItem({
				text: '{"task_group_id":"g1","state":"finished","nodes":[{"task_id":"a","state":"exited","exit_code":0},{"task_id":"b","state":"exited","exit_code":1}]}',
			}),
		);
		expect(card()).toHaveAttribute("data-tool-status", "failed");
		expect(icon()).toHaveAccessibleName("Partly failed");
		expect(screen.getByTestId("tool-toggle")).not.toHaveTextContent("Partly failed");
	});

	test("a tool error result is a failed wrench, labelled Failed", () => {
		renderRow(toolItem({ text: "boom", isError: true }));
		expect(card()).toHaveAttribute("data-tool-status", "failed");
		expect(icon()).toHaveAccessibleName("Failed");
		expect(icon()).toHaveClass("text-danger");
	});
});

const baseTask = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "t1",
		nodeId: "n1",
		kind: "exec",
		summary: "true",
		operation: null,
		actorType: "session",
		actorId: "s1",
		onBehalfOfUserId: "u1",
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutHead: "",
		stdoutTail: "",
		stderrHead: "",
		stderrTail: "",
		outputFile: null,
		outputMode: "status",
		privileged: false,
		result: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
		...overrides,
	}) as TaskView;

const baseGroup = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "g1",
		state: "finished",
		targets: ["n1"],
		nodeIds: ["n1"],
		parallel: 1,
		failFast: false,
		outputMode: "status",
		privileged: false,
		skipped: [],
		tasks: [baseTask()],
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
		...overrides,
	}) as TaskGroupView;

describe("callStillOpen", () => {
	test("a call stays open while the session runs and its task or group is open", () => {
		expect(callStillOpen({ sessionActive: true, taskState: "running", groupState: undefined })).toBe(true);
		expect(callStillOpen({ sessionActive: true, taskState: "awaiting_approval", groupState: undefined })).toBe(true);
		expect(callStillOpen({ sessionActive: true, taskState: undefined, groupState: "running" })).toBe(true);
		expect(callStillOpen({ sessionActive: true, taskState: undefined, groupState: "awaiting_authorization" })).toBe(
			true,
		);
		// A call whose first status has not arrived yet is still open.
		expect(callStillOpen({ sessionActive: true, taskState: undefined, groupState: undefined })).toBe(true);
	});

	test("an idle session stops the wait, even for a task or group that is still open", () => {
		expect(callStillOpen({ sessionActive: false, taskState: undefined, groupState: undefined })).toBe(false);
		expect(callStillOpen({ sessionActive: false, taskState: "running", groupState: undefined })).toBe(false);
		expect(callStillOpen({ sessionActive: false, taskState: undefined, groupState: "awaiting_approval" })).toBe(false);
	});

	test("a task in a terminal state stops the wait", () => {
		for (const state of ["exited", "failed", "denied", "rejected", "unknown"]) {
			expect(callStillOpen({ sessionActive: true, taskState: state, groupState: undefined }), state).toBe(false);
		}
	});

	test("a group that finished, was interrupted or was rejected stops the wait", () => {
		for (const state of ["finished", "interrupted", "rejected"]) {
			expect(callStillOpen({ sessionActive: true, taskState: undefined, groupState: state }), state).toBe(false);
		}
	});
});

describe("a tool card whose call cannot return", () => {
	const unreturned = (details?: Json): TranscriptItem => ({
		kind: "tool",
		key: "a1/0",
		callId: "call-1",
		name: "exec",
		args: { cmd: "true" },
		status: "running",
		output: "",
		details,
		result: undefined,
	});
	const card = () => screen.getByTestId("tool-card");
	const icon = () => screen.getByTestId("tool-status-icon");

	test("an idle session turns the spinner into the wrench and says No result", () => {
		renderRow(unreturned(), new TranscriptStreams(), testQueryClient(), false);
		expect(icon().querySelector(".animate-spin")).toBeNull();
		expect(icon()).toHaveAccessibleName("No result");
		expect(icon()).not.toHaveClass("text-danger");
		expect(card()).toHaveAttribute("data-tool-status", "empty");
	});

	test("a task that ended stops the spinner and names its outcome", () => {
		const client = testQueryClient();
		client.setQueryData(taskKeys.detail("t1"), baseTask());
		renderRow(unreturned({ task_id: "t1", state: "running" }), new TranscriptStreams(), client);
		expect(icon().querySelector(".animate-spin")).toBeNull();
		expect(icon()).toHaveAccessibleName("Done");
		expect(icon()).not.toHaveClass("text-danger");
		// A stopped card has no result of its own: its status stays `empty`.
		expect(card()).toHaveAttribute("data-tool-status", "empty");
	});

	test("a failed task colours the wrench and names the exit code", () => {
		const client = testQueryClient();
		client.setQueryData(taskKeys.detail("t1"), baseTask({ exitCode: 2 }));
		renderRow(unreturned({ task_id: "t1", state: "running" }), new TranscriptStreams(), client);
		expect(icon().querySelector(".animate-spin")).toBeNull();
		expect(icon()).toHaveAccessibleName("Exit 2");
		expect(icon()).toHaveClass("text-danger");
		expect(card()).toHaveAttribute("data-tool-status", "failed");
	});

	test("a group that ended stops the spinner", () => {
		const client = testQueryClient();
		client.setQueryData(taskKeys.group("g1"), baseGroup());
		renderRow(unreturned({ task_group_id: "g1", state: "running" }), new TranscriptStreams(), client);
		expect(icon().querySelector(".animate-spin")).toBeNull();
		expect(icon()).toHaveAccessibleName("Done");
		expect(card()).toHaveAttribute("data-tool-status", "empty");
	});

	test("an interrupted group is a failed wrench", () => {
		const client = testQueryClient();
		client.setQueryData(taskKeys.group("g1"), baseGroup({ state: "interrupted" }));
		renderRow(unreturned({ task_group_id: "g1", state: "running" }), new TranscriptStreams(), client);
		expect(icon().querySelector(".animate-spin")).toBeNull();
		expect(icon()).toHaveAccessibleName("Failed");
		expect(icon()).toHaveClass("text-danger");
		expect(card()).toHaveAttribute("data-tool-status", "failed");
	});

	test("a task that is still running keeps the spinner while the session is active", () => {
		const client = testQueryClient();
		client.setQueryData(taskKeys.detail("t1"), baseTask({ state: "running", exitCode: null, finishedAt: null }));
		// The card long-polls an open task; the stub keeps that request pending so nothing leaves the test.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => {})),
		);
		renderRow(unreturned({ task_id: "t1", state: "running" }), new TranscriptStreams(), client);
		expect(icon().querySelector(".animate-spin")).not.toBeNull();
		expect(icon()).toHaveAccessibleName("Running");
		expect(card()).toHaveAttribute("data-tool-status", "running");
	});

	test("a returned card does not follow the task its details name", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		renderRow(
			{
				kind: "tool",
				key: "a1/0",
				callId: "call-1",
				name: "exec",
				args: { cmd: "true" },
				status: "done",
				output: "",
				details: { task_id: "t1", state: "exited" },
				result: { text: '{"task_id":"t1","state":"exited","exit_code":0}', isError: false, details: undefined },
			},
			new TranscriptStreams(),
			testQueryClient(),
			// Even an idle session must not change a returned card.
			false,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(icon()).toHaveAccessibleName("Done");
	});
});
