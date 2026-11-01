import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approvalKeys } from "@/features/approvals/api";
import { taskKeys } from "@/features/tasks/api";
import type { ApprovalList } from "@/lib/api/types";
import { authorizationKeys, useSubmitAuthorization } from "./api";

const APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
};

function mockFetch(): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			calls.push(new URL(String(input), "http://localhost").pathname);
			return new Response(JSON.stringify({ authorization: { id: "auth-1", dispatched: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

function Harness() {
	const submit = useSubmitAuthorization();
	return (
		<button type="button" onClick={() => submit.mutate({ authorization: "crh_grant_1" })}>
			Sign
		</button>
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useSubmitAuthorization", () => {
	test("refreshes the approvals, the tasks and the authorizations list", async () => {
		const calls = mockFetch();
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(authorizationKeys.listPage({}), {
			pages: [{ items: [], nextCursor: null }],
			pageParams: [null],
		});
		client.setQueryData(approvalKeys.list(), APPROVALS);
		client.setQueryData(taskKeys.detail("auth-task"), { id: "auth-task" });

		render(
			<QueryClientProvider client={client}>
				<Harness />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Sign" }));

		await waitFor(() => expect(calls).toContain("/api/authorizations"));
		await waitFor(() => {
			expect(client.getQueryState(authorizationKeys.listPage({}))?.isInvalidated).toBe(true);
			// The sidebar badge and the Approvals page read this list.
			expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);
			// The signed task leaves its waiting state.
			expect(client.getQueryState(taskKeys.detail("auth-task"))?.isInvalidated).toBe(true);
		});
	});
});
