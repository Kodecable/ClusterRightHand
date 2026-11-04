import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiToken } from "../src/auth/api-tokens.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

/**
 * Task visibility (D108, doc/access-control.md): only the user's relation to the task matters. Administrators
 * see all, the on_behalf_of user keeps seeing their task after losing node access, session-sharing viewers see
 * the session's tasks, and node access never reveals another user's task.
 */
describe("task visibility (sqlite)", () => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let groups: TaskGroups;
	let aliceId: string;
	let bobId: string;
	let aliceCookie: string;
	let bobCookie: string;
	let rootCookie: string;
	let nodeId: string;

	const spec: TaskSpec = { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null };

	const addNode = async (): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name: "web-1",
				name_key: "web-1",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "web-1",
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

	const grant = async (userId: string, targetId = nodeId): Promise<void> => {
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: userId,
				target_type: "node",
				target_id: targetId,
				created_by_user_id: userId,
				created_at: new Date().toISOString(),
			})
			.execute();
	};

	const makeTask = (actor: { type: "user" | "session"; id: string; onBehalfOfUserId: string }) =>
		cluster.createTask({ nodeId, spec, actor });

	const getTask = async (cookie: string, id: string) => {
		const res = await call(app, `/api/tasks/${id}`, { cookie });
		return { status: res.status, body: (await res.json()) as { task?: TaskView } };
	};

	const listTasks = async (cookie: string) => {
		const res = await call(app, "/api/tasks", { cookie });
		return (await res.json()) as { items: TaskView[] };
	};

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db);
		groups = new TaskGroups(db, cluster, {});
		app = makeApp(db, undefined, { cluster, taskGroups: groups });
		const alice = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		const bob = await createUser(db, { username: "bob", kind: "member", password: "password-123" });
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		aliceId = alice.id;
		bobId = bob.id;
		aliceCookie = await login(app, "alice", "password-123");
		bobCookie = await login(app, "bob", "password-123");
		rootCookie = await login(app, "root", "password-123");
		nodeId = await addNode();
		await grant(aliceId);
		await grant(bobId);
	});
	afterEach(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("shows the owner's task after the node grant is removed, and never another user's task", async () => {
		const task = await makeTask({ type: "user", id: aliceId, onBehalfOfUserId: aliceId });
		expect((await getTask(aliceCookie, task.id)).status).toBe(200);
		// bob may access the same node, but that says nothing about alice's task.
		expect((await getTask(bobCookie, task.id)).status).toBe(404);
		expect((await listTasks(bobCookie)).items.map((t) => t.id)).not.toContain(task.id);
		expect((await listTasks(rootCookie)).items.map((t) => t.id)).toContain(task.id);

		await db.deleteFrom("node_access_grants").where("grantee_id", "=", aliceId).execute();
		const after = await getTask(aliceCookie, task.id);
		expect(after.status).toBe(200);
		expect(after.body.task?.id).toBe(task.id);
		expect((await listTasks(aliceCookie)).items.map((t) => t.id)).toContain(task.id);
	});

	it("shows a session's task to a user the session is shared with", async () => {
		const sessionId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("sessions")
			.values({
				id: sessionId,
				org_id: await defaultOrgId(db),
				owner_user_id: aliceId,
				conversation_id: `conv-${sessionId}`,
				parent_session_id: null,
				root_session_id: sessionId,
				title: "shared",
				model: JSON.stringify({ provider: "faux", modelId: "faux" }),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				quota_tokens: null,
				state: "idle",
				state_changed_at: now,
			})
			.execute();
		await db
			.insertInto("shares")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				resource_type: "session",
				resource_id: sessionId,
				grantee_type: "user",
				grantee_id: bobId,
				access: "view",
				created_by_user_id: aliceId,
				created_at: now,
			})
			.execute();
		const task = await makeTask({ type: "session", id: sessionId, onBehalfOfUserId: aliceId });
		expect((await getTask(bobCookie, task.id)).status).toBe(200);
		// The shared session reaches the task by id; the global list stays the "(a)/(b)" list.
		expect((await listTasks(bobCookie)).items.map((t) => t.id)).not.toContain(task.id);
		expect((await getTask(aliceCookie, task.id)).status).toBe(200);
	});

	it("cancels as the owner, not as another user with node access", async () => {
		const task = await makeTask({ type: "user", id: aliceId, onBehalfOfUserId: aliceId });
		const res = await call(app, `/api/tasks/${task.id}/cancel`, { cookie: aliceCookie, body: {} });
		expect(res.status).toBe(200);
		expect((await getTask(bobCookie, task.id)).status).toBe(404);
	});

	it("ends a task waiting for approval with node_access_revoked when the grant is removed", async () => {
		const alice = { sessionId: "s", userId: aliceId, username: "alice", kind: "member" as const };
		const { view: token } = await createApiToken(db, alice, { name: "t", preset: "ask" });
		const task = await cluster.createTask({
			nodeId,
			spec,
			chain: [{ type: "api_token", id: token.id }],
			actor: { type: "api_token", id: token.id, onBehalfOfUserId: aliceId },
		});
		expect(task.state).toBe("awaiting_approval");
		await db.deleteFrom("node_access_grants").where("grantee_id", "=", aliceId).execute();
		await cluster.decide(task.id, {
			decision: "approved",
			by: { type: "user", id: aliceId, onBehalfOfUserId: aliceId },
			at: new Date().toISOString(),
		});
		const after = (await cluster.getTask(task.id)) as TaskView;
		expect(after.state).toBe("failed");
		expect(after.errorCode).toBe("node_access_revoked");
		expect(after.errorMessage).toMatch(/access to the node was revoked/);
	});
});
