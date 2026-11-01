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
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";
import { type DbProbe, probeDb, tableOf } from "./helpers/db-probe.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A recompute must not revive a session that settled while it ran (doc/agent-runtime.md#会话状态): the state
 * it computed from its stale row is written only while the row is still live. The runtime gets a database with a
 * one-shot probe, so the settle lands deterministically inside the read-then-write gap.
 */

const faux = fauxProvider();
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
		groups,
		audit,
	});
	const user = await createUser(db, { username: "race-owner", kind: "member", password: "password-123" });
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

it("keeps the session idle when its run ends during a recompute", async () => {
	const session = await runtime.createSession(owner, {
		model: { provider: faux.provider.id, modelId: faux.getModel().id },
		preset: "yolo",
		title: "recompute race",
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("done")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "go", "recompute-race-1");
	await waitFor("the run live", async () => ((await sessionStateOf(db, session.id)) === "running" ? true : undefined));

	// Hold refreshState at its `tasks` lookup: the run ends (and #settleInput writes idle) while it is there, so
	// the state it computed from the stale row would turn the session back to running.
	let reached!: () => void;
	const reachedP = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let resume!: () => void;
	const resumeP = new Promise<void>((resolve) => {
		resume = resolve;
	});
	probe.onNext(
		(node) => tableOf(node) === "tasks",
		async () => {
			reached();
			await resumeP;
		},
	);
	const refreshing = runtime.refreshState(session.id);
	await reachedP;
	release();
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
	resume();

	expect(await refreshing).toBe("idle");
	expect(await sessionStateOf(db, session.id)).toBe("idle");
	expect(await runtime.waitForSubmission(String(submission))).toMatchObject({ status: "done" });
});
