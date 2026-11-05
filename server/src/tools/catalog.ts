import type { JsonFacts, TaskSpec } from "@crh/protocol";
import { sql } from "kysely";
import * as z from "zod/v4";
import type { SessionUser } from "../auth/sessions.ts";
import { type Actor, type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { nameKey } from "../cluster/names.ts";
import { getNode, listNodesForUser } from "../cluster/nodes.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";
import { derivedId } from "../util/id.ts";
import { jsonResult, type ToolOutput, type ToolResult } from "./render.ts";
import {
	execResult,
	execTaskResult,
	fileJsonGroupResult,
	fileJsonResult,
	GROUP_READ_LINES,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	READ_PAGE_LINES,
	readGroupResult,
	readTaskResult,
	runTaskTool,
	runTaskToolOnNode,
	waitExistingGroup,
	waitExistingTask,
} from "./task-tool.ts";

/**
 * The cluster tools, defined once and adapted to MCP and to agent sessions; see
 * doc/agent-runtime.md#cluster-工具. Handlers return a ToolResult (text or compact JSON plus UI details);
 * the task tools share the component in task-tool.ts (D111).
 */

export interface ToolContext {
	db: Db;
	cluster: Cluster;
	taskGroups: TaskGroups;
	/** The user the caller acts for; node access is theirs. */
	user: SessionUser;
	actor: Actor;
	/** The caller's rule chain, root first. */
	chain: RuleRef[];
	/** Where the user approves a waiting task or task group in the WebUI. */
	approvalUrl: (kind: "task" | "task_group", id: string) => string;
	/** Where the owner sees a waiting task's authorization payload in the WebUI (absolute for MCP). */
	taskUrl?: (id: string) => string;
	/** The task-group page, where a waiting task group is signed (absolute for MCP). */
	taskGroupUrl?: (id: string) => string;
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

export interface ClusterTool<S extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	input: S;
	readOnly: boolean;
	/** Text (raw + note blocks) or compact JSON; also picks the expected-error shape (D112). */
	output: ToolOutput;
	handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

const nodeField = z.string().describe("Node name or id");
const targetsField = z
	.array(z.string())
	.min(1)
	.describe(
		"What to act on: node names or ids, node-group names or ids, or _all (every node you can operate). " +
			"Exactly one entry that names a node runs one task and returns its result; a node-group entry, _all, " +
			"or several entries run a task group and return one result per node",
	);
const waitField = z
	.number()
	.int()
	.min(0)
	.max(600)
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
		"Exec batch only, default status: status returns just each node's exit status and the path of its full " +
			"output file on the node, which you can read with read_file; text returns the end of each node's " +
			"output within one budget shared by the batch. Budgets without output make a batch use text",
	);
const maxLinesField = z
	.number()
	.int()
	.min(1)
	.max(MAX_OUTPUT_LINES)
	.optional()
	.describe(
		"Per-node line budget, at most 2000 (D112): for a single task it caps the tail given to you; for a batch " +
			"each node keeps at most this many lines. Not allowed with output: status",
	);
const maxBytesField = z
	.number()
	.int()
	.min(1)
	.max(MAX_OUTPUT_BYTES)
	.optional()
	.describe(
		"Per-node byte budget, at most 51200 (D112): for a single task it caps the tail given to you; for a batch " +
			"each node keeps at most this many bytes. Not allowed with output: status",
	);

/** The batch parameters of the file tools; they never take a `wait` (D111). */
const fileBatchFields = { ...batchFields };

function define<S extends z.ZodType>(tool: ClusterTool<S>): ClusterTool<S> {
	return tool;
}

// ---- non-task tools ----

const listNodes = define({
	name: "list_nodes",
	description:
		"List the nodes you have been granted access to, with their node groups, status, whether they are online " +
		"and whether you may run tasks on them.",
	input: z.object({}),
	readOnly: true,
	output: "json",
	handler: async (_args, ctx) => {
		const nodes = await listNodesForUser(ctx.db, ctx.user);
		return jsonResult({
			nodes: nodes.map((n) => {
				const connected = n.transport === "ssh" ? null : ctx.cluster.isConnected(n.id);
				return {
					name: n.name,
					id: n.id,
					status: n.status,
					transport: n.transport,
					connected,
					node_groups: n.nodeGroups.map((group) => group.name),
					hostname: n.hostname,
					os: n.facts?.osPrettyName ?? n.facts?.osId,
					client_version: n.clientVersion,
					last_seen_at: n.lastSeenAt,
					privileged_mode: n.privilegedMode,
					can_run_tasks: n.status === "active" && (n.transport === "ssh" || connected === true),
				};
			}),
		});
	},
});

/** Node notes shown by node_info are cut here; read_file gives the rest (doc/agent-runtime.md#默认值). */
const NOTES_BYTES = 8 * 1024;

/** Facts in their snake_case JSON form (the protocol's wire keys, doc/protocol.md#事件). */
function factsWire(facts: JsonFacts | null): Record<string, unknown> | null {
	if (!facts) return null;
	const out: Record<string, unknown> = {};
	if (facts.hostname !== undefined) out.hostname = facts.hostname;
	if (facts.osId !== undefined) out.os_id = facts.osId;
	if (facts.osVersionId !== undefined) out.os_version_id = facts.osVersionId;
	if (facts.osPrettyName !== undefined) out.os_pretty_name = facts.osPrettyName;
	if (facts.kernel !== undefined) out.kernel = facts.kernel;
	if (facts.arch !== undefined) out.arch = facts.arch;
	if (facts.initSystem !== undefined) out.init_system = facts.initSystem;
	if (facts.packageManagers !== undefined) out.package_managers = facts.packageManagers;
	if (facts.privilegeTools !== undefined) out.privilege_tools = facts.privilegeTools;
	if (facts.notesPath !== undefined) out.notes_path = facts.notesPath;
	if (facts.clockOffsetMs !== undefined) out.clock_offset_ms = facts.clockOffsetMs;
	if (facts.shells !== undefined) out.shells = facts.shells;
	return out;
}

/**
 * The node's notes file, read through an ordinary (audited) file.read task, but only when the rules allow
 * that read outright: node_info never leaves an approval request behind.
 */
async function readNotes(ctx: ToolContext, nodeId: string, path: string): Promise<Record<string, unknown>> {
	const node = await getNode(ctx.db, nodeId);
	if (node?.status !== "active") return { path, content: null, note: "the node is not active" };
	const spec: TaskSpec = { kind: "file.read", path, startLine: 1, lineCount: READ_PAGE_LINES };
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
	const page = t.result?.kind === "file.read" ? t.result : undefined;
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
		"Facts about one node (OS, kernel, architecture, init system, package managers, node groups) and its notes: a " +
		"Markdown file on the node that people and agents keep up to date. Edit the notes with edit_file/write_file.",
	input: z.object({ node: nodeField }),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) => {
		const node = (await listNodesForUser(ctx.db, ctx.user)).find(
			(n) => n.id === args.node || nameKey(n.name) === nameKey(args.node),
		);
		if (!node) throw new UserError(`no node ${args.node} that you can see`, "no_such_node");
		const row = await getNode(ctx.db, node.id);
		const notesPath = node.facts?.notesPath;
		return jsonResult({
			name: node.name,
			id: node.id,
			transport: node.transport,
			status: node.status,
			node_groups: node.nodeGroups.map((group) => group.name),
			hostname: node.hostname,
			client_version: node.clientVersion,
			last_seen_at: node.lastSeenAt,
			facts: factsWire(node.facts),
			ssh: row?.transport === "ssh" ? { user: row.ssh_user, host: row.ssh_host } : undefined,
			notes: notesPath ? await readNotes(ctx, node.id, notesPath) : null,
		});
	},
});

