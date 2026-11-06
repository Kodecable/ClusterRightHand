import type { TaskSpec } from "@crh/protocol";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApiToken } from "../src/auth/api-tokens.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import { MAX_GROUP_NODES, TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const LIMIT_MESSAGE = "task group targets 513 nodes (max 512); split it into smaller batches";

/** 513 active nodes: group `first` has the first 512, group `all` has every node (D85's boundary). */
async function addNodes(
	db: Db,
	ownerUserId: string,
): Promise<{ ids: string[]; first512: string[]; allGroupId: string; firstGroupId: string }> {
	const orgId = await defaultOrgId(db);
	const now = new Date().toISOString();
	const ids: string[] = [];
	const rows = [];
	const allGroupId = newId();
	const firstGroupId = newId();
	const memberRows: { node_group_id: string; node_id: string }[] = [];
	for (let i = 0; i <= MAX_GROUP_NODES; i++) {
		const id = newId();
		const name = `node-${i}`;
		ids.push(id);
		rows.push({
			id,
			org_id: orgId,
			name,
			name_key: name.toLowerCase(),
			transport: "client" as const,
			status: "active" as const,
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
		});
		memberRows.push({ node_group_id: allGroupId, node_id: id });
		if (i < MAX_GROUP_NODES) memberRows.push({ node_group_id: firstGroupId, node_id: id });
	}
	// Chunked inserts keep the parameter count below SQLite's limits; the whole set is a handful of statements.
	for (let i = 0; i < rows.length; i += 40)
		await db
			.insertInto("nodes")
			.values(rows.slice(i, i + 40))
			.execute();
	await db
		.insertInto("node_access_grants")
		.values({
			id: newId(),
			org_id: orgId,
			grantee_type: "user",
			grantee_id: ownerUserId,
			target_type: "node_group",
			target_id: allGroupId,
			created_by_user_id: ownerUserId,
			created_at: now,
		})
		.execute();
	await db
		.insertInto("node_groups")
		.values([
			{ id: allGroupId, org_id: orgId, name: "all", name_key: "all", created_at: now, updated_at: now },
			{ id: firstGroupId, org_id: orgId, name: "first", name_key: "first", created_at: now, updated_at: now },
		])
		.execute();
	for (let i = 0; i < memberRows.length; i += 250) {
		await db
			.insertInto("node_group_members")
			.values(memberRows.slice(i, i + 250))
			.execute();
	}
	return { ids, first512: ids.slice(0, MAX_GROUP_NODES), allGroupId, firstGroupId };
}

describeBackends("task group node limit", (backend) => {
	let db: Db;
	let user: SessionUser;
	let nodeIds: string[];
	let first512: string[];
	let allGroupId: string;
	let firstGroupId: string;
	let groups: TaskGroups;
	/** Counts dispatches: the rejected groups must never reach the cluster. */
	let dispatched: number;
	let app: App;
	let cookie: string;
	let token: string;

	const spec = (): TaskSpec => ({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null });
	const actor = () => ({ type: "user" as const, id: user.userId, onBehalfOfUserId: user.userId });

	beforeEach(async () => {
		db = await openTestDb(backend);
		const u = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		user = { sessionId: "s", userId: u.id, username: u.username, kind: "member" };
		({ ids: nodeIds, first512, allGroupId, firstGroupId } = await addNodes(db, user.userId));
		dispatched = 0;
		const stub = (nodeId: string): TaskView =>
			({ id: `task-${nodeId}`, nodeId, state: "exited", exitCode: 0 }) as TaskView;
		// Dispatch is not what this limit is about; a stub keeps 512-node groups cheap and DB-free.
		const cluster = {
			createTask: async (input: { nodeId: string }) => {
				dispatched++;
				return stub(input.nodeId);
			},
			waitTask: async (id: string) => stub(id),
			// The stub keeps nothing, so a group view has no member rows to read.
			groupTasks: async () => [],
			releaseGroupBudget: () => false,
		} as unknown as Cluster;
		groups = new TaskGroups(db, cluster);
		app = makeApp(db, undefined, { cluster, taskGroups: groups });
		cookie = await login(app, "alice", "password-123");
		token = (await createApiToken(db, user, { name: "limit", rulePreset: "yolo" })).token;
	});
	afterEach(async () => {
		await db.destroy();
	});

	async function persisted(table: "task_groups" | "tasks"): Promise<number> {
		return (await db.selectFrom(table).select("id").execute()).length;
	}

	it("rejects 513 node ids passed straight to TaskGroups.create, before anything is written", async () => {
		await expect(groups.create({ targets: [allGroupId], nodeIds, spec: spec(), actor: actor() })).rejects.toThrow(
			LIMIT_MESSAGE,
		);
		expect(dispatched).toBe(0);
		expect(await persisted("task_groups")).toBe(0);
		expect(await persisted("tasks")).toBe(0);
	});

	it("counts duplicate node ids once: 512 ids given twice is accepted", async () => {
		const id = await groups.create({
			targets: [firstGroupId],
			nodeIds: [...first512, ...first512],
			spec: spec(),
			actor: actor(),
		});
		const view = await groups.wait(id, 5000);
		expect(view?.nodeIds).toHaveLength(512);
		expect(new Set(view?.nodeIds).size).toBe(512);
		expect(dispatched).toBe(512);
	});

	it("rejects 513 nodes through the Web API with 400 and persists nothing", async () => {
		const res = await call(app, "/api/task-groups", {
			cookie,
			body: { kind: "exec", shell: "true", targets: [allGroupId], waitMs: 0 },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: LIMIT_MESSAGE });
		expect(dispatched).toBe(0);
		expect(await persisted("task_groups")).toBe(0);
		expect(await persisted("tasks")).toBe(0);
		const audits = await db
			.selectFrom("audit_events")
			.select("action")
			.where("action", "=", "task_group.created")
			.execute();
		expect(audits).toEqual([]);
	});

	it("accepts 512 nodes, counting overlapping targets once, through the Web API", async () => {
		const res = await call(app, "/api/task-groups", {
			cookie,
			body: {
				kind: "exec",
				shell: "true",
				// node-0 is in group first, so the two targets overlap: the union is exactly 512 nodes.
				targets: ["first", "node-0"],
				waitMs: 60000,
			},
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { taskGroup: { nodeIds: string[]; state: string } };
		expect(body.taskGroup.nodeIds).toHaveLength(512);
		expect(new Set(body.taskGroup.nodeIds).size).toBe(512);
		expect(body.taskGroup.state).toBe("finished");
		expect(dispatched).toBe(512);
	});

	it("returns the over-limit error text to the model through MCP", async () => {
		const client = new Client({ name: "crh-test", version: "0.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL("http://crh.test/mcp"), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
			// In-process MCP: the Hono app is the network, so no server or node is needed.
			fetch: async (input, init) => await app.request(new Request(input, init)),
		});
		await client.connect(transport);
		try {
			const res = await client.callTool({
				name: "exec",
				arguments: { targets: [allGroupId], cmd: "true" },
			});
			expect(res.isError).toBe(true);
			expect((res.content as { type: string; text: string }[])[0]?.text).toBe(
				`[error invalid_argument: ${LIMIT_MESSAGE}]`,
			);
		} finally {
			await client.close();
		}
		expect(dispatched).toBe(0);
		expect(await persisted("task_groups")).toBe(0);
		expect(await persisted("tasks")).toBe(0);
	});
});
