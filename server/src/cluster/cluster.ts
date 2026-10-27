import { createHash } from "node:crypto";
import { clone, create, toJson } from "@bufbuild/protobuf";
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
import type { Db } from "../storage/db.ts";
import type { TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import { newId } from "../util/id.ts";
import type { NodeConnection } from "./connection.ts";
import { getNode, markNodeSeen, type NodeRow, updateNodeFacts } from "./nodes.ts";
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
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	createdAt: string;
	finishedAt: string | null;
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
}

const TERMINAL: ReadonlySet<TaskRowState> = new Set(["exited", "failed", "rejected", "unknown"]);
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
	}

	isConnected(nodeId: string): boolean {
		return this.#links.get(nodeId)?.ready === true;
	}

	/** Called by AgentServer after a successful handshake. */
	attach(conn: NodeConnection, node: NodeRow, init: HandshakeInit): void {
		const previous = this.#links.get(node.id);
		const link: NodeLink = { conn, active: node.status === "active", ready: false, queried: new Set() };
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
		void markNodeSeen(this.#db, nodeId);
		this.#graceTimers.set(
			nodeId,
			setTimeout(() => {
				this.#graceTimers.delete(nodeId);
				void this.#expireNode(nodeId);
			}, this.#graceMs),
		);
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

	/** Creates and dispatches a task. A node that is not connected fails it at once with node_offline. */
	async createTask(input: CreateTaskInput): Promise<TaskView> {
		const node = await getNode(this.#db, input.nodeId);
		if (!node) throw new Error(`no such node: ${input.nodeId}`);
		const kind = KINDS[input.spec.kind.case ?? ""];
		if (!kind) throw new Error("task spec has no kind");
		const id = newId();
		const inputBytes = input.input ?? new Uint8Array(0);
		const inputSha = createHash("sha256").update(inputBytes).digest();
		const spec = withInputRef(input.spec, input.input ? { size: inputBytes.length, sha256: inputSha } : undefined);

		const ssh = node.transport === "ssh";
		const link = this.#links.get(node.id);
		const online =
			node.status === "active" && (ssh ? this.#sshRoute !== undefined : link?.ready === true && !link.conn.closed);
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
				state: online ? "dispatched" : "failed",
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: online ? null : "node_offline",
				error_message: online ? null : "the node is not connected",
				actor_type: input.actor.type,
				actor_id: input.actor.id,
				on_behalf_of_user_id: input.actor.onBehalfOfUserId,
				created_at: now(),
				dispatched_at: online ? now() : null,
				accepted_at: null,
				finished_at: online ? null : now(),
				stdout_bytes: 0,
				stderr_bytes: 0,
				stdout_head: null,
				stdout_tail: null,
				stderr_head: null,
				stderr_tail: null,
				output_file: null,
				late_result: null,
			})
			.execute();
		if (online && ssh) {
			this.#newLive(id, node.id);
			void this.#runSsh(id, node, spec, input.input, input.timeoutMs);
		} else if (online && link) {
			this.#newLive(id, node.id);
			// TaskStart goes out exactly once; a failure here surfaces as a closed connection.
			try {
				link.conn.send({
					case: "taskStart",
					value: {
						taskId: id,
						spec,
						privileged: input.privileged ?? false,
						authorizations: [],
						timeoutMs: BigInt(input.timeoutMs ?? 0),
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
		return this.getTask(id) as Promise<TaskView>;
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
		await this.#db
			.updateTable("tasks")
			.set({ ...fields, finished_at: now() })
			.where("id", "=", id)
			.where("node_id", "=", nodeId)
			.where("state", "in", ["dispatched", "running"])
			.execute();
		if (fields.state !== "unknown") this.#live.delete(id);
		this.#notify(id);
	}

	#notify(id: string): void {
		for (const w of this.#waiters.get(id) ?? []) w();
		this.#waiters.delete(id);
	}

	#serial(taskId: string, fn: () => Promise<void>): Promise<void> {
		const next = (this.#queues.get(taskId) ?? Promise.resolve()).then(fn);
		const tail = next.catch(() => {});
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
	};
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
