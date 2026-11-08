import type { User } from "@crh/api";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ResetPasswordDialog } from "./reset-password-dialog";

const ALICE: User = {
	id: "u2",
	username: "alice",
	displayName: "Alice",
	email: null,
	kind: "member",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

function mockFetch(): { body: unknown; url: string }[] {
	const calls: { body: unknown; url: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: new URL(String(input), "http://localhost").pathname,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ResetPasswordDialog", () => {
	test("sends revokeApiTokens for the target user when ticked", async () => {
		const calls = mockFetch();
		renderWithI18n(<ResetPasswordDialog user={ALICE} onClose={() => {}} />);
		fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
		const checkbox = screen.getByRole("checkbox", { name: "Also revoke all of this user's API tokens" });
		expect(checkbox).not.toBeChecked();
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByRole("button", { name: "Set password" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toMatchObject({
			url: "/api/users/u2/password",
			body: { password: "new-password", revokeApiTokens: true },
		});
	});

	test("leaves the user's tokens alone by default", async () => {
		const calls = mockFetch();
		renderWithI18n(<ResetPasswordDialog user={ALICE} onClose={() => {}} />);
		fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
		fireEvent.click(screen.getByRole("button", { name: "Set password" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]?.body).toMatchObject({ revokeApiTokens: false });
	});
});
