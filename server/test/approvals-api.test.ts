import type { TaskSpec } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import { operationOf } from "../src/policy/rules.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe("approvals api (sqlite)", () => {
	const backend = "sqlite";
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let groups: TaskGroups;
	let audit: Audit;
	const cookies: Record<string, string> = {};
	const uid: Record<string, string> = {};
	const nodes: string[] = [];

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
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
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
		nodes.push(id);
		return id;
	};

	const newToken = async (preset = "ask") => {
		const res = await call(app, "/api/api-tokens", { cookie: cookies.alice, body: { name: "t", preset } });
		return ((await res.json()) as { apiToken: { id: string } }).apiToken.id;
	};
	const execSpec = (...argv: string[]): TaskSpec => ({
		kind: "exec",
		command: { argv },
		env: {},
		cwd: "",
		stdin: null,
	});
	const actorOf = (tokenId: string) => ({
		type: "api_token" as const,
		id: tokenId,
		onBehalfOfUserId: uid.alice as string,
	});
	const mkTask = (tokenId: string, spec = execSpec("echo", "hi"), nodeId = nodes[0] as string) =>
		cluster.createTask({ nodeId, spec, chain: [{ type: "api_token", id: tokenId }], actor: actorOf(tokenId) });
	const decide = (who: string, path: string, body: unknown) => call(app, path, { cookie: cookies[who], body });
	const putRules = (tokenId: string, body: unknown) =>
		call(app, `/api/api-tokens/${tokenId}/rules`, { cookie: cookies.alice, method: "PUT", body });
	const task = async (id: string) => (await cluster.getTask(id)) as TaskView;
	const events = async (action: string, targetId: string) => {
		await audit.flush();
		const r = await call(app, `/api/audit?action=${action}&targetId=${targetId}`, { cookie: cookies.root });
		return ((await r.json()) as { items: { detail: Record<string, unknown> }[] }).items;
	};
	const pending = async (who: string) =>
		(await (await call(app, "/api/approvals", { cookie: cookies[who] })).json()) as {
			tasks: TaskView[];
			taskGroups: TaskGroupView[];
		};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		groups = new TaskGroups(db, cluster, { audit });
		app = makeApp(db, undefined, { cluster, taskGroups: groups, audit });
		for (const [name, kind] of [
			["alice", "member"],
			["bob", "member"],
			["root", "admin"],
		] as const) {
			uid[name] = (await createUser(db, { username: name, kind, password: "password-123" })).id;
			cookies[name] = await login(app, name, "password-123");
		}
		await addNode("n1");
		await addNode("n2");
	});
	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("an exec under ask waits; listed for the owner only", async () => {
		const tok = await newToken();
		const t = await mkTask(tok);
		expect(t.state).toBe("awaiting_approval");
		expect(t.approval?.evaluation.result).toBe("require-approval");
		expect((await pending("alice")).tasks.map((x) => x.id)).toContain(t.id);
		expect((await pending("bob")).tasks).toEqual([]);
		expect((await pending("root")).tasks).toEqual([]);
		await cluster.decide(t.id, { decision: "rejected", by: { type: "user", id: "x" }, at: new Date().toISOString() });
	});

	it("hides a request routed to an agent and refuses a user decision", async () => {
		const tok = await newToken();
		const t = await mkTask(tok);
		expect(await cluster.requestAgentDecision(t.id, "agent-session")).toBe(true);
		expect((await pending("alice")).tasks.map((x) => x.id)).not.toContain(t.id);
		const res = await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "approve" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/agent/);
		await cluster.decide(t.id, { decision: "rejected", by: { type: "user", id: "x" }, at: new Date().toISOString() });
	});

	it("only the owner decides; reject ends the task", async () => {
		const tok = await newToken();
		const t = await mkTask(tok);
		for (const who of ["bob", "root"]) {
			expect((await decide(who, `/api/tasks/${t.id}/approval`, { decision: "reject" })).status).toBe(404);
		}
		expect((await task(t.id)).state).toBe("awaiting_approval");
		expect((await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "bogus" })).status).toBe(400);
		const res = await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "reject", reason: "no way" });
		expect(res.status).toBe(200);
		const v = await task(t.id);
		expect(v.state).toBe("rejected");
		expect(v.errorCode).toBe("approval_rejected");
		expect(v.errorMessage).toBe("no way");
		expect((await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "reject" })).status).toBe(409);
		expect((await decide("alice", "/api/tasks/nonexistent/approval", { decision: "reject" })).status).toBe(404);
	});

	it("approve dispatches; the offline node fails it; deciding twice is a conflict", async () => {
		const tok = await newToken();
		const t = await mkTask(tok);
		const res = await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "approve" });
		expect(res.status).toBe(200);
		const v = await task(t.id);
		expect(v.state).toBe("failed");
		expect(v.errorCode).toBe("node_offline");
		expect(v.approval?.decision?.decision).toBe("approved");
		expect((await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "approve" })).status).toBe(409);
	});

	it("approving a task with an unreadable legacy spec is a client error", async () => {
		const tok = await newToken();
		const t = await mkTask(tok);
		await db.updateTable("tasks").set({ spec: "{not json" }).where("id", "=", t.id).execute();
		const res = await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "approve" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("stored spec cannot be read");
		expect((await task(t.id)).state).toBe("awaiting_approval");
	});

	it("approve with always appends the rule and releases a similar waiting task", async () => {
		const tok = await newToken();
		const spec = execSpec("uptime", "-p");
		const target = operationOf(spec).target;
		const a = await mkTask(tok, spec);
		const b = await mkTask(tok, spec);
		const other = await mkTask(tok, execSpec("df"));
		const res = await decide("alice", `/api/tasks/${a.id}/approval`, {
			decision: "approve",
			always: { action: "allow", method: "exec", exact: target },
		});
		expect(res.status).toBe(200);
		expect((await task(a.id)).errorCode).toBe("node_offline");
		const vb = await task(b.id);
		expect(vb.state).toBe("failed");
		expect(vb.errorCode).toBe("node_offline");
		expect(vb.approval?.decision?.by.type).toBe("system");
		expect((await task(other.id)).state).toBe("awaiting_approval");
		const list = (await (await call(app, "/api/api-tokens", { cookie: cookies.alice })).json()) as {
			tokens: { id: string; rules: { rules: unknown[] } }[];
		};
		expect(list.tokens.find((x) => x.id === tok)?.rules.rules).toEqual([
			{ action: "allow", method: "exec", exact: target },
		]);
		// a new matching call is allowed at once
		expect((await mkTask(tok, spec)).errorCode).toBe("node_offline");
		await cluster.decide(other.id, {
			decision: "rejected",
			by: { type: "user", id: "x" },
			at: new Date().toISOString(),
		});
	});

	it("resolves node names in an always rule and reports their display names", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, execSpec("id"), nodes[1] as string);
		const res = await decide("alice", `/api/tasks/${t.id}/approval`, {
			decision: "approve",
			always: { action: "allow", method: "exec", nodes: ["N2"] },
		});
		expect(res.status).toBe(200);
		const list = (await (await call(app, "/api/api-tokens", { cookie: cookies.alice })).json()) as {
			tokens: { id: string; rules: { rules: { nodes?: string[] }[] }; refs: Record<string, unknown> }[];
		};
		const saved = list.tokens.find((token) => token.id === tok);
		expect(saved?.rules.rules[0]?.nodes).toEqual([nodes[1]]);
		expect(saved?.refs).toEqual({ [nodes[1] as string]: { kind: "node", name: "n2" } });
	});

	it("saves an always rule only after the decision is accepted", async () => {
		const tok = await newToken();
		const spec = execSpec("uptime", "-a");
		const target = operationOf(spec).target;
		const t = await mkTask(tok, spec);
		// The request loses the race after it was read: the decision is refused.
		const decided = vi.spyOn(cluster, "decide").mockResolvedValueOnce(false);
		try {
			const res = await decide("alice", `/api/tasks/${t.id}/approval`, {
				decision: "approve",
				always: { action: "allow", method: "exec", exact: target },
			});
			expect(res.status).toBe(409);
		} finally {
			decided.mockRestore();
		}
		const list = (await (await call(app, "/api/api-tokens", { cookie: cookies.alice })).json()) as {
			tokens: { id: string; rules: { rules: unknown[] } }[];
		};
		expect(list.tokens.find((x) => x.id === tok)?.rules.rules).toEqual([]);
		expect((await task(t.id)).state).toBe("awaiting_approval");
		await cluster.decide(t.id, {
			decision: "rejected",
			by: { type: "user", id: "x" },
			at: new Date().toISOString(),
		});
	});

	it("an always rule must be an allow rule", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, execSpec("ls"));
		const res = await decide("alice", `/api/tasks/${t.id}/approval`, {
			decision: "approve",
			always: { action: "deny", method: "exec" },
		});
		expect(res.status).toBe(400);
		expect((await task(t.id)).state).toBe("awaiting_approval");
	});

	it("switching to yolo approves waiting tasks; a deny rule denies them", async () => {
		const tok = await newToken();
		const a = await mkTask(tok, execSpec("one"));
		const b = await mkTask(tok, execSpec("two"));
		expect((await putRules(tok, { preset: "yolo" })).status).toBe(200);
		for (const id of [a.id, b.id]) {
			const v = await task(id);
			expect(v.state).toBe("failed");
			expect(v.errorCode).toBe("node_offline");
		}
		const tok2 = await newToken();
		const c = await mkTask(tok2, execSpec("rm", "-rf", "x"));
		const d = await mkTask(tok2, execSpec("ls"));
		expect((await putRules(tok2, { rules: [{ action: "deny", method: "exec", prefix: "rm " }] })).status).toBe(200);
		const vc = await task(c.id);
		expect(vc.state).toBe("denied");
		expect(vc.errorCode).toBe("policy_denied");
		expect((await task(d.id)).state).toBe("awaiting_approval");
		await cluster.decide(d.id, { decision: "rejected", by: { type: "user", id: "x" }, at: new Date().toISOString() });
	});

	it("file.read under ask is allowed without waiting", async () => {
		const tok = await newToken();
		const spec: TaskSpec = { kind: "file.read", path: "/etc/hostname", startLine: 1, lineCount: 100 };
		const t = await mkTask(tok, spec);
		expect(t.state).toBe("failed");
		expect(t.errorCode).toBe("node_offline");
		expect(t.approval?.decision).toBeUndefined();
	});

	it("a privileged file.read under ask still waits (D86)", async () => {
		const tok = await newToken();
		const spec: TaskSpec = { kind: "file.read", path: "/etc/hostname", startLine: 1, lineCount: 100 };
		const t = await cluster.createTask({
			nodeId: nodes[0] as string,
			spec,
			privileged: true,
			chain: [{ type: "api_token", id: tok }],
			actor: actorOf(tok),
		});
		expect(t.privileged).toBe(true);
		expect(t.state).toBe("awaiting_approval");
		expect(t.approval?.evaluation.result).toBe("require-approval");
		// The matched rule was the preset's ordinary-read allow, which does not cover privileged reads.
		expect(t.approval?.evaluation.levels[0]?.own).toBe("require-approval");
		await cluster.decide(t.id, { decision: "rejected", by: { type: "user", id: "x" }, at: new Date().toISOString() });
	});

	it("records task.created, task.approval and task.finished in the audit log", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, execSpec("audited"));
		await decide("alice", `/api/tasks/${t.id}/approval`, { decision: "approve" });
		expect(await events("task.created", t.id)).toHaveLength(1);
		const appr = await events("task.approval", t.id);
		expect(appr).toHaveLength(1);
		expect(appr[0]?.detail.decision).toBe("approved");
		const fin = await events("task.finished", t.id);
		expect(fin).toHaveLength(1);
		expect(fin[0]?.detail.error_code).toBe("node_offline");
		// bob cannot see alice's events
		const r = await call(app, `/api/audit?targetId=${t.id}`, { cookie: cookies.bob });
		expect(((await r.json()) as { items: unknown[] }).items).toEqual([]);
	});

	describe("task groups", () => {
		const mkGroup = async (tok: string, spec = execSpec("grp")) =>
			groups.create({
				targets: ["n1", "n2"],
				nodeIds: [...nodes],
				spec,
				actor: actorOf(tok),
				chain: [{ type: "api_token", id: tok }],
			});

		it("waits as a whole and starts when approved", async () => {
			const tok = await newToken();
			const id = await mkGroup(tok);
			const g = (await groups.get(id)) as TaskGroupView;
			expect(g.state).toBe("awaiting_approval");
			expect(g.tasks).toEqual([]);
			const waiting = await db
				.selectFrom("task_groups")
				.select(["root_session_id", "handler_type", "handler_session_id"])
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
			expect(waiting).toMatchObject({ root_session_id: null, handler_type: "user", handler_session_id: null });
			const list = await pending("alice");
			expect(list.taskGroups.map((x) => x.id)).toContain(id);
			expect((await pending("bob")).taskGroups).toEqual([]);
			expect((await decide("bob", `/api/task-groups/${id}/approval`, { decision: "approve" })).status).toBe(404);
			expect((await decide("alice", `/api/task-groups/${id}/approval`, { decision: "approve" })).status).toBe(200);
			const decided = await db
				.selectFrom("task_groups")
				.select(["handler_type", "handler_session_id"])
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
			expect(decided).toMatchObject({ handler_type: null, handler_session_id: null });
			const done = (await groups.wait(id, 10000)) as TaskGroupView;
			expect(done.state).toBe("finished");
			expect(done.tasks).toHaveLength(2);
			expect(done.tasks.every((t) => t.errorCode === "node_offline")).toBe(true);
			expect((await decide("alice", `/api/task-groups/${id}/approval`, { decision: "approve" })).status).toBe(409);
		});

		it("an approved privileged group keeps the flag on its tasks (D86)", async () => {
			const tok = await newToken();
			const spec: TaskSpec = { kind: "file.read", path: "/etc/hostname", startLine: 1, lineCount: 100 };
			const id = await groups.create({
				targets: ["n1", "n2"],
				nodeIds: [...nodes],
				spec,
				privileged: true,
				actor: actorOf(tok),
				chain: [{ type: "api_token", id: tok }],
			});
			const g = (await groups.get(id)) as TaskGroupView;
			expect(g.privileged).toBe(true);
			// The preset's ordinary-read allow does not cover a privileged read.
			expect(g.state).toBe("awaiting_approval");
			expect(g.approval?.nodes.every((n) => n.evaluation.result === "require-approval")).toBe(true);
			expect((await decide("alice", `/api/task-groups/${id}/approval`, { decision: "approve" })).status).toBe(200);
			const done = (await groups.wait(id, 10000)) as TaskGroupView;
			expect(done.tasks).toHaveLength(2);
			expect(done.tasks.every((t) => t.privileged)).toBe(true);
		});

		it("can be rejected", async () => {
			const tok = await newToken();
			const id = await mkGroup(tok, execSpec("grp2"));
			expect((await decide("alice", `/api/task-groups/${id}/approval`, { decision: "reject" })).status).toBe(200);
			const g = (await groups.get(id)) as TaskGroupView;
			expect(g.state).toBe("rejected");
			expect(g.tasks).toEqual([]);
		});

		it("keeps the list and view working when a legacy spec cannot be read", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const tok = await newToken();
				const id = await mkGroup(tok);
				await db.updateTable("task_groups").set({ spec: "{not json" }).where("id", "=", id).execute();

				const list = await call(app, "/api/approvals", { cookie: cookies.alice });
				expect(list.status).toBe(200);
				const listed = ((await list.json()) as { taskGroups: TaskGroupView[] }).taskGroups.find((g) => g.id === id);
				expect(listed).toMatchObject({ id, state: "awaiting_approval", summary: "", operation: null });

				const view = await call(app, `/api/task-groups/${id}`, { cookie: cookies.alice });
				expect(view.status).toBe(200);
				expect(((await view.json()) as { taskGroup: TaskGroupView }).taskGroup).toMatchObject({
					id,
					summary: "",
					operation: null,
				});

				const res = await decide("alice", `/api/task-groups/${id}/approval`, { decision: "approve" });
				expect(res.status).toBe(400);
				expect(((await res.json()) as { error: string }).error).toContain("stored spec cannot be read");
				expect((await groups.get(id))?.state).toBe("awaiting_approval");

				await groups.reevaluate({ type: "api_token", id: tok });
				expect(warn.mock.calls.some((call) => String(call[0]).includes("stored spec cannot be read"))).toBe(true);
			} finally {
				warn.mockRestore();
			}
		});
	});
});
