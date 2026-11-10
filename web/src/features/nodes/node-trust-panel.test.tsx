import type { NodeTrust, TrustSummary } from "@crh/api";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { NodeTrustPanel } from "./node-trust";

function trust(overrides: Partial<NodeTrust> = {}): NodeTrust {
	return {
		status: null,
		message: null,
		digest: null,
		updatedAt: null,
		stale: false,
		summary: null,
		...overrides,
	};
}

function mockTrust(payload: NodeTrust): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/nodes/node-1/trust") return json({ trust: payload });
			if (path === "/api/node-groups") return json({ groups: [] });
			return json({});
		}),
	);
}

function renderPanel(payload: NodeTrust): void {
	mockTrust(payload);
	renderWithI18n(<NodeTrustPanel nodeId="node-1" />);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("NodeTrustPanel report status", () => {
	test("not_forward is labeled Not applicable and explains that there is no trust configuration", async () => {
		renderPanel(trust({ status: "not_forward" }));
		expect(await screen.findByText("Not applicable")).toBeInTheDocument();
		expect(
			screen.getByText("The privileged mode is not forward, so this node uses no trust configuration"),
		).toBeInTheDocument();
		expect(screen.queryByText("The node has not reported its trust configuration")).not.toBeInTheDocument();
	});

	test("unavailable is labeled Unavailable, keeping its message and its own hint", async () => {
		renderPanel(trust({ status: "unavailable", message: "the privileged mode did not answer", digest: "abc" }));
		expect(await screen.findByText("Unavailable")).toBeInTheDocument();
		expect(screen.getByText("the privileged mode did not answer")).toBeInTheDocument();
		expect(
			screen.getByText("The privileged mode is unreachable, so the trust configuration is unknown"),
		).toBeInTheDocument();
		expect(screen.queryByText("The node has not reported its trust configuration")).not.toBeInTheDocument();
	});

	test("an unreported node keeps the not-reported label and hint", async () => {
		renderPanel(trust());
		expect(await screen.findByText("not reported")).toBeInTheDocument();
		expect(screen.getByText("The node has not reported its trust configuration")).toBeInTheDocument();
	});

	test("the clock row names the authorization tolerance, not a measured offset", async () => {
		const summary: TrustSummary = {
			nodeId: "node-1",
			aliases: [],
			clockSkewMs: 60_000,
			identities: {
				unprivileged: { uid: 998, gid: 998, user: "crha" },
				privileged: { uid: 0, gid: 0, user: "root" },
			},
			trust: [],
		};
		renderPanel(trust({ status: "ok", summary }));
		expect(await screen.findByText("Authorization clock tolerance")).toBeInTheDocument();
		expect(screen.queryByText("Clock skew")).not.toBeInTheDocument();
	});
});
