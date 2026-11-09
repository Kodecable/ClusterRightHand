import type {
	DirectoryResponse,
	NodeGroupListResponse,
	NodeListResponse,
	UserGroupListResponse,
	UserListResponse,
} from "@crh/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeAccessGrant } from "../src/cluster/node-access.ts";
import { createNodeGroup, queryNodeGroups, setNodeGroupMembers } from "../src/cluster/node-groups.ts";
import { listNodesForUser } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { createUserGroup } from "../src/users/user-groups.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const PASSWORD = "password-123";

/** A path with URL-encoded query parameters. */
function withQuery(path: string, query: Record<string, string>): string {
	const search = new URLSearchParams(query);
	return `${path}?${search.toString()}`;
}

describeBackends("entity list search", (backend) => {
	let db: Db;
	let app: App;
	let adminCookie: string;
	let memberCookie: string;
	const ids: Record<string, string> = {};
	let orgId: string;

	const addNode = async (name: string, hostname: string): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: orgId,
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status: "active",
				public_key: null,
				hostname,
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		return id;
	};

	const get = (path: string, cookie = adminCookie) => call(app, path, { cookie });

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = makeApp(db);
		orgId = await defaultOrgId(db);
		const admin = await createUser(db, { username: "root", kind: "admin", password: PASSWORD });
		ids.root = admin.id;
		const users: { username: string; displayName: string }[] = [
			{ username: "alice", displayName: "Alice Smith" },
			{ username: "bob", displayName: "Bob Jones" },
			{ username: "ann", displayName: "Ann" },
			{ username: "anna", displayName: "Anna" },
			{ username: "joann", displayName: "Joann" },
			{ username: "under_score", displayName: "Under Score" },
			{ username: "percent", displayName: "100% Real" },
			{ username: "backslash", displayName: "back\\slash" },
			{ username: "gone", displayName: "Gone User" },
		];
		for (const user of users) {
			ids[user.username] = (await createUser(db, { ...user, kind: "member", password: PASSWORD })).id;
		}
		await db
			.updateTable("users")
			.set({ status: "disabled" })
			.where("id", "=", ids.gone as string)
			.execute();
		adminCookie = await login(app, "root", PASSWORD);
		memberCookie = await login(app, "alice", PASSWORD);

		const groups = ["alpha-team", "team_ops", "zeta"];
		for (const name of groups) ids[`group:${name}`] = (await createUserGroup(db, name)).id;

		ids.nodeWeb = await addNode("web-01", "web-01.local");
		ids.nodeWorker = await addNode("worker-01", "worker-01.local");
		ids.nodeData = await addNode("database_01", "db.local");
		ids.nodeHidden = await addNode("web-hidden", "web-hidden.local");
		ids.nodeGroupWeb = (await createNodeGroup(db, orgId, "web")).id;
		ids.nodeGroupData = (await createNodeGroup(db, orgId, "data_group")).id;
		ids.nodeGroupOps = (await createNodeGroup(db, orgId, "ops")).id;
		await setNodeGroupMembers(db, ids.nodeGroupWeb as string, [ids.nodeWeb as string, ids.nodeHidden as string]);
		await setNodeGroupMembers(db, ids.nodeGroupData as string, [ids.nodeData as string]);
		await createNodeAccessGrant(db, {
			orgId,
			granteeType: "user",
			granteeId: ids.alice as string,
			targetType: "node",
			targetId: ids.nodeWeb as string,
			createdByUserId: ids.root as string,
		});
	});
	afterAll(async () => {
		await db.destroy();
	});

	describe("users", () => {
		it("returns the unchanged list without search parameters", async () => {
			const res = await get("/api/users");
			expect(res.status).toBe(200);
			const body = (await res.json()) as UserListResponse;
			expect(body.users.map((user) => user.username)).toEqual([
				"alice",
				"ann",
				"anna",
				"backslash",
				"bob",
				"gone",
				"joann",
				"percent",
				"root",
				"under_score",
			]);
			expect(body).not.toHaveProperty("more");
		});

		it("matches username or display name case-insensitively", async () => {
			const response = (await (await get(withQuery("/api/users", { q: "ALI" }))).json()) as UserListResponse;
			expect(response.users.map((user) => user.username)).toEqual(["alice"]);
			expect(response).not.toHaveProperty("more");

			const byDisplay = (await (await get(withQuery("/api/users", { q: "sMiTh" }))).json()) as UserListResponse;
			expect(byDisplay.users.map((user) => user.username)).toEqual(["alice"]);
		});

		it("orders prefix matches before substring matches, then by username", async () => {
			const response = (await (await get(withQuery("/api/users", { q: "ann" }))).json()) as UserListResponse;
			expect(response.users.map((user) => user.username)).toEqual(["ann", "anna", "joann"]);
		});

		it("escapes LIKE metacharacters in the query", async () => {
			const percent = (await (await get(withQuery("/api/users", { q: "%" }))).json()) as UserListResponse;
			expect(percent.users.map((user) => user.username)).toEqual(["percent"]);
			const underscore = (await (await get(withQuery("/api/users", { q: "_" }))).json()) as UserListResponse;
			expect(underscore.users.map((user) => user.username)).toEqual(["under_score"]);
			const backslash = (await (await get(withQuery("/api/users", { q: "\\" }))).json()) as UserListResponse;
			expect(backslash.users.map((user) => user.username)).toEqual(["backslash"]);
		});

		it("limits the list and reports whether more matched", async () => {
			const limitedRes = await get(withQuery("/api/users", { q: "ann", limit: "2" }));
			expect(limitedRes.status).toBe(200);
			const limited = (await limitedRes.json()) as UserListResponse;
			expect(limited.users.map((user) => user.username)).toEqual(["ann", "anna"]);
			expect(limited.more).toBe(true);

			const all = (await (await get(withQuery("/api/users", { q: "ann", limit: "3" }))).json()) as UserListResponse;
			expect(all.users.map((user) => user.username)).toEqual(["ann", "anna", "joann"]);
			expect(all.more).toBe(false);
		});

		it("looks up exact ids and omits unknown or hidden ones", async () => {
			const res = await get(withQuery("/api/users", { ids: `${ids.bob},${ids.alice},does-not-exist` }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as UserListResponse;
			expect(body.users.map((user) => user.username)).toEqual(["alice", "bob"]);
			expect(body).not.toHaveProperty("more");
		});

		it("rejects bad limit and ids values", async () => {
			const badLimits: Record<string, string>[] = [{ limit: "0" }, { limit: "101" }, { limit: "abc" }, { limit: "" }];
			for (const query of badLimits) {
				expect((await get(withQuery("/api/users", query))).status).toBe(400);
			}
			const badIds: Record<string, string>[] = [
				{ ids: "" },
				{ ids: "a,,b" },
				{ ids: `${ids.alice},${ids.bob}`, q: "a" },
				{ ids: `${ids.alice},${ids.bob}`, limit: "1" },
			];
			for (const query of badIds) {
				expect((await get(withQuery("/api/users", query))).status).toBe(400);
			}
			const tooMany = Array.from({ length: 101 }, (_, index) => `id-${index}`).join(",");
			expect((await get(withQuery("/api/users", { ids: tooMany }))).status).toBe(400);
		});
	});

	describe("user groups", () => {
		const groups = async (query: Record<string, string> = {}) => {
			const res = await get(withQuery("/api/user-groups", query));
			expect(res.status).toBe(200);
			return (await res.json()) as UserGroupListResponse;
		};

		it("returns the unchanged list without search parameters", async () => {
			const body = await groups();
			expect(body.groups.map((group) => group.name)).toEqual(["alpha-team", "team_ops", "zeta"]);
			expect(body).not.toHaveProperty("more");
		});

		it("searches by name with prefix-first ordering", async () => {
			expect((await groups({ q: "TEAM" })).groups.map((group) => group.name)).toEqual(["team_ops", "alpha-team"]);
		});

		it("limits, reports more, and looks up ids", async () => {
			const limited = await groups({ limit: "2" });
			expect(limited.groups).toHaveLength(2);
			expect(limited.more).toBe(true);
			const exact = await groups({ ids: `${ids["group:zeta"]},${ids["group:alpha-team"]}` });
			expect(exact.groups.map((group) => group.name)).toEqual(["alpha-team", "zeta"]);
			expect(exact).not.toHaveProperty("more");
		});
	});

	describe("nodes", () => {
		const nodes = async (query: Record<string, string> = {}, cookie = adminCookie) => {
			const res = await get(withQuery("/api/nodes", query), cookie);
			expect(res.status).toBe(200);
			return (await res.json()) as NodeListResponse;
		};

		it("matches name or hostname case-insensitively for an administrator", async () => {
			expect((await nodes({ q: "WEB" })).nodes.map((node) => node.name)).toEqual(["web-01", "web-hidden"]);
			expect((await nodes({ q: "db.local" })).nodes.map((node) => node.name)).toEqual(["database_01"]);
			expect((await nodes({ q: "01" })).nodes.map((node) => node.name)).toEqual(["database_01", "web-01", "worker-01"]);
		});

		it("orders prefix matches before substring matches", async () => {
			// "web" prefixes web-01 and web-hidden; worker-01 only contains it in no column.
			expect((await nodes({ q: "web" })).nodes.map((node) => node.name)).toEqual(["web-01", "web-hidden"]);
		});

		it("applies the visibility rules to q, limit and ids", async () => {
			const admin = await nodes({ q: "web" });
			expect(admin.nodes.map((node) => node.name)).toEqual(["web-01", "web-hidden"]);
			const member = await nodes({ q: "web" }, memberCookie);
			expect(member.nodes.map((node) => node.name)).toEqual(["web-01"]);
			const hiddenById = await nodes({ ids: ids.nodeHidden as string }, memberCookie);
			expect(hiddenById.nodes).toEqual([]);
			expect((await nodes({ ids: ids.nodeHidden as string })).nodes.map((node) => node.name)).toEqual(["web-hidden"]);
			const limited = await nodes({ q: "web", limit: "1" });
			expect(limited.nodes.map((node) => node.name)).toEqual(["web-01"]);
			expect(limited.more).toBe(true);
			const memberLimited = await nodes({ q: "web", limit: "1" }, memberCookie);
			expect(memberLimited.more).toBe(false);
		});

		it("returns the unchanged visible list without search parameters", async () => {
			const member = { sessionId: "", userId: ids.alice as string, username: "alice", kind: "member" as const };
			const expected = (await listNodesForUser(db, member)).map((node) => node.id);
			const body = await nodes({}, memberCookie);
			expect(body.nodes.map((node) => node.id)).toEqual(expected);
			expect(body.nodes.map((node) => node.name)).toEqual(["web-01"]);
			expect(body).not.toHaveProperty("more");
		});
	});

	describe("node groups", () => {
		const groups = async (query: Record<string, string> = {}, cookie = adminCookie) => {
			const res = await get(withQuery("/api/node-groups", query), cookie);
			expect(res.status).toBe(200);
			return (await res.json()) as NodeGroupListResponse;
		};

		it("returns the unchanged list without search parameters", async () => {
			const body = await groups();
			expect(body.groups.map((group) => group.name)).toEqual(["data_group", "ops", "web"]);
			expect([...(body.groups.find((group) => group.name === "web")?.memberIds ?? [])].sort()).toEqual(
				[ids.nodeWeb, ids.nodeHidden].sort(),
			);
			expect(body).not.toHaveProperty("more");
		});

		it("searches by name and reports limit/more", async () => {
			expect((await groups({ q: "WEB" })).groups.map((group) => group.name)).toEqual(["web"]);
			const limited = await groups({ limit: "2" });
			expect(limited.groups).toHaveLength(2);
			expect(limited.more).toBe(true);
			const exact = await groups({ ids: `${ids.nodeGroupData},${ids.nodeGroupWeb}` });
			expect(exact.groups.map((group) => group.name)).toEqual(["data_group", "web"]);
		});

		it("keeps filtering a member's memberIds while searching", async () => {
			const member = await groups({ q: "web" }, memberCookie);
			expect(member.groups).toHaveLength(1);
			expect(member.groups[0]?.memberIds).toEqual([ids.nodeWeb]);
			// The unfiltered list and search still name every group.
			expect(
				[...(await queryNodeGroups(db, { q: "web" }).then((page) => page.items[0]?.memberIds ?? []))].sort(),
			).toEqual([ids.nodeWeb, ids.nodeHidden].sort());
		});
	});

	describe("directory", () => {
		const directory = async (query: Record<string, string> = {}, cookie = memberCookie) => {
			const res = await get(withQuery("/api/directory", query), cookie);
			expect(res.status).toBe(200);
			return (await res.json()) as DirectoryResponse;
		};

		it("returns the unchanged shape without search parameters, hiding disabled users", async () => {
			const body = await directory();
			expect(body).not.toHaveProperty("more");
			expect(body.users.map((user) => user.username)).toEqual([
				"alice",
				"ann",
				"anna",
				"backslash",
				"bob",
				"joann",
				"percent",
				"root",
				"under_score",
			]);
			expect(body.userGroups.map((group) => group.name)).toEqual(["alpha-team", "team_ops", "zeta"]);
		});

		it("searches users and user groups for a member", async () => {
			const users = await directory({ q: "ANN" });
			expect(users.users.map((user) => user.username)).toEqual(["ann", "anna", "joann"]);
			const mixed = await directory({ q: "team" });
			expect(mixed.users).toEqual([]);
			expect(mixed.userGroups.map((group) => group.name)).toEqual(["team_ops", "alpha-team"]);
		});

		it("looks up ids across both lists", async () => {
			const body = await directory({ ids: `${ids.alice},${ids["group:zeta"]},does-not-exist` });
			expect(body.users.map((user) => user.username)).toEqual(["alice"]);
			expect(body.userGroups.map((group) => group.name)).toEqual(["zeta"]);
		});

		it("limits each list and reports more for either one", async () => {
			const body = await directory({ limit: "1" });
			expect(body.users).toHaveLength(1);
			expect(body.userGroups).toHaveLength(1);
			expect(body.more).toBe(true);
			const onlyUsers = await directory({ q: "a", limit: "100" });
			expect(onlyUsers.more).toBe(false);
		});
	});

	it("rejects search parameters for non-administrators on the admin lists", async () => {
		expect((await get(withQuery("/api/users", { q: "a" }), memberCookie)).status).toBe(403);
		expect((await get(withQuery("/api/user-groups", { q: "a" }), memberCookie)).status).toBe(403);
	});
});
