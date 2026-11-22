/**
 * The job layer's shared model (doc/design/jobs.md "Job model" and "Adapters"): one vocabulary for work a tool
 * call started, whatever record is behind it. The layer calls only the `JobSource` interface; the adapters
 * read their own records and never write `jobs`.
 */
import type { TaskAction, TaskOutcome } from "@crh/api";
import type { Selectable } from "kysely";
import type { Actor, TaskView } from "../cluster/types.ts";
import type { JobState, JobsTable, JobWait, SessionState } from "../storage/schema.ts";
import type { ToolContext } from "../tools/catalog.ts";
import type { NodePrivilege, NodeTransport, Started } from "../tools/task-tool.ts";
import type { ToolResult } from "../util/tool-result.ts";

export type { JobKind, JobNotice, JobState, JobWait } from "../storage/schema.ts";

/** One job row as the adapters and tools read it. */
export type JobRow = Selectable<JobsTable>;

/** What an adapter projects from the record behind a job; `undefined` once the record is gone. */
export interface JobProjection {
	state: JobState;
	outcome: TaskOutcome | null;
	wait: JobWait | null;
}

/** What a wait may use besides its deadline (doc/design/jobs.md "Adapters"). */
export interface JobWaitOptions {
	/**
	 * End a wait on something this agent must decide, such as a subagent request. Only the `subagent` adapter
	 * reads it: an approval or signature on an exec task or a call is the user's, not the agent's, so the
	 * caller passes false for those kinds.
	 */
	attention: boolean;
	signal?: AbortSignal;
	/**
	 * The caller's tool context. The `exec` adapter reuses the tool layer's wait through approval and signature
	 * in agent sessions (the same wait `task_wait` used); the job layer never imports the tools at runtime.
	 */
	ctx?: ToolContext;
}

/** The one interface every kind implements, in the layer that owns its record (doc/design/jobs.md "Adapters"). */
export interface JobSource {
	kind: JobRow["kind"];
	/** The projected state of the record behind the job; undefined once the record is gone. */
	project(job: JobRow): Promise<JobProjection | undefined>;
	/** Waits up to `ms` for the record to settle, or for a wait when `attention` is set. */
	wait(job: JobRow, ms: number, options: JobWaitOptions): Promise<void>;
	/** Cancels the work through the record's own cancel path, recorded as `by`. */
	cancel(job: JobRow, by: Actor): Promise<boolean>;
	/** The model-facing result, the same text the starting tool returns. */
	render(job: JobRow, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * The exec waits and renderers, supplied by the tools layer: the job layer reuses `execTaskResult`, the group
 * renderer and the wait that sits through approval in agent sessions without importing server/src/tools at
 * runtime (doc/design/jobs.md "Adapters").
 */
export interface ExecJobRenderers {
	task(
		ctx: ToolContext,
		task: TaskView,
		nodeName: string,
		transport?: NodeTransport,
		privilege?: NodePrivilege,
		jobId?: string,
	): ToolResult;
	group(ctx: ToolContext, started: Started, jobId?: string): ToolResult;
	/** Waits like `task_wait` did: up to `waitMs`, through approval and signature in an agent session. */
	waitTask(ctx: ToolContext, id: string, waitMs: number): Promise<void>;
	/** Waits like a group `task_wait` did: up to `waitMs`, through approval and signature in an agent session. */
	waitGroup(ctx: ToolContext, id: string, waitMs: number): Promise<void>;
}

/** The fields a producer supplies when it creates a job right after the record behind it. */
export interface NewJob {
	kind: JobRow["kind"];
	/** The durable tool call key; the job id derives from it. */
	callKey: string;
	/** The organization of the actor; the default organization when omitted. */
	orgId?: string;
	actor: Actor;
	/** The session whose tool call started it; null for an MCP client. */
	sessionId: string | null;
	resourceType: JobRow["resource_type"];
	resourceId: string;
	action: TaskAction;
}

/** The stored run of a child session, as the agent runtime reports it to the subagent adapter. */
export interface SubagentJobRun {
	state: SessionState;
	wait: JobWait | null;
	outcome: TaskOutcome | null;
}

/**
 * What the subagent adapter needs from the agent runtime (doc/design/jobs.md "Adapters"). The job layer never
 * imports pi-durable or the agent layer: the runtime implements this interface and passes it in.
 */
export interface SubagentJobRuntime {
	/** The child's run state and, once its run ended, its outcome; undefined when the session is gone. */
	project(childId: string): Promise<SubagentJobRun | undefined>;
	/** Waits for the child's run; with `attention`, ends early when the child hands its parent a request. */
	wait(
		childId: string,
		options: { attention: boolean; signal?: AbortSignal; handler?: string },
	): Promise<{ status: "done" | "unanswered" | "attention"; reason?: string }>;
	/** Stops the child's subtree, as stopping a session does. */
	cancel(childId: string, by: Actor): Promise<boolean>;
	/** Whether a completion-notice wake for the child is queued or being delivered (the child is not idle yet). */
	noticeBusy(childId: string): boolean;
	/**
	 * Whether a completion-notice wake for the child can still run under `jobs.max_consecutive_wakes`. A pending
	 * notice only keeps the child unsettled while its wake can be delivered (doc/design/jobs.md "States").
	 */
	noticeWakeAvailable(childId: string): Promise<boolean>;
	/** The answer of the child's latest run, when it ended with one. */
	answer(childId: string): Promise<string | undefined>;
	/** The model-facing block of requests the child handed to an ancestor agent, if any. */
	requestsBlock(childId: string): Promise<string | undefined>;
}
