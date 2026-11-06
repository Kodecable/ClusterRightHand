/**
 * The component every crh task tool shares (D111, doc/agent-runtime.md#工具层的分类与复用组件d111):
 * resolve `targets`, decide one task or a task group, derive the task id from the call, wait, and hand
 * the result to a renderer. Two waiting ways:
 *
 * - background-waitable (`exec`): wait at most `wait`, then return a still-running / waiting note with
 *   the task id so the model follows up with `task_wait` / `task_cancel`;
 * - blocking (the file tools): wait until the task or group ends, approval and signature included, on
 *   both surfaces; expose no task id to the model, and cancel the task when the call is aborted.
 *
 * The renderers are in task-render.ts.
 */
import type { TaskSpec } from "@crh/protocol";
import { type TaskView, TERMINAL } from "../cluster/cluster.ts";
import { resolveTargets, type TaskGroupView } from "../cluster/task-groups.ts";
import { GROUP_TERMINAL } from "../cluster/types.ts";
import { derivedId } from "../util/id.ts";
import type { ToolContext } from "./catalog.ts";
import type { ToolResult } from "./render.ts";

// setTimeout cannot wait longer than ~24.8 days, so long waits loop.
const HOUR = 3_600_000;
/** Output budgets are the single-task total as well; no tool may ask for more (D112). */
export const MAX_OUTPUT_LINES = 2_000;
export const MAX_OUTPUT_BYTES = 50 * 1024;
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
	/** Per-node output budget, passed to task or task-group creation (D112). */
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

/** A started call: one task, or a task group whose result has one entry per node. */
export type Started =
	| { kind: "task"; task: TaskView; nodeName: string; transport?: NodeTransport }
	| {
			kind: "task_group";
			taskGroup: TaskGroupView;
			names: Map<string, string>;
			transports?: Map<string, NodeTransport>;
	  };

/** Waits until a task or group is final, approval and signature included (blocking file tools). */
export type WaitKind = "background" | "blocking";

// ---- started calls ----

async function nodeInfos(
	ctx: ToolContext,
	ids: string[],
): Promise<Map<string, { name: string; transport: NodeTransport }>> {
	const nodes = await ctx.db.selectFrom("nodes").select(["id", "name", "transport"]).where("id", "in", ids).execute();
	return new Map(nodes.map((n) => [n.id, { name: n.name, transport: n.transport }]));
}

function abortReason(): string {
	return ABORT_REASON;
}

/**
 * Waits for one exec task the background-waitable way: up to `waitMs`; with `waitThroughApproval`
 * (agents) it sits through approval and signature first, pushing their links to the UI.
 */
async function waitBackgroundTask(ctx: ToolContext, id: string, waitMs: number): Promise<TaskView | undefined> {
	if (!ctx.waitThroughApproval) {
		if (ctx.onStatus !== undefined) {
			const first = await ctx.cluster.getTask(id);
			await ctx.onStatus({ task_id: id, state: first?.state });
		}
		return ctx.cluster.waitTask(id, waitMs, ctx.signal);
	}
	let t = await ctx.cluster.getTask(id);
	await ctx.onStatus?.({ task_id: id, state: t?.state });
	// A waiting task is not final, so waitTask would sit through the whole wait: look first. Shutdown ends
	// the waits, and then these loops must stop rather than re-enter waitTask on the same state.
	if (t?.state === "awaiting_approval") {
		await ctx.onStatus?.({ task_id: id, state: "awaiting_approval", approval_url: ctx.approvalUrl("task", id) });
		while (t?.state === "awaiting_approval" && !ctx.signal?.aborted && !ctx.cluster.waitsEnded) {
			await new Promise((r) => setTimeout(r, 1000));
			t = await ctx.cluster.getTask(id);
		}
		await ctx.onStatus?.({ task_id: id, state: t?.state });
	}
	if (t?.state === "awaiting_authorization") {
		await ctx.onStatus?.({
			task_id: id,
			state: "awaiting_authorization",
			authorization_url: ctx.taskUrl?.(id) ?? `/tasks/${id}`,
		});
		while (t?.state === "awaiting_authorization" && !ctx.signal?.aborted && !ctx.cluster.waitsEnded) {
			await new Promise((r) => setTimeout(r, 1000));
			t = await ctx.cluster.getTask(id);
		}
		await ctx.onStatus?.({ task_id: id, state: t?.state });
	}
	return t && !ctx.signal?.aborted ? ctx.cluster.waitTask(id, waitMs, ctx.signal) : t;
}

