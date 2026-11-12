import type { PublicNode } from "@crh/api";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { ReenrollNodeDialog } from "./reenroll-node-dialog";

function node(overrides: Partial<PublicNode> = {}): PublicNode {
	return {
		id: "node-1",
		name: "worker-01",
		transport: "client",
		status: "active",
		hostname: "worker-01.local",
		clientVersion: "1",
		privilegedMode: null,
		lastSeenAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: null,
		nodeGroups: [],
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
		...overrides,
	};
}

const CREATED = { token: "crh1.fp-test.secret", expiresAt: "2026-12-01T00:00:00.000Z" };

function mockFetch(created = CREATED): { calls: { path: string; method: string; body: unknown }[] } {
	const calls: { path: string; method: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://localhost").pathname;
			calls.push({ path, method: init?.method ?? "GET", body: init?.body });
			return new Response(JSON.stringify(created), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ReenrollNodeDialog", () => {
	test("explains what is kept and creates a token with a copyable --replace command", async () => {
		const { calls } = mockFetch();
		renderWithI18n(<ReenrollNodeDialog node={node()} onClose={() => {}} />);

		expect(screen.getByText(/The node keeps its id, name, node groups and access grants\./)).toBeInTheDocument();
		expect(screen.getByText(/must be approved again before it runs tasks\./)).toBeInTheDocument();
		expect(screen.queryByText(/crha enroll/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		const command = await screen.findByText(/crha enroll --replace/);
		expect(command.textContent).toContain("--config /etc/crha/crha.toml");
		expect(command.textContent).toContain(`'${CREATED.token}'`);
		expect(screen.getByText(CREATED.token)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy token" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Copy and close" })).toBeInTheDocument();
		expect(screen.getByText(/Pending approval/)).toBeInTheDocument();
		await waitFor(() =>
			expect(calls).toContainEqual(
				expect.objectContaining({
					path: "/api/nodes/node-1/reenroll",
					method: "POST",
				}),
			),
		);
	});

	test("shows the server's refusal without a command", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "SSH nodes cannot be re-enrolled" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		renderWithI18n(<ReenrollNodeDialog node={node()} onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByText("SSH nodes cannot be re-enrolled")).toBeInTheDocument();
		expect(screen.queryByText(/crha enroll --replace/)).not.toBeInTheDocument();
	});
});
