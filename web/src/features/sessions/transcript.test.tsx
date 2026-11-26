import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { Transcript } from "./transcript";
import type { TranscriptItem } from "./transcript-items";
import { TranscriptStreams } from "./transcript-streams";
import { buildTranscriptTurns } from "./turns";

/** The scroll requests the transcript sends through the virtualizer's handle. */
const scrollCalls = vi.hoisted(() => ({
	items: [] as { index: number; align: string | undefined }[],
	/** The row index the handle's `findItemIndex` answers: the row at the viewport's top third. */
	topThirdIndex: 0,
}));

// jsdom has no layout: render the virtualized rows directly so the anchor logic
// can be driven with explicit rectangles.
vi.mock("virtua", async () => {
	const { createElement } = await import("react");
	return {
		Virtualizer: (props: {
			data: unknown[];
			children: (item: unknown) => ReactNode;
			ref?: { current: unknown } | null;
		}) => {
			if (props.ref !== undefined && props.ref !== null) {
				props.ref.current = {
					scrollToIndex: (index: number, options?: { align?: string }) => {
						scrollCalls.items.push({ index, align: options?.align });
					},
					findItemIndex: () => scrollCalls.topThirdIndex,
					scrollOffset: 0,
					viewportSize: 600,
				};
			}
			return createElement(
				"div",
				null,
				props.data.map((row) => props.children(row)),
			);
		},
	};
});

const messages = (from: number, to: number): TranscriptItem[] =>
	Array.from({ length: to - from + 1 }, (_, index) => ({
		kind: "user",
		key: String(from + index),
		text: `message ${from + index}`,
	}));

const rect = (top: number, height = 50): DOMRect =>
	({
		x: 0,
		y: top,
		width: 300,
		height,
		top,
		right: 300,
		bottom: top + height,
		left: 0,
		toJSON: () => ({}),
	}) as DOMRect;

test("an anchor survives a streaming append and is applied only after the requested page prepends", async () => {
	const page = messages(1, 6);
	const streams = new TranscriptStreams();
	const onLoadOlder = vi.fn();
	const view = renderWithI18n(
		<Transcript
			items={page}
			streams={streams}
			ready
			sessionActive={false}
			running={false}
			hasOlder
			loadingOlder={false}
			onLoadOlder={onLoadOlder}
		/>,
	);
	const scroller = screen.getByTestId("transcript-scroller");
	let scrollTop = 0;
	Object.defineProperty(scroller, "scrollTop", {
		configurable: true,
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
	});
	scroller.getBoundingClientRect = () => rect(0, 400);
	for (const [index, row] of screen.getAllByTestId("message").entries()) {
		row.getBoundingClientRect = () => rect(100 + index * 50 - scrollTop);
	}

	// Hitting the top asks for an older page and records the reading anchor.
	fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
	await waitFor(() => expect(onLoadOlder).toHaveBeenCalled());
	expect(scroller.dataset.prependAnchorId).toBe("1");

	// A streaming update only appends a row. Letting a premature realign run to
	// completion proves that it did not consume the anchor.
	view.rerender(
		<Transcript
			items={[...page, { kind: "user", key: "7", text: "message 7" }]}
			streams={streams}
			ready
			sessionActive={false}
			running={false}
			hasOlder
			loadingOlder={false}
			onLoadOlder={onLoadOlder}
		/>,
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 450));
	});
	expect(scrollTop).toBe(0);

	// The page arrives and is prepended; now the anchor is due, and scrolling
	// back to it keeps the same row at the same viewport offset.
	const anchorRow = scroller.querySelector<HTMLElement>('[data-message-id="1"]');
	expect(anchorRow).not.toBeNull();
	if (anchorRow !== null) anchorRow.getBoundingClientRect = () => rect(130 - scrollTop);
	view.rerender(
		<Transcript
			items={[{ kind: "user", key: "0", text: "message 0" }, ...page, { kind: "user", key: "7", text: "message 7" }]}
			streams={streams}
			ready
			sessionActive={false}
			running={false}
			hasOlder
			loadingOlder={false}
			onLoadOlder={onLoadOlder}
		/>,
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 80));
	});
	expect(scrollTop).toBe(30);
});

test("shows the retry attempt at the end of a running turn and hides it when a message streams or the session stops", () => {
	const streams = new TranscriptStreams();
	const items: TranscriptItem[] = [
		{ kind: "user", key: "u1", text: "do it" },
		{ kind: "error", key: "e1", reason: "failed", message: "terminated" },
		{ kind: "error", key: "e2", reason: "failed", message: "terminated" },
	];
	const view = renderWithI18n(
		<Transcript
			items={items}
			streams={streams}
			ready
			sessionActive
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.getByTestId("retrying")).toHaveTextContent("Retrying (attempt 3)…");
	expect(screen.getAllByRole("alert")).toHaveLength(2);

	view.rerender(
		<Transcript
			items={[...items, { kind: "text", key: "a1", text: "again", streaming: true, final: false }]}
			streams={streams}
			ready
			sessionActive
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.queryByTestId("retrying")).toBeNull();
	expect(screen.getAllByRole("alert")).toHaveLength(2);

	view.rerender(
		<Transcript
			items={items}
			streams={streams}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.queryByTestId("retrying")).toBeNull();
	expect(screen.getAllByRole("alert")).toHaveLength(2);
});

