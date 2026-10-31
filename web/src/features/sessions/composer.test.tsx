import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { Composer } from "./composer";

interface Call {
	url: string;
	body: unknown;
}

function mockFetch(): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			});
			return new Response(JSON.stringify({ submissionId: "sub-1", ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

function renderComposer(props: { canChat?: boolean; running?: boolean } = {}) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return renderWithI18n(
		<QueryClientProvider client={client}>
			<Composer sessionId="s1" canChat={props.canChat ?? true} running={props.running ?? false} waitingKind={null} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Composer", () => {
	test("Enter sends the trimmed message with a request id", async () => {
		const calls = mockFetch();
		renderComposer();
		const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "  restart nginx  " } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(input.value).toBe(""));
		expect(calls).toHaveLength(1);
		const first = calls[0] as Call;
		expect(first.url).toBe("/api/sessions/s1/messages");
		expect(first.body).toMatchObject({ text: "restart nginx" });
		expect(typeof (first.body as { requestId?: unknown }).requestId).toBe("string");
	});

	test("Shift+Enter does not send", () => {
		const calls = mockFetch();
		renderComposer();
		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "one line" } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(calls).toHaveLength(0);
	});

	test("Send is disabled while the message is empty", () => {
		mockFetch();
		renderComposer();
		expect(screen.getByTestId("composer-send")).toBeDisabled();
	});

	test("a running session can be stopped from the composer", async () => {
		const calls = mockFetch();
		renderComposer({ running: true });
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
});
