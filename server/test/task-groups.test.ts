import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster, summarize } from "../src/cluster/cluster.ts";
import { GROUP_INTERRUPTED_REASON, outputModeFor, resolveTargets, TaskGroups } from "../src/cluster/task-groups.ts";
import { taskStartOf } from "../src/cluster/task-start.ts";
import type { Rule, RulePreset } from "../src/policy/rules.ts";
import { createRootRuleSet, setRules } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { waitFor } from "./helpers/agent.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";
import { probeDb, tableOf } from "./helpers/db-probe.ts";

describeBackends("task groups", (backend) => {
	let db: Db;
	let user: SessionUser;
	let cluster: Cluster;
	const ids: Record<string, string> = {};

	async function addNode(name: string, groups: string[], status: "active" | "pending" = "active") {
		const id = newId();
		const now = new Date().toISOString();
		const orgId = await defaultOrgId(db);
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
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
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: orgId,
				grantee_type: "user",
				grantee_id: user.userId,
				target_type: "node",
				target_id: id,
				created_by_user_id: user.userId,
				created_at: now,
			})
			.execute();
		for (const g of groups) {
			let group = await db
				.selectFrom("node_groups")
				.select("id")
				.where("org_id", "=", orgId)
				.where("name_key", "=", g)
				.executeTakeFirst();
			if (!group) {
				group = { id: newId() };
				await db
					.insertInto("node_groups")
					.values({ id: group.id, org_id: orgId, name: g, name_key: g, created_at: now, updated_at: now })
					.execute();
			}
			await db.insertInto("node_group_members").values({ node_group_id: group.id, node_id: id }).execute();
		}
		ids[name] = id;
	}

	async function addEmptyGroup(name: string): Promise<string> {
		const now = new Date().toISOString();
		const id = newId();
		await db
			.insertInto("node_groups")
			.values({ id, org_id: await defaultOrgId(db), name, name_key: name, created_at: now, updated_at: now })
			.execute();
		return id;
	}

	beforeEach(async () => {
		db = await openTestDb(backend);
		const u = await createUser(db, { username: "alice", kind: "member" });
		user = { sessionId: "s", userId: u.id, username: u.username, kind: "member" };
		cluster = new Cluster(db, { nodeOfflineGraceMs: 10 });
		await addNode("web-1", ["web", "prod"]);
		await addNode("web-2", ["web"]);
		await addNode("db-1", ["prod"]);
		await addNode("new-1", ["web"], "pending");
	});
	afterEach(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("resolves names, UUIDs and _all to active nodes the user can operate", async () => {
		const resolved = await resolveTargets(db, user, ["web", "db-1"]);
		expect(new Set(resolved.nodeIds)).toEqual(new Set([ids["web-1"], ids["web-2"], ids["db-1"]]));
		expect(resolved.singleNode).toBe(false);
		// The stored references are the group's UUID and the node's UUID, not the input names.
		const webGroup = await db
			.selectFrom("node_groups")
			.select("id")
			.where("name_key", "=", "web")
			.executeTakeFirstOrThrow();
		expect(resolved.targets).toEqual([webGroup.id, ids["db-1"]]);

		const one = await resolveTargets(db, user, ["Web-1"]);
		expect(one).toMatchObject({ targets: [ids["web-1"]], nodeIds: [ids["web-1"]], singleNode: true });

		const all = await resolveTargets(db, user, ["_all"]);
		expect(new Set(all.nodeIds)).toEqual(new Set([ids["web-1"], ids["web-2"], ids["db-1"]]));
		expect(all.singleNode).toBe(false);
		expect(all.targets).toEqual(["_all"]);

		await addEmptyGroup("empty");
		await expect(resolveTargets(db, user, ["nope"])).rejects.toThrow(/no node or node group nope/);
		await expect(resolveTargets(db, user, ["empty"])).rejects.toThrow(/match no node/);
		await expect(resolveTargets(db, user, [])).rejects.toThrow(/empty/);
		const stranger = await createUser(db, { username: "bob", kind: "member" });
		await expect(
			resolveTargets(db, { sessionId: "s", userId: stranger.id, username: "bob", kind: "member" }, ["web-1"]),
		).rejects.toThrow();
	});

	const spec = (): TaskSpec => ({ kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null });
	const readSpec = (): TaskSpec => ({ kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 10 });
	const actor = () => ({ type: "user" as const, id: user.userId, onBehalfOfUserId: user.userId });

	/** An API token's rule chain, with the preset and rules a task group is judged by. */
	async function addChain(preset: RulePreset, rules: Rule[] = []) {
		const tokenId = newId();
		await db
			.insertInto("api_tokens")
			.values({
				id: tokenId,
				org_id: await defaultOrgId(db),
				user_id: user.userId,
				name: "group chain",
				token_hash: newId(),
				created_at: new Date().toISOString(),
				expires_at: null,
				revoked_at: null,
				last_used_at: null,
			})
			.execute();
		const ref = { type: "api_token" as const, id: tokenId };
		await createRootRuleSet(db, await defaultOrgId(db), ref, preset, rules);
		return ref;
	}

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
			targets: [ids["web-1"] as string],
			nodeIds: [ids["web-1"] as string],
			spec: spec(),
			actor: actor(),
		});
		expect((await groups.get(execId))?.outputMode).toBe("status");
		const readId = await groups.create({
			targets: [ids["web-1"] as string],
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
				targets: [ids["web-1"] as string],
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
			targets: [ids["web-1"] as string, ids["db-1"] as string],
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

	it("gives every member the group's timeout", async () => {
		const groups = new TaskGroups(db, cluster);
		const id = await groups.create({
			targets: [ids["web-1"] as string],
			nodeIds: [ids["web-1"], ids["web-2"]] as string[],
			spec: spec(),
			actor: actor(),
			timeoutMs: 30_000,
		});
		const view = await groups.wait(id, 5000);
		expect(view?.tasks.map((task) => task.timeoutMs)).toEqual([30_000, 30_000]);
		// task.start takes the timeout from the member's row, the same value the single-task path sends.
		const rows = await db.selectFrom("tasks").selectAll().where("task_group_id", "=", id).execute();
		expect(rows.map((row) => taskStartOf(row.id, row, spec(), { privileged: false }).timeoutMs)).toEqual([
			30_000, 30_000,
		]);
	});

	it("stops launching after a failure with failFast", async () => {
		const groups = new TaskGroups(db, cluster);
		const nodeIds = [ids["web-1"], ids["web-2"], ids["db-1"]] as string[];
		const id = await groups.create({
			targets: [ids["web-1"] as string],
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

	it("cancels a group's workers so no later member is created", async () => {
		// Long enough that the two members stay in the dispatch window while the test cancels them; a short
		// grace would let the workers finish their nodes and take the next ones before cancel() is called.
		const slow = new Cluster(db, { nodeOfflineGraceMs: 500 });
		const groups = new TaskGroups(db, slow);
		try {
			const nodeIds: string[] = [];
			for (let i = 0; i < 10; i++) {
				await addNode(`cancel-${i}`, []);
				nodeIds.push(ids[`cancel-${i}`] as string);
			}
			const id = await groups.create({
				targets: [nodeIds[0] as string],
				nodeIds,
				spec: spec(),
				actor: actor(),
				parallel: 2,
			});
			const count = async () => {
				const row = await db
					.selectFrom("tasks")
					.select((eb) => eb.fn.countAll().as("n"))
					.where("task_group_id", "=", id)
					.executeTakeFirstOrThrow();
				return Number(row.n);
			};
			await waitFor("the first two members", async () => (await count()) >= 2);
			expect(await groups.cancel(id, "the user stopped the batch")).toBe(true);
			const view = await groups.wait(id, 5000);
			expect(view?.state).toBe("cancelled");
			// Only the two members the workers had started exist; the other eight were never created.
			expect(view?.tasks).toHaveLength(2);
			expect(view?.skipped.sort()).toEqual(nodeIds.slice(2).sort());
			expect(view?.tasks.every((task) => task.state === "rejected" && task.errorCode === "cancelled")).toBe(true);
		} finally {
			await slow.close();
		}
	});

	it("stops the other workers when one throws", async () => {
		const probe = probeDb(db);
		const probedCluster = new Cluster(probe.db, { nodeOfflineGraceMs: 10 });
		const probedGroups = new TaskGroups(probe.db, probedCluster);
		try {
			const nodeIds: string[] = [];
			for (let i = 0; i < 8; i++) {
				await addNode(`throw-${i}`, []);
				nodeIds.push(ids[`throw-${i}`] as string);
			}
			const groupId = "group-worker-throw";
			// The second id lookup of the batch throws: one worker fails while the other is still in flight.
			let reads = 0;
			probe.onNext(
				(node) => tableOf(node) === "tasks" && ++reads === 2,
				() => {
					throw new Error("injected worker failure");
				},
			);
			await probedGroups.create({
				id: groupId,
				targets: [nodeIds[0] as string],
				nodeIds,
				spec: spec(),
				actor: actor(),
				parallel: 2,
			});
			const view = await probedGroups.wait(groupId, 5000);
			expect(view?.state).toBe("interrupted");
			// The surviving worker saw the failure flag after its own member and stopped taking nodes.
			expect(view?.tasks.length).toBeLessThan(nodeIds.length);
			expect(view?.skipped).toHaveLength(nodeIds.length - (view?.tasks.length ?? 0));
		} finally {
			await probedCluster.close();
		}
	});

	it("ends a group whose run throws instead of finishing it", async () => {
		const probe = probeDb(db);
		const probedCluster = new Cluster(probe.db, { nodeOfflineGraceMs: 10 });
		const probedGroups = new TaskGroups(probe.db, probedCluster);
		try {
			const groupId = "group-failure";
			// A member the group created earlier, waiting for an approval that can no longer be acted on.
			const waiting = await insertTask({ group: groupId, nodeId: ids["db-1"] as string, state: "awaiting_approval" });
			// The first member's dispatch throws, as the demo's lock error made it: the run itself fails. The
			// member's own id lookup comes first (the group has a stable id), so arm the second read.
			let reads = 0;
			probe.onNext(
				(node) => tableOf(node) === "tasks" && ++reads === 2,
				() => {
					throw new Error("injected storage failure");
				},
			);
			await probedGroups.create({
				id: groupId,
				targets: [ids["web-1"] as string],
				nodeIds: [ids["web-1"], ids["web-2"]] as string[],
				spec: spec(),
				actor: actor(),
				parallel: 1,
			});
			const view = await probedGroups.wait(groupId, 5000);
			// Not `finished`: the run failed, and the node that never got a task is recorded as skipped.
			expect(view?.state).toBe("interrupted");
			expect(view?.skipped).toEqual([ids["web-2"]]);
			const failed = view?.tasks.find((task) => task.nodeId === ids["web-1"]);
			expect(failed).toMatchObject({ state: "failed", errorCode: "internal_error" });
			// A task written for dispatch only is not left waiting for an approval nobody can decide.
			expect(failed?.handlerType).toBeNull();
			// The member that was still waiting ends with a reason that names the failure.
			const cancelled = await db
				.selectFrom("tasks")
				.select(["state", "error_code", "error_message"])
				.where("id", "=", waiting)
				.executeTakeFirstOrThrow();
			expect(cancelled).toMatchObject({ state: "rejected", error_code: "cancelled" });
			expect(cancelled.error_message).toBe("the task group failed: injected storage failure");
		} finally {
			await probedCluster.close();
		}
	});

	it("judges every member at creation and reads its tasks in one query", async () => {
		// A rule chain the group can judge: an API token's rules, allowed without approval.
		const tokenId = newId();
		await db
			.insertInto("api_tokens")
			.values({
				id: tokenId,
				org_id: await defaultOrgId(db),
				user_id: user.userId,
				name: "batch",
				token_hash: "hash",
				created_at: new Date().toISOString(),
				expires_at: null,
				revoked_at: null,
				last_used_at: null,
			})
			.execute();
		await createRootRuleSet(db, await defaultOrgId(db), { type: "api_token", id: tokenId }, "yolo");
		const probe = probeDb(db);
		const probedCluster = new Cluster(probe.db, { nodeOfflineGraceMs: 10 });
		const probedGroups = new TaskGroups(probe.db, probedCluster);
		try {
			const chain = [{ type: "api_token" as const, id: tokenId }];
			const ruleReads = probe.count((node) => node.kind === "SelectQueryNode" && tableOf(node) === "rule_sets");
			const id = await probedGroups.create({
				targets: [ids["web-1"] as string, ids["db-1"] as string],
				nodeIds: [ids["web-1"], ids["web-2"], ids["db-1"]] as string[],
				spec: spec(),
				actor: actor(),
				chain,
			});
			const view = await probedGroups.wait(id, 5000);
			// One read judges the group (does it wait as a whole?); every member is judged again when it
			// is created, so a rule changed mid-run still applies.
			expect(ruleReads.stop()).toBe(4);
			expect(view?.state).toBe("finished");
			expect(view?.tasks).toHaveLength(3);
			const taskReads = probe.count((node) => node.kind === "SelectQueryNode" && tableOf(node) === "tasks");
			await probedGroups.get(id);
			expect(taskReads.stop()).toBe(1);
		} finally {
			await probedCluster.close();
		}
	});

	it("re-judges members when a rule denies a node the group waited on", async () => {
		const nodeA = ids["web-1"] as string;
		const nodeB = ids["web-2"] as string;
		const ref = await addChain("yolo", [{ action: "require-approval", method: "exec", nodes: [nodeA] }]);
		const groups = new TaskGroups(db, cluster);
		const id = await groups.create({
			targets: [nodeA],
			nodeIds: [nodeA, nodeB],
			spec: spec(),
			actor: actor(),
			chain: [ref],
		});
		expect((await groups.get(id))?.state).toBe("awaiting_approval");

		// Only node A waited; a rule added now denies it, while node B is still allowed.
		await setRules(db, ref, [{ action: "deny", method: "exec", nodes: [nodeA] }]);
		await groups.reevaluate(ref);

		const view = await groups.wait(id, 5000);
		expect(view?.state).toBe("finished");
		expect(view?.approval?.decision).toMatchObject({ decision: "approved", by: { type: "system", id: "rules" } });
		const denied = view?.tasks.find((task) => task.nodeId === nodeA);
		expect(denied).toMatchObject({ state: "denied", errorCode: "policy_denied" });
		const deniedRow = await db
			.selectFrom("tasks")
			.select("dispatched_at")
			.where("id", "=", denied?.id as string)
			.executeTakeFirstOrThrow();
		expect(deniedRow.dispatched_at).toBeNull();
		// Node B still runs; it is offline here, which is the dispatch this test can observe.
		expect(view?.tasks.find((task) => task.nodeId === nodeB)).toMatchObject({
			state: "failed",
			errorCode: "node_offline",
		});
	});

	it("rejects a group when every node is denied", async () => {
		const nodeA = ids["web-1"] as string;
		const nodeB = ids["web-2"] as string;
		const ref = await addChain("ask");
		const groups = new TaskGroups(db, cluster);
		const id = await groups.create({
			targets: [nodeA, nodeB],
			nodeIds: [nodeA, nodeB],
			spec: spec(),
			actor: actor(),
			chain: [ref],
		});
		expect((await groups.get(id))?.state).toBe("awaiting_approval");

		await setRules(db, ref, [
			{ action: "deny", method: "exec", nodes: [nodeA] },
			{ action: "deny", method: "exec", nodes: [nodeB] },
		]);
		await groups.reevaluate(ref);

		const view = await groups.get(id);
		expect(view?.state).toBe("rejected");
		expect(view?.approval?.decision).toMatchObject({
			decision: "rejected",
			by: { type: "system", id: "rules" },
			reason: "denied by the authorization rules",
		});
		expect(view?.tasks).toEqual([]);
	});

	it("applies a deny rule added while a direct-run group is running", async () => {
		const nodeA = ids["web-1"] as string;
		const nodeB = ids["web-2"] as string;
		const ref = await addChain("yolo");
		const probe = probeDb(db);
		// A direct-run group is allowed as a whole; the rule lands after that judgment but before the
		// members judge themselves, as if the user changed it while the batch was starting.
		probe.onNext(
			(node) => node.kind === "SelectQueryNode" && tableOf(node) === "rule_sets",
			async () => {
				await setRules(db, ref, [{ action: "deny", method: "exec", nodes: [nodeB] }]);
			},
		);
		const probedCluster = new Cluster(probe.db, { nodeOfflineGraceMs: 10 });
		const probedGroups = new TaskGroups(probe.db, probedCluster);
		try {
			const id = await probedGroups.create({
				targets: [nodeA],
				nodeIds: [nodeA, nodeB],
				spec: spec(),
				actor: actor(),
				chain: [ref],
				parallel: 2,
			});
			const view = await probedGroups.wait(id, 5000);
			expect(view?.state).toBe("finished");
			const byNode = new Map(view?.tasks.map((task) => [task.nodeId, task]));
			// Node A was judged before the rule changed; node B is judged when its member is created.
			expect(byNode.get(nodeA)).toMatchObject({ state: "failed", errorCode: "node_offline" });
			expect(byNode.get(nodeB)).toMatchObject({ state: "denied", errorCode: "policy_denied" });
		} finally {
			await probedCluster.close();
		}
	});

	it("rejects a member that would need approval and counts it as a failure", async () => {
		const nodeA = ids["web-1"] as string;
		const nodeB = ids["web-2"] as string;
		const nodeC = ids["db-1"] as string;
		const ref = await addChain("yolo");
		const probe = probeDb(db);
		probe.onNext(
			(node) => node.kind === "SelectQueryNode" && tableOf(node) === "rule_sets",
			async () => {
				await setRules(db, ref, [{ action: "require-approval", method: "exec", nodes: [nodeA] }]);
			},
		);
		const probedCluster = new Cluster(probe.db, { nodeOfflineGraceMs: 10 });
		const probedGroups = new TaskGroups(probe.db, probedCluster);
		try {
			const id = await probedGroups.create({
				targets: [nodeA],
				nodeIds: [nodeA, nodeB, nodeC],
				spec: spec(),
				actor: actor(),
				chain: [ref],
				parallel: 1,
				failFast: true,
			});
			const view = await probedGroups.wait(id, 5000);
			expect(view?.state).toBe("finished");
			// A group that is already running cannot stop for an approval: the member ends rejected, and
			// fail_fast treats that as the failure that stops the remaining nodes.
			expect(view?.tasks).toHaveLength(1);
			expect(view?.tasks[0]).toMatchObject({
				nodeId: nodeA,
				state: "rejected",
				errorCode: "approval_required",
				errorMessage: "rules changed while the group ran: this node now requires approval",
			});
			expect(view?.skipped.sort()).toEqual([nodeB, nodeC].sort());
		} finally {
			await probedCluster.close();
		}
	});

	it("does not record a review once the group has left awaiting_approval", async () => {
		const ref = await addChain("ask");
		const audit = new Audit(db);
		const probe = probeDb(db);
		const groups = new TaskGroups(probe.db, cluster, { audit });
		const id = await groups.create({
			targets: [ids["web-1"] as string],
			nodeIds: [ids["web-1"] as string],
			spec: spec(),
			actor: actor(),
			chain: [ref],
		});
		const waiting = await db
			.selectFrom("task_groups")
			.select("approval")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(waiting.approval).not.toBeNull();

		// Settle the group after recordReview has read it as waiting, so its guarded write matches no row.
		probe.onNext(
			(node) => node.kind === "SelectQueryNode" && tableOf(node) === "task_groups",
			async () => {
				await db.updateTable("task_groups").set({ state: "finished" }).where("id", "=", id).execute();
			},
		);
		await groups.recordReview(id, { decision: "approve", reason: "looks safe", model: "test-model" });
		await audit.flush();

		const settled = await db
			.selectFrom("task_groups")
			.select(["state", "approval"])
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(settled.state).toBe("finished");
		expect(settled.approval).toBe(waiting.approval);
		const audits = await db
			.selectFrom("audit_events")
			.select("action")
			.where("target_type", "=", "task_group")
			.where("target_id", "=", id)
			.execute();
		expect(audits.map((event) => event.action)).not.toContain("task_group.review");
	});

	it("keeps a node denied when a human approves after a deny rule was added", async () => {
		const nodeA = ids["web-1"] as string;
		const nodeB = ids["web-2"] as string;
		const ref = await addChain("yolo", [{ action: "require-approval", method: "exec", nodes: [nodeA] }]);
		const groups = new TaskGroups(db, cluster);
		const id = await groups.create({
			targets: [nodeA],
			nodeIds: [nodeA, nodeB],
			spec: spec(),
			actor: actor(),
			chain: [ref],
		});
		expect((await groups.get(id))?.state).toBe("awaiting_approval");

		await setRules(db, ref, [{ action: "deny", method: "exec", nodes: [nodeA] }]);
		expect(
			await groups.decide(id, {
				decision: "approved",
				by: { type: "user", id: user.userId },
				at: new Date().toISOString(),
				reason: "approved by hand",
			}),
		).toBe(true);

		const view = await groups.wait(id, 5000);
		expect(view?.state).toBe("finished");
		expect(view?.tasks.find((task) => task.nodeId === nodeA)).toMatchObject({
			state: "denied",
			errorCode: "policy_denied",
		});
		expect(view?.tasks.find((task) => task.nodeId === nodeB)).toMatchObject({
			state: "failed",
			errorCode: "node_offline",
		});
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

	it("ends a parked wait when recover() interrupts the group", async () => {
		const ref = await addChain("ask");
		const groups = new TaskGroups(db, cluster);
		const id = await groups.create({
			targets: [ids["web-1"] as string],
			nodeIds: [ids["web-1"] as string],
			spec: spec(),
			actor: actor(),
			chain: [ref],
		});
		expect((await groups.get(id))?.state).toBe("awaiting_approval");
		const parked = groups.wait(id, 5000);
		// wait() reads the row once, then parks on the group's settled entry.
		await new Promise((resolve) => setTimeout(resolve, 100));
		// A group a previous process left running is interrupted by recover(); a wait held on it must return
		// then, not at its own timeout.
		await db.updateTable("task_groups").set({ state: "running" }).where("id", "=", id).execute();
		await groups.recover();
		const view = await Promise.race([
			parked,
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
		]);
		if (view === "timeout") throw new Error("the parked wait did not end when the group was interrupted");
		expect(view?.state).toBe("interrupted");
	});

	it("cancels a group that is still waiting for its approval and ends its wait", async () => {
		const ref = await addChain("ask");
		const groups = new TaskGroups(db, cluster);
		const nodeIds = [ids["web-1"], ids["web-2"]] as string[];
		const id = await groups.create({
			targets: [ids["web-1"] as string],
			nodeIds,
			spec: spec(),
			actor: actor(),
			chain: [ref],
		});
		expect((await groups.get(id))?.state).toBe("awaiting_approval");
		const parked = groups.wait(id, 5000);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await groups.cancel(id, "the user cancelled the batch")).toBe(true);
		const view = await Promise.race([
			parked,
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
		]);
		if (view === "timeout") throw new Error("the parked wait did not end when the group was cancelled");
		expect(view?.state).toBe("cancelled");
		// A waiting group created no member, so every node is recorded as skipped.
		expect(view?.skipped.sort()).toEqual(nodeIds.sort());
		expect(view?.tasks).toEqual([]);
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
