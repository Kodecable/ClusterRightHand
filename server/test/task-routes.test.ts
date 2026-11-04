import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { createNodeGroup, setNodeGroupsForNode } from "../src/cluster/node-groups.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe("task routes: privileged (sqlite)", () => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let groups: TaskGroups;
	let audit: Audit;
	let cookie = "";
	let userId = "";
	let nodeId = "";
	let groupId = "";

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		groups = new TaskGroups(db, cluster, { audit });
		app = makeApp(db, undefined, { cluster, taskGroups: groups, audit });
		const user = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		userId = user.id;
		cookie = await login(app, "alice", "password-123");
		nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				owner_user_id: userId,
				name: "n1",
				name_key: "n1",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "n1",
				facts: null,
				client_version: null,
				privileged_mode: "reject",
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
		groupId = (await createNodeGroup(db, await defaultOrgId(db), "workers")).id;
		await setNodeGroupsForNode(db, nodeId, [groupId]);
	});
	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	const post = (path: string, body: unknown) => call(app, path, { cookie, body });

	it("accepts privileged for a single task and records it", async () => {
		const res = await post(`/api/nodes/${nodeId}/tasks`, {
			kind: "exec",
			argv: ["true"],
			privileged: true,
			waitMs: 5000,
		});
		expect(res.status).toBe(201);
		const { task } = (await res.json()) as { task: TaskView };
		expect(task.privileged).toBe(true);
		// The node is not connected: nothing ran, but the task exists with its flag.
		expect(task.state).toBe("failed");
		expect(task.errorCode).toBe("node_offline");
		const fetched = (await (await call(app, `/api/tasks/${task.id}`, { cookie })).json()) as { task: TaskView };
		expect(fetched.task.privileged).toBe(true);
	});

	it("accepts privileged for a task group and gives it to every task", async () => {
		const res = await post("/api/task-groups", {
			kind: "exec",
			argv: ["true"],
			privileged: true,
			targets: ["n1"],
			waitMs: 5000,
		});
		expect(res.status).toBe(201);
		const { taskGroup } = (await res.json()) as { taskGroup: TaskGroupView };
		expect(taskGroup.privileged).toBe(true);
		expect(taskGroup.tasks).toHaveLength(1);
		expect(taskGroup.tasks[0]).toMatchObject({ privileged: true, state: "failed", errorCode: "node_offline" });
		const row = await db
			.selectFrom("task_groups")
			.select("privileged")
			.where("id", "=", taskGroup.id)
			.executeTakeFirstOrThrow();
		expect(row.privileged).toBe(1);
	});

	it("stores group targets as UUIDs and returns their display names", async () => {
		const res = await post("/api/task-groups", {
			kind: "exec",
			argv: ["true"],
			targets: ["WORKERS"],
			waitMs: 5000,
		});
		expect(res.status).toBe(201);
		const { taskGroup } = (await res.json()) as { taskGroup: TaskGroupView };
		expect(taskGroup.targets).toEqual([groupId]);
		expect(taskGroup.refs).toEqual({ [groupId]: { kind: "node_group", name: "workers" } });
		const row = await db
			.selectFrom("task_groups")
			.select("targets")
			.where("id", "=", taskGroup.id)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.targets)).toEqual([groupId]);
	});

	it("defaults to an ordinary task", async () => {
		const res = await post(`/api/nodes/${nodeId}/tasks`, { kind: "exec", argv: ["true"], waitMs: 5000 });
		expect(res.status).toBe(201);
		const { task } = (await res.json()) as { task: TaskView };
		expect(task.privileged).toBe(false);
	});

	it("rejects a non-boolean flag instead of ignoring it", async () => {
		for (const path of [`/api/nodes/${nodeId}/tasks`, "/api/task-groups"]) {
			const res = await post(path, { kind: "exec", argv: ["true"], targets: ["n1"], privileged: "yes" });
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe("privileged must be a boolean");
		}
	});

	it("records the flag in the task.created audit event", async () => {
		const res = await post(`/api/nodes/${nodeId}/tasks`, {
			kind: "exec",
			argv: ["true"],
			privileged: true,
			waitMs: 5000,
		});
		const { task } = (await res.json()) as { task: TaskView };
		await audit.flush();
		const events = await call(app, `/api/audit?action=task.created&targetId=${task.id}`, { cookie });
		const { items: list } = (await events.json()) as { items: { detail: Record<string, unknown> }[] };
		expect(list[0]?.detail.privileged).toBe(true);
	});
});
