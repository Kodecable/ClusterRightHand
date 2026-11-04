import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	DocumentCreate,
	DocumentId,
	Storage,
	StorageWrite,
	TaskId,
	TaskRecord,
	TaskState,
} from "@earendil-works/pi-durable";
import { sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { PgStorage } from "../src/agent/pg-storage.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { RetentionConfig } from "../src/config.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { type Db, openAgentStorage, openDb } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";
import type { RetentionCounts, RetentionOptions } from "../src/storage/retention.ts";
import { AUDIT_SEQ_FLOOR, runRetention, startRetentionSweep } from "../src/storage/retention.ts";
import type { TaskState as ClusterTaskState, TaskGroupState } from "../src/storage/schema.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { type Backend, describeBackends, openTestDb, withDdlLockOn } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const NOW_MS = NOW.getTime();
/** Older than the default 90-day retention of tasks. */
const OLD = new Date(NOW_MS - 100 * DAY).toISOString();
/** Newer than the 90-day retention. */
const RECENT = new Date(NOW_MS - 1 * DAY).toISOString();
/** Older than the default 180-day retention of audit events. */
const AUDIT_OLD = new Date(NOW_MS - 200 * DAY).toISOString();
/** Older than the 7-day retention of durable tasks. */
const PI_OLD = NOW_MS - 10 * DAY;
/** Newer than the 7-day retention of durable tasks. */
const PI_RECENT = NOW_MS - 1 * DAY;
const RETENTION: RetentionConfig = { tasksMs: 90 * DAY, auditMs: 180 * DAY, piTasksMs: 7 * DAY };

interface OpenedStorage {
	storage: Storage;
	close(): Promise<void>;
}

/** A migrated crhs database with pi-durable's tables in it, as production opens them (storage/db.ts). */
interface Fixture {
	db: Db;
	openStorage(): Promise<OpenedStorage>;
	close(): Promise<void>;
}

/**
 * Opens crhs's database together with an agent storage on the same one: a SQLite file opened twice, or a
 * PostgreSQL schema reached through two pools. Retention reaches the pi_ tables through Kysely, so both
 * connections must point at the same database.
 */
async function openFixture(backend: Backend): Promise<Fixture> {
	if (backend === "sqlite") {
		const dir = await mkdtemp(join(tmpdir(), "crh-retention-"));
		const path = join(dir, "crhs.db");
		const db = openDb({ driver: "sqlite", path });
		await migrateToLatest(db);
		return {
			db,
			openStorage: () => openAgentStorage({ driver: "sqlite", path }),
			close: async () => {
				await db.destroy();
				await rm(dir, { recursive: true, force: true });
			},
		};
	}
	const url = process.env.CRH_TEST_PG_URL;
	if (url === undefined) throw new Error("CRH_TEST_PG_URL must be set for the postgres backend");
	const db = await openTestDb("postgres");
	const schema = (await sql<{ schema: string }>`select current_schema() as schema`.execute(db)).rows[0]?.schema;
	if (schema === undefined) throw new Error("the test database has no current schema");
	return {
		db,
		openStorage: async () => {
			const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
			try {
				const storage = await withDdlLockOn("postgres", () => PgStorage.open(pool, { prefix: "pi_" }));
				return {
					storage,
					close: async () => {
						await storage.close(BACKGROUND_CONTEXT);
						await pool.end();
					},
				};
			} catch (err) {
				await pool.end();
				throw err;
			}
		},
		close: async () => {
			await db.destroy();
		},
	};
}

describeBackends("retention sweep", (backend) => {
	let fixture: Fixture;
	let opened: OpenedStorage;
	let db: Db;
	let orgId: string;

	beforeEach(async () => {
		fixture = await openFixture(backend);
		opened = await fixture.openStorage();
		db = fixture.db;
		orgId = await defaultOrgId(db);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await opened.close();
		await fixture.close();
	});

	const insertTask = async (id: string, state: ClusterTaskState, finishedAt: string | null): Promise<void> => {
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: orgId,
				node_id: "node-1",
				task_group_id: null,
				kind: "exec",
				spec: "{}",
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "full",
				state,
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: "user-1",
				on_behalf_of_user_id: "user-1",
				created_at: OLD,
				dispatched_at: null,
				accepted_at: null,
				finished_at: finishedAt,
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
				handler_type: null,
				handler_session_id: null,
			})
			.execute();
	};

	const taskIds = async (): Promise<string[]> =>
		(await db.selectFrom("tasks").select("id").orderBy("id").execute()).map((row) => row.id);

	const insertTaskGroup = async (id: string, state: TaskGroupState, finishedAt: string | null): Promise<void> => {
		await db
			.insertInto("task_groups")
			.values({
				id,
				org_id: orgId,
				targets: "[]",
				node_ids: "[]",
				kind: "exec",
				parallel: 1,
				fail_fast: 0,
				output_mode: "status",
				privileged: 0,
				skipped: "[]",
				state,
				actor_type: "user",
				actor_id: "user-1",
				on_behalf_of_user_id: "user-1",
				created_at: OLD,
				finished_at: finishedAt,
				spec: null,
				timeout_ms: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: null,
				handler_session_id: null,
			})
			.execute();
	};

	const groupIds = async (): Promise<string[]> =>
		(await db.selectFrom("task_groups").select("id").orderBy("id").execute()).map((row) => row.id);

	const insertAuthorization = async (id: string, deadline: string | null): Promise<void> => {
		await db
			.insertInto("authorizations")
			.values({
				id,
				org_id: orgId,
				payload: "AA==",
				signatures: "[]",
				issuer_user_id: null,
				task_ids: null,
				deadline,
				created_at: OLD,
			})
			.execute();
	};

	const authorizationIds = async (): Promise<string[]> =>
		(await db.selectFrom("authorizations").select("id").orderBy("id").execute()).map((row) => row.id);

	const insertAuditEvent = async (seq: number, ts: string): Promise<void> => {
		await db
			.insertInto("audit_events")
			.values({
				seq,
				id: `event-${seq}`,
				org_id: orgId,
				ts,
				actor_type: "system",
				actor_id: "system",
				on_behalf_of_user_id: null,
				action: "test",
				target_type: null,
				target_id: null,
				detail: "{}",
			})
			.execute();
	};

	const auditSeqs = async (): Promise<number[]> =>
		(await db.selectFrom("audit_events").select("seq").orderBy("seq").execute()).map((row) => Number(row.seq));

	/* pi-durable rows are seeded through its own storage, so the tables have the layout its migrations make. */

	const ROOT = 1 as ConversationId;

	const commit = async (...writes: StorageWrite[]): Promise<void> => {
		await opened.storage.commit(writes, BACKGROUND_CONTEXT);
	};

	type SeedStatus = "pending" | "running" | "waiting" | "sleeping" | "completing" | "terminal";

	const taskRecord = (seed: {
		id: number;
		status: SeedStatus;
		endedAt?: number;
		owner?: number;
		on?: number[];
	}): TaskRecord<JsonValue, JsonValue, JsonValue> => {
		const state: TaskState<JsonValue, JsonValue> =
			seed.status === "terminal"
				? { status: "terminal", outcome: { status: "completed", result: null } }
				: seed.status === "completing"
					? { status: "completing", outcome: { status: "completed", result: null } }
					: seed.status === "waiting"
						? {
								status: "waiting",
								checkpoint: null,
								on: (seed.on ?? []).map((id) => id as TaskId),
								policy: "allSettled",
							}
						: seed.status === "sleeping"
							? { status: "sleeping", checkpoint: null, until: NOW_MS + DAY }
							: seed.status === "pending"
								? { status: "pending", checkpoint: null }
								: { status: "running", checkpoint: null };
		return {
			id: seed.id as TaskId,
			conversationId: ROOT,
			kind: "pi.tool",
			version: 1,
			input: null,
			background: false,
			abortRequested: false,
			...(seed.owner === undefined ? {} : { owner: seed.owner as TaskId }),
			...(seed.endedAt === undefined ? {} : { endedAt: seed.endedAt }),
			state,
		} as TaskRecord<JsonValue, JsonValue, JsonValue>;
	};

	const task = (seed: Parameters<typeof taskRecord>[0]): StorageWrite => ({
		type: "task",
		value: taskRecord(seed),
	});

	const conversation = (id: number, ownerTask?: number): StorageWrite => ({
		type: "conversation",
		value: {
			id: id as ConversationId,
			...(ownerTask === undefined ? {} : { owner: { conversationId: ROOT, taskId: ownerTask as TaskId } }),
		},
	});

	const document = (id: number, scope: { task: number } | { conversation: number }): StorageWrite => {
		const record = (
			"task" in scope
				? { id: id as DocumentId, kind: "pi.test", scope: { kind: "task", taskId: scope.task as TaskId } }
				: {
						id: id as DocumentId,
						kind: "pi.test",
						scope: { kind: "conversation", conversationId: scope.conversation as ConversationId },
						history: "latest",
						fork: "current",
					}
		) as DocumentCreate;
		return { type: "document.create", record, content: { kind: "base", version: 1, value: { note: "seed" } } };
	};

	const piTaskIds = async (): Promise<number[]> =>
		(await sql<{ id: number | string }>`select id from pi_tasks order by id`.execute(db)).rows.map((row) =>
			Number(row.id),
		);

	const piDocumentIds = async (): Promise<number[]> =>
		(await sql<{ id: number | string }>`select id from pi_documents order by id`.execute(db)).rows.map((row) =>
			Number(row.id),
		);

	const piRevisionDocumentIds = async (): Promise<number[]> =>
		(
			await sql<{
				document_id: number | string;
			}>`select distinct document_id from pi_document_revisions order by document_id`.execute(db)
		).rows.map((row) => Number(row.document_id));

	it("deletes old terminal tasks but keeps newer, non-terminal and unfinished rows", async () => {
		for (const state of ["exited", "failed", "rejected", "unknown", "denied"] as const) {
			await insertTask(`old-${state}`, state, OLD);
		}
		await insertTask("recent-exited", "exited", RECENT);
		for (const state of ["running", "dispatched", "awaiting_approval", "awaiting_authorization"] as const) {
			await insertTask(`old-${state}`, state, OLD);
		}
		await insertTask("old-exited-without-finish", "exited", null);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.tasks).toBe(5);
		expect(await taskIds()).toEqual([
			"old-awaiting_approval",
			"old-awaiting_authorization",
			"old-dispatched",
			"old-exited-without-finish",
			"old-running",
			"recent-exited",
		]);
	});

	it("deletes old terminal task groups only", async () => {
		for (const state of ["finished", "interrupted", "rejected"] as const) {
			await insertTaskGroup(`old-${state}`, state, OLD);
		}
		await insertTaskGroup("recent-finished", "finished", RECENT);
		for (const state of ["running", "awaiting_approval", "awaiting_authorization"] as const) {
			await insertTaskGroup(`old-${state}`, state, OLD);
		}
		await insertTaskGroup("old-finished-without-finish", "finished", null);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.taskGroups).toBe(3);
		expect(await groupIds()).toEqual([
			"old-awaiting_approval",
			"old-awaiting_authorization",
			"old-finished-without-finish",
			"old-running",
			"recent-finished",
		]);
	});

	it("deletes authorizations by deadline and leaves null deadlines alone", async () => {
		await insertAuthorization("expired-old", OLD);
		await insertAuthorization("expired-recent", RECENT);
		await insertAuthorization("future", new Date(NOW_MS + 30 * DAY).toISOString());
		await insertAuthorization("no-deadline", null);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.authorizations).toBe(1);
		expect(await authorizationIds()).toEqual(["expired-recent", "future", "no-deadline"]);
	});

	it("deletes old audit events only below max(seq) - 16384", async () => {
		for (let seq = 1; seq <= 10; seq++) await insertAuditEvent(seq, AUDIT_OLD);
		// Exactly on the floor (20000 - 16384 = 3616) is deletable; just above it is kept.
		await insertAuditEvent(3616, AUDIT_OLD);
		await insertAuditEvent(3617, AUDIT_OLD);
		await insertAuditEvent(5000, AUDIT_OLD);
		await insertAuditEvent(20000, AUDIT_OLD);

		const counts = await runRetention(db, { tasksMs: null, auditMs: RETENTION.auditMs, piTasksMs: null }, NOW);

		expect(counts.auditEvents).toBe(11);
		expect(await auditSeqs()).toEqual([3617, 5000, 20000]);
		expect(20000 - 3616).toBe(AUDIT_SEQ_FLOOR);
	});

	it("keeps old audit events that are all within the sequence floor", async () => {
		for (let seq = 1; seq <= 10; seq++) await insertAuditEvent(seq, AUDIT_OLD);

		const counts = await runRetention(db, { tasksMs: null, auditMs: RETENTION.auditMs, piTasksMs: null }, NOW);

		expect(counts.auditEvents).toBe(0);
		expect(await auditSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("deletes old terminal durable tasks but keeps recent, live and unfinished records", async () => {
		await commit(
			conversation(1),
			task({ id: 100, status: "terminal", endedAt: PI_OLD }),
			task({ id: 101, status: "terminal", endedAt: PI_RECENT }),
			// A record without endedAt (an older pi-durable wrote none) is never deleted.
			task({ id: 102, status: "terminal" }),
			task({ id: 103, status: "running" }),
			// `completing` is live in pi-durable: it must survive however old its record is.
			task({ id: 104, status: "completing" }),
			task({ id: 105, status: "waiting", on: [] }),
			task({ id: 106, status: "sleeping" }),
			task({ id: 107, status: "pending" }),
		);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.piTasks).toBe(1);
		expect(await piTaskIds()).toEqual([101, 102, 103, 104, 105, 106, 107]);
	});

	it("keeps a terminal task that owns live work", async () => {
		await commit(
			conversation(1),
			task({ id: 200, status: "terminal", endedAt: PI_OLD }),
			task({ id: 201, status: "running", owner: 200 }),
			task({ id: 202, status: "terminal", endedAt: PI_OLD }),
		);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.piTasks).toBe(1);
		expect(await piTaskIds()).toEqual([200, 201]);
	});

	it("keeps a terminal task a waiting task is still waiting on", async () => {
		await commit(
			conversation(1),
			task({ id: 300, status: "terminal", endedAt: PI_OLD }),
			task({ id: 301, status: "terminal", endedAt: PI_OLD }),
			task({ id: 302, status: "waiting", on: [300, 301] }),
			task({ id: 303, status: "terminal", endedAt: PI_OLD }),
		);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.piTasks).toBe(1);
		expect(await piTaskIds()).toEqual([300, 301, 302]);
	});

	it("keeps a terminal task that owns a conversation", async () => {
		await commit(
			conversation(1),
			conversation(2, 400),
			task({ id: 400, status: "terminal", endedAt: PI_OLD }),
			task({ id: 401, status: "terminal", endedAt: PI_OLD }),
		);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.piTasks).toBe(1);
		expect(await piTaskIds()).toEqual([400]);
	});

	it("deletes the task-scoped documents of deleted tasks and keeps the others", async () => {
		await commit(
			conversation(1),
			task({ id: 500, status: "terminal", endedAt: PI_OLD }),
			task({ id: 501, status: "terminal", endedAt: PI_RECENT }),
			document(5000, { task: 500 }),
			document(5001, { task: 501 }),
			document(5002, { conversation: 1 }),
		);

		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts.piTasks).toBe(1);
		expect(await piTaskIds()).toEqual([501]);
		expect(await piDocumentIds()).toEqual([5001, 5002]);
		expect(await piRevisionDocumentIds()).toEqual([5001, 5002]);
	});

	it("keeps scanning when a full batch has nothing to delete", async () => {
		await commit(
			conversation(1),
			// The first full batch (ids 600, 601) is recent, so nothing in it qualifies; the sweep must go on.
			task({ id: 600, status: "terminal", endedAt: PI_RECENT }),
			task({ id: 601, status: "terminal", endedAt: PI_RECENT }),
			task({ id: 602, status: "terminal", endedAt: PI_OLD }),
			task({ id: 603, status: "terminal", endedAt: PI_OLD }),
			task({ id: 604, status: "terminal", endedAt: PI_OLD }),
			task({ id: 605, status: "terminal", endedAt: PI_OLD }),
			task({ id: 606, status: "terminal", endedAt: PI_OLD }),
		);

		const counts = await runRetention(db, RETENTION, NOW, { batchSize: 2 });

		expect(counts.piTasks).toBe(5);
		expect(await piTaskIds()).toEqual([600, 601]);
	});

	it("skips durable task retention when it is off", async () => {
		await commit(conversation(1), task({ id: 700, status: "terminal", endedAt: PI_OLD }));

		const counts = await runRetention(db, { tasksMs: null, auditMs: null, piTasksMs: null }, NOW);

		expect(counts.piTasks).toBe(0);
		expect(await piTaskIds()).toEqual([700]);
	});

	it("continues with the other tables when one table's deletion fails", async () => {
		await insertTask("old-exited", "exited", OLD);
		await insertTaskGroup("old-finished", "finished", OLD);
		await insertAuthorization("expired-old", OLD);
		await insertAuditEvent(1, AUDIT_OLD);
		await insertAuditEvent(20000, AUDIT_OLD);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Fail the tasks sweep the way a database error would; task groups, authorizations and audit events must
		// still be swept, and the last one proves the tables after the failure are not skipped.
		const real = db.selectFrom.bind(db);
		const selectFrom = vi.spyOn(db, "selectFrom").mockImplementation(((table: string) => {
			if (table === "tasks") throw new Error("tasks table is gone");
			return (real as (found: string) => unknown)(table);
		}) as never);
		const counts = await runRetention(db, RETENTION, NOW);
		selectFrom.mockRestore();

		expect(counts).toEqual({ tasks: 0, taskGroups: 1, authorizations: 1, auditEvents: 1, piTasks: 0 });
		expect(await taskIds()).toEqual(["old-exited"]);
		expect(await groupIds()).toEqual([]);
		expect(await authorizationIds()).toEqual([]);
		expect(await auditSeqs()).toEqual([20000]);
		expect(error).toHaveBeenCalledWith("retention: deleting tasks failed:", expect.any(Error));
		expect(console.log).toHaveBeenCalledTimes(1);
	});

	it("skips a table whose retention is off", async () => {
		await insertTask("old-exited", "exited", OLD);
		await insertAuditEvent(1, AUDIT_OLD);
		await insertAuditEvent(20000, AUDIT_OLD);

		const tasksOff = await runRetention(db, { tasksMs: null, auditMs: RETENTION.auditMs, piTasksMs: null }, NOW);
		expect(tasksOff.tasks).toBe(0);
		expect(tasksOff.auditEvents).toBe(1);
		expect(await taskIds()).toEqual(["old-exited"]);

		const auditOff = await runRetention(db, { tasksMs: RETENTION.tasksMs, auditMs: null, piTasksMs: null }, NOW);
		expect(auditOff.tasks).toBe(1);
		expect(auditOff.auditEvents).toBe(0);
		expect(await auditSeqs()).toEqual([20000]);
	});

	it("deletes in batches until a batch is short", async () => {
		for (let i = 0; i < 5; i++) await insertTask(`old-${i}`, "exited", OLD);

		const counts = await runRetention(db, RETENTION, NOW, { batchSize: 2 });

		expect(counts.tasks).toBe(5);
		expect(await taskIds()).toEqual([]);
		expect(console.log).toHaveBeenCalledTimes(1);
	});

	it("stops between batches when the signal aborts", async () => {
		for (let i = 0; i < 5; i++) await insertTask(`old-${i}`, "exited", OLD);

		// false on the first check, so the first batch runs; true afterwards, so it stops between batches.
		let checks = 0;
		const signal = {
			get aborted(): boolean {
				checks++;
				return checks > 1;
			},
		} as unknown as AbortSignal;
		const counts = await runRetention(db, { tasksMs: RETENTION.tasksMs, auditMs: null, piTasksMs: null }, NOW, {
			batchSize: 2,
			signal,
		});

		expect(counts.tasks).toBe(2);
		expect(await taskIds()).toHaveLength(3);

		// An already-aborted signal deletes nothing at all.
		const aborted = new AbortController();
		aborted.abort();
		const stopped = await runRetention(db, RETENTION, NOW, { signal: aborted.signal });
		expect(stopped).toEqual({ tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0, piTasks: 0 });
	});

	it("logs nothing when no rows are deleted", async () => {
		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts).toEqual({ tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0, piTasks: 0 });
		expect(console.log).not.toHaveBeenCalled();
	});
});

