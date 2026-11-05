import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PublicNode } from "@/lib/api/types";
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

function mockFetch(): { calls: { body: unknown; method: string; url: string }[] } {
	const calls: { body: unknown; method: string; url: string }[] = [];
	let probes = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url, method: init?.method ?? "GET", body });
			let response: unknown = {};
			if (url.startsWith("/api/ssh-credentials") && (init?.method ?? "GET") === "GET") {
				response = { credentials: [{ id: "cred-1", name: "laptop", publicKey: "ssh-ed25519 AAAA" }] };
			} else if (url.startsWith("/api/ssh-nodes/probe")) {
				response = { hop: probes, fingerprint: `SHA256:hop-${probes++}` };
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SshNodeWizard", () => {
	test("validates each step before continuing", async () => {
		mockFetch();
		renderWizard();
		const user = userEvent.setup();

		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByText("Choose or create a credential.");

		const credential = await screen.findByLabelText("SSH credential");
		await user.click(credential);
		await user.click(await screen.findByRole("option", { name: "laptop" }));
		await user.click(screen.getByTestId("ssh-next"));

		// The route step starts with only the target and empty fields.
		await screen.findByTestId("ssh-step-route");
		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByText("Target: A host is required.");

		const [host] = screen.getAllByLabelText("Host");
		if (host === undefined) throw new Error("no host field");
		await user.type(host, "target.example");
		const [userField] = screen.getAllByLabelText("User");
		if (userField === undefined) throw new Error("no user field");
		await user.type(userField, "deploy");
		const [port] = screen.getAllByLabelText("Port");
		if (port === undefined) throw new Error("no port field");
		await user.clear(port);
		await user.type(port, "0");
		await user.click(screen.getByTestId("ssh-next"));
		await screen.findByText("Target: The port must be between 1 and 65535.");
	});

	test("walks the steps, pins both host keys and posts the parsed route", async () => {
		const { calls } = mockFetch();
		const { onCreated } = renderWizard();
		const user = userEvent.setup();

		const credential = await screen.findByLabelText("SSH credential");
		await user.click(credential);
		await user.click(await screen.findByRole("option", { name: "laptop" }));
		await user.click(screen.getByTestId("ssh-next"));

		await screen.findByTestId("ssh-step-route");
		// The target first, then insert a jump host before it.
		const [targetHost] = screen.getAllByLabelText("Host");
		if (targetHost === undefined) throw new Error("no host field");
		await user.type(targetHost, "target.example");
		const [targetUser] = screen.getAllByLabelText("User");
		if (targetUser === undefined) throw new Error("no user field");
		await user.type(targetUser, "deploy");
		await user.click(screen.getByRole("button", { name: "Add jump host" }));

		const hosts = screen.getAllByLabelText("Host");
		const jumpHost = hosts[0];
		const finalHost = hosts[1];
		if (jumpHost === undefined || finalHost === undefined) throw new Error("missing hop fields");
		await user.type(jumpHost, "jump.example");
		const users = screen.getAllByLabelText("User");
		const jumpUser = users[0];
		if (jumpUser === undefined) throw new Error("missing jump user");
		// The new jump host inherits the target's user; replace it.
		await user.clear(jumpUser);
		await user.type(jumpUser, "jump");
		await user.click(screen.getByTestId("ssh-next"));

		await screen.findByTestId("ssh-step-host-keys");
		await user.click(screen.getByRole("button", { name: "Check the next host key" }));
		await user.click(await screen.findByRole("button", { name: "It matches, pin it" }));
		await user.click(screen.getByRole("button", { name: "Check the next host key" }));
		await user.click(await screen.findByRole("button", { name: "It matches, pin it" }));
		await screen.findByText("All host keys are confirmed.");
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
			hostKey: "SHA256:hop-1",
			jumps: [{ host: "jump.example", port: 22, user: "jump", hostKey: "SHA256:hop-0" }],
			credentialId: "cred-1",
			name: "",
		});
	});
});
