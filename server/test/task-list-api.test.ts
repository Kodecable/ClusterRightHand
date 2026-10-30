import type { TaskSpec } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { shareNode } from "../src/cluster/nodes.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import type { RuleRef } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

/**
 * GET /api/tasks: every task on a node the user can see, with the filters and ordering the task page
 * needs (doc/privilege.md, the WebUI's task page and the signature section of the approvals page).
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
				owner_user_id: uid.alice as string,
				name,
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
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
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

	/** An api token of alice, with the given preset (ask = require-approval, yolo = allow). */
	const newToken = async (preset = "ask") => {
		const res = await call(app, "/api/api-tokens", { cookie: cookies.alice, body: { name: "t", preset } });
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
			tasks: TaskView[];
			offset: number;
			limit: number;
			nextOffset: number | null;
		}>;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db);
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
		// Bob may view n1; carol sees nothing of alice's.
		await shareNode(db, {
			nodeId: n1,
			granteeType: "user",
			granteeId: uid.bob as string,
			access: "view",
			createdBy: uid.alice as string,
		});
	});
	afterAll(async () => {
		cluster.close();
		await db.destroy();
	});

	it("lists only the tasks on nodes the user can see", async () => {
		const own1 = await mkTask({ nodeId: n1 });
		const own2 = await mkTask({ nodeId: n2 });
		// A member shared into n1 sees its tasks; one without a share sees none of them.
		expect((await list("alice")).tasks.map((t) => t.id)).toEqual(expect.arrayContaining([own1.id, own2.id]));
		const bob = await list("bob");
		expect(bob.tasks.map((t) => t.id)).toContain(own1.id);
		expect(bob.tasks.map((t) => t.id)).not.toContain(own2.id);
		expect((await list("carol")).tasks).toEqual([]);
		expect((await list("root")).tasks.map((t) => t.id)).toEqual(expect.arrayContaining([own1.id, own2.id]));
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
		const onNode = (await list("alice", `?nodeId=${nodeIds[0]}`)).tasks.map((t) => t.id);
		expect(onNode[0]).toBe(ordinary.id);
		const all = (await list("alice")).tasks.map((t) => t.id);
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
		expect(byState.tasks.map((t) => t.id)).toContain(waiting.id);
		expect(byState.tasks.every((t) => t.state === "awaiting_approval")).toBe(true);

		const byNode = await list("alice", `?nodeId=${n2}`);
		expect(byNode.tasks.length).toBeGreaterThan(0);
		expect(byNode.tasks.every((t) => t.nodeId === n2)).toBe(true);

		const byActor = await list("alice", "?actorType=api_token");
		expect(byActor.tasks.map((t) => t.id)).toContain(waiting.id);
		expect(byActor.tasks.every((t) => t.actorType === "api_token")).toBe(true);

		const combined = await list("alice", `?state=awaiting_approval&nodeId=${n1}&actorType=api_token`);
		expect(combined.tasks.map((t) => t.id)).toEqual([waiting.id]);
		await cluster.decide(waiting.id, {
			decision: "rejected",
			by: { type: "user", id: uid.alice as string, onBehalfOfUserId: uid.alice as string },
			at: new Date().toISOString(),
		});
	});

	it("puts the tasks waiting for this user first unless a state is given", async () => {
		// Older tasks first, so ordering by created_at alone would put the waiting ones last.
		const old1 = await mkTask({ nodeId: n1 });
		const old2 = await mkTask({ nodeId: n2 });
		const tok = await newToken("ask");
		const approval = await cluster.createTask({
			nodeId: n1,
			spec: execSpec("echo", "approval"),
			chain: [{ type: "api_token", id: tok }],
			actor: tokenActor(tok),
		});
		// A signature wait: the server only reads the row, so the state is set directly.
		const signature = await mkTask({ nodeId: n1, actor: tokenActor(tok) });
		await db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", signature.id).execute();
		// Another user's signature wait must not jump ahead of alice's own.
		const othersSignature = await mkTask({ nodeId: n1 });
		await db
			.updateTable("tasks")
			.set({ state: "awaiting_authorization", on_behalf_of_user_id: uid.bob as string })
			.where("id", "=", othersSignature.id)
			.execute();

		const all = (await list("alice")).tasks.map((t) => t.id);
		const waiting = new Set([approval.id, signature.id]);
		expect(new Set(all.slice(0, 2))).toEqual(waiting);
		expect(all.indexOf(othersSignature.id)).toBeGreaterThan(1);
		expect(all.indexOf(old1.id)).toBeGreaterThan(1);
		expect(all.indexOf(old2.id)).toBeGreaterThan(1);
		await cluster.decide(approval.id, {
			decision: "rejected",
			by: { type: "user", id: uid.alice as string, onBehalfOfUserId: uid.alice as string },
			at: new Date().toISOString(),
		});
	});

	it("paginates newest first and caps the page size", async () => {
		for (let i = 0; i < 5; i++) await mkTask({ nodeId: n1, spec: execSpec("echo", `page-${i}`) });
		// A state filter keeps the plain newest-first order; the default order moves the waits first.
		const first = await list("alice", "?state=failed&limit=2");
		expect(first.tasks).toHaveLength(2);
		expect(first.limit).toBe(2);
		expect(first.nextOffset).toBe(2);
		const second = await list("alice", "?state=failed&limit=2&offset=2");
		expect(second.tasks).toHaveLength(2);
		expect(second.nextOffset).toBe(4);
		expect(second.tasks.map((t) => t.id)).not.toEqual(first.tasks.map((t) => t.id));
		// Newest first: created_at desc.
		expect(new Date(first.tasks[0]?.createdAt as string).getTime()).toBeGreaterThanOrEqual(
			new Date(first.tasks[1]?.createdAt as string).getTime(),
		);
		const capped = await list("alice", "?limit=1000");
		expect(capped.limit).toBe(100);
	});

	it("rejects an unknown filter or node and an invalid page", async () => {
		for (const query of ["?state=bogus", "?actorType=bogus", "?limit=0", "?offset=-1"]) {
			expect((await call(app, `/api/tasks${query}`, { cookie: cookies.alice })).status, query).toBe(400);
		}
		expect((await call(app, `/api/tasks?nodeId=${newId()}`, { cookie: cookies.alice })).status).toBe(404);
		// A node the user cannot see is not disclosed either.
		expect((await call(app, `/api/tasks?nodeId=${n2}`, { cookie: cookies.bob })).status).toBe(404);
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