describeBackends("durable task retention and the agent runtime", (backend) => {
	it("keeps a session working after its old terminal tasks and documents are deleted", async () => {
		const fixture = await openFixture(backend);
		const faux = fauxProvider();
		const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
		let opened: OpenedStorage | undefined;
		let runtime: AgentRuntime | undefined;
		let cluster: Cluster | undefined;
		let groups: TaskGroups | undefined;
		try {
			opened = await fixture.openStorage();
			const db = fixture.db;
			const audit = new Audit(db);
			cluster = new Cluster(db, { audit });
			groups = new TaskGroups(db, cluster, { audit });
			const models = new ModelConfig(db, MasterKey.generate());
			models.addProvider(faux.provider);
			await models.reload();
			const options = {
				db,
				models,
				cluster,
				taskGroups: groups,
				audit,
				// A tiny recent window lets a manual compaction cut the short history; no background compaction.
				compaction: { keepRecentTokens: 1, backgroundTokens: 0 },
			};
			runtime = await AgentRuntime.open({ ...options, storage: opened.storage });
			const user = await createUser(db, { username: "retention-owner", kind: "member", password: "password-123" });
			const owner: SessionUser = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
			const session = await runtime.createSession(owner, { model: model(), preset: "yolo", title: "retention" });

			// One tool call: a generation task and a tool task, both terminal when the answer arrives.
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "retention-tool" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("tool finished")]),
			]);
			const first = await runtime.submit(session.id, owner, "list the nodes", "retention-1");
			expect(await waitSubmission(runtime, session.id, first)).toEqual({ status: "done", answer: "tool finished" });

			// A compaction adds a third kind of terminal task.
			faux.setResponses([fauxAssistantMessage([fauxText("summary")])]);
			const compaction = await runtime.compact(session.id, owner, "keep node names");
			expect(compaction.outcome).toBe("started");
			await vi.waitFor(
				async () => {
					// The kind column holds the JSON-encoded string (both storages encode indexed identities).
					const rows = await sql<{ count: number | string }>`
						select count(*) as count from pi_tasks
						where kind = ${JSON.stringify("pi.compaction")} and status = 'terminal'`.execute(db);
					expect(Number(rows.rows[0]?.count ?? 0)).toBeGreaterThan(0);
				},
				{ timeout: 15_000, interval: 50 },
			);
			// Everything the run started is now settled, so retention can delete the whole set.
			await vi.waitFor(
				async () => {
					const rows = await sql<{ count: number | string }>`
						select count(*) as count from pi_tasks where status <> 'terminal'`.execute(db);
					expect(Number(rows.rows[0]?.count ?? 0)).toBe(0);
				},
				{ timeout: 15_000, interval: 50 },
			);
			const before = await sql<{ count: number | string }>`select count(*) as count from pi_tasks`.execute(db);
			const durableTasks = Number(before.rows[0]?.count ?? 0);
			expect(durableTasks).toBeGreaterThan(0);

			const counts = await runRetention(
				db,
				{ tasksMs: null, auditMs: null, piTasksMs: RETENTION.piTasksMs },
				new Date(Date.now() + 30 * DAY),
			);
			expect(counts.piTasks).toBe(durableTasks);
			const remaining = await sql<{ count: number | string }>`select count(*) as count from pi_tasks`.execute(db);
			expect(Number(remaining.rows[0]?.count ?? 0)).toBe(0);

			// The conversation itself is untouched: the same session answers another message.
			faux.setResponses([fauxAssistantMessage([fauxText("still alive")])]);
			const second = await runtime.submit(session.id, owner, "are you still there?", "retention-2");
			expect(await waitSubmission(runtime, session.id, second)).toEqual({ status: "done", answer: "still alive" });

			// Closing and reopening on the same database must recover without the deleted records.
			await runtime.close();
			runtime = undefined;
			await opened.close();
			opened = await fixture.openStorage();
			runtime = await AgentRuntime.open({ ...options, storage: opened.storage });
			faux.setResponses([fauxAssistantMessage([fauxText("after reopen")])]);
			const third = await runtime.submit(session.id, owner, "one more", "retention-3");
			expect(await waitSubmission(runtime, session.id, third)).toEqual({ status: "done", answer: "after reopen" });
			expect(faux.getPendingResponseCount()).toBe(0);
		} finally {
			await runtime?.close().catch(() => {});
			await cluster?.close().catch(() => {});
			await groups?.close().catch(() => {});
			await opened?.close().catch(() => {});
			await fixture.close();
		}
	});
});

