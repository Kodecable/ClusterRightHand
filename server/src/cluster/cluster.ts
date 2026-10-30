import { createHash } from "node:crypto";
import {
	type AfterResponse,
	type Authorization,
	type AuthorizationPayload,
	afterResponse,
	authorizationCodec,
	ConnectionError,
	decodeAuthorizationPayload,
	encode as encodeCbor,
	type Facts,
	factsToJson,
	type Hello,
	type InputRef,
	type LocalDecision,
	type LocalRequest,
	type LocalState,
	type LocalWithdraw,
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
	type TrustSummary,
	taskSpecFromJson,
	taskSpecToJson,
	type Welcome,
} from "@crh/protocol";
import type { Selectable, Updateable } from "kysely";
import type { Audit, AuditActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { type Evaluation, evaluate, operationOf } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import { type AuthzDecision, type AuthzSignature, authzEntryFromTrust, decide, STEP } from "../privilege/authz.ts";
import { ownerCredentials } from "../privilege/credentials.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { BuiltAuthorization } from "../privilege/payload.ts";
import {
	type AuthorizationPath,
	buildTaskGroupAuthorization,
	type PlannedLocalPath,
	type PlannedUserPath,
	planAuthorization,
	USER_AUTHORIZATION_TTL_MS,
} from "../privilege/planner.ts";
import {
	assertSubmittingUser,
	encodeAuthorization,
	entryBelongsToUser,
	loadUserSigningMaterial,
	type SubmittedAuthorization,
	signaturesFromJson,
	signaturesToJson,
	type UserSigningMaterial,
	verifyAgainstTrust,
} from "../privilege/submission.ts";
import type { Db } from "../storage/db.ts";
import type { TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import { defaultOrgId, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import {
	authorizationView,
	type PendingPayloadView,
	parseTaskAuthorization,
	planView,
	serializeTaskAuthorization,
	signatureToJson,
	type TaskAuthorizationRecord,
} from "./authorization.ts";
import { createLiveTask, GroupBudget, type LiveTask, type OutputSnapshot } from "./batch-output.ts";
import type { NodeConnection } from "./connection.ts";
import { getNode, markNodeSeen, type NodeRow, nodeGroupNames, setSshNodeFacts, updateNodeFacts } from "./nodes.ts";
import { OUTPUT_KEEP_BYTES, OUTPUT_KEEP_LINES } from "./output.ts";
import { batchRevocations, listRevocations, revokeAuthorizationRow } from "./revocations.ts";
import { connect as connectSsh, SshError, type SshRoute, type SshSession } from "./ssh/connection.ts";
import {
	probeShells,
	runSshExec,
	SshConnectionLost,
	type SshExecSink,
	type SshShells,
	shellQuote,
	sshPrivilegedNotice,
} from "./ssh/exec.ts";
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
	/** Warn when a node's clock differs by more than this; 0 disables (doc/privilege.md#时钟). */
	clockWarnMs?: number;
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

/** One pooled SSH connection and the shell its probe found (doc/execution-plane.md#执行). */
interface SshConnection {
	session: SshSession;
	sh: string;
}

/** A task claimed for an owner authorization and ready to be sent. */
interface ClaimedAuthorization {
	start: TaskStart;
	record: TaskAuthorizationRecord;
	input: Uint8Array;
	cosigned: boolean;
}

/** A waiting task of a submission, judged against its node's trust summary before anything is claimed. */
interface JudgedSubmission {
	row: Selectable<TasksTable>;
	node: NodeRow;
	link: NodeLink;
	/** The user's signatures plus the cosignature this node needed (when one was needed). */
	signatures: Signature[];
	cosigned: boolean;
}

/** A waiting task of a submission that was judged and claimed; sending happens after all of them. */
interface PreparedSubmission {
	link: NodeLink;
	nodeId: string;
	claim: ClaimedAuthorization;
	/** Every signature the Authorization carries (the union of the group's cosignatures included). */
	signatures: Signature[];
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
	readonly #clockWarnMs: number;
	/** Called once for every task that starts waiting for approval (Auto Review hooks in here). */
	onAwaitingApproval: ((task: TaskView) => Promise<void>) | undefined;
	/** Called after a task starts waiting or its approval state/handler changes (the runtime refreshes its inbox). */
	onChange: ((actorId: string) => void) | undefined;
	readonly #sshSessions = new Map<string, Promise<SshConnection>>();
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
	/** Serializes the shared payload of a task group's waiting tasks. */
	readonly #groupQueues = new Map<string, Promise<void>>();

	constructor(db: Db, options: ClusterOptions = {}) {
		this.#db = db;
		this.#graceMs = options.reconnectGraceMs ?? 120_000;
		this.#chunk = options.inputChunkBytes ?? 48 * 1024;
		this.#idleMs = options.idleTimeoutMs ?? 90_000;
		this.#sshRoute = options.sshRoute;
		this.#audit = options.audit;
		this.#authorizationKey = options.authorizationKey;
		this.#trustWaitMs = options.trustWaitMs ?? 5_000;
		this.#clockWarnMs = options.clockWarnMs ?? 60_000;
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
				(x) => x.session.close(),
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
		peer.onEvent("local.decision", (decision) => this.#onLocalDecision(link, decision));
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
		// A clock far from crhs only makes authorization deadlines unreliable; warn, do nothing else
		// (doc/privilege.md#时钟). The offset is an optional fact: an absent one says nothing.
		const offset = facts.clockOffsetMs;
		if (this.#clockWarnMs > 0 && offset !== undefined && Math.abs(offset) > this.#clockWarnMs) {
			const ms = Math.abs(offset);
			const seconds = ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
			console.warn(`node ${nodeId}: clock differs from crhs by ${seconds} s (more than ${this.#clockWarnMs / 1000} s)`);
		}
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
			// A privileged mode that restarted lost its in-memory approval requests (doc/protocol.md#taskstart).
			await this.#resendLocalRequests(link);
			// A signature the owner submitted while the node was away is used now.
			await this.#useStoredAuthorizations(nodeId);
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

	/**
	 * Dispatches a waiting task with an authorization the owner already stored (submitted while the node
	 * was offline, or a reusable one): the same reuse lookup the planner does, without re-planning the
	 * payload, so a signature survives a reconnect.
	 */
	async #useStoredAuthorizations(nodeId: string): Promise<void> {
		const rows = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			.where("state", "=", "awaiting_authorization")
			.execute();
		for (const { id } of rows) await this.#serial(id, () => this.#dispatchStored(id));
	}

	async #dispatchStored(id: string): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_authorization") return;
		const node = await getNode(this.#db, row.node_id);
		const link = this.#links.get(row.node_id);
		if (!node || !link || link.conn.closed || !link.ready || !link.trustFresh) return;
		const report = parseTrustReport(node.trust_report);
		if (report?.kind !== "ok") return;
		const previous = parseTaskAuthorization(row.authorization);
		const skip = new Set<string>();
		if (previous?.lastRejection && previous.payloadId) skip.add(previous.payloadId);
		const reusable = await this.#findReusableAuthorization(
			row,
			node,
			report.summary,
			specFromRow(row.spec, "task"),
			skip,
		);
		if (!reusable) return;
		await this.#dispatchOwnerAuthorization(row, node, link, reusable.submitted, reusable.cosigned);
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
	 * Computes the authorization plan of a privileged task and acts on it, in this order
	 * (doc/privilege.md#授权路径): an authorization the owner already stored that covers the task,
	 * crhs's own signature, the owner's signature or a local approval. With no usable path the task
	 * ends rejected and says why.
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
		const summary = report.summary;
		const previous = parseTaskAuthorization(row.authorization);
		const tried = previous ? [...previous.tried] : [];
		// Without a signing key crhs cannot take its own path; treating it as tried keeps the plan honest.
		if (!this.#authorizationKey && !tried.includes("crhs")) tried.push("crhs");
		const plan = planAuthorization({
			summary,
			nodeId: node.id,
			nodeGroups: summary.groups,
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
			pending: previous?.pending ?? null,
			local: previous?.local ?? null,
			lastRejection: previous?.lastRejection ?? null,
			updatedAt: new Date().toISOString(),
		};
		const crhsPath = plan.paths.find((path) => path.path === "crhs");
		if (crhsPath?.path === "crhs") {
			await this.#dispatchCrhs(id, row, node, link, spec, inputBytes, opts, record, crhsPath.authorization, from);
			return;
		}
		// The owner may already have signed a reusable authorization that covers this command
		// (doc/privilege.md#授权路径 step 3): use it instead of asking for a signature again. A payload
		// crha already rejected is not retried automatically, or the retry would loop.
		const skip = new Set<string>();
		if (previous?.lastRejection && previous.payloadId) skip.add(previous.payloadId);
		const reusable = await this.#findReusableAuthorization(row, node, summary, spec, skip);
		if (reusable) {
			const dispatched = await this.#dispatchOwnerAuthorization(
				row,
				node,
				link,
				reusable.submitted,
				reusable.cosigned,
				from,
			);
			if (dispatched) return;
		}
		const userPath = plan.paths.find((path): path is PlannedUserPath => path.path === "user");
		const localPath = plan.paths.find((path): path is PlannedLocalPath => path.path === "local");
		if (!userPath && !(localPath && row.task_group_id === null)) {
			const code = record.lastRejection?.code ?? "authorization_required";
			const reason = plan.reason ?? "no one on this node can authorize this command";
			const message = record.lastRejection === null ? reason : `${record.lastRejection.message}; ${reason}`;
			await this.#finishAuthorization(id, row, "rejected", code, message, { ...record, pending: null, local: null });
			return;
		}
		await this.#parkForAuthorization(id, row, link, spec, inputBytes, record, userPath, localPath, from);
	}

	/**
	 * Parks the task in `awaiting_authorization`: for a single task it records the exact payload the
	 * owner must sign and, when the node offers local approval, requests that too. A task group's
	 * shared payload is built across all of the group's waiting tasks (#refreshGroupPending).
	 */
	async #parkForAuthorization(
		id: string,
		row: Selectable<TasksTable>,
		link: NodeLink,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		record: TaskAuthorizationRecord,
		userPath: PlannedUserPath | undefined,
		localPath: PlannedLocalPath | undefined,
		from: readonly TaskRowState[],
	): Promise<void> {
		const single = row.task_group_id === null;
		const pending = single && userPath ? pendingOf(userPath.authorization) : null;
		const local = single && localPath ? { attempt: row.attempt } : null;
		// The last task.start was rejected (or none was sent): nothing is in flight while the task waits.
		const updated: TaskAuthorizationRecord = {
			...record,
			pending,
			local,
			dispatchedPath: null,
			updatedAt: new Date().toISOString(),
		};
		const parked = await this.#updateTask(id, from, {
			state: "awaiting_authorization",
			authorization: serializeTaskAuthorization(updated),
			pending_input: inputBytes.length > 0 ? Buffer.from(inputBytes).toString("base64") : null,
			dispatched_at: null,
			handler_type: "user",
			handler_session_id: null,
		});
		if (!parked) return;
		void this.#syncGroupState(row.task_group_id);
		this.onChange?.(row.actor_id);
		if (row.task_group_id !== null) {
			// Every waiting task of the group signs one payload covering all of them (D88).
			await this.#refreshGroupPending(row.task_group_id);
			return;
		}
		if (localPath) await this.#sendLocalRequest(id, link, spec, updated);
	}

	// ---- local approval (doc/privilege.md#本地批准) ----

	/** Sends `local.request` and follows the answer: pending, approved (dispatch) or denied (reject). */
	async #sendLocalRequest(id: string, link: NodeLink, spec: TaskSpec, record: TaskAuthorizationRecord): Promise<void> {
		const attempt = record.attempt;
		let state: LocalState;
		try {
			const request: LocalRequest = { taskId: id, attempt, spec, note: LOCAL_REQUEST_NOTE };
			state = (await link.conn.peer.request("local.request", request)) as LocalState;
		} catch (err) {
			if (err instanceof RemoteError && err.code === "local_not_trusted") {
				// The node has no local trust entry after all: drop that path and plan again.
				await this.#dropLocalPath(id);
				return;
			}
			if (!(err instanceof ConnectionError)) console.error(`local.request for ${id} failed:`, err);
			// Otherwise the request is sent again after the node's next `ok` trust report.
			return;
		}
		await this.#onLocalState(id, attempt, state);
	}

	/** `local.decision`: the node's local approval or denial, for the attempt it was requested for. */
	async #onLocalDecision(link: NodeLink, decision: LocalDecision): Promise<void> {
		await this.#serial(decision.taskId, async () => {
			const row = await this.#row(decision.taskId);
			if (!row || row.node_id !== link.conn.nodeId || row.state !== "awaiting_authorization") return;
			const record = parseTaskAuthorization(row.authorization);
			if (record?.attempt !== decision.attempt) return;
			await this.#onLocalState(decision.taskId, decision.attempt, decision.state);
		});
	}

	async #onLocalState(id: string, attempt: number, state: LocalState): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_authorization" || row.attempt !== attempt) return;
		if (state.kind === "pending") return;
		const record = parseTaskAuthorization(row.authorization);
		if (state.kind === "denied") {
			const updated = record ? { ...record, pending: null, local: null, updatedAt: new Date().toISOString() } : null;
			await this.#finishAuthorization(id, row, "rejected", "authorization_rejected", state.message, updated);
			return;
		}
		// Approved: task.start with the approval instead of an authorization (doc/protocol.md#taskstart).
		const node = await getNode(this.#db, row.node_id);
		const link = this.#links.get(row.node_id);
		if (!node || !link || link.conn.closed || !link.ready || !record) return;
		const spec = specFromRow(row.spec, "task");
		const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
		const updated: TaskAuthorizationRecord = {
			...record,
			pending: null,
			local: null,
			dispatchedPath: "local",
			attempt,
			updatedAt: new Date().toISOString(),
		};
		const claimed = await this.#updateTask(id, ["awaiting_authorization"], {
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
			attempt,
			spec,
			privileged: true,
			authorizations: [],
			timeoutMs: row.timeout_ms ?? 0,
			killGraceMs: 0,
			output: outputModeOf(row.output_mode),
		};
		await this.#sendAuthorizedStart(link, node.id, id, spec, input, start, updated);
	}

	/** Drops the local path after the node refused it, then plans again without it. */
	async #dropLocalPath(id: string): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_authorization") return;
		const record = parseTaskAuthorization(row.authorization);
		if (!record) return;
		const updated: TaskAuthorizationRecord = {
			...record,
			local: null,
			tried: [...new Set<AuthorizationPath>([...record.tried, "local"])],
			updatedAt: new Date().toISOString(),
		};
		const res = await this.#db
			.updateTable("tasks")
			.set({ authorization: serializeTaskAuthorization(updated) })
			.where("id", "=", id)
			.where("state", "=", "awaiting_authorization")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		const node = await getNode(this.#db, row.node_id);
		const link = this.#links.get(row.node_id);
		if (!node || !link || link.conn.closed || !link.ready) return;
		const spec = specFromRow(row.spec, "task");
		const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
		await this.#planPrivileged(id, node, link, spec, input, { timeoutMs: row.timeout_ms ?? undefined }, [
			"awaiting_authorization",
		]);
	}

	/** Sends local.request again for the node's tasks whose approval request the privileged mode lost. */
	async #resendLocalRequests(link: NodeLink): Promise<void> {
		const rows = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", link.conn.nodeId)
			.where("state", "=", "awaiting_authorization")
			.execute();
		for (const { id } of rows) await this.#serial(id, () => this.#resendLocalRequest(id, link));
	}

	async #resendLocalRequest(id: string, link: NodeLink): Promise<void> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_authorization" || link.conn.closed || !link.ready) return;
		const record = parseTaskAuthorization(row.authorization);
		if (!record || record.local === null) return;
		await this.#sendLocalRequest(id, link, specFromRow(row.spec, "task"), record);
	}

	/** Withdraws a pending local request (the owner signed, the task was cancelled or re-planned). */
	#withdrawLocal(link: NodeLink | undefined, taskId: string, record: TaskAuthorizationRecord | null): void {
		if (!record?.local || !link || link.conn.closed) return;
		const withdraw: LocalWithdraw = { taskId, attempt: record.local.attempt };
		void link.conn.peer.request("local.withdraw", withdraw).catch((err: unknown) => {
			if (!(err instanceof ConnectionError)) console.error(`local.withdraw for ${taskId} failed:`, err);
		});
	}

	// ---- task groups: one payload for every waiting task (D88) ----

	/** Rebuilds the shared payload of a group's waiting tasks from their plans, one signature for all. */
	async #refreshGroupPending(groupId: string): Promise<void> {
		await this.#queueGroup(groupId, async () => {
			const group = await this.#db.selectFrom("task_groups").selectAll().where("id", "=", groupId).executeTakeFirst();
			if (!group) return;
			const rows = await this.#db
				.selectFrom("tasks")
				.selectAll()
				.where("task_group_id", "=", groupId)
				.orderBy("created_at")
				.execute();
			const entries = rows
				.filter((row) => row.state === "awaiting_authorization")
				.map((row) => ({ row, record: parseTaskAuthorization(row.authorization) }));
			const withUser = entries.filter((entry) => entry.record?.plan.paths.some((path) => path.path === "user"));
			if (withUser.length === 0) {
				for (const entry of entries) await this.#clearGroupPending(entry.row, entry.record);
				return;
			}
			// The protocol ties a task.start to the payload's attempt, so all covered tasks move to the
			// highest attempt (doc/protocol.md#授权对象, D88).
			const attempt = Math.max(...withUser.map((entry) => entry.row.attempt));
			const ttlMs = Math.min(...withUser.map((entry) => userPathTtl(entry.record)));
			let spec: TaskSpec;
			try {
				spec = specFromRow(group.spec ?? withUser[0]?.row.spec ?? null, "task group");
			} catch (err) {
				console.warn(`task group ${groupId}: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			const authorization = buildTaskGroupAuthorization({
				nodeIds: withUser.map((entry) => entry.row.node_id),
				taskIds: withUser.map((entry) => entry.row.id),
				attempt,
				spec,
				ttlMs,
			});
			const pending = pendingOf(authorization);
			const covered = new Set(withUser.map((entry) => entry.row.id));
			for (const row of rows) {
				if (row.state !== "awaiting_authorization") continue;
				const record = parseTaskAuthorization(row.authorization);
				if (!covered.has(row.id)) {
					await this.#clearGroupPending(row, record);
					continue;
				}
				if (!record) continue;
				const updated: TaskAuthorizationRecord = {
					...record,
					attempt,
					pending,
					updatedAt: new Date().toISOString(),
				};
				const set: Updateable<TasksTable> = { authorization: serializeTaskAuthorization(updated) };
				if (row.attempt !== attempt) set.attempt = attempt;
				const res = await this.#db
					.updateTable("tasks")
					.set(set)
					.where("id", "=", row.id)
					.where("state", "=", "awaiting_authorization")
					.executeTakeFirst();
				if (res.numUpdatedRows === 0n) continue;
				if (row.attempt !== attempt) this.#notify(row.id);
			}
		});
	}

	async #clearGroupPending(row: Selectable<TasksTable>, record: TaskAuthorizationRecord | null): Promise<void> {
		if (!record?.pending) return;
		const updated: TaskAuthorizationRecord = { ...record, pending: null, updatedAt: new Date().toISOString() };
		await this.#db
			.updateTable("tasks")
			.set({ authorization: serializeTaskAuthorization(updated) })
			.where("id", "=", row.id)
			.where("state", "=", "awaiting_authorization")
			.execute();
	}

	/** Serializes the shared payload rebuild of one group. */
	#queueGroup<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
		const next = (this.#groupQueues.get(groupId) ?? Promise.resolve()).then(fn);
		const tail: Promise<void> = next.then(
			() => {},
			() => {},
		);
		this.#groupQueues.set(groupId, tail);
		void tail.then(() => {
			if (this.#groupQueues.get(groupId) === tail) this.#groupQueues.delete(groupId);
		});
		return next;
	}

	// ---- the owner's stored and submitted authorizations ----

	/**
	 * Finds a stored authorization of the task's owner that covers it and that the node's trust
	 * summary would accept (doc/privilege.md#授权路径). Reusable ones (no task ids) and one-shot ones
	 * for this task with the same attempt qualify; a cosignature is added when the accepting entry
	 * needs one and the payload is one-shot.
	 */
	async #findReusableAuthorization(
		row: Selectable<TasksTable>,
		node: NodeRow,
		summary: TrustSummary,
		spec: TaskSpec,
		skip: ReadonlySet<string>,
	): Promise<{ submitted: SubmittedAuthorization; cosigned: boolean } | null> {
		const ownerId = row.on_behalf_of_user_id;
		const stored = await this.#db
			.selectFrom("authorizations")
			.selectAll()
			.where("issuer_user_id", "=", ownerId)
			.where("org_id", "=", node.org_id)
			.where("revoked_at", "is", null)
			.orderBy("created_at")
			.execute();
		if (stored.length === 0) return null;
		const material = await loadUserSigningMaterial(this.#db, ownerId);
		for (const candidate of stored) {
			if (skip.has(candidate.id)) continue;
			const payloadBytes = Uint8Array.from(Buffer.from(candidate.payload, "base64"));
			let payload: AuthorizationPayload;
			try {
				payload = decodeAuthorizationPayload(payloadBytes);
			} catch {
				continue; // a damaged row is never usable (fail closed)
			}
			if (payload.taskIds !== null) {
				if (!payload.taskIds.includes(row.id)) continue;
				if (payload.attempt !== row.attempt) continue;
			}
			const signatures = signaturesFromJson(candidate.signatures);
			if (signatures.length === 0) continue;
			const judged = await this.#judgeOwnerAuthorization({
				payload,
				payloadBytes,
				signatures,
				summary,
				nodeId: node.id,
				task: { id: row.id, attempt: row.attempt, spec },
				material,
			});
			if (!judged.accepted) continue;
			return {
				submitted: { payload, payloadBytes, signatures: judged.signatures, id: candidate.id },
				cosigned: judged.cosigned,
			};
		}
		return null;
	}

	/**
	 * Judges one owner authorization for one task with the real decision port: which trust entry
	 * verifies which signature, whether the node would accept it, and whether a crhs cosignature has
	 * to be appended first (doc/privilege.md#联署).
	 */
	async #judgeOwnerAuthorization(input: {
		payload: AuthorizationPayload;
		payloadBytes: Uint8Array;
		signatures: Signature[];
		summary: TrustSummary;
		nodeId: string;
		task: { id: string; attempt: number; spec: TaskSpec };
		material: UserSigningMaterial;
	}): Promise<{
		accepted: boolean;
		signatures: Signature[];
		entry: string | null;
		cosigned: boolean;
		reason: string;
	}> {
		const trust = input.summary.trust;
		let signatures = [...input.signatures];
		const judge = (candidates: readonly AuthzSignature[]) =>
			decideOwnerAuthorization({
				now: Date.now(),
				summary: input.summary,
				nodeId: input.nodeId,
				task: input.task,
				payload: input.payload,
				payloadBytes: input.payloadBytes,
				signatures: candidates,
			});
		let authz = await verifyAgainstTrust(signatures, input.payloadBytes, trust);
		let decision = judge(authz);
		let cosigned = false;
		if (decision.result !== "accepted" && decision.step === STEP.cosign && input.payload.taskIds !== null) {
			const cosign = this.#cosignature(input.payloadBytes, input.summary);
			if (cosign) {
				signatures = [...signatures, cosign];
				authz = await verifyAgainstTrust(signatures, input.payloadBytes, trust);
				const again = judge(authz);
				if (again.result === "accepted") {
					decision = again;
					cosigned = true;
				}
			}
		}
		if (decision.result !== "accepted") {
			return {
				accepted: false,
				signatures,
				entry: null,
				cosigned,
				reason: decision.step === null ? decision.message : `step ${decision.step}: ${decision.message}`,
			};
		}
		if (!entryBelongsToUser(decision.entry, trust, input.material)) {
			return {
				accepted: false,
				signatures,
				entry: decision.entry,
				cosigned,
				reason: "the accepting trust entry does not belong to the owner's credentials",
			};
		}
		return { accepted: true, signatures, entry: decision.entry, cosigned, reason: "" };
	}

	/** crhs's cosignature for a payload, when the node trusts its signing key with the cosign kind. */
	#cosignature(payloadBytes: Uint8Array, summary: TrustSummary): Signature | null {
		const key = this.#authorizationKey;
		if (!key) return null;
		const entry = summary.trust.find(
			(trustee) =>
				trustee.role === "crhs" &&
				trustee.kinds.includes("cosign") &&
				trustee.key.kind === "sshsig" &&
				trustee.key.fingerprint === key.fingerprint,
		);
		if (!entry) return null;
		return { kind: "sshsig", blob: key.sign(payloadBytes) };
	}

	/**
	 * Claims a task for an owner authorization: the attempt is fixed, the pending payload is cleared
	 * and the local approval request withdrawn. Sending is separate, so a whole task group can be
	 * claimed before the first task.start is sent and a rejection cannot change a sibling's attempt.
	 */
	async #claimOwnerAuthorization(
		row: Selectable<TasksTable>,
		node: NodeRow,
		link: NodeLink,
		submitted: SubmittedAuthorization,
		cosigned: boolean,
		from: readonly TaskRowState[] = ["awaiting_authorization"],
	): Promise<ClaimedAuthorization | null> {
		if (!from.includes(row.state)) return null;
		const oneShot = submitted.payload.taskIds !== null;
		const attempt = oneShot ? (submitted.payload.attempt as number) : row.attempt;
		if (oneShot && attempt !== row.attempt) return null;
		let encoded: Uint8Array;
		try {
			encoded = encodeAuthorization(submitted.payloadBytes, submitted.signatures);
		} catch (err) {
			console.error(`authorization ${submitted.id} cannot be encoded:`, err);
			return null;
		}
		if (encoded.length > MAX_FRAME_BYTES / 2) return null;
		const record = parseTaskAuthorization(row.authorization);
		const updated: TaskAuthorizationRecord = {
			plan: record?.plan ?? { paths: [] },
			tried: record?.tried ?? [],
			dispatchedPath: "user",
			payloadId: submitted.id,
			attempt,
			trustDigest: record?.trustDigest ?? null,
			pending: null,
			local: null,
			lastRejection: record?.lastRejection ?? null,
			updatedAt: new Date().toISOString(),
		};
		this.#withdrawLocal(link, row.id, record);
		const claimed = await this.#updateTask(row.id, from, {
			state: "dispatched",
			attempt,
			dispatched_at: now(),
			authorization: serializeTaskAuthorization(updated),
			pending_input: null,
			handler_type: null,
			handler_session_id: null,
		});
		if (!claimed) return null;
		this.#newLive(row.id, node.id, row.output_mode, row.task_group_id);
		void this.#syncGroupState(row.task_group_id);
		if (cosigned) {
			void this.#audit?.record({
				actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
				action: "authorization.cosigned",
				target: { type: "authorization", id: submitted.id },
				detail: { node_id: node.id, task_id: row.id, attempt },
			});
		}
		const spec = specFromRow(row.spec, "task");
		const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
		const start: TaskStart = {
			taskId: row.id,
			attempt,
			spec,
			privileged: true,
			authorizations: [encoded],
			timeoutMs: row.timeout_ms ?? 0,
			killGraceMs: 0,
			output: outputModeOf(row.output_mode),
		};
		return { start, record: updated, input, cosigned };
	}

	/** Sends the task.start of a claimed authorization and follows the response. */
	async #sendClaimed(
		link: NodeLink,
		nodeId: string,
		prepared: {
			start: TaskStart;
			record: TaskAuthorizationRecord;
			input: Uint8Array;
		},
	): Promise<void> {
		await this.#sendAuthorizedStart(
			link,
			nodeId,
			prepared.start.taskId,
			prepared.start.spec,
			prepared.input,
			prepared.start,
			prepared.record,
		);
	}

	/** Claims and sends one owner authorization (the reuse path of a single task). */
	async #dispatchOwnerAuthorization(
		row: Selectable<TasksTable>,
		node: NodeRow,
		link: NodeLink,
		submitted: SubmittedAuthorization,
		cosigned: boolean,
		from: readonly TaskRowState[] = ["awaiting_authorization"],
	): Promise<boolean> {
		const prepared = await this.#claimOwnerAuthorization(row, node, link, submitted, cosigned, from);
		if (!prepared) return false;
		await this.#sendClaimed(link, node.id, prepared);
		return true;
	}

	/**
	 * POST /api/authorizations: checks a user's authorization, stores it (for display, revocation and
	 * reuse) and dispatches every waiting task of that user it covers (doc/m4.md M4.4).
	 */
	async submitAuthorization(
		user: SessionUser,
		submitted: SubmittedAuthorization,
	): Promise<{ id: string; dispatched: string[] }> {
		const material = await loadUserSigningMaterial(this.#db, user.userId);
		await assertSubmittingUser(material, submitted.payloadBytes, submitted.signatures);
		const now = Date.now();
		const { deadlineMs } = submitted.payload;
		if (deadlineMs !== null && deadlineMs < now) {
			throw new UserError(`the authorization expired at ${new Date(deadlineMs).toISOString()}`);
		}
		if (submitted.payload.issuedAtMs > now + SUBMISSION_CLOCK_SKEW_MS) {
			throw new UserError("the authorization was issued in the future");
		}
		const stored = await this.#insertOwnerAuthorization(user, submitted);
		void this.#audit?.record({
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
			action: "authorization.submitted",
			target: { type: "authorization", id: submitted.id },
			detail: {
				nodes: submitted.payload.nodes,
				command: commandForAudit(submitted.payload.command),
				task_ids: submitted.payload.taskIds,
				attempt: submitted.payload.attempt,
				deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
				duplicate: !stored,
			},
		});
		// A revoked authorization is stored but never used (revocation only ever takes permissions away).
		if (await this.#isRevoked(submitted.id)) return { id: submitted.id, dispatched: [] };
		const rows = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("state", "=", "awaiting_authorization")
			.where("on_behalf_of_user_id", "=", user.userId)
			.orderBy("created_at")
			.execute();
		// Judge every covered task first, then claim all of them, then send: a rejection of one
		// task.start must not re-plan (and change the attempt of) a sibling still about to be sent.
		const judged: JudgedSubmission[] = [];
		for (const { id } of rows) {
			const entry = await this.#serialResult(id, () => this.#judgeSubmitted(id, submitted, material));
			if (entry) judged.push(entry);
		}
		// The Authorization is one object for the whole group (D88), so it carries the union of the
		// cosignatures the covered nodes need; a node ignores a signature of a key it does not trust.
		const keys = new Set(submitted.signatures.map(signatureKey));
		const cosignatures: Signature[] = [];
		for (const entry of judged) {
			for (const signature of entry.signatures) {
				const key = signatureKey(signature);
				if (keys.has(key)) continue;
				keys.add(key);
				cosignatures.push(signature);
			}
		}
		const signatures = [...submitted.signatures, ...cosignatures];
		const prepared: PreparedSubmission[] = [];
		for (const entry of judged) {
			const claim = await this.#serialResult(entry.row.id, () =>
				this.#claimOwnerAuthorization(entry.row, entry.node, entry.link, { ...submitted, signatures }, entry.cosigned),
			);
			if (!claim) continue;
			prepared.push({ link: entry.link, nodeId: entry.node.id, claim, signatures });
		}
		const dispatched: string[] = [];
		for (const entry of prepared) {
			await this.#sendClaimed(entry.link, entry.nodeId, entry.claim);
			dispatched.push(entry.claim.start.taskId);
		}
		if (cosignatures.length > 0) await this.#storeCosignatures(submitted, cosignatures);
		return { id: submitted.id, dispatched };
	}

	/** One waiting task of the submitting user, judged against its node's fresh trust summary. */
	async #judgeSubmitted(
		id: string,
		submitted: SubmittedAuthorization,
		material: UserSigningMaterial,
	): Promise<JudgedSubmission | null> {
		const row = await this.#row(id);
		if (row?.state !== "awaiting_authorization") return null;
		const payload = submitted.payload;
		if (payload.taskIds !== null) {
			if (!payload.taskIds.includes(id) || payload.attempt !== row.attempt) return null;
		}
		const node = await getNode(this.#db, row.node_id);
		const link = this.#links.get(row.node_id);
		if (!node || !link || link.conn.closed || !link.ready || !link.trustFresh) return null;
		const report = parseTrustReport(node.trust_report);
		if (report?.kind !== "ok") return null;
		const judged = await this.#judgeOwnerAuthorization({
			payload,
			payloadBytes: submitted.payloadBytes,
			signatures: submitted.signatures,
			summary: report.summary,
			nodeId: node.id,
			task: { id, attempt: row.attempt, spec: specFromRow(row.spec, "task") },
			material,
		});
		if (!judged.accepted) return null;
		return { row, node, link, signatures: judged.signatures, cosigned: judged.cosigned };
	}

	async #insertOwnerAuthorization(user: SessionUser, submitted: SubmittedAuthorization): Promise<boolean> {
		const existing = await this.#db
			.selectFrom("authorizations")
			.select("id")
			.where("id", "=", submitted.id)
			.executeTakeFirst();
		if (existing) return false;
		await this.#db
			.insertInto("authorizations")
			.values({
				id: submitted.id,
				org_id: await defaultOrgId(this.#db),
				payload: Buffer.from(submitted.payloadBytes).toString("base64"),
				signatures: signaturesToJson(submitted.signatures),
				issuer_user_id: user.userId,
				task_ids: submitted.payload.taskIds === null ? null : JSON.stringify(submitted.payload.taskIds),
				deadline: submitted.payload.deadlineMs === null ? null : new Date(submitted.payload.deadlineMs).toISOString(),
				created_at: now(),
				revoked_at: null,
			})
			.execute();
		return true;
	}

	async #storeCosignatures(submitted: SubmittedAuthorization, cosignatures: Signature[]): Promise<void> {
		const row = await this.#db
			.selectFrom("authorizations")
			.select(["signatures", "revoked_at"])
			.where("id", "=", submitted.id)
			.executeTakeFirst();
		if (!row || row.revoked_at !== null) return;
		const stored = signaturesFromJson(row.signatures);
		const keys = new Set(stored.map(signatureKey));
		const combined = [...stored];
		for (const signature of cosignatures) {
			const key = signatureKey(signature);
			if (keys.has(key)) continue;
			keys.add(key);
			combined.push(signature);
		}
		await this.#db
			.updateTable("authorizations")
			.set({ signatures: signaturesToJson(combined) })
			.where("id", "=", submitted.id)
			.execute();
	}

	async #isRevoked(id: string): Promise<boolean> {
		const row = await this.#db
			.selectFrom("authorizations")
			.select("revoked_at")
			.where("id", "=", id)
			.executeTakeFirst();
		return row?.revoked_at != null;
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
			pending: null,
			local: null,
			updatedAt: new Date().toISOString(),
		};
		this.#withdrawLocal(link, id, record);
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
		// Only crhs's own signature path is ruled out for good (D83): the owner may sign again for the
		// new attempt, and so may a local approver.
		const tried =
			record.dispatchedPath === "crhs" ? [...new Set<AuthorizationPath>([...record.tried, "crhs"])] : record.tried;
		const updated: TaskAuthorizationRecord = {
			...record,
			tried,
			attempt,
			pending: null,
			local: null,
			lastRejection: { code, message, attempt: row.attempt, at: new Date().toISOString() },
			updatedAt: new Date().toISOString(),
		};
		this.#withdrawLocal(link, id, record);
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
		this.#withdrawLocal(this.#links.get(row.node_id), id, record);
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
			this.#withdrawLocal(this.#links.get(row.node_id), id, parseTaskAuthorization(row.authorization));
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

	/**
	 * The pooled connection of an SSH node, after its first-time shell probe. Every new connection probes
	 * before its first task: its tasks run on the sh it found, and the node's facts carry the result
	 * (doc/execution-plane.md#执行). A probe that fails keeps the previous facts and falls back to /bin/sh;
	 * it never fails a task.
	 */
	#sshSession(node: NodeRow): Promise<SshConnection> {
		const existing = this.#sshSessions.get(node.id);
		if (existing) return existing;
		const route = this.#sshRoute as NonNullable<ClusterOptions["sshRoute"]>;
		const link = (async (): Promise<SshConnection> => {
			const session = await connectSsh(await route(node));
			let shells: SshShells | null = null;
			try {
				shells = await probeShells(session);
			} catch (err) {
				console.warn(`node ${node.id}: shell probe failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			const sh = shells?.sh ?? "/bin/sh";
			if (shells !== null) {
				await setSshNodeFacts(this.#db, node.id, { sh, bash: shells.bash }).catch((err: unknown) =>
					console.warn(`node ${node.id}: store shell facts: ${err instanceof Error ? err.message : String(err)}`),
				);
			}
			return { session, sh };
		})();
		this.#sshSessions.set(node.id, link);
		link.then(
			(l) => l.session.onClose(() => this.#sshSessions.get(node.id) === link && this.#sshSessions.delete(node.id)),
			() => this.#sshSessions.delete(node.id),
		);
		return link;
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
				const link = await this.#sshSession(node);
				if (!noticeWritten) {
					const notice = sshPrivilegedNotice(privileged);
					if (notice) live.output.append("stderr", live.output.end("stderr"), notice);
					noticeWritten = true;
				}
				try {
					fields = await this.#sshTask(link, spec, input, timeoutMs, ac.signal, sink);
					break;
				} catch (err) {
					if (isStarted || attempt > 0 || !(err instanceof SshError)) throw err;
					link.session.close();
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
		link: SshConnection,
		spec: TaskSpec,
		input: Uint8Array | undefined,
		timeoutMs: number | undefined,
		signal: AbortSignal,
		sink: SshExecSink,
	): Promise<Updateable<TasksTable>> {
		const session = link.session;
		if (spec.kind === "exec") {
			const res = await runSshExec(session, spec, input, sink, { timeoutMs, signal, sh: link.sh });
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
		authorization: authorizationView(row.authorization),
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

/** A task's local approval request note, shown by `crha pending`. */
const LOCAL_REQUEST_NOTE = "crhs asks for this task to be approved on the node";
/** How far an authorization's issued_at may be ahead of crhs's clock before it is refused. */
const SUBMISSION_CLOCK_SKEW_MS = 60_000;

/** The payload the owner signs, in the form stored on the task and shown by the API. */
function pendingOf(authorization: BuiltAuthorization): PendingPayloadView {
	return {
		payload: Buffer.from(authorization.bytes).toString("base64"),
		id: authorization.id,
		deadline:
			authorization.payload.deadlineMs === null ? null : new Date(authorization.payload.deadlineMs).toISOString(),
		taskIds: authorization.payload.taskIds ?? [],
		attempt: authorization.payload.attempt ?? 0,
	};
}

/** The lifetime of the user path of a stored plan; the default when the plan has none. */
function userPathTtl(record: TaskAuthorizationRecord | null): number {
	const path = record?.plan.paths.find((candidate) => candidate.path === "user");
	return path?.ttlMs ?? USER_AUTHORIZATION_TTL_MS;
}

/** The decision port (`authz.ts`) fed with an owner authorization and a node's trust summary. */
function decideOwnerAuthorization(input: {
	now: number;
	summary: TrustSummary;
	nodeId: string;
	task: { id: string; attempt: number; spec: TaskSpec };
	payload: AuthorizationPayload;
	payloadBytes: Uint8Array;
	signatures: readonly AuthzSignature[];
}): AuthzDecision {
	return decide({
		now: input.now,
		clockSkewMs: input.summary.clockSkewMs,
		nodeId: input.nodeId,
		nodeGroups: input.summary.groups,
		trust: input.summary.trust.map(authzEntryFromTrust),
		task: input.task,
		authorization: { payload: input.payloadBytes, decoded: input.payload, signatures: input.signatures },
		localApproval: null,
	});
}

/** An authorization command with its byte hash as hex, for the audit detail. */
function commandForAudit(command: AuthorizationPayload["command"]): Record<string, unknown> | null {
	if (command === null) return null;
	return command.match.kind === "exact"
		? {
				method: command.method,
				match: "exact",
				target: command.match.target,
				spec_sha256: Buffer.from(command.match.specSha256).toString("hex"),
			}
		: { method: command.method, match: "prefix", target: command.match.target };
}

/** Content identity of a signature, so a stored cosignature is not appended twice. */
function signatureKey(signature: Signature): string {
	return signaturesToJson([signature]);
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
