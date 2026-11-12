import type { AuditEvent } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
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
};

function mockAudit(events: AuditEvent[] = [EVENT]): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			let body: unknown = {};
			if (url.startsWith("/api/audit")) {
				const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
				body = cursor === null ? { items: events, nextCursor: "next" } : { items: [], nextCursor: null };
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
		// A user actor and the on-behalf-of user are links to their pages.
		expect(screen.getByRole("link", { name: "Ada Ops" })).toHaveAttribute("href", "/users/user-1");

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

	test("links the on-behalf-of user even when the actor is not a user", async () => {
		mockAudit([{ ...EVENT, actorType: "api_token", actorId: "tok-1", onBehalfOfUserId: "user-1" }]);
		await renderPage();
		await screen.findByText("task.approval");
		expect(screen.getByText("api_token:tok-1")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Ada Ops" })).toHaveAttribute("href", "/users/user-1");
	});

	test("renders a CLI system actor and the key actions", async () => {
		mockAudit([
			{
				...EVENT,
				actorType: "system",
				actorId: "cli",
				action: "keys.exported",
				targetType: null,
				targetId: null,
				detail: { out: "/root/crhs-keys.age" },
			},
		]);
		await renderPage();
		await screen.findByText("keys.exported");
		expect(screen.getByText("system:cli")).toBeInTheDocument();
	});

	test("activating a row opens the event detail dialog", async () => {
		mockAudit();
		await renderPage();
		const row = (await screen.findByText("task.approval")).closest('[role="row"]');
		if (!(row instanceof HTMLElement)) throw new Error("no audit row");
		// The action cell carries the row's real button; clicking elsewhere on the row also activates it.
		expect(within(row).getByRole("button", { name: "Detail of event 42" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
		const user = userEvent.setup();
		await user.click(within(row).getByRole("button", { name: "Detail of event 42" }));
		expect(await screen.findByRole("dialog", { name: "Event 42" })).toBeInTheDocument();
	});

	test("clicking a non-button part of a row opens the event detail dialog too", async () => {
		mockAudit();
		await renderPage();
		const row = (await screen.findByText("task.approval")).closest('[role="row"]');
		if (!(row instanceof HTMLElement)) throw new Error("no audit row");
		fireEvent.click(row);
		expect(await screen.findByRole("dialog", { name: "Event 42" })).toBeInTheDocument();
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
