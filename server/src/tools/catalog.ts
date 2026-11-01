import { FILE_READ_MAX_BYTES, type JsonTaskResult, type TaskSpec } from "@crh/protocol";
import { sql } from "kysely";
import * as z from "zod/v4";
import type { SessionUser } from "../auth/sessions.ts";
import type { TaskAuthorizationRecord } from "../cluster/authorization.ts";
import { type Actor, type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { getNode, listNodesForUser } from "../cluster/nodes.ts";
import { resolveTargets, type TaskGroups, type TaskGroupView } from "../cluster/task-groups.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";
import { derivedId } from "../util/id.ts";

/**
 * The cluster tools, defined once and adapted to MCP (now) and to agent sessions (M3); see
 * doc/agent-runtime.md#cluster-工具. Handlers return plain JSON-able values.
 */

export interface ToolContext {
	db: Db;
	cluster: Cluster;
	groups: TaskGroups;
	/** The user the caller acts for; node access is theirs. */
	user: SessionUser;
	actor: Actor;
	/** The caller's rule chain, root first. */
	chain: RuleRef[];
	/** Where the user approves a waiting task or task group in the WebUI. */
	approvalUrl: (kind: "task" | "task_group", id: string) => string;
	/** Where the owner sees a waiting task's authorization payload in the WebUI (absolute for MCP). */
	taskUrl?: (id: string) => string;
	/** The task-group page, where a waiting group is signed (absolute for MCP). */
	groupUrl?: (id: string) => string;
	signal?: AbortSignal;
	/** Stable per tool call: tasks get ids derived from it, so a rerun after a crash reattaches to them. */
	callKey?: string;
	/** Seconds a call waits for its result when the caller gives no `wait` (MCP: 30; agents: 600). */
	defaultWaitS?: number;
	/** Agents keep waiting while a task waits for approval (MCP returns and follows up with task_wait). */
	waitThroughApproval?: boolean;
	/** Progress for a UI, e.g. "waiting for approval". */
	onStatus?: (status: Record<string, unknown>) => Promise<void>;
}

/** setTimeout cannot wait longer than ~24.8 days, so long waits loop. */
const HOUR = 3_600_000;

async function waitTaskFor(ctx: ToolContext, id: string, waitMs: number): Promise<TaskView | undefined> {
	// The WebUI follows a tool call that has no result by the id its statuses publish (doc/webui.md#工具卡片),
	// so the first status carries it before any wait can block. MCP callers pass no `onStatus`, so they pay no read.
	if (!ctx.waitThroughApproval) {
		if (ctx.onStatus !== undefined) {
			const first = await ctx.cluster.getTask(id);
			await ctx.onStatus({ task_id: id, state: first?.state });
		}
		return ctx.cluster.waitTask(id, waitMs, ctx.signal);
	}
	// A waiting task is not final, so waitTask would sit through the whole wait: look first. Shutdown ends
	// the waits, and then these loops must stop rather than re-enter waitTask on the same state.
	let t = await ctx.cluster.getTask(id);
	await ctx.onStatus?.({ task_id: id, state: t?.state });
	if (t?.state === "awaiting_approval") {
		await ctx.onStatus?.({ task_id: id, state: "awaiting_approval", approval_url: ctx.approvalUrl("task", id) });
		while (t?.state === "awaiting_approval" && !ctx.signal?.aborted && !ctx.cluster.waitsEnded) {
			await new Promise((r) => setTimeout(r, 1000));
			t = await ctx.cluster.getTask(id);
		}
		await ctx.onStatus?.({ task_id: id, state: t?.state });
	}
	if (t?.state === "awaiting_authorization") {
		// The owner signs in the WebUI or with `crha grant`; the task has no automatic timeout.
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

async function waitGroupFor(ctx: ToolContext, id: string, waitMs: number): Promise<TaskGroupView> {
	// As in waitTaskFor: the id goes out before the wait, so a card without a result can follow the group.
	if (!ctx.waitThroughApproval) {
		if (ctx.onStatus !== undefined) {
			const first = (await ctx.groups.get(id)) as TaskGroupView | undefined;
			await ctx.onStatus({ task_group_id: id, state: first?.state });
		}
		return (await ctx.groups.wait(id, waitMs)) as TaskGroupView;
	}
	let g = (await ctx.groups.get(id)) as TaskGroupView;
	await ctx.onStatus?.({ task_group_id: id, state: g.state });
	if (g.state === "awaiting_approval") {
		await ctx.onStatus?.({
			task_group_id: id,
			state: "awaiting_approval",
			approval_url: ctx.approvalUrl("task_group", id),
		});
		while (g.state === "awaiting_approval" && !ctx.signal?.aborted && !ctx.groups.waitsEnded)
			g = (await ctx.groups.wait(id, HOUR, ctx.signal)) as TaskGroupView;
		await ctx.onStatus?.({ task_group_id: id, state: g.state });
	}
	if (g.state === "awaiting_authorization") {
		await ctx.onStatus?.({
			task_group_id: id,
			state: "awaiting_authorization",
			authorization_url: ctx.groupUrl?.(id) ?? `/task-groups/${id}`,
		});
		while (g.state === "awaiting_authorization" && !ctx.signal?.aborted && !ctx.groups.waitsEnded)
			g = (await ctx.groups.wait(id, HOUR, ctx.signal)) as TaskGroupView;
		await ctx.onStatus?.({ task_group_id: id, state: g.state });
	}
	return ctx.signal?.aborted ? g : ((await ctx.groups.wait(id, waitMs, ctx.signal)) as TaskGroupView);
}

export interface ClusterTool<S extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	input: S;
	readOnly: boolean;
	handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 600;
/** Output given back per call, as pi's tools do: the tail, at most this many bytes and lines. */
const OUTPUT_BYTES = 50 * 1024;
const OUTPUT_LINES = 2000;

const nodeField = z.string().describe("Node name or id");
const targetsField = z
	.array(z.string())
	.min(1)
	.describe(
		'What to act on: node names or ids, and "group:<name>". Exactly one node name runs one task and ' +
			"returns its result; several entries, or any group entry, run a task group and return one result " +
			"per node",
	);
const waitField = z
	.number()
	.int()
	.min(0)
	.max(MAX_WAIT_S)
	.optional()
	.describe("Seconds to wait for the result; after that the task keeps running and task_wait follows it up");
const privilegedField = z
	.boolean()
	.optional()
	.describe(
		"Run with elevated privileges according to the node's privileged mode (forward, native, ignore or " +
			"reject); SSH nodes ignore it and run as the SSH user",
	);
/** The batch parameters; a single task ignores them (doc/agent-runtime.md#批量执行). */
const batchFields = {
	parallel: z.number().int().min(1).max(100).optional().describe("Batch only: nodes run at once (default 10)"),
	fail_fast: z.boolean().optional().describe("Batch only: start no more nodes after one fails"),
};
const outputField = z
	.enum(["status", "text"])
	.optional()
	.describe(
		"Batch only, default status: status returns just each node's exit status and the path of its full " +
			"output file on the node, which you can read with read_file; text returns the end of each node's " +
			"output within one budget shared by the batch",
	);

/** Keeps the last OUTPUT_BYTES / OUTPUT_LINES of a stream. */
export function tailOf(text: string): { text: string; truncated: boolean } {
	let out = text;
	let truncated = false;
	const lines = out.split("\n");
	if (lines.length > OUTPUT_LINES + 1) {
		out = lines.slice(-OUTPUT_LINES - 1).join("\n");
		truncated = true;
	}
	const bytes = Buffer.from(out);
	if (bytes.length > OUTPUT_BYTES) {
		out = bytes
			.subarray(bytes.length - OUTPUT_BYTES)
			.toString("utf8")
			.replace(/^�+/, "");
		truncated = true;
	}
	return { text: out, truncated };
}

function streamOf(head: string, tail: string, bytes: number): { text: string; truncated: boolean } {
	// crhs keeps the first and last 50 KB; when they cover everything, head is the whole stream.
	const whole = Buffer.byteLength(head) >= bytes;
	const r = tailOf(whole ? head : tail);
	return { text: r.text, truncated: r.truncated || !whole };
}

/** A task as the model sees it. */
export function taskResult(t: TaskView, nodeName: string, ctx: ToolContext): Record<string, unknown> {
	const out: Record<string, unknown> = { task_id: t.id, node: nodeName, state: t.state };
	if (t.privileged) out.privileged = true;
	if (t.state === "awaiting_approval") {
		out.approval = {
			status: "waiting for the user's approval",
			url: ctx.approvalUrl("task", t.id),
			next: "call task_wait with this task_id to keep waiting",
		};
		return out;
	}
	if (t.state === "awaiting_authorization") {
		out.authorization = authorizationResult(t.authorization, ctx, t.id);
		out.next = "call task_wait with this task_id to keep waiting";
		return out;
	}
	if (t.exitCode !== null) out.exit_code = t.exitCode;
	if (t.signal) out.signal = t.signal;
	if (t.timedOut) out.timed_out = true;
	if (t.cancelled) out.cancelled = true;
	if (t.errorCode) out.error = { code: t.errorCode, message: t.errorMessage };
	// Denied or rejected before running: there is no output to show.
	if ((t.state === "denied" || t.state === "rejected") && t.stdoutBytes === 0 && t.stderrBytes === 0) return out;
	// A file operation reports structured data instead of text: the model gets its fields, not a JSON
	// string in an output stream (doc/protocol.md TaskResult).
	if (t.result !== null) Object.assign(out, resultFields(t.result));
	if (t.outputMode === "head") {
		// A file operation: the group's budget let this node keep the head of its page. The only
		// stderr crhs keeps for one is its own line (the SSH privileged notice, doc/execution-plane.md#ssh-传输).
		if (t.stderrHead) out.notice = t.stderrHead;
		if (t.stdoutHead !== "") out.output = t.stdoutHead;
		if (t.stdoutBytes > Buffer.byteLength(t.stdoutHead)) {
			out.truncated = { note: "only the head is shown; ask for less on this node to see the rest" };
		}
		if (t.state === "dispatched" || t.state === "running") out.next = "still running: call task_wait with this task_id";
		return out;
	}
	if (t.outputMode === "text") {
		// The group's budget let this node keep one combined tail (stdout and stderr in arrival order).
		out.output = t.stdoutTail;
		if (t.stdoutBytes + t.stderrBytes > Buffer.byteLength(t.stdoutTail)) {
			out.truncated = {
				stdout_bytes: t.stdoutBytes,
				stderr_bytes: t.stderrBytes,
				note: t.outputFile
					? `only the end is shown; the full output is in ${t.outputFile} on the node (read it with read_file)`
					: "only the end is shown",
			};
		}
		if (t.state === "dispatched" || t.state === "running") out.next = "still running: call task_wait with this task_id";
		return out;
	}
	if (t.outputMode === "status") {
		// crhs keeps one line of its own in stderr_head (the SSH privileged notice) even though a
		// status task pushes no output (doc/execution-plane.md#ssh-传输).
		if (t.stderrHead) out.notice = t.stderrHead;
		// Nothing was pushed to crhs: only the node's output file has the output (SSH keeps none).
		if (t.outputFile) {
			out.output_file = t.outputFile;
			out.note = "full output is on the node; read it with read_file";
		} else if (t.state === "dispatched" || t.state === "running") {
			out.next = "still running: call task_wait with this task_id";
		} else if (t.exitCode !== null || t.signal !== null) {
			// Only a task that actually ran has output on the node (SSH keeps none).
			out.note = "no output file was reported; SSH nodes keep no output";
		}
		return out;
	}
	const stdout = streamOf(t.stdoutHead, t.stdoutTail, t.stdoutBytes);
	const stderr = streamOf(t.stderrHead, t.stderrTail, t.stderrBytes);
	out.stdout = stdout.text;
	if (stderr.text) out.stderr = stderr.text;
	if (stdout.truncated || stderr.truncated) {
		out.truncated = {
			stdout_bytes: t.stdoutBytes,
			stderr_bytes: t.stderrBytes,
			note: t.outputFile
				? `only the end is shown; the full output is in ${t.outputFile} on the node (read it with read_file)`
				: "only the end is shown",
		};
	}
	if (t.state === "dispatched" || t.state === "running") out.next = "still running: call task_wait with this task_id";
	return out;
}

/** The fields of a task's structured result as the model sees them (doc/protocol.md TaskResult). */
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

async function nodeNames(ctx: ToolContext, ids: string[]): Promise<Map<string, string>> {
	const nodes = await listNodesForUser(ctx.db, ctx.user);
	return new Map(nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, n.name]));
}

/** The sessions below `sessionId`; their tasks are the only other ones its tools may act on. */
function descendantsOf(sessionId: string) {
	return sql<{ id: string }>`
		with recursive subtree(id) as (
			select id from sessions where parent_session_id = ${sessionId}
			union all
			select child.id from sessions as child join subtree on child.parent_session_id = subtree.id
		)
		select id from subtree
	`;
}

/**
 * Whether the caller may act on work started for `actorType` / `actorId` (doc/agent-runtime.md#cluster-工具,
 * doc/access-control.md#操作者): its own session or token, or a session in its subtree. Anything else, even
 * another session of the same user, is out of reach; the conservative reading, because the docs scope a tool
 * to the caller's own work.
 */
async function mayActFor(ctx: ToolContext, actorType: string, actorId: string): Promise<boolean> {
	if (ctx.actor.type === actorType && ctx.actor.id === actorId) return true;
	// Only a session has a subtree; an API token's own tasks are the only ones it may touch.
	if (ctx.actor.type !== "session" && ctx.actor.type !== "subagent") return false;
	if (actorType !== "session" && actorType !== "subagent") return false;
	const { rows } = await descendantsOf(ctx.actor.id).execute(ctx.db);
	return rows.some((row) => row.id === actorId);
}

/**
 * The authorization plan of a waiting task, for the model (doc/m4.md#crhs-侧数据). The owner has to
 * act: sign in the WebUI or, when a local path is planned, run `crha approve` on the node.
 */
function authorizationResult(
	record: TaskAuthorizationRecord | null,
	ctx: ToolContext,
	taskId: string,
): Record<string, unknown> {
	const url = ctx.taskUrl?.(taskId) ?? `/tasks/${taskId}`;
	const local = record?.plan.paths.some((path) => path.path === "local") ?? false;
	const next = `the task owner must authorize it in the WebUI (${url})${
		local ? `, or run "crha approve ${taskId}" on the node` : ""
	}`;
	if (!record) return { status: "waiting for the owner's authorization", url, next };
	return {
		status: "waiting for the owner's authorization",
		attempt: record.attempt,
		paths: record.plan.paths.map((path) => `${path.path}: ${path.entries.map((entry) => entry.name).join(", ")}`),
		...(record.plan.reason === undefined ? {} : { reason: record.plan.reason }),
		...(record.lastRejection === null
			? {}
			: {
					last_rejection: {
						code: record.lastRejection.code,
						message: record.lastRejection.message,
						attempt: record.lastRejection.attempt,
					},
				}),
		url,
		next,
	};
}

function groupResult(
	g: TaskGroupView,
	names: Map<string, string>,
	ctx: ToolContext,
	render: (task: TaskView, nodeName: string) => Record<string, unknown> = (task, nodeName) =>
		taskResult(task, nodeName, ctx),
): Record<string, unknown> {
	const out: Record<string, unknown> = { task_group_id: g.id, state: g.state };
	if (g.privileged) out.privileged = true;
	if (g.state === "awaiting_approval") {
		out.approval = {
			status: "waiting for the user's approval",
			url: ctx.approvalUrl("task_group", g.id),
			next: "call task_wait with this task_group_id to keep waiting",
		};
	}
	if (g.state === "awaiting_authorization") {
		// Only the nodes whose task waits for a signature; the others may have finished already.
		const waiting = g.tasks.filter((t) => t.state === "awaiting_authorization");
		out.authorization = {
			status: "waiting for the authorization of the task group's owner",
			url: ctx.groupUrl?.(g.id) ?? `/task-groups/${g.id}`,
			nodes: waiting.map((t) => names.get(t.nodeId) ?? t.nodeId),
			tasks: waiting.map((t) => ({
				task_id: t.id,
				node: names.get(t.nodeId) ?? t.nodeId,
				...(ctx.taskUrl ? { url: ctx.taskUrl(t.id) } : {}),
			})),
			next: "the owner signs once for the whole group in the WebUI; call task_wait with this task_group_id to keep waiting",
		};
	}
	// The group budget already decided how much each node keeps (doc/execution-plane.md#输出); no second cut.
	out.nodes = g.tasks.map((t) => render(t, names.get(t.nodeId) ?? t.nodeId));
	if (g.skipped.length > 0) out.skipped = g.skipped.map((id) => names.get(id) ?? id);
	if (g.state === "running") out.next = "still running: call task_wait with this task_group_id";
	return out;
}

/** The targets of one call: exactly one node name is one task; anything else is a task group. */
interface RunTargets {
	targets: string[];
	wait?: number;
	timeout?: number;
	parallel?: number;
	fail_fast?: boolean;
	output?: "status" | "text";
	privileged?: boolean;
}

/** Whether the input names one node: a single entry that is not a group (doc/agent-runtime.md#批量执行). */
function oneNode(targets: string[]): boolean {
	return targets.length === 1 && !(targets[0] as string).startsWith("group:");
}

/** A started call: one task, or a task group whose result has one entry per node. */
type Started =
	| { kind: "task"; task: TaskView; nodeName: string }
	| { kind: "group"; group: TaskGroupView; names: Map<string, string> };

/** Starts one task on one node and waits up to `wait` seconds. */
async function startOne(
	ctx: ToolContext,
	node: string,
	args: { wait?: number; timeout?: number; privileged?: boolean },
	spec: TaskSpec,
	input?: Uint8Array,
): Promise<{ task: TaskView; nodeName: string }> {
	const waitMs = (args.wait ?? ctx.defaultWaitS ?? DEFAULT_WAIT_S) * 1000;
	const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;
	const nodeIds = await resolveTargets(ctx.db, ctx.user, [node]);
	if (nodeIds.length !== 1) {
		// A group used as a node would pick one arbitrary member: say so instead.
		throw new UserError(`${node} matches ${nodeIds.length} nodes; this tool runs on one node. Name one node.`);
	}
	const nodeId = nodeIds[0] as string;
	// The task id is derived from the call, so a rerun after a restart reattaches to the same task.
	const id = ctx.callKey ? derivedId(`task:${ctx.callKey}`) : undefined;
	const created = await ctx.cluster.createTask({
		nodeId,
		spec,
		input,
		timeoutMs,
		actor: ctx.actor,
		chain: ctx.chain,
		privileged: args.privileged === true,
		...(id ? { id } : {}),
	});
	const task = (await waitTaskFor(ctx, created.id, waitMs)) ?? created;
	const names = await nodeNames(ctx, [nodeId]);
	return { task, nodeName: names.get(nodeId) ?? node };
}

/**
 * Starts a spec and waits up to `wait` seconds. The shape follows the input, never how many nodes it
 * resolves to: one node name runs one task, several entries or a group run a task group
 * (doc/agent-runtime.md#批量执行).
 */
async function start(ctx: ToolContext, args: RunTargets, spec: TaskSpec, input?: Uint8Array): Promise<Started> {
	const common = { spec, input, actor: ctx.actor, chain: ctx.chain, privileged: args.privileged === true };
	if (oneNode(args.targets)) {
		return { kind: "task", ...(await startOne(ctx, args.targets[0] as string, args, spec, input)) };
	}
	const waitMs = (args.wait ?? ctx.defaultWaitS ?? DEFAULT_WAIT_S) * 1000;
	const nodeIds = await resolveTargets(ctx.db, ctx.user, args.targets);
	const id = await ctx.groups.create({
		...common,
		targets: args.targets,
		nodeIds,
		// An exec group chooses text or status; a file operation always keeps each node's head.
		outputMode: args.output,
		parallel: args.parallel,
		failFast: args.fail_fast,
		...(ctx.callKey ? { id: derivedId(`group:${ctx.callKey}`) } : {}),
	});
	const group = await waitGroupFor(ctx, id, waitMs);
	return { kind: "group", group, names: await nodeNames(ctx, nodeIds) };
}

/** Runs a spec and renders the task or task group the way every tool but read_file does. */
async function run(ctx: ToolContext, args: RunTargets, spec: TaskSpec, input?: Uint8Array): Promise<unknown> {
	const started = await start(ctx, args, spec, input);
	return started.kind === "task"
		? taskResult(started.task, started.nodeName, ctx)
		: groupResult(started.group, started.names, ctx);
}

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
					`example sed -n '${startLine}p' ${quoted(path)} | head -c ${FILE_READ_MAX_BYTES}`,
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

/**
 * Reads `path` on one node: the page's exact bytes, the lines it holds, the file's line count when the
 * page reached its end, and the offset that continues it (doc/agent-runtime.md#默认值).
 */
async function readOnNode(
	ctx: ToolContext,
	task: TaskView,
	nodeName: string,
	path: string,
	startLine: number,
): Promise<Record<string, unknown>> {
	// A read that failed (or is still waiting) is reported as the task, not as file content.
	if (task.state !== "exited" || task.errorCode) return taskResult(task, nodeName, ctx);
	const page = pageResultOf(task.result);
	if (!page) throw new UserError("the node reported no file.read result; run it again");
	const failure = pageFailure(page, startLine, path);
	if (failure) throw new UserError(failure.message);
	const out: Record<string, unknown> = {
		task_id: task.id,
		node: nodeName,
		path,
		state: task.state,
		// The bytes are the page itself, its last line's newline included (or absent) as in the file.
		stdout: task.stdoutHead,
	};
	if (task.privileged) out.privileged = true;
	if (page.from > 0) out.lines = { from: page.from, to: page.to };
	if (page.eof && page.total !== null) out.total = page.total;
	// An empty page here can only be an empty file: a start line past the end threw above.
	if (page.from === 0) out.note = "the file is empty";
	else if (!page.eof) out.truncated = { note: `Use offset=${page.to + 1} to continue.` };
	return out;
}

/** The bytes of `text` up to its last complete line; a batch cuts a page wherever its budget ends. */
function completeLines(text: string): string {
	const nl = text.lastIndexOf("\n");
	return nl < 0 ? "" : text.slice(0, nl + 1);
}

/**
 * The batch result of one node's read: the head its budget kept, the lines it holds and the offset
 * that continues it. Each node has its own page, so those offsets are per node
 * (doc/agent-runtime.md#批量执行).
 */
function readHeadResult(
	ctx: ToolContext,
	task: TaskView,
	nodeName: string,
	path: string,
	startLine: number,
): Record<string, unknown> {
	if (task.state !== "exited" || task.errorCode) return taskResult(task, nodeName, ctx);
	const page = pageResultOf(task.result);
	const base: Record<string, unknown> = { task_id: task.id, node: nodeName, path, state: task.state };
	if (task.privileged) base.privileged = true;
	if (!page) {
		base.error = { code: PAGE_MISSING, message: "the node reported no file.read result" };
		return base;
	}
	const failure = pageFailure(page, startLine, path);
	if (failure) {
		base.error = failure;
		return base;
	}
	if (page.from === 0) {
		base.note = "the file is empty";
		return base;
	}
	// The budget keeps a head of the page; a cut is finished at the last whole line it holds.
	const whole = task.stdoutBytes <= Buffer.byteLength(task.stdoutHead);
	const stdout = whole ? task.stdoutHead : completeLines(task.stdoutHead);
	const kept = whole ? page.to - page.from + 1 : (stdout.match(/\n/g) ?? []).length;
	if (kept === 0) {
		base.note = `the batch budget kept less than one whole line for this node; read it on its own with targets: [${JSON.stringify(nodeName)}]`;
		return base;
	}
	const to = page.from + kept - 1;
	base.stdout = stdout;
	base.lines = { from: page.from, to };
	const more = !page.eof || to < page.to;
	if (more) base.truncated = { note: `Use offset=${to + 1} to continue.` };
	else if (page.total !== null) base.total = page.total;
	return base;
}

/** The same file on several nodes: one entry per node, each page under the group's output budget. */
function readGroup(
	ctx: ToolContext,
	group: TaskGroupView,
	names: Map<string, string>,
	path: string,
	startLine: number,
): Record<string, unknown> {
	return groupResult(group, names, ctx, (task, nodeName) => readHeadResult(ctx, task, nodeName, path, startLine));
}

function define<S extends z.ZodType>(tool: ClusterTool<S>): ClusterTool<S> {
	return tool;
}

const listNodes = define({
	name: "list_nodes",
	description:
		"List the nodes you can use (your own and those shared with you), with their groups, status and whether " +
		"you may run tasks on them.",
	input: z.object({}),
	readOnly: true,
	handler: async (_args, ctx) => {
		const nodes = await listNodesForUser(ctx.db, ctx.user);
		return {
			nodes: nodes.map((n) => ({
				name: n.name,
				id: n.id,
				status: n.status,
				transport: n.transport,
				connected: n.transport === "ssh" ? undefined : ctx.cluster.isConnected(n.id),
				groups: n.groups,
				hostname: n.hostname,
				os: n.facts?.osPrettyName ?? n.facts?.osId,
				can_run_tasks: n.access !== "view" && n.status === "active",
			})),
		};
	},
});

/** Node notes shown by node_info are cut here; read_file gives the rest (doc/agent-runtime.md#节点笔记). */
const NOTES_BYTES = 8 * 1024;

/**
 * The node's notes file, read through an ordinary (audited) file.read task, but only when the rules allow
 * that read outright: node_info never leaves an approval request behind.
 */
async function readNotes(ctx: ToolContext, nodeId: string, path: string): Promise<Record<string, unknown>> {
	const node = await getNode(ctx.db, nodeId);
	if (node?.status !== "active") return { path, content: null, note: "the node is not active" };
	const spec: TaskSpec = { kind: "file.read", path, startLine: 1, lineCount: OUTPUT_LINES };
	if ((await ctx.cluster.evaluateFor(node, spec, ctx.chain, false)).result !== "allow") {
		return { path, content: null, note: "reading it needs approval here; use read_file" };
	}
	const id = ctx.callKey ? derivedId(`notes:${ctx.callKey}`) : undefined;
	const created = await ctx.cluster.createTask({
		nodeId,
		spec,
		actor: ctx.actor,
		chain: ctx.chain,
		...(id ? { id } : {}),
	});
	const t = (await ctx.cluster.waitTask(created.id, 15_000, ctx.signal)) ?? created;
	if (t.state !== "exited") {
		const missing = t.errorCode === "not_found";
		return {
			path,
			content: null,
			note: missing ? "no notes yet; create the file with write_file" : `could not read: ${t.errorCode ?? t.state}`,
		};
	}
	const text = t.stdoutHead;
	// The notes are shown up to 8 KB, and only a page that reached the end of the file is the whole file.
	const page = pageResultOf(t.result);
	const cut = Buffer.byteLength(text) > NOTES_BYTES || page?.eof !== true;
	return {
		path,
		content: cut
			? Buffer.from(text)
					.subarray(0, NOTES_BYTES)
					.toString("utf8")
					.replace(/\uFFFD+$/, "")
			: text,
		...(cut ? { truncated: `first ${NOTES_BYTES} bytes shown; read the whole file with read_file` } : {}),
	};
}

const nodeInfo = define({
	name: "node_info",
	description:
		"Facts about one node (OS, kernel, architecture, init system, package managers, groups) and its notes: a " +
		"Markdown file on the node that people and agents keep up to date. Edit the notes with edit_file/write_file.",
	input: z.object({ node: nodeField }),
	readOnly: true,
	handler: async (args, ctx) => {
		const node = (await listNodesForUser(ctx.db, ctx.user)).find((n) => n.name === args.node || n.id === args.node);
		if (!node) throw new UserError(`no node ${args.node} that you can see`);
		const row = await getNode(ctx.db, node.id);
		const notesPath = node.facts?.notesPath;
		const canRun = node.access !== "view";
		return {
			name: node.name,
			id: node.id,
			transport: node.transport,
			status: node.status,
			groups: node.groups,
			hostname: node.hostname,
			client_version: node.clientVersion,
			last_seen_at: node.lastSeenAt,
			facts: node.facts,
			ssh: row?.transport === "ssh" ? { user: row.ssh_user, host: row.ssh_host } : undefined,
			notes: notesPath && canRun ? await readNotes(ctx, node.id, notesPath) : notesPath ? { path: notesPath } : null,
		};
	},
});

const exec = define({
	name: "exec",
	description:
		"Run a command on a node, or on several nodes with targets. Give cmd (run with the node's POSIX sh) or " +
		"argv. Returns the exit code and the end of stdout/stderr; long-running tasks return a task_id to follow " +
		"with task_wait. The task may first need the user's approval.",
	input: z.object({
		targets: targetsField,
		cmd: z
			.string()
			.optional()
			.describe(
				'Shell command, run with sh -c; for bash syntax use argv ["bash", "-c", …] after checking ' +
					"node_info facts.shells.bash",
			),
		argv: z.array(z.string()).min(1).optional().describe("Program and arguments, run without a shell"),
		cwd: z.string().optional().describe("Absolute working directory (default /)"),
		env: z.record(z.string(), z.string()).optional(),
		stdin: z.string().optional(),
		timeout: z.number().int().min(1).optional().describe("Seconds before the command is killed"),
		privileged: privilegedField,
		wait: waitField,
		...batchFields,
		output: outputField,
	}),
	readOnly: false,
	handler: async (args, ctx) => {
		if ((args.cmd === undefined) === (args.argv === undefined)) throw new UserError("give either cmd or argv");
		return run(
			ctx,
			args,
			{
				kind: "exec",
				command: args.argv !== undefined ? { argv: args.argv } : { shell: args.cmd ?? "" },
				env: args.env ?? {},
				cwd: args.cwd ?? "",
				stdin: null,
			},
			args.stdin === undefined ? undefined : Buffer.from(args.stdin),
		);
	},
});

const readFile = define({
	name: "read_file",
	description:
		"Read a file on a node, or the same file on several nodes with targets. Lines are 1-based: read " +
		`${OUTPUT_LINES} lines from \`offset\` (default 1), whole lines only, at most 50 KB per call. The page is ` +
		"returned exactly as it is in the file. A truncated result says how to continue with `offset`; the " +
		"line count and the end of the file are reported only when the page reaches it. A line longer than " +
		"50 KB cannot be read with this tool. With several nodes, each node keeps its own page and offset " +
		"under one shared output budget.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		offset: z.number().int().min(1).optional().describe("Line to start at (1-based; default 1)"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(OUTPUT_LINES)
			.optional()
			.describe(`Lines to read (default ${OUTPUT_LINES}); a page also stops at 50 KB`),
		privileged: privilegedField,
		wait: waitField,
		...batchFields,
	}),
	readOnly: true,
	handler: async (args, ctx) => {
		const startLine = args.offset ?? 1;
		const spec: TaskSpec = { kind: "file.read", path: args.path, startLine, lineCount: args.limit ?? OUTPUT_LINES };
		const started = await start(ctx, args, spec);
		return started.kind === "task"
			? readOnNode(ctx, started.task, started.nodeName, args.path, startLine)
			: readGroup(ctx, started.group, started.names, args.path, startLine);
	},
});

