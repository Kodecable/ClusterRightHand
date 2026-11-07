import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { RulePreset } from "../src/policy/rules.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { addUserGroupMember, createUserGroup } from "../src/users/user-groups.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

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
let adminId = "";
let aliceId = "";
let bobId = "";
let carolId = "";
let groupId = "";
const faux = fauxProvider();
let seq = 0;
const owners = new Map<string, SessionUser>();

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
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });

	const root = await createUser(db, { username: "root", kind: "admin", password: PASSWORD });
	const a = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	const b = await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	const c = await createUser(db, { username: "carol", kind: "member", password: PASSWORD });
	adminId = root.id;
	aliceId = a.id;
	bobId = b.id;
	carolId = c.id;
	admin = await login(app, root.username, PASSWORD);
	alice = await login(app, "alice", PASSWORD);
	bob = await login(app, "bob", PASSWORD);
	carol = await login(app, "carol", PASSWORD);
	for (const [cookie, created] of [
		[admin, root],
		[alice, a],
		[bob, b],
		[carol, c],
	] as const) {
		owners.set(cookie, {
			sessionId: `test-${created.username}`,
			userId: created.id,
			username: created.username,
			kind: created.kind,
		});
	}
	const group = await createUserGroup(db, "ops");
	groupId = group.id;
	await addUserGroupMember(db, group.id, bobId);
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

async function newSession(cookie: string, title: string, rulePreset: RulePreset = "ask") {
	// Setup only: the HTTP create route now always submits a first message (D117), and these tests need a
	// session without a run, so the runtime creates it and the API renders the viewer's view of it.
	const owner = owners.get(cookie);
	if (!owner) throw new Error("unknown cookie");
	const created = await runtime.createSession(owner, { title, model: model(), rulePreset });
	const res = await call(app, `/api/sessions/${created.id}`, { cookie });
	expect(res.status).toBe(200);
	return (
		(await res.json()) as {
			session: {
				id: string;
				relationship: string;
				capabilities: { view: boolean; chat: boolean; manageShares: boolean; configure: boolean };
				ownerUserId: string;
			};
		}
	).session;
}

const share = (id: string, cookie: string, body: Record<string, unknown>) =>
	call(app, `/api/sessions/${id}/shares`, { method: "PUT", cookie, body });

const list = async (cookie: string, query = "") =>
	(
		(await (await call(app, `/api/sessions${query}`, { cookie })).json()) as {
			items: { id: string; shared: boolean; ownerName: string; ownerUserId: string }[];
		}
	).items;

const get = (id: string, cookie: string) => call(app, `/api/sessions/${id}`, { cookie });

const messages = (id: string, cookie: string, text = "hello") =>
	call(app, `/api/sessions/${id}/messages`, { cookie, body: { text, requestId: `req-${++seq}` } });

async function answer(id: string, cookie: string): Promise<string> {
	faux.setResponses([fauxAssistantMessage([fauxText("an answer")])]);
	const res = await messages(id, cookie);
	expect(res.status).toBe(202);
	const { submissionId } = (await res.json()) as { submissionId: string };
	const settled = await waitSubmission(runtime, id, submissionId);
	expect(settled.status).toBe("done");
	return settled.status === "done" ? settled.answer : "";
}

it("is invisible until shared, then view can look but not drive", async () => {
	const s = await newSession(alice, "alice's session");
	expect((await get(s.id, bob)).status).toBe(404);
	expect((await list(bob)).map((x) => x.id)).not.toContain(s.id);

	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "view" })).status).toBe(200);
	const seen = (await list(bob, "?scope=shared")).find((x) => x.id === s.id);
	expect(seen).toMatchObject({ shared: true, ownerName: "alice" });
	const res = await get(s.id, bob);
	expect(res.status).toBe(200);
	expect(
		(
			(await res.json()) as {
				session: { relationship: string; capabilities: { view: boolean; chat: boolean } };
			}
		).session,
	).toMatchObject({ relationship: "shared", capabilities: { view: true, chat: false } });
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
		(await call(app, `/api/sessions/${s.id}`, { method: "PATCH", cookie: bob, body: { rulePreset: "yolo" } })).status,
	).toBe(403);
	expect((await call(app, `/api/sessions/${s.id}/shares`, { cookie: bob })).status).toBe(403);
});

