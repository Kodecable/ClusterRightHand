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
import type { Live } from "./live-output.ts";
import { getNode, type NodeRow } from "./nodes.ts";
import type { SshConnection } from "./ssh-runner.ts";
import { TASK_QUEUE_LABEL } from "./task-rows.ts";
import {
	type Actor,
	type ClusterOptions,
	NODE_OFFLINE_GRACE_MS,
	type TaskView,
	UNKNOWN_OUTPUT_KEEP_MS,
} from "./types.ts";

/** A node that is ready to take a task.start, with its current connection (none for SSH). */
export interface ReadyNode {
	node: NodeRow;
	link?: NodeLink;
}

/** The timestamp every write of a state change records, as the database keeps it. */
export function now(): string {
	return new Date().toISOString();
}

/** One Cluster's shared state; the modules take it as their first argument. */
export class ClusterCore {
	readonly db: Db;
	/** How long a node may stay disconnected before its tasks are reported unknown (doc/execution-plane.md#断线恢复). */
	readonly graceMs: number;
	/** How long a task waits for its offline node before failing node_offline (D113). */
	readonly nodeOfflineGraceMs: number;
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
	/** Tasks waiting for a node's link to change (the offline grace, D113). */
	readonly linkWaiters = new Map<string, Set<() => void>>();
	/** Serializes database updates per task, since frames are handled asynchronously. */
	readonly taskQueue = new KeyedQueue(TASK_QUEUE_LABEL);
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
	/** The D118 turn violations already logged; production logs each call site once, never crashes. */
	readonly #turnWarnings = new Set<string>();

	constructor(db: Db, options: ClusterOptions = {}) {
		this.db = db;
		this.graceMs = options.reconnectGraceMs ?? 120_000;
		this.nodeOfflineGraceMs = options.nodeOfflineGraceMs ?? NODE_OFFLINE_GRACE_MS;
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

	/**
	 * D118: a task queue turn only reads the row, decides and writes it. A path that would wait for a
	 * node (`waitNodeReady`, `waitTrust`) or send a request that waits for an answer (`task.start`,
	 * `local.request`) calls this first. Under tests it throws, so a regression fails the suite; in
	 * production it is logged once with a stack and the work continues (a violation must never crash
	 * the cluster).
	 */
	assertOutsideTaskTurn(what: string): void {
		if (!this.taskQueue.inTurn()) return;
		const message = `${what} inside a task queue turn (D118)`;
		if (process.env.VITEST) throw new Error(message);
		if (this.#turnWarnings.has(what)) return;
		this.#turnWarnings.add(what);
		console.error(`${message}\n${new Error(message).stack ?? ""}`);
	}

	async row(id: string): Promise<Selectable<TasksTable> | undefined> {
		return this.db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
	}

	notify(id: string): void {
		for (const w of this.waiters.get(id) ?? []) w();
		this.waiters.delete(id);
	}

	/** Wakes the tasks waiting for this node's link (attach, detach, hello ready, trust report). */
	notifyLink(nodeId: string): void {
		const waiters = this.linkWaiters.get(nodeId);
		if (!waiters) return;
		this.linkWaiters.delete(nodeId);
		for (const wake of [...waiters]) wake();
	}

	/** Waits for a node's link to change, at most `timeoutMs`; the offline grace also polls. */
	waitLink(nodeId: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const waiters = this.linkWaiters.get(nodeId) ?? new Set<() => void>();
			this.linkWaiters.set(nodeId, waiters);
			const done = () => {
				clearTimeout(timer);
				waiters.delete(done);
				// A timed-out wait must not leave an empty set behind: nothing would remove it until the next
				// link change, and a node that is never seen again would keep one.
				if (waiters.size === 0 && this.linkWaiters.get(nodeId) === waiters) this.linkWaiters.delete(nodeId);
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			waiters.add(done);
		});
	}

	/** Waits for this connection's first trust summary; crhs does not query it itself. */
	waitTrust(link: NodeLink, timeoutMs: number = this.trustWaitMs): Promise<void> {
		this.assertOutsideTaskTurn("waitTrust");
		if (link.trustFresh) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				link.trustWaiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, timeoutMs);
			link.trustWaiters.add(wake);
		});
	}

	/** A node that is ready right now, without waiting: an online link (or an SSH route). */
	readyNodeNow(nodeId: string): Promise<ReadyNode | undefined> {
		return this.#readyNode(nodeId, { trust: false }, 0);
	}

	/**
	 * A node ready to take a task.start: at once when it is connected, else after waitNodeReady (D113).
	 * `trust` applies only to the wait: a connected node is ready even before its new trust report.
	 */
	async readyNode(nodeId: string, options: { trust?: boolean } = {}): Promise<ReadyNode | undefined> {
		return (await this.readyNodeNow(nodeId)) ?? (await this.waitNodeReady(nodeId, options));
	}

	/**
	 * Waits up to NODE_OFFLINE_GRACE_MS for a node to be ready to take a task.start (D113): an active,
	 * ready link, and for a forward privileged task also a fresh trust report. SSH nodes have no
	 * connection to wait for: they are ready while a route exists. Returns undefined when the grace
	 * ran out, the server is closing or waits were ended.
	 */
	async waitNodeReady(nodeId: string, options: { trust?: boolean } = {}): Promise<ReadyNode | undefined> {
		this.assertOutsideTaskTurn("waitNodeReady");
		// An SSH node has no standing connection to wait for: without a route it can never become ready, so
		// fail at once instead of polling for the whole grace (doc/execution-plane.md#节点不在线).
		const node = await getNode(this.db, nodeId);
		if (node?.transport === "ssh" && this.sshRoute === undefined) return undefined;
		const deadline = Date.now() + this.nodeOfflineGraceMs;
		for (;;) {
			const ready = await this.#readyNode(nodeId, options, deadline);
			if (ready) return ready;
			if (this.closing || this.waitsEnded) return undefined;
			const left = deadline - Date.now();
			if (left <= 0) return undefined;
			// A link change wakes the wait at once; the short timer catches a status change in the database.
			await this.waitLink(nodeId, Math.min(left, 250));
		}
	}

	async #readyNode(nodeId: string, options: { trust?: boolean }, deadline: number): Promise<ReadyNode | undefined> {
		const node = await getNode(this.db, nodeId);
		if (!node) return undefined;
		if (node.transport === "ssh") {
			return node.status === "active" && this.sshRoute !== undefined ? { node } : undefined;
		}
		const link = this.links.get(nodeId);
		if (node.status !== "active" || !link || link.conn.closed || !link.ready) return undefined;
		if (options.trust && !link.trustFresh) {
			const left = deadline - Date.now();
			if (left <= 0) return undefined;
			await this.waitTrust(link, Math.min(left, this.trustWaitMs));
			return undefined;
		}
		return { node, link };
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
		for (const nodeId of [...this.linkWaiters.keys()]) this.notifyLink(nodeId);
		for (const link of this.links.values()) for (const wake of [...link.trustWaiters]) wake();
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
