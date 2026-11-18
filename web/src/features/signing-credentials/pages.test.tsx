import type { SigningCredentialView } from "@crh/api";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { base64urlToBase64 } from "@/lib/authorization";
import { renderWithI18n } from "@/test/render";
import { SigningCredentialsPage } from "./pages";

/** The unpadded base64url challenge the API returns; `-_` becomes `+/` in the manual recipe. */
const CHALLENGE = "AQID-_8";

interface MockApi {
	calls: { body: unknown; method: string; url: string }[];
	credentials: SigningCredentialView[];
}

function mockApi(credentials: SigningCredentialView[] = [], options: { registerStatus?: number } = {}): MockApi {
	const state: MockApi = { calls: [], credentials };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
			state.calls.push({ body, method, url });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (url === "/api/me/signing-credentials" && method === "GET") {
				return json({ signingCredentials: state.credentials });
			}
			if (url === "/api/me/signing-credentials/ssh/challenge" && method === "POST") {
				return json({ challenge: CHALLENGE, expiresAt: "2026-01-01T00:10:00.000Z" });
			}
			if (url === "/api/me/signing-credentials/ssh" && method === "POST") {
				if (options.registerStatus !== undefined) {
					return json({ error: "the registration signature does not verify" }, options.registerStatus);
				}
				const input = body as { signature: string; name?: string };
				const credential: SigningCredentialView = {
					id: "signing-credential-1",
					kind: "ssh",
					name: input.name ?? "ssh key",
					createdAt: "2026-01-01T00:00:00.000Z",
					publicKey: "ssh-ed25519 AAAAlaptop laptop",
					fingerprint: "SHA256:user",
					credentialId: null,
					rpId: null,
					origins: [],
				};
				state.credentials.push(credential);
				return json({ signingCredential: credential }, 201);
			}
			return json({});
		}),
	);
	return state;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SigningCredentialsPage SSH registration", () => {
	test("requests a challenge and shows crhu register plus a correctly decoded ssh-keygen recipe", async () => {
		const api = mockApi();
		const user = userEvent.setup();
		renderWithI18n(<SigningCredentialsPage />);
		await screen.findByText("No signing credentials yet");

		await user.click(screen.getByRole("button", { name: "Request challenge" }));
		expect(await screen.findByText(`crhu register ${CHALLENGE}`)).toBeInTheDocument();
		expect(screen.getByText(/Run this on your workstation and paste the output below:/)).toBeInTheDocument();
		// The manual recipe decodes the base64url challenge, not the base64 text, before signing it.
		const recipe = screen.getByText(/ssh-keygen -Y sign -n crh-register-v1/);
		expect(recipe).toHaveTextContent(`printf %s '${base64urlToBase64(CHALLENGE)}' | base64 -d > crh-register.bin`);
		expect(base64urlToBase64(CHALLENGE)).toBe("AQID+/8=");

		const challengeCall = api.calls.find((call) => call.url.endsWith("/ssh/challenge"));
		expect(challengeCall).toMatchObject({ method: "POST", url: "/api/me/signing-credentials/ssh/challenge" });
	});

	test("submits the pasted signature and name, then clears the registration form", async () => {
		const api = mockApi();
		const user = userEvent.setup();
		renderWithI18n(<SigningCredentialsPage />);
		await screen.findByText("No signing credentials yet");
		await user.click(screen.getByRole("button", { name: "Request challenge" }));

		await screen.findByLabelText("Signature");
		await user.type(screen.getByLabelText("Name", { selector: "#ssh-signing-name" }), "laptop");
		const signature = "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----";
		await user.type(screen.getByLabelText("Signature"), signature);
		await user.click(screen.getByRole("button", { name: "Register SSH key" }));

		await waitFor(() => expect(api.calls.some((call) => call.url === "/api/me/signing-credentials/ssh")).toBe(true));
		const submit = api.calls.find((call) => call.url === "/api/me/signing-credentials/ssh");
		expect(submit).toEqual({
			body: { signature, name: "laptop" },
			method: "POST",
			url: "/api/me/signing-credentials/ssh",
		});
		// The single-use challenge is spent, so the form is gone and a new challenge can be requested.
		await waitFor(() => expect(screen.queryByLabelText("Signature")).not.toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Request challenge" })).toBeInTheDocument();
	});

	test("a failed registration shows the server's reason and asks for a new challenge", async () => {
		mockApi([], { registerStatus: 400 });
		const user = userEvent.setup();
		renderWithI18n(<SigningCredentialsPage />);
		await screen.findByText("No signing credentials yet");
		await user.click(screen.getByRole("button", { name: "Request challenge" }));
		await screen.findByLabelText("Signature");
		await user.type(
			screen.getByLabelText("Signature"),
			"-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----",
		);
		await user.click(screen.getByRole("button", { name: "Register SSH key" }));

		expect(await screen.findByText("the registration signature does not verify")).toBeInTheDocument();
		// The server consumes the challenge on every attempt, so the form returns to requesting one.
		await waitFor(() => expect(screen.queryByLabelText("Signature")).not.toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Request challenge" })).toBeInTheDocument();
	});
});
