/**
 * The Cluster: crhs's execution plane, the node connections and the task state machine
 * (doc/execution-plane.md, doc/privilege.md). This class is the facade the rest of crhs programs
 * against; the work is done by the modules next to it:
 *
 * - `core.ts`: the state and helpers every module shares;
 * - `links.ts`: node connections, hello, the reconnect grace;
 * - `trust-cache.ts`: the trust reports and the revocation pushes;
 * - `authorization-flow.ts`: the authorization of privileged tasks;
 * - `ssh-runner.ts`: SSH nodes;
 * - `task-state.ts`: the task state machine and its endings.
 */
import type { NodeStatus, TaskSpec } from "@crh/protocol";
import type { AuditActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Evaluation } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import type { SubmittedAuthorization } from "../privilege/submission.ts";
import type { Db } from "../storage/db.ts";
import * as authorizations from "./authorization-flow.ts";
import type { NodeConnection } from "./connection.ts";
import { ClusterCore } from "./core.ts";
import * as links from "./links.ts";
import type { NodeRow } from "./nodes.ts";
import { closeSsh } from "./ssh-runner.ts";
import * as tasks from "./task-state.ts";
import * as trustCache from "./trust-cache.ts";
import type { Actor, ApprovalDecision, ApprovalRecord, ClusterOptions, CreateTaskInput, TaskView } from "./types.ts";

export { EMPTY_INPUT_REF, operationOfJson, specFromRow, summarize } from "./spec.ts";
export type {
	Actor,
	AgentRequest,
	ApprovalDecision,
	ApprovalRecord,
	ClusterOptions,
	CreateTaskInput,
	TaskView,
} from "./types.ts";
export { AUTHORIZATION_CODES, AUTHORIZATION_WAIT_MS, TERMINAL, UNKNOWN_OUTPUT_KEEP_MS } from "./types.ts";

/**
 * The Cluster core's execution side: node connections, task dispatch, the task state machine and its
 * failure semantics. See doc/execution-plane.md.
 */
export class Cluster {
	readonly #core: ClusterCore;

	constructor(db: Db, options: ClusterOptions = {}) {
		this.#core = new ClusterCore(db, options);
	}

	/** Called once for every task that starts waiting for approval (Auto Review hooks in here). */
	get onAwaitingApproval(): ((task: TaskView) => Promise<void>) | undefined {
		return this.#core.onAwaitingApproval;
	}

	set onAwaitingApproval(hook: ((task: TaskView) => Promise<void>) | undefined) {
		this.#core.onAwaitingApproval = hook;
	}

	/** Called after a task starts waiting or its approval state/handler changes (the runtime refreshes its inbox). */
	get onChange(): ((actorId: string) => void) | undefined {
		return this.#core.onChange;
	}

	set onChange(hook: ((actorId: string) => void) | undefined) {
		this.#core.onChange = hook;
	}