/** Waits for one exec task group the background-waitable way, with the same approval handling. */
async function waitBackgroundGroup(ctx: ToolContext, id: string, waitMs: number): Promise<TaskGroupView> {
	if (!ctx.waitThroughApproval) {
		if (ctx.onStatus !== undefined) {
			const first = await ctx.taskGroups.get(id);
			await ctx.onStatus({ task_group_id: id, state: first?.state });
		}
		return (await ctx.taskGroups.wait(id, waitMs)) as TaskGroupView;
	}
	let g = (await ctx.taskGroups.get(id)) as TaskGroupView;
	await ctx.onStatus?.({ task_group_id: id, state: g.state });
	if (g.state === "awaiting_approval") {
		await ctx.onStatus?.({
			task_group_id: id,
			state: "awaiting_approval",
			approval_url: ctx.approvalUrl("task_group", id),
		});
		while (g.state === "awaiting_approval" && !ctx.signal?.aborted && !ctx.taskGroups.waitsEnded)
			g = (await ctx.taskGroups.wait(id, HOUR, ctx.signal)) as TaskGroupView;
		await ctx.onStatus?.({ task_group_id: id, state: g.state });
	}
	if (g.state === "awaiting_authorization") {
		await ctx.onStatus?.({
			task_group_id: id,
			state: "awaiting_authorization",
			authorization_url: ctx.taskGroupUrl?.(id) ?? `/task-groups/${id}`,
		});
		while (g.state === "awaiting_authorization" && !ctx.signal?.aborted && !ctx.taskGroups.waitsEnded)
			g = (await ctx.taskGroups.wait(id, HOUR, ctx.signal)) as TaskGroupView;
		await ctx.onStatus?.({ task_group_id: id, state: g.state });
	}
	return ctx.signal?.aborted ? g : ((await ctx.taskGroups.wait(id, waitMs, ctx.signal)) as TaskGroupView);
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
 * aborted the task is cancelled instead (a running one asked to stop, a waiting one rejected).
 */
async function waitBlockingTask(ctx: ToolContext, id: string): Promise<TaskView | undefined> {
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
	for (const task of latest.tasks) {
		if (!TERMINAL.has(task.state)) await ctx.cluster.cancelTask(task.id, abortReason(), ctx.actor);
	}
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
async function waitBlockingGroup(ctx: ToolContext, id: string): Promise<TaskGroupView> {
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
		privileged: args.privileged === true,
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
			privileged: args.privileged === true,
			...(id ? { id } : {}),
		});
		const info = (await nodeInfos(ctx, [nodeId])).get(nodeId);
		return { kind: "task", task, nodeName: info?.name ?? nodeId, transport: info?.transport };
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
	return {
		kind: "task_group",
		taskGroup: (await ctx.taskGroups.get(id)) as TaskGroupView,
		names,
		transports,
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
): Promise<ToolResult> {
	const started = await createCall(ctx, args, options);
	if (started.kind === "task") {
		const done =
			waiting === "blocking"
				? await waitBlockingTask(ctx, started.task.id)
				: await waitBackgroundTask(ctx, started.task.id, (options.wait ?? ctx.defaultWaitS ?? 30) * 1000);
		return render({ ...started, task: done ?? started.task });
	}
	const taskGroup =
		waiting === "blocking"
			? await waitBlockingGroup(ctx, started.taskGroup.id)
			: await waitBackgroundGroup(ctx, started.taskGroup.id, (options.wait ?? ctx.defaultWaitS ?? 30) * 1000);
	return render({ ...started, taskGroup });
}

// ---- task_wait / task_cancel ----

/** Waits for an already-created exec task the background-waitable way (`task_wait`). */
export function waitExistingTask(ctx: ToolContext, id: string, waitMs: number): Promise<TaskView | undefined> {
	return waitBackgroundTask(ctx, id, waitMs);
}

/** Waits for an already-created exec task group the background-waitable way (`task_wait`). */
export function waitExistingGroup(ctx: ToolContext, id: string, waitMs: number): Promise<TaskGroupView> {
	return waitBackgroundGroup(ctx, id, waitMs);
}
