import type { User } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import { useUpdateUser } from "./api";

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

function mockFetch(): { method: string; url: string }[] {
	const calls: { method: string; url: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://localhost").pathname;
			calls.push({ method: init?.method ?? "GET", url: path });
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user: ME });
			if (path === `/api/users/${ME.id}`) return json({ user: { ...ME, displayName: "Ada Renamed" } });
			if (path === `/api/users/${OTHER.id}`) return json({ user: { ...OTHER, kind: "admin" } });
			return json({});
		}),
	);
	return calls;
}

function Harness({ id }: { id: string }) {
	const update = useUpdateUser();
	return (
		<button type="button" onClick={() => update.mutate({ id, patch: { displayName: "Ada Renamed" } })}>
			Update
		</button>
	);
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("useUpdateUser", () => {
	test("an update of the signed-in user refreshes the boot-time copy", async () => {
		mockFetch();
		await authStore.load();
		expect(authStore.state.user?.displayName).toBe("Ada Ops");

		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<Harness id={ME.id} />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));

		await waitFor(() => expect(authStore.state.user?.displayName).toBe("Ada Renamed"));
	});

	test("an update of another user leaves the signed-in user alone", async () => {
		const calls = mockFetch();
		await authStore.load();

		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<Harness id={OTHER.id} />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));

		await waitFor(() =>
			expect(calls.some((call) => call.method === "PATCH" && call.url === `/api/users/${OTHER.id}`)).toBe(true),
		);
		expect(authStore.state.user?.displayName).toBe("Ada Ops");
	});
});
