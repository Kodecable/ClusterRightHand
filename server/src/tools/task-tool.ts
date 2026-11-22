/**
 * The component every crh task tool shares (doc/design/agent-runtime.md "Tool categories and shared components"):
 * resolve `targets`, decide one task or a task group, derive the task id from the call, wait, and hand
 * the result to a renderer. Two waiting ways:
 *
 * - background-waitable (`exec`): wait at most `wait`, then return a still-running / waiting note with
 *   the job id so the model follows up with `job_wait` / `job_cancel`;
 * - blocking (the file tools): wait until the task or group ends, approval and signature included, on
 *   both surfaces; expose no task id to the model, and cancel the task when the call is aborted.
 *
 * The renderers are in task-render.ts.
 */
import type { TaskSpec } from "@crh/protocol";
import { type TaskView, TERMINAL } from "../cluster/cluster.ts";
import { resolveTargets, type TaskGroupView } from "../cluster/task-groups.ts";
import { GROUP_TERMINAL } from "../cluster/types.ts";
import { withJobLimit } from "../jobs/limits.ts";
import { derivedId } from "../util/id.ts";
import type { ToolContext } from "./catalog.ts";
import type { ToolResult } from "./render.ts";

// setTimeout cannot wait longer than ~24.8 days, so long waits loop.
const HOUR = 3_600_000;

