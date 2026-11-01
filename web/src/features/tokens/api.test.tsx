import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approvalKeys } from "@/features/approvals/api";
import { taskKeys } from "@/features/tasks/api";
import type { ApiTokenView, ApprovalList } from "@/lib/api/types";
import { tokenKeys, useRevokeApiToken, useSetTokenRules } from "./api";

const APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
};

const TOKEN: ApiTokenView = {
	id: "token-1",
	name: "laptop",
	userId: "u1",
	createdAt: "2026-01-01T00:00:00.000Z",
	expiresAt: null,
	revokedAt: null,
	lastUsedAt: null,
	rules: null,
};

function mockFetch(): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			calls.push(new URL(String(input), "http://localhost").pathname);
			return new Response(JSON.stringify({ apiToken: TOKEN }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

function seededClient(): QueryClient {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	client.setQueryData(tokenKeys.list(), [TOKEN]);
	client.setQueryData(approvalKeys.list(), APPROVALS);
	client.setQueryData(taskKeys.detail("task-1"), { id: "task-1" });
	return client;
}

function RevokeTokenHarness() {
	const revoke = useRevokeApiToken();
	return (
		<button type="button" onClick={() => revoke.mutate("token-1")}>
			Revoke
		</button>
	);
}

function SaveRulesHarness() {
	const save = useSetTokenRules();
	return (
		<button type="button" onClick={() => save.mutate({ id: "token-1", body: { preset: "yolo" } })}>
			Save
		</button>
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("token mutations", () => {
	test("revoking a token refreshes the approvals and tasks it rejected", async () => {
		const calls = mockFetch();
		const client = seededClient();

		render(
			<QueryClientProvider client={client}>
				<RevokeTokenHarness />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

		await waitFor(() => expect(calls).toContain("/api/api-tokens/token-1/revoke"));
		await waitFor(() => {
			expect(client.getQueryState(tokenKeys.list())?.isInvalidated).toBe(true);
			// The server rejects what the token had waiting for approval.
			expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);
			expect(client.getQueryState(taskKeys.detail("task-1"))?.isInvalidated).toBe(true);
		});
	});

	test("changing a token's rules refreshes the tasks the server re-evaluated", async () => {
		const calls = mockFetch();
		const client = seededClient();

		render(
			<QueryClientProvider client={client}>
				<SaveRulesHarness />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(calls).toContain("/api/api-tokens/token-1/rules"));
		await waitFor(() => {
			expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);
			expect(client.getQueryState(taskKeys.detail("task-1"))?.isInvalidated).toBe(true);
		});
	});
});