test("a copy action sits under the user message and the final reply, never under process rows", () => {
	const items: TranscriptItem[] = [
		{ kind: "user", key: "u1", text: "do it", at: 1_000 },
		{ kind: "thinking", key: "t1", text: "hmm", streaming: false },
		{ kind: "text", key: "a1", text: "interim text", streaming: false, final: false },
		{ kind: "text", key: "a2", text: "final answer", streaming: false, final: true, at: 2_000, durationMs: 1_000 },
	];
	renderWithI18n(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.getAllByTestId("message-actions")).toHaveLength(2);
	expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Copy reply" })).toBeInTheDocument();

	// Expanding the completed turn brings back the process rows: they have no copy action of their own.
	fireEvent.click(screen.getByRole("button", { name: /^Ended in / }));
	expect(screen.getByText("interim text")).toBeInTheDocument();
	expect(screen.getAllByTestId("message-actions")).toHaveLength(2);
	expect(screen.queryAllByRole("button", { name: "Copy" })).toHaveLength(0);
});

test("a turn's delivered files sit between its final answer and the reply's actions", () => {
	const items: TranscriptItem[] = [
		{ kind: "user", key: "u1", text: "hand me the report", at: 1_000 },
		{
			kind: "tool",
			key: "c1",
			callId: "call-1",
			name: "copy_file",
			args: {},
			status: "done",
			output: "",
			details: undefined,
			result: {
				text: "offered report.txt",
				isError: false,
				details: {
					delivery: {
						source: { node: "web-1", nodeId: "node-1", path: "/srv/report.txt" },
						name: "report.txt",
						bytes: 12,
					},
				},
			},
		},
		{
			kind: "text",
			key: "a1",
			text: "Here is the report.",
			streaming: false,
			final: true,
			at: 2_000,
			durationMs: 1_000,
		},
	];
	renderWithI18n(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	const answer = screen.getByText("Here is the report.");
	const deliveries = screen.getByTestId("turn-deliveries");
	const actions = screen.getByRole("button", { name: "Copy reply" }).closest('[data-testid="message-actions"]');
	expect(actions).not.toBeNull();
	if (actions === null) return;
	expect(answer.compareDocumentPosition(deliveries) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(deliveries.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	// The action row is its own row, outside the answer's message row.
	expect(actions.closest('[data-testid="message"]')).toBeNull();
});

test("the owner's fork action sits under an ended turn's final reply only", () => {
	const items: TranscriptItem[] = [
		{ kind: "user", key: "u1", text: "do it", at: 1_000, entryId: "1" },
		{ kind: "thinking", key: "t1", text: "hmm", streaming: false },
		{ kind: "text", key: "a1", text: "interim text", streaming: false, final: false, entryId: "2" },
		{ kind: "text", key: "a2", text: "final answer", streaming: false, final: true, entryId: "7", at: 2_000 },
	];
	const onFork = vi.fn();
	const result = renderWithI18n(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
			canFork
			onFork={onFork}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
	expect(onFork).toHaveBeenCalledWith(7);
	expect(screen.getAllByRole("button", { name: "Fork from here" })).toHaveLength(1);

	// The same final reply in a running turn is not forkable yet.
	result.unmount();
	renderWithI18n(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
			canFork
			onFork={onFork}
		/>,
	);
	expect(screen.queryByRole("button", { name: "Fork from here" })).not.toBeInTheDocument();
});

test("a notice line starts its own turn, so the previous turn still folds and the notice stays visible", () => {
	const items: TranscriptItem[] = [
		{ kind: "user", key: "u1", text: "hi", at: 0 },
		{ kind: "thinking", key: "th1", text: "thinking", streaming: false },
		{ kind: "text", key: "a1", text: "done", streaming: false, final: true, at: 1_000, durationMs: 1_000 },
		{ kind: "notice", key: "n1", notice: { type: "agent_request" } },
		{ kind: "text", key: "a2", text: "woken answer", streaming: false, final: true, at: 2_000, durationMs: 1_000 },
	];
	const turns = buildTranscriptTurns(items, false);
	expect(turns).toHaveLength(2);
	expect(turns[0]?.foldable).toBe(true);
	expect(turns[0]?.body.map((item) => item.kind)).toEqual(["thinking", "text"]);
	expect(turns[1]?.user).toBeUndefined();
	expect(turns[1]?.body.map((item) => item.kind)).toEqual(["notice", "text"]);
	expect(turns[1]?.foldable).toBe(false);
});

test("the running line follows the last row only while this session's own turn runs", () => {
	const streams = new TranscriptStreams();
	const items: TranscriptItem[] = [
		{ kind: "user", key: "u1", text: "do it" },
		{ kind: "thinking", key: "t1", text: "hmm", streaming: false },
	];
	const view = renderWithI18n(
		<Transcript
			items={items}
			streams={streams}
			ready
			sessionActive
			running
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	const line = screen.getByTestId("transcript-running");
	expect(line).toHaveTextContent("Running…");
	expect(line.querySelector(".animate-spin")).not.toBeNull();
	// Inside the scroller, after the last transcript row, so it scrolls with the content.
	expect(screen.getByTestId("transcript-scroller")).toContainElement(line);
	const lastRow = screen.getAllByTestId("message").at(-1);
	expect(lastRow).toBeDefined();
	expect((lastRow?.compareDocumentPosition(line) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

	// Idle: the turn ended and the line goes.
	view.rerender(
		<Transcript
			items={items}
			streams={streams}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.queryByTestId("transcript-running")).toBeNull();

	// Awaiting: the session is active but no turn runs, so the line stays away.
	view.rerender(
		<Transcript
			items={items}
			streams={streams}
			ready
			sessionActive
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.queryByTestId("transcript-running")).toBeNull();
});

test("a focus request scrolls again for every new token and honours its alignment", async () => {
	const items: TranscriptItem[] = [
		{ kind: "user", key: "1", entryId: "1", text: "one" },
		{ kind: "user", key: "2", entryId: "2", text: "two" },
		{ kind: "user", key: "3", entryId: "3", text: "three" },
	];
	const focus = (token: number, align: "center" | "start") => ({ entryId: "2", align, token });
	scrollCalls.items.length = 0;
	const view = renderWithI18n(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
			focusRequest={focus(1, "center")}
		/>,
	);
	await waitFor(() => expect(scrollCalls.items.some((call) => call.index === 1 && call.align === "center")).toBe(true));

	// The same entry with a new token scrolls again, this time aligned to the top for a rail jump.
	view.rerender(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
			focusRequest={focus(2, "start")}
		/>,
	);
	await waitFor(() => expect(scrollCalls.items.some((call) => call.index === 1 && call.align === "start")).toBe(true));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 120));
	});

	// The same token is already handled: no further scroll.
	const calls = scrollCalls.items.length;
	view.rerender(
		<Transcript
			items={items}
			streams={new TranscriptStreams()}
			ready
			sessionActive={false}
			running={false}
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
			focusRequest={focus(2, "start")}
		/>,
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 120));
	});
	expect(scrollCalls.items).toHaveLength(calls);
});

