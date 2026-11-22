import { createHash } from "node:crypto";
import type { Evaluation, Operation } from "@crh/api";
import type { TaskSpec } from "@crh/protocol";
import type { CallToolResult } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { isPendingReview, pendingReview } from "../cluster/approval.ts";
import { type Actor, type Cluster, EMPTY_INPUT_REF } from "../cluster/cluster.ts";
import { listNodesForUser, type PublicNode } from "../cluster/nodes.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { resolveTargets } from "../cluster/task-groups.ts";
import {
	type CallRunner,
	callRunningResult,
	callWaitingResult,
	type RunningCall,
	settledCallResult,
} from "../extensions/call-runner.ts";
import {
	createExternalCall,
	type ExternalCallRow,
	externalCallApproval,
	externalCallId,
	externalCallTaskAction,
	finishExternalCall,
	getExternalCall,
} from "../extensions/external-calls.ts";
import type { ExtensionTool, SessionExtension } from "../extensions/model.ts";
import { buildSearchIndex, searchIndexRecord, searchQueryTerms } from "../extensions/search-index.ts";
import { sameInputSchema } from "../extensions/store.ts";
import { parseCallResult } from "../jobs/call.ts";
import type { Jobs } from "../jobs/jobs.ts";
import { jobLimitResult, withJobLimit } from "../jobs/limits.ts";
import { JOB_TOOLS } from "../jobs/tools.ts";
import type { JobRow } from "../jobs/types.ts";
import { copyLibraryFile } from "../library/files.ts";
import { type ImageCache, REJECTED_IMAGE_TEXT } from "../library/image-cache.ts";
import { readImageHeader } from "../library/image-header.ts";
import { findUserLibrary, libraryRef } from "../library/library.ts";
import { validateLibraryPath, validateLibraryPrefix } from "../library/paths.ts";
import { openTransferLocation, type TransferLocationJson } from "../library/transfer-location.ts";
import { evaluate } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { TodoLists } from "../todos/todos.ts";
import { TODO_TOOLS } from "../todos/tools.ts";
import { UserError } from "../util/errors.ts";
import { derivedId, newId } from "../util/id.ts";
import { copyDirectory } from "./directory-copy.ts";
import { convertExternalResult } from "./external-results.ts";
import { listToolLibrary, statToolLibrary, toolLibrary } from "./library-access.ts";
import { readLibraryFile } from "./library-read.ts";
import { nodeInfoFields, readNotes, readNotesBatch } from "./node-info.ts";
import { errorResult, jsonResult, type ToolOutput, type ToolResult, textResult } from "./render.ts";
import {
	execResult,
	fileJsonGroupResult,
	fileJsonResult,
	readGroupResult,
	readTaskResult,
	taskError,
} from "./task-render.ts";
import {
	GROUP_READ_LINES,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	READ_PAGE_LINES,
	runTaskTool,
	waitBlockingGroup,
	waitBlockingTask,
} from "./task-tool.ts";

/**
 * The cluster tools, defined once and adapted to MCP and to agent sessions; see
 * doc/design/agent-runtime.md "Cluster tools". Handlers return a ToolResult (text or compact JSON plus UI details);
 * the task tools share the component in task-tool.ts and its renderers in task-render.ts.
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
	/** The model's call id (the transcript's call id, which providers may reuse); tasks and calls are bound by `callKey`. */
	callId?: string;
	/** Seconds a call waits for its result when the caller gives no `wait` (MCP: 30; agents: 600). */
	defaultWaitS?: number;
	/** Agents keep waiting while a task waits for approval (MCP returns and follows up with job_wait). */
	/** Progress for a UI, e.g. "waiting for approval". */
	onStatus?: (status: Record<string, unknown>) => Promise<void>;
	/** The image cache behind `view_image`; the tool reports that it is not configured without one. */
	imageCache?: ImageCache;
	/** Whether this conversation already had the provider reject a SHA-256 (doc/design/library.md "view_image"). */
	imageRejected?: (sha256: string) => Promise<boolean>;
	/**
	 * The model's image input limits. Absent over MCP, where there is no model: the tool then uses the
	 * defaults (doc/design/library.md "view_image").
	 */
	imageLimits?: ImageLimits;
	/** The audit log, for the library copy `copy_file` records. */
	audit?: Audit;
	/** The extensions this session may use, with its own on/off choice (doc/design/extensions.md). */
	extensions?: SessionExtension[];
	/** The job service behind the job tools and the tools that start jobs (doc/design/jobs.md). */
	jobs?: Jobs;
	/** The change bus behind todo_write (doc/design/todo.md); absent on a surface without a runtime. */
	todos?: TodoLists;
	/** The crhs-owned in-flight extension calls (doc/design/jobs.md "Background extension calls"). */
	callRunner: CallRunner;
	/** The most unsettled jobs this caller may have (`jobs.max_running`); the default without System settings. */
	jobsMaxRunning?: number;
	/** The session tree's root, for grouping external-call approvals. */
	rootSessionId?: string;
	/** The session's organization, for tools that write rules (`subagent`). */
	orgId?: string;
	/** The WebUI page where the owner decides a waiting external call. */
	externalCallUrl?: (id: string) => string;
	/** Auto Review for one waiting external call; settles it before the waiter looks again. */
	reviewExternalCall?: (id: string, signal?: AbortSignal) => Promise<void>;
	/** Whether Auto Review will judge a request on this chain; the call then enters awaiting approval marked reviewing. */
	willReview?: (chain: RuleRef[]) => Promise<boolean>;
	/** The session state may now follow a wait; the runtime refreshes it and the chat notifications. */
	onApprovalChange?: (actorId: string) => void;
	/** Hands a waiting external call to an ancestor's agent; true when one took it. */
	routeExternalCall?: (id: string) => Promise<boolean>;
	/** Whether crhs is shutting down: a running external call then stays `running` for recovery. */
	closing?: () => boolean;
	/** How many files this turn has already offered through `copy_file` (at most 5). */
	deliveryCount?: () => Promise<number>;
	/** The limits of one directory copy (doc/design/library.md "Directory copies"); the defaults without it. */
	directoryCopyLimits?: { files: number; bytes: number };
}

/** How large an image `view_image` accepts. */
export interface ImageLimits {
	/** The model cannot take images at all: the tool refuses and the request hook writes a placeholder. */
	supported: boolean;
	maxWidth: number;
	maxHeight: number;
	/** The largest base64 form the request may carry. */
	maxBase64Bytes: number;
}

/** The line that tells any surface whose library is whose (doc/design/library.md "Agent tools"). */
export function actingUserNote(username: string): string {
	return (
		`You act for ${username}. user:${username} is that user's personal library; user_group:<name> is a library of ` +
		"a user group the user belongs to."
	);
}

/** The limits `view_image` uses when the surface has no model to ask (MCP) or the model declares none. */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
	supported: true,
	maxWidth: 2000,
	maxHeight: 2000,
	maxBase64Bytes: 4_500_000,
};

export interface ClusterTool<S extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	input: S;
	readOnly: boolean;
	/** Text (raw + note blocks) or compact JSON; also picks the expected-error shape. */
	output: ToolOutput;
	/** Only agent sessions: crhs's own MCP endpoint does not forward external tools. */
	agentOnly?: boolean;
	handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

const targetsField = z
	.array(z.string())
	.min(1)
	.describe(
		"What to act on: node names or ids, node-group names or ids, or _all (every node you can operate). " +
			"Exactly one entry that names a node runs one task and returns its result; a node-group entry, _all, " +
			"or several entries run a task group and return one result per node",
	);
/** The optional `targets` of a tool that also takes `library`: omit it when the library is used. */
const libraryTargetsField = targetsField
	.optional()
	.describe(`${targetsField.description}. Omit it when library is given.`);
const waitField = z
	.number()
	.int()
	.min(0)
	.max(600)
	.optional()
	.describe("Seconds to wait for the result; after that the job keeps running and job_wait follows it up");
const privilegedField = z
	.boolean()
	.optional()
	.describe(
		"Run with elevated privileges according to the node's privileged mode (forward, native, ignore or " +
			"reject); SSH nodes ignore it and run as the SSH user",
	);
/** The batch parameters; a single task ignores them (doc/design/agent-runtime.md "Batch execution"). */
const batchFields = {
	parallel: z.number().int().min(1).max(100).optional().describe("Batch only: nodes run at once (default 10)"),
	fail_fast: z.boolean().optional().describe("Batch only: start no more nodes after one fails"),
};
const withOutputField = z
	.boolean()
	.optional()
	.describe(
		"Return the command's output (default true): the task's tail as text, and for a batch each node's tail under " +
			"one shared budget. false returns one compact JSON status per task or node (exit status, state and the " +
			"path of the full output file on the node) without any output; max_lines/max_bytes are not allowed then",
	);
