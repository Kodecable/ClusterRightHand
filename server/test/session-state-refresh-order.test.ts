import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { type DbProbe, probeDb, tableOf } from "./helpers/db-probe.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Recomputations of one session run in order (doc/agent-runtime.md#会话状态): a request while one runs shares its
 * promise and asks for one more pass, and that pass reads the data again. Without the coalescing, a refresh
 * that read the task while it still waited for its signature can write its stale `awaiting` after a fresher
 * refresh already wrote `running`, leaving the session waiting for a decision that already happened.
 */

const faux = fauxProvider();
const TASK: TaskSpec = { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

let db: Db;
let probe: DbProbe;
let cluster: Cluster;
let groups: TaskGroups;
let runtime: AgentRuntime;
let owner: SessionUser;

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	groups = new TaskGroups(db, cluster, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	probe = probeDb(db);
	runtime = await AgentRuntime.open({
		db: probe.db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: groups,
		audit,
	});
	const user = await createUser(db, { username: "refresh-order-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
});

afterAll(async () => {
	await runtime.close();
	cluster.endWaits();
	groups.endWaits();
	await cluster.close();
	await groups.close();
	await db.destroy();
});

/**
 * A task acting for `sessionId`, inserted in `awaiting_authorization` the way the cluster parks it. Inserted
 * directly so creating it never fires the cluster's change hook, which would start a background refresh of
 * its own and compete with the one the test drives.
 */
async function waitingTask(sessionId: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("tasks")
		.values({
			id,
			org_id: await defaultOrgId(db),
			node_id: newId(),
			task_group_id: null,
			kind: TASK.kind,
			spec: JSON.stringify(taskSpecToJson(TASK)),
			input_size: null,
			input_sha256: null,
			privileged: 0,
			attempt: 1,
			timeout_ms: null,
			output_mode: "full",
			state: "awaiting_authorization",
			exit_code: null,
			signal: null,
			timed_out: 0,
			cancelled: 0,
			error_code: null,
			error_message: null,
			actor_type: "session",
			actor_id: sessionId,
			on_behalf_of_user_id: owner.userId,
			created_at: now,
			dispatched_at: null,
			accepted_at: null,
			finished_at: null,
			output_bytes: 0,
			output_head: null,
			output_tail: null,
			notice: null,
			output_file: null,
			result: null,
			late_result: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: null,
			handler_session_id: null,
		})
		.execute();
	return id;
}

it("writes the state of the latest recompute, not a stale awaiting", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let submission: string | undefined;
	try {
		const session = await runtime.createSession(owner, {
			model: { provider: faux.provider.id, modelId: faux.getModel().id },
			preset: "yolo",
			title: "refresh order",
		});
		// Hold a real run open: with a settled latest input refreshState computes idle before it reads tasks.
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("done")]);
			},
		]);
		submission = await runtime.submit(session.id, owner, "go", "refresh-order-1");
		await waitFor("the run live", async () =>
			(await sessionStateOf(db, session.id)) === "running" ? true : undefined,
		);
		expect(await sessionStateOf(db, session.id)).toBe("running");
		const task = await waitingTask(session.id);

		let reached!: () => void;
		const reachedP = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let resume!: () => void;
		const resumeP = new Promise<void>((resolve) => {
			resume = resolve;
		});
		// Pause refresh A after the authorization lookup, its second `tasks` read: the query already returned the
		// waiting row, so A holds `awaiting_authorization` while the row below moves on to `dispatched`.
		let taskReads = 0;
		probe.onNext(
			(node) => tableOf(node) === "tasks" && ++taskReads === 2,
			async () => {
				reached();
				await resumeP;
			},
		);

		const first = runtime.refreshState(session.id);
		await reachedP;
		await db.updateTable("tasks").set({ state: "dispatched" }).where("id", "=", task).execute();
		const second = runtime.refreshState(session.id);
		// With the fix `second` shares A's promise and cannot settle before the release; without it the call
		// recomputes on its own, so let that pass finish before A's stale write and the interleaving is forced.
		await Promise.race([
			second.then(
				() => undefined,
				() => undefined,
			),
			sleep(100),
		]);
		resume();

		const states = await Promise.all([first, second]);
		const row = await db
			.selectFrom("sessions")
			.select(["state", "waiting_kind"])
			.where("id", "=", session.id)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ state: "running", waiting_kind: null });
		expect(states).toEqual(["running", "running"]);
	} finally {
		release();
		if (submission) await runtime.waitForSubmission(submission);
	}
});
