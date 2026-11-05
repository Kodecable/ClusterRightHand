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
 * Rendering follows D112: `exec` and `read_file` are text (raw block plus note block per node, a task
 * group leading with a group note), every other tool is one compact JSON block. UI details keep the
 * shape the WebUI reads today (task_id / task_group_id, state, per-node states, error codes).
 */
import type { JsonTaskResult, TaskSpec } from "@crh/protocol";
import { countOutputLines, type TaskView, TERMINAL } from "../cluster/cluster.ts";
import { resolveTargets, type TaskGroupView } from "../cluster/task-groups.ts";
import { GROUP_TERMINAL } from "../cluster/types.ts";
import { derivedId } from "../util/id.ts";
import type { ToolContext } from "./catalog.ts";
import { jsonResult, type TextBlock, type ToolResult, textResult } from "./render.ts";

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

// ---- details for the UI ----

/** One task's details, the shape the WebUI's tool cards read today (doc/agent-runtime.md#给-ui-的-details). */
export function taskDetails(task: TaskView, nodeName: string): Record<string, unknown> {
	const out: Record<string, unknown> = { task_id: task.id, node: nodeName, state: task.state };
	if (task.privileged) out.privileged = true;
	if (task.exitCode !== null) out.exit_code = task.exitCode;
	if (task.signal !== null) out.signal = task.signal;
	if (task.timedOut) out.timed_out = true;
	if (task.cancelled) out.cancelled = true;
	if (task.errorCode !== null) out.error = { code: task.errorCode, message: task.errorMessage ?? "" };
	return out;
}

/** A task group's details: the group state and one detail per node. */
export function groupDetails(group: TaskGroupView, names: Map<string, string>): Record<string, unknown> {
	const out: Record<string, unknown> = {
		task_group_id: group.id,
		state: group.state,
		nodes: group.tasks.map((task) => taskDetails(task, names.get(task.nodeId) ?? task.nodeId)),
	};
	if (group.privileged) out.privileged = true;
	if (group.skipped.length > 0) out.skipped = group.skipped.map((id) => names.get(id) ?? id);
	return out;
}

// ---- failure classification ----

/** Whether a task result counts as failed (doc/agent-runtime.md#错误结果): denied/rejected/unknown, a nonzero exit, a signal, a timeout or a cancel. */
export function taskFailed(task: TaskView): boolean {
	if (task.state === "failed" || task.state === "denied" || task.state === "rejected" || task.state === "unknown")
		return true;
	if (task.errorCode !== null) return true;
	if (task.cancelled || task.timedOut) return true;
	if (task.signal !== null && task.signal !== "") return true;
	return task.exitCode !== null && task.exitCode !== 0;
}

function groupFailed(group: TaskGroupView): boolean {
	return GROUP_TERMINAL.has(group.state) && group.state !== "finished"
		? true
		: group.tasks.some((task) => taskFailed(task));
}

/** The stable code and message of a failed task; undefined for one that did not fail. */
export function taskError(task: TaskView): { code: string; message: string } | undefined {
	if (task.errorCode !== null) return { code: task.errorCode, message: task.errorMessage ?? "" };
	if (task.timedOut) {
		return {
			code: "timed_out",
			message: `the task timed out${task.timeoutMs === null ? "" : ` after ${seconds(task.timeoutMs)}`}`,
		};
	}
	if (task.cancelled) return { code: "cancelled", message: "the task was cancelled" };
	if (task.signal !== null && task.signal !== "") {
		return { code: "signal", message: `the process was killed by ${task.signal}` };
	}
	if (task.exitCode !== null && task.exitCode !== 0) {
		return { code: "exit_code", message: `the process exited with code ${task.exitCode}` };
	}
	if (task.state === "unknown") return { code: "unknown", message: "the outcome of the task is unknown" };
	if (task.state === "failed" || task.state === "denied" || task.state === "rejected") {
		return { code: task.state, message: `the task ended ${task.state}` };
	}
	return undefined;
}

function seconds(ms: number): string {
	const value = ms / 1000;
	return Number.isInteger(value) ? `${value} s` : `${value.toFixed(1)} s`;
}

// ---- text rendering (exec and read_file) ----

/** One synthesized note line: fields inside square brackets, separated by ", " (D114). */
function noteLine(fields: readonly string[]): string {
	return `[${fields.join(", ")}]`;
}

