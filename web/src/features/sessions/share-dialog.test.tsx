import type { SessionShare } from "@crh/api";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ShareDialog } from "./share-dialog";

const SHARE: SessionShare = {
	id: "share-1",
	sessionId: "s1",
	granteeType: "user",
	granteeId: "u2",
	granteeName: "bob",
	access: "view",
	createdByUserId: "u1",
	createdAt: "2026-01-01T00:00:00.000Z",
};

function mockFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/sessions/s1/shares") return json({ shares: [SHARE] });
			if (path === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ShareDialog", () => {
	test("an administrator can list and revoke, but gets no add control", async () => {
		mockFetch();
		renderWithI18n(<ShareDialog sessionId="s1" canCreateShares={false} open onOpenChange={() => {}} />);
		expect(await screen.findByTestId("share-list")).toBeVisible();
		expect(screen.getByRole("button", { name: "Remove share" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "Add share" })).not.toBeInTheDocument();
	});

	test("the owner gets the add control", async () => {
		mockFetch();
		renderWithI18n(<ShareDialog sessionId="s1" canCreateShares open onOpenChange={() => {}} />);
		expect(await screen.findByTestId("share-list")).toBeVisible();
		expect(screen.getByRole("button", { name: "Add share" })).toBeVisible();
	});
});
