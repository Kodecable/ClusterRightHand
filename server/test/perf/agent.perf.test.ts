import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelConfig } from "../../src/agent/models.ts";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import type { SessionUser } from "../../src/auth/sessions.ts";
import { Cluster } from "../../src/cluster/cluster.ts";
import { TaskGroups } from "../../src/cluster/task-groups.ts";
import { MasterKey } from "../../src/keys/master-key.ts";
import type { Db } from "../../src/storage/db.ts";
import { createUser } from "../../src/users/service.ts";
import { openTestDb } from "../helpers/db.ts";

// doc/agent-runtime.md#2-性能和内存回归: faux model, real SQLite storage. Run with `pnpm test:perf` (not in the
// regular suites: timings depend on the machine). Bounds are loose multiples of the research baseline.

const gc = (globalThis as { gc?: () => void }).gc;
const heapMiB = () => {
	gc?.();
	gc?.();
	return process.memoryUsage().heapUsed / 2 ** 20;
};

describe("agent runtime performance", () => {
	let tmp = "";
	let db: Db;
	let owner: SessionUser;
	const faux = fauxProvider();
	const model = { provider: faux.provider.id, modelId: faux.getModel().id };
	let cluster: Cluster;

	const open = async () => {
		const models = new ModelConfig(db, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		return AgentRuntime.open({
			db,
			storage: await openNodeSqliteStorage(join(tmp, "durable.sqlite"), { prefix: "pi_" }),
			models,
			cluster,
			groups: new TaskGroups(db, cluster),
			retentionMs: 0,
		});
	};

	/** One turn: a list_nodes tool call (a real cluster tool, hitting the database), then an answer. */
	const turn = (i: number): FauxResponseStep[] => [
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: `c${i}` })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText(`answer ${i} ${"x".repeat(2000)}`)]),
	];

	const run = async (runtime: AgentRuntime, sessionId: string, i: number) => {
		const sub = await runtime.submit(sessionId, owner, `question ${i}`, `r${i}`);
		const settled = await runtime.waitSubmission(sessionId, sub);
		expect(settled.status).toBe("done");
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-perf-"));
		db = await openTestDb("sqlite");
		cluster = new Cluster(db);
		const u = await createUser(db, { username: "perf", kind: "admin", password: "perf-password" });
		owner = { userId: u.id, username: "perf", kind: "admin", sessionId: "perf" };
	});

	afterAll(async () => {
		await cluster.close();
		await db.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	it("20 sessions x 10 turns: throughput, and the heap returns near its baseline", async () => {
		const runtime = await open();
		try {
			const before = heapMiB();
			const sessions = await Promise.all(
				Array.from({ length: 20 }, (_, i) => runtime.createSession(owner, { model, preset: "yolo", title: `s${i}` })),
			);
			faux.setResponses(Array.from({ length: 200 }, (_, i) => turn(i)).flat());
			const t0 = performance.now();
			// Turns run one at a time per session, sessions side by side; faux answers in queue order.
			for (let round = 0; round < 10; round++) {
				for (const s of sessions) await run(runtime, s.id, round);
			}
			const perSecond = 200 / ((performance.now() - t0) / 1000);
			await runtime.waitForIdle();
			const after = heapMiB();
			console.log(`throughput ${perSecond.toFixed(0)} turns/s, heap ${before.toFixed(0)} -> ${after.toFixed(0)} MiB`);
			expect(perSecond).toBeGreaterThan(15);
			if (gc) expect(after - before).toBeLessThan(40);
		} finally {
			await runtime.close();
		}
	}, 300_000);

	it("one long session: turn latency does not grow with its length", async () => {
		const runtime = await open();
		try {
			const s = await runtime.createSession(owner, { model, preset: "yolo" });
			faux.setResponses(Array.from({ length: 120 }, (_, i) => turn(i)).flat());
			const times: number[] = [];
			for (let i = 0; i < 120; i++) {
				const t0 = performance.now();
				await run(runtime, s.id, i);
				times.push(performance.now() - t0);
			}
			const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
			const early = mean(times.slice(10, 30));
			const late = mean(times.slice(-20));
			console.log(`turn latency early ${early.toFixed(1)} ms, late ${late.toFixed(1)} ms`);
			expect(late).toBeLessThan(Math.max(early * 2.5, early + 20));
		} finally {
			await runtime.close();
		}
	}, 300_000);

	it("reopening with existing sessions is fast, and so is an old session's first turn", async () => {
		const t0 = performance.now();
		const runtime = await open();
		const openMs = performance.now() - t0;
		try {
			const [old] = await runtime.listSessions(owner);
			faux.setResponses(turn(999));
			const t1 = performance.now();
			await run(runtime, old?.id as string, 999);
			const firstTurnMs = performance.now() - t1;
			console.log(`reopen ${openMs.toFixed(0)} ms, first turn of an old session ${firstTurnMs.toFixed(0)} ms`);
			expect(openMs).toBeLessThan(2000);
			expect(firstTurnMs).toBeLessThan(1000);
		} finally {
			await runtime.close();
		}
	}, 60_000);
});
