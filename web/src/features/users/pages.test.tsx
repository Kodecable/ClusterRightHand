import type { NodeAccessGrant, User, UserGroup } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/features/auth/session";
import { renderWithRouter } from "@/test/render";
import { UserDetailPage, UsersPage } from "./pages";

/** The route params `useParams` returns; the detail page's test sets the user id. */
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useParams: () => route.params };
});

const ME: User = {
	id: "u1",
	username: "ops",
	displayName: "Ada Ops",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const OTHER: User = { ...ME, id: "u2", username: "alice", displayName: "Alice", kind: "member" };

const OPS_GROUP: UserGroup = {
	id: "group-1",
	name: "Ops",
	source: "local",
	createdAt: "2026-01-01T00:00:00.000Z",
	memberIds: [],
};

function grant(overrides: Partial<NodeAccessGrant> = {}): NodeAccessGrant {
	return {
		id: "grant-1",
		granteeType: "user",
		granteeId: OTHER.id,
		granteeName: OTHER.username,
		targetType: "node",
		targetId: "node-1",
		targetName: "worker-01",
		createdAt: "2026-01-01T00:00:00.000Z",
		createdByUserId: ME.id,
		...overrides,
	};
}

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function mockFetch(
	me: User,
	{
		users = [ME, OTHER] as User[],
		groups = [] as UserGroup[],
		grants = [] as NodeAccessGrant[],
		detail = undefined as { user: User; userGroups: { id: string; name: string }[] } | undefined,
		detailStatus = 200,
	} = {},
): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url: `${path}${url.search}`, method, body });
			const json = (payload: unknown, status = 200) =>
				new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
			if (path === "/api/me") return json({ user: me });
			if (path === "/api/users") return json({ users });
			if (/^\/api\/users\/[^/]+$/.test(path)) {
				if (detailStatus !== 200) return json({ error: "no such user" }, detailStatus);
				return json(detail ?? { user: OTHER, userGroups: [] });
			}
			if (path === "/api/user-groups" && method === "GET") return json({ groups });
			if (path === "/api/user-groups" && method === "POST") {
				const created: UserGroup = { ...OPS_GROUP, id: "group-2", name: (body as { name: string }).name };
				return json({ group: created }, 201);
			}
			if (path === "/api/node-access-grants") {
				const granteeType = url.searchParams.get("granteeType");
				const granteeId = url.searchParams.get("granteeId");
				return json({
					grants: grants.filter(
						(grant) =>
							(granteeType === null || grant.granteeType === granteeType) &&
							(granteeId === null || grant.granteeId === granteeId),
					),
				});
			}
			const grantDelete = /^\/api\/node-access-grants\/([^/]+)$/.exec(path);
			if (grantDelete && method === "DELETE") {
				const id = decodeURIComponent(grantDelete[1] as string);
				const index = grants.findIndex((grant) => grant.id === id);
				if (index >= 0) grants.splice(index, 1);
				return json({ ok: true });
			}
			if (path === "/api/sessions") return json({ items: [], nextCursor: null });
			if (path === "/api/tasks") return json({ items: [], nextCursor: null });
			if (path === "/api/nodes") return json({ nodes: [] });
			if (path === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
	return { calls };
}

async function renderPage(
	page: React.ReactElement,
	me: User = ME,
	options?: Parameters<typeof mockFetch>[1],
): Promise<{ calls: Call[] }> {
	const { calls } = mockFetch(me, options);
	await authStore.load();
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
	return { calls };
}

afterEach(() => {
	authStore.clear();
	route.params = {};
	vi.unstubAllGlobals();
});

describe("UsersPage", () => {
	test("rows link to the user page and carry no edit controls", async () => {
		const { calls } = await renderPage(<UsersPage />, ME, { groups: [OPS_GROUP], grants: [] });

		const link = await screen.findByRole("link", { name: "alice" });
		expect(link).toHaveAttribute("href", "/users/u2");
		// The username itself is plain text; the row link is the stretched overlay.
		expect(screen.getByText("alice").closest("a")).toBeNull();
		const row = screen.getByText("alice").closest('[role="row"]');
		if (!(row instanceof HTMLElement)) throw new Error("no user row");
		expect(within(row).getByText("Member")).toBeInTheDocument();
		// Editing moved to the detail page, so the list has neither a kind select nor row actions.
		expect(screen.queryByLabelText("Kind of alice")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
		expect(screen.getByTestId("new-user")).toBeInTheDocument();
		// Node access is on the user page, never as a column with edit controls.
		expect(screen.queryByRole("columnheader", { name: "Node access" })).not.toBeInTheDocument();
		expect(screen.queryByText("No node access")).not.toBeInTheDocument();

		// The group section navigates to the group page; it has no inline member editor.
		const groupLink = await screen.findByRole("link", { name: "Ops" });
		expect(groupLink).toHaveAttribute("href", "/user-groups/group-1");
		expect(screen.getByText("0 members")).toBeInTheDocument();
		expect(screen.queryByLabelText("Add member")).not.toBeInTheDocument();

		await fireEvent.click(screen.getByTestId("create-user-group"));
		const dialog = screen.getByTestId("user-group-name-dialog");
		await fireEvent.change(within(dialog).getByLabelText("User group name"), { target: { value: "db" } });
		await fireEvent.click(within(dialog).getByRole("button", { name: "Create user group" }));
		await waitFor(() =>
			expect(calls.find((call) => call.url === "/api/user-groups" && call.method === "POST")?.body).toEqual({
				name: "db",
			}),
		);
	});

	test("does not render a user's node access in the list", async () => {
		const { calls } = await renderPage(<UsersPage />, ME, { grants: [grant()] });
		await screen.findByText("alice");
		expect(screen.queryByRole("columnheader", { name: "Node access" })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "worker-01" })).not.toBeInTheDocument();
		expect(screen.queryByText("No node access")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.startsWith("/api/node-access-grants"))).toBe(false);
	});
});

