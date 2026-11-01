import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import type { User } from "@/lib/api/types";
import { renderWithI18n } from "@/test/render";
import { UsersPage } from "./pages";

const ME: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const OTHER: User = { ...ME, id: "u2", username: "alice", displayName: "Alice", kind: "member" };

function mockFetch(users: User[] = [ME, OTHER]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user: ME });
			if (path === "/api/users") return json({ users });
			if (path === "/api/user-groups") return json({ groups: [] });
			return json({});
		}),
	);
}

async function renderPage(): Promise<void> {
	mockFetch();
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	renderWithI18n(
		<QueryClientProvider client={client}>
			<UsersPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("UsersPage self-change guards", () => {
	test("your own row cannot change kind or be disabled", async () => {
		await renderPage();

		expect(await screen.findByLabelText("Kind of ops")).toBeDisabled();
		expect(screen.getByLabelText("Kind of alice")).toBeEnabled();
		// The reason is on the disabled controls, not in a page-wide hint.
		expect(screen.queryByTestId("self-change-hint")).not.toBeInTheDocument();
		expect(screen.getByTitle("You cannot change your own kind.")).toBeInTheDocument();

		const disable = screen.getAllByRole("button", { name: "Disable" });
		expect(disable).toHaveLength(2);
		expect(disable[0]).toBeDisabled();
		expect(disable[0]).toHaveAttribute("title", "You cannot disable your own account.");
		expect(disable[1]).toBeEnabled();
	});
});
