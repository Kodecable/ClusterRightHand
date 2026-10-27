import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { TaskSpecSchema } from "@crh/protocol";
import * as z from "zod/v4";
import type { SessionUser } from "../auth/sessions.ts";
import type { Actor, Cluster, TaskView } from "../cluster/cluster.ts";
import { getNode, listNodesForUser } from "../cluster/nodes.ts";
import { resolveTargets, type TaskGroups, type TaskGroupView } from "../cluster/task-groups.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";

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
	signal?: AbortSignal;
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

type SpecInit = MessageInitShape<typeof TaskSpecSchema>;

const nodeField = z.string().describe("Node name or id");
const targetsField = z
	.array(z.string())
	.min(1)
	.describe('Several nodes at once: node names and "group:<name>", e.g. ["web-1", "group:prod"]');
const waitField = z
	.number()
	.int()
	.min(0)
	.max(MAX_WAIT_S)
	.optional()
	.describe(`Seconds to wait for the result (default ${DEFAULT_WAIT_S}); after that, follow up with task_wait`);
const batchFields = {
	parallel: z.number().int().min(1).max(100).optional().describe("Batch: nodes run at once (default 10)"),
	fail_fast: z.boolean().optional().describe("Batch: start no more nodes after one fails"),
};

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
	if (t.state === "awaiting_approval") {
		out.approval = {
			status: "waiting for the user's approval",
			url: ctx.approvalUrl("task", t.id),
			expires_at: t.approvalExpiresAt,
			next: "call task_wait with this task_id to keep waiting",
		};
		return out;
	}
	if (t.exitCode !== null) out.exit_code = t.exitCode;
	if (t.signal) out.signal = t.signal;
	if (t.timedOut) out.timed_out = true;
	if (t.cancelled) out.cancelled = true;
	if (t.errorCode) out.error = { code: t.errorCode, message: t.errorMessage };
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

async function nodeNames(ctx: ToolContext, ids: string[]): Promise<Map<string, string>> {
	const nodes = await listNodesForUser(ctx.db, ctx.user);
	return new Map(nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, n.name]));
}

function groupResult(g: TaskGroupView, names: Map<string, string>, ctx: ToolContext): Record<string, unknown> {
	const out: Record<string, unknown> = { task_group_id: g.id, state: g.state };
	if (g.state === "awaiting_approval") {
		out.approval = {
			status: "waiting for the user's approval",
			url: ctx.approvalUrl("task_group", g.id),
			expires_at: g.approvalExpiresAt,
			next: "call task_wait with this task_group_id to keep waiting",
		};
	}
	// Per node, sharing one output budget across the group.
	let budget = OUTPUT_BYTES;
	out.nodes = g.tasks.map((t) => {
		const r = taskResult(t, names.get(t.nodeId) ?? t.nodeId, ctx);
		for (const k of ["stdout", "stderr"] as const) {
			const s = r[k];
			if (typeof s !== "string") continue;
			const share = Math.max(1024, Math.floor(budget / 2));
			if (Buffer.byteLength(s) > share) {
				r[k] = Buffer.from(s).subarray(-share).toString("utf8").replace(/^�+/, "");
				r.truncated = { ...(r.truncated as object), note: "only the end is shown (batch output budget)" };
			}
			budget = Math.max(0, budget - Buffer.byteLength(r[k] as string));
		}
		return r;
	});
	if (g.skipped.length > 0) out.skipped = g.skipped.map((id) => names.get(id) ?? id);
	if (g.state === "running") out.next = "still running: call task_wait with this task_group_id";
	return out;
}

/** Runs a spec on one node or, with targets, as a task group; waits up to `wait` seconds. */
async function run(
	ctx: ToolContext,
	args: { node?: string; targets?: string[]; wait?: number; timeout?: number; parallel?: number; fail_fast?: boolean },
	spec: SpecInit,
	input?: Uint8Array,
): Promise<unknown> {
	if ((args.node === undefined) === (args.targets === undefined)) throw new UserError("give either node or targets");
	const waitMs = (args.wait ?? DEFAULT_WAIT_S) * 1000;
	const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;
	const common = { spec: create(TaskSpecSchema, spec), input, timeoutMs, actor: ctx.actor, chain: ctx.chain };
	if (args.node !== undefined) {
		const [nodeId] = await resolveTargets(ctx.db, ctx.user, [args.node]);
		const created = await ctx.cluster.createTask({ ...common, nodeId: nodeId as string });
		const task = (await ctx.cluster.waitTask(created.id, waitMs, ctx.signal)) ?? created;
		return taskResult(task, args.node, ctx);
	}
	const targets = args.targets as string[];
	const nodeIds = await resolveTargets(ctx.db, ctx.user, targets);
	const id = await ctx.groups.create({
		...common,
		targets,
		nodeIds,
		parallel: args.parallel,
		failFast: args.fail_fast,
	});
	const group = (await ctx.groups.wait(id, waitMs)) as TaskGroupView;
	return groupResult(group, await nodeNames(ctx, nodeIds), ctx);
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
				os: (n.facts as { os?: unknown } | null)?.os,
				can_run_tasks: n.access !== "view" && n.status === "active",
			})),
		};
	},
});

