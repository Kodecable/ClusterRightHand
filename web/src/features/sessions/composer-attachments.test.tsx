import type { SessionView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/lib/session";
import { renderWithI18n } from "@/test/render";
import { Composer } from "./composer";

const USER = {
	id: "u1",
	username: "alice",
	displayName: "Alice",
	kind: "member" as const,
	email: null,
	status: "active" as const,
	createdAt: "2026-01-01T00:00:00.000Z",
};

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "s1",
		title: "Deploy",
		ownerUserId: "u1",
		parentSessionId: null,
		scheduleId: null,
		model: { provider: "faux", modelId: "faux-1" },
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		rules: {
			scope: { type: "user", id: "u1" },
			rulePreset: "ask",
			rules: [],
			default: "require-approval",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, createShares: true, configure: true },
		ownerUsername: "alice",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
		stats: {
			turns: 0,
			steps: 0,
			ttftMs: 0,
			ttftSteps: 0,
			decodeMs: 0,
			decodeTokens: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
		},
		...overrides,
	};
}

interface Call {
	url: string;
	body: { text?: string; requestId?: string; attachments?: { library: string; path: string }[] };
}

function mockFetch(): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/me")) {
				return new Response(JSON.stringify({ user: USER }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.endsWith("/api/models")) {
				return new Response(
					JSON.stringify({
						models: [
							{
								provider: "faux",
								providerName: "faux",
								modelId: "faux-1",
								name: "Faux",
								contextWindow: 128_000,
								thinkingLevels: ["off"],
								input: ["text"],
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.endsWith("/api/libraries")) {
				return new Response(
					JSON.stringify({
						libraries: [
							{
								id: "lib-1",
								ref: "user:alice",
								ownerKind: "user",
								ownerId: "u1",
								ownerName: "alice",
								ownerDisplayName: "Alice",
								usage: { files: 0, bytes: 0 },
								limits: { files: 1, fileBytes: 1, totalBytes: 1 },
								capabilities: { write: true, manage: false },
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/stat?path=")) {
				return new Response(JSON.stringify({ error: "no such library file" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			calls.push({ url, body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Call["body"]) });
			return new Response(JSON.stringify({ submissionId: "sub-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

/** The URL of the last upload, for the `rename=1` assertion. */
let lastUploadUrl = "";

/** An XHR that completes the upload at once and reports progress; enough for the upload queue. */
class FakeXhr {
	status = 201;
	responseText = "";
	responseType = "";
	upload = { addEventListener: (_event: string, _listener: () => void) => {} };
	private load: (() => void) | undefined;
	open(_method: string, url: string) {
		lastUploadUrl = url;
	}
	setRequestHeader() {}
	addEventListener(event: string, listener: () => void) {
		if (event === "load") this.load = listener;
	}
	send() {
		if (this.status === 201) {
			const requested = new URL(lastUploadUrl, "http://localhost").searchParams.get("path") ?? "attachments/x.txt";
			// The server picked the numbered name; the composer must carry the returned path, not its request.
			const path = requested.replace(/notes\.txt$/, "notes (1).txt");
			this.responseText = JSON.stringify({
				file: { path, size: 5, sha256: "a".repeat(64), mediaType: "text/plain" },
			});
		}
		setTimeout(() => this.load?.(), 0);
	}
	abort() {}
}

class FailingXhr extends FakeXhr {
	override status = 400;
	override responseText = JSON.stringify({ error: "the file is larger than the library's one-file size limit" });
}

function renderComposer(session = sessionView()) {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	return renderWithI18n(
		<QueryClientProvider client={client}>
			<Composer session={session} stoppable={false} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	authStore.clear();
	lastUploadUrl = "";
});

describe("composer attachments", () => {
	test("the owner sees the + menu; a session someone else owns does not show it", async () => {
		mockFetch();
		await authStore.load();
		const view = renderComposer();
		expect(screen.getByTestId("composer-attach")).toBeInTheDocument();
		view.unmount();
		renderComposer(sessionView({ ownerUserId: "u2", ownerUsername: "bob" }));
		expect(screen.queryByTestId("composer-attach")).not.toBeInTheDocument();
	});

	test("uploading a file shows a chip, and sending waits for the upload and carries the attachment", async () => {
		const calls = mockFetch();
		vi.stubGlobal("XMLHttpRequest", FakeXhr);
		await authStore.load();
		renderComposer();
		const input = screen.getByTestId("composer-upload-input") as HTMLInputElement;
		const file = new File(["hello"], "notes.txt", { type: "text/plain" });
		fireEvent.change(input, { target: { files: [file] } });
		expect(await screen.findByTestId("composer-attachments")).toBeInTheDocument();
		expect(screen.getByTestId("composer-attachment")).toHaveTextContent("notes.txt");

		fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "see attached" } });
		const send = screen.getByTestId("composer-send");
		await waitFor(() => expect(send).not.toBeDisabled());
		fireEvent.click(send);
		await waitFor(() => expect(calls.some((call) => call.url.endsWith("/messages"))).toBe(true));
		const message = calls.find((call) => call.url.endsWith("/messages"));
		expect(message?.body).toMatchObject({ text: "see attached" });
		expect(message?.body.attachments).toHaveLength(1);
		expect(message?.body.attachments?.[0]?.library).toBe("user:alice");
		// The upload asked the server to rename and the message carries the path the server returned.
		expect(lastUploadUrl).toContain("rename=1");
		expect(message?.body.attachments?.[0]?.path).toMatch(/^attachments\/\d{4}-\d{2}\/notes \(1\)\.txt$/);
	});

	test("a failed upload stays visible with its reason and blocks sending", async () => {
		mockFetch();
		vi.stubGlobal("XMLHttpRequest", FailingXhr);
		await authStore.load();
		renderComposer();
		fireEvent.change(screen.getByTestId("composer-upload-input"), {
			target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
		});
		const chip = await screen.findByTestId("composer-attachment");
		await waitFor(() => expect(chip).toHaveAttribute("data-status", "failed"));
		expect(chip).toHaveTextContent("the file is larger than the library's one-file size limit");
		fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "see attached" } });
		expect(screen.getByTestId("composer-send")).toBeDisabled();
	});

	test("the + menu offers uploads and opens the library picker", async () => {
		mockFetch();
		await authStore.load();
		renderComposer();
		fireEvent.click(screen.getByTestId("composer-attach"));
		expect(await screen.findByTestId("composer-upload")).toHaveTextContent("Upload files");
		const choose = screen.getByTestId("composer-choose-library");
		expect(choose).toHaveTextContent("Choose from library");
		fireEvent.click(choose);
		expect(await screen.findByTestId("attachment-picker")).toBeInTheDocument();
	});
});