const maxLinesField = z
	.number()
	.int()
	.min(1)
	.max(MAX_OUTPUT_LINES)
	.optional()
	.describe(
		"Per node, at most 2000: exec keeps the last lines (the tail) of each node's output, for a single task " +
			"and for each node of a batch alike. Not allowed with with_output: false",
	);
const maxBytesField = z
	.number()
	.int()
	.min(1)
	.max(MAX_OUTPUT_BYTES)
	.optional()
	.describe(
		"Per node, at most 51200: exec keeps the last bytes (the tail) of each node's output, for a single task " +
			"and for each node of a batch alike. Not allowed with with_output: false",
	);

/** The batch parameters of the file tools; they never take a `wait`. */
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
					platform: n.facts?.platform,
					client_version: n.clientVersion,
					last_seen_at: n.lastSeenAt,
					privileged_mode: n.privilegedMode,
					can_run_tasks: n.status === "active" && (n.transport === "ssh" || connected === true),
				};
			}),
		});
	},
});

const nodeInfo = define({
	name: "node_info",
	description:
		"Facts about one or more nodes (targets): status, node groups, the platform (OS and architecture), the shells, " +
		"short hints the node reports for people and agents, and each node's notes, a Markdown file on the node that " +
		"people and agents keep up to date. Exactly " +
		"one node returns one object; a node group, _all or several entries return one entry per node. Edit the " +
		"notes with edit_file/write_file.",
	input: z.object({ targets: targetsField }),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) => {
		const resolved = await resolveTargets(ctx.db, ctx.user, args.targets);
		const byId = new Map((await listNodesForUser(ctx.db, ctx.user)).map((node) => [node.id, node] as const));
		if (resolved.singleNode) {
			const node = byId.get(resolved.nodeIds[0] as string);
			if (!node) throw new UserError("no such node", "no_such_node");
			const path = node.facts?.notesPath;
			const notes = path === undefined || path === "" ? null : await readNotes(ctx, node.id, path);
			return jsonResult(await nodeInfoFields(ctx, node, notes));
		}
		const nodes = resolved.nodeIds.map((id) => byId.get(id)).filter((node): node is PublicNode => node !== undefined);
		const notes = await readNotesBatch(ctx, nodes);
		const entries = await Promise.all(nodes.map((node) => nodeInfoFields(ctx, node, notes.get(node.id) ?? null)));
		return jsonResult({ nodes: entries });
	},
});

// ---- crh task tools ----

const exec = define({
	name: "exec",
	description:
		"Run a command on one node, or on several with targets. Give cmd (run with the node's POSIX sh) or argv. " +
		"Returns the command's output and exit status as text; long-running tasks return a job id to follow with " +
		"job_wait. A batch runs one task per node and returns each node's output tail as text, within one budget " +
		"shared by the batch. with_output: false returns JSON with the status and the path of the full output file " +
		"instead, for a single task too; max_lines/max_bytes cap each node's output and need with_output: true. " +
		"The task may first need the user's approval.",
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
		with_output: withOutputField,
		max_lines: maxLinesField,
		max_bytes: maxBytesField,
	}),
	readOnly: false,
	output: "text",
	handler: async (args, ctx) => {
		if ((args.cmd === undefined) === (args.argv === undefined))
			throw new UserError("give either cmd or argv", "invalid_argument");
		const withOutput = args.with_output !== false;
		if (!withOutput && (args.max_lines !== undefined || args.max_bytes !== undefined)) {
			throw new UserError(
				"max_lines and max_bytes need with_output: true (the default); with_output: false returns no output",
				"invalid_argument",
			);
		}
		const callKey = ctx.callKey ?? newId();
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
				outputMode: withOutput ? "text" : "status",
			},
			"background",
			(started) => execResult(ctx, started),
			async (started) => {
				if (!ctx.jobs) return undefined;
				const job = await ctx.jobs.ensure({
					kind: "exec",
					callKey,
					...(ctx.orgId === undefined ? {} : { orgId: ctx.orgId }),
					actor: ctx.actor,
					sessionId: jobSessionId(ctx),
					resourceType: started.kind === "task" ? "task" : "task_group",
					resourceId: started.kind === "task" ? started.task.id : started.taskGroup.id,
					action: started.kind === "task" ? started.task.action : started.taskGroup.action,
				});
				return job.id;
			},
			{ ctx, kind: "exec", callKey },
		);
	},
});

const readFile = define({
	name: "read_file",
	description:
		"Read a file on a node, or the same file on several nodes with targets, or a library file with `library` " +
		"instead of targets. Lines are 1-based: read " +
		`${READ_PAGE_LINES} lines from \`offset\` (default 1), whole lines only, at most 50 KB per call. The page is ` +
		"returned exactly as it is in the file; its bracketed note gives the line range, and only a page that reached " +
		"the end of the file reports the total. Use offset to continue. In a batch, limit (default 128) is each node's " +
		"line budget and max_bytes its byte budget; each node keeps its own page and offset. The call blocks until " +
		"the task ends, approval included, and returns no task id.",
	input: z.object({
		targets: libraryTargetsField,
		library: z
			.string()
			.optional()
			.describe("A library to read from instead of nodes: user:<username> or user_group:<user group name>"),
		path: z
			.string()
			.describe("A node's absolute path, or a library path relative to the library root (a leading / is optional)"),
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
		if (args.library !== undefined) {
			if (args.targets !== undefined) throw new UserError("give targets or library, not both", "invalid_argument");
			return readLibraryFile(ctx, {
				library: args.library,
				path: args.path,
				startLine,
				lineCount: args.limit ?? READ_PAGE_LINES,
				...(args.max_bytes === undefined ? {} : { maxBytes: args.max_bytes }),
			});
		}
		if (args.targets === undefined) throw new UserError("give targets or library", "invalid_argument");
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
					? readTaskResult(ctx, started.task, started.nodeName, args.path, startLine, args.max_bytes, started.privilege)
					: readGroupResult(
							ctx,
							started.taskGroup,
							started.names,
							args.path,
							startLine,
							args.max_bytes,
							started.privileges,
						),
		);
	},
});

/** `mode` is an octal permission string such as "0644"; a leading 0 is optional. */
const MODE_PATTERN = /^0?[0-7]{3,4}$/;

/** The permission bits of a write_file mode; invalid_argument when it is not an octal string. */
function modeBits(mode: unknown): number {
	if (mode === undefined) return 0;
	if (typeof mode !== "string" || !MODE_PATTERN.test(mode)) {
		throw new UserError(
			`mode must be an octal permission string such as "0644" (three or four octal digits, leading 0 optional)`,
			"invalid_argument",
		);
	}
	const bits = Number.parseInt(mode, 8);
	// Setuid, setgid and sticky are not permission bits a file task may set; an exec chmod under a
	// spec authorization is the only way (doc/design/execution.md "File tasks").
	if (bits > 0o777) {
		throw new UserError("mode must be at most 0777", "invalid_argument");
	}
	return bits;
}

const writeFile = define({
	name: "write_file",
	description:
		"Create a file on one node, or the same file on several with targets. Fails if the file exists unless " +
		'overwrite is true. mode is an octal string such as "0644"; create_parent_dirs creates missing parent ' +
		"directories first (like mkdir -p). To change part of a file, use edit_file. The call blocks until the task " +
		"ends, approval included, and returns no task id.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		content: z.string(),
		overwrite: z.boolean().optional(),
		mode: z
			.string()
			.optional()
			.describe('Permission bits for a new file as an octal string, e.g. "0644" (a leading 0 is optional)'),
		create_parent_dirs: z
			.boolean()
			.optional()
			.describe("Create missing parent directories first, like mkdir -p (default false)"),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) => {
		const mode = modeBits(args.mode);
		return runTaskTool(
			ctx,
			args,
			{
				spec: {
					kind: "file.write",
					path: args.path,
					content: EMPTY_INPUT_REF,
					overwrite: args.overwrite === true,
					mode,
					owner: "",
					group: "",
					createParentDirs: args.create_parent_dirs === true,
				},
				input: Buffer.from(args.content),
			},
			"blocking",
			(started) =>
				started.kind === "task"
					? fileJsonResult(ctx, started.task, started.nodeName)
					: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		);
	},
});

const editFile = define({
	name: "edit_file",
	description:
		"Edit a file on one node, or the same file on several with targets, by replacing text. Each old_text must " +
		"occur exactly once in each node's file; on one node all edits apply together or not at all. A node where an " +
		"old_text is missing or not unique fails on its own; the other nodes still complete. The call blocks until " +
		"the task ends, approval included, and returns no task id.",
	input: z.object({
		targets: targetsField,
		path: z.string().describe("Absolute path"),
		edits: z
			.array(z.object({ old_text: z.string().min(1), new_text: z.string() }))
			.min(1)
			.describe("Replacements, applied together or not at all on each node; old_text must be unique in the file"),
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
					kind: "file.edit",
					path: args.path,
					edits: args.edits.map((edit) => ({ oldText: edit.old_text, newText: edit.new_text })),
				},
			},
			"blocking",
			(started) =>
				started.kind === "task"
					? fileJsonResult(ctx, started.task, started.nodeName)
					: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		),
});

