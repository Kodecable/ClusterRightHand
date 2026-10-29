import { createHash } from "node:crypto";
import {
	type AfterResponse,
	type Authorization,
	afterResponse,
	authorizationCodec,
	ConnectionError,
	encode as encodeCbor,
	type Facts,
	factsToJson,
	type Hello,
	type InputRef,
	MAX_FRAME_BYTES,
	type NodeStatus,
	type OutputAck,
	ProtocolError,
	RemoteError,
	type Revocation,
	type Signature,
	type TaskExit,
	type TaskSpec,
	type TaskStart,
	type TaskStatus,
	type TrustReport,
	taskSpecFromJson,
	taskSpecToJson,
	type Welcome,
} from "@crh/protocol";
import type { Selectable, Updateable } from "kysely";
import type { Audit, AuditActor } from "../audit/audit.ts";
import { type Evaluation, evaluate, operationOf } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import { ownerCredentials } from "../privilege/credentials.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { BuiltAuthorization } from "../privilege/payload.ts";
import { planAuthorization } from "../privilege/planner.ts";
import type { Db } from "../storage/db.ts";
import type { TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import {
	parseTaskAuthorization,
	planView,
	serializeTaskAuthorization,
	signatureToJson,
	type TaskAuthorizationRecord,
} from "./authorization.ts";
import { createLiveTask, GroupBudget, type LiveTask, type OutputSnapshot } from "./batch-output.ts";
import type { NodeConnection } from "./connection.ts";
import { getNode, markNodeSeen, type NodeRow, nodeGroupNames, updateNodeFacts } from "./nodes.ts";
import { OUTPUT_KEEP_BYTES, OUTPUT_KEEP_LINES } from "./output.ts";
import { batchRevocations, listRevocations, revokeAuthorizationRow } from "./revocations.ts";
import { connect as connectSsh, SshError, type SshRoute, type SshSession } from "./ssh/connection.ts";
import { runSshExec, SshConnectionLost, type SshExecSink, shellQuote, sshPrivilegedNotice } from "./ssh/exec.ts";
import { FileTaskError, runSftpFileTask } from "./ssh/file-task.ts";
import { parseTrustReport, recordTrustReport, trustUnavailableMessage } from "./trust.ts";

/** Who asked for a task; see doc/access-control.md#操作者. */
export interface Actor {
	type: "user" | "session" | "subagent" | "schedule" | "api_token" | "system";
	id: string;
	onBehalfOfUserId: string;
}

export interface CreateTaskInput {
	nodeId: string;
	spec: TaskSpec;
	/** stdin for exec, content for file.write; sent as TaskInput chunks. */
	input?: Uint8Array;
	/** A privileged task: rules see the flag and crha decides by its privileged mode (doc/privilege.md). */
	privileged?: boolean;
	timeoutMs?: number;
	/** How much output to keep; single tasks use `full`, a group's tasks get its mode. */
	outputMode?: "full" | "text" | "status";
	actor: Actor;
	taskGroupId?: string;
	/** The rule chain, root first; omitted when a user acts in person (doc/access-control.md#规则链). */
	chain?: RuleRef[];
	/** Set for the tasks of an approved task group: a require-approval result counts as approved. */
	approvedBy?: ApprovalDecision;
	/**
	 * A caller-chosen id. If a task with it exists, createTask returns that task instead of creating one: a tool
	 * call that reruns after a crash reattaches to the task its first attempt started (doc/agent-runtime.md).
	 */
	id?: string;
}

/** How an approval was settled. */
export interface ApprovalDecision {
	decision: "approved" | "rejected";
	by: { type: string; id: string; onBehalfOfUserId?: string };
	at: string;
	reason?: string;
	/** The task group whose approval covered this task. */
	taskGroupId?: string;
}

/**
 * A request handed to the agent of an ancestor session instead of going straight to the user
 * (doc/agent-runtime.md#处理子会话的请求).
 */
export interface AgentRequest {
	/** The session whose agent decides; its agent calls subagent_decide. */
	session: string;
	/** `escalated`: its agent passed it on to the user. */
	state: "pending" | "escalated";
}

/** The approval state of a tool call: how the rules judged it, then how it was settled. */
export interface ApprovalRecord {
	evaluation: Evaluation;
	decision?: ApprovalDecision;
	/** Auto Review's verdict, when the root's preset asked for one. */
	review?: { decision: "approve" | "escalate"; reason: string; model: string };
	/** Set while (or after) an ancestor's agent had the request. */
	agent?: AgentRequest;
}

export interface TaskView {
	id: string;
	nodeId: string;
	kind: string;
	state: TaskRowState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	errorCode: string | null;
	errorMessage: string | null;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutHead: string;
	/**
	 * For `text` mode this is the combined stdout/stderr tail in arrival order (the only output kept);
	 * the other head/tail fields are "" then. A trailing newline ends the last line.
	 */
	stdoutTail: string;
	stderrHead: string;
	stderrTail: string;
	outputFile: string | null;
	/** How much output was kept for this task (doc/execution-plane.md#输出). */
	outputMode: "full" | "text" | "status";
	/** Whether this is a privileged task (doc/privilege.md). */
	privileged: boolean;
	/** The authorization plan and its history for a privileged task; null for the others (doc/m4.md#crhs-侧数据). */
	authorization: TaskAuthorizationRecord | null;
	/** One line describing what ran: the command line or the path. */
	summary: string;
	/** What authorization rules match on (doc/privilege.md#方法与目标); null if the spec cannot be read. */
	operation: { method: string; target: string } | null;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	createdAt: string;
	finishedAt: string | null;
	taskGroupId: string | null;
	ruleChain: RuleRef[] | null;
	approval: ApprovalRecord | null;
	/** Root session of the rule chain, for grouping approvals by session tree. */
	rootSessionId: string | null;
	/** Who handles a waiting approval; null when it is not waiting. */
	handlerType: "agent" | "user" | null;
	handlerSessionId: string | null;
}

export interface ClusterOptions {
	/** How long a node may stay disconnected before its tasks are reported unknown(connection_lost). */
	reconnectGraceMs?: number;
	/** TaskInput chunk size; one frame must stay under MAX_FRAME_BYTES (60 KiB). */
	inputChunkBytes?: number;
	/**
	 * A connection with no message for this long is closed. crha must ping at least every 45 s (crhs only answers); this catches hung
	 * clients and half-open links that never deliver a close.
	 */
	idleTimeoutMs?: number;
	/** Resolves an SSH node's route (hosts, pinned keys, private key). Without it SSH nodes are offline. */
	sshRoute?: (node: NodeRow) => Promise<SshRoute>;
	/**
	 * crhs's authorization signing key (doc/privilege.md#授权签名密钥). Without it no crhs-signed
	 * authorization can be issued, so only the owner's user/local paths remain available.
	 */
	authorizationKey?: AuthorizationSigningKey;
	/** How long a forward dispatch waits for the first trust.summary of its connection. */
	trustWaitMs?: number;
	audit?: Audit;
}

export const TERMINAL: ReadonlySet<TaskRowState> = new Set(["exited", "failed", "rejected", "unknown", "denied"]);

/** Whether the row already has a result. `unknown` does not: it still accepts a late result. */
function recorded(state: TaskRowState): boolean {
	return TERMINAL.has(state) && state !== "unknown";
}

/**
 * Codes a crha answers `task.start` with before accepting, for which the task may be retried with a
 * higher attempt (doc/protocol.md#taskstart). Other codes are terminal.
 */
export const AUTHORIZATION_CODES: ReadonlySet<string> = new Set([
	"authorization_required",
	"authorization_invalid",
	"authorization_expired",
	"authorization_rejected",
]);

/**
 * The ref of an empty input. file.write always carries one; callers set it and createTask overwrites it
 * from the input actually sent (doc/protocol.md#json-形式服务端存储).
 */
export const EMPTY_INPUT_REF: InputRef = { size: 0, sha256: createHash("sha256").update(new Uint8Array(0)).digest() };

/** A task between dispatch and its recorded end: output accumulates here, not in the database. */
interface Live {
	id: string;
	nodeId: string;
	/** The task's group, for the shared batch budget; null for a single task. */
	groupId: string | null;
	output: LiveTask;
}

/** No output at all: a task that never ran, or a status task before task.exit names its file. */
const EMPTY_OUTPUT: OutputSnapshot = {
	stdoutBytes: 0,
	stderrBytes: 0,
	stdoutHead: null,
	stdoutTail: null,
	stderrHead: null,
	stderrTail: null,
};

interface NodeLink {
	conn: NodeConnection;
	active: boolean;
	/** The node's owner, for the audit trail of connect/disconnect. */
	ownerUserId: string | null;
	/** Set once Hello has been reconciled; tasks are dispatched only after that. */
	ready: boolean;
	/** Task ids we asked about with TaskQuery after Hello. */
	queried: Set<string>;
	/** Whether this connection has reported its trust summary; the cached report is stale until then. */
	trustFresh: boolean;
	/** Dispatches waiting for the first trust summary of this connection. */
	trustWaiters: Set<() => void>;
}

/**
 * The Cluster core's execution side: node connections, task dispatch, the task state machine and its
 * failure semantics. See doc/execution-plane.md.
 */
export class Cluster {
	readonly #db: Db;
	readonly #graceMs: number;
	readonly #chunk: number;
	readonly #idleMs: number;
	readonly #sshRoute: ClusterOptions["sshRoute"];
	readonly #audit: Audit | undefined;
	readonly #authorizationKey: AuthorizationSigningKey | undefined;
	readonly #trustWaitMs: number;
	/** Called once for every task that starts waiting for approval (Auto Review hooks in here). */
	onAwaitingApproval: ((task: TaskView) => Promise<void>) | undefined;
	/** Called after a task starts waiting or its approval state/handler changes (the runtime refreshes its inbox). */
	onChange: ((actorId: string) => void) | undefined;
	readonly #sshSessions = new Map<string, Promise<SshSession>>();
	readonly #sshCancels = new Map<string, AbortController>();
	readonly #links = new Map<string, NodeLink>();
	readonly #live = new Map<string, Live>();
	/** One output budget per running `text` group, created lazily (doc/execution-plane.md#输出). */
	readonly #budgets = new Map<string, GroupBudget>();
	readonly #graceTimers = new Map<string, NodeJS.Timeout>();
	readonly #waiters = new Map<string, Set<() => void>>();
	/** Serializes database updates per task, since frames are handled asynchronously. */
	readonly #queues = new Map<string, Promise<void>>();
	/** Serializes trust.summary processing per node, so a rejection never plans against an older report. */
	readonly #trustQueues = new Map<string, Promise<void>>();

	constructor(db: Db, options: ClusterOptions = {}) {
		this.#db = db;
		this.#graceMs = options.reconnectGraceMs ?? 120_000;
		this.#chunk = options.inputChunkBytes ?? 48 * 1024;
		this.#idleMs = options.idleTimeoutMs ?? 90_000;
		this.#sshRoute = options.sshRoute;
		this.#audit = options.audit;
		this.#authorizationKey = options.authorizationKey;
		this.#trustWaitMs = options.trustWaitMs ?? 5_000;
	}

	isConnected(nodeId: string): boolean {
		return this.#links.get(nodeId)?.ready === true;
	}

	/** Whether the cached trust report of the node came from the current connection (otherwise it is stale). */
	trustFresh(nodeId: string): boolean {
		return this.#links.get(nodeId)?.trustFresh === true;
	}

	/**
	 * Revokes an authorization, audits it and pushes `revocations.add` to every connected node of its
	 * organization (doc/privilege.md#吊销). Idempotent: a second call changes nothing and pushes nothing.
	 */
	async revokeAuthorization(
		id: string,
		actor: AuditActor,
	): Promise<{ id: string; revokedAt: string; changed: boolean }> {
		const { row, changed } = await revokeAuthorizationRow(this.#db, id);
		const revokedAt = row.revoked_at as string;
		if (!changed) return { id, revokedAt, changed };
		await this.#audit?.record({
			actor,
			action: "authorization.revoked",
			target: { type: "authorization", id },
			detail: { issuer_user_id: row.issuer_user_id, deadline: row.deadline, task_ids: row.task_ids },
		});
		// The privileged mode accepts pushed revocations without a signature; the push is best effort,
		// the next `ok` report sends the whole list again (doc/protocol.md#revocationsadd).
		const entries = await listRevocations(this.#db, row.org_id);
		for (const link of this.#links.values()) {
			const node = await getNode(this.#db, link.conn.nodeId);
			if (node?.org_id === row.org_id) this.#sendRevocations(link, entries);
		}
		return { id, revokedAt, changed };
	}

	/** Called by AgentServer after a successful handshake. */
	attach(conn: NodeConnection, node: NodeRow): void {
		const previous = this.#links.get(node.id);
		const link: NodeLink = {
			conn,
			active: node.status === "active",
			ownerUserId: node.owner_user_id,
			ready: false,
			queried: new Set(),
			trustFresh: false,
			trustWaiters: new Set(),
		};
		this.#links.set(node.id, link);
		previous?.conn.close("replaced by a new connection");
		const timer = this.#graceTimers.get(node.id);
		if (timer) clearTimeout(timer);
		this.#graceTimers.delete(node.id);

		const idle = setTimeout(() => conn.close("idle timeout"), this.#idleMs);
		conn.onActivity(() => idle.refresh());
		if (link.active) this.#registerActive(conn, link);
		else this.#registerRestricted(conn);
		conn.onClose(() => {
			clearTimeout(idle);
			this.#detach(link);
		});
		void markNodeSeen(this.#db, node.id);
		if (link.active) this.#auditConnection(link, "node.connected");
	}

	/** Closes a node's connection, e.g. after approval (crha reconnects as active) or deletion. */
	disconnect(nodeId: string, reason: string): void {
		this.#links.get(nodeId)?.conn.close(reason);
	}

	/**
	 * Tells a connected node about a status change, then closes the connection: crha reconnects as an
	 * active node after approval, or stops (rejected) after deletion. See doc/execution-plane.md#注册.
	 */
	notifyNodeStatus(nodeId: string, state: NodeStatus["state"], message: string): void {
		const link = this.#links.get(nodeId);
		if (!link) return;
		try {
			link.conn.peer.emit("node.status", { nodeId, state, message });
		} catch {
			// The peer is already going away; the close below finishes it.
		}
		link.conn.close(message);
	}

	close(): void {
		for (const ac of this.#sshCancels.values()) ac.abort();
		for (const s of this.#sshSessions.values())
			s.then(
				(x) => x.close(),
				() => {},
			);
		for (const link of this.#links.values()) link.conn.close("server shutting down");
		for (const t of this.#graceTimers.values()) clearTimeout(t);
	}

	#detach(link: NodeLink): void {
		const nodeId = link.conn.nodeId;
		if (this.#links.get(nodeId) !== link) return; // already replaced
		this.#links.delete(nodeId);
		if (!link.active) return;
		this.#auditConnection(link, "node.disconnected");
		void markNodeSeen(this.#db, nodeId);
		this.#graceTimers.set(
			nodeId,
			setTimeout(() => {
				this.#graceTimers.delete(nodeId);
				void this.#expireNode(nodeId);
			}, this.#graceMs),
		);
	}

	#auditConnection(link: NodeLink, action: "node.connected" | "node.disconnected"): void {
		void this.#audit?.record({
			actor: { type: "system", id: "cluster", onBehalfOfUserId: link.ownerUserId },
			action,
			target: { type: "node", id: link.conn.nodeId },
		});
	}

	/** The node did not come back in time: its unfinished tasks become unknown. */
	async #expireNode(nodeId: string): Promise<void> {
		if (this.#links.has(nodeId)) return;
		const rows = await this.#db
			.selectFrom("tasks")
			.select(["id", "state"])
			.where("node_id", "=", nodeId)
			.where("state", "in", ["dispatched", "running"])
			.execute();
		for (const row of rows) {
			const reason = row.state === "dispatched" ? "dispatch_unconfirmed" : "connection_lost";
			await this.#serial(row.id, () => this.#markUnknown(row.id, reason));
		}
	}

	// ---- incoming commands and events ----

	/** An active node: the full command and event set of doc/protocol.md. */
	#registerActive(conn: NodeConnection, link: NodeLink): void {
		const peer = conn.peer;
		peer.onRequest("hello", (hello: Hello) => this.#onHello(link, hello));
		peer.onRequest("ping", (ping) => ping);
		peer.onEvent("task.output", (output) => {
			const live = this.#ownLive(conn.nodeId, output.taskId);
			if (!live) return;
			// A gap means the client could not resend; keep going, the record shows the byte counts.
			live.output.append(output.stream, output.offset, output.data);
		});
		peer.onEvent("task.exit", (exit) => this.#serial(exit.taskId, () => this.#onExit(conn, exit)));
		peer.onEvent("facts", (facts) => this.#onFacts(conn.nodeId, facts));
		// Pushed once after hello and again on every change (doc/protocol.md#新增命令和事件11可选).
		peer.onEvent("trust.summary", (report) => this.#onTrustSummary(link, report));
	}

	/**
	 * A pending node may only report facts and ping; hello is answered with an empty welcome. Everything
	 * else is `node_pending` (doc/protocol.md#受限连接).
	 */
	#registerRestricted(conn: NodeConnection): void {
		const peer = conn.peer;
		peer.onRequest("hello", () => afterResponse<Welcome>({ acks: [] }, () => {}));
		peer.onRequest("ping", (ping) => ping);
		peer.onEvent("facts", (facts) => this.#onFacts(conn.nodeId, facts));
		const pending = () => {
			throw new RemoteError("node_pending", "node is pending approval");
		};
		peer.onRequest("task.start", pending);
		peer.onRequest("task.input", pending);
		peer.onRequest("task.cancel", pending);
		peer.onRequest("task.query", pending);
	}

	async #onFacts(nodeId: string, facts: Facts): Promise<void> {
		await updateNodeFacts(this.#db, nodeId, {
			facts: factsToJson(facts),
			groups: facts.groups,
		});
	}

	// ---- trust cache and revocations ----

	/**
	 * Applies a pushed trust report, then resends the organization's revocations and re-plans the tasks
	 * that wait for an authorization signature (doc/privilege.md#信任缓存, #吊销).
	 */
	async #onTrustSummary(link: NodeLink, report: TrustReport): Promise<void> {
		const nodeId = link.conn.nodeId;
		const change = await this.#queueTrust(nodeId, async () => {
			const result = await recordTrustReport(this.#db, nodeId, report, { audit: this.#audit });
			if (!link.trustFresh) {
				link.trustFresh = true;
				for (const wake of [...link.trustWaiters]) wake();
				link.trustWaiters.clear();
			}
			return result;
		});
		if (report.kind === "ok" && !link.conn.closed) {
			const node = await getNode(this.#db, nodeId);
			if (node) this.#sendRevocations(link, await listRevocations(this.#db, node.org_id));
		}
		// Only an `ok` report carries a digest worth re-planning against: a privileged mode that went
		// away must not fail the tasks that wait for a signature (it may come back with the same trust).
		if (change.changed && report.kind === "ok") await this.#replanAwaiting(nodeId);
	}

	/** Serializes trust processing per node, so a dispatch never plans against an older report. */
	#queueTrust<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
		const next = (this.#trustQueues.get(nodeId) ?? Promise.resolve()).then(fn);
		const tail: Promise<void> = next.then(
			() => {},
			() => {},
		);
		this.#trustQueues.set(nodeId, tail);
		void tail.then(() => {
			if (this.#trustQueues.get(nodeId) === tail) this.#trustQueues.delete(nodeId);
		});
		return next;
	}

	/** Waits for the trust summaries that arrived before this call to be stored (doc/protocol.md#taskstart). */
	async #awaitTrustQueue(nodeId: string): Promise<void> {
		await this.#trustQueues.get(nodeId);
	}

	/** Waits for this connection's first trust summary; crhs does not query it itself. */
	async #waitTrust(link: NodeLink): Promise<void> {
		if (link.trustFresh) return;
		await new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				link.trustWaiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, this.#trustWaitMs);
			link.trustWaiters.add(wake);
		});
	}

	#sendRevocations(link: NodeLink, entries: readonly Revocation[]): void {
		if (entries.length === 0 || link.conn.closed || !link.conn.optional.has("revocations.add")) return;
		for (const batch of batchRevocations(entries)) {
			void link.conn.peer.request("revocations.add", { entries: [...batch] }).catch((err: unknown) => {
				// Retried after the node's next `ok` report; a gone connection needs no log line.
				if (!(err instanceof ConnectionError)) console.error("revocations.add failed:", err);
			});
		}
	}

	/** Re-plans the node's tasks that wait for an authorization signature after its trust digest changed. */
	async #replanAwaiting(nodeId: string): Promise<void> {
		const rows = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			.where("state", "=", "awaiting_authorization")
			.execute();
		for (const { id } of rows) await this.#serial(id, () => this.#replan(id));
	}

	async #replan(id: string): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_authorization") return;
		const node = await getNode(this.#db, row.node_id);
		const link = this.#links.get(row.node_id);
		if (!node || !link || link.conn.closed || !link.ready) return;
		const spec = specFromRow(row.spec, "task");
		const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
		await this.#planPrivileged(id, node, link, spec, input, { timeoutMs: row.timeout_ms ?? undefined }, [
			"awaiting_authorization",
		]);
	}

	/** Reconciles the client's task list with ours, answers with Welcome, then queries the rest. */
	async #onHello(link: NodeLink, hello: Hello): Promise<AfterResponse<Welcome>> {
		const nodeId = link.conn.nodeId;
		// How the node handles privileged tasks is reported here and nowhere else (doc/protocol.md#hello).
		if (hello.privilegedMode) {
			await this.#db
				.updateTable("nodes")
				.set({ privileged_mode: hello.privilegedMode })
				.where("id", "=", nodeId)
				.execute();
		}
		const acks: OutputAck[] = [];
		const reported = new Set<string>();
		for (const t of hello.tasks) {
			const row = await this.#row(t.taskId);
			if (!row || row.node_id !== nodeId) continue;
			reported.add(t.taskId);
			// It ran because the client had accepted it, but the success response never reached us.
			if (row.state === "dispatched") await this.#serial(t.taskId, () => this.#onAccepted(nodeId, t.taskId));
			// A recorded result needs no output: ack the stored totals, so crha drops its buffer instead of
			// resending it and charging the group budget a second time. An `unknown` task still accepts a late
			// result, so it keeps the old behaviour and may resend (doc/execution-plane.md#输出).
			if (recorded(row.state)) {
				acks.push({
					taskId: t.taskId,
					stdoutOffset: Number(row.stdout_bytes),
					stderrOffset: Number(row.stderr_bytes),
				});
				continue;
			}
			// After a crhs restart the output is gone from memory: start over and let the client resend it all.
			const live = this.#live.get(t.taskId) ?? this.#newLive(t.taskId, nodeId, row.output_mode, row.task_group_id);
			acks.push({
				taskId: t.taskId,
				stdoutOffset: live.output.end("stdout"),
				stderrOffset: live.output.end("stderr"),
			});
		}
		// The queries must not overtake the welcome, so they start only once it has been sent.
		const open = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			.where("state", "in", ["dispatched", "running"])
			.execute();
		return afterResponse({ acks }, () => {
			link.ready = true;
			for (const { id } of open) {
				if (reported.has(id)) continue;
				link.queried.add(id);
				link.conn.peer.request("task.query", { taskId: id }).then(
					(status) => {
						void this.#serial(id, () => this.#onStatus(link, status));
					},
					(err: unknown) => {
						if (err instanceof ConnectionError) return;
						console.error("task.query failed:", err);
					},
				);
			}
		});
	}

	async #onStatus(link: NodeLink, status: TaskStatus): Promise<void> {
		if (!link.queried.delete(status.taskId)) return;
		if (status.state !== "unknown") return; // it will show up in the next Hello or send TaskExit
		const row = await this.#row(status.taskId);
		if (!row || row.node_id !== link.conn.nodeId || TERMINAL.has(row.state)) return;
		// Not accepted: the start may never have arrived. Accepted: the client restarted and lost it.
		await this.#markUnknown(row.id, row.state === "dispatched" ? "dispatch_unconfirmed" : "executor_restarted");
	}

	async #onAccepted(nodeId: string, taskId: string): Promise<void> {
		await this.#db
			.updateTable("tasks")
			.set({ state: "running", accepted_at: now() })
			.where("id", "=", taskId)
			.where("node_id", "=", nodeId)
			.where("state", "=", "dispatched")
			.execute();
		this.#notify(taskId);
	}

	async #onExit(conn: NodeConnection, exit: TaskExit): Promise<void> {
		const row = await this.#row(exit.taskId);
		if (!row || row.node_id !== conn.nodeId) return;
		const existing = this.#live.get(exit.taskId);
		// The result is already recorded and crha resent task.exit after a lost task.exit.ack: there is no
		// live record to complete, and re-sending the task must not close the connection in a loop.
		if (recorded(row.state) && !existing) {
			conn.peer.emit("task.exit.ack", { taskId: row.id });
			return;
		}
		const live = existing ?? this.#newLive(exit.taskId, conn.nodeId, row.output_mode, row.task_group_id);
		// TaskExit follows all output on the wire; if bytes are missing, the client will resend after a
		// reconnect and send TaskExit again. Record what we have only when complete. A `status` task gets
		// no task.output at all, so there is nothing to wait for (doc/execution-plane.md#输出).
		const complete =
			row.output_mode === "status" ||
			(live.output.end("stdout") >= exit.stdoutEnd && live.output.end("stderr") >= exit.stderrEnd);
		if (!complete) return conn.close("output incomplete at exit");

		// A status task's byte totals come from task.exit; the other modes already received the bytes.
		const output =
			row.output_mode === "status"
				? live.output.snapshot({ stdout: exit.stdoutEnd, stderr: exit.stderrEnd })
				: live.output.snapshot();
		const outcome = exit.outcome;
		const fields: Updateable<TasksTable> = {
			exit_code: outcome.kind === "code" ? outcome.value : null,
			signal: outcome.kind === "signal" ? outcome.value : null,
			error_code: outcome.kind === "error" ? outcome.code : null,
			error_message: outcome.kind === "error" ? outcome.message : null,
			timed_out: exit.timedOut ? 1 : 0,
			cancelled: exit.cancelled ? 1 : 0,
			...outputColumns(output),
			output_file: exit.outputFile || null,
		};
		if (row.state === "unknown") {
			// Already reported as unknown: keep that answer, but record what really happened.
			await this.#db
				.updateTable("tasks")
				.set({ late_result: JSON.stringify(fields) })
				.where("id", "=", row.id)
				.execute();
		} else if (!TERMINAL.has(row.state)) {
			await this.#finish(conn.nodeId, row.id, { ...fields, state: outcome.kind === "error" ? "failed" : "exited" });
		}
		this.#dropLive(row.id);
		conn.peer.emit("task.exit.ack", { taskId: row.id });
	}

	// ---- task API ----

	/** How the rule chain judges running `spec` on a node. */
	async evaluateFor(node: NodeRow, spec: TaskSpec, chain: RuleRef[], privileged: boolean): Promise<Evaluation> {
		const groups = (await nodeGroupNames(this.#db, [node.id])).get(node.id) ?? [];
		const levels = await loadChain(this.#db, chain);
		return evaluate(levels, {
			...operationOf(spec),
			node: { id: node.id, name: node.name, groups },
			privileged,
		});
	}

	/**
	 * Creates a task. With a rule chain it is first judged: denied, left waiting for approval, or
	 * dispatched. A node that is not connected at dispatch fails it at once with node_offline.
	 */
	async createTask(input: CreateTaskInput): Promise<TaskView> {
		const node = await getNode(this.#db, input.nodeId);
		if (!node) throw new Error(`no such node: ${input.nodeId}`);
		const kind = input.spec.kind;
		if (input.id) {
			const existing = await this.getTask(input.id);
			if (existing) return existing;
		}
		const id = input.id ?? newId();
		const inputBytes = input.input ?? new Uint8Array(0);
		const inputSha = createHash("sha256").update(inputBytes).digest();
		const spec = withInputRef(input.spec, input.input ? { size: inputBytes.length, sha256: inputSha } : undefined);

		let approval: ApprovalRecord | undefined;
		let verdict: "allow" | "deny" | "require-approval" = "allow";
		const privileged = input.privileged === true;
		if (input.chain) {
			const evaluation = await this.evaluateFor(node, input.spec, input.chain, privileged);
			approval = { evaluation };
			verdict = evaluation.result;
			if (verdict === "require-approval" && input.approvedBy) {
				approval.decision = input.approvedBy;
				verdict = "allow";
			}
		}
		const waiting = verdict === "require-approval";
		const denied = verdict === "deny";
		const root = input.chain?.[0];
		await this.#db
			.insertInto("tasks")
			.values({
				id,
				org_id: node.org_id,
				node_id: node.id,
				task_group_id: input.taskGroupId ?? null,
				kind,
				spec: JSON.stringify(taskSpecToJson(spec)),
				attempt: 1,
				input_size: input.input ? inputBytes.length : null,
				input_sha256: input.input ? inputSha.toString("hex") : null,
				privileged: input.privileged ? 1 : 0,
				timeout_ms: input.timeoutMs ?? null,
				output_mode: input.outputMode ?? "full",
				// Allowed tasks pass through awaiting_approval only for the instant before dispatch.
				state: denied ? "denied" : "awaiting_approval",
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: denied ? "policy_denied" : null,
				error_message: denied ? "denied by the authorization rules" : null,
				actor_type: input.actor.type,
				actor_id: input.actor.id,
				on_behalf_of_user_id: input.actor.onBehalfOfUserId,
				created_at: now(),
				dispatched_at: null,
				accepted_at: null,
				finished_at: denied ? now() : null,
				stdout_bytes: 0,
				stderr_bytes: 0,
				stdout_head: null,
				stdout_tail: null,
				stderr_head: null,
				stderr_tail: null,
				output_file: null,
				late_result: null,
				rule_chain: input.chain ? JSON.stringify(input.chain) : null,
				approval: approval ? JSON.stringify(approval) : null,
				pending_input: waiting && input.input ? Buffer.from(inputBytes).toString("base64") : null,
				root_session_id: root?.type === "session" ? root.id : null,
				// Until an ancestor agent is routed, the user (the task's on_behalf user) is the handler.
				handler_type: waiting ? "user" : null,
				handler_session_id: null,
			})
			.execute();
		void this.#audit?.record({
			actor: auditActor(input.actor),
			action: "task.created",
			target: { type: "task", id },
			detail: {
				node_id: node.id,
				kind,
				summary: summarize(JSON.stringify(taskSpecToJson(spec))),
				task_group_id: input.taskGroupId,
				input_sha256: input.input ? inputSha.toString("hex") : undefined,
				privileged,
				policy: approval ? approval.evaluation.result : "none",
				approved_by_group: approval?.decision ? input.taskGroupId : undefined,
			},
		});
		if (!waiting && !denied) await this.#serial(id, () => this.#dispatch(id, node, spec, inputBytes, input));
		const view = (await this.getTask(id)) as TaskView;
		if (waiting) {
			this.onChange?.(view.actorId);
			if (this.onAwaitingApproval) {
				void this.onAwaitingApproval(view).catch((err: unknown) => console.error("review:", err));
			}
		}
		return view;
	}

	/** Moves a task out of awaiting_approval: sends it, parks it for authorization, or fails it. */
	async #dispatch(
		id: string,
		node: NodeRow,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		opts: { privileged?: boolean; timeoutMs?: number },
	): Promise<void> {
		const ssh = node.transport === "ssh";
		const link = this.#links.get(node.id);
		const row = await this.#row(id);
		const fresh = await getNode(this.#db, node.id);
		const online =
			fresh?.status === "active" && (ssh ? this.#sshRoute !== undefined : link?.ready === true && !link.conn.closed);
		if (!online) {
			const res = await this.#db
				.updateTable("tasks")
				.set({
					state: "failed",
					error_code: "node_offline",
					error_message: "the node is not connected",
					finished_at: now(),
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				})
				.where("id", "=", id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return;
			this.#notify(id);
			void this.#syncGroupState(row?.task_group_id ?? null);
			return this.#auditFinish(id);
		}
		// A privileged task on a forward node needs an authorization before task.start (doc/privilege.md#授权路径).
		// native/ignore/reject nodes, SSH nodes and ordinary tasks keep the plain dispatch below.
		if (!ssh && link && row?.privileged === 1 && fresh?.privileged_mode === "forward") {
			await this.#planPrivileged(id, fresh, link, spec, inputBytes, opts, ["awaiting_approval"]);
			return;
		}
		const res = await this.#db
			.updateTable("tasks")
			.set({
				state: "dispatched",
				dispatched_at: now(),
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
			})
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		this.#notify(id);
		if (ssh) {
			this.#newLive(id, node.id, row?.output_mode ?? "full", row?.task_group_id ?? null);
			void this.#runSsh(
				id,
				node,
				spec,
				inputBytes.length > 0 ? inputBytes : undefined,
				opts.timeoutMs,
				opts.privileged === true,
			);
		} else if (link) {
			this.#newLive(id, node.id, row?.output_mode ?? "full", row?.task_group_id ?? null);
			// The start may be refused or the link may drop; the state machine follows the response.
			void this.#dispatchRemote(link, id, spec, inputBytes, opts);
		}
	}

	/**
	 * Computes the authorization plan of a privileged task and acts on it: signs and dispatches through
	 * crhs, waits for the owner's signature, or rejects (doc/privilege.md#授权路径, #预演与 fallback).
	 */
	async #planPrivileged(
		id: string,
		node: NodeRow,
		link: NodeLink,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		opts: { timeoutMs?: number },
		from: readonly TaskRowState[],
	): Promise<void> {
		const row = await this.#row(id);
		if (!row || !from.includes(row.state)) return;
		if (!link.conn.supportsForward) {
			// A 1.0 crha cannot take part in forward whatever its reported mode says (doc/protocol.md#握手载荷).
			await this.#finishAuthorization(
				id,
				row,
				"failed",
				"privileged_unsupported",
				"the node's crha does not support forward",
				null,
			);
			return;
		}
		await this.#waitTrust(link);
		const fresh = await getNode(this.#db, node.id);
		const report = fresh ? parseTrustReport(fresh.trust_report) : null;
		// A report kept from a previous connection is stale until this connection reports again: the node's
		// trust configuration may have changed while it was away (doc/privilege.md#信任缓存).
		if (!fresh || !link.trustFresh || report?.kind !== "ok") {
			const message = link.trustFresh
				? trustUnavailableMessage(report)
				: "the node has not reported a trust summary on this connection";
			await this.#finishAuthorization(id, row, "failed", "privileged_unavailable", message, null);
			return;
		}
		const previous = parseTaskAuthorization(row.authorization);
		const tried = previous ? [...previous.tried] : [];
		// Without a signing key crhs cannot take its own path; treating it as tried keeps the plan honest.
		if (!this.#authorizationKey && !tried.includes("crhs")) tried.push("crhs");
		const plan = planAuthorization({
			summary: report.summary,
			nodeId: node.id,
			nodeGroups: report.summary.groups,
			task: { id, attempt: row.attempt, spec, privileged: true },
			taskGroup: row.task_group_id !== null,
			owner: await ownerCredentials(this.#db, row.on_behalf_of_user_id),
			...(this.#authorizationKey ? { crhsFingerprint: this.#authorizationKey.fingerprint } : {}),
			tried,
			now: Date.now(),
		});
		const record: TaskAuthorizationRecord = {
			plan: planView(plan),
			tried,
			dispatchedPath: previous?.dispatchedPath ?? null,
			payloadId: previous?.payloadId ?? null,
			attempt: row.attempt,
			trustDigest: fresh.trust_digest,
			lastRejection: previous?.lastRejection ?? null,
			updatedAt: new Date().toISOString(),
		};
		const crhsPath = plan.paths.find((path) => path.path === "crhs");
		if (crhsPath?.path === "crhs") {
			await this.#dispatchCrhs(id, row, node, link, spec, inputBytes, opts, record, crhsPath.authorization, from);
			return;
		}
		if (plan.paths.length > 0) {
			// The owner's user entries and/or local approval remain: the next wave signs (M4.4), so for now
			// the task waits and keeps its input; nothing is sent to the node yet.
			const updated = await this.#updateTask(id, from, {
				state: "awaiting_authorization",
				authorization: serializeTaskAuthorization({ ...record, dispatchedPath: null }),
				pending_input: inputBytes.length > 0 ? Buffer.from(inputBytes).toString("base64") : null,
				dispatched_at: null,
				handler_type: "user",
				handler_session_id: null,
			});
			if (!updated) return;
			void this.#syncGroupState(row.task_group_id);
			this.onChange?.(row.actor_id);
			return;
		}
		const code = record.lastRejection?.code ?? "authorization_required";
		const reason = plan.reason ?? "no one on this node can authorize this command";
		const message = record.lastRejection === null ? reason : `${record.lastRejection.message}; ${reason}`;
		await this.#finishAuthorization(id, row, "rejected", code, message, { ...record, dispatchedPath: null });
	}

	/** Signs the planned payload with crhs's key, stores it and sends it inside task.start. */
	async #dispatchCrhs(
		id: string,
		row: Selectable<TasksTable>,
		node: NodeRow,
		link: NodeLink,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		opts: { timeoutMs?: number },
		record: TaskAuthorizationRecord,
		authorization: BuiltAuthorization,
		from: readonly TaskRowState[],
	): Promise<void> {
		const key = this.#authorizationKey;
		if (!key) {
			await this.#finishAuthorization(
				id,
				row,
				"rejected",
				"authorization_required",
				"crhs has no authorization signing key",
				record,
			);
			return;
		}
		let encoded: Uint8Array;
		let signatures: Signature[];
		try {
			signatures = [{ kind: "sshsig", blob: key.sign(authorization.bytes) }];
			const wire: Authorization = { payload: authorization.bytes, signatures };
			encoded = encodeCbor(authorizationCodec.encode(wire));
		} catch (err) {
			await this.#finishAuthorization(
				id,
				row,
				"failed",
				"invalid_spec",
				`cannot encode the authorization: ${errorText(err)}`,
				record,
			);
			return;
		}
		// An authorization may take at most half a frame so the rest of task.start still fits (doc/protocol.md#授权对象).
		if (encoded.length > MAX_FRAME_BYTES / 2) {
			await this.#finishAuthorization(
				id,
				row,
				"failed",
				"invalid_spec",
				`the authorization is ${encoded.length} bytes, more than half a frame`,
				record,
			);
			return;
		}
		if (await this.#storeAuthorization(node, authorization, signatures)) {
			// crhs-signed authorizations are audited like user ones (doc/access-control.md#记录内容).
			void this.#audit?.record({
				actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
				action: "authorization.issued",
				target: { type: "authorization", id: authorization.id },
				detail: {
					node_id: node.id,
					task_id: id,
					attempt: row.attempt,
					deadline:
						authorization.payload.deadlineMs === null ? null : new Date(authorization.payload.deadlineMs).toISOString(),
					trust_digest: record.trustDigest,
				},
			});
		}
		const updated: TaskAuthorizationRecord = {
			...record,
			dispatchedPath: "crhs",
			payloadId: authorization.id,
			attempt: row.attempt,
			updatedAt: new Date().toISOString(),
		};
		const claimed = await this.#updateTask(id, from, {
			state: "dispatched",
			dispatched_at: now(),
			authorization: serializeTaskAuthorization(updated),
			pending_input: null,
			handler_type: null,
			handler_session_id: null,
		});
		if (!claimed) return;
		this.#newLive(id, node.id, row.output_mode, row.task_group_id);
		void this.#syncGroupState(row.task_group_id);
		const start: TaskStart = {
			taskId: id,
			attempt: row.attempt,
			spec,
			privileged: true,
			authorizations: [encoded],
			timeoutMs: opts.timeoutMs ?? row.timeout_ms ?? 0,
			killGraceMs: 0,
			output: outputModeOf(row.output_mode),
		};
		await this.#sendAuthorizedStart(link, node.id, id, spec, inputBytes, start, updated);
	}

	/**
	 * Sends an authorized task.start and follows up: accepted, terminal failure, or a retryable
	 * authorization rejection that re-plans with `attempt + 1` (doc/execution-plane.md#不重复执行与授权重试).
	 */
	async #sendAuthorizedStart(
		link: NodeLink,
		nodeId: string,
		id: string,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		start: TaskStart,
		record: TaskAuthorizationRecord,
	): Promise<void> {
		try {
			await link.conn.peer.request("task.start", start);
		} catch (err) {
			if (err instanceof ConnectionError) {
				// The task stays dispatched; the grace timer reports dispatch_unconfirmed, never a retry.
				return;
			}
			if (err instanceof RemoteError && AUTHORIZATION_CODES.has(err.code)) {
				await this.#retryAuthorization(link, id, spec, inputBytes, record, err.code, err.message);
				return;
			}
			if (err instanceof RemoteError) {
				await this.#finish(nodeId, id, { state: "failed", error_code: err.code, error_message: err.message });
				return;
			}
			if (err instanceof ProtocolError) {
				// Raised locally while encoding: the request was never sent, so nothing can have run.
				await this.#finish(nodeId, id, { state: "failed", error_code: "invalid_spec", error_message: err.message });
				return;
			}
			console.error("task.start failed:", err);
			link.conn.close("send failed");
			return;
		}
		await this.#onAccepted(nodeId, id);
		for (let off = 0; off < inputBytes.length; off += this.#chunk) {
			void link.conn.peer
				.request("task.input", { taskId: id, offset: off, data: inputBytes.subarray(off, off + this.#chunk) })
				.catch((err: unknown) => console.error(`task.input for ${id} failed:`, err));
		}
	}

	/**
	 * A crha rejected the authorization before accepting, so nothing ran: the path that was sent is
	 * ruled out, the attempt advances and the plan is recomputed from the refreshed trust summary.
	 */
	async #retryAuthorization(
		link: NodeLink,
		id: string,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		record: TaskAuthorizationRecord,
		code: string,
		message: string,
	): Promise<void> {
		// crha refreshes its trust summary before sending an authorization_* error on the same connection.
		await this.#awaitTrustQueue(link.conn.nodeId);
		const row = await this.#row(id);
		if (row?.state !== "dispatched") return; // accepted (or ended) meanwhile: never retried
		const attempt = row.attempt + 1;
		const updated: TaskAuthorizationRecord = {
			...record,
			tried: [...new Set([...record.tried, record.dispatchedPath ?? "crhs"])],
			attempt,
			lastRejection: { code, message, attempt: row.attempt, at: new Date().toISOString() },
			updatedAt: new Date().toISOString(),
		};
		const res = await this.#db
			.updateTable("tasks")
			.set({
				state: "awaiting_authorization",
				attempt,
				authorization: serializeTaskAuthorization(updated),
				pending_input: inputBytes.length > 0 ? Buffer.from(inputBytes).toString("base64") : null,
				dispatched_at: null,
				handler_type: "user",
				handler_session_id: null,
			})
			.where("id", "=", id)
			.where("state", "=", "dispatched")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		this.#dropLive(id);
		this.#notify(id);
		void this.#syncGroupState(row.task_group_id);
		const node = await getNode(this.#db, row.node_id);
		const current = this.#links.get(row.node_id);
		if (!node || !current || current.conn.closed || !current.ready) return;
		await this.#planPrivileged(id, node, current, spec, inputBytes, { timeoutMs: row.timeout_ms ?? undefined }, [
			"awaiting_authorization",
		]);
	}

	/** Ends a task that could not be authorized, with the plan and the reason on its record. */
	async #finishAuthorization(
		id: string,
		row: Selectable<TasksTable>,
		state: "failed" | "rejected",
		code: string,
		message: string,
		record: TaskAuthorizationRecord | null,
	): Promise<void> {
		const res = await this.#db
			.updateTable("tasks")
			.set({
				state,
				error_code: code,
				error_message: message,
				...(record ? { authorization: serializeTaskAuthorization(record) } : {}),
				pending_input: null,
				dispatched_at: null,
				finished_at: now(),
				handler_type: null,
				handler_session_id: null,
			})
			.where("id", "=", id)
			.where("state", "=", row.state)
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		this.#dropLive(id);
		this.#notify(id);
		void this.#syncGroupState(row.task_group_id);
		this.onChange?.(row.actor_id);
		await this.#auditFinish(id);
	}

	/**
	 * Stores the signed payload, verbatim, for display, lookup and revocation (doc/m4.md#crhs-侧数据).
	 * Returns whether this call inserted it (an id already present is left alone).
	 */
	async #storeAuthorization(
		node: NodeRow,
		authorization: BuiltAuthorization,
		signatures: readonly Signature[],
	): Promise<boolean> {
		const existing = await this.#db
			.selectFrom("authorizations")
			.select("id")
			.where("id", "=", authorization.id)
			.executeTakeFirst();
		if (existing) return false;
		const { deadlineMs, taskIds } = authorization.payload;
		await this.#db
			.insertInto("authorizations")
			.values({
				id: authorization.id,
				org_id: node.org_id,
				payload: Buffer.from(authorization.bytes).toString("base64"),
				signatures: JSON.stringify(signatures.map(signatureToJson)),
				issuer_user_id: null,
				task_ids: taskIds === null ? null : JSON.stringify(taskIds),
				deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
				created_at: now(),
				revoked_at: null,
			})
			.execute();
		return true;
	}

	/** Updates a task only from the states the caller has observed, so a settled task is never rewritten. */
	async #updateTask(id: string, from: readonly TaskRowState[], set: Updateable<TasksTable>): Promise<boolean> {
		const res = await this.#db
			.updateTable("tasks")
			.set(set)
			.where("id", "=", id)
			.where("state", "in", [...from])
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return false;
		this.#notify(id);
		return true;
	}

	/**
	 * A task group shows awaiting_authorization while every unfinished task of it waits for a signature,
	 * and running otherwise (doc/execution-plane.md#状态机). The group's own end states are left alone.
	 */
	async #syncGroupState(groupId: string | null): Promise<void> {
		if (!groupId) return;
		const group = await this.#db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirst();
		if (!group || (group.state !== "running" && group.state !== "awaiting_authorization")) return;
		const rows = await this.#db.selectFrom("tasks").select("state").where("task_group_id", "=", groupId).execute();
		const unfinished = rows.filter((row) => !TERMINAL.has(row.state));
		const next =
			unfinished.length > 0 && unfinished.every((row) => row.state === "awaiting_authorization")
				? "awaiting_authorization"
				: "running";
		if (next === group.state) return;
		await this.#db
			.updateTable("task_groups")
			.set({ state: next })
			.where("id", "=", groupId)
			.where("state", "=", group.state)
			.execute();
	}

	/**
	 * Sends `task.start` exactly once, then, once accepted, the input as pipelined `task.input` requests.
	 * See doc/execution-plane.md#不重复执行与授权重试.
	 */
	async #dispatchRemote(
		link: NodeLink,
		id: string,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		opts: { privileged?: boolean; timeoutMs?: number },
	): Promise<void> {
		const nodeId = link.conn.nodeId;
		const row = await this.#row(id);
		const mode = row?.output_mode ?? "full";
		const start: TaskStart = {
			taskId: id,
			attempt: row?.attempt ?? 1,
			spec,
			privileged: opts.privileged ?? false,
			authorizations: [],
			timeoutMs: opts.timeoutMs ?? 0,
			killGraceMs: 0,
			output: outputModeOf(mode),
		};
		try {
			await link.conn.peer.request("task.start", start);
		} catch (err) {
			if (err instanceof ConnectionError) {
				// The task stays dispatched; the grace timer reports dispatch_unconfirmed.
				return;
			}
			if (err instanceof RemoteError) {
				const final: Updateable<TasksTable> = AUTHORIZATION_CODES.has(err.code)
					? { state: "rejected", error_code: err.code, error_message: err.message }
					: { state: "failed", error_code: err.code, error_message: err.message };
				await this.#serial(id, () => this.#finish(nodeId, id, final));
				return;
			}
			if (err instanceof ProtocolError) {
				// Raised locally while encoding: the request was never sent, so nothing can have run.
				await this.#serial(id, () =>
					this.#finish(nodeId, id, { state: "failed", error_code: "invalid_spec", error_message: err.message }),
				);
				return;
			}
			console.error("task.start failed:", err);
			link.conn.close("send failed");
			return;
		}
		await this.#serial(id, () => this.#onAccepted(nodeId, id));
		// Pipelined: crha processes the chunks in order; a failed chunk fails the task on its side.
		for (let off = 0; off < inputBytes.length; off += this.#chunk) {
			void link.conn.peer
				.request("task.input", { taskId: id, offset: off, data: inputBytes.subarray(off, off + this.#chunk) })
				.catch((err: unknown) => console.error(`task.input for ${id} failed:`, err));
		}
	}

	/**
	 * Settles a task waiting for approval. Returns false if it is not waiting (already settled, or never
	 * needed approval). Who may decide is checked by the caller.
	 */
	decide(id: string, decision: ApprovalDecision): Promise<boolean> {
		return this.#serialResult(id, async () => {
			const row = await this.#row(id);
			if (row?.state !== "awaiting_approval") return false;
			const record: ApprovalRecord = { ...(JSON.parse(row.approval ?? "{}") as ApprovalRecord), decision };
			if (decision.decision === "approved") {
				// Read the spec before recording the decision: migration 0019 may have left a row it could not
				// convert, and the caller gets a client error instead of a half-approved task.
				const spec = specFromRow(row.spec, "task");
				await this.#db
					.updateTable("tasks")
					.set({ approval: JSON.stringify(record) })
					.where("id", "=", id)
					.execute();
				const node = await getNode(this.#db, row.node_id);
				const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
				void this.#auditApproval(row, decision);
				if (node) {
					await this.#dispatch(id, node, spec, input, {
						privileged: row.privileged === 1,
						timeoutMs: row.timeout_ms ?? undefined,
					});
				}
				this.onChange?.(row.actor_id);
				return true;
			}
			const res = await this.#db
				.updateTable("tasks")
				.set({
					state: "rejected",
					error_code: "approval_rejected",
					error_message: decision.reason ?? "approval rejected",
					approval: JSON.stringify(record),
					pending_input: null,
					finished_at: now(),
					handler_type: null,
					handler_session_id: null,
				})
				.where("id", "=", id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return false;
			this.onChange?.(row.actor_id);
			void this.#auditApproval(row, decision);
			this.#notify(id);
			return true;
		});
	}

	/** Stores Auto Review's verdict on a waiting task. */
	async recordReview(id: string, review: NonNullable<ApprovalRecord["review"]>): Promise<void> {
		await this.#serial(id, async () => {
			const row = await this.#row(id);
			if (row?.state !== "awaiting_approval") return;
			const record: ApprovalRecord = { ...(JSON.parse(row.approval ?? "{}") as ApprovalRecord), review };
			await this.#db
				.updateTable("tasks")
				.set({ approval: JSON.stringify(record) })
				.where("id", "=", id)
				.execute();
			void this.#audit?.record({
				actor: { type: "system", id: "auto-review", onBehalfOfUserId: row.on_behalf_of_user_id },
				action: "task.review",
				target: { type: "task", id },
				detail: review,
			});
		});
	}

	/**
	 * Hands a waiting task's approval to an ancestor session's agent. False when it is no longer waiting (Auto Review
	 * or the user settled it first).
	 */
	requestAgentDecision(id: string, session: string): Promise<boolean> {
		return this.#serialResult(id, async () => {
			const row = await this.#row(id);
			if (row?.state !== "awaiting_approval") return false;
			const record: ApprovalRecord = {
				...(JSON.parse(row.approval ?? "{}") as ApprovalRecord),
				agent: { session, state: "pending" },
			};
			await this.#db
				.updateTable("tasks")
				.set({
					approval: JSON.stringify(record),
					handler_type: "agent",
					handler_session_id: session,
				})
				.where("id", "=", id)
				.execute();
			this.onChange?.(row.actor_id);
			void this.#audit?.record({
				actor: { type: "system", id: "agent-routing" },
				action: "task.agent_request",
				target: { type: "task", id },
				detail: { session },
			});
			return true;
		});
	}

	/** The agent passed the request on to the user: the approval page takes it from here. */
	escalateAgentDecision(id: string, session: string): Promise<boolean> {
		return this.#serialResult(id, async () => {
			const row = await this.#row(id);
			if (row?.state !== "awaiting_approval") return false;
			const record: ApprovalRecord = {
				...(JSON.parse(row.approval ?? "{}") as ApprovalRecord),
				agent: { session, state: "escalated" },
			};
			await this.#db
				.updateTable("tasks")
				.set({
					approval: JSON.stringify(record),
					handler_type: "user",
					handler_session_id: null,
				})
				.where("id", "=", id)
				.execute();
			this.onChange?.(row.actor_id);
			void this.#audit?.record({
				actor: { type: "system", id: "agent-routing" },
				action: "task.agent_escalated",
				target: { type: "task", id },
				detail: { session },
			});
			return true;
		});
	}

	/**
	 * Judges waiting tasks again after rules on their chain changed (doc/access-control.md#审批): allow
	 * dispatches them, deny ends them, require-approval leaves them waiting.
	 */
	async reevaluate(ref: RuleRef): Promise<void> {
		const rows = await this.#db
			.selectFrom("tasks")
			.selectAll()
			.where("state", "=", "awaiting_approval")
			.where("rule_chain", "is not", null)
			.execute();
		for (const row of rows) {
			const chain = JSON.parse(row.rule_chain ?? "[]") as RuleRef[];
			if (!chain.some((r) => r.type === ref.type && r.id === ref.id)) continue;
			const node = await getNode(this.#db, row.node_id);
			if (!node) continue;
			let evaluation: Evaluation;
			try {
				evaluation = await this.evaluateFor(node, taskSpecFromJson(JSON.parse(row.spec)), chain, row.privileged === 1);
			} catch {
				continue; // a level is gone (e.g. a revoked token); expiry ends the task
			}
			const by = { type: "system", id: "rules" };
			if (evaluation.result === "allow") {
				await this.decide(row.id, { decision: "approved", by, at: now(), reason: "allowed by changed rules" });
			} else if (evaluation.result === "deny") {
				await this.#serial(row.id, async () => {
					const res = await this.#db
						.updateTable("tasks")
						.set({
							state: "denied",
							error_code: "policy_denied",
							error_message: "denied by the authorization rules",
							approval: JSON.stringify({ evaluation }),
							pending_input: null,
							finished_at: now(),
							handler_type: null,
							handler_session_id: null,
						})
						.where("id", "=", row.id)
						.where("state", "=", "awaiting_approval")
						.executeTakeFirst();
					if (res.numUpdatedRows > 0n) {
						this.onChange?.(row.actor_id);
						this.#notify(row.id);
						await this.#auditFinish(row.id);
					}
				});
			}
		}
	}

	async getTask(id: string): Promise<TaskView | undefined> {
		const row = await this.#row(id);
		return row ? toView(row, this.#live.get(id)) : undefined;
	}

	/** Waits until the task is in a final state, or until timeoutMs passes; returns its current view. */
	async waitTask(id: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskView | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const view = await this.getTask(id);
			if (!view || TERMINAL.has(view.state) || Date.now() >= deadline || signal?.aborted) return view;
			await new Promise<void>((resolve) => {
				const waiters = this.#waiters.get(id) ?? new Set();
				this.#waiters.set(id, waiters);
				const done = () => {
					clearTimeout(timer);
					waiters.delete(done);
					signal?.removeEventListener("abort", done);
					resolve();
				};
				const timer = setTimeout(done, deadline - Date.now());
				signal?.addEventListener("abort", done);
				waiters.add(done);
			});
		}
	}

	/**
	 * Asks the node to cancel a running task. A task that still waits for its approval or its
	 * authorization signature was never dispatched, so it ends here instead (there is no node-side task).
	 * Returns false if the task already ended or the node is offline.
	 */
	async cancelTask(id: string): Promise<boolean> {
		const row = await this.#row(id);
		if (!row || TERMINAL.has(row.state)) return false;
		if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") {
			const res = await this.#db
				.updateTable("tasks")
				.set({
					state: "rejected",
					error_code: "cancelled",
					error_message: "the task was cancelled before it was dispatched",
					cancelled: 1,
					finished_at: now(),
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				})
				.where("id", "=", id)
				.where("state", "=", row.state)
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return false;
			this.#notify(id);
			void this.#syncGroupState(row.task_group_id);
			this.onChange?.(row.actor_id);
			await this.#auditFinish(id);
			return true;
		}
		const ssh = this.#sshCancels.get(id);
		if (ssh) {
			ssh.abort();
			return true;
		}
		const link = this.#links.get(row.node_id);
		if (!link?.ready) return false;
		void link.conn.peer.request("task.cancel", { taskId: id }).catch((err: unknown) => {
			if (!(err instanceof ConnectionError)) console.error(`task.cancel for ${id} failed:`, err);
		});
		return true;
	}

	/**
	 * Releases the output budget a batch `text` group shares. TaskGroups calls this when the group itself is
	 * done (finished, interrupted or rejected), not when its last task ends: with `parallel: 1` every node
	 * would otherwise get a fresh budget. Returns whether a budget was still held.
	 */
	releaseGroupBudget(groupId: string): boolean {
		return this.#budgets.delete(groupBudgetKey(groupId));
	}

	// ---- SSH nodes: no crha, no resume; see doc/execution-plane.md#ssh-传输 ----

	#sshSession(node: NodeRow): Promise<SshSession> {
		const existing = this.#sshSessions.get(node.id);
		if (existing) return existing;
		const route = this.#sshRoute as NonNullable<ClusterOptions["sshRoute"]>;
		const session = route(node).then(connectSsh);
		this.#sshSessions.set(node.id, session);
		session.then(
			(s) => s.onClose(() => this.#sshSessions.get(node.id) === session && this.#sshSessions.delete(node.id)),
			() => this.#sshSessions.delete(node.id),
		);
		return session;
	}

	async #runSsh(
		id: string,
		node: NodeRow,
		spec: TaskSpec,
		input: Uint8Array | undefined,
		timeoutMs: number | undefined,
		privileged: boolean,
	): Promise<void> {
		const live = this.#live.get(id) as Live;
		let isStarted = false;
		// SSH has no privileged mode: the task runs as the SSH user, and its output says so before
		// anything else (doc/execution-plane.md#ssh-传输). Written once, before the first run, so a
		// stale pooled connection that is replaced does not repeat it.
		let noticeWritten = false;
		const sink = {
			stdout: (d: Uint8Array) => void live.output.append("stdout", live.output.end("stdout"), d),
			stderr: (d: Uint8Array) => void live.output.append("stderr", live.output.end("stderr"), d),
			started: () => {
				isStarted = true;
				void this.#serial(id, () => this.#onAccepted(node.id, id));
			},
		};
		const ac = new AbortController();
		this.#sshCancels.set(id, ac);
		// SSH keeps no full output (no output file): status saves only byte counts, text its budgeted tail.
		const outputFields = () => outputColumns(live.output.snapshot());
		try {
			let fields: Updateable<TasksTable>;
			// A pooled connection may have died without notice; nothing has run yet, so retry once fresh.
			for (let attempt = 0; ; attempt++) {
				const session = await this.#sshSession(node);
				if (!noticeWritten) {
					const notice = sshPrivilegedNotice(privileged);
					if (notice) live.output.append("stderr", live.output.end("stderr"), notice);
					noticeWritten = true;
				}
				try {
					fields = await this.#sshTask(session, spec, input, timeoutMs, ac.signal, sink);
					break;
				} catch (err) {
					if (isStarted || attempt > 0 || !(err instanceof SshError)) throw err;
					session.close();
				}
			}
			// For SSH nodes "last seen" is the last task that reached the node.
			void markNodeSeen(this.#db, node.id);
			await this.#serial(id, () => this.#finish(node.id, id, { ...fields, ...outputFields() }));
		} catch (err) {
			// Once the remote side started, the outcome is unknown; before that, nothing ran.
			if (isStarted) {
				await this.#serial(id, () => this.#markUnknown(id, "connection_lost"));
			} else {
				const code = err instanceof SshError ? err.code : "connect_failed";
				await this.#serial(id, () =>
					this.#finish(node.id, id, { state: "failed", error_code: code, error_message: (err as Error).message }),
				);
			}
		} finally {
			this.#sshCancels.delete(id);
			if (this.#live.get(id) === live) this.#dropLive(id);
		}
	}

	async #sshTask(
		session: SshSession,
		spec: TaskSpec,
		input: Uint8Array | undefined,
		timeoutMs: number | undefined,
		signal: AbortSignal,
		sink: SshExecSink,
	): Promise<Updateable<TasksTable>> {
		if (spec.kind === "exec") {
			const res = await runSshExec(session, spec, input, sink, { timeoutMs, signal });
			return {
				state: res.error ? "failed" : "exited",
				exit_code: res.exitCode ?? null,
				signal: res.signal ?? null,
				error_code: res.error?.code ?? null,
				error_message: res.error?.message ?? null,
				timed_out: res.timedOut ? 1 : 0,
				cancelled: res.cancelled ? 1 : 0,
			};
		}
		const sftp = await session.sftp();
		sink.started();
		try {
			await runSftpFileTask(sftp, spec, input, sink.stdout, signal);
			return { state: "exited", exit_code: 0 };
		} catch (err) {
			if (!(err instanceof FileTaskError) || session.closed) throw new SshConnectionLost("connection lost");
			return {
				state: "failed",
				error_code: err.code,
				error_message: err.message,
				cancelled: err.code === "cancelled" ? 1 : 0,
			};
		} finally {
			sftp.end();
		}
	}

	// ---- helpers ----

	#newLive(id: string, nodeId: string, mode: "full" | "text" | "status", groupId: string | null): Live {
		const budget = mode === "text" ? this.#budgetFor(budgetKey(groupId, id)) : undefined;
		const live: Live = { id, nodeId, groupId, output: createLiveTask(mode, budget) };
		this.#live.set(id, live);
		return live;
	}

	#budgetFor(key: string): GroupBudget {
		let budget = this.#budgets.get(key);
		if (!budget) {
			budget = new GroupBudget();
			this.#budgets.set(key, budget);
		}
		return budget;
	}

	/** Drops the live record. A group's budget outlives its tasks and goes with releaseGroupBudget. */
	#dropLive(id: string): void {
		const live = this.#live.get(id);
		if (!live) return;
		this.#live.delete(id);
		// A text task outside a group has no group end to release its budget.
		if (live.groupId === null) this.#budgets.delete(budgetKey(null, live.id));
	}

	#ownLive(nodeId: string, taskId: string): Live | undefined {
		const live = this.#live.get(taskId);
		return live?.nodeId === nodeId ? live : undefined;
	}

	async #row(id: string): Promise<Selectable<TasksTable> | undefined> {
		return this.#db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
	}

	async #markUnknown(id: string, reason: string): Promise<void> {
		const row = await this.#row(id);
		if (!row || TERMINAL.has(row.state)) return;
		const output = this.#live.get(id)?.output.snapshot() ?? EMPTY_OUTPUT;
		await this.#finish(row.node_id, id, {
			state: "unknown",
			error_code: reason,
			error_message: "execution status unknown",
			...outputColumns(output),
		});
	}

	async #finish(nodeId: string, id: string, fields: Updateable<TasksTable>): Promise<void> {
		const res = await this.#db
			.updateTable("tasks")
			.set({ ...fields, finished_at: now() })
			.where("id", "=", id)
			.where("node_id", "=", nodeId)
			.where("state", "in", ["dispatched", "running"])
			.executeTakeFirst();
		if (fields.state !== "unknown") this.#dropLive(id);
		this.#notify(id);
		if (res.numUpdatedRows === 0n) return;
		await this.#syncGroupOfTask(id);
		await this.#auditFinish(id);
	}

	/** Re-derives the state of the task's group after the task settled. */
	async #syncGroupOfTask(id: string): Promise<void> {
		const row = await this.#db.selectFrom("tasks").select("task_group_id").where("id", "=", id).executeTakeFirst();
		if (row?.task_group_id) await this.#syncGroupState(row.task_group_id);
	}

	/** task.finished: the outcome, as recorded (the system acts, on behalf of the task's user). */
	async #auditFinish(id: string): Promise<void> {
		if (!this.#audit) return;
		const row = await this.#row(id);
		if (!row) return;
		const outputHash = createHash("sha256")
			.update(`${row.stdout_head ?? ""}\n${row.stdout_tail ?? ""}\n${row.stderr_head ?? ""}\n${row.stderr_tail ?? ""}`)
			.digest("hex");
		void this.#audit.record({
			actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "task.finished",
			target: { type: "task", id },
			detail: {
				node_id: row.node_id,
				state: row.state,
				exit_code: row.exit_code,
				signal: row.signal,
				error_code: row.error_code,
				timed_out: row.timed_out === 1,
				cancelled: row.cancelled === 1,
				stdout_bytes: Number(row.stdout_bytes),
				stderr_bytes: Number(row.stderr_bytes),
				// Of the kept head and tail; crhs never has the full output.
				kept_output_sha256: outputHash,
				output_file: row.output_file,
			},
		});
	}

	async #auditApproval(row: Selectable<TasksTable>, d: ApprovalDecision): Promise<void> {
		void this.#audit?.record({
			actor: { type: d.by.type, id: d.by.id, onBehalfOfUserId: d.by.onBehalfOfUserId ?? row.on_behalf_of_user_id },
			action: "task.approval",
			target: { type: "task", id: row.id },
			detail: { decision: d.decision, reason: d.reason },
		});
	}

	#notify(id: string): void {
		for (const w of this.#waiters.get(id) ?? []) w();
		this.#waiters.delete(id);
	}

	#serial(taskId: string, fn: () => Promise<void>): Promise<void> {
		return this.#serialResult(taskId, fn);
	}

	#serialResult<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
		const next = (this.#queues.get(taskId) ?? Promise.resolve()).then(fn);
		const tail: Promise<void> = next.then(
			() => {},
			() => {},
		);
		this.#queues.set(taskId, tail);
		void tail.then(() => {
			if (this.#queues.get(taskId) === tail) this.#queues.delete(taskId);
		});
		return next;
	}
}

