import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("add an OpenAI-compatible model provider", async ({ page }) => {
	const api = await mockApi(page);
	await login(page);
	await page.goto("/settings/models");
	await expect(page.getByTestId("models-page")).toBeVisible();

	await page.getByTestId("add-provider").click();
	const dialog = page.getByTestId("provider-dialog");
	await expect(dialog).toBeVisible();

	await page.getByLabel("Kind").click();
	await page.getByRole("option", { name: "OpenAI-compatible endpoint" }).click();
	await page.getByLabel("Provider id").fill("myllm");
	await page.getByLabel("Name").fill("My LLM");
	await page.getByLabel("Base URL").fill("https://llm.example/v1");
	await page.getByLabel("Model 1 id").fill("model-a");
	await page.getByLabel("API key").fill("sk-secret");
	await page.getByRole("button", { name: "Save provider" }).click();

	await expect(page.getByText("Provider saved.")).toBeVisible();
	await expect(page.getByRole("table", { name: "Model providers" })).toContainText("myllm");
	await expect
		.poll(() => api.state.requests.some((request) => request.url === "/api/model-providers/myllm"))
		.toBe(true);
	const saved = api.state.requests.find(
		(request) => request.method === "PUT" && request.url === "/api/model-providers/myllm",
	);
	expect(saved?.body).toMatchObject({
		kind: "openai-compatible",
		name: "My LLM",
		baseUrl: "https://llm.example/v1",
		apiKey: "sk-secret",
		enabled: true,
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 8192 }],
	});
	expect(api.state.providers[0]).toMatchObject({ providerId: "myllm", hasApiKey: true });

	// Editing again never displays the key back.
	await page.getByRole("button", { name: "Edit myllm" }).click();
	await expect(dialog).toBeVisible();
	await expect(page.getByLabel("API key")).toHaveValue("");
	await expect(page.getByLabel("API key")).toHaveAttribute("placeholder", "Leave empty to keep the current key");
});
