import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelProviderView } from "@/lib/api/types";
import { renderWithI18n } from "@/test/render";
import { ProviderDialog } from "./pages";

const EXISTING: ModelProviderView = {
	id: "provider-row-1",
	providerId: "faux",
	kind: "builtin",
	builtin: "faux",
	name: "Faux",
	baseUrl: null,
	hasApiKey: true,
	models: null,
	headers: null,
	enabled: true,
};

function mockFetch(): { calls: { body: unknown; method: string; url: string }[] } {
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
			return new Response(JSON.stringify({ provider: EXISTING }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

function renderDialog() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onSaved = vi.fn();
	const onClose = vi.fn();
	const result = renderWithI18n(
		<QueryClientProvider client={client}>
			<ProviderDialog existing={EXISTING} builtin={["faux"]} onClose={onClose} onSaved={onSaved} />
		</QueryClientProvider>,
	);
	return { ...result, onClose, onSaved };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ProviderDialog", () => {
	test("never prefills the API key and keeps it when the field stays empty", async () => {
		const { calls } = mockFetch();
		const { onSaved, onClose } = renderDialog();
		const key = screen.getByLabelText("API key");
		expect(key).toHaveValue("");
		expect(key).toHaveAttribute("placeholder", "Leave empty to keep the current key");
		// The stored key is not even a DOM value the browser could leak back.
		expect(document.querySelector('input[name="apiKey"]')).toBeNull();

		await userEvent.setup().click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.url).toBe("/api/model-providers/faux");
		expect(save?.body).toEqual({ kind: "builtin", enabled: true });
		expect(save?.body).not.toHaveProperty("apiKey");
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(onClose).toHaveBeenCalled();
	});

	test("removing the stored key sends apiKey null", async () => {
		const { calls } = mockFetch();
		renderDialog();
		const user = userEvent.setup();
		await user.click(screen.getByRole("checkbox", { name: "Remove the stored key" }));
		await user.click(screen.getByRole("button", { name: "Save provider" }));
		await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
		const save = calls.find((call) => call.method === "PUT");
		expect(save?.body).toMatchObject({ apiKey: null });
	});
});