describe("retention sweep scheduler", () => {
	const CONFIG: RetentionConfig = { tasksMs: 90 * DAY, auditMs: 180 * DAY, piTasksMs: 7 * DAY };
	const COUNTS: RetentionCounts = { tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0, piTasks: 0 };
	const STARTUP_DELAY_MS = 5_000;
	const INTERVAL_MS = 60_000;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** Records a call's signal, failing the test if the scheduler ever runs without one. */
	const recordSignal = (signals: AbortSignal[], options: RetentionOptions): void => {
		const signal = options.signal;
		if (signal === undefined) throw new Error("startRetentionSweep must pass a signal");
		signals.push(signal);
	};

	/** A run that resolves at once, so the next tick is free to start. */
	const immediateRun = (): { run: typeof runRetention; signals: AbortSignal[] } => {
		const signals: AbortSignal[] = [];
		const run = ((_db: Db, _retention: RetentionConfig, _now: Date, options: RetentionOptions = {}) => {
			recordSignal(signals, options);
			return Promise.resolve(COUNTS);
		}) as typeof runRetention;
		return { run, signals };
	};

	/** A run whose calls stay pending until the test settles them by call index. */
	const controllableRun = (): {
		run: typeof runRetention;
		signals: AbortSignal[];
		resolve(index: number): void;
		reject(index: number, err: unknown): void;
	} => {
		const signals: AbortSignal[] = [];
		const settle: { resolve(): void; reject(err: unknown): void }[] = [];
		const run = ((_db: Db, _retention: RetentionConfig, _now: Date, options: RetentionOptions = {}) => {
			recordSignal(signals, options);
			return new Promise<RetentionCounts>((resolve, reject) => {
				settle.push({ resolve: () => resolve(COUNTS), reject });
			});
		}) as typeof runRetention;
		return {
			run,
			signals,
			resolve: (index) => settle[index]?.resolve(),
			reject: (index, err) => settle[index]?.reject(err),
		};
	};

	/** Starts the sweep with short, explicit timings; the run is a fake, so no database is touched. */
	const start = (run: typeof runRetention) =>
		startRetentionSweep({} as Db, CONFIG, { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, run });

	it("runs once after the startup delay and then once per interval", async () => {
		const { run, signals } = immediateRun();
		const sweep = start(run);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
		expect(signals).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(signals).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(signals).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
		expect(signals).toHaveLength(5);

		await sweep.stop();
	});

	it("does not overlap runs while the previous one is still in flight", async () => {
		const fake = controllableRun();
		const sweep = start(fake.run);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(fake.signals).toHaveLength(1);

		// Three interval ticks pass with the first run unresolved: each one is skipped.
		await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
		expect(fake.signals).toHaveLength(1);

		fake.resolve(0);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(fake.signals).toHaveLength(2);

		fake.resolve(1);
		await sweep.stop();
	});

	it("logs a rejected run and runs again on the next interval", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const failure = new Error("sweep exploded");
		const fake = controllableRun();
		const sweep = start(fake.run);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(fake.signals).toHaveLength(1);

		fake.reject(0, failure);
		await vi.advanceTimersByTimeAsync(0);
		expect(error).toHaveBeenCalledWith("retention sweep failed:", failure);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(fake.signals).toHaveLength(2);

		fake.resolve(1);
		await sweep.stop();
	});

	it("stop() aborts the in-flight run and waits for it to resolve", async () => {
		const fake = controllableRun();
		const sweep = start(fake.run);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(fake.signals).toHaveLength(1);

		let stopped = false;
		const stopping = sweep.stop().then(() => {
			stopped = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.signals[0]?.aborted).toBe(true);
		expect(stopped).toBe(false);

		fake.resolve(0);
		await stopping;
		expect(stopped).toBe(true);

		await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);
		expect(fake.signals).toHaveLength(1);
	});

	it("stop() before the startup delay prevents any run", async () => {
		const fake = controllableRun();
		const sweep = start(fake.run);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
		expect(fake.signals).toHaveLength(0);
		await sweep.stop();

		await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);
		expect(fake.signals).toHaveLength(0);
	});
});
