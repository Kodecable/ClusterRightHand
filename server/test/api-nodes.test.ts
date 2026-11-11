import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { enrollNode, parseEnrollmentToken } from "../src/cluster/enrollment.ts";
import type { PublicNode } from "../src/cluster/nodes.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { addUserGroupMember, createUserGroup } from "../src/users/user-groups.ts";
import { type App, call, login } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describeBackends("api nodes", (backend) => {
	let db: Db;
	let app: App;
	const ids: Record<string, string> = {};
	const cookies: Record<string, string> = {};
	let groupId: string;
	let sshNodeId: string;

	const newToken = async (who = "root", body: unknown = {}) => {
		const res = await call(app, "/api/enrollment-tokens", { cookie: cookies[who], body });
		expect(res.status).toBe(201);
		return ((await res.json()) as { token: string }).token;
	};
	const enrollFor = async (hostname: string, tokenBy = "root") => {
		const token = await newToken(tokenBy);
		return enrollNode(db, {
			secret: parseEnrollmentToken(token).secret,
			publicKey: new Uint8Array(randomBytes(32)),
			hostname,
			facts: {},
			clientVersion: "1",
		});
	};
	const get = (who: string, id: string) => call(app, `/api/nodes/${id}`, { cookie: cookies[who] });
	const grant = (who: string, body: unknown) => call(app, "/api/node-access-grants", { cookie: cookies[who], body });

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = createApp(db, {
			serverFingerprint: "fp-test",
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			masterKey: MasterKey.generate(),
		});
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
		await addUserGroupMember(db, groupId, ids.viewer as string);
		sshNodeId = (await enrollFor("ssh-reenroll")).id;
		await db.updateTable("nodes").set({ transport: "ssh" }).where("id", "=", sshNodeId).execute();
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("requires sign-in and an administrator for enrollment tokens", async () => {
		expect((await call(app, "/api/nodes")).status).toBe(401);
		expect((await call(app, "/api/enrollment-tokens", { cookie: cookies.owner, body: {} })).status).toBe(403);
		const bare = createApp(db);
		const res = await call(bare, "/api/enrollment-tokens", { cookie: cookies.root, body: {} });
		// the cookie is valid against the same database
		expect(res.status).toBe(500);
		expect(((await res.json()) as { error: string }).error).toMatch(/fingerprint/);
	});

	it("issues enrollment tokens to administrators", async () => {
		const res = await call(app, "/api/enrollment-tokens", { cookie: cookies.root, body: { nameHint: "Foo" } });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; expiresAt: string };
		expect(parseEnrollmentToken(body.token).fingerprint).toBe("fp-test");
		expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
	});

	it("issues re-enrollment tokens bound to a crha node", async () => {
		const n = await enrollFor("reenroll-token");
		const res = await call(app, `/api/nodes/${n.id}/reenroll`, { cookie: cookies.root, body: {} });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; expiresAt: string };
		expect(parseEnrollmentToken(body.token).fingerprint).toBe("fp-test");
		expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
		const row = await db
			.selectFrom("enrollment_tokens")
			.selectAll()
			.where("bound_node_id", "=", n.id)
			.executeTakeFirst();
		expect(row).toMatchObject({ bound_node_id: n.id, used_at: null });
	});

	it("refuses to re-enroll an SSH node", async () => {
		const res = await call(app, `/api/nodes/${sshNodeId}/reenroll`, { cookie: cookies.root, body: {} });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/SSH nodes/);
	});

	describe("access and permissions", () => {
		let nodeId: string;
		beforeAll(async () => {
			nodeId = (await enrollFor("perm-node")).id;
			expect(
				(await grant("root", { granteeType: "user", granteeId: ids.op, targetType: "node", targetId: nodeId })).status,
			).toBe(201);
			expect(
				(
					await grant("root", {
						granteeType: "user_group",
						granteeId: groupId,
						targetType: "node",
						targetId: nodeId,
					})
				).status,
			).toBe(201);
		});

		it("shows a granted node to its grantees, hides it from everyone else, and adds SSH details for admins only", async () => {
			const expected: Record<string, string | undefined> = {
				root: "admin",
				op: "granted",
				viewer: "granted",
				owner: undefined,
				stranger: undefined,
			};
			for (const [who, access] of Object.entries(expected)) {
				const res = await get(who, nodeId);
				if (!access) {
					expect(res.status).toBe(404);
					continue;
				}
				expect(res.status).toBe(200);
				const body = (await res.json()) as { node: PublicNode; shares?: unknown[]; ssh?: unknown };
				expect(body.node.access).toBe(access);
				expect(body.node.name).toBe("perm-node");
				expect(body).not.toHaveProperty("shares");
				if (who === "root") expect(body).toHaveProperty("ssh");
				else expect(body).not.toHaveProperty("ssh");
			}
			const list = async (who: string) =>
				((await (await call(app, "/api/nodes", { cookie: cookies[who] })).json()) as { nodes: PublicNode[] }).nodes;
			expect((await list("viewer")).map((n) => n.id)).toContain(nodeId);
			expect((await list("stranger")).map((n) => n.id)).not.toContain(nodeId);
		});

		it("restricts management routes: 403 for grantees, 404 for strangers", async () => {
			const attempts: [string, string, unknown][] = [
				["POST", `/api/nodes/${nodeId}/approve`, undefined],
				["PATCH", `/api/nodes/${nodeId}`, { name: "x" }],
				["DELETE", `/api/nodes/${nodeId}`, undefined],
				["PUT", `/api/nodes/${nodeId}/node-groups`, { nodeGroups: [] }],
				["POST", "/api/enrollment-tokens", {}],
				["POST", `/api/nodes/${nodeId}/reenroll`, {}],
				["POST", "/api/ssh-credentials", { name: "x" }],
				["DELETE", "/api/ssh-credentials/x", {}],
				["POST", "/api/ssh-nodes", {}],
				["POST", "/api/ssh-nodes/probe", {}],
				["POST", "/api/ssh-nodes/test", {}],
			];
			for (const [method, path, body] of attempts) {
				for (const [who, status] of [
					["op", 403],
					["viewer", 403],
				] as const) {
					const res = await call(app, path, { method, cookie: cookies[who], body: body ?? {} });
					expect(res.status, `${method} ${path} as ${who}`).toBe(status);
				}
				if (path.includes(nodeId)) {
					const res = await call(app, path, { method, cookie: cookies.stranger, body: body ?? {} });
					expect(res.status, `${method} ${path} as stranger`).toBe(404);
				}
			}
			for (const who of ["op", "viewer"]) {
				expect((await call(app, "/api/ssh-credentials", { cookie: cookies[who] })).status).toBe(403);
			}
			expect((await get("root", nodeId)).status).toBe(200);
		});
	});

	it("approve flow: pending to active, then 409", async () => {
		const n = await enrollFor("approve-me");
		expect((await (await get("root", n.id)).json()) as { node: PublicNode }).toMatchObject({
			node: { status: "pending" },
		});
		const res = await call(app, `/api/nodes/${n.id}/approve`, { cookie: cookies.root, body: {} });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { node: PublicNode }).node.status).toBe("active");
		expect((await call(app, `/api/nodes/${n.id}/approve`, { cookie: cookies.root, body: {} })).status).toBe(409);
	});

	it("renames nodes, rejecting duplicates and bad names", async () => {
		const a = await enrollFor("ren-a");
		await enrollFor("ren-b");
		const patch = (name: unknown) =>
			call(app, `/api/nodes/${a.id}`, { method: "PATCH", cookie: cookies.root, body: { name } });
		const ok = await patch("Renamed");
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { node: PublicNode }).node.name).toBe("Renamed");
		expect((await patch("ren-b")).status).toBe(400);
		expect((await patch("bad name")).status).toBe(400);
		expect((await patch(5)).status).toBe(400);
	});

	it("delete works for pending and active nodes and removes grants", async () => {
		const pending = await enrollFor("reject-me");
		expect(
			(await call(app, `/api/nodes/${pending.id}`, { method: "DELETE", cookie: cookies.root, body: {} })).status,
		).toBe(200);
		expect((await get("root", pending.id)).status).toBe(404);

		const active = await enrollFor("remove-me");
		await call(app, `/api/nodes/${active.id}/approve`, { cookie: cookies.root, body: {} });
		await grant("root", { granteeType: "user", granteeId: ids.op, targetType: "node", targetId: active.id });
		expect(
			(await call(app, `/api/nodes/${active.id}`, { method: "DELETE", cookie: cookies.root, body: {} })).status,
		).toBe(200);
		expect(
			await db.selectFrom("node_access_grants").select("id").where("target_id", "=", active.id).execute(),
		).toHaveLength(0);
		expect((await get("op", active.id)).status).toBe(404);
	});
});
