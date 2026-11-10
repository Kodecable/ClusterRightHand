/**
 * The types of the Cluster's public surface and the constants of the task state machine. The modules
 * of this directory build on them; cluster.ts re-exports them as the Cluster's own API.
 */
import type { AgentRequest, ApprovalDecision, ApprovalRecord, TaskView } from "@crh/api";
import type { TaskSpec } from "@crh/protocol";
import type { Audit } from "../audit/audit.ts";
import type { RuleRef } from "../policy/store.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { OutputMode, TaskGroupState, TaskState as TaskRowState } from "../storage/schema.ts";
import type { NodeRow } from "./nodes.ts";
import type { SshRoute } from "./ssh/connection.ts";

/** Who asked for a task; see doc/design/access-control.md "Actors" */
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
	/** A privileged task: rules see the flag and crha decides by its privileged mode (doc/design/privilege.md). */
	privileged?: boolean;
	timeoutMs?: number;
	/** How much output to keep; single tasks use `full`, a task group's tasks get its mode. */
	outputMode?: OutputMode;
	/** The task's output budget; for a task group's member, the group's per-node caps. */
	maxLines?: number;
	maxBytes?: number;
	actor: Actor;
	taskGroupId?: string;
	/** The rule chain, root first; omitted when a user acts in person (doc/design/access-control.md "Rule chain"). */
	chain?: RuleRef[];
	/** Set for the tasks of an approved task group: a require-approval result counts as approved. */
	approvedBy?: ApprovalDecision;
	/**
	 * A task group member that cannot stop to wait for an approval: a require-approval verdict ends it
	 * `rejected` instead of leaving it waiting inside a group that already started
	 * (doc/design/access-control.md "Approvals").
	 */
	noWait?: boolean;
	/**
	 * A caller-chosen id. If a task with it exists, createTask returns that task instead of creating one: a tool
	 * call that reruns after a crash reattaches to the task its first attempt started (doc/design/agent-runtime.md).
	 */
	id?: string;
}

/** What decide() expects of the waiting row's handler when its turn runs (the read is checked again). */
export interface ApprovalExpect {
	/**
	 * The handler the row must have. `any-waiting` only requires one (the default when the caller passes
	 * no expectation): a row without a handler is already allowed and being dispatched, not waiting.
	 */
	handlerType: "user" | "agent" | "any-waiting";
	/** For `agent`, the session that must handle it; omitted when the caller only knows the kind. */
	handlerSessionId?: string | null;
}

/**
 * What a task decision did: `approved` recorded a decision and dispatched (or will dispatch), `rejected`
 * ended the task, `node_deleted` approved it but ended it because its node was gone; false means it was
 * not waiting for a decision with the expected handler.
 */
export type DecisionResult = "approved" | "rejected" | "node_deleted" | false;

export type { AgentRequest, ApprovalDecision, ApprovalRecord, TaskView };

export interface ClusterOptions {
	/** How long a node may stay disconnected before its tasks are reported unknown(connection_lost). */
	reconnectGraceMs?: number;
	/** How long a task waits for its offline node before failing node_offline. */
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
	 * crhs's authorization signing key (doc/design/privilege.md "Authorization signing key"). Without it no crhs-signed
	 * authorization can be issued, so only the owner's user/local paths remain available.
	 */
	authorizationKey?: AuthorizationSigningKey;
	/** How long a forward dispatch waits for the first trust.summary of its connection. */
	trustWaitMs?: number;
	/** Warn when a node's clock differs by more than this; 0 disables (doc/design/privilege.md "Clock"). */
	clockWarnMs?: number;
	audit?: Audit;
}

export const TERMINAL: ReadonlySet<TaskRowState> = new Set(["exited", "failed", "rejected", "unknown", "denied"]);

/** Whether the row already has a result. `unknown` does not: it still accepts a late result. */
export function recorded(state: TaskRowState): boolean {
	return TERMINAL.has(state) && state !== "unknown";
}

/** A task group in one of these states runs nothing more (doc/design/execution.md "State machine"). */
export const GROUP_TERMINAL: ReadonlySet<TaskGroupState> = new Set([
	"finished",
	"interrupted",
	"rejected",
	"cancelled",
]);

/**
 * How long the output of a task reported `unknown` stays in memory for a late result. The client keeps
 * its output until task.exit.ack, so a node that comes back in this window can still be acked from
 * where it stopped; after it the buffer is dropped so a node that never returns cannot leak it.
 */
export const UNKNOWN_OUTPUT_KEEP_MS = 10 * 60 * 1000;

/**
 * How long a task waits for its node to reconnect before it fails with node_offline. The wait
 * covers the seconds after a crhs restart in which nodes reconnect and short network hiccups.
 */
export const NODE_OFFLINE_GRACE_MS = 30_000;

/** A crha's answer to a `task.start` for a task it was told to cancel before starting (doc/design/protocol.md "task.start"). */
export const TASK_CANCELLED_CODE = "cancelled";

/**
 * Codes a crha answers `task.start` with before accepting, for which the task may be retried with a
 * higher attempt (doc/design/protocol.md "task.start"). Other codes are terminal.
 */
export const AUTHORIZATION_CODES: ReadonlySet<string> = new Set([
	"authorization_required",
	"authorization_invalid",
	"authorization_expired",
	"authorization_rejected",
]);

/** How long a task waits for its signature before it ends as `authorization_wait_expired`. */
export const AUTHORIZATION_WAIT_MS = 24 * 60 * 60 * 1000;