describe("UserDetailPage", () => {
	test("an administrator edits the role, status and password on the page", async () => {
		route.params = { userId: OTHER.id };
		const { calls } = await renderPage(<UserDetailPage />, ME, {
			detail: { user: OTHER, userGroups: [{ id: "group-1", name: "Ops" }] },
		});

		expect(await screen.findByRole("heading", { name: "Alice" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "All users" })).toHaveAttribute("href", "/users");
		expect(screen.getByText("alice")).toBeInTheDocument();
		expect(screen.getByText("Member")).toBeInTheDocument();
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Ops" })).toHaveAttribute("href", "/user-groups/group-1");

		// This row is not the administrator's own, so the kind is editable.
		const kind = screen.getByLabelText("Kind of alice");
		expect(kind).toBeEnabled();
		await userEvent.click(kind);
		await userEvent.click(screen.getByRole("option", { name: "Administrator" }));
		await waitFor(() =>
			expect(calls.find((call) => call.url === "/api/users/u2" && call.method === "PATCH")?.body).toEqual({
				kind: "admin",
			}),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		const confirm = screen.getByRole("dialog");
		expect(within(confirm).getByText("Disable alice?")).toBeInTheDocument();
		await fireEvent.click(within(confirm).getByRole("button", { name: "Disable user" }));
		await waitFor(() =>
			expect(calls.filter((call) => call.url === "/api/users/u2" && call.method === "PATCH").at(-1)?.body).toEqual({
				status: "disabled",
			}),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
		expect(screen.getByRole("dialog", { name: /Reset the password of alice/ })).toBeInTheDocument();
	});

	test("an administrator sees only this user's node access and removes a grant", async () => {
		route.params = { userId: OTHER.id };
		const { calls } = await renderPage(<UserDetailPage />, ME, {
			detail: { user: OTHER, userGroups: [] },
			grants: [
				grant(),
				grant({ id: "grant-2", granteeId: "u3", granteeName: "bob", targetId: "node-2", targetName: "worker-02" }),
			],
		});

		const section = await screen.findByTestId("grantee-node-access");
		expect(within(section).getByRole("heading", { name: "Node access" })).toBeInTheDocument();
		expect(await within(section).findByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		// The section shows the grants of this user only, not another grantee's.
		expect(within(section).queryByText("worker-02")).not.toBeInTheDocument();

		await fireEvent.click(within(section).getByRole("button", { name: "Remove access to worker-01 for alice" }));
		const confirm = screen.getByRole("dialog");
		expect(within(confirm).getByText("Remove access for alice?")).toBeInTheDocument();
		await fireEvent.click(within(confirm).getByRole("button", { name: "Remove access" }));
		await waitFor(() =>
			expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/node-access-grants/grant-1")).toBe(
				true,
			),
		);
		expect(await screen.findByText("No node access")).toBeInTheDocument();
	});

	test("your own page is read-only for a non-administrator", async () => {
		route.params = { userId: OTHER.id };
		const { calls } = await renderPage(<UserDetailPage />, OTHER, { detail: { user: OTHER, userGroups: [] } });

		expect(await screen.findByRole("heading", { name: "Alice" })).toBeInTheDocument();
		expect(screen.getByText("Member")).toBeInTheDocument();
		expect(screen.queryByLabelText("Kind of alice")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
		// The grant list is administrator-only, so a member sees no node access section.
		expect(screen.queryByRole("heading", { name: "Node access" })).not.toBeInTheDocument();
		expect(screen.queryByTestId("grantee-node-access")).not.toBeInTheDocument();
		expect(calls.some((call) => call.url.startsWith("/api/node-access-grants"))).toBe(false);
		// Only the recent-activity sections remain.
		expect(screen.getByRole("heading", { name: "Recent sessions" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Recent tasks" })).toBeInTheDocument();
	});

	test("a missing user and a user you may not read show one no-access message", async () => {
		route.params = { userId: "u3" };
		await renderPage(<UserDetailPage />, { ...ME, kind: "member" }, { detailStatus: 404 });
		const alerts = await screen.findAllByRole("alert");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toHaveTextContent("This user doesn't exist or you don't have access.");
	});
});
