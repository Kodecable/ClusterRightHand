import type { ApiTokenView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { CreateTokenDialog } from "./create-token-dialog";
import { TokensPage } from "./pages";

const TOKEN = "crh_secret_once";
const API_TOKEN: ApiTokenView = {
	id: "token-1",
	name: "laptop",
	userId: "user-1",
	createdAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2026-04-01T00:00:00.000Z",
	revokedAt: null,
	lastUsedAt: null,
	rules: null,
	refs: {},
};

function mockFetch(): { calls: { body: unknown; method: string; url: string }[] } {
	const calls: { body: unknown; method: string; url: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			return new Response(JSON.stringify({ token: TOKEN, apiToken: API_TOKEN }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

function renderDialog(onCreated = vi.fn()) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onClose = vi.fn();
	const result = renderWithI18n(
		<QueryClientProvider client={client}>
			<CreateTokenDialog onClose={onClose} onCreated={onCreated} />
		</QueryClientProvider>,
	);
	return { ...result, onClose, onCreated };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CreateTokenDialog", () => {
	test("shows the secret once and supports copying it", async () => {
		const { calls } = mockFetch();
		const { onClose, onCreated, unmount } = renderDialog();
		const user = userEvent.setup();

		await user.type(screen.getByLabelText("Name"), "laptop");
		await user.click(screen.getByRole("button", { name: "Create token" }));

		await screen.findByText("Copy this token now. It will not be shown again.");
		expect(screen.getByText(TOKEN)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy token" })).toBeInTheDocument();
		expect(screen.getByText(/claude mcp add --transport http crh/)).toBeInTheDocument();

		const created = calls.find((call) => call.method === "POST" && call.url === "/api/api-tokens");
		expect(created?.body).toEqual({ name: "laptop", rulePreset: "ask", days: 90 });
		expect(onCreated).toHaveBeenCalledTimes(1);
		// Closing and reopening cannot recover the secret: it lives only in the
		// dialog's state, and the server never returns it again.
		onClose();
		unmount();
		renderDialog();
		expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Create token" })).toBeInTheDocument());
	});

	test("offers only Ask and Yolo, and warns for Yolo", async () => {
		mockFetch();
		renderDialog();
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Rule preset"));
		expect(screen.queryByRole("option", { name: "Auto Review" })).not.toBeInTheDocument();
		await user.click(await screen.findByRole("option", { name: "Yolo" }));
		await screen.findByText("Yolo lets this token run anything on your nodes without asking.");
	});
});

describe("TokensPage", () => {
	test("a token without an expiry reads Never, as plain text", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ tokens: [{ ...API_TOKEN, expiresAt: null }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderWithI18n(
			<QueryClientProvider client={client}>
				<TokensPage />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("Never")).toBeInTheDocument();
		expect(screen.queryByText("never")).not.toBeInTheDocument();
	});

	test("shows a token's rule preset by its product name", async () => {
		const token: ApiTokenView = {
			...API_TOKEN,
			rules: {
				scope: { type: "api_token", id: API_TOKEN.id },
				rulePreset: "yolo",
				rules: [],
				default: "require-approval",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ tokens: [token] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderWithI18n(
			<QueryClientProvider client={client}>
				<TokensPage />
			</QueryClientProvider>,
		);

		expect(await screen.findByText("Yolo")).toBeInTheDocument();
		expect(screen.queryByText("yolo")).not.toBeInTheDocument();
	});
});