const writeFile = define({
	name: "write_file",
	description:
		"Create a file on a node (or several with targets). Fails if the file exists unless overwrite is true. " +
		"To change part of a file, use edit_file.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		content: z.string(),
		overwrite: z.boolean().optional(),
		mode: z.number().int().min(0).max(0o7777).optional().describe("Permission bits for a new file, e.g. 420 (0644)"),
		privileged: privilegedField,
		wait: waitField,
		...batchFields,
	}),
	readOnly: false,
	handler: async (args, ctx) =>
		run(
			ctx,
			args,
			{
				kind: "file.write",
				path: args.path,
				content: EMPTY_INPUT_REF,
				overwrite: args.overwrite === true,
				mode: args.mode ?? 0,
				owner: "",
				group: "",
			},
			Buffer.from(args.content),
		),
});

const editFile = define({
	name: "edit_file",
	description:
		"Edit a file on a node by replacing text. Each oldText must occur exactly once in the file; all edits " +
		"apply together or not at all.",
	input: z.object({
		node: nodeField,
		path: z.string().describe("Absolute path"),
		edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1),
		privileged: privilegedField,
		wait: waitField,
	}),
	readOnly: false,
	handler: async (args, ctx) => {
		const { task, nodeName } = await startOne(ctx, args.node, args, {
			kind: "file.edit",
			path: args.path,
			edits: args.edits.map((e) => ({ oldText: e.oldText, newText: e.newText })),
		});
		return taskResult(task, nodeName, ctx);
	},
});