/** `<node, exit 0>`, `<node, error <code>: <message>>`, and the waiting variants. */
function taskStatusLine(task: TaskView, label: string): string {
	if (task.timedOut) {
		const timeout = task.timeoutMs === null ? "timed out" : `timed out after ${seconds(task.timeoutMs)}`;
		return noteLine([label, timeout]);
	}
	if (task.signal !== null && task.signal !== "") return noteLine([label, `killed by ${task.signal}`]);
	if (task.state === "unknown") {
		const code = task.errorCode ?? "unknown";
		const reason = task.errorMessage === null ? "" : ` (${task.errorMessage})`;
		return noteLine([label, `error ${code}: execution failed; the outcome is unknown${reason}`]);
	}
	if (task.errorCode !== null) return noteLine([label, `error ${task.errorCode}: ${task.errorMessage ?? ""}`]);
	if (task.state === "exited") {
		const fields = [label, `exit ${task.exitCode ?? 0}`];
		if (task.cancelled) fields.push("cancelled");
		return noteLine(fields);
	}
	if (task.exitCode !== null) {
		const fields = [label, `exit ${task.exitCode}`];
		if (task.cancelled) fields.push("cancelled");
		return noteLine(fields);
	}
	if (task.state === "failed" || task.state === "denied" || task.state === "rejected") {
		const error = taskError(task);
		return noteLine([label, `error ${error?.code ?? task.state}: ${error?.message ?? ""}`]);
	}
	return noteLine([label, task.state]);
}

function isWaiting(task: TaskView): boolean {
	return task.state === "awaiting_approval" || task.state === "awaiting_authorization";
}

function isRunning(task: TaskView): boolean {
	return task.state === "dispatched" || task.state === "running";
}

/** The note of a non-final task, with the id only for background-waitable tools (exec). */
function waitingLine(task: TaskView, label: string, ctx: ToolContext, exposeId: boolean): string | undefined {
	const followUp = exposeId ? `task_id ${task.id}. Call task_wait with this task_id.` : undefined;
	if (task.state === "awaiting_approval") {
		const fields = [label, `waiting for approval: ${ctx.approvalUrl("task", task.id)}`];
		if (followUp !== undefined) fields.push(followUp);
		return noteLine(fields);
	}
	if (task.state === "awaiting_authorization") {
		const fields = [label, `waiting for authorization: ${ctx.taskUrl?.(task.id) ?? `/tasks/${task.id}`}`];
		if (followUp !== undefined) fields.push(followUp);
		return noteLine(fields);
	}
	if (isRunning(task))
		return followUp === undefined ? noteLine([label, "still running"]) : noteLine([label, "still running", followUp]);
	return undefined;
}

/** The "Showing lines X-Y of N …" hint that follows truncated exec output (D112), as its own bracketed line. */
function truncationHint(
	keptLines: number,
	totalLines: number | null,
	outputFile: string | null,
	transport: NodeTransport,
	bytesTruncated = false,
): string | undefined {
	if (totalLines === null || totalLines <= 0) return undefined;
	if (keptLines >= totalLines && !bytesTruncated) return undefined;
	if (keptLines <= 0) return "[No output was kept for this node (batch budget).]";
	const from = Math.max(1, totalLines - keptLines + 1);
	const head = `Showing lines ${from}-${totalLines} of ${totalLines}.`;
	if (outputFile) return `[${head} Full output: ${outputFile} (read it with read_file).]`;
	// Only an SSH task runs without an output file; a crha node without one lost it (e.g. after a restart).
	return transport === "ssh"
		? `[${head} This is an SSH node; no full output is kept.]`
		: `[${head} The node kept no full output.]`;
}

/** Whether the full byte count reported by the node is larger than the tail the model gets. */
function bytesTruncated(task: TaskView, text: string): boolean {
	return task.outputBytes > Buffer.byteLength(text);
}

/** crhs's own note about the task (the SSH privileged notice), bracketed on its own line (D114). */
function noticeLine(task: TaskView): string | undefined {
	if (task.notice === null || task.notice.trim() === "") return undefined;
	return task.notice
		.trim()
		.split(/\r?\n/)
		.map((line) => noteLine([line.trim()]))
		.join("\n");
}

