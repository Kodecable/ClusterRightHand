import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("add a custom model provider", async ({ page }) => {
	const api = await mockApi(page);
	await login(page);
	await page.goto("/settings/models");
	await expect(page.getByTestId("models-page")).toBeVisible();

	await page.getByTestId("add-provider").click();
	const dialog = page.getByTestId("provider-dialog");
	await expect(dialog).toBeVisible();

	await page.getByLabel("Kind").click();
	await page.getByRole("option", { name: "Custom" }).click();
	await page.getByLabel("Provider id").fill("myllm");
	await page.getByLabel("Name").fill("My LLM");
	await page.getByLabel("Base URL").fill("https://llm.example/v1");
	await page.getByLabel("API key").fill("sk-secret");
	await dialog.getByRole("button", { name: "New model" }).click();
	const model = page.getByTestId("model-dialog");
	await model.getByLabel("Model id").fill("model-a");
	await model.getByRole("button", { name: "Save model" }).click();
	await expect(page.getByTestId("model-dialog")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Save provider" }).click();

	await expect(page.getByRole("table", { name: "Model providers" })).toContainText("myllm");
	await expect
		.poll(() => api.state.requests.some((request) => request.url === "/api/model-providers/myllm"))
		.toBe(true);
	const saved = api.state.requests.find(
		(request) => request.method === "PUT" && request.url === "/api/model-providers/myllm",
	);
	expect(saved?.body).toMatchObject({
		kind: "custom",
		name: "My LLM",
		baseUrl: "https://llm.example/v1",
		apiKey: "sk-secret",
		enabled: true,
		models: [
			{
				id: "model-a",
				api: "openai-completions",
				contextWindow: 128000,
				maxTokens: 8192,
				input: ["text"],
			},
		],
	});
	expect(api.state.providers[0]).toMatchObject({ providerId: "myllm", hasApiKey: true });

	// Editing again never displays the key back.
	await page.getByRole("button", { name: "Edit myllm" }).click();
	await expect(dialog).toBeVisible();
	await expect(page.getByLabel("API key")).toHaveValue("");
	await expect(page.getByLabel("API key")).toHaveAttribute("placeholder", "Leave empty to keep the current key");
});

test("list a custom provider's models and add the selected ones", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			providers: [
				{
					id: "provider-1",
					providerId: "myllm",
					kind: "custom",
					builtin: null,
					name: "My LLM",
					baseUrl: "https://llm.example/v1",
					hasApiKey: true,
					models: [
						{
							id: "model-a",
							api: "openai-completions",
							contextWindow: 128_000,
							maxTokens: 8_192,
							input: ["text"],
						},
					],
					headers: null,
					sessionId: null,
					enabled: true,
				},
			],
			discoveredModels: { myllm: ["model-a", "model-b", "model-c"] },
		},
	});
	await login(page);
	await page.goto("/settings/models");
	await page.getByRole("button", { name: "Edit myllm" }).click();
	const dialog = page.getByTestId("provider-dialog");
	await dialog.getByRole("button", { name: "List provider models" }).click();

	const discovery = page.getByTestId("model-discovery-dialog");
	await expect(discovery).toBeVisible();
	// The configured model is not offered, and the dialog lists ids only.
	await expect(discovery.getByText("model-a")).toHaveCount(0);
	await expect(discovery.getByText("model-b")).toBeVisible();
	await expect(discovery.getByRole("table")).toHaveCount(0);

	await discovery.getByLabel("Search models").fill("model-c");
	await expect(discovery.getByText("model-b")).toHaveCount(0);
	await discovery.getByRole("checkbox", { name: "Select all visible" }).click();
	await discovery.getByRole("button", { name: "Add models" }).click();

	await expect(discovery).toHaveCount(0);
	await expect(dialog.getByRole("table", { name: "Models" })).toContainText("model-c");
	const added = api.state.requests.find(
		(request) => request.method === "POST" && request.url === "/api/model-providers/myllm/discover",
	);
	expect(added?.body).toEqual({ ids: ["model-c"] });
	expect(api.state.providers[0]?.models?.some((model) => model.id === "model-c")).toBe(true);
});