/** Returns a copy with the input ref filled in from the bytes actually sent (doc/protocol.md#json-形式服务端存储). */
function withInputRef(spec: TaskSpec, ref: { size: number; sha256: Uint8Array } | undefined): TaskSpec {
	const inputRef: InputRef | undefined = ref ? { size: ref.size, sha256: ref.sha256 } : undefined;
	switch (spec.kind) {
		case "exec":
			return { ...spec, stdin: inputRef ?? null };
		case "file.write":
			return { ...spec, content: inputRef ?? EMPTY_INPUT_REF };
		default:
			if (inputRef) throw new Error(`${spec.kind} takes no input`);
			return spec;
	}
}

function toView(row: Selectable<TasksTable>, live: Live | undefined): TaskView {
	const b64 = (s: string | null) => (s ? Buffer.from(s, "base64").toString("utf8") : "");
	const fromLive = live && !TERMINAL.has(row.state);
	const text = (b: Buffer | null) => (b ? b.toString("utf8") : "");
	const output = fromLive ? live.output.snapshot() : undefined;
	return {
		id: row.id,
		nodeId: row.node_id,
		kind: row.kind,
		summary: summarize(row.spec),
		operation: operationOfJson(row.spec),
		actorType: row.actor_type,
		actorId: row.actor_id,
		onBehalfOfUserId: row.on_behalf_of_user_id,
		state: row.state,
		exitCode: row.exit_code,
		signal: row.signal,
		timedOut: row.timed_out === 1,
		cancelled: row.cancelled === 1,
		errorCode: row.error_code,
		errorMessage: row.error_message,
		stdoutBytes: output ? output.stdoutBytes : Number(row.stdout_bytes),
		stderrBytes: output ? output.stderrBytes : Number(row.stderr_bytes),
		stdoutHead: output ? text(output.stdoutHead) : b64(row.stdout_head),
		// Text mode puts the combined tail here; its other head/tail fields are empty.
		stdoutTail: output ? text(output.stdoutTail) : b64(row.stdout_tail),
		stderrHead: output ? text(output.stderrHead) : b64(row.stderr_head),
		stderrTail: output ? text(output.stderrTail) : b64(row.stderr_tail),
		outputFile: row.output_file,
		outputMode: row.output_mode,
		privileged: row.privileged === 1,
		authorization: parseTaskAuthorization(row.authorization),
		createdAt: row.created_at,
		finishedAt: row.finished_at,
		taskGroupId: row.task_group_id,
		ruleChain: row.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null,
		approval: row.approval ? (JSON.parse(row.approval) as ApprovalRecord) : null,
		rootSessionId: row.root_session_id,
		handlerType: row.handler_type,
		handlerSessionId: row.handler_session_id,
	};
}