/** Adds the task's notice as the last line of a note block. */
function withNotice(note: string, task: TaskView): string {
	const notice = noticeLine(task);
	return notice === undefined ? note : `${note}\n${notice}`;
}

function taskSourceText(task: TaskView): { text: string; keptLines: number } {
	if (task.outputTail !== "") return { text: task.outputTail, keptLines: countOutputLines(task.outputTail) };
	return { text: "", keptLines: 0 };
}

/** A single exec task as text: raw tail block plus a note with the exit status and the truncation hint. */
export function execTaskResult(
	ctx: ToolContext,
	task: TaskView,
	nodeName: string,
	transport: NodeTransport = "client",
): ToolResult {
	const details = taskDetails(task, nodeName);
	// with_output: false keeps only the status; the model gets JSON, like a status batch (D114).
	if (task.outputMode === "status") {
		return jsonResult(statusNode(ctx, task, nodeName), { isError: taskFailed(task), details });
	}
	const waiting = waitingLine(task, nodeName, ctx, true);
	if (waiting !== undefined) {
		// A long-running task still returns the output it has produced so far (doc/agent-runtime.md#exec-工具的语义).
		const { text } = taskSourceText(task);
		const note = [waiting, noticeLine(task)].filter((line): line is string => line !== undefined).join("\n");
		return textResult([{ output: text, note }], { details });
	}
	const { text, keptLines } = taskSourceText(task);
	const note = [
		taskStatusLine(task, nodeName),
		truncationHint(keptLines, task.outputLines, task.outputFile, transport, bytesTruncated(task, text)),
		noticeLine(task),
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	return textResult([{ output: text, note }], { isError: taskFailed(task), details });
}

/** The leading note of a text task group: id (unless the tool hides ids), node count, success/failure counts. */
export function groupTextNote(
	ctx: ToolContext,
	group: TaskGroupView,
	exposeId: boolean,
	counts?: { succeeded: number; failed: number },
): string {
	const succeeded =
		counts?.succeeded ?? group.tasks.filter((task) => task.state === "exited" && !taskFailed(task)).length;
	const failed = counts?.failed ?? group.tasks.filter((task) => taskFailed(task)).length;
	// A waiting group has no tasks yet but already knows its nodes: count the nodes it targets.
	const fields = [`task group${exposeId ? ` ${group.id}` : ""}`, `${group.nodeIds.length} nodes`];
	fields.push(`${succeeded} succeeded`, `${failed} failed`);
	if (group.skipped.length > 0) fields.push(`${group.skipped.length} skipped`);
	if (group.state === "awaiting_approval") {
		fields.push(`waiting for approval: ${ctx.approvalUrl("task_group", group.id)}`);
	} else if (group.state === "awaiting_authorization") {
		fields.push(`waiting for authorization: ${ctx.taskGroupUrl?.(group.id) ?? `/task-groups/${group.id}`}`);
	} else if (group.state === "running") {
		fields.push("still running");
	} else if (group.state === "interrupted" || group.state === "rejected") {
		fields.push(group.state);
	}
	if (exposeId && !GROUP_TERMINAL.has(group.state)) {
		fields.push(`task_group_id ${group.id}. Call task_wait with this task_group_id.`);
	}
	return noteLine(fields);
}

/** A task group's nodes as text: one note/raw pair per node, after the leading group note. */
function groupTextResult(
	ctx: ToolContext,
	group: TaskGroupView,
	names: Map<string, string>,
	transports?: Map<string, NodeTransport>,
): ToolResult {
	const blocks: TextBlock[] = [{ note: groupTextNote(ctx, group, true) }];
	for (const task of group.tasks) {
		const nodeName = names.get(task.nodeId) ?? task.nodeId;
		const transport = transports?.get(task.nodeId) ?? "client";
		const waiting = waitingLine(task, nodeName, ctx, false);
		if (waiting !== undefined) {
			const { text } = taskSourceText(task);
			const note = [waiting, noticeLine(task)].filter((line): line is string => line !== undefined).join("\n");
			blocks.push({ output: text, note });
			continue;
		}
		const { text, keptLines } = taskSourceText(task);
		const note = [
			taskStatusLine(task, nodeName),
			truncationHint(keptLines, task.outputLines, task.outputFile, transport, bytesTruncated(task, text)),
			noticeLine(task),
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
		blocks.push({ output: text, note });
	}
	return textResult(blocks, { isError: groupFailed(group), details: groupDetails(group, names) });
}

// ---- exec status (JSON) ----

/** One node of an exec status group: status, exit and the full output file. */
function statusNode(ctx: ToolContext, task: TaskView, nodeName: string): Record<string, unknown> {
	const out = taskDetails(task, nodeName);
	if (task.notice !== null) out.notice = task.notice;
	if (task.outputFile) {
		out.output_file = task.outputFile;
		out.note = "full output is on the node; read it with read_file";
	} else if (isRunning(task)) {
		out.next = "still running: call task_wait with this task_id";
	} else if (task.exitCode !== null || task.signal !== null) {
		out.note = "no output file was reported; SSH nodes keep no output";
	}
	void ctx;
	return out;
}

function execGroupStatusResult(ctx: ToolContext, group: TaskGroupView, names: Map<string, string>): ToolResult {
	const value: Record<string, unknown> = { task_group_id: group.id, state: group.state };
	if (group.privileged) value.privileged = true;
	if (group.state === "awaiting_approval") {
		value.approval = {
			status: "waiting for the user's approval",
			url: ctx.approvalUrl("task_group", group.id),
			next: "call task_wait with this task_group_id to keep waiting",
		};
	}
	if (group.state === "awaiting_authorization") {
		const waiting = group.tasks.filter((task) => task.state === "awaiting_authorization");
		value.authorization = {
			status: "waiting for the authorization of the task group's owner",
			url: ctx.taskGroupUrl?.(group.id) ?? `/task-groups/${group.id}`,
			nodes: waiting.map((task) => names.get(task.nodeId) ?? task.nodeId),
			tasks: waiting.map((task) => ({
				task_id: task.id,
				node: names.get(task.nodeId) ?? task.nodeId,
				...(ctx.taskUrl ? { url: ctx.taskUrl(task.id) } : {}),
			})),
			next: "the owner signs once for the whole group in the WebUI; call task_wait with this task_group_id to keep waiting",
		};
	}
	value.nodes = group.tasks.map((task) => statusNode(ctx, task, names.get(task.nodeId) ?? task.nodeId));
	if (group.skipped.length > 0) value.skipped = group.skipped.map((id) => names.get(id) ?? id);
	if (group.state === "running") value.next = "still running: call task_wait with this task_group_id";
	return jsonResult(value, { isError: groupFailed(group), details: groupDetails(group, names) });
}

/**
 * A started exec call as the model sees it: a single task is text, a group follows its `output` mode
 * (`status` JSON by default, `text` otherwise).
 */
export function execResult(ctx: ToolContext, started: Started): ToolResult {
	if (started.kind === "task") return execTaskResult(ctx, started.task, started.nodeName, started.transport);
	const { taskGroup, names, transports } = started;
	return taskGroup.outputMode === "text"
		? groupTextResult(ctx, taskGroup, names, transports)
		: execGroupStatusResult(ctx, taskGroup, names);
}

// ---- file results (JSON for everything but read_file) ----

/** The fields of a task's structured result in their snake_case JSON form (doc/protocol.md TaskResult). */
function resultFields(result: JsonTaskResult): Record<string, unknown> {
	switch (result.kind) {
		case "file.read":
			return {
				...(result.from > 0 ? { lines: { from: result.from, to: result.to } } : {}),
				...(result.total === null ? {} : { total: result.total }),
				...(result.tooLong ? { too_long: true } : {}),
			};
		case "file.stat":
			return {
				path: result.path,
				type: result.type,
				size: result.size,
				mode: result.mode,
				uid: result.uid,
				gid: result.gid,
				owner: result.owner,
				group: result.group,
				mtime: result.mtime,
				...(result.linkTarget === null ? {} : { link_target: result.linkTarget }),
			};
		case "file.list":
			return { entries: result.entries, truncated: result.truncated };
		case "file.write":
			return { bytes: result.bytes, created: result.created };
		case "file.edit":
			return { replacements: result.replacements };
	}
}

/** One file task as a JSON object (no task id: the model does not get one for blocking file tools). */
function fileNode(task: TaskView, nodeName: string): Record<string, unknown> {
	const out: Record<string, unknown> = { node: nodeName, state: task.state };
	if (task.privileged) out.privileged = true;
	if (task.exitCode !== null) out.exit_code = task.exitCode;
	if (task.signal !== null) out.signal = task.signal;
	if (task.timedOut) out.timed_out = true;
	if (task.cancelled) out.cancelled = true;
	if (task.result !== null) Object.assign(out, resultFields(task.result));
	// crhs's own line (the SSH privileged notice) is not part of the output (D114).
	if (task.notice !== null) out.notice = task.notice;
	const error = taskError(task);
	if (error !== undefined) out.error = error;
	return out;
}

/** A single blocking file task as JSON; a failure is the bare `{"error": …}` (D112). */
export function fileJsonResult(ctx: ToolContext, task: TaskView, nodeName: string): ToolResult {
	const details = taskDetails(task, nodeName);
	const error = taskError(task);
	if (error !== undefined) return jsonResult({ error }, { isError: true, details });
	const out: Record<string, unknown> = { node: nodeName, state: task.state };
	if (task.result !== null) Object.assign(out, resultFields(task.result));
	if (task.notice !== null) out.notice = task.notice;
	void ctx;
	return jsonResult(out, { details });
}

/** A blocking file task group as JSON: one object per node, `isError` if any failed. */
export function fileJsonGroupResult(ctx: ToolContext, group: TaskGroupView, names: Map<string, string>): ToolResult {
	const value: Record<string, unknown> = {
		state: group.state,
		nodes: group.tasks.map((task) => fileNode(task, names.get(task.nodeId) ?? task.nodeId)),
	};
	if (group.skipped.length > 0) value.skipped = group.skipped.map((id) => names.get(id) ?? id);
	void ctx;
	return jsonResult(value, { isError: groupFailed(group), details: groupDetails(group, names) });
}

// ---- read_file ----

/** The page one file.read task reports as its result (doc/protocol.md TaskResult). */
type PageResult = Extract<JsonTaskResult, { kind: "file.read" }>;

const PAGE_TOO_LONG = "line_too_long";
const PAGE_OUT_OF_RANGE = "offset_out_of_range";
const PAGE_MISSING = "invalid_result";

/** The page a file.read task reported as its result; undefined when it reported none. */
function pageResultOf(result: JsonTaskResult | null): PageResult | undefined {
	return result?.kind === "file.read" ? result : undefined;
}

/** A path as one shell word, for a hint the model may paste into exec. */
function quoted(path: string): string {
	return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Why the read cannot show its page, in the words the model gets. */
function pageVerdict(page: PageResult): "page" | "empty" | "too-long" | "out-of-range" {
	if (page.tooLong) return "too-long";
	if (page.from === 0) return page.eof && page.total === 0 ? "empty" : "out-of-range";
	return "page";
}

function pageFailure(page: PageResult, startLine: number, path: string): { code: string; message: string } | undefined {
	switch (pageVerdict(page)) {
		case "too-long":
			return {
				code: PAGE_TOO_LONG,
				message:
					`line ${startLine} alone is longer than the 50 KB a page keeps; read it with exec, for ` +
					`example sed -n '${startLine}p' ${quoted(path)} | head -c ${MAX_OUTPUT_BYTES}`,
			};
		case "out-of-range":
			return {
				code: PAGE_OUT_OF_RANGE,
				message: `the file ${path} has ${page.total ?? 0} lines; line ${startLine} is past its end`,
			};
		default:
			return undefined;
	}
}

/** The bytes of `text` up to its last complete line; a budget cut can leave a partial last line. */
function completeLines(text: string): string {
	const nl = text.lastIndexOf("\n");
	return nl < 0 ? "" : text.slice(0, nl + 1);
}

/** Bytes the page kept, cut at `maxBytes` on a character boundary; whether anything was cut. */
function cutToBytes(text: string, maxBytes: number | undefined): { text: string; cut: boolean } {
	if (maxBytes === undefined) return { text, cut: false };
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return { text, cut: false };
	return {
		text: bytes
			.subarray(0, maxBytes)
			.toString("utf8")
			.replace(/\uFFFD+$/, ""),
		cut: true,
	};
}

interface PageRead {
	output: string;
	note: string;
	error?: { code: string; message: string };
}

/**
 * Reads one node's page: the page bytes exactly as the file has them, the line range, and — when the page
 * reached the end of the file — the file's line count. A budget cut continues at its last whole line; the
 * total is never reported for a page that did not reach the end (doc/agent-runtime.md#交给模型的输出d112).
 */
function readPage(
	ctx: ToolContext,
	task: TaskView,
	label: string,
	path: string,
	startLine: number,
	maxBytes: number | undefined,
): PageRead {
	if (isWaiting(task) || isRunning(task)) {
		return { output: "", note: waitingLine(task, label, ctx, false) ?? taskStatusLine(task, label) };
	}
	if (task.state !== "exited" || task.errorCode !== null) {
		const status = taskStatusLine(task, label);
		return { output: "", note: status, ...(taskError(task) ? { error: taskError(task) } : {}) };
	}
	const page = pageResultOf(task.result);
	if (!page) {
		const error = { code: PAGE_MISSING, message: "the node reported no file.read result" };
		return { output: "", note: noteLine([label, `error ${error.code}: ${error.message}`]), error };
	}
	const failure = pageFailure(page, startLine, path);
	if (failure) {
		return { output: "", note: noteLine([label, `error ${failure.code}: ${failure.message}`]), error: failure };
	}
	if (page.from === 0) return { output: "", note: noteLine([label, "the file is empty"]) };

	// The page may be cut by the per-node byte budget (single task `max_bytes`, or a batch node's grant).
	// A batch head that dropped its whole grant, or cut it mid-line, is finished at its last whole line.
	if (task.outputBytes > 0 && task.outputHead === "" && page.to >= page.from) {
		return {
			output: "",
			note: noteLine([label, "no page was kept for this node (batch budget); read it on its own"]),
		};
	}
	const available = task.outputHead;
	const cut = cutToBytes(available, maxBytes);
	const whole = !cut.cut && task.outputBytes > 0 && Buffer.byteLength(available) >= task.outputBytes;
	const output = whole ? available : completeLines(cut.text);
	const keptLines = whole ? page.to - page.from + 1 : countOutputLines(output);
	if (keptLines === 0) {
		const error = {
			code: PAGE_TOO_LONG,
			message:
				maxBytes === undefined
					? "no whole line was kept for this node (batch budget); read it on its own"
					: "no whole line fits in max_bytes; increase max_bytes or use a smaller offset",
		};
		return { output: "", note: noteLine([label, `error ${error.code}: ${error.message}`]), error };
	}
	const to = page.from + keptLines - 1;
	const more = !page.eof || to < page.to;
	const note = more
		? noteLine([label, `lines ${page.from}-${to}. Use offset=${to + 1} to continue.`])
		: noteLine([label, `lines ${page.from}-${to}${page.total === null ? "" : ` of ${page.total}`} (end of file)`]);
	return { output, note };
}

/** A single read_file page as text (raw page plus note). */
export function readTaskResult(
	ctx: ToolContext,
	task: TaskView,
	nodeName: string,
	path: string,
	startLine: number,
	maxBytes: number | undefined,
): ToolResult {
	const details = taskDetails(task, nodeName);
	const page = readPage(ctx, task, `${nodeName}:${path}`, path, startLine, maxBytes);
	return textResult([{ output: page.output, note: withNotice(page.note, task) }], {
		isError: taskFailed(task) || page.error !== undefined,
		details,
	});
}

/** The same file on several nodes: a leading group note, then each node's page and note. */
export function readGroupResult(
	ctx: ToolContext,
	group: TaskGroupView,
	names: Map<string, string>,
	path: string,
	startLine: number,
	maxBytes: number | undefined,
): ToolResult {
	const pages = group.tasks.map((task) => {
		const nodeName = names.get(task.nodeId) ?? task.nodeId;
		return { task, page: readPage(ctx, task, `${nodeName}:${path}`, path, startLine, maxBytes) };
	});
	const failedPages = pages.filter(({ task, page }) => taskFailed(task) || page.error !== undefined).length;
	const blocks: TextBlock[] = [
		{
			note: groupTextNote(ctx, group, false, {
				succeeded: pages.length - failedPages,
				failed: failedPages,
			}),
		},
	];
	for (const { task, page } of pages) blocks.push({ output: page.output, note: withNotice(page.note, task) });
	return textResult(blocks, {
		isError: groupFailed(group) || failedPages > 0,
		details: groupDetails(group, names),
	});
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