// ---- crh task tools ----

const exec = define({
	name: "exec",
	description:
		"Run a command on a node, or on several nodes with targets. Give cmd (run with the node's POSIX sh) or " +
		"argv. Returns the command's merged output and exit status as text; long-running tasks return a task_id " +
		"to follow with task_wait. A batch returns per-node status (JSON) by default, or each node's output tail " +
		"as text with output: text. max_lines/max_bytes cap each node's output. The task may first need the " +
		"user's approval.",
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
		max_lines: maxLinesField,
		max_bytes: maxBytesField,
	}),
	readOnly: false,
	output: "text",
	handler: async (args, ctx) => {
		if ((args.cmd === undefined) === (args.argv === undefined))
			throw new UserError("give either cmd or argv", "invalid_argument");
		const budgets = args.max_lines !== undefined || args.max_bytes !== undefined;
		if (args.output === "status" && budgets) {
			throw new UserError(
				"max_lines and max_bytes need output: text (or no output) for a batch; output: status returns no output",
				"invalid_argument",
			);
		}
		// Budgets without an explicit output make an exec batch use text (D112).
		const outputMode = args.output ?? (budgets ? "text" : undefined);
		return runTaskTool(
			ctx,
			args,
			{
				spec: {
					kind: "exec",
					command: args.argv !== undefined ? { argv: args.argv } : { shell: args.cmd ?? "" },
					env: args.env ?? {},
					cwd: args.cwd ?? "",
					stdin: null,
				},
				input: args.stdin === undefined ? undefined : Buffer.from(args.stdin),
				wait: args.wait,
				timeoutMs: args.timeout === undefined ? undefined : args.timeout * 1000,
				maxLines: args.max_lines,
				maxBytes: args.max_bytes,
				outputMode,
			},
			"background",
			(started) => execResult(ctx, started),
		);
	},
});

