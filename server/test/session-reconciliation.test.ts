import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Startup reconciliation (doc/design/agent-runtime.md "Session state"): after durable resumed the runs, crhs corrects every
 * cached session state before accepting requests — a settled run is idle, an unsettled one is running or
 * awaiting on a surviving wait — and logs each correction.
 */

const faux = fauxProvider();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
	what: string,
	probe: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

describe("startup reconciliation", () => {
	let dir = "";
	let localDb: Db;
	let localCluster: Cluster;
	let localGroups: TaskGroups;
	let models: ModelConfig;
	let localOwner: SessionUser;
	const localModel = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

	const openWith = async (storage: Storage): Promise<AgentRuntime> =>
		AgentRuntime.open({
			db: localDb,
			storage,
			models,
			cluster: localCluster,
			taskGroups: localGroups,
			audit: new Audit(localDb),
		});

	const open = async (): Promise<AgentRuntime> =>
		openWith(await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }));

	/**
	 * Opens the runtime with a spy on the storage's submission lookups: every read durable makes for one
	 * submission passes through here, so the calls are exactly the per-session reads reconciliation may make.
	 */
	const openCountingReads = async (): Promise<{ runtime: AgentRuntime; reads: string[] }> => {
		const storage = await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" });
		const lookup = vi.spyOn(storage, "submission");
		const runtime = await openWith(storage);
		return { runtime, reads: lookup.mock.calls.map(([id]) => String(id)) };
	};

	const localRow = async (id: string) =>
		localDb
			.selectFrom("sessions")
			.select(["state", "waiting_kind", "waiting_level_id"])
			.where("id", "=", id)
			.executeTakeFirstOrThrow();

	/** Corrections are logged, not audited; the collected lines are what the assertions look at. */
	const captureLog = () => {
		const lines: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		return { lines, restore: () => log.mockRestore() };
	};

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "crh-session-reconcile-"));
		localDb = await openTestDb("sqlite");
		const audit = new Audit(localDb);
		localCluster = new Cluster(localDb, { audit });
		localGroups = new TaskGroups(localDb, localCluster, { audit });
		models = new ModelConfig(localDb, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		const user = await createUser(localDb, { username: "reconcile-owner", kind: "member", password: "password-123" });
		localOwner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
		const now = new Date().toISOString();
		const nodeId = newId();
		await localDb
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(localDb),
				name: "web-1-reconcile",
				name_key: "web-1-reconcile",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "web-1-reconcile",
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
		await localDb
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(localDb),
				grantee_type: "user",
				grantee_id: localOwner.userId,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: localOwner.userId,
				created_at: now,
			})
			.execute();
	});

	afterAll(async () => {
		localCluster.endWaits();
		localGroups.endWaits();
		await localCluster.close();
		await localGroups.close();
		await localDb.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	it("turns a run that ended while the process was down into idle", async () => {
		const first = await open();
		const session = await first.createSession(localOwner, {
			model: localModel(),
			rulePreset: "yolo",
			title: "settled while down",
		});
		faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		const submission = await first.submit(session.id, localOwner, "go", "reconcile-settled");
		expect(await waitSubmission(first, session.id, submission)).toMatchObject({ status: "done" });
		await waitFor("idle", async () => ((await localRow(session.id)).state === "idle" ? true : undefined));
		// The process died after the run ended but before the state write: a stale `running` row.
		await localDb.updateTable("sessions").set({ state: "running" }).where("id", "=", session.id).execute();
		await first.close();

		const log = captureLog();
		try {
			const second = await open();
			try {
				expect(await localRow(session.id)).toMatchObject({ state: "idle", waiting_kind: null });
				expect(log.lines.some((line) => line.includes(session.id) && line.endsWith("running -> idle"))).toBe(true);
			} finally {
				await second.close();
			}
		} finally {
			log.restore();
		}
	});

	/**
	 * The official SQLite storage, with one commit made to fail on demand: that closes the Harness. The
	 * factory makes a fresh storage the way main.ts does, for the supervisor's reopen.
	 */
	const failingStorage = () => {
		let failNext = false;
		const factory = async (): Promise<Storage> => {
			const real = await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" });
			return new Proxy(real, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					if (prop !== "commit") return value.bind(target);
					return (...args: unknown[]) => {
						if (failNext) {
							failNext = false;
							return Promise.reject(new Error("injected storage failure"));
						}
						return value.apply(target, args);
					};
				},
			});
		};
		return {
			factory,
			failOnce: () => {
				failNext = true;
			},
		};
	};

	it("reconciles and re-arms the watches when #supervise reopens the Harness", async () => {
		const storage = failingStorage();
		const first = await AgentRuntime.open({
			db: localDb,
			storage: storage.factory,
			models,
			cluster: localCluster,
			taskGroups: localGroups,
			audit: new Audit(localDb),
		});
		try {
			const session = await first.createSession(localOwner, {
				model: localModel(),
				rulePreset: "yolo",
				title: "reopened while running",
			});
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const gated = async () => {
				await gate;
				return fauxAssistantMessage([fauxText("after the reopen")]);
			};
			faux.setResponses([gated, gated]);
			const submission = await first.submit(session.id, localOwner, "go", "reopen-running-1");
			await waitFor("the run live", async () => ((await localRow(session.id)).state === "running" ? true : undefined));
			// The answer's commit fails, which closes the Harness and rejects the run's pending wait; the
			// supervisor reopens, and the resumed run commits the answer after a fresh model response.
			storage.failOnce();
			release();
			await waitFor("the Harness reopened", () => (first.reopened === 1 ? true : undefined), 10_000);
			// The failed wait is gone, so only the reopened reconciliation's watch can write idle.
			await waitFor(
				"idle after the reopen",
				async () => ((await localRow(session.id)).state === "idle" ? true : undefined),
				10_000,
			);
			expect(await waitSubmission(first, session.id, submission)).toMatchObject({ status: "done" });
		} finally {
			await first.close();
		}
	});

	it("ends the waits of a session the reopen reconciles to idle", async () => {
		const storage = failingStorage();
		const first = await AgentRuntime.open({
			db: localDb,
			storage: storage.factory,
			models,
			cluster: localCluster,
			taskGroups: localGroups,
			audit: new Audit(localDb),
		});
		try {
			// A session whose run is over but whose row still claims it (a lost settle write), with a task that
			// waits for a decision the settled run can no longer hand to its agent.
			const session = await first.createSession(localOwner, {
				model: localModel(),
				rulePreset: "ask",
				title: "waits through a reopen",
			});
			const settled = await first.createSession(localOwner, {
				model: localModel(),
				rulePreset: "yolo",
				title: "settled while the reopen runs",
			});
			faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
			const submission = await first.submit(session.id, localOwner, "go", "reopen-waits-1");
			expect(await waitSubmission(first, session.id, submission)).toMatchObject({ status: "done" });
			await waitFor("idle", async () => ((await localRow(session.id)).state === "idle" ? true : undefined));
			await localDb.updateTable("sessions").set({ state: "running" }).where("id", "=", session.id).execute();
			const node = await localDb.selectFrom("nodes").select("id").executeTakeFirstOrThrow();
			const waiting = await localCluster.createTask({
				nodeId: node.id,
				spec: { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null },
				chain: [{ type: "session", id: session.id }],
				actor: { type: "session", id: session.id, onBehalfOfUserId: localOwner.userId },
			});
			// A pending approval: the row waits with a handler, whoever it is.
			await localDb
				.updateTable("tasks")
				.set({ state: "awaiting_approval", handler_type: "user" })
				.where("id", "=", waiting.id)
				.execute();

			// Another run's answer makes a commit fail, which closes the Harness; the supervisor reopens it.
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			faux.setResponses([
				async () => {
					await gate;
					return fauxAssistantMessage([fauxText("after the reopen")]);
				},
				async () => {
					await gate;
					return fauxAssistantMessage([fauxText("after the reopen")]);
				},
			]);
			await first.submit(settled.id, localOwner, "go", "reopen-waits-2");
			await waitFor("the run live", async () => ((await localRow(settled.id)).state === "running" ? true : undefined));
			storage.failOnce();
			release();
			await waitFor("the Harness reopened", () => (first.reopened === 1 ? true : undefined), 10_000);
			// The reopened reconciliation writes idle for the settled session and ends its waits, as settleInput does.
			await waitFor(
				"the wait ended",
				async () => {
					const row = await localDb
						.selectFrom("tasks")
						.select(["state", "error_message"])
						.where("id", "=", waiting.id)
						.executeTakeFirstOrThrow();
					return row.state === "rejected" ? row : undefined;
				},
				10_000,
			);
			expect(await localRow(session.id)).toMatchObject({ state: "idle", waiting_kind: null });
		} finally {
			await first.close();
		}
	});

	it("recomputes a wait whose task was decided while the process was down", async () => {
		const first = await open();
		const session = await first.createSession(localOwner, {
			model: localModel(),
			rulePreset: "ask",
			title: "decided while down",
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: ["web-1-reconcile"], cmd: "true" }, { id: "reconcile-approval" })],
				{ stopReason: "toolUse" },
			),
			async () => {
				await sleep(400);
				return fauxAssistantMessage([fauxText("after the decision")]);
			},
		]);
		const submission = await first.submit(session.id, localOwner, "run it", "reconcile-approval-1");
		const task = await waitFor("the waiting task", async () => {
			const row = await localDb
				.selectFrom("tasks")
				.select("id")
				.where("actor_id", "=", session.id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			return row?.id;
		});
		await waitFor("awaiting/approval", async () => {
			const row = await localRow(session.id);
			return row.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
		});
		await first.close();
		// The decision was made while crhs was down: no callback is left to update the cached state.
		localCluster.onChange = undefined;
		localGroups.onChange = undefined;
		await localCluster.decide(task, {
			decision: "rejected",
			by: { type: "user", id: localOwner.userId },
			at: new Date().toISOString(),
		});

		const log = captureLog();
		try {
			const second = await open();
			try {
				expect(
					log.lines.some((line) => line.includes(session.id) && line.endsWith("awaiting/approval -> running")),
				).toBe(true);
				expect(await localRow(session.id)).toMatchObject({ state: "running", waiting_kind: null });
				expect(await waitSubmission(second, session.id, submission)).toEqual({
					status: "done",
					answer: "after the decision",
				});
				await waitFor("idle after the rerun", async () =>
					(await localRow(session.id)).state === "idle" ? true : undefined,
				);
			} finally {
				await second.close();
			}
		} finally {
			log.restore();
		}
	});

	it("turns an idle row with an unsettled input back into running", async () => {
		const first = await open();
		const session = await first.createSession(localOwner, {
			model: localModel(),
			rulePreset: "ask",
			title: "idle while unsettled",
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: ["web-1-reconcile"], cmd: "true" }, { id: "reconcile-idle" })],
				{
					stopReason: "toolUse",
				},
			),
			async () => {
				await sleep(400);
				return fauxAssistantMessage([fauxText("after the decision")]);
			},
		]);
		const submission = await first.submit(session.id, localOwner, "run it", "reconcile-idle-1");
		const task = await waitFor("the waiting task", async () => {
			const row = await localDb
				.selectFrom("tasks")
				.select("id")
				.where("actor_id", "=", session.id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			return row?.id;
		});
		await waitFor("awaiting/approval", async () => {
			const row = await localRow(session.id);
			return row.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
		});
		await first.close();
		localCluster.onChange = undefined;
		localGroups.onChange = undefined;
		await localCluster.decide(task, {
			decision: "rejected",
			by: { type: "user", id: localOwner.userId },
			at: new Date().toISOString(),
		});
		// A crashed write left `idle` on a session whose input has not ended.
		await localDb
			.updateTable("sessions")
			.set({ state: "idle", waiting_kind: null, waiting_level_id: null })
			.where("id", "=", session.id)
			.execute();

		const log = captureLog();
		try {
			const second = await open();
			try {
				expect(log.lines.some((line) => line.includes(session.id) && line.endsWith("idle -> running"))).toBe(true);
				expect(await localRow(session.id)).toMatchObject({ state: "running", waiting_kind: null });
				expect(await waitSubmission(second, session.id, submission)).toMatchObject({ status: "done" });
			} finally {
				await second.close();
			}
		} finally {
			log.restore();
		}
	});

	it("reconciles stale candidates only and never reads the submissions of idle sessions", async () => {
		const first = await open();
		const stale = await first.createSession(localOwner, {
			model: localModel(),
			rulePreset: "yolo",
			title: "stale running",
		});
		faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		const staleSubmission = await first.submit(stale.id, localOwner, "go", "reconcile-scale-stale");
		expect(await waitSubmission(first, stale.id, staleSubmission)).toMatchObject({ status: "done" });
		await waitFor("idle", async () => ((await localRow(stale.id)).state === "idle" ? true : undefined));
		// The process died before the settle write: the row still claims the run.
		await localDb.updateTable("sessions").set({ state: "running" }).where("id", "=", stale.id).execute();
		await first.close();

		// The fleet the system is sized for: 5,000 idle sessions, most with a settled latest input that durable
		// no longer lists (every tenth has no submission at all). None of them may cost a durable read.
		const orgId = await defaultOrgId(localDb);
		const model = JSON.stringify(localModel());
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		const settledSubmissions = new Set<string>();
		await localDb.transaction().execute(async (trx) => {
			for (let start = 0; start < 5_000; start += 500) {
				const rows = [];
				for (let index = start; index < Math.min(start + 500, 5_000); index++) {
					const id = `reconcile-idle-${String(index).padStart(5, "0")}`;
					const time = new Date(base + index * 1_000).toISOString();
					const lastSubmission = index % 10 === 0 ? null : String(9_000_000 + index);
					if (lastSubmission) settledSubmissions.add(lastSubmission);
					rows.push({
						id,
						org_id: orgId,
						owner_user_id: localOwner.userId,
						conversation_id: `conv-${index}`,
						parent_session_id: null,
						root_session_id: id,
						schedule_id: null,
						title: `idle ${index}`,
						model,
						status: "active" as const,
						created_at: time,
						updated_at: time,
						archived_at: null,
						last_submission_id: lastSubmission,
						state: "idle" as const,
						waiting_kind: null,
						waiting_level_id: null,
						waiting_handler_id: null,
						state_changed_at: time,
						quota_tokens: null,
					});
				}
				await trx.insertInto("sessions").values(rows).execute();
			}
		});

		const log = captureLog();
		try {
			const { runtime, reads } = await openCountingReads();
			try {
				// The one stale candidate is corrected, and nothing else is.
				expect(await localRow(stale.id)).toMatchObject({ state: "idle", waiting_kind: null });
				expect(log.lines.some((line) => line.includes(stale.id) && line.endsWith("running -> idle"))).toBe(true);
				expect(await localDb.selectFrom("sessions").select("id").where("state", "!=", "idle").execute()).toEqual([]);
				// The candidate's latest input is the only submission durable is asked about.
				expect(reads).toContain(staleSubmission);
				expect(reads.filter((id) => settledSubmissions.has(id))).toEqual([]);
			} finally {
				await runtime.close();
			}
		} finally {
			log.restore();
		}
	});

	it("finds an idle row with an unsettled input and a surviving wait through its latest submission", async () => {
		const first = await open();
		const session = await first.createSession(localOwner, {
			model: localModel(),
			rulePreset: "ask",
			title: "migrated awaiting",
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: ["web-1-reconcile"], cmd: "true" }, { id: "reconcile-migrated" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxText("after the decision")]),
		]);
		const submission = await first.submit(session.id, localOwner, "run it", "reconcile-migrated-1");
		const task = await waitFor("the waiting task", async () => {
			const row = await localDb
				.selectFrom("tasks")
				.select("id")
				.where("actor_id", "=", session.id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			return row?.id;
		});
		await waitFor("awaiting/approval", async () => {
			const row = await localRow(session.id);
			return row.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
		});
		await first.close();
		// 0029 maps a pre-migration `active` row to `idle`, so only the unsettled submission marks the row live.
		await localDb
			.updateTable("sessions")
			.set({ state: "idle", waiting_kind: null, waiting_level_id: null, waiting_handler_id: null })
			.where("id", "=", session.id)
			.execute();

		const log = captureLog();
		try {
			const { runtime, reads } = await openCountingReads();
			try {
				expect(log.lines.some((line) => line.includes(session.id) && line.endsWith("idle -> awaiting/approval"))).toBe(
					true,
				);
				expect(await localRow(session.id)).toMatchObject({ state: "awaiting", waiting_kind: "approval" });
				// The unresolved approval kept the run alive across the restart; it ends when the task is decided.
				expect(reads).toContain(submission);
				localCluster.onChange = undefined;
				localGroups.onChange = undefined;
				await localCluster.decide(task, {
					decision: "rejected",
					by: { type: "user", id: localOwner.userId },
					at: new Date().toISOString(),
				});
				expect(await waitSubmission(runtime, session.id, submission)).toMatchObject({ status: "done" });
				await waitFor("idle after the rerun", async () =>
					(await localRow(session.id)).state === "idle" ? true : undefined,
				);
			} finally {
				await runtime.close();
			}
		} finally {
			log.restore();
		}
	});
});
