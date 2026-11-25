import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit } from "../src/audit/audit.ts";
import { NODE_USER_REMARK_MAX_CODE_POINTS } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function addNode(db: Db, name: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
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
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	return id;
}

describeBackends("node user remark API", (backend) => {
	let db: Db;
	let app: App;
	let audit: Audit;
	let rootCookie: string;
	let memberCookie: string;
	let strangerCookie: string;
	let nodeId: string;

	const setUserRemark = (cookie: string, userRemark: string | null, id = nodeId) =>
		call(app, `/api/nodes/${id}/user-remark`, { method: "PUT", cookie, body: { userRemark } });
	const nodeUserRemark = async (cookie: string, id = nodeId): Promise<string | null> => {
		const res = await call(app, `/api/nodes/${id}`, { cookie });
		expect(res.status).toBe(200);
		return ((await res.json()) as { node: { userRemark: string | null } }).node.userRemark;
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		app = createApp(db, { clientAddress: () => "198.51.100.7", captcha: "none", audit });
		const root = await createUser(db, { username: "remark-root", kind: "admin", password: "password-123" });
		const member = await createUser(db, { username: "remark-member", kind: "member", password: "password-123" });
		await createUser(db, { username: "remark-stranger", kind: "member", password: "password-123" });
		nodeId = await addNode(db, "remark-node");
		// A member sees the node only through a grant; without one it is hidden and answers 404.
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: member.id,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: root.id,
				created_at: new Date().toISOString(),
			})
			.execute();
		rootCookie = await login(app, "remark-root", "password-123");
		memberCookie = await login(app, "remark-member", "password-123");
		strangerCookie = await login(app, "remark-stranger", "password-123");
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("sets a trimmed user remark and serves it on the detail and the list", async () => {
		const res = await setUserRemark(rootCookie, "  rack 4, lab  ");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { node: { userRemark: string | null; name: string } };
		expect(body.node.userRemark).toBe("rack 4, lab");
		expect(body.node.name).toBe("remark-node");
		expect(await nodeUserRemark(rootCookie)).toBe("rack 4, lab");

		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: { id: string; userRemark: string | null }[];
		};
		expect(list.nodes.find((node) => node.id === nodeId)?.userRemark).toBe("rack 4, lab");
	});

	it("accepts 50 Unicode code points, counting an emoji as one and not as two UTF-16 units", async () => {
		const fifty = "😀".repeat(NODE_USER_REMARK_MAX_CODE_POINTS);
		expect(fifty.length).toBe(NODE_USER_REMARK_MAX_CODE_POINTS * 2);
		const res = await setUserRemark(rootCookie, fifty);
		expect(res.status).toBe(200);
		expect(await nodeUserRemark(rootCookie)).toBe(fifty);
	});

	it("rejects a user remark over 50 code points", async () => {
		for (const userRemark of [
			"x".repeat(NODE_USER_REMARK_MAX_CODE_POINTS + 1),
			"😀".repeat(NODE_USER_REMARK_MAX_CODE_POINTS + 1),
		]) {
			const res = await setUserRemark(rootCookie, userRemark);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/at most 50/);
		}
		// The refused user remarks left the stored one alone.
		expect(await nodeUserRemark(rootCookie)).toBe("😀".repeat(NODE_USER_REMARK_MAX_CODE_POINTS));
	});

	it("rejects a newline or another control character: the user remark is one line", async () => {
		for (const userRemark of ["two\nlines", "tab\there", "nul\u0000byte", "del\u007fchar"]) {
			const res = await setUserRemark(rootCookie, userRemark);
			expect(res.status, userRemark).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/single line/);
		}
	});

	it("stores an empty or blank user remark as null", async () => {
		expect((await setUserRemark(rootCookie, "remarked")).status).toBe(200);
		const blank = await setUserRemark(rootCookie, "   ");
		expect(blank.status).toBe(200);
		expect(((await blank.json()) as { node: { userRemark: string | null } }).node.userRemark).toBeNull();
		expect(await nodeUserRemark(rootCookie)).toBeNull();

		const explicit = await setUserRemark(rootCookie, null);
		expect(explicit.status).toBe(200);
		expect(((await explicit.json()) as { node: { userRemark: string | null } }).node.userRemark).toBeNull();
	});

	it("refuses members and hides the node from users without access", async () => {
		expect((await setUserRemark(memberCookie, "member write")).status).toBe(403);
		expect((await setUserRemark(strangerCookie, "stranger write")).status).toBe(404);
		expect((await setUserRemark(rootCookie, "missing", "no-such-node")).status).toBe(404);
		expect(
			(await call(app, `/api/nodes/${nodeId}/user-remark`, { method: "PUT", body: { userRemark: "anon" } })).status,
		).toBe(401);
		expect(await nodeUserRemark(rootCookie)).toBeNull();
	});

	it("audits the previous and the new user remark", async () => {
		expect((await setUserRemark(rootCookie, "first remark")).status).toBe(200);
		expect((await setUserRemark(rootCookie, "second remark")).status).toBe(200);
		await audit.flush();
		const rows = await db
			.selectFrom("audit_events")
			.select(["target_type", "target_id", "detail"])
			.where("action", "=", "node.user_remark_set")
			.orderBy("seq", "desc")
			.execute();
		const [latest, first] = rows;
		expect(latest).toMatchObject({ target_type: "node", target_id: nodeId });
		expect(JSON.parse(latest?.detail ?? "null")).toEqual({ previous: "first remark", userRemark: "second remark" });
		expect(JSON.parse(first?.detail ?? "null")).toEqual({ previous: null, userRemark: "first remark" });
	});
});
