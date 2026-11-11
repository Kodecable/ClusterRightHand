import type { PublicNode, SshTargetInput } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { SshNodeWizard } from "./ssh-wizard";

const NODE: PublicNode = {
	id: "node-1",
	name: "edge",
	transport: "ssh",
	status: "active",
	hostname: "target.example",
	clientVersion: null,
	privilegedMode: null,
	lastSeenAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	approvedAt: null,
	nodeGroups: [],
	access: "admin",
	facts: null,
	keyFingerprint: null,
	connected: null,
	clockWarning: null,
	trustWarnings: [],
};

const CREDENTIAL = {
	id: "cred-1",
	name: "laptop",
	publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
};

function mockFetch(): { calls: { body: unknown; method: string; url: string }[] } {
	const calls: { body: unknown; method: string; url: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url, method: init?.method ?? "GET", body });
			let response: unknown = {};
			if (url.startsWith("/api/ssh-credentials") && (init?.method ?? "GET") === "GET") {
				response = { credentials: [CREDENTIAL] };
			} else if (url.startsWith("/api/ssh-nodes/probe")) {
				const target = body as SshTargetInput;
				const jumps = target.jumps ?? [];
				const hop = jumps.findIndex((candidate) => !candidate.hostFingerprint);
				response = { hop: hop >= 0 ? hop : jumps.length, fingerprint: `SHA256:hop-${hop >= 0 ? hop : jumps.length}` };
			} else if (url.startsWith("/api/ssh-nodes") && (init?.method ?? "GET") === "POST") {
				response = { node: NODE };
			}
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

function renderWizard() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onCreated = vi.fn();
	const onCancel = vi.fn();
	const result = renderWithI18n(
		<QueryClientProvider client={client}>
			<SshNodeWizard onCancel={onCancel} onCreated={onCreated} />
		</QueryClientProvider>,
	);
	return { ...result, onCreated, onCancel };
}

/** Picks the wizard's only credential for the row whose accessible name ends with `hop`. */
async function pickCredential(user: ReturnType<typeof userEvent.setup>, hop: string): Promise<void> {
	await user.click(screen.getByRole("combobox", { name: `Credential — ${hop}` }));
	await user.click(await screen.findByRole("option", { name: /laptop/ }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SshNodeWizard", () => {
	test("validates the route, the credential and every fingerprint before continuing", async () => {
		mockFetch();
		renderWizard();
		const user = userEvent.setup();

		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByText("Target: A host is required.");

		await user.type(screen.getByLabelText("Host — Target"), "target.example");
		await user.type(screen.getByLabelText("User — Target"), "deploy");
		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByText("Target: An SSH credential is required.");

		await pickCredential(user, "Target");
		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByText("Confirm every host fingerprint first.");

		await user.click(screen.getByRole("button", { name: "Probe — Target" }));
		await user.click(await screen.findByRole("button", { name: "Matches, pin it" }));
		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByTestId("ssh-step-create");
	});

	test("adds a hop at the end, pins both fingerprints and posts the parsed route", async () => {
		const { calls } = mockFetch();
		const { onCreated } = renderWizard();
		const user = userEvent.setup();

		// The first row is the target; fill it as a jump host, then append the real target.
		await user.type(screen.getByLabelText("Host — Target"), "jump.example");
		await user.type(screen.getByLabelText("User — Target"), "jump");
		await pickCredential(user, "Target");
		await user.click(screen.getByRole("button", { name: "Probe — Target" }));
		await user.click(await screen.findByRole("button", { name: "Matches, pin it" }));
		expect(screen.getByText("SHA256:hop-0")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Add hop" }));
		expect(screen.getAllByLabelText(/^Host/)).toHaveLength(2);
		expect(screen.getByText("Jump 1")).toBeInTheDocument();
		// The previous target keeps its pin and becomes the jump; the new row is the target.
		expect(screen.getByText("SHA256:hop-0")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Host — Target"), "target.example");
		await user.type(screen.getByLabelText("User — Target"), "deploy");
		await pickCredential(user, "Target");
		await user.click(screen.getByRole("button", { name: "Probe — Target" }));
		await user.click(await screen.findByRole("button", { name: "Matches, pin it" }));
		expect(screen.getByText("SHA256:hop-1")).toBeInTheDocument();

		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByTestId("ssh-step-create");
		expect(screen.getByText(/jump@jump\.example:22/)).toBeInTheDocument();
		expect(screen.getByText(/deploy@target\.example:22/)).toBeInTheDocument();
		await user.click(screen.getByTestId("ssh-create"));

		await waitFor(() => expect(onCreated).toHaveBeenCalledWith(NODE));
		const create = calls.find((call) => call.method === "POST" && call.url === "/api/ssh-nodes");
		expect(create?.body).toEqual({
			host: "target.example",
			port: 22,
			user: "deploy",
			hostFingerprint: "SHA256:hop-1",
			credentialId: "cred-1",
			name: "",
			jumps: [
				{
					host: "jump.example",
					port: 22,
					user: "jump",
					hostFingerprint: "SHA256:hop-0",
					credentialId: "cred-1",
				},
			],
		});
	});
});