/** The DB columns of an output snapshot; null fields mean the mode keeps no head/tail there. */
function outputColumns(out: OutputSnapshot) {
	return {
		stdout_bytes: out.stdoutBytes,
		stderr_bytes: out.stderrBytes,
		stdout_head: out.stdoutHead?.toString("base64") ?? null,
		stdout_tail: out.stdoutTail?.toString("base64") ?? null,
		stderr_head: out.stderrHead?.toString("base64") ?? null,
		stderr_tail: out.stderrTail?.toString("base64") ?? null,
	};
}

/** A group's budget is shared by its tasks; a single text task (not produced by the code) gets its own. */
function budgetKey(groupId: string | null, taskId: string): string {
	return groupId ? groupBudgetKey(groupId) : `task:${taskId}`;
}

function groupBudgetKey(groupId: string): string {
	return `group:${groupId}`;
}

/** The wire output mode of a task row (doc/protocol.md#taskstart). */
function outputModeOf(mode: "full" | "text" | "status"): TaskStart["output"] {
	return mode === "full"
		? { kind: "full", spillBytes: OUTPUT_KEEP_BYTES, spillLines: OUTPUT_KEEP_LINES }
		: { kind: mode };
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function operationOfJson(specJson: string): { method: string; target: string } | null {
	try {
		return operationOf(taskSpecFromJson(JSON.parse(specJson)));
	} catch {
		return null;
	}
}

/** A stored spec; migration 0019 may have left one unreadable, which is a client error on approval. */
export function specFromRow(specJson: string | null, what: string): TaskSpec {
	try {
		return taskSpecFromJson(JSON.parse(specJson ?? "null"));
	} catch (err) {
		throw new UserError(
			`the ${what}'s stored spec cannot be read: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function auditActor(actor: Actor) {
	return { type: actor.type, id: actor.id, onBehalfOfUserId: actor.onBehalfOfUserId };
}

/** Spec JSON (doc/protocol.md#json-形式服务端存储) to a short description. */
export function summarize(specJson: string): string {
	try {
		const spec = JSON.parse(specJson) as {
			kind?: unknown;
			command?: { argv?: unknown; shell?: unknown };
			path?: unknown;
		};
		if (spec.kind === "exec") {
			const command = spec.command ?? {};
			if (Array.isArray(command.argv)) return command.argv.map((arg) => shellQuote(String(arg))).join(" ");
			if (typeof command.shell === "string") return command.shell;
			return "";
		}
		if (typeof spec.path === "string") return spec.path;
	} catch {}
	return "";
}

function now(): string {
	return new Date().toISOString();
}
