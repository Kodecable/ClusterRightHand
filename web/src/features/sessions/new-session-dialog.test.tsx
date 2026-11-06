import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { NewSessionDialog } from "./new-session-dialog";

const MODELS = [
	{
		provider: "faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off", "low", "high"],
		input: ["text"],
	},
	{
		provider: "faux",
		modelId: "faux-2",
		name: "Faux Plain",
		contextWindow: 128_000,
		thinkingLevels: ["off"],
		input: ["text"],
	},
];

function mockFetch(): { body: Record<string, unknown> | undefined }[] {
	const calls: { body: Record<string, unknown> | undefined }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/models")) {
				return new Response(JSON.stringify({ models: MODELS }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "/api/sessions" && init?.method === "POST") {
				calls.push({ body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
				return new Response(JSON.stringify({ session: { id: "s-new" } }), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ items: [], nextCursor: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("NewSessionDialog", () => {
	test("sends the selected thinking level with the model", async () => {
		const calls = mockFetch();
		await renderWithRouter(<NewSessionDialog open onOpenChange={() => {}} />);
		const user = userEvent.setup();
		await screen.findByText("Faux One");
		await user.click(screen.getByLabelText("Thinking level"));
		await user.click(await screen.findByRole("option", { name: "High" }));
		await waitFor(() => expect(screen.getByLabelText("Thinking level")).toHaveTextContent("High"));
		await user.click(screen.getByRole("button", { name: "Create session" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]?.body).toMatchObject({
			model: { provider: "faux", modelId: "faux-1", thinkingLevel: "high" },
			rulePreset: "ask",
			budgetRemaining: null,
		});
	});

	test("resets the level to off when the model changes", async () => {
		mockFetch();
		await renderWithRouter(<NewSessionDialog open onOpenChange={() => {}} />);
		const user = userEvent.setup();
		await screen.findByText("Faux One");
		await user.click(screen.getByLabelText("Thinking level"));
		await user.click(await screen.findByRole("option", { name: "High" }));
		await user.click(screen.getByLabelText("Model"));
		await user.click(await screen.findByRole("option", { name: "Faux Plain" }));
		await waitFor(() => expect(screen.getByLabelText("Thinking level")).toHaveTextContent("Off"));
	});
});
