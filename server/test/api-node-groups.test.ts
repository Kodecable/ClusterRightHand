import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit } from "../src/audit/audit.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

describe("api node groups", () => {
	let db: Db;
	let app: App;
	let audit: Audit;
	const ids: Record<string, string> = {};
	const cookies: Record<string, string> = {};
	let visibleNodeId: string;
	let hiddenNodeId: string;

	async function addNode(ownerUserId: string, name: string): Promise<string> {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				owner_user_id: ownerUserId,
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status: "active",
				public_key: null,
				hostname: name,
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
	}

	const req = (who: string, path: string, body?: unknown, method?: string) =>
		call(app, path, { cookie: cookies[who], body, method });

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		audit = new Audit(db);
		app = createApp(db, { serverFingerprint: "fp-test", audit });
		for (const [name, kind] of [
			["root", "admin"],
			["member", "member"],
		] as const) {
			ids[name] = (await createUser(db, { username: name, kind, password: "password-123" })).id;
			cookies[name] = await login(app, name, "password-123");
		}
		visibleNodeId = await addNode(ids.member as string, "member-node");
		hiddenNodeId = await addNode(ids.root as string, "admin-node");
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("lets any signed-in user list groups, with members filtered to the nodes they can see", async () => {
		const created = await req("root", "/api/node-groups", { name: "Web" });
		expect(created.status).toBe(201);
		const group = (await created.json()) as { group: { id: string; name: string; memberIds: string[] } };
		expect(group.group).toMatchObject({ name: "Web", memberIds: [] });
		const id = group.group.id;

		expect(
			(await req("root", `/api/node-groups/${id}/members`, { nodeIds: [visibleNodeId, hiddenNodeId] }, "PUT")).status,
		).toBe(200);

		const asAdmin = (await (await req("root", "/api/node-groups")).json()) as {
			groups: { id: string; name: string; memberIds: string[] }[];
		};
		expect(asAdmin.groups.find((group) => group.name === "Web")?.memberIds.sort()).toEqual(
			[visibleNodeId, hiddenNodeId].sort(),
		);
		const asMember = (await (await req("member", "/api/node-groups")).json()) as {
			groups: { id: string; name: string; memberIds: string[] }[];
		};
		expect(asMember.groups.find((group) => group.name === "Web")?.memberIds).toEqual([visibleNodeId]);
		expect((await call(app, "/api/node-groups")).status).toBe(401);
	});

	it("keeps management administrator-only", async () => {
		const created = await req("root", "/api/node-groups", { name: "Ops" });
		const id = ((await created.json()) as { group: { id: string } }).group.id;
		expect((await req("member", "/api/node-groups", { name: "Nope" })).status).toBe(403);
		expect((await req("member", `/api/node-groups/${id}`, { name: "Nope" }, "PATCH")).status).toBe(403);
		expect((await req("member", `/api/node-groups/${id}`, {}, "DELETE")).status).toBe(403);
		expect((await req("member", `/api/node-groups/${id}/members`, { nodeIds: [] }, "PUT")).status).toBe(403);
	});

	it("renames and deletes, auditing each change", async () => {
		const created = await req("root", "/api/node-groups", { name: "Rename-Me" });
		const id = ((await created.json()) as { group: { id: string } }).group.id;
		const renamed = await req("root", `/api/node-groups/${id}`, { name: "Renamed" }, "PATCH");
		expect(renamed.status).toBe(200);
		expect(((await renamed.json()) as { group: { name: string } }).group.name).toBe("Renamed");
		const other = await req("root", "/api/node-groups", { name: "Other" });
		expect(other.status).toBe(201);
		expect((await req("root", `/api/node-groups/${id}`, { name: "Other" }, "PATCH")).status).toBe(400);
		expect((await req("root", `/api/node-groups/${id}`, {}, "DELETE")).status).toBe(200);
		expect((await req("root", `/api/node-groups/${id}`, { name: "Again" }, "PATCH")).status).toBe(404);

		await audit.flush();
		const actions = (await db.selectFrom("audit_events").select("action").where("target_id", "=", id).execute()).map(
			(row) => row.action,
		);
		expect(actions).toContain("node_group.created");
		expect(actions).toContain("node_group.renamed");
		expect(actions).toContain("node_group.deleted");
	});

	it("shares the namespace with nodes, case-insensitively, in both directions", async () => {
		expect((await req("root", "/api/node-groups", { name: "MEMBER-NODE" })).status).toBe(400);
		const created = await req("root", "/api/node-groups", { name: "TakenByGroup" });
		const id = ((await created.json()) as { group: { id: string } }).group.id;
		expect((await req("root", "/api/node-groups", { name: "takenbygroup" })).status).toBe(400);
		// The node rename route uses the same namespace and validation.
		expect((await req("root", `/api/nodes/${visibleNodeId}`, { name: "takenbygroup" }, "PATCH")).status).toBe(400);
		expect((await req("root", `/api/nodes/${visibleNodeId}`, { name: "MEMBER-NODE" }, "PATCH")).status).toBe(200);
		expect((await req("root", `/api/nodes/${visibleNodeId}`, { name: "x" }, "PATCH")).status).toBe(400);
		expect((await req("root", `/api/node-groups/${id}`, {}, "DELETE")).status).toBe(200);
	});
});