/** Output budgets are the single-task total as well; no tool may ask for more. */
export { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../util/output-limits.ts";
/** `read_file` reads this many lines per page unless `limit` says otherwise. */
export const READ_PAGE_LINES = 2_000;
/** A batch read keeps this many lines per node unless `limit` says otherwise. */
export const GROUP_READ_LINES = 128;
const ABORT_REASON = "the tool call was aborted";

/** The targets of one call: exactly one node is one task; a node group, `_all` or several entries are a task group. */
export interface CallArgs {
	targets?: string[];
	wait?: number;
	timeout?: number;
	parallel?: number;
	fail_fast?: boolean;
	privileged?: boolean;
}

export interface StartOptions {
	spec: TaskSpec;
	/** stdin for exec, content for file.write. */
	input?: Uint8Array;
	/** Per-node output budget, passed to task or task-group creation. */
	maxLines?: number;
	maxBytes?: number;
	/**
	 * What an exec task group returns; a single task keeps `status` too (exec with_output: false) and
	 * otherwise keeps its full output.
	 */
	outputMode?: "status" | "text";
	/** Seconds a background-waitable call waits; undefined uses the surface's default. */
	wait?: number;
	timeoutMs?: number;
}

/** A node's transport, which decides whether its tasks can keep a full output file. */
export type NodeTransport = "client" | "ssh";

/** How a node applies privileged execution, for the note that says so. */
export interface NodePrivilege {
	transport: NodeTransport;
	/** The node's privileged mode (forward, native, ignore or reject); null for SSH and unknown nodes. */
	mode: string | null;
	/** The SSH user a task runs as; null for a client node. */
	sshUser: string | null;
}

/** A started call: one task, or a task group whose result has one entry per node. */
export type Started =
	| {
			kind: "task";
			task: TaskView;
			nodeName: string;
			transport?: NodeTransport;
			privilege?: NodePrivilege;
			/** The job the call created, when the tool is job-backed (`exec`); the renderers name it. */
			jobId?: string;
	  }
	| {
			kind: "task_group";
			taskGroup: TaskGroupView;
			names: Map<string, string>;
			transports?: Map<string, NodeTransport>;
			privileges?: Map<string, NodePrivilege>;
			jobId?: string;
	  };

/** Waits until a task or group is final, approval and signature included (blocking file tools). */
export type WaitKind = "background" | "blocking";

// ---- started calls ----

async function nodeInfos(
	ctx: ToolContext,
	ids: string[],
): Promise<Map<string, { name: string; transport: NodeTransport; privilege: NodePrivilege }>> {
	const nodes = await ctx.db
		.selectFrom("nodes")
		.select(["id", "name", "transport", "privileged_mode", "ssh_user"])
		.where("id", "in", ids)
		.execute();
	return new Map(
		nodes.map((n) => [
			n.id,
			{
				name: n.name,
				transport: n.transport as NodeTransport,
				privilege: { transport: n.transport as NodeTransport, mode: n.privileged_mode, sshUser: n.ssh_user },
			},
		]),
	);
}

function abortReason(): string {
	return ABORT_REASON;
}

/** How often a wait re-reads a task that waits for approval or a signature, so the UI sees it move on. */
const WAITING_POLL_MS = 1000;

function isWaitingState(state: string | undefined): boolean {
	return state === "awaiting_approval" || state === "awaiting_authorization";
}

/** Pushes a task's or group's state to the UI, with its approval or signature link while it waits. */
async function pushWaitStatus(
	ctx: ToolContext,
	kind: "task" | "task_group",
	id: string,
	state: string | undefined,
): Promise<void> {
	const key = kind === "task" ? { task_id: id } : { task_group_id: id };
	// The id and state first, so a UI learns the record before its link; then the link while it waits.
	await ctx.onStatus?.({ ...key, state });
	if (state === "awaiting_approval") {
		await ctx.onStatus?.({ ...key, state, approval_url: ctx.approvalUrl(kind, id) });
	} else if (state === "awaiting_authorization") {
		const url =
			kind === "task" ? (ctx.taskUrl?.(id) ?? `/tasks/${id}`) : (ctx.taskGroupUrl?.(id) ?? `/task-groups/${id}`);
		await ctx.onStatus?.({ ...key, state, authorization_url: url });
	}
}

/**
 * Waits for one exec task up to `waitMs`, approval and signature included (doc/design/jobs.md "Tools"): a task still
 * waiting for a person when the time is up is returned as it is, and its job's completion notice reports the end.
 * While it waits, the UI gets the approval or signature link, and the state again when the wait ends.
 */
async function waitBackgroundTask(ctx: ToolContext, id: string, waitMs: number): Promise<TaskView | undefined> {
	const deadline = Date.now() + waitMs;
	const left = (): number => Math.max(0, deadline - Date.now());
	let t = await ctx.cluster.getTask(id);
	await pushWaitStatus(ctx, "task", id, t?.state);
	// A waiting task is not final, so waitTask would sit until the deadline without telling the UI that the
	// approval was decided: look again every second while it waits. Shutdown ends the waits, and then this loop
	// must stop rather than spin on the same state.
	if (isWaitingState(t?.state)) {
		let state = t?.state;
		while (isWaitingState(t?.state) && left() > 0 && !ctx.signal?.aborted && !ctx.cluster.waitsEnded) {
			await new Promise((r) => setTimeout(r, Math.min(WAITING_POLL_MS, left())));
			t = await ctx.cluster.getTask(id);
			if (t?.state !== state) {
				state = t?.state;
				await pushWaitStatus(ctx, "task", id, state);
			}
		}
	}
	if (!t || isWaitingState(t.state) || ctx.signal?.aborted || left() <= 0) return t;
	return ctx.cluster.waitTask(id, left(), ctx.signal);
}

/** Waits for one exec task group up to `waitMs`, with the same approval and signature handling. */
async function waitBackgroundGroup(ctx: ToolContext, id: string, waitMs: number): Promise<TaskGroupView> {
	const deadline = Date.now() + waitMs;
	const left = (): number => Math.max(0, deadline - Date.now());
	let g = (await ctx.taskGroups.get(id)) as TaskGroupView;
	await pushWaitStatus(ctx, "task_group", id, g.state);
	let state = g.state;
	// The group wait returns when the group changes, so it follows a decision without polling.
	while (isWaitingState(g.state) && left() > 0 && !ctx.signal?.aborted && !ctx.taskGroups.waitsEnded) {
		g = (await ctx.taskGroups.wait(id, left(), ctx.signal)) as TaskGroupView;
		if (g.state !== state) {
			state = g.state;
			await pushWaitStatus(ctx, "task_group", id, state);
		}
	}
	if (isWaitingState(g.state) || ctx.signal?.aborted || left() <= 0) return g;
	return (await ctx.taskGroups.wait(id, left(), ctx.signal)) as TaskGroupView;
}

/** Waits for an already-created exec task the same way (`job_wait` over its job). */
export function waitExistingTask(ctx: ToolContext, id: string, waitMs: number): Promise<TaskView | undefined> {
	return waitBackgroundTask(ctx, id, waitMs);
}

/** Waits for an already-created exec task group the same way (`job_wait` over its job). */
export function waitExistingGroup(ctx: ToolContext, id: string, waitMs: number): Promise<TaskGroupView> {
	return waitBackgroundGroup(ctx, id, waitMs);
}

/** Pushes a task's waiting status, with its approval or signature link, to the UI. */
async function pushTaskWaiting(ctx: ToolContext, t: TaskView): Promise<void> {
	if (t.state === "awaiting_approval") {
		await ctx.onStatus?.({
			task_id: t.id,
			state: t.state,
			approval_url: ctx.approvalUrl("task", t.id),
		});
	} else if (t.state === "awaiting_authorization") {
		await ctx.onStatus?.({
			task_id: t.id,
			state: t.state,
			authorization_url: ctx.taskUrl?.(t.id) ?? `/tasks/${t.id}`,
		});
	}
}

/**
 * Waits for a blocking file task until it is final, approval and signature included. When the call is
 * aborted the task is cancelled instead, whether it was running or still waiting.
 */
export async function waitBlockingTask(ctx: ToolContext, id: string): Promise<TaskView | undefined> {
	let t = await ctx.cluster.getTask(id);
	await ctx.onStatus?.({ task_id: id, state: t?.state });
	const cancel = async () => {
		await ctx.cluster.cancelTask(id, abortReason(), ctx.actor);
	};
	if (ctx.signal?.aborted) {
		await cancel();
		return ctx.cluster.getTask(id);
	}
	let aborted = false;
	const onAbort = () => {
		aborted = true;
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (t && !TERMINAL.has(t.state) && !ctx.cluster.waitsEnded) {
			await pushTaskWaiting(ctx, t);
			t = (await ctx.cluster.waitTask(id, HOUR, ctx.signal)) ?? t;
			if (aborted || ctx.signal?.aborted) {
				await cancel();
				return (await ctx.cluster.getTask(id)) ?? t;
			}
		}
		return t;
	} finally {
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

/** Rejects a waiting group or cancels its unfinished members when the tool call is aborted. */
async function cancelBlockingGroup(ctx: ToolContext, group: TaskGroupView): Promise<void> {
	let latest = (await ctx.taskGroups.get(group.id)) ?? group;
	if (latest.state === "awaiting_approval") {
		await ctx.taskGroups.decide(latest.id, {
			decision: "rejected",
			by: ctx.actor,
			at: new Date().toISOString(),
			reason: abortReason(),
		});
		// The approval may have been settled just before the abort: the group can already be running.
		latest = (await ctx.taskGroups.get(latest.id)) ?? latest;
	}
	// Cancel the group itself, so its workers stop creating the remaining nodes; the per-member loop this
	// replaces only stopped the members that already existed (doc/design/execution.md "State machine").
	if (!GROUP_TERMINAL.has(latest.state)) await ctx.taskGroups.cancel(latest.id, abortReason(), ctx.actor);
}

/** Pushes a task group's waiting status, with its approval or signature link, to the UI. */
async function pushGroupWaiting(ctx: ToolContext, g: TaskGroupView): Promise<void> {
	if (g.state === "awaiting_approval") {
		await ctx.onStatus?.({
			task_group_id: g.id,
			state: g.state,
			approval_url: ctx.approvalUrl("task_group", g.id),
		});
	} else if (g.state === "awaiting_authorization") {
		await ctx.onStatus?.({
			task_group_id: g.id,
			state: g.state,
			authorization_url: ctx.taskGroupUrl?.(g.id) ?? `/task-groups/${g.id}`,
		});
	}
}

/** Waits for a blocking file task group until it is final; an aborted call cancels it. */
export async function waitBlockingGroup(ctx: ToolContext, id: string): Promise<TaskGroupView> {
	let g = (await ctx.taskGroups.get(id)) as TaskGroupView;
	await ctx.onStatus?.({ task_group_id: id, state: g.state });
	if (ctx.signal?.aborted) {
		await cancelBlockingGroup(ctx, g);
		return (await ctx.taskGroups.get(id)) as TaskGroupView;
	}
	let aborted = false;
	const onAbort = () => {
		aborted = true;
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (!GROUP_TERMINAL.has(g.state) && !ctx.taskGroups.waitsEnded) {
			await pushGroupWaiting(ctx, g);
			g = (await ctx.taskGroups.wait(id, HOUR, ctx.signal)) as TaskGroupView;
			if (aborted || ctx.signal?.aborted) {
				await cancelBlockingGroup(ctx, g);
				return (await ctx.taskGroups.get(id)) as TaskGroupView;
			}
		}
		return g;
	} finally {
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Creates the call's task or task group. The id is derived from the durable call key, so a rerun after a
 * restart reattaches to the same Cluster task instead of starting another.
 */
async function createCall(ctx: ToolContext, args: CallArgs, options: StartOptions): Promise<Started> {
	const resolved = await resolveTargets(ctx.db, ctx.user, args.targets ?? []);
	const common = {
		spec: options.spec,
		input: options.input,
		actor: ctx.actor,
		chain: ctx.chain,
		...(ctx.signal ? { signal: ctx.signal } : {}),
		privileged: args.privileged === true,
		sourceToolTask: ctx.callKey ?? null,
	};
	if (resolved.singleNode) {
		const nodeId = resolved.nodeIds[0] as string;
		const id = ctx.callKey ? derivedId(`task:${ctx.callKey}`) : undefined;
		const task = await ctx.cluster.createTask({
			nodeId,
			spec: options.spec,
			...(options.input === undefined ? {} : { input: options.input }),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
			...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
			// A single exec task with with_output: false keeps only its status and output file path.
			...(options.outputMode === "status" ? { outputMode: "status" as const } : {}),
			actor: ctx.actor,
			chain: ctx.chain,
			...(ctx.signal ? { signal: ctx.signal } : {}),
			privileged: args.privileged === true,
			sourceToolTask: ctx.callKey ?? null,
			...(id ? { id } : {}),
		});
		const info = (await nodeInfos(ctx, [nodeId])).get(nodeId);
		return {
			kind: "task",
			task,
			nodeName: info?.name ?? nodeId,
			transport: info?.transport,
			...(info === undefined ? {} : { privilege: info.privilege }),
		};
	}
	const id = await ctx.taskGroups.create({
		...common,
		targets: resolved.targets,
		nodeIds: resolved.nodeIds,
		...(options.outputMode === undefined ? {} : { outputMode: options.outputMode }),
		...(args.parallel === undefined ? {} : { parallel: args.parallel }),
		...(args.fail_fast === undefined ? {} : { failFast: args.fail_fast }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.maxLines === undefined ? {} : { maxLines: options.maxLines }),
		...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
		...(ctx.callKey ? { id: derivedId(`group:${ctx.callKey}`) } : {}),
	});
	const infos = await nodeInfos(ctx, resolved.nodeIds);
	const names = new Map(Array.from(infos, ([nodeId, info]) => [nodeId, info.name] as const));
	const transports = new Map(Array.from(infos, ([nodeId, info]) => [nodeId, info.transport] as const));
	const privileges = new Map(Array.from(infos, ([nodeId, info]) => [nodeId, info.privilege] as const));
	return {
		kind: "task_group",
		taskGroup: (await ctx.taskGroups.get(id)) as TaskGroupView,
		names,
		transports,
		privileges,
	};
}

/**
 * Runs one crh task tool: create the task or group, wait the way the tool declares, and return what the
 * renderer makes of it. `wait` is ignored for blocking tools, which never expose a wait parameter.
 */
export async function runTaskTool(
	ctx: ToolContext,
	args: CallArgs,
	options: StartOptions,
	waiting: WaitKind,
	render: (started: Started) => ToolResult,
	onStarted?: (started: Started) => Promise<string | undefined>,
	/** A job-backed tool's start, run under the job-limit lock together with its job creation. */
	jobStart?: { ctx: ToolContext; kind: "exec" | "call" | "subagent"; callKey: string },
): Promise<ToolResult> {
	const start = async (): Promise<{ created: Started; jobId: string | undefined }> => {
		const created = await createCall(ctx, args, options);
		const jobId = onStarted === undefined ? undefined : await onStarted(created);
		return { created, jobId };
	};
	let created: Started;
	let jobId: string | undefined;
	if (jobStart) {
		const outcome = await withJobLimit(jobStart.ctx, jobStart.kind, jobStart.callKey, start);
		if ("refused" in outcome) return outcome.refused;
		({ created, jobId } = outcome.value);
	} else {
		({ created, jobId } = await start());
	}
	const started: Started = jobId === undefined ? created : { ...created, jobId };
	// A live wait on the job collects its completion notice instead of leaving it pending
	// (doc/design/jobs.md "Completion notices"); a wait that ends before the work did collects nothing.
	const release = jobId === undefined ? undefined : ctx.jobs?.beginWait(jobId);
	try {
		if (started.kind === "task") {
			const done =
				waiting === "blocking"
					? await waitBlockingTask(ctx, started.task.id)
					: await waitBackgroundTask(ctx, started.task.id, (options.wait ?? ctx.defaultWaitS ?? 30) * 1000);
			if (jobId !== undefined && done !== undefined && TERMINAL.has(done.state)) await ctx.jobs?.collect(jobId);
			return render({ ...started, task: done ?? started.task });
		}
		const taskGroup =
			waiting === "blocking"
				? await waitBlockingGroup(ctx, started.taskGroup.id)
				: await waitBackgroundGroup(ctx, started.taskGroup.id, (options.wait ?? ctx.defaultWaitS ?? 30) * 1000);
		if (jobId !== undefined && GROUP_TERMINAL.has(taskGroup.state)) await ctx.jobs?.collect(jobId);
		return render({ ...started, taskGroup });
	} finally {
		release?.();
	}
}
