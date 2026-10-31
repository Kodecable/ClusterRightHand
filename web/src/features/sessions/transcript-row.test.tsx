import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithI18n } from "@/test/render";
import type { TranscriptItem } from "./sessionState";
import { TranscriptRow } from "./transcript-row";
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