it("shares to a group reach its members only", async () => {
	const s = await newSession(alice, "for the group");
	expect((await share(s.id, alice, { granteeType: "user_group", granteeId: groupId, access: "view" })).status).toBe(
		200,
	);
	const member = (await (await get(s.id, bob)).json()) as {
		session: { capabilities: { view: boolean; chat: boolean } };
	};
	expect(member.session.capabilities).toMatchObject({ view: true, chat: false });
	expect((await list(carol, "?scope=shared")).map((x) => x.id)).not.toContain(s.id);
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
	expect(
		(
			(await res.json()) as {
				session: { relationship: string; capabilities: { view: boolean; chat: boolean } };
			}
		).session,
	).toMatchObject({ relationship: "shared", capabilities: { view: true, chat: true } });
	expect((await get(child.id, carol)).status).toBe(404);
});

it("closing a share ends an already open event stream", async () => {
	const s = await newSession(alice, "streamed", "yolo");
	expect((await share(s.id, alice, { granteeType: "user", granteeId: bobId, access: "view" })).status).toBe(200);
	const res = await call(app, `/api/sessions/${s.id}/events`, { cookie: bob });
	const reader = res.body?.getReader();
	expect(reader).toBeTruthy();
	const first = await reader?.read();
	expect(first?.done).toBe(false);
	const shares = (
		(await (await call(app, `/api/sessions/${s.id}/shares`, { cookie: alice })).json()) as {
			shares: { id: string }[];
		}
	).shares;
	await call(app, `/api/sessions/${s.id}/shares/${shares[0]?.id}`, { method: "DELETE", cookie: alice, body: {} });
	const closed = await Promise.race([
		(async () => {
			for (;;) {
				const chunk = await reader?.read();
				if (chunk?.done) return true;
			}
		})(),
		new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
	]);
	expect(closed).toBe(true);
	await reader?.cancel();
});

it("shares the same pair concurrently without a unique-constraint failure", async () => {
	const s = await newSession(alice, "concurrent shares");
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) =>
			share(s.id, alice, { granteeType: "user", granteeId: bobId, access: i % 2 === 0 ? "view" : "chat" }),
		),
	);
	expect(results.map((res) => res.status)).toEqual(Array.from({ length: 8 }, () => 200));
	const { shares } = (await (await call(app, `/api/sessions/${s.id}/shares`, { cookie: alice })).json()) as {
		shares: { granteeId: string; access: string }[];
	};
	expect(shares).toHaveLength(1);
	expect(shares[0]).toMatchObject({ granteeId: bobId, access: expect.stringMatching(/^(view|chat)$/) });
});

it("administrators look and may share, but do not drive", async () => {
	const s = await newSession(alice, "admin looks");
	const res = await get(s.id, admin);
	expect(res.status).toBe(200);
	expect(
		(
			(await res.json()) as {
				session: { relationship: string; capabilities: { chat: boolean; manageShares: boolean; configure: boolean } };
			}
		).session,
	).toMatchObject({
		relationship: "admin",
		capabilities: { chat: false, manageShares: true, configure: false },
	});
	expect((await messages(s.id, admin)).status).toBe(403);
	// The administrator sees it in `all`, but no share reaches them, so it is not `shared` (no share icon).
	expect((await list(admin, "?scope=all")).find((x) => x.id === s.id)?.shared).toBe(false);
	// Administrators may manage shares (doc/access-control.md#归属与分享).
	expect((await share(s.id, admin, { granteeType: "user", granteeId: carolId, access: "view" })).status).toBe(200);
	expect((await get(s.id, carol)).status).toBe(200);
});