describe("the turn rail", () => {
	const turnItems: TranscriptItem[] = [
		{ kind: "user", key: "1", entryId: "1", text: "first question" },
		{ kind: "text", key: "a1", entryId: "a1", text: "first answer", streaming: true, final: false },
		{ kind: "user", key: "2", entryId: "2", text: "second question" },
		{ kind: "text", key: "a2", entryId: "a2", text: "second answer", streaming: true, final: false },
	];
	const renderWithRail = () =>
		renderWithI18n(
			<Transcript
				items={turnItems}
				streams={new TranscriptStreams()}
				ready
				sessionActive
				running={false}
				hasOlder={false}
				loadingOlder={false}
				onLoadOlder={() => {}}
				sessionId="s1"
				historyCursor={null}
				onJumpToEntry={() => {}}
			/>,
		);
	const mark = (name: string) => screen.getByRole("button", { name: `Go to message: ${name}` });

	afterEach(() => {
		scrollCalls.topThirdIndex = 0;
		vi.unstubAllGlobals();
	});

	test("marks the user turn whose rows reach the viewport's top third", async () => {
		vi.stubGlobal("innerWidth", 1280);
		// The top third is the second answer's row: its turn starts at the second question.
		scrollCalls.topThirdIndex = 3;
		renderWithRail();
		await waitFor(() => expect(mark("second question")).toHaveAttribute("aria-current", "true"));
		expect(mark("first question")).not.toHaveAttribute("aria-current");

		// Scrolled back to the first answer: the first question's turn is active.
		scrollCalls.topThirdIndex = 1;
		fireEvent.scroll(screen.getByTestId("transcript-scroller"));
		await waitFor(() => expect(mark("first question")).toHaveAttribute("aria-current", "true"));
		expect(mark("second question")).not.toHaveAttribute("aria-current");
	});

	test("appears only on a transcript at least 960 px wide", async () => {
		vi.stubGlobal("innerWidth", 959);
		const narrow = renderWithRail();
		expect(screen.queryByTestId("turn-rail")).toBeNull();
		narrow.unmount();

		vi.stubGlobal("innerWidth", 960);
		renderWithRail();
		expect(await screen.findByTestId("turn-rail")).toBeInTheDocument();
	});
});
