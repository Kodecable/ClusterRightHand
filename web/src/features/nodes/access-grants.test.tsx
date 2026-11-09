import type { NodeAccessGrant, User, UserGroup } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import { renderWithI18n } from "@/test/render";
import { NodeAccessSection } from "./access-grants";

const ADMIN: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const ALICE: User = {
	id: "u2",
	username: "alice",
	displayName: "Alice",
	email: null,
	kind: "member",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const OPS: UserGroup = {
	id: "group-1",
	name: "Ops",
	source: "local",
	createdAt: "2026-01-01T00:00:00.000Z",
	memberIds: [],
};

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function mockFetch(user: User): { calls: Call[]; grants: NodeAccessGrant[] } {
	const calls: Call[] = [];
	const grants: NodeAccessGrant[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const parsed = new URL(String(input), "http://localhost");
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url: `${parsed.pathname}${parsed.search}`, method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (parsed.pathname === "/api/me") return json({ user });
			if (parsed.pathname === "/api/users") return json({ users: [ADMIN, ALICE] });
			if (parsed.pathname === "/api/user-groups") return json({ groups: [OPS] });
			if (parsed.pathname === "/api/node-access-grants" && method === "GET") return json({ grants });
			if (parsed.pathname === "/api/node-access-grants" && method === "POST") {
				const input = body as Pick<NodeAccessGrant, "granteeType" | "granteeId" | "targetType" | "targetId">;
				const grant: NodeAccessGrant = {
					id: `grant-${grants.length + 1}`,
					...input,
					granteeName: input.granteeType === "user" ? ALICE.username : OPS.name,
					targetName: "worker-01",
					createdAt: "2026-01-01T00:00:00.000Z",
					createdByUserId: ADMIN.id,
				};
				grants.push(grant);
				return json({ grant }, 201);
			}
			const one = /^\/api\/node-access-grants\/([^/]+)$/.exec(parsed.pathname);
			if (one && method === "DELETE") {
				const id = decodeURIComponent(one[1] as string);
				const index = grants.findIndex((grant) => grant.id === id);
				if (index >= 0) grants.splice(index, 1);
				return json({ ok: true });
			}
			return json({});
		}),
	);
	return { calls, grants };
}

async function renderSection(user: User): Promise<{ calls: Call[]; grants: NodeAccessGrant[] }> {
	const mocked = mockFetch(user);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	renderWithI18n(
		<QueryClientProvider client={client}>
			<NodeAccessSection targetType="node" targetId="node-1" targetName="worker-01" />
		</QueryClientProvider>,
	);
	return mocked;
}

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("NodeAccessSection", () => {
	test("an administrator adds and removes a grant", async () => {
		const { calls, grants } = await renderSection(ADMIN);
		await screen.findByTestId("node-access");
		await screen.findByText("No access grants yet");

		const user = userEvent.setup();
		await user.click(screen.getByTestId("add-access"));
		const dialog = await screen.findByTestId("add-access-dialog");
		await user.click(within(dialog).getByLabelText("User"));
		await user.click(await screen.findByRole("option", { name: "alice" }));
		await user.click(within(dialog).getByRole("button", { name: "Add access" }));

		await waitFor(() =>
			expect(calls.find((call) => call.method === "POST")?.body).toEqual({
				granteeType: "user",
				granteeId: ALICE.id,
				targetType: "node",
				targetId: "node-1",
			}),
		);
		await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
		expect(grants).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: "Remove access for alice" }));
		const confirm = await screen.findByRole("dialog");
		await user.click(within(confirm).getByRole("button", { name: "Remove access" }));

		await waitFor(() =>
			expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/node-access-grants/grant-1")).toBe(
				true,
			),
		);
		await waitFor(() => expect(screen.getByText("No access grants yet")).toBeInTheDocument());
	});

	test("a member does not see the section", async () => {
		const { calls } = await renderSection({ ...ADMIN, kind: "member" });
		expect(screen.queryByTestId("node-access")).not.toBeInTheDocument();
		expect(screen.queryByText("No access grants yet")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.startsWith("/api/node-access-grants"))).toBe(false);
	});
});