const readFile = define({
	name: "read_file",
	description:
		"Read a file on a node, or the same file on several nodes with targets. Lines are 1-based: read " +
		`${READ_PAGE_LINES} lines from \`offset\` (default 1), whole lines only, at most 50 KB per call. The page is ` +
		"returned exactly as it is in the file; the note says its line range, and only a page that reached the end " +
		"of the file reports the total. Use offset to continue. In a batch, limit (default 128) is each node's " +
		"line budget and max_bytes its byte budget; each node keeps its own page and offset. The call blocks until " +
		"the task ends, approval included, and returns no task id.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		offset: z.number().int().min(1).optional().describe("Line to start at (1-based; default 1)"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(READ_PAGE_LINES)
			.optional()
			.describe(`Lines to read (default ${READ_PAGE_LINES}; a page also stops at 50 KB)`),
		max_bytes: z
			.number()
			.int()
			.min(1)
			.max(MAX_OUTPUT_BYTES)
			.optional()
			.describe("Per-node byte budget for the page, at most 51200"),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: true,
	output: "text",
	handler: async (args, ctx) => {
		const startLine = args.offset ?? 1;
		const spec: TaskSpec = { kind: "file.read", path: args.path, startLine, lineCount: args.limit ?? READ_PAGE_LINES };
		return runTaskTool(
			ctx,
			args,
			{
				spec,
				// In a group `limit` is also the per-node line budget; without it the batch default applies.
				maxLines: args.limit ?? GROUP_READ_LINES,
				maxBytes: args.max_bytes,
			},
			"blocking",
			(started) =>
				started.kind === "task"
					? readTaskResult(ctx, started.task, started.nodeName, args.path, startLine, args.max_bytes)
					: readGroupResult(ctx, started.taskGroup, started.names, args.path, startLine, args.max_bytes),
		);
	},
});

const writeFile = define({
	name: "write_file",
	description:
		"Create a file on a node (or several with targets). Fails if the file exists unless overwrite is true. " +
		"To change part of a file, use edit_file. The call blocks until the task ends, approval included, and " +
		"returns no task id.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		content: z.string(),
		overwrite: z.boolean().optional(),
		mode: z.number().int().min(0).max(0o7777).optional().describe("Permission bits for a new file, e.g. 420 (0644)"),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) =>
		runTaskTool(
			ctx,
			args,
			{
				spec: {
					kind: "file.write",
					path: args.path,
					content: EMPTY_INPUT_REF,
					overwrite: args.overwrite === true,
					mode: args.mode ?? 0,
					owner: "",
					group: "",
				},
				input: Buffer.from(args.content),
			},
			"blocking",
			(started) =>
				started.kind === "task"
					? fileJsonResult(ctx, started.task, started.nodeName)
					: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		),
});

