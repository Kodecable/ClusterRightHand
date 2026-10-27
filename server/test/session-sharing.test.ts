import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { addGroupMember, createUserGroup } from "../src/users/groups.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const PASSWORD = "member-password-123";

/** Session sharing (doc/access-control.md#归属与分享): a session acts for its owner. */
let db: Db;
let app: App;
let audit: Audit;
let runtime: AgentRuntime;
let alice = "";
let bob = "";
let carol = "";
let admin = "";
let aliceId = "";
let bobId = "";
let carolId = "";
let groupId = "";
const faux = fauxProvider();
let seq = 0;

const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		groups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });

	const root = await createUser(db, { username: "root", kind: "admin", password: PASSWORD });
	const a = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	const b = await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	const c = await createUser(db, { username: "carol", kind: "member", password: PASSWORD });
	aliceId = a.id;
	bobId = b.id;
	carolId = c.id;
	admin = await login(app, root.username, PASSWORD);
	alice = await login(app, "alice", PASSWORD);
	bob = await login(app, "bob", PASSWORD);
	carol = await login(app, "carol", PASSWORD);
	const group = await createUserGroup(db, "ops");
	groupId = group.id;
	await addGroupMember(db, group.id, bobId);
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

async function newSession(cookie: string, title: string, preset = "ask") {
	const res = await call(app, "/api/sessions", { cookie, body: { title, model: model(), preset } });
	expect(res.status).toBe(201);
	return ((await res.json()) as { session: { id: string; access: string; ownerUserId: string } }).session;
}

const share = (id: string, cookie: string, body: Record<string, unknown>) =>
	call(app, `/api/sessions/${id}/shares`, { method: "PUT", cookie, body });

const list = async (cookie: string) =>
	(
		(await (await call(app, "/api/sessions", { cookie })).json()) as {
			sessions: { id: string; access: string; ownerUsername: string | null }[];
		}
	).sessions;

const get = (id: string, cookie: string) => call(app, `/api/sessions/${id}`, { cookie });

const messages = (id: string, cookie: string, text = "hello") =>
	call(app, `/api/sessions/${id}/messages`, { cookie, body: { text, requestId: `req-${++seq}` } });

async function answer(id: string, cookie: string): Promise<string> {
	faux.setResponses([fauxAssistantMessage([fauxText("an answer")])]);
	const res = await messages(id, cookie);
	expect(res.status).toBe(202);
	const { submissionId } = (await res.json()) as { submissionId: string };
	const settled = await runtime.waitSubmission(id, submissionId);
	expect(settled.status).toBe("done");
	return settled.status === "done" ? settled.answer : "";
}

it("is invisible until shared, then view can look but not drive", async () => {
	const s = await newSession(alice, "alice's session");
	expect((await get(s.id, bob)).status).toBe(404);
	expect((await list(bob)).map((x) => x.id)).not.toContain(s.id);

	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "view" })).status).toBe(200);
	const seen = (await list(bob)).find((x) => x.id === s.id);
	expect(seen).toMatchObject({ access: "view", ownerUsername: "alice" });
	const res = await get(s.id, bob);
	expect(res.status).toBe(200);
	expect(((await res.json()) as { session: { access: string } }).session.access).toBe("view");
	expect((await messages(s.id, bob)).status).toBe(403);
	expect((await call(app, `/api/sessions/${s.id}/abort`, { cookie: bob, body: {} })).status).toBe(403);
	expect(
		(await call(app, `/api/sessions/${s.id}`, { method: "PATCH", cookie: bob, body: { title: "mine" } })).status,
	).toBe(403);
});

