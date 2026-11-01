import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { Composer } from "./composer";

interface Call {
	url: string;
	body: { text?: string; requestId?: string };
}

interface Reply {
	status?: number;
	body?: unknown;
	/** Answer only after this promise resolves: a send that lands later. */
	hold?: Promise<void>;
}

function mockFetch(replies: Reply[] = []): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				body: init?.body === undefined ? {} : JSON.parse(String(init.body)),
			});
			const reply = replies.shift();
			if (reply?.hold !== undefined) await reply.hold;
			return new Response(JSON.stringify(reply?.body ?? { submissionId: "sub-1", ok: true }), {
				status: reply?.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function renderComposer(props: { canChat?: boolean; stoppable?: boolean } = {}) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const element = (sessionId: string) => (
		<QueryClientProvider client={client}>
			<Composer
				sessionId={sessionId}
				canChat={props.canChat ?? true}
				stoppable={props.stoppable ?? false}
				waitingKind={null}
			/>
		</QueryClientProvider>
	);
	const result = renderWithI18n(element("s1"));
	return {
		...result,
		/** Open another session the way the router does: same page, new session id. */
		switchTo: (sessionId: string) => result.rerender(element(sessionId)),
	};
}

const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Composer", () => {
	test("Enter sends the trimmed message with a request id", async () => {
		const calls = mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "  restart nginx  " } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(input().value).toBe(""));
		expect(calls).toHaveLength(1);
		const first = calls[0] as Call;
		expect(first.url).toBe("/api/sessions/s1/messages");
		expect(first.body).toMatchObject({ text: "restart nginx" });
		expect(typeof first.body.requestId).toBe("string");
	});

	test("Shift+Enter does not send", () => {
		const calls = mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "one line" } });
		fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
		expect(calls).toHaveLength(0);
	});

	test("Send is disabled while the message is empty", () => {
		mockFetch();
		renderComposer();
		expect(screen.getByTestId("composer-send")).toBeDisabled();
	});

	test("a stoppable session can be stopped from the composer", async () => {
		const calls = mockFetch();
		renderComposer({ stoppable: true });
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]?.url).toBe("/api/sessions/s1/abort");
	});

	test("view access shows a read-only hint instead of the form", () => {
		mockFetch();
		renderComposer({ canChat: false });
		expect(screen.queryByTestId("composer-input")).not.toBeInTheDocument();
		expect(screen.getByText(/You have view access/)).toBeInTheDocument();
	});

	test("switching sessions drops the draft and the failed send", async () => {
		mockFetch([{ status: 500, body: { error: "the server refused it" } }]);
		const view = renderComposer();
		fireEvent.change(input(), { target: { value: "draft for s1" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await screen.findByText("the server refused it");

		view.switchTo("s2");

		expect(input().value).toBe("");
		expect(screen.queryByText("the server refused it")).not.toBeInTheDocument();
		expect(screen.getByTestId("composer-send")).toBeDisabled();
	});

	test("a send answering after the switch does not clear the new session's draft", async () => {
		const late = deferred();
		const calls = mockFetch([{ hold: late.promise }]);
		const view = renderComposer();
		fireEvent.change(input(), { target: { value: "draft for s1" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(calls).toHaveLength(1));

		view.switchTo("s2");
		fireEvent.change(input(), { target: { value: "draft for s2" } });
		await act(async () => {
			late.resolve();
			await Promise.resolve();
		});

		expect(input().value).toBe("draft for s2");
	});

	test("a retried send reuses the request id until the text changes", async () => {
		const calls = mockFetch([
			{ status: 500, body: { error: "lost the answer" } },
			{ status: 500, body: { error: "lost the answer" } },
			{ status: 200, body: { submissionId: "sub-1" } },
		]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "retry me" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await screen.findByText("lost the answer");

		// The text is unchanged: the server must see the same id and dedupe the retry.
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(calls).toHaveLength(2));

		// A new draft is a new message and gets an id of its own.
		fireEvent.change(input(), { target: { value: "retry me, edited" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(calls).toHaveLength(3));

		const ids = calls.map((call) => call.body.requestId);
		expect(ids[0]).toBeTypeOf("string");
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).not.toBe(ids[0]);
	});
});
