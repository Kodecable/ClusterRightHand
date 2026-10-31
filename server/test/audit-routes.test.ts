import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Audit, type AuditEvent } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { enrollNode } from "../src/cluster/enrollment.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describeBackends("audit of API routes", (backend) => {
	let db: Db;
	let audit: Audit;
	let app: App;
	let admin: string;
	let adminId: string;

	const events = async (action: string): Promise<AuditEvent[]> => {
		await audit.flush();
		const res = await call(app, `/api/audit?action=${action}`, { cookie: admin });
		return ((await res.json()) as { items: AuditEvent[] }).items;
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		app = makeApp(db, undefined, { audit, cluster: new Cluster(db, { audit }), serverFingerprint: "fp" });
		adminId = (await createUser(db, { username: "root", kind: "admin", password: "root-password" })).id;
		admin = await login(app, "root", "root-password");
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("records logins and failed logins without the password", async () => {
		await call(app, "/api/auth/login", { body: { username: "root", password: "not-the-password" } });
		await call(app, "/api/auth/login", { body: { username: "nobody", password: "secret-guess" } });
		const failed = await events("auth.login_failed");
		expect(failed).toHaveLength(2);
		const known = failed.find((e) => e.detail.username === "root");
		expect(known).toMatchObject({
			actorType: "system",
			actorId: "auth",
			onBehalfOfUserId: adminId,
			detail: { reason: "wrong_password" },
		});
		expect(failed.find((e) => e.detail.username === "nobody")).toMatchObject({
			onBehalfOfUserId: null,
			detail: { reason: "unknown_user" },
		});
		expect(JSON.stringify(failed)).not.toContain("secret-guess");
		expect(JSON.stringify(failed)).not.toContain("not-the-password");

		const ok = await events("auth.login");
		expect(ok[0]).toMatchObject({ actorId: adminId, detail: { username: "root" } });
	});

	it("records user creation", async () => {
		const res = await call(app, "/api/users", { cookie: admin, body: { username: "dave", password: "dave-password" } });
		const { user } = (await res.json()) as { user: { id: string } };
		const [event] = await events("user.created");
		expect(event).toMatchObject({
			actorId: adminId,
			targetType: "user",
			targetId: user.id,
			detail: { username: "dave", kind: "member" },
		});
		expect(JSON.stringify(event)).not.toContain("dave-password");
	});

	it("records enrollment, rename and delete of a node", async () => {
		const tokenRes = await call(app, "/api/enrollment-tokens", { cookie: admin, body: { nameHint: "box" } });
		const { token } = (await tokenRes.json()) as { token: string };
		const [created] = await events("enrollment_token.created");
		expect(created?.targetType).toBe("enrollment_token");
		expect(JSON.stringify(created)).not.toContain(token.split(".")[2]);

		const node = await enrollNode(db, {
			secret: token.split(".")[2] as string,
			publicKey: new Uint8Array(32).fill(7),
			hostname: "box",
			facts: null,
			clientVersion: "test",
			audit,
		});
		const [enrolled] = await events("node.enrollment_requested");
		expect(enrolled).toMatchObject({ actorType: "system", onBehalfOfUserId: adminId, targetId: node.id });

		await call(app, `/api/nodes/${node.id}`, { method: "PATCH", cookie: admin, body: { name: "renamed" } });
		const [renamed] = await events("node.renamed");
		expect(renamed).toMatchObject({
			actorId: adminId,
			targetType: "node",
			targetId: node.id,
			detail: { old_name: "box", new_name: "renamed" },
		});

		const del = await call(app, `/api/nodes/${node.id}`, { method: "DELETE", cookie: admin, body: {} });
		expect(del.status).toBe(200);
		const [deleted] = await events("node.deleted");
		expect(deleted).toMatchObject({ targetId: node.id, detail: { was_pending: true } });
	});
});