it("chat drives the session for its owner; audits name both", async () => {
	const s = await newSession(alice, "chat me", "yolo");
	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "chat" })).status).toBe(200);
	await audit.flush();
	expect(await answer(s.id, bob)).toBe("an answer");

	const rows = await db.selectFrom("audit_events").selectAll().where("action", "=", "session.message").execute();
	const event = rows.find((r) => r.target_id === s.id);
	expect(event).toMatchObject({ actor_type: "user", actor_id: bobId, on_behalf_of_user_id: aliceId, target_id: s.id });

	// Sending is the only shared power: the session's rules, model and title stay the owner's.
	expect(
		(await call(app, `/api/sessions/${s.id}`, { method: "PATCH", cookie: bob, body: { preset: "yolo" } })).status,
	).toBe(403);
	expect((await call(app, `/api/sessions/${s.id}/shares`, { cookie: bob })).status).toBe(403);
});

it("shares to a group reach its members only", async () => {
	const s = await newSession(alice, "for the group");
	expect((await share(s.id, alice, { granteeType: "user_group", granteeId: groupId, access: "view" })).status).toBe(
		200,
	);
	expect((await list(bob)).find((x) => x.id === s.id)?.access).toBe("view");
	expect((await list(carol)).map((x) => x.id)).not.toContain(s.id);
	expect((await get(s.id, carol)).status).toBe(404);
});

it("a share on the root reaches its subagents", async () => {
	const s = await newSession(alice, "with a subagent", "yolo");
	const child = await runtime.createSubagent(s.id, {
		callKey: `share-child-${++seq}`,
		task: "child work",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	expect((await get(child.id, bob)).status).toBe(404);

	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "chat" })).status).toBe(200);
	const res = await get(child.id, bob);
	expect(res.status).toBe(200);
	expect(((await res.json()) as { session: { access: string } }).session.access).toBe("chat");
	expect((await get(child.id, carol)).status).toBe(404);
});

it("administrators look and may share, but do not drive", async () => {
	const s = await newSession(alice, "admin looks");
	const res = await get(s.id, admin);
	expect(res.status).toBe(200);
	expect(((await res.json()) as { session: { access: string } }).session.access).toBe("admin");
	expect((await messages(s.id, admin)).status).toBe(403);
	expect((await list(admin)).find((x) => x.id === s.id)?.access).toBe("admin");
	// Administrators may manage shares (doc/access-control.md#归属与分享).
	expect((await share(s.id, admin, { granteeType: "user", granteeId: carolId, access: "view" })).status).toBe(200);
	expect((await get(s.id, carol)).status).toBe(200);
});

it("rejects bad shares and keeps the owner supreme", async () => {
	const s = await newSession(alice, "validation");
	expect((await share(s.id, alice, { granteeType: "user", granteeId: aliceId, access: "view" })).status).toBe(400);
	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "operate" })).status).toBe(400);
	expect((await share(s.id, alice, { granteeType: "nobody", granteeId: bobId, access: "view" })).status).toBe(400);
	expect((await share(s.id, alice, { granteeType: "user", granteeId: "missing", access: "view" })).status).toBe(404);
	expect((await share("missing", alice, { granteeType: "user", granteeId: bobId, access: "view" })).status).toBe(404);
});

it("unsharing closes the door and is audited", async () => {
	const s = await newSession(alice, "revoked");
	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "chat" })).status).toBe(200);
	const shares = (
		(await (await call(app, `/api/sessions/${s.id}/shares`, { cookie: alice })).json()) as {
			shares: { id: string; granteeName: string; access: string }[];
		}
	).shares;
	expect(shares.map((x) => [x.granteeName, x.access])).toEqual([["bob", "chat"]]);

	await audit.flush();
	expect(
		(await call(app, `/api/sessions/${s.id}/shares/${shares[0]?.id}`, { method: "DELETE", cookie: alice, body: {} }))
			.status,
	).toBe(200);
	expect((await get(s.id, bob)).status).toBe(404);
	expect((await messages(s.id, bob)).status).toBe(404);
	await audit.flush();
	const events = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "in", ["session.shared", "session.unshared"])
		.where("target_id", "=", s.id)
		.execute();
	expect(events.map((e) => e.action)).toEqual(["session.shared", "session.unshared"]);
	expect(JSON.parse(events[1]?.detail ?? "{}")).toMatchObject({ grantee_id: bobId, access: "chat" });
});
