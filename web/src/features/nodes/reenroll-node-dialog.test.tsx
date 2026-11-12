import type { PublicNode } from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
	test("explains what is kept and creates a token with the command, address and token", async () => {
		const { calls } = mockFetch();
		renderWithI18n(<ReenrollNodeDialog node={node()} onClose={() => {}} />);

		expect(screen.getByText(/The node keeps its id, name, node groups and access grants\./)).toBeInTheDocument();
		expect(screen.getByText(/must be approved again before it runs tasks\./)).toBeInTheDocument();
		expect(screen.queryByText(/crha enroll/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByText("sudo crha enroll")).toBeInTheDocument();
		expect(screen.getByText(/crha enroll will ask to re-enroll/)).toBeInTheDocument();
		const address = within(screen.getByRole("group", { name: "crhs address" }));
		expect(address.getByText(window.location.origin)).toBeInTheDocument();
		expect(address.getByRole("button", { name: "Copy crhs address" })).toBeInTheDocument();
		const token = within(screen.getByRole("group", { name: "Enrollment token" }));
		expect(token.getByText(CREATED.token)).toBeInTheDocument();
		expect(token.getByRole("button", { name: "Copy enrollment token" })).toBeInTheDocument();
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
		expect(screen.queryByText("sudo crha enroll")).not.toBeInTheDocument();
	});
});
