/**
 * The Cluster: crhs's execution plane, the node connections and the task state machine
 * (doc/design/execution.md, doc/design/privilege.md). This class is the facade the rest of crhs programs
 * against; the work is done by the modules next to it:
 *
 * - `core.ts`: the state and helpers every module shares;
 * - `links.ts`: node connections, hello, the reconnect grace;
 * - `trust-cache.ts`: the trust reports;
 * - `authorization-flow.ts`: the authorization of privileged tasks (the entry points of `authorization/`);
 * - `ssh-runner.ts`: SSH nodes;
 * - `task-state.ts`: the task state machine (the entry points of `task-dispatch.ts`, `task-end.ts`,
 *   `task-approval.ts`, `task-wait.ts` and `live-output.ts`);
 * - `approval.ts`: what the approval of a task and of a task group share.
 */
import type { NodeStatus, TaskSpec } from "@crh/protocol";
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
import type {
	Actor,
	ApprovalDecision,
	ApprovalExpect,
	ApprovalRecord,
	ClusterOptions,
	CreateTaskInput,
	DecisionResult,
	TaskView,
} from "./types.ts";

export { countOutputLines } from "./output.ts";
export { EMPTY_INPUT_REF, operationOfJson, specFromRow, summarize } from "./spec.ts";
export type {
	Actor,
	AgentRequest,
	ApprovalDecision,
	ApprovalExpect,
	ApprovalRecord,
	ClusterOptions,
	CreateTaskInput,
	DecisionResult,
	TaskView,
} from "./types.ts";
export {
	AUTHORIZATION_CODES,
	AUTHORIZATION_WAIT_MS,
	NODE_OFFLINE_GRACE_MS,
	TASK_CANCELLED_CODE,
	TERMINAL,
	UNKNOWN_OUTPUT_KEEP_MS,
} from "./types.ts";

