import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { enrollNode, parseEnrollmentToken } from "../src/cluster/enrollment.ts";
import type { PublicNode } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { addGroupMember, createUserGroup } from "../src/users/groups.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describeBackends("api nodes", (backend) => {
	let db: Db;
	let app: App;
	const ids: Record<string, string> = {};
	const cookies: Record<string, string> = {};
	let groupId: string;

	const newToken = async (who: string, body: unknown = {}) => {
		const res = await call(app, "/api/enrollment-tokens", { cookie: cookies[who], body });
		expect(res.status).toBe(201);
		return ((await res.json()) as { token: string }).token;
	};
	const enrollFor = async (who: string, hostname: string) => {
		const token = await newToken(who);
		return enrollNode(db, {
			secret: parseEnrollmentToken(token).secret,
			publicKey: new Uint8Array(randomBytes(32)),
			hostname,
			facts: {},
			clientVersion: "1",
		});
	};
	const get = (who: string, id: string) => call(app, `/api/nodes/${id}`, { cookie: cookies[who] });

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = createApp(db, { serverFingerprint: "fp-test", clientAddress: () => "198.51.100.7" });
		for (const [name, kind] of [
			["root", "admin"],
			["owner", "member"],
			["op", "member"],
			["viewer", "member"],
			["stranger", "member"],
		] as const) {
			ids[name] = (await createUser(db, { username: name, kind, password: "password-123" })).id;
			cookies[name] = await login(app, name, "password-123");
		}
		groupId = (await createUserGroup(db, "viewers")).id;
		await addGroupMember(db, groupId, ids.viewer as string);
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("requires sign-in and a configured fingerprint", async () => {
		expect((await call(app, "/api/nodes")).status).toBe(401);
		const bare = createApp(db);
		const res = await call(bare, "/api/enrollment-tokens", { cookie: cookies.owner, body: {} });
		// the cookie is valid against the same database
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: string }).error).toMatch(/fingerprint/);
	});

	it("issues enrollment tokens to any signed-in user", async () => {
		const res = await call(app, "/api/enrollment-tokens", { cookie: cookies.stranger, body: { nameHint: "Foo" } });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; expiresAt: string };
		expect(parseEnrollmentToken(body.token).fingerprint).toBe("fp-test");
		expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
	});

	describe("permissions", () => {
		let nodeId: string;
		beforeAll(async () => {
			nodeId = (await enrollFor("owner", "perm-node")).id;
			const put = (granteeType: string, granteeId: string, access: string) =>
				call(app, `/api/nodes/${nodeId}/shares`, {
					method: "PUT",
					cookie: cookies.owner,
					body: { granteeType, granteeId, access },
				});
			expect((await put("user", ids.op as string, "operate")).status).toBe(200);
			expect((await put("user_group", groupId, "view")).status).toBe(200);
		});

		it("shows the node and its access level to everyone who can see it; shares only to owner/admin", async () => {
			const expected: Record<string, string | undefined> = {
				owner: "owner",
				root: "admin",
				op: "operate",
				viewer: "view",
				stranger: undefined,
			};
			for (const [who, access] of Object.entries(expected)) {
				const res = await get(who, nodeId);
				if (!access) {
					expect(res.status).toBe(404);
					continue;
				}
				expect(res.status).toBe(200);
				const body = (await res.json()) as { node: PublicNode; shares?: unknown[] };
				expect(body.node.access).toBe(access);
				expect(body.node.name).toBe("perm-node");
				if (who === "owner" || who === "root") expect(body.shares).toHaveLength(2);
				else expect(body).not.toHaveProperty("shares");
			}
			const list = async (who: string) =>
				((await (await call(app, "/api/nodes", { cookie: cookies[who] })).json()) as { nodes: PublicNode[] }).nodes;
			expect((await list("viewer")).map((n) => n.id)).toEqual([nodeId]);
			expect((await list("stranger")).map((n) => n.id)).not.toContain(nodeId);
		});

		it("restricts management routes: 403 for shared users, 404 for strangers", async () => {
			const attempts: [string, string, unknown][] = [
				["POST", `/api/nodes/${nodeId}/approve`, undefined],
				["PATCH", `/api/nodes/${nodeId}`, { name: "x" }],
				["DELETE", `/api/nodes/${nodeId}`, undefined],
				["PUT", `/api/nodes/${nodeId}/shares`, { granteeType: "user", granteeId: ids.op, access: "view" }],
				["DELETE", `/api/nodes/${nodeId}/shares/whatever`, undefined],
			];
			for (const [method, path, body] of attempts) {
				for (const [who, status] of [
					["op", 403],
					["viewer", 403],
					["stranger", 404],
				] as const) {
					const res = await call(app, path, { method, cookie: cookies[who], body: body ?? {} });
					expect(res.status, `${method} ${path} as ${who}`).toBe(status);
				}
			}
			expect((await get("owner", nodeId)).status).toBe(200);
		});
	});

	it("approve flow: pending to active, then 409", async () => {
		const n = await enrollFor("owner", "approve-me");
		expect((await (await get("owner", n.id)).json()) as { node: PublicNode }).toMatchObject({
			node: { status: "pending" },
		});
		const res = await call(app, `/api/nodes/${n.id}/approve`, { cookie: cookies.owner, body: {} });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { node: PublicNode }).node.status).toBe("active");
		expect((await call(app, `/api/nodes/${n.id}/approve`, { cookie: cookies.owner, body: {} })).status).toBe(409);
		const n2 = await enrollFor("owner", "approve-by-admin");
		expect((await call(app, `/api/nodes/${n2.id}/approve`, { cookie: cookies.root, body: {} })).status).toBe(200);
	});

	it("renames nodes, rejecting duplicates and bad names", async () => {
		const a = await enrollFor("owner", "ren-a");
		await enrollFor("owner", "ren-b");
		const patch = (name: unknown) =>
			call(app, `/api/nodes/${a.id}`, { method: "PATCH", cookie: cookies.owner, body: { name } });
		const ok = await patch("Renamed");
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { node: PublicNode }).node.name).toBe("renamed");
		expect((await patch("ren-b")).status).toBe(400);
		expect((await patch("bad name")).status).toBe(400);
		expect((await patch(5)).status).toBe(400);
	});

	it("share upsert, validation and delete", async () => {
		const n = await enrollFor("owner", "share-me");
		const put = (body: unknown, who = "owner") =>
			call(app, `/api/nodes/${n.id}/shares`, { method: "PUT", cookie: cookies[who], body });
		const first = (await (await put({ granteeType: "user", granteeId: ids.viewer, access: "view" })).json()) as {
			share: { id: string; access: string };
		};
		expect(first.share.access).toBe("view");
		const second = (await (
			await put({ granteeType: "user", granteeId: ids.viewer, access: "operate" }, "root")
		).json()) as {
			share: { id: string; access: string };
		};
		expect(second.share).toMatchObject({ id: first.share.id, access: "operate" });
		expect(((await (await get("viewer", n.id)).json()) as { node: PublicNode }).node.access).toBe("operate");
		expect((await put({ granteeType: "user", granteeId: "nope", access: "view" })).status).toBe(404);
		expect((await put({ granteeType: "team", granteeId: ids.op, access: "view" })).status).toBe(400);
		expect((await put({ granteeType: "user", granteeId: ids.op, access: "chat" })).status).toBe(400);
		expect((await put({ granteeType: "user", access: "view" })).status).toBe(400);

		const del = await call(app, `/api/nodes/${n.id}/shares/${first.share.id}`, {
			method: "DELETE",
			cookie: cookies.owner,
			body: {},
		});
		expect(del.status).toBe(200);
		expect((await get("viewer", n.id)).status).toBe(404);
		const again = await call(app, `/api/nodes/${n.id}/shares/${first.share.id}`, {
			method: "DELETE",
			cookie: cookies.owner,
			body: {},
		});
		expect(again.status).toBe(404);
	});

	it("delete works for pending and active nodes and removes shares", async () => {
		const pending = await enrollFor("owner", "reject-me");
		expect(
			(await call(app, `/api/nodes/${pending.id}`, { method: "DELETE", cookie: cookies.owner, body: {} })).status,
		).toBe(200);
		expect((await get("owner", pending.id)).status).toBe(404);

		const active = await enrollFor("owner", "remove-me");
		await call(app, `/api/nodes/${active.id}/approve`, { cookie: cookies.owner, body: {} });
		await call(app, `/api/nodes/${active.id}/shares`, {
			method: "PUT",
			cookie: cookies.owner,
			body: { granteeType: "user", granteeId: ids.op, access: "view" },
		});
		expect(
			(await call(app, `/api/nodes/${active.id}`, { method: "DELETE", cookie: cookies.root, body: {} })).status,
		).toBe(200);
		expect(await db.selectFrom("shares").select("id").where("resource_id", "=", active.id).execute()).toHaveLength(0);
		expect((await get("op", active.id)).status).toBe(404);
	});
});
