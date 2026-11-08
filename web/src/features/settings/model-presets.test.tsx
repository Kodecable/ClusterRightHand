import type { AvailableModel, ModelPreset } from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ModelPresetsSection } from "./model-presets";

const MODELS: AvailableModel[] = [
	{
		provider: "faux",
		providerName: "faux",
		modelId: "one",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off", "low", "high"],
		thinkingLabels: { off: "Off", low: "Quick", high: "Deep" },
		input: ["text"],
	},
	{
		provider: "faux",
		providerName: "faux",
		modelId: "plain",
		name: "Faux Plain",
		contextWindow: 32_000,
		thinkingLevels: ["off"],
		input: ["text"],
	},
];

const PRESETS: ModelPreset[] = [
	{
		kind: "session",
		model: null,
		systemPrompt: null,
		defaultPrompt: "You are ClusterRightHand, an assistant.",
		protocol: "- Start with list_nodes when you do not know the nodes yet.",
	},
	{
		kind: "review",
		model: { provider: "faux", modelId: "one", thinkingLevel: "low" },
		systemPrompt: "Be careful.",
		defaultPrompt: "You review operations an automated agent wants to run.",
		protocol: "Answer by calling submit_review.",
	},
	{
		kind: "title",
		model: null,
		systemPrompt: null,
		defaultPrompt: "Write a short title for this conversation.",
		protocol: "Reply with the title only, on one line.",
	},
];

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function mockApi(presets: ModelPreset[] = PRESETS): { calls: Call[] } {
	const calls: Call[] = [];
	// A save refreshes the query: keep the server-side values so the cards see their own write.
	const stored = presets.map((preset) => ({ ...preset }));
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			if (url === "/api/models") return json({ models: MODELS });
			if (url === "/api/model-presets") return json({ presets: stored });
			if (url.startsWith("/api/model-presets/") && method === "PUT") {
				const kind = url.slice("/api/model-presets/".length) as ModelPreset["kind"];
				const preset = stored.find((candidate) => candidate.kind === kind);
				Object.assign(preset as ModelPreset, calls.at(-1)?.body as object);
				return json({ preset });
			}
			return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
		}),
	);
	return { calls };
}

async function renderSection() {
	const result = renderWithI18n(<ModelPresetsSection />);
	const session = await screen.findByTestId("model-preset-session");
	const review = screen.getByTestId("model-preset-review");
	const title = screen.getByTestId("model-preset-title");
	return { ...result, session, review, title };
}

async function choose(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, label: string, option: string) {
	await user.click(within(scope).getByLabelText(label));
	await user.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ModelPresetsSection", () => {
	test("loads the three cards and shows the default prompt and protocol", async () => {
		mockApi();
		const user = userEvent.setup();
		const { session, review, title } = await renderSection();

		// The session card has no model select; review and title do.
		expect(within(session).queryByLabelText("Model")).toBeNull();
		expect(within(review).getByLabelText("Model")).toBeVisible();
		expect(within(title).getByLabelText("Model")).toBeVisible();
		expect(within(session).getByLabelText("System prompt")).toHaveValue("");
		expect(within(review).getByLabelText("System prompt")).toHaveValue("Be careful.");

		await user.click(within(review).getByText("Default prompt and protocol"));
		expect(await screen.findByText("You review operations an automated agent wants to run.")).toBeVisible();
		expect(within(review).getByText("Always appended")).toBeVisible();
		expect(within(review).getByText("Answer by calling submit_review.")).toBeVisible();
	});

	test("saves the review card with its thinking level", async () => {
		const { calls } = mockApi();
		const user = userEvent.setup();
		const { review } = await renderSection();

		// The custom model names its own levels.
		await choose(user, review, "Thinking level", "Deep");
		fireEvent.change(within(review).getByLabelText("System prompt"), { target: { value: "Look closely." } });
		await user.click(within(review).getByTestId("save-model-preset-review"));

		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-presets/review");
		expect(save?.body).toEqual({
			model: { provider: "faux", modelId: "one", thinkingLevel: "high" },
			systemPrompt: "Look closely.",
		});
	});

	test("the review card follows the session's model without a thinking level", async () => {
		const { calls } = mockApi();
		const user = userEvent.setup();
		const { review } = await renderSection();

		// Following the session hides the level select: the root session's own level is used.
		await choose(user, review, "Model", "Use the session's model");
		expect(within(review).queryByLabelText("Thinking level")).toBeNull();
		await user.click(within(review).getByTestId("save-model-preset-review"));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.body).toEqual({ model: null, systemPrompt: "Be careful." });

		// A specific model carries its own level in the model ref.
		calls.length = 0;
		await choose(user, review, "Model", "Faux One");
		await choose(user, review, "Thinking level", "Deep");
		await user.click(within(review).getByTestId("save-model-preset-review"));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const chosen = calls.find((call) => call.method === "PUT");
		expect(chosen?.body).toEqual({
			model: { provider: "faux", modelId: "one", thinkingLevel: "high" },
			systemPrompt: "Be careful.",
		});
	});

	test("the model-level selector hides the levels the model list leaves out", async () => {
		mockApi();
		const user = userEvent.setup();
		const { review } = await renderSection();

		await user.click(within(review).getByLabelText("Thinking level"));
		expect(await screen.findByRole("option", { name: "Deep" })).toBeVisible();
		expect(screen.queryByRole("option", { name: "Medium" })).toBeNull();
	});

	test("saves the session card's prompt only, with whitespace meaning the default", async () => {
		const { calls } = mockApi();
		const user = userEvent.setup();
		const { session } = await renderSection();

		fireEvent.change(within(session).getByLabelText("System prompt"), { target: { value: "   " } });
		await user.click(within(session).getByTestId("save-model-preset-session"));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-presets/session");
		expect(save?.body).toEqual({ systemPrompt: null });
		expect(save?.body).not.toHaveProperty("model");
	});

	test("title can use the session's model (null) or a chosen model without a thinking level", async () => {
		const { calls } = mockApi();
		const user = userEvent.setup();
		const { title } = await renderSection();

		// Pick a model, then pick "Use the session's model" again: null is sent explicitly.
		await choose(user, title, "Model", "Faux One");
		await choose(user, title, "Model", "Use the session's model");
		await user.click(within(title).getByTestId("save-model-preset-title"));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		let save = calls.find((call) => call.method === "PUT");
		expect(save?.body).toEqual({ model: null, systemPrompt: null });

		// A chosen title model carries no thinking level: the server fixes the lowest one.
		calls.length = 0;
		await choose(user, title, "Model", "Faux One");
		await user.click(within(title).getByTestId("save-model-preset-title"));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		save = calls.find((call) => call.method === "PUT");
		expect(save?.body).toEqual({ model: { provider: "faux", modelId: "one" }, systemPrompt: null });
	});
});
