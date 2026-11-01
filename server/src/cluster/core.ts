/**
 * The state every Cluster module works on and the helpers they all need: the database, the resolved
 * options, the per-node and per-task maps, the keyed queues that serialize work, and the tracking of
 * background writes that close() drains. The behaviour lives in the sibling modules; this is only the
 * core they share.
 */
import type { Selectable } from "kysely";
import type { Audit, AuditInput } from "../audit/audit.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { Db } from "../storage/db.ts";
import type { TasksTable } from "../storage/schema.ts";
import { KeyedQueue } from "../util/keyed-queue.ts";
import type { GroupBudget } from "./batch-output.ts";
import type { NodeLink } from "./links.ts";
import type { SshConnection } from "./ssh-runner.ts";
import type { Live } from "./task-state.ts";
import { type Actor, type ClusterOptions, type TaskView, UNKNOWN_OUTPUT_KEEP_MS } from "./types.ts";

/** The timestamp every write of a state change records, as the database keeps it. */
export function now(): string {
	return new Date().toISOString();
}

/** One Cluster's shared state; the modules take it as their first argument. */
export class ClusterCore {
	readonly db: Db;
	/** How long a node may stay disconnected before its tasks are reported unknown (doc/execution-plane.md#断线恢复). */
	readonly graceMs: number;
	readonly unknownKeepMs: number;
	/** TaskInput chunk size; one frame stays under MAX_FRAME_BYTES. */
	readonly chunkBytes: number;
	readonly idleMs: number;
	readonly sshRoute: ClusterOptions["sshRoute"];
	readonly audit: Audit | undefined;
	readonly authorizationKey: AuthorizationSigningKey | undefined;
	readonly trustWaitMs: number;
	readonly clockWarnMs: number;

	/** Called once for every task that starts waiting for approval (Auto Review hooks in here). */
	onAwaitingApproval: ((task: TaskView) => Promise<void>) | undefined;
	/** Called after a task starts waiting or its approval state/handler changes (the runtime refreshes its inbox). */
	onChange: ((actorId: string) => void) | undefined;

	/** The live connection of each node (one at a time). */
	readonly links = new Map<string, NodeLink>();
	/** The pooled SSH connection of each SSH node, created on its first task. */
	readonly sshSessions = new Map<string, Promise<SshConnection>>();
	/** The abort of each running SSH task, so a cancel can stop it. */
	readonly sshCancels = new Map<string, AbortController>();
	/** A task between dispatch and its recorded end: output accumulates here, not in the database. */
	readonly live = new Map<string, Live>();
	/** One output budget per running `text` group, created lazily (doc/execution-plane.md#输出). */
	readonly budgets = new Map<string, GroupBudget>();
	/** The grace timer of a node that has no connection. */
	readonly graceTimers = new Map<string, NodeJS.Timeout>();
	/** Drops the kept output of an unknown task after UNKNOWN_OUTPUT_KEEP_MS. */
	readonly unknownTimers = new Map<string, NodeJS.Timeout>();
	/** The actor of a cancel in flight, named by the task.finished audit event that ends it. */
	readonly cancelledBy = new Map<string, Actor>();
	/** The waiters of waitTask, woken on every state change. */
	readonly waiters = new Map<string, Set<() => void>>();
	/** Serializes database updates per task, since frames are handled asynchronously. */
	readonly taskQueue = new KeyedQueue("task queue");
	/** Serializes trust.summary processing per node, so a rejection never plans against an older report. */
	readonly trustQueue = new KeyedQueue("trust queue");
	/** Serializes the shared payload of a task group's waiting tasks. */
	readonly groupQueue = new KeyedQueue("task group queue");
	/** Set when close() begins: no connection is attached and no task starts afterwards. */
	closing = false;
	/** Set by endWaits(): every current and later waitTask returns the current view at once. */
	waitsEnded = false;
	/** Fire-and-forget writes started by the connection and close paths; close() waits for them. */
	readonly pending = new Set<Promise<void>>();

	constructor(db: Db, options: ClusterOptions = {}) {
		this.db = db;
		this.graceMs = options.reconnectGraceMs ?? 120_000;
		this.unknownKeepMs = options.unknownOutputKeepMs ?? UNKNOWN_OUTPUT_KEEP_MS;
		this.chunkBytes = options.inputChunkBytes ?? 48 * 1024;
		this.idleMs = options.idleTimeoutMs ?? 90_000;
		this.sshRoute = options.sshRoute;
		this.audit = options.audit;
		this.authorizationKey = options.authorizationKey;
		this.trustWaitMs = options.trustWaitMs ?? 5_000;
		this.clockWarnMs = options.clockWarnMs ?? 60_000;
	}

	/**
	 * Tracks a fire-and-forget write: a failure is logged instead of becoming an unhandled rejection,
	 * and close() waits for the write before the database is destroyed.
	 */
	background(what: string, work: Promise<unknown>): void {
		const tracked: Promise<void> = work
			.catch((err: unknown) => console.error(`${what}:`, err))
			.then(() => {
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
	}

	/** Fire-and-forget audit write that close() waits for. */
	auditLater(input: AuditInput): void {
		if (this.audit) this.background(`audit: failed to record ${input.action}`, this.audit.record(input));
	}

	/**
	 * Tracks an in-flight protocol handler so close() waits for its writes, but returns the handler's own
	 * promise: the peer still handles its errors exactly as before.
	 */
	trackHandler<T>(work: Promise<T>): Promise<T> {
		const tracked: Promise<void> = work.then(
			() => {
				this.pending.delete(tracked);
			},
			() => {
				this.pending.delete(tracked);
			},
		);
		this.pending.add(tracked);
		return work;
	}

	async row(id: string): Promise<Selectable<TasksTable> | undefined> {
		return this.db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
	}

	notify(id: string): void {
		for (const w of this.waiters.get(id) ?? []) w();
		this.waiters.delete(id);
	}

	/**
	 * Ends every waitTask at once without closing anything: each returns the task's current view, and so does
	 * every waitTask started afterwards. Shutdown calls it after the agent runtime closes, so a handler holding
	 * a long wait (an HTTP `wait`, an MCP tool call) returns and its request can finish (main.ts). An agent tool
	 * call is ended by the Harness through its signal instead: ending its wait would record an outcome for it.
	 */
	endWaits(): void {
		if (this.waitsEnded) return;
		this.waitsEnded = true;
		for (const waiters of [...this.waiters.values()]) for (const wake of [...waiters]) wake();
		this.waiters.clear();
	}

	/** Waits until the pending background writes and the keyed task queues have settled. */
	async drain(): Promise<void> {
		for (;;) {
			const pending = [
				...this.pending,
				...this.taskQueue.pending,
				...this.trustQueue.pending,
				...this.groupQueue.pending,
			];
			if (pending.length === 0) return;
			await Promise.all(pending);
			if (
				this.pending.size === 0 &&
				this.taskQueue.size === 0 &&
				this.trustQueue.size === 0 &&
				this.groupQueue.size === 0
			)
				return;
		}
	}
}