const listDir = define({
	name: "list_dir",
	description:
		"List a directory on a node (or on several with targets), or a directory of a library with `library` " +
		"instead of targets. A library is user:<username> or user_group:<user group name>; you reach the libraries " +
		"of the user you act for. A library directory exists only while some file is under it, so a library has no " +
		"empty directories and none need creating. The call blocks until the task ends, approval included, " +
		"and returns no task id.",
	input: z.object({
		targets: libraryTargetsField,
		library: z
			.string()
			.optional()
			.describe("A library to list instead of nodes: user:<username> or user_group:<user group name>"),
		path: z
			.string()
			.describe("A node's absolute path, or a library path relative to the library root (a leading / is optional)"),
		limit: z.number().int().min(1).max(10_000).optional(),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) => {
		if (args.library !== undefined) {
			if (args.targets !== undefined) throw new UserError("give targets or library, not both", "invalid_argument");
			const prefix = validateLibraryPrefix(args.path);
			return jsonResult(await listToolLibrary(ctx, args.library, prefix));
		}
		if (args.targets === undefined) throw new UserError("give targets or library", "invalid_argument");
		return runTaskTool(
			ctx,
			{ ...args, targets: args.targets },
			{ spec: { kind: "file.list", path: args.path, limit: args.limit ?? 0 } },
			"blocking",
			(started) =>
				started.kind === "task"
					? fileJsonResult(ctx, started.task, started.nodeName)
					: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		);
	},
});

const stat = define({
	name: "stat",
	description:
		"Show a file's attributes on a node (or the same path on several with targets): type, size, mode, owner, " +
		"group, modification time and link target. With `library` instead of targets, show a library file's size, " +
		"SHA-256, media type and times. The call blocks until the task ends, approval included, and returns no task id.",
	input: z.object({
		targets: libraryTargetsField,
		library: z
			.string()
			.optional()
			.describe("A library to stat instead of nodes: user:<username> or user_group:<user group name>"),
		path: z
			.string()
			.describe("A node's absolute path, or a library path relative to the library root (a leading / is optional)"),
		privileged: privilegedField,
		...fileBatchFields,
	}),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) => {
		if (args.library !== undefined) {
			if (args.targets !== undefined) throw new UserError("give targets or library, not both", "invalid_argument");
			const path = validateLibraryPath(args.path);
			const row = await statToolLibrary(ctx, args.library, path);
			return jsonResult({
				library: args.library,
				path: row.path,
				size: row.size,
				sha256: row.sha256,
				media_type: row.media_type,
				created_at: row.created_at,
				updated_at: row.updated_at,
			});
		}
		if (args.targets === undefined) throw new UserError("give targets or library", "invalid_argument");
		return runTaskTool(
			ctx,
			{ ...args, targets: args.targets },
			{ spec: { kind: "file.stat", path: args.path } },
			"blocking",
			(started) =>
				started.kind === "task"
					? fileJsonResult(ctx, started.task, started.nodeName)
					: fileJsonGroupResult(ctx, started.taskGroup, started.names),
		);
	},
});

// ---- copies and images ----

/** Collects a byte stream; image and cache reads are bounded well below memory concerns. */
async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of stream) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts);
}

/** One synthesized note line: fields inside square brackets, separated by ", ". */
function noteLine(fields: readonly string[]): string {
	return `[${fields.join(", ")}]`;
}

/** One source file of a copy: a node path, or a library path. */
const sourceLocation = z
	.union([
		z
			.object({
				node: z.string().describe("A node name or id"),
				path: z.string().describe("Absolute path on the node"),
			})
			.strict(),
		z
			.object({
				library: z.string().describe("A library: user:<username> or user_group:<user group name>"),
				path: z.string().describe("Path in the library relative to its root (a leading / is optional)"),
			})
			.strict(),
	])
	.describe("One source file: { node, path } or { library, path }");

/** A node destination; its options apply only here, so the schema says where they are allowed. */
const nodeDestination = z
	.object({
		targets: z
			.array(z.string())
			.min(1)
			.describe("Destination nodes: node names or ids, node-group names or ids, or _all"),
		path: z.string().describe("Absolute destination path on each node"),
		create_parent_dirs: z
			.boolean()
			.optional()
			.describe("Create missing parent directories first, like mkdir -p (default false)"),
		mode: z
			.string()
			.optional()
			.describe('Permission bits for a new file as an octal string, e.g. "0644" (a leading 0 is optional)'),
		owner: z.string().optional().describe("Owning user name"),
		group: z.string().optional().describe("Owning group name"),
		privileged: privilegedField,
	})
	.strict();

/** A library destination: no directories and no node-only options. */
const libraryDestination = z
	.object({
		library: z.string().describe("Destination library: user:<username> or user_group:<user group name>"),
		path: z.string().describe("Destination path in the library relative to its root (a leading / is optional)"),
	})
	.strict();

/** The no-copy destination: offer the source to the people in the session and download it at click time. */
const userInterfaceDestination = z
	.object({
		user_interface: z
			.literal(true)
			.describe(
				"Offer the file to the people in the session; nothing is copied, and the source is read only when someone downloads it, so it must stay in place",
			),
	})
	.strict();

/**
 * Removes staged transfer data without hiding the result the caller is returning: a discard failure is
 * logged, because it must not turn a finished copy into an error or replace the error that caused it.
 */
async function discardStaged(ctx: ToolContext, location: TransferLocationJson): Promise<void> {
	try {
		await openTransferLocation(ctx.cluster.transferContext(), location).discard();
	} catch (err) {
		console.error("tools: discarding staged transfer data failed:", err);
	}
}

const destinationLocation = z
	.union([nodeDestination, libraryDestination, userInterfaceDestination])
	.describe(
		"Where the file goes: a node destination { targets, path, create_parent_dirs?, mode?, owner?, group?, " +
			"privileged? }, a library destination { library, path }, or { user_interface: true }",
	);

