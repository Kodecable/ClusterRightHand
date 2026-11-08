import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelProviderView } from "@/lib/api/types";
import { renderWithI18n } from "@/test/render";
import { ModelSettingsPage } from "./pages";
import { ProviderDialog } from "./provider-dialog";

const BUILTIN: ModelProviderView = {
	id: "provider-row-1",
	providerId: "faux",
	kind: "builtin",
	builtin: "faux",
	name: "Faux",
	baseUrl: null,
	hasApiKey: true,
	models: null,
	headers: null,
	sessionId: null,
	enabled: true,
};

const CUSTOM: ModelProviderView = {
	id: "provider-row-2",
	providerId: "myllm",
	kind: "custom",
	builtin: null,
	name: "My LLM",
	baseUrl: "https://llm.example/v1",
	hasApiKey: true,
	headers: { "x-gateway": "edge" },
	sessionId: { headers: ["x-opencode-session"], body: ["metadata.session_id"] },
	models: [
		{
			id: "resp-model",
			name: "Responder",
			api: "openai-responses",
			contextWindow: 200_000,
			maxTokens: 16_000,
			input: ["text", "image"],
			thinking: { mode: "custom", levels: { high: { reasoning: { effort: "high" } } } },
		},
		{
			id: "chat-model",
			api: "openai-completions",
			contextWindow: 128_000,
			maxTokens: 8_192,
			input: ["text"],
			thinking: {
				mode: "standard",
				format: "deepseek",
				levels: { low: "low", xhigh: null },
				labels: { low: "Fast" },
			},
			compat: { maxTokensField: "max_completion_tokens" },
		},
	],
	enabled: true,
};

