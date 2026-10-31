import { startAuthentication } from "@simplewebauthn/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { SubmitAuthorizationInput } from "@/features/authorizations/api";
import type { PendingAuthorization } from "@/lib/api/types";
import { renderWithI18n } from "@/test/render";
import { AuthorizationCard } from "./authorization-card";

vi.mock("@simplewebauthn/browser", () => ({
	startAuthentication: vi.fn(async () => ({ id: "credential-1", response: { clientDataJSON: "x" } })),
}));

const pending = (overrides: Partial<PendingAuthorization> = {}): PendingAuthorization => ({
	id: "a".repeat(64),
	payload: "o2dub2RlcwFhZ3JvdXA6d2Vi",
	challenge: "challenge-b64url",
	deadline: "2026-10-31T12:00:00.000Z",
	taskIds: ["task-1"],
	attempt: 2,
	passkeys: [],
	localRequested: false,
	lastRejection: null,
	tried: ["crhs"],
	decoded: {
		nodes: ["node-1"],
		command: {
			method: "exec",
			match: "exact",
			target: "systemctl restart nginx",
			specSha256: "b".repeat(64),
		},
		issuedAt: "2026-10-30T12:00:00.000Z",
		deadline: "2026-10-31T12:00:00.000Z",
		taskIds: ["task-1"],
		attempt: 2,
		note: "",
	},
	...overrides,
});

describe("AuthorizationCard", () => {
	test("shows the decoded payload and the exact crha grant command", () => {
		const { container } = renderWithI18n(<AuthorizationCard pending={pending()} onSubmit={async () => {}} />);
		expect(screen.getByText(/systemctl restart nginx/)).toBeInTheDocument();
		expect(container.textContent).toContain("crha grant --payload o2dub2RlcwFhZ3JvdXA6d2Vi --key ~/.ssh/id_ed25519");
		expect(container.textContent).toContain("ssh-keygen -Y sign -n crh-auth-v1");
		expect(screen.getByRole("button", { name: "Copy crha grant command" })).toBeInTheDocument();
		expect(screen.getByText("Already tried: crhs.")).toBeInTheDocument();
	});

	test("submits the pasted authorization", async () => {
		const onSubmit = vi.fn(async (_input: SubmitAuthorizationInput) => {});
		renderWithI18n(<AuthorizationCard pending={pending()} onSubmit={onSubmit} />);
		const paste = screen.getByLabelText("Authorization from `crha grant`");
		fireEvent.change(paste, { target: { value: "  signed-payload  " } });
		fireEvent.click(screen.getByRole("button", { name: "Submit authorization" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ authorization: "signed-payload" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Authorization submitted.");
	});

	test("signs with a trusted Passkey", async () => {
		const onSubmit = vi.fn(async (_input: SubmitAuthorizationInput) => {});
		renderWithI18n(
			<AuthorizationCard
				pending={pending({
					passkeys: [
						{
							credentialId: "Y3JlZA",
							name: "YubiKey",
							rpId: "crh.example.com",
							origins: ["https://crh.example.com"],
							requireUv: true,
							entry: "yubikey",
						},
					],
				})}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Sign with Passkey “YubiKey”" }));
		await waitFor(() => expect(startAuthentication).toHaveBeenCalled());
		expect(startAuthentication).toHaveBeenCalledWith({
			optionsJSON: expect.objectContaining({
				rpId: "crh.example.com",
				challenge: "challenge-b64url",
				userVerification: "required",
			}),
		});
		await waitFor(() =>
			expect(onSubmit).toHaveBeenCalledWith({
				payloadId: "a".repeat(64),
				webauthn: { id: "credential-1", response: { clientDataJSON: "x" } },
			}),
		);
	});

	test("a task group shows its pending tasks", () => {
		renderWithI18n(
			<AuthorizationCard
				kind="group"
				pending={pending()}
				tasks={[
					{
						id: "task-1",
						nodeId: "node-1",
						nodeName: "worker-01",
						attempt: 2,
						state: "awaiting_authorization",
						localRequested: false,
						lastRejection: null,
						tried: ["crhs"],
					},
				]}
				onSubmit={async () => {}}
			/>,
		);
		expect(screen.getByText("worker-01")).toBeInTheDocument();
		expect(screen.getByText(`${"task-1".slice(0, 8)}…`)).toBeInTheDocument();
	});

	test("the local crha approve alternative is shown when requested", () => {
		const { container } = renderWithI18n(
			<AuthorizationCard pending={pending({ localRequested: true })} onSubmit={async () => {}} />,
		);
		expect(container.textContent).toContain("crha approve task-1");
	});
});
