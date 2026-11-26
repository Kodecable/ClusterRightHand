import type { SessionOutlinePage } from "@crh/api";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { TurnRail } from "./turn-rail";

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Serve the outline endpoint from a per-cursor map and record the cursors asked for. */
function stubOutline(pages: Record<string, SessionOutlinePage>): (string | null)[] {
	const calls: (string | null)[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const before = url.searchParams.get("before");
			calls.push(before);
			return json(pages[before ?? ""] ?? { turns: [], cursor: null });
		}),
	);
	return calls;
}

const LOADED = [
	{ entryId: "10", text: "newer loaded question" },
	{ entryId: "11", text: "newest loaded question" },
];

function renderRail(overrides: Partial<ComponentProps<typeof TurnRail>> = {}) {
	return renderWithI18n(
		<TurnRail
			sessionId="s1"
			historyCursor={null}
			loadedItems={LOADED}
			activeEntryId={null}
			onJumpToEntry={() => {}}
			{...overrides}
		/>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("renders loaded and unloaded marks, oldest first", async () => {
	stubOutline({
		h1: { turns: [{ entryId: 3, text: "older outline turn", truncated: false }], cursor: null },
	});
	renderRail({ historyCursor: "h1" });
	const older = await screen.findByRole("button", { name: "Go to message: older outline turn" });
	expect(older).toHaveAttribute("data-loaded", "false");
	const marks = screen.getByRole("navigation", { name: "Messages" }).querySelectorAll("[data-rail-entry]");
	expect([...marks].map((mark) => mark.getAttribute("data-rail-entry"))).toEqual(["3", "10", "11"]);
	for (const loaded of LOADED) {
		const mark = screen.getByRole("button", { name: `Go to message: ${loaded.text}` });
		expect(mark).toHaveAttribute("data-loaded", "true");
	}
});

test("clicking a mark calls onJumpToEntry", () => {
	const onJumpToEntry = vi.fn();
	renderRail({ onJumpToEntry });
	fireEvent.click(screen.getByRole("button", { name: "Go to message: newer loaded question" }));
	expect(onJumpToEntry).toHaveBeenCalledWith("10");
});

test("hovering a truncated mark shows the preview with an ellipsis", async () => {
	stubOutline({
		h1: {
			turns: [{ entryId: 3, text: "a question the server cut", truncated: true }],
			cursor: null,
		},
	});
	renderRail({ historyCursor: "h1" });
	const mark = await screen.findByRole("button", { name: "Go to message: a question the server cut" });
	fireEvent.pointerMove(mark);
	const preview = await screen.findByTestId("turn-rail-preview");
	expect(preview).toHaveTextContent("a question the server cut…");
});

test("the active turn's mark carries aria-current", () => {
	renderRail({ activeEntryId: "11" });
	const active = screen.getByRole("button", { name: "Go to message: newest loaded question" });
	expect(active).toHaveAttribute("aria-current", "true");
	expect(screen.getByRole("button", { name: "Go to message: newer loaded question" })).not.toHaveAttribute(
		"aria-current",
	);
});

test("is hidden while fewer than two items exist and no outline page may follow", () => {
	const { container } = renderRail({ loadedItems: [{ entryId: "10", text: "only one" }] });
	expect(container).toBeEmptyDOMElement();
});

test("scrolling the rail to its top asks for the next outline page", async () => {
	const calls = stubOutline({
		h1: {
			turns: [
				{ entryId: 3, text: "second chunk", truncated: false },
				{ entryId: 4, text: "first chunk", truncated: false },
			],
			cursor: "c1",
		},
		c1: { turns: [{ entryId: 1, text: "oldest", truncated: false }], cursor: null },
	});
	renderRail({ historyCursor: "h1" });
	await screen.findByRole("button", { name: "Go to message: second chunk" });
	expect(calls).toEqual(["h1"]);

	fireEvent.scroll(screen.getByTestId("turn-rail-scroller"), { target: { scrollTop: 0 } });
	await waitFor(() => expect(calls).toContain("c1"));
	expect(await screen.findByRole("button", { name: "Go to message: oldest" })).toBeInTheDocument();
});

test("the mark of a rail jump still loading history pulses, and only that one", () => {
	renderRail({ pendingEntryId: "10" });
	expect(screen.getByRole("button", { name: "Go to message: newer loaded question" })).toHaveClass("animate-pulse");
	expect(screen.getByRole("button", { name: "Go to message: newest loaded question" })).not.toHaveClass(
		"animate-pulse",
	);
});