/**
 * The Cluster core's execution side: node connections, task dispatch, the task state machine and its
 * failure semantics. See doc/design/execution.md.
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
	 * Settles the tasks a previous process left unfinished (doc/design/execution.md "Reconnect"). A client
	 * node's dispatched or running tasks are treated as detached now, so the reconnect grace they get is
	 * the same as after a disconnect: a node that comes back within it resolves them through hello, and
	 * one that does not leaves them `unknown`. An SSH node has no connection to resume: its tasks are
	 * `unknown(connection_lost)` at once. Called at startup, before any node connects.
	 */
	recover(): Promise<void> {
		return links.recover(this.#core);
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
	 * active node after approval, or stops (rejected) after deletion. See doc/design/protocol.md "Node registration".
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

	/**
	 * Waits until the background work and the keyed queues have settled. close() does this before the
	 * database is destroyed; a caller that must know a fire-and-forget dispatch is done (a submitted
	 * authorization's dispatch runs in the background) can await it as well.
	 */
	drain(): Promise<void> {
		return this.#core.drain();
	}

	/** How the rule chain judges running `spec` on a node. */
	evaluateFor(node: NodeRow, spec: TaskSpec, chain: RuleRef[], privileged: boolean): Promise<Evaluation> {
		return tasks.evaluateFor(this.#core, node, spec, chain, privileged);
	}

	/** How the rule chain judges `spec` on each node, loading the chain and the nodes' groups once. */
	evaluateForNodes(
		nodes: readonly NodeRow[],
		spec: TaskSpec,
		chain: RuleRef[],
		privileged: boolean,
	): Promise<Map<string, Evaluation>> {
		return tasks.evaluateForNodes(this.#core, nodes, spec, chain, privileged);
	}

	/**
	 * Creates a task. With a rule chain it is first judged: denied, left waiting for approval, or
	 * dispatched. A node that is not connected at dispatch gets the offline grace and then
	 * fails with node_offline.
	 */
	createTask(input: CreateTaskInput): Promise<TaskView> {
		return tasks.createTask(this.#core, input);
	}

	/**
	 * POST /api/authorizations: checks a user's authorization and stores it (for display and reuse). The
	 * waiting tasks it covers are judged, claimed and sent in the background, so this returns
	 * once the authorization is stored; their outcome shows up in the task states (doc/design/privilege.md "Authorizations").
	 */
	submitAuthorization(user: SessionUser, submitted: SubmittedAuthorization): Promise<{ id: string }> {
		return authorizations.submitAuthorization(this.#core, user, submitted);
	}

	/**
	 * Settles a task waiting for approval. Returns false if it is not waiting with the handler `expect`
	 * names (already settled, or the handler changed since the caller's read); `node_deleted` when the
	 * approval was recorded but the node was gone, so the task ended without dispatching. The expectation
	 * is checked again in the task's turn; omitted, any handler will do, but the row must have one.
	 */
	decide(id: string, decision: ApprovalDecision, expect?: ApprovalExpect): Promise<DecisionResult> {
		return tasks.decide(this.#core, id, decision, expect);
	}

	/**
	 * Ends the waiting tasks of a node that was just deleted (doc/design/execution.md "State machine"): they can
	 * never dispatch, and nothing else would ever settle them. Returns how many tasks ended.
	 */
	endNodeTasks(nodeId: string): Promise<number> {
		return tasks.endNodeTasks(this.#core, nodeId);
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
	 * Judges waiting tasks again after rules on their chain changed (doc/design/access-control.md "Approvals"): allow
	 * dispatches them, deny ends them, require-approval leaves them waiting.
	 */
	reevaluate(ref: RuleRef): Promise<void> {
		return tasks.reevaluate(this.#core, ref);
	}

	getTask(id: string): Promise<TaskView | undefined> {
		return tasks.getTask(this.#core, id);
	}

	/** Several tasks in one query, in the input order; missing ids are omitted. */
	getTasks(ids: readonly string[]): Promise<TaskView[]> {
		return tasks.getTasks(this.#core, ids);
	}

	/** A task group's tasks in creation order, in one query. */
	groupTasks(groupId: string): Promise<TaskView[]> {
		return tasks.groupTasks(this.#core, groupId);
	}

	/** Several task groups' tasks in one query; each group is in creation order. */
	groupTasksMany(groupIds: readonly string[]): Promise<Map<string, TaskView[]>> {
		return tasks.groupTasksMany(this.#core, groupIds);
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
	 * A task claimed for dispatch records the request on its row and returns true even while the node is
	 * offline, so the dispatch path ends it instead of sending its task.start
	 * (doc/design/execution.md "Task cancellation"). Returns false if the task already ended, or when it already runs
	 * and the node is offline. `message` replaces the default reason of a task that ends before dispatch
	 * (e.g. its session was stopped). `by` is the actor who asked for the cancellation: the task.finished
	 * audit event names it, or the system when it is absent.
	 */
	cancelTask(id: string, message?: string, by?: Actor): Promise<boolean> {
		return tasks.cancelTask(this.#core, id, message, by);
	}

	/**
	 * POST /api/tasks/:id/authorization/reject: the owner declines to sign a waiting task. The task ends
	 * `rejected`/`authorization_rejected` with the reason, and an outstanding local approval request is
	 * withdrawn. Returns false when the task is no longer waiting for its signature
	 * (doc/design/privilege.md "Waiting for signatures"). Without a reason the default message is stored.
	 * A task group's members pass `audit: false`: the group's one event names the group instead.
	 */
	rejectAuthorization(id: string, reason: string, by: Actor, options: { audit?: boolean } = {}): Promise<boolean> {
		return authorizations.rejectAuthorizationWait(this.#core, id, reason, by, options);
	}

	/**
	 * Ends the tasks whose signature has not arrived within AUTHORIZATION_WAIT_MS since they began to wait
	 * (doc/design/privilege.md "Waiting for signatures"): from the approval decision when there was one, else from creation.
	 * Run at startup and by the periodic sweep; returns how many tasks it ended.
	 */
	expireAuthorizationWaits(nowMs?: number): Promise<number> {
		return authorizations.expireAuthorizationWaits(this.#core, nowMs);
	}

	/**
	 * Releases the output budget a batch `text` group shares. TaskGroups calls this when the group itself is
	 * done (finished, interrupted, rejected or cancelled), not when its last task ends: with `parallel: 1` every node
	 * would otherwise get a fresh budget. Returns whether a budget was still held.
	 */
	releaseGroupBudget(groupId: string): boolean {
		return tasks.releaseGroupBudget(this.#core, groupId);
	}
}
