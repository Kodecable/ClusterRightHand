import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RetentionConfig } from "../src/config.ts";
import type { Db } from "../src/storage/db.ts";
import { AUDIT_SEQ_FLOOR, runRetention } from "../src/storage/retention.ts";
import type { TaskGroupState, TaskState } from "../src/storage/schema.ts";
import { defaultOrgId } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
/** Older than the default 90-day retention of tasks. */
const OLD = new Date(NOW.getTime() - 100 * DAY).toISOString();
/** Newer than the 90-day retention. */
const RECENT = new Date(NOW.getTime() - 1 * DAY).toISOString();
/** Older than the default 180-day retention of audit events. */
const AUDIT_OLD = new Date(NOW.getTime() - 200 * DAY).toISOString();
const RETENTION: RetentionConfig = { tasksMs: 90 * DAY, auditMs: 180 * DAY };

describeBackends("retention sweep", (backend) => {
	let db: Db;
	let orgId: string;

	beforeEach(async () => {
		db = await openTestDb(backend);
		orgId = await defaultOrgId(db);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	const insertTask = async (id: string, state: TaskState, finishedAt: string | null): Promise<void> => {
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
		await insertAuthorization("future", new Date(NOW.getTime() + 30 * DAY).toISOString());
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

		const counts = await runRetention(db, { tasksMs: null, auditMs: RETENTION.auditMs }, NOW);

		expect(counts.auditEvents).toBe(11);
		expect(await auditSeqs()).toEqual([3617, 5000, 20000]);
		expect(20000 - 3616).toBe(AUDIT_SEQ_FLOOR);
	});

	it("keeps old audit events that are all within the sequence floor", async () => {
		for (let seq = 1; seq <= 10; seq++) await insertAuditEvent(seq, AUDIT_OLD);

		const counts = await runRetention(db, { tasksMs: null, auditMs: RETENTION.auditMs }, NOW);

		expect(counts.auditEvents).toBe(0);
		expect(await auditSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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

		expect(counts).toEqual({ tasks: 0, taskGroups: 1, authorizations: 1, auditEvents: 1 });
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

		const tasksOff = await runRetention(db, { tasksMs: null, auditMs: RETENTION.auditMs }, NOW);
		expect(tasksOff.tasks).toBe(0);
		expect(tasksOff.auditEvents).toBe(1);
		expect(await taskIds()).toEqual(["old-exited"]);

		const auditOff = await runRetention(db, { tasksMs: RETENTION.tasksMs, auditMs: null }, NOW);
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
		const counts = await runRetention(db, { tasksMs: RETENTION.tasksMs, auditMs: null }, NOW, {
			batchSize: 2,
			signal,
		});

		expect(counts.tasks).toBe(2);
		expect(await taskIds()).toHaveLength(3);

		// An already-aborted signal deletes nothing at all.
		const aborted = new AbortController();
		aborted.abort();
		const stopped = await runRetention(db, RETENTION, NOW, { signal: aborted.signal });
		expect(stopped).toEqual({ tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0 });
	});

	it("logs nothing when no rows are deleted", async () => {
		const counts = await runRetention(db, RETENTION, NOW);

		expect(counts).toEqual({ tasks: 0, taskGroups: 0, authorizations: 0, auditEvents: 0 });
		expect(console.log).not.toHaveBeenCalled();
	});
});
