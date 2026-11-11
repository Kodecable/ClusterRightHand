import type { TaskSpec } from "@crh/protocol";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";

import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import type { RuleRef } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

/**
 * GET /api/tasks: the tasks the user may see (administrators all, everyone else their own), with the
 * filters and ordering the task page needs (doc/design/privilege.md, the WebUI's task page and the signature
 * section of the approvals page).
 */
describe("task list api (sqlite)", () => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let groups: TaskGroups;
	const cookies: Record<string, string> = {};
	const uid: Record<string, string> = {};
	let n1 = "";
	let n2 = "";

	const addNode = async (name: string) => {
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
		// The node belongs to the organization; alice gets a grant so her tasks can be dispatched.
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: uid.alice as string,
				target_type: "node",
				target_id: id,
				created_by_user_id: uid.alice as string,
				created_at: now,
			})
			.execute();
		return id;
	};

	const execSpec = (...argv: string[]): TaskSpec => ({
		kind: "exec",
		command: { argv },
		env: {},
		cwd: "",
		stdin: null,
	});

	/** An api token of alice, with the given rule preset (ask = require-approval, yolo = allow). */
	const newToken = async (rulePreset = "ask") => {
		const res = await call(app, "/api/api-tokens", { cookie: cookies.alice, body: { name: "t", rulePreset } });
		return ((await res.json()) as { apiToken: { id: string } }).apiToken.id;
	};

	const mkTask = async (opts: {
		nodeId?: string;
		actor?: { type: "user" | "api_token"; id: string; onBehalfOfUserId: string };
		chain?: RuleRef[];
		spec?: TaskSpec;
	}) =>
		cluster.createTask({
			nodeId: opts.nodeId ?? n1,
			spec: opts.spec ?? execSpec("echo", "hi"),
			actor: opts.actor ?? aliceActor(),
			...(opts.chain ? { chain: opts.chain } : {}),
		});

	const aliceActor = () => ({
		type: "user" as const,
		id: uid.alice as string,
		onBehalfOfUserId: uid.alice as string,
	});
	const tokenActor = (tokenId: string) => ({
		type: "api_token" as const,
		id: tokenId,
		onBehalfOfUserId: uid.alice as string,
	});

	const list = async (who: string, query = "") =>
		(await call(app, `/api/tasks${query}`, { cookie: cookies[who] })).json() as Promise<{
			items: TaskView[];
			nextCursor: string | null;
		}>;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { nodeOfflineGraceMs: 10 });
		groups = new TaskGroups(db, cluster, {});
		app = makeApp(db, undefined, { cluster, taskGroups: groups });
		for (const [name, kind] of [
			["alice", "member"],
			["bob", "member"],
			["carol", "member"],
			["root", "admin"],
		] as const) {
			uid[name] = (await createUser(db, { username: name, kind, password: "password-123" })).id;
			cookies[name] = await login(app, name, "password-123");
		}
		n1 = await addNode("n1");
		n2 = await addNode("n2");
	});
	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("lists the user's own tasks, all tasks for an admin, and never another user's", async () => {
		const own1 = await mkTask({ nodeId: n1 });
		const own2 = await mkTask({ nodeId: n2 });
		const bobs = await cluster.createTask({
			nodeId: n1,
			spec: execSpec("echo", "bob"),
			actor: { type: "user", id: uid.bob as string, onBehalfOfUserId: uid.bob as string },
		});
		expect((await list("alice")).items.map((t) => t.id)).toEqual(expect.arrayContaining([own1.id, own2.id]));
		expect((await list("alice")).items.map((t) => t.id)).not.toContain(bobs.id);
		const bob = await list("bob");
		expect(bob.items.map((t) => t.id)).toEqual([bobs.id]);
		expect((await list("carol")).items).toEqual([]);
		expect((await list("root")).items.map((t) => t.id)).toEqual(expect.arrayContaining([own1.id, own2.id, bobs.id]));
	});

	it("lists a waiting task group once, not once per member task", async () => {
		const nodeIds = [await addNode("group-a"), await addNode("group-b"), await addNode("group-c")];
		const tok = await newToken("ask");
		const groupId = newId();
		const members: string[] = [];
		for (const nodeId of nodeIds) {
			const member = await mkTask({ nodeId, actor: tokenActor(tok) });
			// The server only reads these rows, so the group assignment and the signature wait are set directly.
			await db
				.updateTable("tasks")
				.set({ state: "awaiting_authorization", task_group_id: groupId })
				.where("id", "=", member.id)
				.execute();
			members.push(member.id);
		}
		await db
			.insertInto("task_groups")
			.values({
				id: groupId,
				org_id: await defaultOrgId(db),
				targets: JSON.stringify(["group-a", "group-b", "group-c"]),
				node_ids: JSON.stringify(nodeIds),
				kind: "exec",
				parallel: 3,
				fail_fast: 0,
				output_mode: "status",
				privileged: 0,
				skipped: "[]",
				state: "awaiting_authorization",
				actor_type: "api_token",
				actor_id: tok,
				on_behalf_of_user_id: uid.alice as string,
				created_at: new Date().toISOString(),
				finished_at: null,
			})
			.execute();

		const res = (await (await call(app, "/api/approvals", { cookie: cookies.alice })).json()) as {
			authorizations: { tasks: TaskView[]; taskGroups: TaskGroupView[] };
		};
		// The group is one entry; its three member tasks are signed with it and are not listed at all.
		expect(res.authorizations.taskGroups.map((g) => g.id)).toEqual([groupId]);
		expect(res.authorizations.tasks).toEqual([]);

		// The list of tasks still shows the members, but none of them jumps ahead of a newer ordinary
		// task: the signature is given on the group page, so per-node waits get no priority.
		const ordinary = await mkTask({ nodeId: nodeIds[0] as string });
		const onNode = (await list("alice", `?nodeId=${nodeIds[0]}`)).items.map((t) => t.id);
		expect(onNode[0]).toBe(ordinary.id);
		const all = (await list("alice")).items.map((t) => t.id);
		expect(all).toEqual(expect.arrayContaining(members));
	});

	it("filters by state, node and actor type", async () => {
		const tok = await newToken("ask");
		const waiting = await cluster.createTask({
			nodeId: n1,
			spec: execSpec("echo", "waiting"),
			chain: [{ type: "api_token", id: tok }],
			actor: tokenActor(tok),
		});
		expect(waiting.state).toBe("awaiting_approval");

		const byState = await list("alice", "?state=awaiting_approval");
		expect(byState.items.map((t) => t.id)).toContain(waiting.id);
		expect(byState.items.every((t) => t.state === "awaiting_approval")).toBe(true);

		const byNode = await list("alice", `?nodeId=${n2}`);
		expect(byNode.items.length).toBeGreaterThan(0);
		expect(byNode.items.every((t) => t.nodeId === n2)).toBe(true);

		const byActor = await list("alice", "?actorType=api_token");
		expect(byActor.items.map((t) => t.id)).toContain(waiting.id);
		expect(byActor.items.every((t) => t.actorType === "api_token")).toBe(true);

		const combined = await list("alice", `?state=awaiting_approval&nodeId=${n1}&actorType=api_token`);
		expect(combined.items.map((t) => t.id)).toEqual([waiting.id]);
		await cluster.decide(waiting.id, {
			decision: "rejected",
			by: { type: "user", id: uid.alice as string, onBehalfOfUserId: uid.alice as string },
			at: new Date().toISOString(),
		});
	});

	it("filters by the requesting user, the By column, including session-actor tasks", async () => {
		const node = await addNode("by-node");
		const aliceTask = await mkTask({ nodeId: node, spec: execSpec("echo", "alice-task") });
		const bobTask = await cluster.createTask({
			nodeId: node,
			spec: execSpec("echo", "bob-task"),
			actor: { type: "user", id: uid.bob as string, onBehalfOfUserId: uid.bob as string },
		});
		// A session acts for its owner, and the By column shows that owner, so the filter includes it.
		const sessionTask = await cluster.createTask({
			nodeId: node,
			spec: execSpec("echo", "session-task"),
			actor: { type: "session", id: "session-by-owner", onBehalfOfUserId: uid.alice as string },
		});

		const alice = await list("alice", `?userId=${uid.alice}`);
		expect(alice.items.map((task) => task.id)).toEqual(expect.arrayContaining([aliceTask.id, sessionTask.id]));
		expect(alice.items.map((task) => task.id)).not.toContain(bobTask.id);
		expect(alice.items.every((task) => task.onBehalfOfUserId === uid.alice)).toBe(true);
		// Visibility still applies first: a member cannot list another user's tasks through the filter.
		expect((await list("bob", `?userId=${uid.alice}`)).items).toEqual([]);

		const adminView = await list("root", `?userId=${uid.bob}`);
		const ids = adminView.items.map((task) => task.id);
		expect(ids).toContain(bobTask.id);
		expect(ids).not.toContain(aliceTask.id);
		expect(ids).not.toContain(sessionTask.id);
	});

	it("orders only by created_at desc, id desc", async () => {
		const node = await addNode("order-node");
		const tok = await newToken("ask");
		const waiting = await cluster.createTask({
			nodeId: node,
			spec: execSpec("echo", "waiting"),
			chain: [{ type: "api_token", id: tok }],
			actor: tokenActor(tok),
		});
		expect(waiting.state).toBe("awaiting_approval");
		await db
			.updateTable("tasks")
			.set({ created_at: sql`'2026-01-01T00:00:00.000Z'` })
			.where("id", "=", waiting.id)
			.execute();
		const normal = await mkTask({ nodeId: node });
		await db
			.updateTable("tasks")
			.set({ created_at: sql`'2026-01-02T00:00:00.000Z'` })
			.where("id", "=", normal.id)
			.execute();

		// Waiting for this user no longer jumps ahead: the newer ordinary task is first.
		const ordered = (await list("alice", `?nodeId=${node}`)).items.map((t) => t.id);
		expect(ordered).toEqual([normal.id, waiting.id]);

		// A tie on created_at is broken by the id, descending.
		await db
			.updateTable("tasks")
			.set({ created_at: sql`'2026-01-03T00:00:00.000Z'` })
			.where("id", "in", [normal.id, waiting.id])
			.execute();
		const [first, second] = [normal.id, waiting.id].sort().reverse() as [string, string];
		expect((await list("alice", `?nodeId=${node}`)).items.map((t) => t.id)).toEqual([first, second]);
		await cluster.decide(waiting.id, {
			decision: "rejected",
			by: { type: "user", id: uid.alice as string, onBehalfOfUserId: uid.alice as string },
			at: new Date().toISOString(),
		});
	});

	it("pages with a keyset cursor and validates the page size", async () => {
		const node = await addNode("page-node");
		const created: string[] = [];
		for (let index = 0; index < 7; index++) {
			const task = await mkTask({ nodeId: node, spec: execSpec("echo", `page-${index}`) });
			await db
				.updateTable("tasks")
				.set({ created_at: sql`${`2026-02-01T00:00:0${index}.000Z`}` })
				.where("id", "=", task.id)
				.execute();
			created.push(task.id);
		}
		const expected = [...created].reverse();
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const page = await list(
				"alice",
				`?nodeId=${node}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			expect(page.items.length).toBeLessThanOrEqual(3);
			seen.push(...page.items.map((t) => t.id));
			cursor = page.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toEqual(expected);
		expect(new Set(seen).size).toBe(expected.length);

		expect((await call(app, "/api/tasks?limit=200", { cookie: cookies.alice })).status).toBe(200);
		for (const query of ["?limit=201", "?limit=0", "?cursor=garbage", "?cursor="]) {
			expect((await call(app, `/api/tasks${query}`, { cookie: cookies.alice })).status, query).toBe(400);
		}
	});

	it("rejects an unknown filter and treats nodeId as a plain narrowing filter", async () => {
		for (const query of ["?state=bogus", "?actorType=bogus"]) {
			expect((await call(app, `/api/tasks${query}`, { cookie: cookies.alice })).status, query).toBe(400);
		}
		// No node disclosure through the filter: an unknown id is an empty page, not a 404.
		const unknown = await list("alice", `?nodeId=${newId()}`);
		expect(unknown.items).toEqual([]);
		const bobsView = await list("bob", `?nodeId=${n2}`);
		expect(bobsView.items).toEqual([]);
	});

	it("lists the signature waits on the approvals page", async () => {
		const signature = await mkTask({ nodeId: n1 });
		await db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", signature.id).execute();
		const res = (await (await call(app, "/api/approvals", { cookie: cookies.alice })).json()) as {
			authorizations: { tasks: TaskView[]; taskGroups: TaskGroupView[] };
		};
		expect(res.authorizations.tasks.map((t) => t.id)).toContain(signature.id);
		// Another user does not get alice's signature wait.
		const bob = (await (await call(app, "/api/approvals", { cookie: cookies.bob })).json()) as {
			authorizations: { tasks: TaskView[] };
		};
		expect(bob.authorizations.tasks.map((t) => t.id)).not.toContain(signature.id);
	});
});
