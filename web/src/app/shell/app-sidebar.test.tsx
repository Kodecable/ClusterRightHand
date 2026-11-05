import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authStore } from "@/features/auth/session";
import type { User } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { AppSidebar } from "./app-sidebar";

const ADMIN: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

/** The badge's own colour plus the peer variants that outrank SidebarMenuBadge's tint. */
const PRIMARY_FOREGROUND = [
	"text-primary-foreground",
	"peer-hover/menu-button:text-primary-foreground",
	"peer-data-active/menu-button:text-primary-foreground",
] as const;

/** The tints SidebarMenuBadge sets for itself; tailwind-merge must drop them. */
const ACCENT_FOREGROUND = [
	"text-sidebar-foreground",
	"peer-hover/menu-button:text-sidebar-accent-foreground",
	"peer-data-active/menu-button:text-sidebar-accent-foreground",
] as const;

async function renderSidebar(pendingApprovals: number): Promise<void> {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			if (url === "/api/me") return json({ user: ADMIN });
			if (url === "/api/approvals") {
				return json({
					tasks: Array.from({ length: pendingApprovals }, () => ({})),
					taskGroups: [],
					authorizations: { tasks: [], taskGroups: [] },
					quotas: [],
				});
			}
			return json({});
		}),
	);
	await authStore.load();
	await renderWithRouter(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<SidebarProvider>
				<AppSidebar />
			</SidebarProvider>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("AppSidebar approvals badge", () => {
	test("counts the pending approvals", async () => {
		await renderSidebar(3);

		expect(await screen.findByTestId("nav-approvals-badge")).toHaveTextContent("3");
	});

	test("keeps its primary foreground on hover and when the item is active", async () => {
		await renderSidebar(1);
		const badge = await screen.findByTestId("nav-approvals-badge");

		expect(badge).toHaveClass(...PRIMARY_FOREGROUND);
		expect(badge).not.toHaveClass(...ACCENT_FOREGROUND);
	});
});
