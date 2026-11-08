import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AvailableModel, SessionView } from "@/lib/api/types";
import { renderWithI18n } from "@/test/render";
import { Composer } from "./composer";

interface Call {
	url: string;
	body: { text?: string; requestId?: string; instructions?: string };
}

interface Reply {
	status?: number;
	body?: unknown;
	/** Answer only after this promise resolves: a send that lands later. */
	hold?: Promise<void>;
}

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "s1",
		title: "Deploy the cluster",
		ownerUserId: "u1",
		parentSessionId: null,
		scheduleId: null,
		model: { provider: "faux", modelId: "faux-1" },
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		rules: {
			scope: { type: "user", id: "u1" },
			rulePreset: "yolo",
			rules: [],
			default: "ask",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, createShares: true, configure: true },
		ownerUsername: "ops",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		budgetRemaining: 12_345,
		budgetUsedTokens: 0,
		usageTokens: 1_500_000,
		contextTokens: 64_000,
		...overrides,
	};
}

const DEFAULT_MODELS: AvailableModel[] = [
	{
		provider: "faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off"],
		input: ["text"],
	},
];

function mockFetch(replies: Reply[] = [], models: AvailableModel[] = DEFAULT_MODELS): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			// The composer footer reads the model list for its context window; it is not one of the send replies.
			if (url.endsWith("/api/models")) {
				return new Response(
					JSON.stringify({
						models,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			calls.push({
				url,
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

function renderComposer(props: { canChat?: boolean; stoppable?: boolean; session?: Partial<SessionView> } = {}) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const element = (id: string) => {
		const session = sessionView({
			id,
			capabilities: {
				view: true,
				chat: props.canChat ?? true,
				manageShares: true,
				createShares: true,
				configure: true,
			},
			...(props.session ?? {}),
		});
		return (
			<QueryClientProvider client={client}>
				<Composer session={session} stoppable={props.stoppable ?? false} />
			</QueryClientProvider>
		);
	};
	const result = renderWithI18n(element("s1"));
	return {
		...result,
		/** Open another session the way the router does: same page, new session id. */
		switchTo: (id: string) => result.rerender(element(id)),
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

	test("a /compact command posts its instructions instead of a message", async () => {
		const calls = mockFetch([{ body: { taskId: "task-1", outcome: "started" } }]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compact keep node names" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(input().value).toBe(""));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/sessions/s1/compact");
		expect(calls[0]?.body).toEqual({ instructions: "keep node names" });
		expect(calls.some((call) => call.url.endsWith("/messages"))).toBe(false);
	});

	test("/compact alone posts an empty body", async () => {
		const calls = mockFetch([{ body: { taskId: "task-1", outcome: "started" } }]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compact" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(input().value).toBe(""));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/sessions/s1/compact");
		expect(calls[0]?.body).toEqual({});
	});

	test("a compaction with nothing to summarize says so", async () => {
		const info = vi.spyOn(toast, "info").mockImplementation(() => "");
		const calls = mockFetch([{ body: { taskId: "task-1", outcome: "nothing" } }]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compact" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(input().value).toBe(""));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/sessions/s1/compact");
		expect(info).toHaveBeenCalledWith(
			"Nothing to compact yet: the most recent ~20k tokens of the conversation are always kept as they are.",
		);
	});

	test("a word that only starts with /compact is a normal message", async () => {
		const calls = mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compactor" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]?.url).toBe("/api/sessions/s1/messages");
		expect(calls[0]?.body).toMatchObject({ text: "/compactor" });
	});

	test("typing / opens the command list and an unknown token explains itself", () => {
		mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "/" } });
		const listbox = screen.getByRole("listbox");
		expect(within(listbox).getByRole("option")).toHaveTextContent("/compact");
		expect(input()).toHaveAttribute("aria-expanded", "true");
		expect(input()).toHaveAttribute("aria-controls", listbox.id);

		fireEvent.change(input(), { target: { value: "/co" } });
		expect(within(screen.getByRole("listbox")).getByRole("option")).toHaveTextContent("/compact");

		fireEvent.change(input(), { target: { value: "/x" } });
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(screen.getByTestId("slash-hint")).toHaveTextContent("Unknown command: it will be sent as a message.");
	});

	test("Tab completes /co and the completed command accepts instructions", async () => {
		const calls = mockFetch([{ body: { taskId: "task-1", outcome: "started" } }]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "/co" } });
		fireEvent.keyDown(input(), { key: "Tab" });
		expect(input().value).toBe("/compact ");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

		fireEvent.change(input(), { target: { value: "/compact keep x" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(input().value).toBe(""));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/sessions/s1/compact");
		expect(calls[0]?.body).toEqual({ instructions: "keep x" });
	});

	test("Enter on an exact command runs it rather than completing it", async () => {
		const calls = mockFetch([{ body: { taskId: "task-1", outcome: "started" } }]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compact" } });
		expect(screen.getByRole("listbox")).toBeInTheDocument();
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() => expect(input().value).toBe(""));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/sessions/s1/compact");
		expect(calls[0]?.body).toEqual({});
	});

	test("Enter on a partial command completes it without sending", () => {
		const calls = mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "/co" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(input().value).toBe("/compact ");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(calls).toHaveLength(0);
	});

	test("Escape closes the list until the draft changes", () => {
		mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "/co" } });
		expect(screen.getByRole("listbox")).toBeInTheDocument();
		fireEvent.keyDown(input(), { key: "Escape" });
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		fireEvent.change(input(), { target: { value: "/com" } });
		expect(screen.getByRole("listbox")).toBeInTheDocument();
	});

	test("clicking a suggestion completes it", () => {
		mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "/co" } });
		fireEvent.mouseDown(screen.getByTestId("slash-option-compact"));
		expect(input().value).toBe("/compact ");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	test("a complete command explains itself and that it is not sent", () => {
		mockFetch();
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compact keep node names" } });
		const hint = screen.getByTestId("slash-hint");
		expect(hint).toHaveTextContent("/compact:");
		expect(hint).toHaveTextContent("not sent as a message");
	});

	test("a failed /compact keeps the draft and shows the server's message", async () => {
		const quota = "the session's token quota is used up; raise it to continue";
		const calls = mockFetch([{ status: 400, body: { error: quota } }]);
		renderComposer();
		fireEvent.change(input(), { target: { value: "/compact keep node names" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		await screen.findByText(quota);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("/api/sessions/s1/compact");
		expect(input().value).toBe("/compact keep node names");
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

	test("mutations elsewhere in the document do not measure the transcript", async () => {
		mockFetch();
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		renderWithI18n(
			<QueryClientProvider client={client}>
				<div data-testid="session-page">
					<div data-slot="transcript" data-testid="fixture-transcript" />
					<Composer session={sessionView()} stoppable={false} />
				</div>
			</QueryClientProvider>,
		);
		const transcript = screen.getByTestId("fixture-transcript");
		let reads = 0;
		Object.defineProperty(transcript, "clientHeight", {
			configurable: true,
			get: () => {
				reads += 1;
				return 600;
			},
		});

		// A mutation elsewhere (a toast, a portal, another page's DOM) is not the
		// transcript pane and must not force a measurement.
		const elsewhere = document.createElement("div");
		document.body.append(elsewhere);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(reads).toBe(0);

		// The transcript mounting or being replaced is a page-level change: the
		// observer finds it again and measures once on the next frame.
		screen.getByTestId("session-page").append(document.createElement("div"));
		await act(async () => {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		});
		expect(reads).toBeGreaterThan(0);
		elsewhere.remove();
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

describe("ComposerFooter", () => {
	test("shows the rule preset name, the remaining budget, the context fill and the total usage", async () => {
		mockFetch();
		renderComposer();
		await waitFor(() => expect(screen.getByTestId("composer-context")).toHaveTextContent("50%"));
		expect(screen.getByTestId("composer-model")).toHaveTextContent("faux/faux-1");
		expect(screen.getByTestId("composer-rules")).toHaveTextContent("Yolo");
		expect(screen.getByTestId("composer-budget")).toHaveTextContent("12.3K");
		expect(screen.getByTestId("composer-usage")).toHaveTextContent("1.5M");
		// The exact numbers are the tooltips.
		expect(screen.getByTestId("composer-budget")).toHaveAttribute("title", "12,345 tokens left");
		expect(screen.getByTestId("composer-context")).toHaveAttribute("title", "64,000 / 128,000");
		expect(screen.getByTestId("composer-usage")).toHaveAttribute("title", "1,500,000 tokens in total");
		expect(screen.getByTestId("composer-rules").querySelector(".lucide-shield-alert")).not.toBeNull();
		expect(screen.getByTestId("composer-budget").querySelector(".lucide-droplet")).not.toBeNull();
		expect(screen.getByTestId("composer-usage").querySelector(".lucide-database")).not.toBeNull();
	});

	test("the thinking picker lists only the model's levels and PATCHes the model with the level", async () => {
		const calls = mockFetch(
			[],
			[
				{
					provider: "faux",
					modelId: "faux-1",
					name: "Faux One",
					contextWindow: 128_000,
					thinkingLevels: ["off", "low", "high"],
					input: ["text"],
				},
			],
		);
		renderComposer({ session: { model: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" } } });
		const user = userEvent.setup();
		const trigger = await screen.findByTestId("composer-thinking");
		expect(trigger).toHaveTextContent("High");
		await user.click(trigger);
		await user.click(await screen.findByRole("option", { name: "Low" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toEqual({
			url: "/api/sessions/s1",
			body: { model: { provider: "faux", modelId: "faux-1", thinkingLevel: "low" } },
		});
	});

	test("the thinking picker uses a custom model's display names and hides hidden levels", async () => {
		const calls = mockFetch(
			[],
			[
				{
					provider: "faux",
					modelId: "faux-1",
					name: "Faux One",
					contextWindow: 128_000,
					thinkingLevels: ["off", "low", "high"],
					thinkingLabels: { off: "Off", low: "Quick", high: "Deep" },
					input: ["text"],
				},
			],
		);
		renderComposer({ session: { model: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" } } });
		const user = userEvent.setup();
		const trigger = await screen.findByTestId("composer-thinking");
		expect(trigger).toHaveTextContent("Deep");
		await user.click(trigger);
		expect(await screen.findByRole("option", { name: "Quick" })).toBeVisible();
		// The server's list excludes hidden levels, so the picker never shows them.
		expect(screen.queryByRole("option", { name: "Medium" })).toBeNull();
		await user.click(await screen.findByRole("option", { name: "Quick" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toEqual({
			url: "/api/sessions/s1",
			body: { model: { provider: "faux", modelId: "faux-1", thinkingLevel: "low" } },
		});
	});

	test("the thinking picker is hidden when the model only supports off", async () => {
		mockFetch(
			[],
			[
				{
					provider: "faux",
					modelId: "faux-1",
					name: "Faux One",
					contextWindow: 128_000,
					thinkingLevels: ["off"],
					input: ["text"],
				},
			],
		);
		renderComposer();
		await waitFor(() => expect(screen.getByTestId("composer-rules")).toBeInTheDocument());
		expect(screen.queryByTestId("composer-thinking")).not.toBeInTheDocument();
	});

	test("an unlimited budget reads infinity, and a negative one reads 0 in the danger tone", async () => {
		mockFetch();
		const view = renderComposer({ session: { budgetRemaining: null } });
		expect(screen.getByTestId("composer-budget")).toHaveTextContent("∞");
		view.rerender(
			<QueryClientProvider client={new QueryClient()}>
				<Composer session={sessionView({ budgetRemaining: -5 })} stoppable={false} />
			</QueryClientProvider>,
		);
		const budget = screen.getByTestId("composer-budget");
		expect(budget).toHaveTextContent("0");
		expect(budget.className).toContain("text-danger");
	});

	test("the context ring is hidden until the session has a main call", async () => {
		mockFetch();
		renderComposer({ session: { contextTokens: null } });
		await waitFor(() => expect(screen.getByTestId("composer-rules")).toBeInTheDocument());
		expect(screen.queryByTestId("composer-context")).not.toBeInTheDocument();
	});

	test("a subagent has no rule preset picker but shows its rules summary", async () => {
		mockFetch();
		renderComposer({
			session: {
				parentSessionId: "root-1",
				rules: {
					scope: { type: "session", id: "s1" },
					rulePreset: null,
					rules: [{ action: "allow", method: "file.read" }],
					default: "inherit",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});
		expect(screen.getByTestId("composer-rules")).toHaveTextContent("Rules: 1");
		expect(screen.queryByRole("button", { name: "Rule preset" })).not.toBeInTheDocument();
	});

	test("the icon button is Stop for an empty draft while stoppable, Send otherwise", () => {
		mockFetch();
		renderComposer({ stoppable: true });
		expect(screen.getByTestId("abort-session").querySelector(".lucide-square")).not.toBeNull();
		expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();

		fireEvent.change(input(), { target: { value: "steer the run" } });
		expect(screen.getByTestId("composer-send").querySelector(".lucide-arrow-up")).not.toBeNull();
		expect(screen.queryByTestId("abort-session")).not.toBeInTheDocument();

		fireEvent.change(input(), { target: { value: "" } });
		expect(screen.getByTestId("abort-session")).toBeInTheDocument();
	});
});
