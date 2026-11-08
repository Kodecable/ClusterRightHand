import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ChangePasswordDialog } from "./change-password-dialog";

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

function fill(): void {
	fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password" } });
	fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
	fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: "new-password" } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ChangePasswordDialog", () => {
	test("sends revokeApiTokens when the checkbox is ticked", async () => {
		const calls = mockFetch();
		renderWithI18n(<ChangePasswordDialog open onOpenChange={() => {}} />);
		fill();
		const checkbox = screen.getByRole("checkbox", { name: "Also revoke all of my API tokens" });
		expect(checkbox).not.toBeChecked();
		fireEvent.click(checkbox);
		fireEvent.click(screen.getByRole("button", { name: "Save password" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]).toMatchObject({
			url: "/api/auth/password",
			body: { currentPassword: "old-password", newPassword: "new-password", revokeApiTokens: true },
		});
	});

	test("leaves tokens alone by default", async () => {
		const calls = mockFetch();
		renderWithI18n(<ChangePasswordDialog open onOpenChange={() => {}} />);
		fill();
		fireEvent.click(screen.getByRole("button", { name: "Save password" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0]?.body).toMatchObject({ revokeApiTokens: false });
	});
});