function mockFetch(response?: { body: unknown; status: number }): {
	calls: { body: unknown; method: string; url: string }[];
} {
	const calls: { body: unknown; method: string; url: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			return new Response(JSON.stringify(response?.body ?? { provider: BUILTIN }), {
				status: response?.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

function renderProvider(existing?: ModelProviderView) {
	const onSaved = vi.fn();
	const onClose = vi.fn();
	const result = renderWithI18n(
		<ProviderDialog existing={existing} builtin={["faux", "deepseek"]} onClose={onClose} onSaved={onSaved} />,
	);
	return { ...result, onClose, onSaved };
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string, scope?: HTMLElement) {
	const query = scope === undefined ? screen : within(scope);
	await user.click(query.getByLabelText(label));
	await user.click(await screen.findByRole("option", { name: option }));
}

async function fill(_user: ReturnType<typeof userEvent.setup>, element: HTMLElement, text: string) {
	// fireEvent keeps the long provider/model forms fast; the userEvent clicks
	// still exercise focus and the selects.
	fireEvent.change(element, { target: { value: text } });
}

function change(element: HTMLElement, text: string) {
	fireEvent.change(element, { target: { value: text } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ModelSettingsPage", () => {
	test("puts the presets section first, then the providers, under the Models page title", async () => {
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/model-providers") return json({ providers: [BUILTIN], builtin: ["faux"] });
				if (url === "/api/models") return json({ models: [] });
				if (url === "/api/model-presets") return json({ presets: [] });
				return json({});
			}),
		);
		renderWithI18n(<ModelSettingsPage />);
		expect(await screen.findByRole("heading", { name: "Models" })).toBeVisible();
		const presets = await screen.findByRole("heading", { name: "Model presets" });
		const providers = await screen.findByRole("heading", { name: "Model providers" });
		expect(presets.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const section = screen.getByTestId("model-providers");
		expect(within(section).getByTestId("add-provider")).toBeVisible();
	});
});

describe("ProviderDialog", () => {
	test("never prefills the API key and keeps it when the field stays empty", async () => {
		const { calls } = mockFetch();
		const { onSaved, onClose } = renderProvider(BUILTIN);
		const key = screen.getByLabelText("API key");
		expect(key).toHaveValue("");
		expect(key).toHaveAttribute("placeholder", "Leave empty to keep the current key");

		await userEvent.setup().click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-providers/faux");
		expect(save?.body).toEqual({ kind: "builtin", baseUrl: null, enabled: true });
		expect(save?.body).not.toHaveProperty("apiKey");
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(onClose).toHaveBeenCalled();
	});

	test("removing the stored key sends apiKey null", async () => {
		const { calls } = mockFetch();
		renderProvider(BUILTIN);
		const user = userEvent.setup();
		await user.click(screen.getByRole("checkbox", { name: "Remove the stored key" }));
		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.body).toMatchObject({ apiKey: null });
	});

	test("creates a Pi built-in provider with a key and without OAuth", async () => {
		const { calls } = mockFetch();
		renderProvider();
		const user = userEvent.setup();
		expect(screen.getByLabelText("Kind")).toHaveTextContent("Pi built-in");
		expect(screen.getByLabelText("Provider")).toHaveTextContent("faux");
		expect(screen.queryByRole("table", { name: "Models" })).not.toBeInTheDocument();

		await fill(user, screen.getByLabelText("Base URL"), "https://pi.example");
		await fill(user, screen.getByLabelText("API key"), "sk-pi");
		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-providers/faux");
		expect(save?.body).toEqual({ kind: "builtin", baseUrl: "https://pi.example", enabled: true, apiKey: "sk-pi" });
	});

	test("creates a custom provider with custom and standard thinking models", async () => {
		const { calls } = mockFetch();
		renderProvider();
		const user = userEvent.setup();

		await choose(user, "Kind", "Custom");
		await fill(user, screen.getByLabelText("Provider id"), "myllm");
		await fill(user, screen.getByLabelText("Name"), "My LLM");
		await fill(user, screen.getByLabelText("Base URL"), "https://llm.example/v1");
		await fill(user, screen.getByLabelText("API key"), "sk-secret");

		const extra = screen.getByRole("group", { name: "Extra headers" });
		await user.click(within(extra).getByRole("button", { name: "Add header" }));
		await fill(user, within(extra).getByLabelText("Header 1 name"), "x-gateway");
		await fill(user, within(extra).getByLabelText("Header 1 value"), "edge");

		const session = screen.getByRole("group", { name: "Session id fields" });
		expect(within(session).getByText("Headers")).toBeVisible();
		expect(within(session).getByText("Body fields")).toBeVisible();
		await user.click(within(session).getByRole("button", { name: "Add header" }));
		await fill(user, within(session).getByLabelText("Session id header 1"), "x-opencode-session");
		await user.click(within(session).getByRole("button", { name: "Add field" }));
		await fill(user, within(session).getByLabelText("Session id body field 1"), "metadata.session_id");

		await user.click(screen.getByRole("button", { name: "Add model" }));
		let dialog = await screen.findByRole("dialog", { name: "Add model" });
		// Base UI marks a dialog opened inside another one as nested (it must not close the parent).
		expect(dialog).toHaveAttribute("data-nested");
		// ...and marks the parent popup; the nested dialog brings its own blurred backdrop.
		expect(screen.getByTestId("provider-dialog")).toHaveAttribute("data-nested-dialog-open");
		expect(screen.getByTestId("provider-dialog")).toBeInTheDocument();
		await fill(user, within(dialog).getByLabelText("Model id"), "resp-model");
		await fill(user, within(dialog).getByLabelText("Display name"), "Responder");
		await choose(user, "Protocol", "Responses", dialog);
		await fill(user, within(dialog).getByLabelText("Context window"), "200000");
		await fill(user, within(dialog).getByLabelText("Max output tokens"), "16000");
		await user.click(within(dialog).getByRole("checkbox", { name: "Image understanding" }));
		await choose(user, "Thinking", "Custom", dialog);
		const highDisplayName = within(dialog).getByLabelText("high display name");
		expect(highDisplayName).toHaveValue("high");
		expect(highDisplayName).toHaveAttribute("placeholder", "high");
		change(within(dialog).getByLabelText("high request body JSON"), '{"reasoning":{"effort":"high"}}');
		change(highDisplayName, "Deep");
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add model" })).not.toBeInTheDocument());

		await user.click(screen.getByRole("button", { name: "Add model" }));
		dialog = await screen.findByRole("dialog", { name: "Add model" });
		await fill(user, within(dialog).getByLabelText("Model id"), "chat-model");
		await choose(user, "Thinking", "Standard", dialog);
		expect(within(dialog).getByLabelText("Thinking format")).toHaveTextContent("Auto (omit)");
		await choose(user, "Thinking format", "deepseek", dialog);
		// The level column is gone: the display name input defaults to the level id and
		// keeps it as its placeholder once cleared (which is what hides the level).
		expect(within(dialog).queryByRole("columnheader", { name: "Level" })).not.toBeInTheDocument();
		expect(within(dialog).getByRole("columnheader", { name: "Display name" })).toBeInTheDocument();
		const standardHigh = within(dialog).getByLabelText("high display name");
		expect(standardHigh).toHaveValue("high");
		expect(standardHigh).toHaveAttribute("placeholder", "high");
		await choose(user, "low mapping", "Mapped value", dialog);
		await fill(user, within(dialog).getByLabelText("low value"), "low");
		change(within(dialog).getByLabelText("low display name"), "Fast");
		const mediumDisplayName = within(dialog).getByLabelText("medium display name");
		change(mediumDisplayName, "");
		expect(mediumDisplayName).toHaveValue("");
		expect(mediumDisplayName).toHaveAttribute("placeholder", "medium");
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add model" })).not.toBeInTheDocument());

		const table = screen.getByRole("table", { name: "Models" });
		expect(table).toHaveTextContent("resp-model");
		expect(table).toHaveTextContent("Responses");
		expect(table).toHaveTextContent("Custom");
		expect(table).toHaveTextContent("chat-model");
		expect(table).toHaveTextContent("Standard");
		expect(table).toHaveTextContent("deepseek");

		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-providers/myllm");
		expect(save?.body).toEqual({
			kind: "custom",
			name: "My LLM",
			baseUrl: "https://llm.example/v1",
			apiKey: "sk-secret",
			enabled: true,
			headers: { "x-gateway": "edge" },
			sessionId: { headers: ["x-opencode-session"], body: ["metadata.session_id"] },
			models: [
				{
					id: "resp-model",
					name: "Responder",
					api: "openai-responses",
					contextWindow: 200_000,
					maxTokens: 16_000,
					input: ["text", "image"],
					thinking: {
						mode: "custom",
						levels: { high: { reasoning: { effort: "high" } } },
						labels: { high: "Deep" },
					},
				},
				{
					id: "chat-model",
					api: "openai-completions",
					contextWindow: 128_000,
					maxTokens: 8_192,
					input: ["text"],
					thinking: {
						mode: "standard",
						format: "deepseek",
						levels: { low: "low" },
						labels: { low: "Fast", medium: "" },
					},
				},
			],
		});
	}, 15_000);

	test("edits an existing custom provider and saves every stored value back", async () => {
		const { calls } = mockFetch();
		renderProvider(CUSTOM);
		const user = userEvent.setup();

		expect(screen.getByLabelText("Kind")).toHaveTextContent("Custom");
		expect(screen.getByLabelText("Provider id")).toHaveValue("myllm");
		expect(screen.getByLabelText("Provider id")).toBeDisabled();
		expect(screen.getByLabelText("Name")).toHaveValue("My LLM");
		expect(screen.getByLabelText("Base URL")).toHaveValue("https://llm.example/v1");
		expect(screen.getByLabelText("API key")).toHaveValue("");
		expect(screen.getByLabelText("Header 1 name")).toHaveValue("x-gateway");
		expect(screen.getByLabelText("Header 1 value")).toHaveValue("edge");
		expect(screen.getByLabelText("Session id header 1")).toHaveValue("x-opencode-session");
		expect(screen.getByLabelText("Session id body field 1")).toHaveValue("metadata.session_id");

		const table = screen.getByRole("table", { name: "Models" });
		expect(table).toHaveTextContent("resp-model");
		expect(table).toHaveTextContent("Responses");
		expect(table).toHaveTextContent("200000");
		expect(table).toHaveTextContent("16000");
		expect(table).toHaveTextContent("Yes");
		expect(table).toHaveTextContent("Custom");
		expect(table).toHaveTextContent("chat-model");
		expect(table).toHaveTextContent("deepseek");
		expect(table).toHaveTextContent("No");

		await user.click(screen.getByRole("button", { name: "Edit model 1" }));
		let dialog = await screen.findByRole("dialog", { name: "Edit model resp-model" });
		expect(within(dialog).getByLabelText("Model id")).toHaveValue("resp-model");
		expect(within(dialog).getByLabelText("Display name")).toHaveValue("Responder");
		expect(within(dialog).getByLabelText("Protocol")).toHaveTextContent("Responses");
		expect(within(dialog).getByLabelText("Context window")).toHaveValue("200000");
		expect(within(dialog).getByLabelText("Max output tokens")).toHaveValue("16000");
		expect(within(dialog).getByRole("checkbox", { name: "Image understanding" })).toBeChecked();
		expect(within(dialog).getByLabelText("Thinking")).toHaveTextContent("Custom");
		expect(within(dialog).getByLabelText("high request body JSON")).toHaveValue(
			'{\n  "reasoning": {\n    "effort": "high"\n  }\n}',
		);
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Edit model resp-model" })).not.toBeInTheDocument(),
		);

		await user.click(screen.getByRole("button", { name: "Edit model 2" }));
		dialog = await screen.findByRole("dialog", { name: "Edit model chat-model" });
		expect(within(dialog).getByLabelText("Protocol")).toHaveTextContent("Chat Completions");
		expect(within(dialog).getByLabelText("Thinking")).toHaveTextContent("Standard");
		expect(within(dialog).getByLabelText("Thinking format")).toHaveTextContent("deepseek");
		expect(within(dialog).getByLabelText("low mapping")).toHaveTextContent("Mapped value");
		expect(within(dialog).getByLabelText("low display name")).toHaveValue("Fast");
		expect(within(dialog).getByLabelText("low value")).toHaveValue("low");
		expect(within(dialog).getByLabelText("medium mapping")).toHaveTextContent("Default (omitted)");
		expect(within(dialog).getByLabelText("medium display name")).toHaveValue("medium");
		expect(within(dialog).getByLabelText("xhigh display name")).toHaveValue("");
		await user.click(within(dialog).getByRole("button", { name: "Compat (JSON, advanced)" }));
		expect(within(dialog).getByLabelText("Compat JSON")).toHaveValue(
			'{\n  "maxTokensField": "max_completion_tokens"\n}',
		);
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Edit model chat-model" })).not.toBeInTheDocument(),
		);

		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-providers/myllm");
		expect(save?.body).toEqual({
			kind: "custom",
			name: "My LLM",
			baseUrl: "https://llm.example/v1",
			enabled: true,
			headers: { "x-gateway": "edge" },
			sessionId: { headers: ["x-opencode-session"], body: ["metadata.session_id"] },
			models: [
				{
					id: "resp-model",
					name: "Responder",
					api: "openai-responses",
					contextWindow: 200_000,
					maxTokens: 16_000,
					input: ["text", "image"],
					thinking: { mode: "custom", levels: { high: { reasoning: { effort: "high" } } } },
				},
				{
					id: "chat-model",
					api: "openai-completions",
					contextWindow: 128_000,
					maxTokens: 8_192,
					input: ["text"],
					thinking: {
						mode: "standard",
						format: "deepseek",
						levels: { low: "low" },
						labels: { low: "Fast" },
					},
					compat: { maxTokensField: "max_completion_tokens" },
				},
			],
		});
		expect(save?.body).not.toHaveProperty("apiKey");
	});

	test("shows the level id through the display name field and scrolls only the dialog body", async () => {
		mockFetch();
		renderProvider(CUSTOM);
		const user = userEvent.setup();

		// Custom mode: there is no separate level column or label. The display name input
		// defaults to the level id and keeps it as the placeholder when cleared (hidden).
		await user.click(screen.getByRole("button", { name: "Edit model 1" }));
		const customDialog = await screen.findByRole("dialog", { name: "Edit model resp-model" });
		expect(within(customDialog).queryByText("Level")).not.toBeInTheDocument();
		const highDisplayName = within(customDialog).getByLabelText("high display name");
		expect(highDisplayName).toHaveValue("high");
		expect(highDisplayName).toHaveAttribute("placeholder", "high");
		change(highDisplayName, "");
		expect(highDisplayName).toHaveValue("");
		expect(highDisplayName).toHaveAttribute("placeholder", "high");

		// The header and footer stay outside the scrolling body, inside the clipped rounded frame.
		const body = customDialog.querySelector('[data-slot="dialog-scroll-area"]');
		expect(body).not.toBeNull();
		expect(body?.contains(highDisplayName)).toBe(true);
		expect(body?.contains(within(customDialog).getByRole("button", { name: "Save model" }))).toBe(false);
		expect(body?.querySelector('[data-slot="dialog-header"]')).toBeNull();
		expect(body?.querySelector('[data-slot="dialog-footer"]')).toBeNull();

		await user.click(within(customDialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "Edit model resp-model" })).not.toBeInTheDocument(),
		);

		// Standard mode: the mapping table has no level column either.
		await user.click(screen.getByRole("button", { name: "Edit model 2" }));
		const standardDialog = await screen.findByRole("dialog", { name: "Edit model chat-model" });
		expect(within(standardDialog).queryByRole("columnheader", { name: "Level" })).not.toBeInTheDocument();
		expect(within(standardDialog).getByRole("columnheader", { name: "Display name" })).toBeInTheDocument();
		expect(within(standardDialog).getByLabelText("high display name")).toHaveValue("high");
		expect(within(standardDialog).getByLabelText("high display name")).toHaveAttribute("placeholder", "high");
	});

	test("validates request body and compat JSON before closing the model dialog", async () => {
		const { calls } = mockFetch();
		renderProvider();
		const user = userEvent.setup();

		await choose(user, "Kind", "Custom");
		await user.click(screen.getByRole("button", { name: "Add model" }));
		let dialog = await screen.findByRole("dialog", { name: "Add model" });
		await fill(user, within(dialog).getByLabelText("Model id"), "m1");
		await choose(user, "Thinking", "Custom", dialog);
		const high = within(dialog).getByLabelText("high request body JSON");
		change(high, "{");
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		expect(await within(dialog).findByText("Request body overrides must be valid JSON.")).toBeInTheDocument();

		change(high, "[]");
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		expect(await within(dialog).findByText("Request body overrides must be a JSON object.")).toBeInTheDocument();

		change(high, '{"reasoning":{"effort":"high"}}');
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add model" })).not.toBeInTheDocument());

		await user.click(screen.getByRole("button", { name: "Edit model 1" }));
		dialog = await screen.findByRole("dialog", { name: "Edit model m1" });
		await user.click(within(dialog).getByRole("button", { name: "Compat (JSON, advanced)" }));
		const compat = within(dialog).getByLabelText("Compat JSON");
		change(compat, "{");
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		expect(await within(dialog).findByText("Compat must be valid JSON.")).toBeInTheDocument();

		change(compat, "[]");
		await user.click(within(dialog).getByRole("button", { name: "Save model" }));
		expect(await within(dialog).findByText("Compat must be a JSON object.")).toBeInTheDocument();
		expect(calls.some((call) => call.method === "PUT")).toBe(false);
	});

	test("asks for a new key when an existing custom provider's base URL changes", async () => {
		const { calls } = mockFetch();
		renderProvider(CUSTOM);
		const user = userEvent.setup();
		// Headers are not secrets and are shown in plaintext; the dialog says so beside the editor.
		expect(screen.getByText(/Headers are stored and shown in plaintext/)).toBeVisible();

		change(screen.getByLabelText("Base URL"), "https://other.example/v1");
		expect(screen.getByText("Changing the base URL requires re-entering the API key.")).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() =>
			expect(screen.getAllByText("Changing the base URL requires re-entering the API key.")).toHaveLength(2),
		);
		expect(calls.some((call) => call.method === "PUT")).toBe(false);

		await fill(user, screen.getByLabelText("API key"), "sk-new-endpoint");
		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.body).toMatchObject({
			kind: "custom",
			baseUrl: "https://other.example/v1",
			apiKey: "sk-new-endpoint",
		});
	});

	test("shows the server's 400 field-path error inside the provider dialog", async () => {
		// The server validates what only it can (compat against pi-ai's schema, header names,
		// session id paths); its message names the field and must reach the user unchanged.
		const message = "models[1].compat.maxTokensField: Expected string";
		const { calls } = mockFetch({ status: 400, body: { error: message } });
		renderProvider(CUSTOM);

		await userEvent.setup().click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));

		const dialog = screen.getByTestId("provider-dialog");
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
		expect(dialog).toBeInTheDocument();
	});
});
