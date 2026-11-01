import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster, summarize } from "../src/cluster/cluster.ts";
import { GROUP_INTERRUPTED_REASON, outputModeFor, resolveTargets, TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

describeBackends("task groups", (backend) => {
	let db: Db;
	let user: SessionUser;
	let cluster: Cluster;
	const ids: Record<string, string> = {};

	async function addNode(name: string, groups: string[], status: "active" | "pending" = "active") {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				owner_user_id: user.userId,
				name,
				transport: "client",
				status,
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
			})
			.execute();
		for (const g of groups) {
			await db.insertInto("node_groups").values({ node_id: id, group_name: g, refreshed_at: now }).execute();
		}
		ids[name] = id;
	}

	beforeEach(async () => {
		db = await openTestDb(backend);
		const u = await createUser(db, { username: "alice", kind: "member" });
		user = { sessionId: "s", userId: u.id, username: u.username, kind: "member" };
		cluster = new Cluster(db);
		await addNode("web-1", ["web", "prod"]);
		await addNode("web-2", ["web"]);
		await addNode("db-1", ["prod"]);
		await addNode("new-1", ["web"], "pending");
	});
	afterEach(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("resolves names and groups to active nodes the user can operate", async () => {
		const resolved = await resolveTargets(db, user, ["group:web", "db-1"]);
		expect(new Set(resolved)).toEqual(new Set([ids["web-1"], ids["web-2"], ids["db-1"]]));
		await expect(resolveTargets(db, user, ["nope"])).rejects.toThrow(/no node nope/);
		await expect(resolveTargets(db, user, ["group:empty"])).rejects.toThrow(/match no node/);
		await expect(resolveTargets(db, user, [])).rejects.toThrow(/empty/);
		const stranger = await createUser(db, { username: "bob", kind: "member" });
		await expect(
			resolveTargets(db, { sessionId: "s", userId: stranger.id, username: "bob", kind: "member" }, ["web-1"]),
		).rejects.toThrow();
	});

	const spec = (): TaskSpec => ({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null });
	const readSpec = (): TaskSpec => ({ kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 10 });
	const actor = () => ({ type: "user" as const, id: user.userId, onBehalfOfUserId: user.userId });

	it("describes a read by the lines it asks for", () => {
		// The summary is what the approval pages and the task lists show, so the range is visible there.
		expect(
			summarize(JSON.stringify({ kind: "file.read", path: "/var/log/app.log", startLine: 10, lineCount: 50 })),
		).toBe("/var/log/app.log (lines 10-59)");
		expect(summarize(JSON.stringify({ kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 1 }))).toBe(
			"/etc/hosts (lines 1-1)",
		);
		expect(summarize(JSON.stringify({ kind: "file.stat", path: "/etc/hosts" }))).toBe("/etc/hosts");
	});

	it("derives the output mode from the task kind", () => {
		// exec chooses status or text; file operations always keep each node's head.
		expect(outputModeFor("exec")).toBe("status");
		expect(outputModeFor("exec", "text")).toBe("text");
		expect(outputModeFor("exec", "status")).toBe("status");
		expect(() => outputModeFor("exec", "head")).toThrow(/status.*text/);
		expect(outputModeFor("file.read")).toBe("head");
		expect(outputModeFor("file.list", "head")).toBe("head");
		expect(() => outputModeFor("file.read", "status")).toThrow(/head/);
	});

	it("stores the derived mode on the group and its tasks", async () => {
		const groups = new TaskGroups(db, cluster);
		const execId = await groups.create({
			targets: ["x"],
			nodeIds: [ids["web-1"] as string],
			spec: spec(),
			actor: actor(),
		});
		expect((await groups.get(execId))?.outputMode).toBe("status");
		const readId = await groups.create({
			targets: ["x"],
			nodeIds: [ids["web-1"] as string],
			spec: readSpec(),
			actor: actor(),
		});
		// The members are created asynchronously, so wait for the group to settle before reading them.
		const view = await groups.wait(readId, 5000);
		expect(view?.outputMode).toBe("head");
		expect(view?.tasks.map((t) => t.outputMode)).toEqual(["head"]);
		await expect(
			groups.create({
				targets: ["x"],
				nodeIds: [ids["web-1"] as string],
				spec: readSpec(),
				actor: actor(),
				outputMode: "text",
			}),
		).rejects.toThrow(/head/);
	});

	it("runs one task per node; offline nodes fail with node_offline", async () => {
		const groups = new TaskGroups(db, cluster);
		const nodeIds = [ids["web-1"], ids["web-2"], ids["db-1"]] as string[];
		const id = await groups.create({
			targets: ["group:web", "db-1"],
			nodeIds,
			spec: spec(),
			actor: actor(),
			parallel: 2,
		});
		const view = await groups.wait(id, 5000);
		expect(view?.state).toBe("finished");
		expect(view?.tasks.map((t) => t.nodeId).sort()).toEqual([...nodeIds].sort());
		expect(view?.tasks.every((t) => t.state === "failed" && t.errorCode === "node_offline")).toBe(true);
		expect(view?.skipped).toEqual([]);
	});

	it("stops launching after a failure with failFast", async () => {
		const groups = new TaskGroups(db, cluster);
		const nodeIds = [ids["web-1"], ids["web-2"], ids["db-1"]] as string[];
		const id = await groups.create({
			targets: ["x"],
			nodeIds,
			spec: spec(),
			actor: actor(),
			parallel: 1,
			failFast: true,
		});
		const view = await groups.wait(id, 5000);
		expect(view?.tasks).toHaveLength(1);
		expect(view?.skipped).toHaveLength(2);
	});

	it("marks groups left running by a previous process as interrupted", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("task_groups")
			.values({
				id: "g1",
				org_id: await defaultOrgId(db),
				targets: "[]",
				node_ids: JSON.stringify([ids["web-1"], ids["web-2"]]),
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "text",
				privileged: 0,
				skipped: "[]",
				state: "running",
				actor_type: "user",
				actor_id: user.userId,
				on_behalf_of_user_id: user.userId,
				created_at: now,
				finished_at: null,
			})
			.execute();
		const groups = new TaskGroups(db, cluster);
		await groups.recover();
		const view = await groups.get("g1");
		expect(view?.state).toBe("interrupted");
		expect(view?.skipped.sort()).toEqual([ids["web-1"], ids["web-2"]].sort());
	});

	/** Inserts a task row as a previous process would have left it. */
	const insertTask = async (input: {
		group: string;
		nodeId: string;
		state: "awaiting_approval" | "awaiting_authorization";
	}): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: await defaultOrgId(db),
				node_id: input.nodeId,
				task_group_id: input.group,
				kind: "exec",
				spec: JSON.stringify({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null }),
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "text",
				state: input.state,
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: user.userId,
				on_behalf_of_user_id: user.userId,
				created_at: now,
				dispatched_at: null,
				accepted_at: null,
				finished_at: null,
				stdout_bytes: 0,
				stderr_bytes: 0,
				stdout_head: null,
				stdout_tail: null,
				stderr_head: null,
				stderr_tail: null,
				output_file: null,
				late_result: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: "user",
				handler_session_id: null,
			})
			.execute();
		return id;
	};

	it("cancels the members of an interrupted group that never started", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("task_groups")
			.values({
				id: "g2",
				org_id: await defaultOrgId(db),
				targets: "[]",
				node_ids: JSON.stringify([ids["web-1"], ids["web-2"]]),
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "text",
				privileged: 0,
				skipped: "[]",
				state: "awaiting_authorization",
				actor_type: "user",
				actor_id: user.userId,
				on_behalf_of_user_id: user.userId,
				created_at: now,
				finished_at: null,
			})
			.execute();
		// One member waits for its signature; the other node never got a task.
		await insertTask({ group: "g2", nodeId: ids["web-1"] as string, state: "awaiting_authorization" });

		const groups = new TaskGroups(db, cluster);
		await groups.recover();
		const view = await groups.get("g2");
		expect(view?.state).toBe("interrupted");
		expect(view?.skipped).toEqual([ids["web-2"]]);
		// The waiting member can no longer start once its signature arrives, so it ends now.
		expect(view?.tasks[0]).toMatchObject({
			state: "rejected",
			errorCode: "cancelled",
			errorMessage: GROUP_INTERRUPTED_REASON,
			cancelled: true,
		});
	});
});