const copyFile = define({
	name: "copy_file",
	description:
		"Copy one file, or with recursive: true one directory into a library. The source is { node, path } or " +
		"{ library, path }. The destination is a node " +
		"{ targets, path } (one or more nodes, with create_parent_dirs, mode, owner, group and privileged), a " +
		"library { library, path }, or { user_interface: true }. Node destinations create missing parent " +
		"directories only with create_parent_dirs: true; a library has no directories, so any library path " +
		"works. With user_interface nothing is copied: the file is offered to the people in the session and " +
		"read from its source only when someone clicks to download it, which may be long after this call " +
		"returns, and each click reads the file as it is then. So do not offer a temporary file, or delete, " +
		"move or change the source afterwards; to offer a temporary result, first copy it to a library and " +
		"offer the library copy. At most 5 files can be offered in one turn, and the sixth is refused. An " +
		"existing destination is refused unless overwrite is true; overwrite " +
		"applies to node and library destinations and has no effect with user_interface. A library path reaches " +
		"the libraries of the user you act for. The call blocks until every destination task ends, approval included. " +
		"recursive: true copies a whole directory, only into a library (from a node or a library), for example to " +
		"install a skill under skills/<name>. It copies file by file and is not atomic: a failure stops it, leaves the " +
		"files already copied and lists them, and copying again with overwrite replaces the directory. Symbolic links " +
		"and other non-regular files are skipped, and overwrite replaces the whole destination directory; a refused " +
		"copy changes nothing. A directory to nodes or to the user, or " +
		"one past the size limits, is refused; pack it into one archive (tar on a node) and copy that file instead.",
	input: z.object({
		source: sourceLocation,
		destination: destinationLocation,
		overwrite: z.boolean().optional(),
		recursive: z
			.boolean()
			.optional()
			.describe("Copy the directory at source.path into a library destination (default false)"),
		parallel: z.number().int().min(1).max(100).optional().describe("Nodes copied at once (default 10)"),
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) => {
		const { source, destination } = args;
		const overwrite = args.overwrite === true;
		const actor = ctx.actor;
		const chain = ctx.chain;

		if (args.recursive === true) return copyDirectory(ctx, source, destination, overwrite);
		if ("user_interface" in destination) return offerToUser(source, ctx);

		// The node destination is the only one with node-only options and several targets.
		const toNodes = "targets" in destination;
		const destinationPath = "library" in destination ? validateLibraryPath(destination.path) : destination.path;
		const mode = toNodes ? modeBits(destination.mode) : 0;
		const createParentDirs = toNodes && destination.create_parent_dirs === true;
		const privileged = toNodes && destination.privileged === true;

		if ("library" in source) {
			const sourcePath = validateLibraryPath(source.path);
			const record = await toolLibrary(ctx, source.library);
			if (!toNodes) {
				const destinationLibrary = await toolLibrary(ctx, destination.library);
				const backend = ctx.cluster.libraryBackend;
				if (!backend) throw new UserError("this crhs has no library backend");
				const file = await copyLibraryFile(
					ctx.db,
					backend,
					record.row.id,
					sourcePath,
					{ libraryId: destinationLibrary.row.id, library: destinationLibrary.row },
					destinationPath,
					overwrite,
					ctx.user.userId,
				);
				void ctx.audit?.record({
					actor: { type: actor.type, id: actor.id, onBehalfOfUserId: actor.onBehalfOfUserId },
					action: "library.file.copied",
					target: { type: "library", id: libraryRef(destinationLibrary.row, destinationLibrary.ownerName) },
					detail: {
						from_library: libraryRef(record.row, record.ownerName),
						from_path: sourcePath,
						library: libraryRef(destinationLibrary.row, destinationLibrary.ownerName),
						path: file.path,
						size: file.size,
						sha256: file.sha256,
					},
				});
				return jsonResult(
					{
						library: libraryRef(destinationLibrary.row, destinationLibrary.ownerName),
						path: file.path,
						size: file.size,
						sha256: file.sha256,
					},
					{ details: { library: libraryRef(destinationLibrary.row, destinationLibrary.ownerName), path: file.path } },
				);
			}
			const resolved = await resolveTargets(ctx.db, ctx.user, destination.targets);
			const names = await nodeNames(ctx, resolved.nodeIds);
			if (resolved.singleNode) {
				const nodeId = resolved.nodeIds[0] as string;
				const id = ctx.callKey ? derivedId(`copy:${ctx.callKey}:${nodeId}`) : undefined;
				const task = await ctx.cluster.pushLibraryFile({
					nodeId,
					libraryId: record.row.id,
					libraryPath: sourcePath,
					path: destinationPath,
					overwrite,
					mode,
					owner: destination.owner ?? "",
					group: destination.group ?? "",
					createParentDirs,
					actor,
					chain,
					privileged,
					sourceToolTask: ctx.callKey ?? null,
					...(id ? { id } : {}),
				});
				const done = (await waitBlockingTask(ctx, task.id)) ?? task;
				return fileJsonResult(ctx, done, names.get(nodeId) ?? nodeId);
			}
			const location = await ctx.cluster.stageLibrarySource(record.row.id, sourcePath);
			const id = ctx.callKey ? derivedId(`copy-group:${ctx.callKey}`) : undefined;
			let groupId: string;
			try {
				groupId = await ctx.taskGroups.create({
					spec: pushSpec(
						destinationPath,
						location,
						overwrite,
						mode,
						destination.owner ?? "",
						destination.group ?? "",
						createParentDirs,
					),
					targets: resolved.targets,
					nodeIds: resolved.nodeIds,
					transferLocation: location,
					...(args.parallel === undefined ? {} : { parallel: args.parallel }),
					actor,
					chain,
					privileged,
					sourceToolTask: ctx.callKey ?? null,
					...(id ? { id } : {}),
				});
			} catch (err) {
				// The group takes over the staged source once it exists; a failed create leaves it to discard.
				await discardStaged(ctx, location);
				throw err;
			}
			return fileJsonGroupResult(ctx, await waitBlockingGroup(ctx, groupId), names);
		}

		const sourceResolved = await resolveTargets(ctx.db, ctx.user, [source.node]);
		if (!sourceResolved.singleNode) {
			throw new UserError("source.node must name one node", "invalid_argument");
		}
		const sourceNodeId = sourceResolved.nodeIds[0] as string;
		const sourceName = (await nodeNames(ctx, [sourceNodeId])).get(sourceNodeId) ?? sourceNodeId;

		if (!toNodes) {
			const destinationLibrary = await toolLibrary(ctx, destination.library);
			const id = ctx.callKey ? derivedId(`copy:${ctx.callKey}:library`) : undefined;
			const task = await ctx.cluster.pullLibraryFile({
				nodeId: sourceNodeId,
				path: source.path,
				libraryId: destinationLibrary.row.id,
				libraryPath: destinationPath,
				overwrite,
				createdBy: ctx.user.userId,
				actor,
				chain,
				sourceToolTask: ctx.callKey ?? null,
				...(id ? { id } : {}),
			});
			const done = (await waitBlockingTask(ctx, task.id)) ?? task;
			return fileJsonResult(ctx, done, sourceName);
		}

		const resolved = await resolveTargets(ctx.db, ctx.user, destination.targets);
		const names = await nodeNames(ctx, resolved.nodeIds);
		const own = await findUserLibrary(ctx.db, ctx.user.userId);
		if (!own) throw new UserError("the acting user has no library");
		const location = ctx.cluster.stagingLocation();
		const pullId = ctx.callKey ? derivedId(`copy-pull:${ctx.callKey}`) : undefined;
		const pull = await ctx.cluster.pullFile({
			nodeId: sourceNodeId,
			path: source.path,
			maxBytes: own.row.max_file_bytes,
			location,
			actor,
			chain,
			privileged,
			sourceToolTask: ctx.callKey ?? null,
			...(pullId ? { id: pullId } : {}),
		});
		const pulled = (await waitBlockingTask(ctx, pull.id)) ?? pull;
		if (pulled.result?.kind !== "file.pull" || pulled.state !== "exited") {
			// The pull kept whatever it staged; the failed copy is over and nothing else will read it.
			await discardStaged(ctx, location);
			return fileJsonResult(ctx, pulled, sourceName);
		}
		const staged = {
			...location,
			size: pulled.result.size,
			sha256: pulled.result.sha256,
		};
		if (resolved.singleNode) {
			const nodeId = resolved.nodeIds[0] as string;
			const id = ctx.callKey ? derivedId(`copy:${ctx.callKey}:${nodeId}`) : undefined;
			try {
				const task = await ctx.cluster.pushFile({
					nodeId,
					path: destinationPath,
					location: staged,
					overwrite,
					mode,
					owner: destination.owner ?? "",
					group: destination.group ?? "",
					createParentDirs,
					actor,
					chain,
					privileged,
					sourceToolTask: ctx.callKey ?? null,
					...(id ? { id } : {}),
				});
				const done = (await waitBlockingTask(ctx, task.id)) ?? task;
				return fileJsonResult(ctx, done, names.get(nodeId) ?? nodeId);
			} finally {
				await discardStaged(ctx, location);
			}
		}
		// One group, one approval: every member streams from the same staged file, and the group
		// discards it when it ends (doc/design/library.md "Copies").
		const id = ctx.callKey ? derivedId(`copy-group:${ctx.callKey}`) : undefined;
		const groupId = await ctx.taskGroups.create({
			spec: pushSpec(
				destinationPath,
				staged,
				overwrite,
				mode,
				destination.owner ?? "",
				destination.group ?? "",
				createParentDirs,
			),
			targets: resolved.targets,
			nodeIds: resolved.nodeIds,
			transferLocation: staged,
			...(args.parallel === undefined ? {} : { parallel: args.parallel }),
			actor,
			chain,
			privileged,
			sourceToolTask: ctx.callKey ?? null,
			...(id ? { id } : {}),
		});
		return fileJsonGroupResult(ctx, await waitBlockingGroup(ctx, groupId), names);
	},
});

/** Where an offered file came from, as the WebUI resolves it when the user downloads (doc/design/library.md "Agent tools"). */
type DeliverySource =
	| { library: string; libraryId: string; path: string }
	| { node: string; nodeId: string; path: string };

/**
 * `copy_file` with a user_interface destination: stat the source so the model learns whether it exists, then
 * record it as offered. Nothing is transferred; the WebUI's download runs the ordinary download at click
 * time, under the clicking user's library or node access.
 */
async function offerToUser(
	source: { node: string; path: string } | { library: string; path: string },
	ctx: ToolContext,
): Promise<ToolResult> {
	// At most five offers per turn: a turn starts at the last user input. The sixth is refused with the limit,
	// so a model cannot flood the session with download boxes (doc/design/library.md "Deliveries").
	if (ctx.deliveryCount !== undefined && (await ctx.deliveryCount()) >= 5) {
		throw new UserError("at most 5 files can be offered to the user in one turn", "delivery_limit");
	}
	if ("library" in source) {
		const path = validateLibraryPath(source.path);
		const record = await toolLibrary(ctx, source.library);
		const row = await statToolLibrary(ctx, source.library, path);
		return deliveryResult(
			{ library: libraryRef(record.row, record.ownerName), libraryId: record.row.id, path: row.path },
			row.path.slice(row.path.lastIndexOf("/") + 1),
			row.size,
		);
	}
	const resolved = await resolveTargets(ctx.db, ctx.user, [source.node]);
	if (!resolved.singleNode) throw new UserError("source.node must name one node", "invalid_argument");
	const nodeId = resolved.nodeIds[0] as string;
	const nodeName = (await nodeNames(ctx, [nodeId])).get(nodeId) ?? nodeId;
	const id = ctx.callKey ? derivedId(`offer:${ctx.callKey}:${nodeId}`) : undefined;
	const task = await ctx.cluster.createTask({
		nodeId,
		spec: { kind: "file.stat", path: source.path },
		actor: ctx.actor,
		chain: ctx.chain,
		privileged: false,
		sourceToolTask: ctx.callKey ?? null,
		...(id ? { id } : {}),
	});
	const done = (await waitBlockingTask(ctx, task.id)) ?? task;
	if (done.state !== "exited" || done.result?.kind !== "file.stat") {
		return fileJsonResult(ctx, done, nodeName);
	}
	return deliveryResult(
		{ node: nodeName, nodeId, path: source.path },
		source.path.slice(source.path.lastIndexOf("/") + 1),
		done.result.size,
	);
}

/** The model-facing note and the `details.delivery` of an offer; the WebUI shows the delivered file from it. */
function deliveryResult(source: DeliverySource, name: string, bytes: number): ToolResult {
	const where = "library" in source ? `${source.library} at ${source.path}` : `${source.node} at ${source.path}`;
	return textResult(
		[{ note: noteLine([`copy_file offered ${name}`, `${bytes} bytes`, "to the user for download", `from ${where}`]) }],
		{ details: { delivery: { source, name, bytes } } },
	);
}

/** Node names for a set of ids, for the labels of copy results. */
async function nodeNames(ctx: ToolContext, ids: readonly string[]): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const rows = await ctx.db
		.selectFrom("nodes")
		.select(["id", "name"])
		.where("id", "in", [...ids])
		.execute();
	return new Map(rows.map((row) => [row.id, row.name] as const));
}