const editFile = define({
	name: "edit_file",
	description:
		"Edit a file on one node by replacing text. Each old_text must occur exactly once in the file; all edits " +
		"apply together or not at all. The call blocks until the task ends, approval included, and returns no " +
		"task id.",
	input: z.object({
		node: nodeField,
		path: z.string().describe("Absolute path"),
		edits: z
			.array(z.object({ old_text: z.string().min(1), new_text: z.string() }))
			.min(1)
			.describe("Replacements, applied together or not at all; old_text must be unique in the file"),
		privileged: privilegedField,
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) =>
		runTaskToolOnNode(
			ctx,
			args.node,
			args,
			{
				spec: {
					kind: "file.edit",
					path: args.path,
					edits: args.edits.map((edit) => ({ oldText: edit.old_text, newText: edit.new_text })),
				},
			},
			"blocking",
			(started) => fileJsonResult(ctx, started.task, started.nodeName),
		),
});

const listDir = define({
	name: "list_dir",
	description:
		"List a directory on a node (or on several with targets). The call blocks until the task ends, approval " +
		"included, and returns no task id.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		limit: z.number().int().min(1).max(10_000).optional(),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) =>
		runTaskTool(
			ctx,
			args,
			{ spec: { kind: "file.list", path: args.path, limit: args.limit ?? 0 } },
			"blocking",
			(started) =>
				started.kind === "task"
					? fileJsonResult(ctx, started.task, started.nodeName)
					: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		),
});

const stat = define({
	name: "stat",
	description:
		"Show a file's attributes on a node (or the same path on several with targets): type, size, mode, owner, " +
		"group, modification time and link target. The call blocks until the task ends, approval included, and " +
		"returns no task id.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) =>
		runTaskTool(ctx, args, { spec: { kind: "file.stat", path: args.path } }, "blocking", (started) =>
			started.kind === "task"
				? fileJsonResult(ctx, started.task, started.nodeName)
				: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		),
});

// ---- following up exec ----

const taskWait = define({
	name: "task_wait",
	description:
		"Keep waiting for an exec task or task group started earlier (still running, or waiting for approval or " +
		"authorization); returns its current result, text like exec. File tools never return task ids, so they " +
		"cannot be waited for.",
	input: z.object({
		task_id: z.string().optional(),
		task_group_id: z.string().optional(),
		wait: waitField,
	}),
	readOnly: true,
	output: "text",
	handler: async (args, ctx) => {
		const waitMs = (args.wait ?? ctx.defaultWaitS ?? 30) * 1000;
		if (args.task_group_id) {
			const taskGroup = await ctx.taskGroups.get(args.task_group_id);
			if (
				!taskGroup ||
				taskGroup.onBehalfOfUserId !== ctx.user.userId ||
				!(await mayActFor(ctx, taskGroup.actorType, taskGroup.actorId)) ||
				taskGroup.kind !== "exec"
			) {
				throw new UserError("no such task group", "no_such_task");
			}
			const done = await waitExistingGroup(ctx, taskGroup.id, waitMs);
			const nodes = await ctx.db
				.selectFrom("nodes")
				.select(["id", "name", "transport"])
				.where("id", "in", done.nodeIds)
				.execute();
			const names = new Map(nodes.map((n) => [n.id, n.name] as const));
			const transports = new Map(nodes.map((n) => [n.id, n.transport] as const));
			return execResult(ctx, { kind: "task_group", taskGroup: done, names, transports });
		}
		if (!args.task_id) throw new UserError("give task_id or task_group_id", "invalid_argument");
		const t = await ownTask(ctx, args.task_id);
		if (t.kind !== "exec") throw new UserError("no such task", "no_such_task");
		const done = (await waitExistingTask(ctx, t.id, waitMs)) ?? t;
		const node = await ctx.db
			.selectFrom("nodes")
			.select(["name", "transport"])
			.where("id", "=", t.nodeId)
			.executeTakeFirst();
		return execTaskResult(ctx, done, node?.name ?? t.nodeId, node?.transport ?? "client");
	},
});

const taskCancel = define({
	name: "task_cancel",
	description:
		"Cancel a running exec task (TERM, then KILL after a grace period). File tools never return task ids, so " +
		"they cannot be cancelled.",
	input: z.object({ task_id: z.string() }),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) => {
		const t = await ownTask(ctx, args.task_id);
		if (t.kind !== "exec") throw new UserError("no such task", "no_such_task");
		return jsonResult({ task_id: t.id, cancel_sent: await ctx.cluster.cancelTask(t.id, undefined, ctx.actor) });
	},
});

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
 * A task the caller may act on: started for the same user **and** for its own session or token (or a session
 * below it). Another session of the same user keeps its tasks (doc/agent-runtime.md#cluster-工具).
 */
async function ownTask(ctx: ToolContext, id: string): Promise<TaskView> {
	const t = await ctx.cluster.getTask(id);
	if (!t || t.onBehalfOfUserId !== ctx.user.userId || !(await mayActFor(ctx, t.actorType, t.actorId))) {
		throw new UserError("no such task", "no_such_task");
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
	stat,
	taskWait,
	taskCancel,
] as unknown as ClusterTool[];
