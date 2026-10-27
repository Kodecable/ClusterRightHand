import { createHash } from "node:crypto";
import { clone, create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	type Envelope,
	type Facts,
	FactsSchema,
	type HandshakeInit,
	InputRefSchema,
	Stream,
	type TaskExit,
	type TaskSpec,
	TaskSpecSchema,
	TaskState,
	type TaskStatus,
} from "@crh/protocol";
import type { Selectable, Updateable } from "kysely";
import type { Audit } from "../audit/audit.ts";
import { type Evaluation, evaluate, operationOf } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import { newId } from "../util/id.ts";
import type { NodeConnection } from "./connection.ts";
import { getNode, markNodeSeen, type NodeRow, nodeGroupNames, updateNodeFacts } from "./nodes.ts";
import { OUTPUT_KEEP_BYTES, OUTPUT_KEEP_LINES, StreamAccumulator } from "./output.ts";
import { connect as connectSsh, SshError, type SshRoute, type SshSession } from "./ssh/connection.ts";
import { runSshExec, SshConnectionLost, type SshExecSink, shellQuote } from "./ssh/exec.ts";
import { FileTaskError, runSftpFileTask } from "./ssh/file-task.ts";

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
	privileged?: boolean;
	timeoutMs?: number;
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
	stdoutTail: string;
	stderrHead: string;
	stderrTail: string;
	outputFile: string | null;
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
}

export interface ClusterOptions {
	/** How long a node may stay disconnected before its tasks are reported unknown(connection_lost). */
	reconnectGraceMs?: number;
	/** TaskInput chunk size; one envelope must stay under 60 KiB. */
	inputChunkBytes?: number;
	/**
	 * A connection with no message for this long is closed. crha must ping at least every 45 s (crhs only answers); this catches hung
	 * clients and half-open links that never deliver a close.
	 */
	idleTimeoutMs?: number;
	/** Resolves an SSH node's route (hosts, pinned keys, private key). Without it SSH nodes are offline. */
	sshRoute?: (node: NodeRow) => Promise<SshRoute>;
	audit?: Audit;
}

export const TERMINAL: ReadonlySet<TaskRowState> = new Set(["exited", "failed", "rejected", "unknown", "denied"]);
const KINDS: Record<string, string> = {
	exec: "exec",
	fileRead: "file.read",
	fileWrite: "file.write",
	fileEdit: "file.edit",
	fileStat: "file.stat",
	fileList: "file.list",
};

/** A task between dispatch and its recorded end: output accumulates here, not in the database. */
interface LiveTask {
	id: string;
	nodeId: string;
	stdout: StreamAccumulator;
	stderr: StreamAccumulator;
}

interface NodeLink {
	conn: NodeConnection;
	active: boolean;
	/** The node's owner, for the audit trail of connect/disconnect. */
	ownerUserId: string | null;
	/** Set once Hello has been reconciled; tasks are dispatched only after that. */
	ready: boolean;
	/** Task ids we asked about with TaskQuery after Hello. */
	queried: Set<string>;
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
	/** Called once for every task that starts waiting for approval (Auto Review hooks in here). */
	onAwaitingApproval: ((task: TaskView) => Promise<void>) | undefined;
	readonly #sshSessions = new Map<string, Promise<SshSession>>();
	readonly #sshCancels = new Map<string, AbortController>();
	readonly #links = new Map<string, NodeLink>();
	readonly #live = new Map<string, LiveTask>();
	readonly #graceTimers = new Map<string, NodeJS.Timeout>();
	readonly #waiters = new Map<string, Set<() => void>>();
	/** Serializes database updates per task, since envelopes are handled asynchronously. */
	readonly #queues = new Map<string, Promise<void>>();

	constructor(db: Db, options: ClusterOptions = {}) {
		this.#db = db;
		this.#graceMs = options.reconnectGraceMs ?? 120_000;
		this.#chunk = options.inputChunkBytes ?? 48 * 1024;
		this.#idleMs = options.idleTimeoutMs ?? 90_000;
		this.#sshRoute = options.sshRoute;
		this.#audit = options.audit;
	}

	isConnected(nodeId: string): boolean {
		return this.#links.get(nodeId)?.ready === true;
	}