/** The spec of a copy group; its endpoint is a placeholder that each member replaces with its own transfer id. */
function pushSpec(
	path: string,
	location: TransferLocationJson,
	overwrite: boolean,
	mode: number,
	owner: string,
	group: string,
	createParentDirs: boolean,
): TaskSpec {
	if (location.size === null || location.sha256 === null) throw new UserError("the copy source has no size and sha256");
	return {
		kind: "file.push",
		path,
		size: location.size,
		sha256: Buffer.from(location.sha256, "hex"),
		overwrite,
		mode,
		owner,
		group,
		createParentDirs,
		endpoint: { kind: "crhs", transferId: "" },
	};
}

const viewImage = define({
	name: "view_image",
	description:
		"Look at one image from { node, path } or { library, path }. PNG, JPEG, GIF and WebP work, within the " +
		"model's image size limits; the image becomes visible to you for the rest of this conversation. A larger " +
		"image or another format is refused with the limits, so shrink it on a node first. The call blocks until " +
		"a node task ends, approval included.",
	input: z.object({
		node: z.string().optional().describe("A node name or id"),
		library: z.string().optional().describe("A library: user:<username> or user_group:<user group name>"),
		path: z
			.string()
			.describe("Absolute on a node; relative to the library root in a library (a leading / is optional)"),
	}),
	readOnly: true,
	output: "text",
	handler: async (args, ctx) => {
		if ((args.node === undefined) === (args.library === undefined)) {
			throw new UserError("give node or library, one of them", "invalid_argument");
		}
		const limits = ctx.imageLimits ?? DEFAULT_IMAGE_LIMITS;
		if (!limits.supported) {
			return errorResult(
				"text",
				"image_input_unavailable",
				"this model cannot take images; tell the user what the image is and where it is instead",
			);
		}
		if (!ctx.imageCache) {
			return errorResult("text", "image_cache_unavailable", "the image cache is not configured on this server");
		}
		let bytes: Buffer;
		let source: { library: string; path: string } | { node: string; path: string };
		let label: string;
		if (args.library !== undefined) {
			const path = validateLibraryPath(args.path);
			const record = await toolLibrary(ctx, args.library);
			const row = await statToolLibrary(ctx, args.library, path);
			const backend = ctx.cluster.libraryBackend;
			if (!backend) throw new UserError("this crhs has no library backend");
			// Check the stored size before reading the object: a large one must not be loaded only
			// to be refused below.
			const base64Bytes = Math.ceil(row.size / 3) * 4;
			if (base64Bytes > limits.maxBase64Bytes) {
				return errorResult(
					"text",
					"image_too_large",
					`the image is ${row.size} bytes, ${base64Bytes} bytes as base64; the model accepts at most ` +
						`${limits.maxBase64Bytes} bytes as base64`,
				);
			}
			bytes = await readAll(backend.get(row.object_key));
			source = { library: libraryRef(record.row, record.ownerName), path: row.path };
			label = row.path.slice(row.path.lastIndexOf("/") + 1);
		} else {
			const resolved = await resolveTargets(ctx.db, ctx.user, [args.node as string]);
			if (!resolved.singleNode) throw new UserError("node must name one node", "invalid_argument");
			const nodeId = resolved.nodeIds[0] as string;
			const name = (await nodeNames(ctx, [nodeId])).get(nodeId) ?? nodeId;
			const own = await findUserLibrary(ctx.db, ctx.user.userId);
			if (!own) throw new UserError("the acting user has no library");
			const location = ctx.cluster.stagingLocation();
			const task = await ctx.cluster.pullFile({
				nodeId,
				path: args.path,
				maxBytes: own.row.max_file_bytes,
				location,
				actor: ctx.actor,
				chain: ctx.chain,
				sourceToolTask: ctx.callKey ?? null,
				...(ctx.callKey ? { id: derivedId(`image:${ctx.callKey}`) } : {}),
			});
			const done = (await waitBlockingTask(ctx, task.id)) ?? task;
			const opened = openTransferLocation(ctx.cluster.transferContext(), location);
			try {
				if (done.result?.kind !== "file.pull" || done.state !== "exited") {
					const error = taskError(done);
					return errorResult("text", error?.code ?? "pull_failed", error?.message ?? "the file could not be read");
				}
				bytes = await readAll(opened.openRead());
			} finally {
				// A discard failure must not replace the image result or the read error.
				try {
					await opened.discard();
				} catch (err) {
					console.error("tools: discarding staged transfer data failed:", err);
				}
			}
			source = { node: name, path: args.path };
			label = args.path.slice(args.path.lastIndexOf("/") + 1);
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (ctx.imageRejected && (await ctx.imageRejected(sha256))) {
			return textResult([{ note: REJECTED_IMAGE_TEXT }]);
		}
		const header = readImageHeader(bytes);
		if (!header) {
			return errorResult(
				"text",
				"unsupported_image",
				"only PNG, JPEG, GIF and WebP images can be viewed; convert the file first",
			);
		}
		const base64Bytes = Math.ceil(bytes.length / 3) * 4;
		if (header.width > limits.maxWidth || header.height > limits.maxHeight || base64Bytes > limits.maxBase64Bytes) {
			return errorResult(
				"text",
				"image_too_large",
				`the image is ${header.width}x${header.height}, ${base64Bytes} bytes as base64; the model accepts at most ` +
					`${limits.maxWidth}x${limits.maxHeight} and ${limits.maxBase64Bytes} bytes as base64`,
			);
		}
		await ctx.imageCache.put(sha256, header.mime, bytes);
		const image = {
			sha256,
			mime: header.mime,
			width: header.width,
			height: header.height,
			bytes: bytes.length,
			source,
		};
		return textResult(
			[
				{
					note: noteLine([
						`view_image ${label}`,
						header.mime,
						`${header.width}x${header.height}`,
						`${bytes.length} bytes`,
						`sha256 ${sha256}`,
					]),
				},
			],
			{ details: { image } },
		);
	},
});

// ---- jobs ----

/** The session whose tool call started a job; null for an API token (an MCP client has no session). */
export function jobSessionId(ctx: ToolContext): string | null {
	return ctx.actor.type === "session" || ctx.actor.type === "subagent" ? ctx.actor.id : null;
}

// ---- extension tools ----

/** How much of a call's arguments the audit log keeps. */
const AUDIT_ARGUMENTS_MAX = 2000;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_SEARCH_RESULTS = 25;
const MAX_LISTED_TOOLS = 100;

function auditArguments(args: unknown): string {
	const text = JSON.stringify(args ?? {});
	return text.length > AUDIT_ARGUMENTS_MAX ? `${text.slice(0, AUDIT_ARGUMENTS_MAX)}…` : text;
}

function auditExternal(ctx: ToolContext, action: string, id: string, detail: Record<string, unknown>): void {
	if (!ctx.audit) return;
	void ctx.audit.record({
		actor: { type: ctx.actor.type, id: ctx.actor.id, onBehalfOfUserId: ctx.actor.onBehalfOfUserId },
		action,
		target: { type: "external_call", id },
		detail,
	});
}

/** One indexed tool: the fields MiniSearch ranks, plus the tool the result names. */
interface ToolSearchRecord {
	id: string;
	extension: string;
	name: string;
	title: string;
	description: string;
	tool: ExtensionTool;
}

const TOOL_SEARCH_FIELDS = ["name", "title", "description", "extension"] as const;
const TOOL_SEARCH_BOOST = { name: 3, title: 2, description: 1, extension: 1 } as const;

/** BM25 search over the tools of `entries` (name, title, description and extension name). */
function searchExtensionTools(
	entries: readonly SessionExtension[],
	query: string,
): { extension: string; score: number; tool: ExtensionTool }[] {
	if (searchQueryTerms(query).length === 0) return [];
	const records: ToolSearchRecord[] = [];
	for (const entry of entries) {
		for (const tool of entry.extension.tools()) {
			records.push({
				id: JSON.stringify([entry.extension.name, tool.name]),
				extension: entry.extension.name,
				name: tool.name,
				title: tool.title ?? "",
				description: tool.description ?? "",
				tool,
			});
		}
	}
	const search = buildSearchIndex(records, {
		fields: TOOL_SEARCH_FIELDS,
		storeFields: ["extension", "name"],
		boost: TOOL_SEARCH_BOOST,
	});
	const matches: { extension: string; score: number; tool: ExtensionTool }[] = [];
	for (const result of search.index.search(query)) {
		const record = searchIndexRecord(search, result);
		if (record) matches.push({ extension: record.extension, score: result.score, tool: record.tool });
	}
	matches.sort(
		(a, b) => b.score - a.score || a.extension.localeCompare(b.extension) || a.tool.name.localeCompare(b.tool.name),
	);
	return matches;
}

/** The session's extension list, with the owner's on/off choice. */
function sessionExtensions(ctx: ToolContext): SessionExtension[] {
	return ctx.extensions ?? [];
}

function extensionOf(ctx: ToolContext, name: string): SessionExtension {
	const entry = sessionExtensions(ctx).find((candidate) => candidate.extension.name === name);
	if (!entry) throw new UserError(`no extension named ${name} is available to this session`, "not_found");
	if (!entry.enabled) throw new UserError(`the extension ${name} is turned off for this session`, "unavailable");
	return entry;
}

/** Lists the extensions a search may use that were never listed; a cached list is searched without connecting. */
async function prepareSearchExtensions(entries: readonly SessionExtension[]): Promise<void> {
	const available = entries.filter((entry) => entry.extension.status().state !== "unavailable");
	await Promise.allSettled(available.map((entry) => entry.extension.ensureAvailable()));
}

/** The rule operation of one extension call and its evaluation along the caller's chain. */
async function evaluateExtension(
	ctx: ToolContext,
	entry: SessionExtension,
	tool: string,
	args: Record<string, unknown>,
): Promise<{ operation: Operation; evaluation: Evaluation }> {
	const operation = entry.extension.operation(tool, args);
	let chain: Awaited<ReturnType<typeof loadChain>>;
	try {
		chain = await loadChain(ctx.db, ctx.chain);
	} catch {
		return { operation, evaluation: { result: "deny", levels: [] } };
	}
	const evaluation = evaluate(chain, { ...operation, privileged: false });
	return { operation, evaluation };
}

const searchTools = define({
	name: "search_tools",
	description:
		"Search the tools of the extensions available to this session by keyword over their names, titles and " +
		"descriptions. Returns the best matches with their full input schema and annotations. Give extension to search " +
		"one extension; with extension and no query it lists that extension's tools by name and summary, paged with " +
		"offset. Call a result with call_tool.",
	input: z.object({
		query: z.string().optional().describe('Keywords, e.g. "create issue" or "query database"'),
		extension: z.string().optional().describe("Restrict the search to one extension"),
		offset: z.number().int().min(0).optional().describe("Listing mode only: skip this many tools (default 0)"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_LISTED_TOOLS)
			.optional()
			.describe("How many results (default 8, at most 25 for a search)"),
	}),
	readOnly: true,
	agentOnly: true,
	output: "json",
	handler: async (args, ctx) => {
		if (!ctx.extensions) throw new UserError("extensions are not configured", "unavailable");
		const entries = sessionExtensions(ctx);
		const query = args.query?.trim() ?? "";
		if (query === "" && args.extension === undefined) {
			// Nothing to search: show what exists, so the model can pick an extension or write a query.
			return jsonResult({
				extensions: entries.map((entry) => ({
					name: entry.extension.name,
					kind: entry.extension.kind,
					description: entry.extension.description,
					enabled: entry.enabled,
					available: entry.extension.status().state !== "unavailable",
					tool_count: entry.extension.status().toolCount,
				})),
				hint: "Give query, or extension with no query to list that extension's tools.",
			});
		}
		if (args.extension !== undefined) {
			const entry = extensionOf(ctx, args.extension);
			await prepareSearchExtensions([entry]);
			const name = entry.extension.name;
			const state = entry.extension.status();
			if (query === "") {
				const all = entry.extension.tools();
				const offset = Math.min(args.offset ?? 0, all.length);
				const limit = Math.min(args.limit ?? 25, MAX_LISTED_TOOLS);
				const page = all.slice(offset, offset + limit);
				return jsonResult({
					extension: name,
					total: all.length,
					offset,
					next_offset: offset + page.length < all.length ? offset + page.length : null,
					stale: state.state === "unavailable",
					tools: page.map((tool) => ({
						name: tool.name,
						title: tool.title,
						summary: tool.description === null ? null : tool.description.slice(0, 200),
					})),
				});
			}
			const matches = searchExtensionTools([entry], query).slice(
				0,
				Math.min(args.limit ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS),
			);
			return jsonResult({
				extension: name,
				stale: state.state === "unavailable",
				results: matches.map(({ tool }) => ({
					extension: name,
					tool: tool.name,
					title: tool.title,
					description: tool.description,
					annotations: tool.annotations,
					input_schema: tool.inputSchema,
				})),
			});
		}
		await prepareSearchExtensions(entries.filter((entry) => entry.enabled));
		const matches = searchExtensionTools(
			entries.filter((entry) => entry.enabled),
			query,
		);
		const staleExtensions = entries
			.filter((entry) => entry.extension.status().state === "unavailable")
			.map((entry) => entry.extension.name);
		return jsonResult({
			// The tool list is the last one listed: when an extension is unavailable, its results may be stale.
			...(staleExtensions.length > 0 ? { stale: true, stale_extensions: staleExtensions } : {}),
			results: matches
				.slice(0, Math.min(args.limit ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS))
				.map(({ extension, tool }) => ({
					extension,
					tool: tool.name,
					title: tool.title,
					description: tool.description,
					annotations: tool.annotations,
					input_schema: tool.inputSchema,
				})),
		});
	},
});

/**
 * The result of a tool call whose row is already terminal: the first attempt ended before this one, and its
 * result was never kept. The call is not made again. An unknown outcome keeps its own wording.
 */
function replayedResult(row: ExternalCallRow, extension: string, tool: string): ToolResult {
	const details = { extension, tool };
	switch (row.state) {
		case "running":
			return errorResult(
				"text",
				"unknown",
				"an earlier attempt of this call is still marked in flight; its outcome is unknown and it was not sent again",
				details,
			);
		case "unknown":
			return errorResult(
				"text",
				"unknown",
				"crhs stopped while the call was in flight; its outcome is unknown and it was not sent again",
				details,
			);
		default:
			return textResult(
				[
					{
						note: `[${extension}/${tool}: the call finished before a restart; its result could not be kept, and the extension was not called again]`,
					},
				],
				{ details },
			);
	}
}

/** Finishes a call and records it; every terminal path goes through here so the audit cannot be forgotten. */
async function finishCall(
	ctx: ToolContext,
	id: string,
	extension: string,
	tool: string,
	state: "succeeded" | "failed" | "rejected" | "cancelled" | "unknown",
): Promise<void> {
	await finishExternalCall(ctx.db, id, { state });
	auditExternal(ctx, "external_call.finished", id, { extension, tool, state });
}

/**
 * Ends the earlier attempt of a replayed call that cannot run now, so its row does not stay on the approvals
 * page without a waiter. The arguments go like any terminal row.
 */
async function finishOrphanedCall(
	ctx: ToolContext,
	existing: ExternalCallRow | undefined,
	extension: string,
	tool: string,
	state: "failed" | "rejected",
): Promise<void> {
	if (!existing) return;
	await finishCall(ctx, existing.id, extension, tool, state);
}

/** Ends an orphaned replay on a failure path; a failed finish is logged instead of hiding the original error. */
async function finishOrphanedCallQuietly(
	ctx: ToolContext,
	existing: ExternalCallRow | undefined,
	extension: string,
	tool: string,
	state: "failed" | "rejected",
): Promise<void> {
	try {
		await finishOrphanedCall(ctx, existing, extension, tool, state);
	} catch (err) {
		console.error("tools: finishing an orphaned extension call failed:", err);
	}
}

/** Ends a waiting replay that cannot run, keeping the text the caller receives in its job (doc/design/jobs.md "Results"). */
async function finishOrphanedWithResult(
	ctx: ToolContext,
	existing: ExternalCallRow | undefined,
	extension: string,
	tool: string,
	callKey: string,
	state: "failed" | "rejected",
	result: ToolResult,
): Promise<ToolResult> {
	await finishOrphanedCallQuietly(ctx, existing, extension, tool, state);
	await ctx.jobs?.callResult(callKey, result);
	return result;
}

/** Whether a tool changed since the call was judged: its rev moved. A built-in's tools carry no rev. */
function toolChangedSince(row: ExternalCallRow, tool: ExtensionTool): boolean {
	return row.tool_rev !== null && tool.rev !== undefined && tool.rev !== row.tool_rev;
}

/** The answer to a call made against a tool definition that changed: the current schema, to build the call again. */
function toolChangedResult(extension: string, tool: ExtensionTool): ToolResult {
	return errorResult(
		"text",
		"tool_changed",
		`the tool ${extension}/${tool.name} changed since the call was made, so it was not run; check its current input ` +
			`schema and call it again: ${JSON.stringify(tool.inputSchema)}`,
		{ extension, tool: tool.name },
	);
}

/**
 * Creates the `call` job for an external call, idempotently: a replayed tool call finds the same job. The action
 * is the one the call's approval shows.
 */
async function ensureCallJob(ctx: ToolContext, row: ExternalCallRow, callKey: string): Promise<JobRow | undefined> {
	if (!ctx.jobs) return undefined;
	return ctx.jobs.ensure({
		kind: "call",
		callKey,
		...(ctx.orgId === undefined ? {} : { orgId: ctx.orgId }),
		actor: ctx.actor,
		sessionId: jobSessionId(ctx),
		resourceType: "external_call",
		resourceId: row.id,
		action: externalCallTaskAction(row.extension_name, row.tool_name, row.arguments),
	});
}

/** The kept result of a call's job, or today's replay note when none was kept (a replay after a restart). */
async function replayCallResult(
	ctx: ToolContext,
	existing: ExternalCallRow,
	extension: string,
	tool: string,
	callKey: string,
): Promise<ToolResult> {
	const job = await ensureCallJob(ctx, existing, callKey);
	// A replayed invocation reads the settled call's result (or its terminal note): that collects the job's
	// completion notice instead of leaving it for a wake (doc/design/jobs.md "Completion notices").
	if (job) await ctx.jobs?.collect(job.id);
	const stored = parseCallResult(job?.result ?? null);
	if (stored) {
		return {
			content: stored.content,
			isError: stored.isError,
			details: { ...(stored.details ?? {}), external_call_id: existing.id },
		};
	}
	return replayedResult(existing, extension, tool);
}

/** The note of a call that has not settled: its approval link while it waits, else the job id to follow. */
function callNoteResult(row: ExternalCallRow, jobId: string | undefined, ctx: ToolContext): ToolResult {
	if (row.state === "awaiting_approval") {
		return callWaitingResult(row, jobId, ctx.externalCallUrl ?? ((id) => `/approvals/external-calls/${id}`));
	}
	if (row.state === "running") return callRunningResult(row, jobId);
	return settledCallResult(row);
}

/**
 * Starts the call in the crhs-owned runner and waits up to `waitMs` for it (doc/design/jobs.md "Background
 * extension calls"). The invocation's abort signal only ends the wait: the runner holds the request, so a call
 * that outlives the tool call still finishes and keeps its result in the job.
 */
async function startAndWaitCall(
	ctx: ToolContext,
	input: {
		row: ExternalCallRow;
		entry: SessionExtension;
		tool: ExtensionTool;
		arguments: Record<string, unknown>;
		callKey: string;
		waitMs: number;
	},
): Promise<ToolResult> {
	const { row, entry, tool, arguments: callArguments, callKey, waitMs } = input;
	const ensured = await ensureCallJob(ctx, row, callKey);
	const jobs = ctx.jobs;
	// The job may have been created under the limit lock while the call still looked like Auto Review; project
	// it again now that routing decided whether it is a user-facing approval wait.
	const job = ensured && jobs ? ((await jobs.project(ensured)) ?? ensured) : ensured;
	const running = ctx.callRunner.start({
		db: ctx.db,
		callKey,
		row,
		extension: entry.extension,
		tool: tool.name,
		arguments: callArguments,
		userId: ctx.user.userId,
		...(ctx.audit ? { audit: ctx.audit } : {}),
		...(ctx.imageCache ? { imageCache: ctx.imageCache } : {}),
		...(jobs
			? {
					jobs: {
						callResult: (key: string, result: ToolResult) => jobs.callResult(key, result),
						callChanged: (key: string) => jobs.callChanged(key),
					},
				}
			: {}),
		identity: { username: ctx.user.username, sessionId: ctx.actor.id },
		convert: (value, options) => convertExternalResult(value as CallToolResult, options),
	});
	const release = job === undefined ? undefined : jobs?.beginWait(job.id);
	let settled = false;
	try {
		settled = await running.wait(waitMs, ctx.signal);
	} finally {
		release?.();
	}
	if (settled) {
		const outcome = await running.done;
		if (outcome.error !== undefined) throw outcome.error;
		if (outcome.result !== undefined) {
			if (jobs && job) await jobs.collect(job.id);
			return outcome.result;
		}
	}
	const current = (await getExternalCall(ctx.db, row.id)) ?? row;
	if (jobs && job) {
		const projected = await jobs.get(job.id);
		// The call settled at the deadline: return what a settled job returns, not a stale running note.
		if (projected?.state === "settled") {
			await jobs.collect(job.id);
			return jobs.render((await jobs.get(job.id)) ?? projected, ctx);
		}
	}
	if (settled && jobs && job) await jobs.collect(job.id);
	return callNoteResult(current, job?.id, ctx);
}

/**
 * Runs one extension call under the rules and approvals (doc/design/extensions.md "Rules and approvals" and
 * "External calls"): a denied call never starts, an approval waits in the WebUI (or Auto Review settles it), and
 * the call itself is never repeated after a connection loss or a restart. The extension supplies its own rule
 * operation, so an MCP tool and a built-in API request are judged the same way.
 */
export async function runExtensionTool(
	ctx: ToolContext,
	extensionName: string,
	toolName: string,
	arguments_: Record<string, unknown>,
	waitSeconds?: number,
): Promise<ToolResult> {
	if (!ctx.extensions) throw new UserError("extensions are not configured", "unavailable");
	// An MCP request has no durable call, so it gets a fresh key and a retried request is a new call and job
	// (doc/design/jobs.md "Ids").
	const callKey = ctx.callKey ?? newId();
	const limited = await jobLimitResult(ctx, "call", callKey);
	if (limited) return limited;
	const waitMs = Math.min(Math.max(0, waitSeconds ?? ctx.defaultWaitS ?? 30), 600) * 1000;
	// The row id derives from durable's tool call key, which is unique; the same key is recorded
	// (source_tool_task) for Auto Review to find exactly this call in the transcript.
	const id = externalCallId(callKey);
	// A replayed tool call finds its row and returns what the first attempt produced, without connecting again.
	const existing = await getExternalCall(ctx.db, id);
	// A replayed tool call finds its row: a running one is followed when this process holds it, a terminal one
	// already ran and is never sent again.
	if (existing && existing.state !== "awaiting_approval") {
		const running = ctx.callRunner.get(id);
		if (running && existing.state === "running") {
			const job = await ensureCallJob(ctx, existing, callKey);
			const result = await startAndWaitOnCall(ctx, running, job, waitMs);
			return { ...result, details: { ...(result.details ?? {}), external_call_id: id } };
		}
		return replayCallResult(ctx, existing, extensionName, toolName, callKey);
	}
	let entry: SessionExtension;
	try {
		entry = extensionOf(ctx, extensionName);
	} catch (err) {
		// The extension was disabled, deleted or ungranted since the first attempt, so its waiting row has
		// nobody left to run it.
		await finishOrphanedCallQuietly(ctx, existing, extensionName, toolName, "failed");
		await ctx.jobs?.callChanged(callKey);
		throw err;
	}
	const extension = entry.extension;
	// The definition the model most likely built its arguments from: the one it could have found before this call.
	const seen = extension.tools().find((candidate) => candidate.name === toolName);
	try {
		// Connects now and brings the tool list up to date, so the call is judged on the server's current
		// definitions (doc/design/extensions.md "MCP connections").
		await extension.prepareCall();
	} catch (err) {
		return finishOrphanedWithResult(
			ctx,
			existing,
			extensionName,
			toolName,
			callKey,
			"failed",
			errorResult("text", "unavailable", `the extension ${extensionName} is unavailable: ${(err as Error).message}`, {
				extension: extensionName,
			}),
		);
	}
	let tool = extension.tools().find((candidate) => candidate.name === toolName);
	if (!tool) {
		// A tool can be new since the last listing; one refresh makes a just-added tool callable.
		try {
			await extension.refreshTools();
			tool = extension.tools().find((candidate) => candidate.name === toolName);
		} catch {
			// The listing failed; the original "no such tool" is the useful answer.
		}
	}
	if (!tool) {
		return finishOrphanedWithResult(
			ctx,
			existing,
			extensionName,
			toolName,
			callKey,
			"failed",
			errorResult("text", "unknown_tool", `the extension ${extensionName} has no tool named ${toolName}`, {
				extension: extensionName,
				tool: toolName,
			}),
		);
	}
	// A waiting call from an earlier attempt was judged on the tool as it was then; a changed tool ends it.
	if (existing && toolChangedSince(existing, tool)) {
		return finishOrphanedWithResult(
			ctx,
			existing,
			extensionName,
			toolName,
			callKey,
			"failed",
			toolChangedResult(extensionName, tool),
		);
	}
	// Arguments built for an input schema the server no longer has would be read differently: ask again.
	if (!existing && seen !== undefined && !sameInputSchema(seen, tool)) return toolChangedResult(extensionName, tool);
	let operation: Operation;
	let evaluation: Evaluation;
	try {
		({ operation, evaluation } = await evaluateExtension(ctx, entry, toolName, arguments_));
	} catch (err) {
		// A built-in extension refuses a call in its operation before any rule or external call exists, e.g. an
		// API route its document marks deny (doc/design/extensions.md "API requests").
		if (!(err instanceof UserError)) throw err;
		return finishOrphanedWithResult(
			ctx,
			existing,
			extensionName,
			toolName,
			callKey,
			"failed",
			errorResult("text", err.code ?? "invalid_argument", err.message, {
				extension: extensionName,
				tool: toolName,
			}),
		);
	}
	if (evaluation.result === "deny") {
		return finishOrphanedWithResult(
			ctx,
			existing,
			extensionName,
			toolName,
			callKey,
			"rejected",
			errorResult("text", "policy_denied", "denied by the authorization rules", {
				extension: extensionName,
				tool: toolName,
			}),
		);
	}
	let row: ExternalCallRow;
	if (existing) {
		row = existing;
	} else {
		// Auto Review judging this call must not look like a user-facing approval: the pending marker is
		// written with the row, and only a routing to an agent or the final verdict replaces it.
		// Auto Review judges tool calls, so a call without a durable tool task is the user's from the start.
		const reviewPlanned =
			evaluation.result === "require-approval" &&
			ctx.callKey !== undefined &&
			(await ctx.willReview?.(ctx.chain)) === true;
		// The count and the creation of the row and its job are one step under the session's job lock, so two
		// parallel calls cannot both start when only one slot is left (doc/design/jobs.md "Limit").
		const started = await withJobLimit(ctx, "call", callKey, async () => {
			const created = await createExternalCall(ctx.db, {
				callKey,
				sourceToolTask: ctx.callKey ?? null,
				orgId: await defaultOrgId(ctx.db),
				actorType: ctx.actor.type,
				actorId: ctx.actor.id,
				onBehalfOfUserId: ctx.actor.onBehalfOfUserId,
				extension: extensionName,
				tool: toolName,
				arguments: arguments_,
				operation,
				annotations: tool.annotations,
				toolRev: tool.rev ?? null,
				ruleChain: ctx.chain,
				rootSessionId: ctx.rootSessionId ?? null,
				approval: { evaluation, ...(reviewPlanned ? { review: pendingReview(new Date().toISOString()) } : {}) },
				state: evaluation.result === "allow" ? "running" : "awaiting_approval",
			});
			if (created.created) {
				auditExternal(ctx, "external_call.started", id, {
					extension: extensionName,
					tool: toolName,
					arguments: auditArguments(arguments_),
					state: created.row.state,
				});
			}
			// The job exists before the lock is released, so the slot is counted for the next start.
			await ensureCallJob(ctx, created.row, callKey);
			return created;
		});
		if ("refused" in started) return started.refused;
		row = started.value.row;
	}
	if (row.state === "awaiting_approval") {
		// Up the chain first, like a task: an ancestor's agent decides; only when none takes it does Auto
		// Review judge it (once), then the owner in the WebUI (doc/design/access-control.md "Approvals").
		// A call that is not being reviewed is a user-facing wait, so the session may now follow it.
		const reviewPending = isPendingReview(externalCallApproval(row)?.review);
		const routed = row.handler_type === "agent" || (await ctx.routeExternalCall?.(id)) === true;
		const existingReview = externalCallApproval(row)?.review;
		// While Auto Review judges the call the transcript keeps its in-progress look: the phase says so, and
		// there is no approval link yet. The status that follows the verdict replaces these details.
		if (!routed && reviewPending) {
			await ctx.onStatus?.({ external_call_id: id, state: "awaiting_approval", phase: "reviewing" });
		}
		// A pending marker is a review the last process did not finish: run it again (the reviewer is single-flight).
		if (!routed && (existingReview === undefined || isPendingReview(existingReview))) {
			await ctx.reviewExternalCall?.(id, ctx.signal);
		}
		if (!routed && !reviewPending) ctx.onApprovalChange?.(ctx.actor.id);
		row = (await getExternalCall(ctx.db, id)) ?? row;
		// The invocation no longer waits for the decision here: the runner waits in the background and starts
		// the request when it is approved. The approval link is announced while the call still waits.
		if (row.state === "awaiting_approval") {
			await ctx.onStatus?.({
				external_call_id: id,
				state: "awaiting_approval",
				approval_url: ctx.externalCallUrl?.(id) ?? `/approvals/external-calls/${id}`,
			});
		} else {
			// The review settled it: the live details no longer carry the approval link.
			await ctx.onStatus?.({ external_call_id: id, state: row.state });
			ctx.onApprovalChange?.(ctx.actor.id);
		}
	}
	if (row.state !== "running" && row.state !== "awaiting_approval") {
		await ensureCallJob(ctx, row, callKey);
		return settledCallResult(row);
	}
	const result = await startAndWaitCall(ctx, { row, entry, tool, arguments: arguments_, callKey, waitMs });
	const finalRow = (await getExternalCall(ctx.db, id)) ?? row;
	if (finalRow.state !== "awaiting_approval" && finalRow.state !== "running") {
		// The call ended while this invocation waited: drop the approval link from the live details and let the
		// session state follow the now settled call.
		await ctx.onStatus?.({ external_call_id: id, state: finalRow.state });
		ctx.onApprovalChange?.(ctx.actor.id);
	}
	return result;
}

/** Waits on an in-flight call a replay found; the result is the same text the starting invocation would get. */
async function startAndWaitOnCall(
	ctx: ToolContext,
	running: RunningCall,
	job: JobRow | undefined,
	waitMs: number,
): Promise<ToolResult> {
	const release = job === undefined ? undefined : ctx.jobs?.beginWait(job.id);
	let settled = false;
	try {
		if (await running.wait(waitMs, ctx.signal)) {
			const outcome = await running.done;
			if (outcome.error !== undefined) throw outcome.error;
			settled = true;
			if (outcome.result !== undefined) return outcome.result;
		}
	} finally {
		release?.();
	}
	const current = (await getExternalCall(ctx.db, running.callId)) ?? undefined;
	if (ctx.jobs && job) {
		const projected = await ctx.jobs.get(job.id);
		if (projected?.state === "settled") {
			await ctx.jobs.collect(job.id);
			return ctx.jobs.render((await ctx.jobs.get(job.id)) ?? projected, ctx);
		}
	}
	if (settled && job) await ctx.jobs?.collect(job.id);
	return current === undefined
		? textResult([{ note: "[the record behind this job is no longer kept]" }])
		: callNoteResult(current, job?.id, ctx);
}
const callTool = define({
	name: "call_tool",
	description:
		"Call a tool of an extension with arguments (a JSON object matching the tool's input schema, as search_tools " +
		"returns it). The call runs in the background after `wait`: a call that settles in time returns its result, " +
		"otherwise the waiting or still-running note with its job id. The call may wait for the user's approval. A " +
		"call that ends unknown may have run on the extension; it is not retried.",
	input: z.object({
		extension: z.string().describe("The extension's name, as search_tools lists it"),
		tool: z.string().describe("The tool's name on that extension"),
		arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments; omit for no arguments"),
		wait: waitField,
	}),
	readOnly: false,
	agentOnly: true,
	output: "text",
	handler: async (args, ctx) => runExtensionTool(ctx, args.extension, args.tool, args.arguments ?? {}, args.wait),
});

export const TOOLS: readonly ClusterTool[] = [
	listNodes,
	nodeInfo,
	exec,
	readFile,
	writeFile,
	editFile,
	listDir,
	stat,
	copyFile,
	viewImage,
	searchTools,
	callTool,
	...JOB_TOOLS,
	...TODO_TOOLS,
] as unknown as ClusterTool[];