const listDir = define({
	name: "list_dir",
	description: "List a directory on a node (or on several with targets).",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		limit: z.number().int().min(1).max(10_000).optional(),
		privileged: privilegedField,
		wait: waitField,
		...batchFields,
	}),
	readOnly: true,
	handler: async (args, ctx) => run(ctx, args, { kind: "file.list", path: args.path, limit: args.limit ?? 0 }),
});

const taskWait = define({
	name: "task_wait",
	description:
		"Keep waiting for a task or task group started earlier (still running, or waiting for approval); returns " +
		"its current result.",
	input: z.object({
		task_id: z.string().optional(),
		task_group_id: z.string().optional(),
		wait: waitField,
	}),
	readOnly: true,
	handler: async (args, ctx) => {
		const waitMs = (args.wait ?? ctx.defaultWaitS ?? DEFAULT_WAIT_S) * 1000;
		if (args.task_group_id) {
			const g = await ctx.groups.get(args.task_group_id);
			if (!g || g.onBehalfOfUserId !== ctx.user.userId || !(await mayActFor(ctx, g.actorType, g.actorId))) {
				throw new UserError("no such task group");
			}
			const done = await waitGroupFor(ctx, g.id, waitMs);
			return groupResult(done, await nodeNames(ctx, done.nodeIds), ctx);
		}
		if (!args.task_id) throw new UserError("give task_id or task_group_id");
		const t = await ownTask(ctx, args.task_id);
		const done = (await waitTaskFor(ctx, t.id, waitMs)) ?? t;
		return taskResult(done, (await nodeNames(ctx, [t.nodeId])).get(t.nodeId) ?? t.nodeId, ctx);
	},
});

const taskCancel = define({
	name: "task_cancel",
	description: "Cancel a running task (TERM, then KILL after a grace period).",
	input: z.object({ task_id: z.string() }),
	readOnly: false,
	handler: async (args, ctx) => {
		const t = await ownTask(ctx, args.task_id);
		return { task_id: t.id, cancel_sent: await ctx.cluster.cancelTask(t.id, undefined, ctx.actor) };
	},
});

/**
 * A task the caller may act on: started for the same user **and** for its own session or token (or a session
 * below it). Another session of the same user keeps its tasks (doc/agent-runtime.md#cluster-工具).
 */
async function ownTask(ctx: ToolContext, id: string): Promise<TaskView> {
	const t = await ctx.cluster.getTask(id);
	if (!t || t.onBehalfOfUserId !== ctx.user.userId || !(await mayActFor(ctx, t.actorType, t.actorId))) {
		throw new UserError("no such task");
	}
	return t;
}

export const TOOLS: readonly ClusterTool[] = [
	listNodes,
	nodeInfo,
	exec,
	readFile,
	writeFile,
	editFile,
	listDir,
	taskWait,
	taskCancel,
] as unknown as ClusterTool[];
