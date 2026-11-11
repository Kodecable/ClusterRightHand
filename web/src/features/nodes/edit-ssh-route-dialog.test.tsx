import type { PublicNode, SshNodeDetails, SshTargetInput } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { EditSshRouteDialog } from "./edit-ssh-route-dialog";

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

const DETAILS: SshNodeDetails = {
	hops: [
		{
			host: "jump.example",
			port: 2222,
			user: "jumper",
			hostFingerprint: "SHA256:jump-key",
			credentialId: "cred-1",
			credential: { id: "cred-1", name: "laptop" },
		},
		{
			host: "target.example",
			port: 22,
			user: "deploy",
			hostFingerprint: "SHA256:target-key",
			credentialId: "cred-2",
			credential: { id: "cred-2", name: "desk" },
		},
	],
};

const CREDENTIALS = [
	{ id: "cred-1", name: "laptop" },
	{ id: "cred-2", name: "desk" },
];

/** Answers credentials, the probe (first unpinned hop) and the route PATCH. */
function mockFetch(options: { credentials?: { id: string; name: string }[] } = {}): {
	calls: { body: unknown; method: string; path: string }[];
} {
	const calls: { body: unknown; method: string; path: string }[] = [];
	const credentials = options.credentials ?? CREDENTIALS;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ path, method, body });
			let response: unknown = {};
			if (path === "/api/ssh-credentials" && method === "GET") {
				response = {
					credentials: credentials.map((credential) => ({
						...credential,
						publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
					})),
				};
			} else if (path === "/api/ssh-nodes/probe") {
				const target = body as SshTargetInput;
				const jumps = target.jumps ?? [];
				const jump = jumps.findIndex((hop) => !hop.hostFingerprint);
				response =
					jump >= 0
						? { hop: jump, fingerprint: "SHA256:reprobed-jump" }
						: { hop: jumps.length, fingerprint: "SHA256:reprobed-target" };
			} else if (path === "/api/nodes/node-1/ssh-route" && method === "PATCH") {
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

async function renderDialog() {
	const onClose = vi.fn();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<EditSshRouteDialog node={NODE} details={DETAILS} onClose={onClose} />
		</QueryClientProvider>,
	);
	return { onClose };
}

const fieldValues = (label: RegExp) =>
	screen.getAllByLabelText(label).map((input) => (input as HTMLInputElement).value);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("EditSshRouteDialog", () => {
	test("prefills the stored hops, their pins and each hop's credential", async () => {
		mockFetch();
		await renderDialog();
		await screen.findByRole("combobox", { name: "Credential — Target" });

		expect(fieldValues(/^Host/)).toEqual(["jump.example", "target.example"]);
		expect(fieldValues(/^User/)).toEqual(["jumper", "deploy"]);
		expect(fieldValues(/^Port/)).toEqual(["2222", "22"]);
		expect(screen.getByText("SHA256:jump-key")).toBeInTheDocument();
		expect(screen.getByText("SHA256:target-key")).toBeInTheDocument();
		expect(screen.getByText("Target")).toBeInTheDocument();
		expect(screen.getByText("Jump 1")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("combobox", { name: "Credential — Jump 1" })).toHaveTextContent("laptop"),
		);
		await waitFor(() =>
			expect(screen.getByRole("combobox", { name: "Credential — Target" })).toHaveTextContent("desk"),
		);
		expect(
			screen.getByText("Saving closes the connection; tasks running on this node become unknown."),
		).toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeEnabled();
	});

	test("a user or credential change keeps the pin, while a changed host clears only that row's pin", async () => {
		mockFetch();
		await renderDialog();
		const user = userEvent.setup();
		await screen.findByRole("combobox", { name: "Credential — Target" });

		// Only the user changes: the address is the same, so the pin is kept and saving stays allowed.
		const targetUser = screen.getByLabelText("User — Target");
		await user.clear(targetUser);
		await user.type(targetUser, "other");
		expect(screen.getByText("SHA256:target-key")).toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeEnabled();

		// The credential alone also needs no new confirmation.
		await user.click(screen.getByRole("combobox", { name: "Credential — Target" }));
		await user.click(await screen.findByRole("option", { name: /laptop/ }));
		expect(screen.getByText("SHA256:target-key")).toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeEnabled();

		// A changed host clears the target's pin only; the jump's pin belongs to its own address.
		const targetHost = screen.getByLabelText("Host — Target");
		await user.clear(targetHost);
		await user.type(targetHost, "new.example");
		expect(screen.queryByText("SHA256:target-key")).not.toBeInTheDocument();
		expect(screen.getByText("SHA256:jump-key")).toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeDisabled();

		// Back to the stored address: the pin is not restored automatically, so it must be re-probed.
		await user.clear(targetHost);
		await user.type(targetHost, "target.example");
		expect(screen.queryByText("SHA256:target-key")).not.toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeDisabled();
	});

	test("removing the target makes the previous jump the target and keeps its pin", async () => {
		mockFetch();
		await renderDialog();
		const user = userEvent.setup();
		await screen.findByRole("combobox", { name: "Credential — Target" });

		const removeTarget = screen.getByRole("button", { name: "Remove Target" });
		expect(removeTarget).toBeEnabled();
		await user.click(removeTarget);
		await waitFor(() => expect(fieldValues(/^Host/)).toEqual(["jump.example"]));
		expect(screen.getByRole("combobox", { name: "Credential — Target" })).toHaveTextContent("laptop");
		expect(screen.getByText("SHA256:jump-key")).toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeEnabled();
		// The last row cannot be removed.
		expect(screen.getByRole("button", { name: "Remove Target" })).toBeDisabled();
	});

	test("re-probes a hop, confirms the fingerprint and saves every hop's credential", async () => {
		const { calls } = mockFetch();
		const { onClose } = await renderDialog();
		const user = userEvent.setup();
		await screen.findByRole("combobox", { name: "Credential — Target" });

		await user.click(screen.getByRole("button", { name: "Re-probe — Target" }));
		const dialog = await screen.findByRole("dialog", { name: /Pin the host fingerprint of the Target\?/ });
		expect(within(dialog).getByText("target.example:22")).toBeInTheDocument();
		expect(within(dialog).getByText("SHA256:reprobed-target")).toBeInTheDocument();
		expect(within(dialog).getByText(/for f in \/etc\/ssh\/ssh_host_\*_key\.pub/)).toBeInTheDocument();
		await user.click(within(dialog).getByRole("button", { name: "Matches, pin it" }));

		expect(screen.getByText("SHA256:reprobed-target")).toBeInTheDocument();
		expect(screen.getByTestId("save-ssh-route")).toBeEnabled();
		await user.click(screen.getByTestId("save-ssh-route"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		const patch = calls.find((call) => call.method === "PATCH");
		expect(patch?.path).toBe("/api/nodes/node-1/ssh-route");
		expect(patch?.body).toEqual({
			host: "target.example",
			port: 22,
			user: "deploy",
			hostFingerprint: "SHA256:reprobed-target",
			credentialId: "cred-2",
			jumps: [
				{
					host: "jump.example",
					port: 2222,
					user: "jumper",
					hostFingerprint: "SHA256:jump-key",
					credentialId: "cred-1",
				},
			],
		});
	});

	test("links to the credential page when there are no credentials", async () => {
		mockFetch({ credentials: [] });
		await renderDialog();
		expect(await screen.findByText("No SSH credentials yet.")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Create one on the SSH credentials page." })).toHaveAttribute(
			"href",
			"/ssh-credentials",
		);
	});
});
