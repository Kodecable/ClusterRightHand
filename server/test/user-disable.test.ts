import type { Insertable } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import { userCanAccessNode } from "../src/cluster/node-access.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { TaskGroupsTable, TasksTable } from "../src/storage/schema.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Disabling a user ends the work they left waiting (doc/design/access-control.md "User types"). */
describe("disabling a user", () => {
	let db: Db;
	let cluster: Cluster;
	let taskGroups: TaskGroups;
	let app: App;
	let adminCookie: string;
	let userId: string;
	let nodeId: string;
	let taskId: string;
	let groupId: string;

	const insertTask = async (): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: await defaultOrgId(db),
				node_id: nodeId,
				task_group_id: null,
				kind: "exec",
				spec: JSON.stringify({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null }),
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "text",
				state: "awaiting_approval",
				exit_code: null,
				signal: null,
				timed_out: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: userId,
				on_behalf_of_user_id: userId,
				created_at: now,
				dispatched_at: null,
				accepted_at: null,
				finished_at: null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_file: null,
				late_result: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: "user",
				handler_session_id: null,
			} satisfies Insertable<TasksTable>)
			.execute();
		return id;
	};

	const insertGroup = async (): Promise<string> => {
		const id = newId();
		await db
			.insertInto("task_groups")
			.values({
				id,
				org_id: await defaultOrgId(db),
				targets: "[]",
				node_ids: JSON.stringify([nodeId]),
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "text",
				privileged: 0,
				skipped: "[]",
				state: "awaiting_authorization",
				actor_type: "user",
				actor_id: userId,
				on_behalf_of_user_id: userId,
				created_at: new Date().toISOString(),
				finished_at: null,
			} satisfies Insertable<TaskGroupsTable>)
			.execute();
		return id;
	};

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { nodeOfflineGraceMs: 10 });
		taskGroups = new TaskGroups(db, cluster);
		app = makeApp(db, undefined, { cluster, taskGroups });
		await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		adminCookie = await login(app, "root", "root-password");
		userId = (await createUser(db, { username: "alice", kind: "member", password: "alice-password" })).id;

		nodeId = newId();
		const now = new Date().toISOString();
		const orgId = await defaultOrgId(db);
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: orgId,
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
				ssh_host_fingerprint: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: orgId,
				grantee_type: "user",
				grantee_id: userId,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: userId,
				created_at: now,
			})
			.execute();

		taskId = await insertTask();
		groupId = await insertGroup();
	});

	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("cancels the user's waiting work and takes away their node access", async () => {
		expect(await userCanAccessNode(db, userId, nodeId)).toBe(true);

		const res = await call(app, `/api/users/${userId}`, {
			method: "PATCH",
			cookie: adminCookie,
			body: { status: "disabled" },
		});
		expect(res.status).toBe(200);

		const task = await db
			.selectFrom("tasks")
			.select(["state", "error_message"])
			.where("id", "=", taskId)
			.executeTakeFirstOrThrow();
		expect(task).toMatchObject({ state: "cancelled", error_message: "the user was disabled" });
		const group = await db
			.selectFrom("task_groups")
			.select(["state", "finished_at"])
			.where("id", "=", groupId)
			.executeTakeFirstOrThrow();
		expect(group.state).toBe("cancelled");
		expect(group.finished_at).not.toBeNull();

		expect(await userCanAccessNode(db, userId, nodeId)).toBe(false);
	});
});
