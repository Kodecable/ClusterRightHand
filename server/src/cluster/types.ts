/**
 * The types of the Cluster's public surface and the constants of the task state machine. The modules
 * of this directory build on them; cluster.ts re-exports them as the Cluster's own API.
 */
import type { JsonTaskResult, TaskSpec } from "@crh/protocol";
import type { Audit } from "../audit/audit.ts";
import type { Evaluation } from "../policy/rules.ts";
import type { RuleRef } from "../policy/store.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { OutputMode, TaskGroupState, TaskState as TaskRowState } from "../storage/schema.ts";
import type { TaskAuthorizationRecord } from "./authorization.ts";
import type { NodeRow } from "./nodes.ts";
import type { SshRoute } from "./ssh/connection.ts";

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
	/** How much output to keep; single tasks use `full`, a task group's tasks get its mode. */
	outputMode?: OutputMode;
	/** The task's output budget (D112); for a task group's member, the group's per-node caps. */
	maxLines?: number;
	maxBytes?: number;
	actor: Actor;
	taskGroupId?: string;
	/** The rule chain, root first; omitted when a user acts in person (doc/access-control.md#规则链). */
	chain?: RuleRef[];
	/** Set for the tasks of an approved task group: a require-approval result counts as approved. */
	approvedBy?: ApprovalDecision;
	/** The task group's own judgment of this node, so a member does not re-run the chain its task group already ran. */
	evaluation?: Evaluation;
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
	/** The task's timeout in milliseconds; null when it had none (used by the text note "timed out after N s"). */
	timeoutMs: number | null;
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
	/** A single task's merged stdout+stderr tail in arrival order (D112); "" for the batch modes. */
	outputTail: string;
	/** Lines of the merged tail, counted by newline characters; a last line without one counts. */
	outputTailLines: number;
	/** Total lines of the merged output; null until crha reports it in task.exit (or an SSH task counts it). */
	outputLines: number | null;
	/** The task's output budget; null means the default for its mode (D112). */
	maxLines: number | null;
	maxBytes: number | null;
	outputFile: string | null;
	/** How much output was kept for this task (doc/execution-plane.md#输出). */
	outputMode: OutputMode;
	/** Whether this is a privileged task (doc/privilege.md). */
	privileged: boolean;
	/** The authorization plan and its history for a privileged task; null for the others (doc/m4.md#crhs-侧数据). */
	authorization: TaskAuthorizationRecord | null;
	/**
	 * The task's structured result in its JSON form; null for a kind that reports none, for a task
	 * that is still running and for one that failed (doc/protocol.md TaskResult).
	 */
	result: JsonTaskResult | null;
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
	/** The chain's first session, for grouping approvals by session tree (a schedule may come before it). */
	rootSessionId: string | null;
	/** Who handles a waiting approval; null when it is not waiting. */
	handlerType: "agent" | "user" | null;
	handlerSessionId: string | null;
}

export interface ClusterOptions {
	/** How long a node may stay disconnected before its tasks are reported unknown(connection_lost). */
	reconnectGraceMs?: number;
	/** How long a task waits for its offline node before failing node_offline (D113). */
	nodeOfflineGraceMs?: number;
	/** How long a task reported unknown keeps its output for a late result (UNKNOWN_OUTPUT_KEEP_MS). */
	unknownOutputKeepMs?: number;
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
export function recorded(state: TaskRowState): boolean {
	return TERMINAL.has(state) && state !== "unknown";
}

/** A task group in one of these states runs nothing more (doc/execution-plane.md#状态机). */
export const GROUP_TERMINAL: ReadonlySet<TaskGroupState> = new Set(["finished", "interrupted", "rejected"]);

/**
 * How long the output of a task reported `unknown` stays in memory for a late result. The client keeps
 * its output until task.exit.ack, so a node that comes back in this window can still be acked from
 * where it stopped; after it the buffer is dropped so a node that never returns cannot leak it.
 */
export const UNKNOWN_OUTPUT_KEEP_MS = 10 * 60 * 1000;

/**
 * How long a task waits for its node to reconnect before it fails with node_offline (D113). The wait
 * covers the seconds after a crhs restart in which nodes reconnect and short network hiccups.
 */
export const NODE_OFFLINE_GRACE_MS = 30_000;

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

/** How long a task waits for its signature before it ends as `authorization_wait_expired` (D98). */
export const AUTHORIZATION_WAIT_MS = 24 * 60 * 60 * 1000;