	/** Called by AgentServer after a successful handshake. */
	attach(conn: NodeConnection, node: NodeRow, init: HandshakeInit): void {
		const previous = this.#links.get(node.id);
		const link: NodeLink = {
			conn,
			active: node.status === "active",
			ownerUserId: node.owner_user_id,
			ready: false,
			queried: new Set(),
		};
		this.#links.set(node.id, link);
		previous?.conn.close("replaced by a new connection");
		const timer = this.#graceTimers.get(node.id);
		if (timer) clearTimeout(timer);
		this.#graceTimers.delete(node.id);

		const idle = setTimeout(() => conn.close("idle timeout"), this.#idleMs);
		conn.onEnvelope((env) => {
			idle.refresh();
			this.#handle(link, env).catch((err: unknown) => {
				conn.close(`internal error: ${(err as Error).message}`);
			});
		});
		conn.onClose(() => {
			clearTimeout(idle);
			this.#detach(link);
		});
		void markNodeSeen(this.#db, node.id);
		if (link.active) this.#auditConnection(link, "node.connected");
		void init;
	}

	/** Closes a node's connection, e.g. after approval (crha reconnects as active) or deletion. */
	disconnect(nodeId: string, reason: string): void {
		this.#links.get(nodeId)?.conn.close(reason);
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

	// ---- incoming messages ----

	async #handle(link: NodeLink, env: Envelope): Promise<void> {
		const conn = link.conn;
		const body = env.body;
		if (body.case === "ping") return conn.send({ case: "pong", value: { seq: body.value.seq } });
		if (body.case === "pong") return;
		if (body.case === "facts") return this.#onFacts(conn.nodeId, body.value);
		if (!link.active) return; // pending nodes may only report facts

		switch (body.case) {
			case "hello":
				return this.#onHello(link, body.value.tasks);
			case "taskAccepted":
				return this.#serial(body.value.taskId, () => this.#onAccepted(conn.nodeId, body.value.taskId));
			case "taskRejected":
				return this.#serial(body.value.taskId, () =>
					this.#finish(conn.nodeId, body.value.taskId, {
						state: "rejected",
						error_code: "rejected",
						error_message: body.value.reason,
					}),
				);
			case "taskOutput": {
				const live = this.#ownLive(conn.nodeId, body.value.taskId);
				if (!live) return;
				const stream = body.value.stream === Stream.STDERR ? live.stderr : live.stdout;
				if (!stream.append(Number(body.value.offset), body.value.data)) {
					// A gap means the client could not resend; keep going, the record shows the byte counts.
				}
				return;
			}
			case "taskExit":
				return this.#serial(body.value.taskId, () => this.#onExit(conn, body.value));
			case "taskStatus":
				return this.#serial(body.value.taskId, () => this.#onStatus(link, body.value));
			default:
				return;
		}
	}

	async #onFacts(nodeId: string, facts: Facts): Promise<void> {
		await updateNodeFacts(this.#db, nodeId, {
			facts: toJson(FactsSchema, facts),
			groups: facts.groups,
		});
	}

	/** Reconciles the client's task list with ours, answers with Welcome, then queries the rest. */
	async #onHello(link: NodeLink, tasks: TaskStatus[]): Promise<void> {
		const nodeId = link.conn.nodeId;
		const acks = [];
		const reported = new Set<string>();
		for (const t of tasks) {
			const row = await this.#row(t.taskId);
			if (!row || row.node_id !== nodeId) continue;
			reported.add(t.taskId);
			// After a crhs restart the output is gone from memory: start over and let the client resend it all.
			const live = this.#live.get(t.taskId) ?? this.#newLive(t.taskId, nodeId);
			acks.push({ taskId: t.taskId, stdoutOffset: BigInt(live.stdout.end), stderrOffset: BigInt(live.stderr.end) });
		}
		link.conn.send({ case: "welcome", value: { capabilities: [], acks } });
		link.ready = true;

		const open = await this.#db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			.where("state", "in", ["dispatched", "running"])
			.execute();
		for (const { id } of open) {
			if (reported.has(id)) continue;
			link.queried.add(id);
			link.conn.send({ case: "taskQuery", value: { taskId: id } });
		}
	}

	async #onStatus(link: NodeLink, status: TaskStatus): Promise<void> {
		if (!link.queried.delete(status.taskId)) return;
		if (status.state !== TaskState.UNKNOWN) return; // it will show up in the next Hello or send TaskExit
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
		const live = this.#live.get(exit.taskId) ?? this.#newLive(exit.taskId, conn.nodeId);
		// TaskExit follows all output on the wire; if bytes are missing, the client will resend after a
		// reconnect and send TaskExit again. Record what we have only when complete.
		const complete = live.stdout.end >= Number(exit.stdoutEnd) && live.stderr.end >= Number(exit.stderrEnd);
		if (!complete) return conn.close("output incomplete at exit");

		const outcome = exit.outcome;
		const fields: Updateable<TasksTable> = {
			exit_code: outcome.case === "exitCode" ? outcome.value : null,
			signal: outcome.case === "signal" ? outcome.value : null,
			error_code: outcome.case === "error" ? outcome.value.code : null,
			error_message: outcome.case === "error" ? outcome.value.message : null,
			timed_out: exit.timedOut ? 1 : 0,
			cancelled: exit.cancelled ? 1 : 0,
			stdout_bytes: live.stdout.end,
			stderr_bytes: live.stderr.end,
			stdout_head: live.stdout.head().toString("base64"),
			stdout_tail: live.stdout.tail().toString("base64"),
			stderr_head: live.stderr.head().toString("base64"),
			stderr_tail: live.stderr.tail().toString("base64"),
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
			await this.#finish(conn.nodeId, row.id, { ...fields, state: outcome.case === "error" ? "failed" : "exited" });
		}
		this.#live.delete(row.id);
		conn.send({ case: "taskExitAck", value: { taskId: row.id } });
	}

	// ---- task API ----

	/** How the rule chain judges running `spec` on a node. */
	async evaluateFor(node: NodeRow, spec: TaskSpec, chain: RuleRef[]): Promise<Evaluation> {
		const groups = (await nodeGroupNames(this.#db, [node.id])).get(node.id) ?? [];
		const levels = await loadChain(this.#db, chain);
		return evaluate(levels, { ...operationOf(spec), node: { id: node.id, name: node.name, groups } });
	}

	/**
	 * Creates a task. With a rule chain it is first judged: denied, left waiting for approval, or
	 * dispatched. A node that is not connected at dispatch fails it at once with node_offline.
	 */
	async createTask(input: CreateTaskInput): Promise<TaskView> {
		const node = await getNode(this.#db, input.nodeId);
		if (!node) throw new Error(`no such node: ${input.nodeId}`);
		const kind = KINDS[input.spec.kind.case ?? ""];
		if (!kind) throw new Error("task spec has no kind");
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
		if (input.chain) {
			const evaluation = await this.evaluateFor(node, input.spec, input.chain);
			approval = { evaluation };
			verdict = evaluation.result;
			if (verdict === "require-approval" && input.approvedBy) {
				approval.decision = input.approvedBy;
				verdict = "allow";
			}
		}
		const waiting = verdict === "require-approval";
		const denied = verdict === "deny";
		await this.#db
			.insertInto("tasks")
			.values({
				id,
				org_id: node.org_id,
				node_id: node.id,
				task_group_id: input.taskGroupId ?? null,
				kind,
				spec: JSON.stringify(toJson(TaskSpecSchema, spec)),
				input_size: input.input ? inputBytes.length : null,
				input_sha256: input.input ? inputSha.toString("hex") : null,
				privileged: input.privileged ? 1 : 0,
				timeout_ms: input.timeoutMs ?? null,
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
			})
			.execute();
		void this.#audit?.record({
			actor: auditActor(input.actor),
			action: "task.created",
			target: { type: "task", id },
			detail: {
				node_id: node.id,
				kind,
				summary: summarize(JSON.stringify(toJson(TaskSpecSchema, spec))),
				task_group_id: input.taskGroupId,
				input_sha256: input.input ? inputSha.toString("hex") : undefined,
				policy: approval ? approval.evaluation.result : "none",
				approved_by_group: approval?.decision ? input.taskGroupId : undefined,
			},
		});
		if (!waiting && !denied) await this.#serial(id, () => this.#dispatch(id, node, spec, inputBytes, input));
		const view = (await this.getTask(id)) as TaskView;
		if (waiting && this.onAwaitingApproval) {
			void this.onAwaitingApproval(view).catch((err: unknown) => console.error("review:", err));
		}
		return view;
	}

	/** Moves a task out of awaiting_approval and sends it, or fails it if the node is offline. */
	async #dispatch(
		id: string,
		node: NodeRow,
		spec: TaskSpec,
		inputBytes: Uint8Array,
		opts: { privileged?: boolean; timeoutMs?: number },
	): Promise<void> {
		const ssh = node.transport === "ssh";
		const link = this.#links.get(node.id);
		const fresh = await getNode(this.#db, node.id);
		const online =
			fresh?.status === "active" && (ssh ? this.#sshRoute !== undefined : link?.ready === true && !link.conn.closed);
		const res = await this.#db
			.updateTable("tasks")
			.set(
				online
					? { state: "dispatched", dispatched_at: now(), pending_input: null }
					: {
							state: "failed",
							error_code: "node_offline",
							error_message: "the node is not connected",
							finished_at: now(),
							pending_input: null,
						},
			)
			.where("id", "=", id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		if (res.numUpdatedRows === 0n) return;
		if (!online) {
			this.#notify(id);
			return this.#auditFinish(id);
		}
		this.#notify(id);
		if (ssh) {
			this.#newLive(id, node.id);
			void this.#runSsh(id, node, spec, inputBytes.length > 0 ? inputBytes : undefined, opts.timeoutMs);
		} else if (link) {
			this.#newLive(id, node.id);
			// TaskStart goes out exactly once; a failure here surfaces as a closed connection.
			try {
				link.conn.send({
					case: "taskStart",
					value: {
						taskId: id,
						spec,
						privileged: opts.privileged ?? false,
						authorizations: [],
						timeoutMs: BigInt(opts.timeoutMs ?? 0),
						killGraceMs: 0n,
						spillBytes: BigInt(OUTPUT_KEEP_BYTES),
						spillLines: BigInt(OUTPUT_KEEP_LINES),
					},
				});
				for (let off = 0; off < inputBytes.length; off += this.#chunk) {
					link.conn.send({
						case: "taskInput",
						value: { taskId: id, offset: BigInt(off), data: inputBytes.subarray(off, off + this.#chunk) },
					});
				}
			} catch {
				link.conn.close("send failed");
			}
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
				await this.#db
					.updateTable("tasks")
					.set({ approval: JSON.stringify(record) })
					.where("id", "=", id)
					.execute();
				const node = await getNode(this.#db, row.node_id);
				const spec = fromJson(TaskSpecSchema, JSON.parse(row.spec));
				const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
				void this.#auditApproval(row, decision);
				if (node) {
					await this.#dispatch(id, node, spec, input, {
						privileged: row.privileged === 1,
						timeoutMs: row.timeout_ms ?? undefined,
					});
				}
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
				})
				.where("id", "=", id)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) return false;
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
				.set({ approval: JSON.stringify(record) })
				.where("id", "=", id)
				.execute();
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
				.set({ approval: JSON.stringify(record) })
				.where("id", "=", id)
				.execute();
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
				evaluation = await this.evaluateFor(node, fromJson(TaskSpecSchema, JSON.parse(row.spec)), chain);
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
						})
						.where("id", "=", row.id)
						.where("state", "=", "awaiting_approval")
						.executeTakeFirst();
					if (res.numUpdatedRows > 0n) {
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

	/** Asks the node to cancel a running task. Returns false if it is not running or the node is offline. */
	async cancelTask(id: string): Promise<boolean> {
		const row = await this.#row(id);
		if (!row || TERMINAL.has(row.state)) return false;
		const ssh = this.#sshCancels.get(id);
		if (ssh) {
			ssh.abort();
			return true;
		}
		const link = this.#links.get(row.node_id);
		if (!link?.ready) return false;
		link.conn.send({ case: "taskCancel", value: { taskId: id } });
		return true;
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
	): Promise<void> {
		const live = this.#live.get(id) as LiveTask;
		let isStarted = false;
		const sink = {
			stdout: (d: Uint8Array) => void live.stdout.append(live.stdout.end, d),
			stderr: (d: Uint8Array) => void live.stderr.append(live.stderr.end, d),
			started: () => {
				isStarted = true;
				void this.#serial(id, () => this.#onAccepted(node.id, id));
			},
		};
		const ac = new AbortController();
		this.#sshCancels.set(id, ac);
		const outputFields = () => ({
			stdout_bytes: live.stdout.end,
			stderr_bytes: live.stderr.end,
			stdout_head: live.stdout.head().toString("base64"),
			stdout_tail: live.stdout.tail().toString("base64"),
			stderr_head: live.stderr.head().toString("base64"),
			stderr_tail: live.stderr.tail().toString("base64"),
		});
		try {
			let fields: Updateable<TasksTable>;
			// A pooled connection may have died without notice; nothing has run yet, so retry once fresh.
			for (let attempt = 0; ; attempt++) {
				const session = await this.#sshSession(node);
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
			if (this.#live.get(id) === live) this.#live.delete(id);
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
		if (spec.kind.case === "exec") {
			const res = await runSshExec(session, spec.kind.value, input, sink, { timeoutMs, signal });
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

	#newLive(id: string, nodeId: string): LiveTask {
		const live = { id, nodeId, stdout: new StreamAccumulator(), stderr: new StreamAccumulator() };
		this.#live.set(id, live);
		return live;
	}

	#ownLive(nodeId: string, taskId: string): LiveTask | undefined {
		const live = this.#live.get(taskId);
		return live?.nodeId === nodeId ? live : undefined;
	}

	async #row(id: string): Promise<Selectable<TasksTable> | undefined> {
		return this.#db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
	}

	async #markUnknown(id: string, reason: string): Promise<void> {
		const row = await this.#row(id);
		if (!row || TERMINAL.has(row.state)) return;
		const live = this.#live.get(id);
		await this.#finish(row.node_id, id, {
			state: "unknown",
			error_code: reason,
			error_message: "execution status unknown",
			stdout_bytes: live?.stdout.end ?? 0,
			stderr_bytes: live?.stderr.end ?? 0,
			stdout_head: live?.stdout.head().toString("base64") ?? null,
			stdout_tail: live?.stdout.tail().toString("base64") ?? null,
			stderr_head: live?.stderr.head().toString("base64") ?? null,
			stderr_tail: live?.stderr.tail().toString("base64") ?? null,
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
		if (fields.state !== "unknown") this.#live.delete(id);
		this.#notify(id);
		if (res.numUpdatedRows > 0n) await this.#auditFinish(id);
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

function withInputRef(spec: TaskSpec, ref: { size: number; sha256: Uint8Array } | undefined): TaskSpec {
	const copy = clone(TaskSpecSchema, spec);
	if (!ref) return copy;
	const inputRef = create(InputRefSchema, { size: BigInt(ref.size), sha256: ref.sha256 });
	if (copy.kind.case === "exec") copy.kind.value.stdin = inputRef;
	else if (copy.kind.case === "fileWrite") copy.kind.value.content = inputRef;
	else throw new Error(`${copy.kind.case} takes no input`);
	return copy;
}

function toView(row: Selectable<TasksTable>, live: LiveTask | undefined): TaskView {
	const b64 = (s: string | null) => (s ? Buffer.from(s, "base64").toString("utf8") : "");
	const fromLive = live && !TERMINAL.has(row.state);
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
		stdoutBytes: fromLive ? live.stdout.end : Number(row.stdout_bytes),
		stderrBytes: fromLive ? live.stderr.end : Number(row.stderr_bytes),
		stdoutHead: fromLive ? live.stdout.head().toString("utf8") : b64(row.stdout_head),
		stdoutTail: fromLive ? live.stdout.tail().toString("utf8") : b64(row.stdout_tail),
		stderrHead: fromLive ? live.stderr.head().toString("utf8") : b64(row.stderr_head),
		stderrTail: fromLive ? live.stderr.tail().toString("utf8") : b64(row.stderr_tail),
		outputFile: row.output_file,
		createdAt: row.created_at,
		finishedAt: row.finished_at,
		taskGroupId: row.task_group_id,
		ruleChain: row.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null,
		approval: row.approval ? (JSON.parse(row.approval) as ApprovalRecord) : null,
	};
}

function operationOfJson(specJson: string): { method: string; target: string } | null {
	try {
		return operationOf(fromJson(TaskSpecSchema, JSON.parse(specJson)));
	} catch {
		return null;
	}
}

function auditActor(actor: Actor) {
	return { type: actor.type, id: actor.id, onBehalfOfUserId: actor.onBehalfOfUserId };
}

/** Spec JSON (protobuf JSON form) to a short description. */
export function summarize(specJson: string): string {
	try {
		const spec = JSON.parse(specJson) as Record<string, Record<string, unknown>>;
		const exec = spec.exec;
		if (exec) {
			if (typeof exec.shell === "string") return exec.shell;
			return ((exec.argv as string[] | undefined) ?? []).map(shellQuote).join(" ");
		}
		for (const value of Object.values(spec)) {
			if (typeof value?.path === "string") return value.path;
		}
	} catch {}
	return "";
}

function now(): string {
	return new Date().toISOString();
}
