import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { IssueAuthorizationDialog } from "./issue-dialog";

vi.mock("@simplewebauthn/browser", () => ({
	startAuthentication: vi.fn(async () => ({ id: "credential-1", response: { clientDataJSON: "x" } })),
}));

const NODE = { id: "0192f000-0000-7000-8000-000000000001", name: "worker-01", hostname: "", status: "active" };

const PASSKEY = {
	id: "cred-1",
	kind: "webauthn",
	name: "YubiKey",
	createdAt: "2026-01-01T00:00:00.000Z",
	publicKey: "pk",
	fingerprint: null,
	credentialId: "Y3JlZA",
	rpId: "crh.example.com",
	origins: ["https://crh.example.com"],
};

/** Answers the picker, the credential list, the draft and the submission; records the posted bodies. */
function mockApi() {
	const posted: { path: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (init?.method === "POST") posted.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
			if (url.pathname === "/api/nodes") return json({ nodes: [NODE] });
			if (url.pathname === "/api/node-groups") return json({ groups: [] });
			if (url.pathname === "/api/me/signing-credentials") return json({ signingCredentials: [PASSKEY] });
			if (url.pathname === "/api/authorizations/draft") {
				return json({ draft: { payload: "drafted", id: "d".repeat(64), challenge: "drafted-challenge", decoded: {} } });
			}
			if (url.pathname === "/api/authorizations") return json({ authorization: { id: "d".repeat(64) } });
			return json({});
		}),
	);
	return posted;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("IssueAuthorizationDialog", () => {
	test("signs the drafted payload with a Passkey and closes once it is stored", async () => {
		const posted = mockApi();
		const onOpenChange = vi.fn();
		renderWithI18n(<IssueAuthorizationDialog open onOpenChange={onOpenChange} />);
		const user = userEvent.setup();
		expect(screen.getByText("Choose at least one node or node group to sign.")).toBeInTheDocument();

		await user.click(screen.getByRole("combobox", { name: "Nodes or node groups" }));
		await user.click(await screen.findByRole("option", { name: /worker-01/ }));
		await user.keyboard("{Escape}");
		await user.type(screen.getByLabelText("Target prefix"), "systemctl restart ");
		await user.type(screen.getByLabelText("Note (optional)"), "weekly restart");

		// Escape closed only the picker's popup, not the dialog.
		expect(onOpenChange).not.toHaveBeenCalled();
		await user.click(await screen.findByRole("button", { name: "Sign with Passkey “YubiKey”" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(posted).toEqual([
			{
				path: "/api/authorizations/draft",
				body: {
					nodes: [NODE.id],
					command: { method: "exec", prefix: "systemctl restart " },
					ttlSeconds: 86_400,
					note: "weekly restart",
				},
			},
			{
				path: "/api/authorizations",
				body: { payload: "drafted", webauthn: { id: "credential-1", response: { clientDataJSON: "x" } } },
			},
		]);
		expect(startAuthentication).toHaveBeenCalledWith({
			optionsJSON: expect.objectContaining({ rpId: "crh.example.com", challenge: "drafted-challenge" }),
		});
	});
});
