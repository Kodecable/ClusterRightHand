/**
 * The handler checks around an approval decision and the endings that keep waiting rows from outliving
 * their chance to dispatch: an approval drops the handler before the claim (M2a), a row being dispatched
 * is not re-judged (M2b), the decision turn repeats the caller's handler read (M2c), changed rules do not
 * wait for offline nodes (M1), and a deleted node ends what waited for it (M3).
 */
import type { TaskSpec } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import { type ApprovalDecision, Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { deleteNode } from "../src/cluster/nodes.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { setRulePreset } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { probeDb, tableOf } from "./helpers/db-probe.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Long enough that a decision that awaited the dispatch would be visibly slower than the turn. */
const GRACE_MS = 400;

describe("approval handlers and task decisions (sqlite)", () => {
	let db: Db;
	let probe: ReturnType<typeof probeDb>;
	let cluster: Cluster;
	let groups: TaskGroups;
	let audit: Audit;
	let app: App;
	let aliceId = "";
	let aliceCookie = "";
	let rootCookie = "";

	const execSpec = (...argv: string[]): TaskSpec => ({
		kind: "exec",
		command: { argv },
		env: {},
		cwd: "",
		stdin: null,
	});

	const addNode = async (name: string): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		const orgId = await defaultOrgId(db);
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: orgId,
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
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: orgId,
				grantee_type: "user",
				grantee_id: aliceId,
				target_type: "node",
				target_id: id,
				created_by_user_id: aliceId,
				created_at: now,
			})
			.execute();
		return id;
	};

	const newToken = async (rulePreset = "ask"): Promise<string> => {
		const res = await call(app, "/api/api-tokens", { cookie: aliceCookie, body: { name: "t", rulePreset } });
		expect(res.status).toBe(201);
		return ((await res.json()) as { apiToken: { id: string } }).apiToken.id;
	};

	const mkTask = async (tokenId: string, nodeId: string): Promise<TaskView> =>
		cluster.createTask({
			nodeId,
			spec: execSpec("echo", "hi"),
			chain: [{ type: "api_token", id: tokenId }],
			actor: { type: "api_token", id: tokenId, onBehalfOfUserId: aliceId },
		});

	const rowOf = async (id: string) => db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();

	const decision = (kind: "approved" | "rejected", reason?: string): ApprovalDecision => ({
		decision: kind,
		by: { type: "user", id: aliceId, onBehalfOfUserId: aliceId },
		at: new Date().toISOString(),
		...(reason ? { reason } : {}),
	});

	const pending = async (): Promise<{ tasks: TaskView[] }> =>
		(await (await call(app, "/api/approvals", { cookie: aliceCookie })).json()) as { tasks: TaskView[] };

	/** A row a previous process left waiting, without a task flow that would settle it first. */
	const insertWaiting = async (
		nodeId: string,
		state: "awaiting_approval" | "awaiting_authorization",
	): Promise<string> => {
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
				state,
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: aliceId,
				on_behalf_of_user_id: aliceId,
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
				handler_type: state === "awaiting_approval" ? "user" : null,
				handler_session_id: null,
			})
			.execute();
		return id;
	};

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		probe = probeDb(db);
		audit = new Audit(probe.db);
		cluster = new Cluster(probe.db, { audit, nodeOfflineGraceMs: GRACE_MS });
		groups = new TaskGroups(probe.db, cluster, { audit });
		app = makeApp(probe.db, undefined, { cluster, taskGroups: groups, audit });
		aliceId = (await createUser(db, { username: "alice", kind: "member", password: "password-123" })).id;
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		aliceCookie = await login(app, "alice", "password-123");
		rootCookie = await login(app, "root", "password-123");
	});

	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("clears the handler with the approval, so a second decision is refused during the grace", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, await addNode("approve-handler"));
		expect(t.handlerType).toBe("user");
		expect((await pending()).tasks.map((task) => task.id)).toContain(t.id);

		const approving = cluster.decide(t.id, decision("approved"));
		await waitFor("the approval cleared the handler", async () => (await rowOf(t.id))?.handler_type === null);
		const approved = await rowOf(t.id);
		expect(approved).toMatchObject({
			state: "awaiting_approval",
			handler_type: null,
			handler_session_id: null,
		});
		// The inbox is filtered by handler, so the approved row is no longer a request for the user.
		expect((await pending()).tasks.map((task) => task.id)).not.toContain(t.id);
		// A late agent routing or Auto Review must not re-open the row either.
		expect(await cluster.requestAgentDecision(t.id, "agent-1")).toBe(false);
		await cluster.recordReview(t.id, { decision: "approve", reason: "late review", model: "test-model" });
		const untouched = await rowOf(t.id);
		expect(untouched).toMatchObject({ handler_type: null });
		expect(JSON.parse(untouched?.approval ?? "{}").review).toBeUndefined();

		// A reject after the approval must not end an approved task, and it does not wait for the grace.
		const started = Date.now();
		expect(await cluster.decide(t.id, decision("rejected", "changed my mind"))).toBe(false);
		expect(Date.now() - started).toBeLessThan(GRACE_MS / 2);
		const viaRoute = await call(app, `/api/tasks/${t.id}/approval`, {
			cookie: aliceCookie,
			body: { decision: "reject" },
		});
		expect(viaRoute.status).toBe(409);

		expect(await approving).toBe("approved");
		expect(await rowOf(t.id)).toMatchObject({ state: "failed", error_code: "node_offline" });
	});

	it("ends an approval that survives a restart as interrupted, not as a fresh request", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, await addNode("restart-handler"));
		const approving = cluster.decide(t.id, decision("approved"));
		await waitFor("the approval cleared the handler", async () => (await rowOf(t.id))?.handler_type === null);

		// A restart finds the row in the allowed shape between its decision and its claim.
		await cluster.recover();
		expect(await rowOf(t.id)).toMatchObject({
			state: "failed",
			error_code: "dispatch_interrupted",
			handler_type: null,
		});
		expect(await approving).toBe("approved");
	});

	it("does not re-judge a row that is already allowed and being dispatched", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, await addNode("dispatching-handler"));
		const approving = cluster.decide(t.id, decision("approved"));
		await waitFor("the approval cleared the handler", async () => (await rowOf(t.id))?.handler_type === null);
		const before = (await rowOf(t.id))?.approval;

		// The new rules would allow the task, but the row is not waiting for a decision any more.
		await setRulePreset(db, { type: "api_token", id: tok }, "yolo");
		await cluster.reevaluate({ type: "api_token", id: tok });

		const after = await rowOf(t.id);
		expect(after?.approval).toBe(before);
		expect(after).toMatchObject({ state: "awaiting_approval", handler_type: null });
		expect(await approving).toBe("approved");
		expect(await rowOf(t.id)).toMatchObject({ state: "failed", error_code: "node_offline" });
	});

	it("re-checks the route's handler read in the decision turn", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, await addNode("toctou-handler"));
		// The route reads the task as handled by the user; before its decision turn runs, an agent takes it.
		probe.onNext(
			(node) => node.kind === "SelectQueryNode" && tableOf(node) === "tasks",
			async () => {
				await db
					.updateTable("tasks")
					.set({ handler_type: "agent", handler_session_id: "agent-1" })
					.where("id", "=", t.id)
					.execute();
			},
		);
		const res = await call(app, `/api/tasks/${t.id}/approval`, {
			cookie: aliceCookie,
			body: { decision: "reject" },
		});
		expect(res.status).toBe(409);
		expect(await rowOf(t.id)).toMatchObject({ state: "awaiting_approval", handler_type: "agent" });

		// The agent route passes its own session id; another handler is refused, the routed one decides.
		expect(await cluster.decide(t.id, decision("rejected"), { handlerType: "user" })).toBe(false);
		expect(
			await cluster.decide(t.id, decision("rejected"), { handlerType: "agent", handlerSessionId: "agent-2" }),
		).toBe(false);
		expect(
			await cluster.decide(t.id, decision("rejected"), { handlerType: "agent", handlerSessionId: "agent-1" }),
		).toBe("rejected");
	});

	it("checks a task group's handler in its decide turn too", async () => {
		const tok = await newToken();
		const node = await addNode("group-handler");
		const id = await groups.create({
			targets: [node],
			nodeIds: [node],
			spec: execSpec("true"),
			actor: { type: "api_token", id: tok, onBehalfOfUserId: aliceId },
			chain: [{ type: "api_token", id: tok }],
		});
		expect((await groups.get(id))?.state).toBe("awaiting_approval");
		expect(await groups.requestAgentDecision(id, "agent-1")).toBe(true);

		expect(await groups.decide(id, decision("rejected"), { handlerType: "user" })).toBe(false);
		expect(await groups.decide(id, decision("rejected"), { handlerType: "agent", handlerSessionId: "agent-2" })).toBe(
			false,
		);
		expect(await groups.decide(id, decision("rejected"), { handlerType: "agent", handlerSessionId: "agent-1" })).toBe(
			true,
		);
		expect((await groups.get(id))?.state).toBe("rejected");
	});

	it("returns from reevaluate without waiting out an offline node's grace", async () => {
		const tok = await newToken();
		const t = await mkTask(tok, await addNode("reevaluate-allow"));
		await setRulePreset(db, { type: "api_token", id: tok }, "yolo");

		const started = Date.now();
		await cluster.reevaluate({ type: "api_token", id: tok });
		const reevaluateMs = Date.now() - started;
		// The allow is recorded and dispatched in the background; the call does not hold the HTTP request
		// for the node's offline grace.
		expect(reevaluateMs).toBeLessThan(GRACE_MS / 2);
		await waitFor("the allow recorded", async () => (await rowOf(t.id))?.handler_type === null);
		const decided = await rowOf(t.id);
		expect(decided).toMatchObject({ state: "awaiting_approval", handler_type: null });
		expect(JSON.parse(decided?.approval ?? "{}").decision).toMatchObject({ decision: "approved" });

		await cluster.drain();
		expect(await rowOf(t.id)).toMatchObject({ state: "failed", error_code: "node_offline" });
	});

	it("ends a deleted node's waiting tasks through the API route", async () => {
		const node = await addNode("delete-waiting");
		const tok = await newToken();
		const approval = await mkTask(tok, node);
		const authorization = await insertWaiting(node, "awaiting_authorization");

		const res = await call(app, `/api/nodes/${node}`, { method: "DELETE", cookie: rootCookie, body: {} });
		expect(res.status).toBe(200);
		for (const id of [approval.id, authorization]) {
			expect(await rowOf(id)).toMatchObject({
				state: "failed",
				error_code: "node_deleted",
				handler_type: null,
				handler_session_id: null,
				finished_at: expect.any(String),
			});
		}
	});

	it("ends a task whose node was gone when its approval arrived, without appending the rule", async () => {
		const node = await addNode("delete-before-approval");
		const tok = await newToken();
		const t = await mkTask(tok, node);
		// The node row is gone, but the task still waits (tasks.node_id has no foreign key).
		await deleteNode(db, node);

		const res = await call(app, `/api/tasks/${t.id}/approval`, {
			cookie: aliceCookie,
			body: { decision: "approve", always: { action: "allow", method: "exec" } },
		});
		expect(res.status).toBe(200);
		const ended = await rowOf(t.id);
		expect(ended).toMatchObject({ state: "failed", error_code: "node_deleted", handler_type: null });
		expect(JSON.parse(ended?.approval ?? "{}").decision).toMatchObject({ decision: "approved" });

		const list = (await (await call(app, "/api/api-tokens", { cookie: aliceCookie })).json()) as {
			tokens: { id: string; rules: { rules: unknown[] } }[];
		};
		expect(list.tokens.find((token) => token.id === tok)?.rules.rules).toEqual([]);
	});
});