const nodeInfo = define({
	name: "node_info",
	description: "Facts about one node: OS, kernel, architecture, init system, package manager, groups.",
	input: z.object({ node: nodeField }),
	readOnly: true,
	handler: async (args, ctx) => {
		const node = (await listNodesForUser(ctx.db, ctx.user)).find((n) => n.name === args.node || n.id === args.node);
		if (!node) throw new UserError(`no node ${args.node} that you can see`);
		const row = await getNode(ctx.db, node.id);
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
		};
	},
});

const exec = define({
	name: "exec",
	description:
		"Run a command on a node, or on several nodes with targets. Give cmd (run with /bin/sh -c) or argv. " +
		"Returns the exit code and the end of stdout/stderr; long-running tasks return a task_id to follow with " +
		"task_wait. The task may first need the user's approval.",
	input: z.object({
		node: nodeField.optional(),
		targets: targetsField.optional(),
		cmd: z.string().optional().describe("Shell command, run with /bin/sh -c"),
		argv: z.array(z.string()).min(1).optional().describe("Program and arguments, run without a shell"),
		cwd: z.string().optional().describe("Absolute working directory (default /)"),
		env: z.record(z.string(), z.string()).optional(),
		stdin: z.string().optional(),
		timeout: z.number().int().min(1).optional().describe("Seconds before the command is killed"),
		wait: waitField,
		...batchFields,
	}),
	readOnly: false,
	handler: async (args, ctx) => {
		if ((args.cmd === undefined) === (args.argv === undefined)) throw new UserError("give either cmd or argv");
		return run(
			ctx,
			args,
			{
				kind: {
					case: "exec",
					value: { argv: args.argv ?? [], shell: args.cmd ?? "", env: args.env ?? {}, cwd: args.cwd ?? "" },
				},
			},
			args.stdin === undefined ? undefined : Buffer.from(args.stdin),
		);
	},
});

const readFile = define({
	name: "read_file",
	description: "Read a file on a node (or the same file on several nodes with targets).",
	input: z.object({
		node: nodeField.optional(),
		targets: targetsField.optional(),
		path: z.string().describe("Absolute path"),
		offset: z.number().int().min(0).optional().describe("Byte offset to start at"),
		limit: z.number().int().min(1).optional().describe("Bytes to read (default: to the end)"),
		wait: waitField,
		...batchFields,
	}),
	readOnly: true,
	handler: async (args, ctx) =>
		run(ctx, args, {
			kind: {
				case: "fileRead",
				value: { path: args.path, offset: BigInt(args.offset ?? 0), limit: BigInt(args.limit ?? 0) },
			},
		}),
});

const writeFile = define({
	name: "write_file",
	description:
		"Create a file on a node (or several with targets). Fails if the file exists unless overwrite is true. " +
		"To change part of a file, use edit_file.",
	input: z.object({
		node: nodeField.optional(),
		targets: targetsField.optional(),
		path: z.string().describe("Absolute path"),
		content: z.string(),
		overwrite: z.boolean().optional(),
		mode: z.number().int().min(0).max(0o7777).optional().describe("Permission bits for a new file, e.g. 420 (0644)"),
		wait: waitField,
		...batchFields,
	}),
	readOnly: false,
	handler: async (args, ctx) =>
		run(
			ctx,
			args,
			{
				kind: {
					case: "fileWrite",
					value: { path: args.path, overwrite: args.overwrite === true, mode: args.mode ?? 0 },
				},
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
		wait: waitField,
	}),
	readOnly: false,
	handler: async (args, ctx) =>
		run(ctx, args, {
			kind: {
				case: "fileEdit",
				value: { path: args.path, edits: args.edits.map((e) => ({ oldText: e.oldText, newText: e.newText })) },
			},
		}),
});

const listDir = define({
	name: "list_dir",
	description: "List a directory on a node.",
	input: z.object({
		node: nodeField,
		path: z.string().describe("Absolute path"),
		limit: z.number().int().min(1).max(10_000).optional(),
		wait: waitField,
	}),
	readOnly: true,
	handler: async (args, ctx) =>
		run(ctx, args, { kind: { case: "fileList", value: { path: args.path, limit: args.limit ?? 0 } } }),
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
		const waitMs = (args.wait ?? DEFAULT_WAIT_S) * 1000;
		if (args.task_group_id) {
			const g = await ctx.groups.get(args.task_group_id);
			if (!g || g.onBehalfOfUserId !== ctx.user.userId) throw new UserError("no such task group");
			const done = (await ctx.groups.wait(g.id, waitMs)) as TaskGroupView;
			return groupResult(done, await nodeNames(ctx, done.nodeIds), ctx);
		}
		if (!args.task_id) throw new UserError("give task_id or task_group_id");
		const t = await ownTask(ctx, args.task_id);
		const done = (await ctx.cluster.waitTask(t.id, waitMs, ctx.signal)) ?? t;
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
		return { task_id: t.id, cancel_sent: await ctx.cluster.cancelTask(t.id) };
	},
});

/** Tasks are visible to tools only when they were started for the same user. */
async function ownTask(ctx: ToolContext, id: string): Promise<TaskView> {
	const t = await ctx.cluster.getTask(id);
	if (!t || t.onBehalfOfUserId !== ctx.user.userId) throw new UserError("no such task");
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