it("an administrator chats only when explicitly shared chat", async () => {
	const s = await newSession(alice, "admin chat", "yolo");
	const before = (await (await get(s.id, admin)).json()) as {
		session: { relationship: string; capabilities: { chat: boolean } };
	};
	expect(before.session).toMatchObject({ relationship: "admin", capabilities: { chat: false } });
	expect((await messages(s.id, admin)).status).toBe(403);

	expect((await share(s.id, alice, { granteeType: "user", granteeId: adminId, access: "chat" })).status).toBe(200);
	const after = (await (await get(s.id, admin)).json()) as {
		session: { relationship: string; capabilities: { chat: boolean } };
	};
	expect(after.session).toMatchObject({ relationship: "admin", capabilities: { chat: true } });
	expect(await answer(s.id, admin)).toBe("an answer");
	// Still an administrator, not the owner: settings stay owner-only, share management stays available.
	expect(
		(await call(app, `/api/sessions/${s.id}`, { method: "PATCH", cookie: admin, body: { title: "mine" } })).status,
	).toBe(403);
	expect((await call(app, `/api/sessions/${s.id}/shares`, { cookie: admin })).status).toBe(200);
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

/** Opens a session event stream and checks that it started with a snapshot. */
async function openEventStream(sessionId: string, cookie: string) {
	const res = await call(app, `/api/sessions/${sessionId}/events`, { cookie });
	const reader = res.body?.getReader();
	if (!reader) throw new Error("the event stream has no body");
	const first = await reader.read();
	expect(first.done).toBe(false);
	return reader;
}

/** Whether the stream ended within `ms`; a ping every 15 s keeps it open otherwise. */
function streamClosed(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 2_000): Promise<boolean> {
	return Promise.race([
		(async () => {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) return true;
			}
		})(),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

it("disabling a user ends their open session event streams", async () => {
	const dave = await createUser(db, { username: "dave", kind: "member", password: PASSWORD });
	const daveCookie = await login(app, "dave", PASSWORD);
	const s = await newSession(alice, "stream disable", "yolo");
	expect((await share(s.id, alice, { granteeType: "user", granteeId: dave.id, access: "view" })).status).toBe(200);
	const reader = await openEventStream(s.id, daveCookie);
	const disabled = await call(app, `/api/users/${dave.id}`, {
		method: "PATCH",
		cookie: admin,
		body: { status: "disabled" },
	});
	expect(disabled.status).toBe(200);
	expect(await streamClosed(reader)).toBe(true);
	await reader.cancel();
	expect((await get(s.id, daveCookie)).status).toBe(401);
});

it("demoting an administrator ends the session streams they saw as an administrator", async () => {
	const eve = await createUser(db, { username: "eve", kind: "admin", password: PASSWORD });
	await login(app, "eve", PASSWORD);
	const eveCookie = await login(app, "eve", PASSWORD);
	const s = await newSession(alice, "stream demotion", "yolo");
	// Administrators see every session they are not shared, so the stream is open without a share.
	const reader = await openEventStream(s.id, eveCookie);
	const demoted = await call(app, `/api/users/${eve.id}`, {
		method: "PATCH",
		cookie: admin,
		body: { kind: "member" },
	});
	expect(demoted.status).toBe(200);
	expect(await streamClosed(reader)).toBe(true);
	await reader.cancel();
});

it("leaving a user group ends the streams its shares reached", async () => {
	const s = await newSession(alice, "stream group removal", "yolo");
	expect((await share(s.id, alice, { granteeType: "user_group", granteeId: groupId, access: "view" })).status).toBe(
		200,
	);
	const reader = await openEventStream(s.id, bob);
	const removed = await call(app, `/api/user-groups/${groupId}/members/${bobId}`, {
		method: "DELETE",
		cookie: admin,
		body: {},
	});
	expect(removed.status).toBe(200);
	expect(await streamClosed(reader)).toBe(true);
	await reader.cancel();
});

it("deleting a user group ends the streams its shares reached", async () => {
	const temp = await createUserGroup(db, "temp-share");
	const carolCookie = await login(app, "carol", PASSWORD);
	await call(app, `/api/user-groups/${temp.id}/members/${carolId}`, { method: "PUT", cookie: admin, body: {} });
	const s = await newSession(alice, "stream group deletion", "yolo");
	expect((await share(s.id, alice, { granteeType: "user_group", granteeId: temp.id, access: "view" })).status).toBe(
		200,
	);
	const reader = await openEventStream(s.id, carolCookie);
	const deleted = await call(app, `/api/user-groups/${temp.id}`, { method: "DELETE", cookie: admin, body: {} });
	expect(deleted.status).toBe(200);
	expect(await streamClosed(reader)).toBe(true);
	await reader.cancel();
});
