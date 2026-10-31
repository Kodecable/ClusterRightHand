import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuditEvent } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { AuditPage } from "./pages";

const EVENT: AuditEvent = {
	seq: 42,
	id: "evt-42",
	ts: "2026-01-01T00:00:00.000Z",
	actorType: "user",
	actorId: "user-1",
	onBehalfOfUserId: null,
	action: "task.approval",
	targetType: "task",
	targetId: "task-1",
	detail: { decision: "approved" },
	hash: "abc",
};

function mockAudit(): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			let body: unknown = {};
			if (url.startsWith("/api/audit/verify")) {
				body = { ok: true, count: 1 };
			} else if (url.startsWith("/api/audit")) {
				const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
				body = cursor === null ? { items: [EVENT], nextCursor: "next" } : { items: [], nextCursor: null };
			} else if (url.startsWith("/api/directory")) {
				body = { users: [{ id: "user-1", username: "ops", displayName: "Ada Ops" }], userGroups: [] };
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { urls };
}

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderWithRouter(
		<QueryClientProvider client={client}>
			<AuditPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("AuditPage filters", () => {
	test("sends the action and target filters, then pages with the returned cursor", async () => {
		const { urls } = mockAudit();
		await renderPage();
		await screen.findByText("task.approval");

		const user = userEvent.setup();
		await user.type(screen.getByLabelText("Action"), "task.");
		await user.type(screen.getByLabelText("Target type"), "task");
		await user.type(screen.getByLabelText("Target id"), "task-1");
		await user.click(screen.getByRole("button", { name: "Filter" }));

		await waitFor(() => {
			const request = urls.find(
				(url) =>
					url.startsWith("/api/audit?") &&
					url.includes("action=task.") &&
					url.includes("targetType=task") &&
					url.includes("targetId=task-1"),
			);
			expect(request).toBeDefined();
		});

		// The action filter is not re-requested while typing; it only changes on Filter.
		await user.click(screen.getByRole("button", { name: "Load more" }));
		await waitFor(() =>
			expect(urls.some((url) => url.startsWith("/api/audit?") && url.includes("cursor=next"))).toBe(true),
		);
	});

	test("an empty result shows the empty state", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				const body = url.startsWith("/api/audit")
					? { items: [], nextCursor: null }
					: url.startsWith("/api/directory")
						? { users: [], userGroups: [] }
						: {};
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		await renderPage();
		await screen.findByText("No events");
	});
});