	isConnected(nodeId: string): boolean {
		return links.isConnected(this.#core, nodeId);
	}

	/** Whether the cached trust report of the node came from the current connection (otherwise it is stale). */
	trustFresh(nodeId: string): boolean {
		return links.trustFresh(this.#core, nodeId);
	}

	/**
	 * Settles the tasks a previous process left unfinished (doc/execution-plane.md#断线恢复). A client
	 * node's dispatched or running tasks are treated as detached now, so the reconnect grace they get is
	 * the same as after a disconnect: a node that comes back within it resolves them through hello, and
	 * one that does not leaves them `unknown`. An SSH node has no connection to resume: its tasks are
	 * `unknown(connection_lost)` at once. Called at startup, before any node connects.
	 */
	recover(): Promise<void> {
		return links.recover(this.#core);
	}

	/**
	 * Revokes an authorization, audits it and pushes `revocations.add` to every connected node of its
	 * organization (doc/privilege.md#吊销). Idempotent: a second call changes nothing and pushes nothing.
	 */
	revokeAuthorization(id: string, actor: AuditActor): Promise<{ id: string; revokedAt: string; changed: boolean }> {
		return trustCache.revokeAuthorization(this.#core, id, actor);
	}

	/** Whether close() has begun; new connections are refused and no task starts afterwards. */
	get closing(): boolean {
		return this.#core.closing;
	}

	/** Whether endWaits() has run: waitTask no longer sleeps and the catalog wait loops stop. */
	get waitsEnded(): boolean {
		return this.#core.waitsEnded;
	}

	/**
	 * Ends every waitTask at once without closing anything: each returns the task's current view, and so does
	 * every waitTask started afterwards. Shutdown calls it after the agent runtime closes, so a handler holding
	 * a long wait (an HTTP `wait`, an MCP tool call) returns and its request can finish (main.ts). An agent tool
	 * call is ended by the Harness through its signal instead: ending its wait would record an outcome for it.
	 */
	endWaits(): void {
		this.#core.endWaits();
	}

	/** Called by AgentServer after a successful handshake. */
	attach(conn: NodeConnection, node: NodeRow): void {
		links.attach(this.#core, conn, node);
	}

	/** Closes a node's connection, e.g. after approval (crha reconnects as active) or deletion. */
	disconnect(nodeId: string, reason: string): void {
		links.disconnect(this.#core, nodeId, reason);
	}

	/**
	 * Tells a connected node about a status change, then closes the connection: crha reconnects as an
	 * active node after approval, or stops (rejected) after deletion. See doc/execution-plane.md#注册.
	 */
	notifyNodeStatus(nodeId: string, state: NodeStatus["state"], message: string): void {
		links.notifyNodeStatus(this.#core, nodeId, state, message);
	}

	/**
	 * Closes every node link and SSH session and resolves once the work the closes started has been
	 * written (disconnect audits, last_seen updates, task and task group state). No database write is
	 * started after it resolves, so the caller may destroy the database afterwards.
	 */
	async close(): Promise<void> {
		if (!this.#core.closing) {
			this.#core.closing = true;
			closeSsh(this.#core);
			links.closeLinks(this.#core);
			for (const t of this.#core.unknownTimers.values()) clearTimeout(t);
			this.#core.unknownTimers.clear();
			this.#core.cancelledBy.clear();
			// Let waitTask callers (task groups, tools) return instead of holding a timer for an hour.
			this.#core.endWaits();
		}
		await this.#core.drain();
		await this.#core.audit?.flush();
	}

	/** How the rule chain judges running `spec` on a node. */
	evaluateFor(node: NodeRow, spec: TaskSpec, chain: RuleRef[], privileged: boolean): Promise<Evaluation> {
		return tasks.evaluateFor(this.#core, node, spec, chain, privileged);
	}

	/**
	 * Creates a task. With a rule chain it is first judged: denied, left waiting for approval, or
	 * dispatched. A node that is not connected at dispatch fails it at once with node_offline.
	 */
	createTask(input: CreateTaskInput): Promise<TaskView> {
		return tasks.createTask(this.#core, input);
	}

	/**
	 * POST /api/authorizations: checks a user's authorization, stores it (for display, revocation and
	 * reuse) and dispatches every waiting task of that user it covers (doc/m4.md M4.4).
	 */
	submitAuthorization(
		user: SessionUser,
		submitted: SubmittedAuthorization,
	): Promise<{ id: string; dispatched: string[] }> {
		return authorizations.submitAuthorization(this.#core, user, submitted);
	}

	/**
	 * Settles a task waiting for approval. Returns false if it is not waiting (already settled, or never
	 * needed approval). Who may decide is checked by the caller.
	 */
	decide(id: string, decision: ApprovalDecision): Promise<boolean> {
		return tasks.decide(this.#core, id, decision);
	}

	/** Stores Auto Review's verdict on a waiting task. */
	recordReview(id: string, review: NonNullable<ApprovalRecord["review"]>): Promise<void> {
		return tasks.recordReview(this.#core, id, review);
	}

	/**
	 * Hands a waiting task's approval to an ancestor session's agent. False when it is no longer waiting (Auto Review
	 * or the user settled it first).
	 */
	requestAgentDecision(id: string, session: string): Promise<boolean> {
		return tasks.requestAgentDecision(this.#core, id, session);
	}

	/** The agent passed the request on to the user: the approval page takes it from here. */
	escalateAgentDecision(id: string, session: string): Promise<boolean> {
		return tasks.escalateAgentDecision(this.#core, id, session);
	}

	/**
	 * Judges waiting tasks again after rules on their chain changed (doc/access-control.md#审批): allow
	 * dispatches them, deny ends them, require-approval leaves them waiting.
	 */
	reevaluate(ref: RuleRef): Promise<void> {
		return tasks.reevaluate(this.#core, ref);
	}

	getTask(id: string): Promise<TaskView | undefined> {
		return tasks.getTask(this.#core, id);
	}

	/**
	 * Waits until the task is in a final state, the timeout passes or endWaits() ends the waits; returns its
	 * current view (never undefined for an existing task). A wait ended by shutdown returns at once, so a
	 * handler holding it does not hold the drain; close() runs before the database is destroyed, so that
	 * read is safe.
	 */
	waitTask(id: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskView | undefined> {
		return tasks.waitTask(this.#core, id, timeoutMs, signal);
	}

	/**
	 * Asks the node to cancel a running task. A task that still waits for its approval or its
	 * authorization signature was never dispatched, so it ends here instead (there is no node-side task).
	 * Returns false if the task already ended or the node is offline. `message` replaces the default reason of
	 * a task that ends before dispatch (e.g. its session was stopped). `by` is the actor who asked for the
	 * cancellation: the task.finished audit event names it, or the system when it is absent.
	 */
	cancelTask(id: string, message?: string, by?: Actor): Promise<boolean> {
		return tasks.cancelTask(this.#core, id, message, by);
	}

	/**
	 * Ends the tasks whose signature has not arrived within AUTHORIZATION_WAIT_MS since they began to wait
	 * (doc/privilege.md#等待签名的期限): from the approval decision when there was one, else from creation.
	 * Run at startup and by the periodic sweep; returns how many tasks it ended.
	 */
	expireAuthorizationWaits(nowMs?: number): Promise<number> {
		return authorizations.expireAuthorizationWaits(this.#core, nowMs);
	}

	/**
	 * Releases the output budget a batch `text` group shares. TaskGroups calls this when the group itself is
	 * done (finished, interrupted or rejected), not when its last task ends: with `parallel: 1` every node
	 * would otherwise get a fresh budget. Returns whether a budget was still held.
	 */
	releaseGroupBudget(groupId: string): boolean {
		return tasks.releaseGroupBudget(this.#core, groupId);
	}
}
