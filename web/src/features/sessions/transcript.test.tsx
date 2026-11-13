import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { Transcript } from "./transcript";
import type { TranscriptItem } from "./transcript-items";
import { TranscriptStreams } from "./transcript-streams";

// jsdom has no layout: render the virtualized rows directly so the anchor logic
// can be driven with explicit rectangles.
vi.mock("virtua", async () => {
	const { createElement } = await import("react");
	return {
		Virtualizer: (props: { data: unknown[]; children: (item: unknown) => ReactNode }) =>
			createElement(
				"div",
				null,
				props.data.map((row) => props.children(row)),
			),
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
			hasOlder={false}
			loadingOlder={false}
			onLoadOlder={() => {}}
		/>,
	);
	expect(screen.queryByTestId("retrying")).toBeNull();
	expect(screen.getAllByRole("alert")).toHaveLength(2);
});
