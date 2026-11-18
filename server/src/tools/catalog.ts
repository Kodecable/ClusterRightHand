import { createHash } from "node:crypto";
import type { Evaluation, Operation } from "@crh/api";
import type { TaskSpec } from "@crh/protocol";
import type { CallToolResult } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { isPendingReview, pendingReview } from "../cluster/approval.ts";
import { type Actor, type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { listNodesForUser, type PublicNode } from "../cluster/nodes.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { resolveTargets } from "../cluster/task-groups.ts";
import {
	createExternalCall,
	type ExternalCallRow,
	externalCallApproval,
	externalCallId,
	finishExternalCall,
	getExternalCall,
	waitExternalCall,
} from "../extensions/external-calls.ts";
import {
	ExtensionCallLostError,
	type ExtensionTool,
	ExtensionToolError,
	ExtensionUnavailableError,
	type SessionExtension,
} from "../extensions/model.ts";
import { buildSearchIndex, searchIndexRecord, searchQueryTerms } from "../extensions/search-index.ts";
import { extensionsForUser } from "../extensions/store.ts";
import { copyLibraryFile } from "../library/files.ts";
import { type ImageCache, REJECTED_IMAGE_TEXT } from "../library/image-cache.ts";
import { readImageHeader } from "../library/image-header.ts";
import { findUserLibrary, libraryRef } from "../library/library.ts";
import { validateLibraryPath, validateLibraryPrefix } from "../library/paths.ts";
import { openTransferLocation, type TransferLocationJson } from "../library/transfer-location.ts";
import { evaluate } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import { sessionDescendants } from "../sessions/session-chain.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import { UserError } from "../util/errors.ts";
import { derivedId, newId } from "../util/id.ts";
import { convertExternalResult } from "./external-results.ts";
import { listToolLibrary, statToolLibrary, toolLibrary } from "./library-access.ts";
import { nodeInfoFields, readNotes, readNotesBatch } from "./node-info.ts";
import { errorResult, jsonResult, type ToolOutput, type ToolResult, textResult } from "./render.ts";
import {
	execResult,
	execTaskResult,
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
	type NodeTransport,
	READ_PAGE_LINES,
	runTaskTool,
	waitBlockingGroup,
	waitBlockingTask,
	waitExistingGroup,
	waitExistingTask,
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
	/** Agents keep waiting while a task waits for approval (MCP returns and follows up with task_wait). */
	waitThroughApproval?: boolean;
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
	.describe("Seconds to wait for the result; after that the task keeps running and task_wait follows it up");
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

const nodeInfo = define({
	name: "node_info",
	description:
		"Facts about one or more nodes (targets): OS, kernel, architecture, init system, package managers and node " +
		"groups, plus each node's notes, a Markdown file on the node that people and agents keep up to date. Exactly " +
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
		"Returns the command's output and exit status as text; long-running tasks return a task_id to follow with " +
		"task_wait. A batch runs one task per node and returns each node's output tail as text, within one budget " +
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
		);
	},
});

const readFile = define({
	name: "read_file",
	description:
		"Read a file on a node, or the same file on several nodes with targets. Lines are 1-based: read " +
		`${READ_PAGE_LINES} lines from \`offset\` (default 1), whole lines only, at most 50 KB per call. The page is ` +
		"returned exactly as it is in the file; its bracketed note gives the line range, and only a page that reached " +
		"the end of the file reports the total. Use offset to continue. In a batch, limit (default 128) is each node's " +
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
	return Number.parseInt(mode, 8);
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
		user_interface: z.literal(true).describe("Offer the file to the people in the session; nothing is copied"),
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
		"Copy one file. The source is { node, path } or { library, path }. The destination is a node " +
		"{ targets, path } (one or more nodes, with create_parent_dirs, mode, owner, group and privileged), a " +
		"library { library, path }, or { user_interface: true }. Node destinations create missing parent " +
		"directories only with create_parent_dirs: true; a library has no directories, so any library path " +
		"works. With user_interface nothing is copied: the file is offered to the people in the session and " +
		"downloaded at click time; at most 5 files can be offered in one turn, and the sixth is refused. An " +
		"existing destination is refused unless overwrite is true; overwrite " +
		"applies to node and library destinations and has no effect with user_interface. A library path reaches " +
		"the libraries of the user you act for. The call blocks until every destination task ends, approval included.",
	input: z.object({
		source: sourceLocation,
		destination: destinationLocation,
		overwrite: z.boolean().optional(),
		parallel: z.number().int().min(1).max(100).optional().describe("Nodes copied at once (default 10)"),
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) => {
		const { source, destination } = args;
		const overwrite = args.overwrite === true;
		const actor = ctx.actor;
		const chain = ctx.chain;

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
				.select(["id", "name", "transport", "privileged_mode", "ssh_user"])
				.where("id", "in", done.nodeIds)
				.execute();
			const names = new Map(nodes.map((n) => [n.id, n.name] as const));
			const transports = new Map(nodes.map((n) => [n.id, n.transport as NodeTransport] as const));
			const privileges = new Map(
				nodes.map(
					(n) =>
						[
							n.id,
							{
								transport: n.transport as NodeTransport,
								mode: n.privileged_mode,
								sshUser: n.ssh_user,
							},
						] as const,
				),
			);
			return execResult(ctx, { kind: "task_group", taskGroup: done, names, transports, privileges });
		}
		if (!args.task_id) throw new UserError("give task_id or task_group_id", "invalid_argument");
		const t = await ownTask(ctx, args.task_id);
		if (t.kind !== "exec") throw new UserError("no such task", "no_such_task");
		const done = (await waitExistingTask(ctx, t.id, waitMs)) ?? t;
		const node = await ctx.db
			.selectFrom("nodes")
			.select(["name", "transport", "privileged_mode", "ssh_user"])
			.where("id", "=", t.nodeId)
			.executeTakeFirst();
		return execTaskResult(
			ctx,
			done,
			node?.name ?? t.nodeId,
			(node?.transport as NodeTransport | undefined) ?? "client",
			node === undefined
				? undefined
				: {
						transport: node.transport as NodeTransport,
						mode: node.privileged_mode,
						sshUser: node.ssh_user,
					},
		);
	},
});

const taskCancel = define({
	name: "task_cancel",
	description:
		"Cancel a running exec task (TERM, then KILL after a grace period) or an exec task group (stops its workers " +
		"and every unfinished member). File tools never return task ids, so they cannot be cancelled.",
	input: z.object({
		task_id: z.string().optional(),
		task_group_id: z.string().optional(),
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) => {
		if (args.task_group_id) {
			const group = await ctx.taskGroups.get(args.task_group_id);
			if (
				!group ||
				group.onBehalfOfUserId !== ctx.user.userId ||
				!(await mayActFor(ctx, group.actorType, group.actorId)) ||
				group.kind !== "exec"
			) {
				throw new UserError("no such task group", "no_such_task");
			}
			return jsonResult({
				task_group_id: group.id,
				cancel_sent: await ctx.taskGroups.cancel(group.id, undefined, ctx.actor),
			});
		}
		if (!args.task_id) throw new UserError("give task_id or task_group_id", "invalid_argument");
		const t = await ownTask(ctx, args.task_id);
		if (t.kind !== "exec") throw new UserError("no such task", "no_such_task");
		return jsonResult({ task_id: t.id, cancel_sent: await ctx.cluster.cancelTask(t.id, undefined, ctx.actor) });
	},
});

/**
 * Whether the caller may act on work started for `actorType` / `actorId` (doc/design/agent-runtime.md "Cluster tools",
 * doc/design/access-control.md "Actors"): its own session or token, or a session in its subtree. Anything else, even
 * another session of the same user, is out of reach; the conservative reading, because the docs scope a tool
 * to the caller's own work.
 */
async function mayActFor(ctx: ToolContext, actorType: string, actorId: string): Promise<boolean> {
	if (ctx.actor.type === actorType && ctx.actor.id === actorId) return true;
	// Only a session has a subtree; an API token's own tasks are the only ones it may touch.
	if (ctx.actor.type !== "session" && ctx.actor.type !== "subagent") return false;
	if (actorType !== "session" && actorType !== "subagent") return false;
	const descendants = await sessionDescendants(ctx.db, ctx.actor.id);
	return descendants.includes(actorId);
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

/** Connects the extensions a search may use; failures leave them unavailable with their last known tools. */
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

/** The result of a call settled while this tool call waited: rejected and cancelled end here, never at the extension. */
function settledResult(row: ExternalCallRow, extension: string, tool: string): ToolResult {
	const details = { extension, tool };
	if (row.state === "rejected") {
		return errorResult(
			"text",
			"rejected",
			externalCallApproval(row)?.decision?.reason ?? "rejected by the user",
			details,
		);
	}
	if (row.state === "cancelled") {
		return errorResult("text", "cancelled", "the call was cancelled before it ran", details);
	}
	if (row.state === "awaiting_approval") {
		// Only a shutdown leaves the waiting call in place after the wait returns; it was never sent.
		return errorResult("text", "unknown", "the call is still waiting for approval; it was not sent", details);
	}
	return replayedResult(row, extension, tool);
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

/** Finishes a call on a failure path; a failed finish is logged instead of hiding the error being returned. */
async function finishCallQuietly(
	ctx: ToolContext,
	id: string,
	extension: string,
	tool: string,
	state: "succeeded" | "failed" | "rejected" | "cancelled" | "unknown",
): Promise<void> {
	try {
		await finishCall(ctx, id, extension, tool, state);
	} catch (err) {
		console.error("tools: finishing an extension call failed:", err);
	}
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

/**
 * Runs one extension call under the rules and approvals (doc/design/extensions.md "Rules and approvals" and
 * "External calls"): a denied call never starts, an approval waits in the WebUI (or Auto Review settles it),
 * and the call itself is never repeated after a connection loss or a restart. The extension supplies its own
 * rule operation, so an MCP tool and a built-in API request are judged the same way.
 */
export async function runExtensionTool(
	ctx: ToolContext,
	extensionName: string,
	toolName: string,
	arguments_: Record<string, unknown>,
): Promise<ToolResult> {
	if (!ctx.extensions) throw new UserError("extensions are not configured", "unavailable");
	// The row id derives from durable's tool call key, which is unique; the same key is recorded
	// (source_tool_task) for Auto Review to find exactly this call in the transcript.
	const callKey = ctx.callKey ?? newId();
	const id = externalCallId(callKey);
	// A replayed tool call finds its row and returns what the first attempt produced, without connecting again.
	const existing = await getExternalCall(ctx.db, id);
	// A replayed tool call finds its row: a running one is never sent again, and a terminal one already ran.
	if (existing && existing.state !== "awaiting_approval") return replayedResult(existing, extensionName, toolName);
	let entry: SessionExtension;
	try {
		entry = extensionOf(ctx, extensionName);
	} catch (err) {
		// The extension was disabled, deleted or ungranted since the first attempt, so its waiting row has
		// nobody left to run it.
		await finishOrphanedCallQuietly(ctx, existing, extensionName, toolName, "failed");
		throw err;
	}
	const extension = entry.extension;
	try {
		await extension.ensureAvailable({ immediate: true });
	} catch (err) {
		await finishOrphanedCallQuietly(ctx, existing, extensionName, toolName, "failed");
		return errorResult(
			"text",
			"unavailable",
			`the extension ${extensionName} is unavailable: ${(err as Error).message}`,
			{ extension: extensionName },
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
		await finishOrphanedCallQuietly(ctx, existing, extensionName, toolName, "failed");
		return errorResult("text", "unknown_tool", `the extension ${extensionName} has no tool named ${toolName}`, {
			extension: extensionName,
			tool: toolName,
		});
	}
	let operation: Operation;
	let evaluation: Evaluation;
	try {
		({ operation, evaluation } = await evaluateExtension(ctx, entry, toolName, arguments_));
	} catch (err) {
		// A built-in extension refuses a call in its operation before any rule or external call exists, e.g. an
		// API route its document marks deny (doc/design/extensions.md "API requests").
		if (!(err instanceof UserError)) throw err;
		await finishOrphanedCallQuietly(ctx, existing, extensionName, toolName, "failed");
		return errorResult("text", err.code ?? "invalid_argument", err.message, {
			extension: extensionName,
			tool: toolName,
		});
	}
	if (evaluation.result === "deny") {
		await finishOrphanedCall(ctx, existing, extensionName, toolName, "rejected");
		return errorResult("text", "policy_denied", "denied by the authorization rules", {
			extension: extensionName,
			tool: toolName,
		});
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
			ruleChain: ctx.chain,
			rootSessionId: ctx.rootSessionId ?? null,
			approval: { evaluation, ...(reviewPlanned ? { review: pendingReview(new Date().toISOString()) } : {}) },
			state: evaluation.result === "allow" ? "running" : "awaiting_approval",
		});
		row = created.row;
		if (created.created) {
			auditExternal(ctx, "external_call.started", id, {
				extension: extensionName,
				tool: toolName,
				arguments: auditArguments(arguments_),
				state: row.state,
			});
		}
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
		// The approval link is announced by `onWaiting`, only while the call still waits: a call Auto Review
		// just approved must not flash an approval in the transcript.
		row = await waitExternalCall(ctx.db, id, {
			...(ctx.signal ? { signal: ctx.signal } : {}),
			cancelOnAbort: !ctx.closing?.(),
			onCancelled: () => {
				// A call aborted before it ran never reached the extension; record that like any other end.
				auditExternal(ctx, "external_call.finished", id, {
					extension: extensionName,
					tool: toolName,
					state: "cancelled",
					reason: "the tool call was aborted",
				});
			},
			onWaiting: async () => {
				await ctx.onStatus?.({
					external_call_id: id,
					state: "awaiting_approval",
					approval_url: ctx.externalCallUrl?.(id) ?? `/approvals/external-calls/${id}`,
				});
			},
		});
		// The wait is over: the live details no longer carry the approval link, so a finished call's card
		// cannot keep pointing at an approval that is already settled. A shutdown keeps the waiting state.
		if (row.state !== "awaiting_approval") {
			await ctx.onStatus?.({ external_call_id: id, state: row.state });
			ctx.onApprovalChange?.(ctx.actor.id);
		}
	}
	if (row.state !== "running") return settledResult(row, extensionName, toolName);
	// The approval may have waited a long time: a grant revoked, or the extension disabled, while it waited
	// means nobody may run this call now. Read the user's availability again instead of trusting the dispatch
	// snapshot, and end the call without contacting the extension.
	const available = await extensionsForUser(ctx.db, ctx.user.userId);
	if (!available.some((candidate) => candidate.name === extensionName)) {
		await finishCallQuietly(ctx, id, extensionName, toolName, "failed");
		return errorResult("text", "unavailable", `the extension ${extensionName} is no longer available to you`, {
			extension: extensionName,
			tool: toolName,
		});
	}
	let resultValue: unknown;
	try {
		resultValue = await extension.call(toolName, arguments_, {
			...(ctx.signal ? { signal: ctx.signal } : {}),
			identity: { username: ctx.user.username, sessionId: ctx.actor.id },
			builtin: {
				db: ctx.db,
				actor: { type: ctx.actor.type, id: ctx.actor.id, onBehalfOfUserId: ctx.actor.onBehalfOfUserId },
			},
		});
	} catch (err) {
		if (err instanceof UserError) {
			// The built-in refused the call itself (a bad argument, an unknown document); it never ran.
			await finishCallQuietly(ctx, id, extensionName, toolName, "failed");
			return errorResult("text", err.code ?? "invalid_argument", err.message, {
				extension: extensionName,
				tool: toolName,
			});
		}
		if (err instanceof ExtensionUnavailableError) {
			await finishCallQuietly(ctx, id, extensionName, toolName, "failed");
			return errorResult("text", "unavailable", err.message, { extension: extensionName, tool: toolName });
		}
		if (err instanceof ExtensionToolError) {
			await finishCallQuietly(ctx, id, extensionName, toolName, "failed");
			return errorResult("text", "tool_error", err.message, { extension: extensionName, tool: toolName });
		}
		if (err instanceof ExtensionCallLostError) {
			// A lost call is not retried. On shutdown the row stays running so the next start recovers it as unknown.
			if (!ctx.closing?.()) await finishCallQuietly(ctx, id, extensionName, toolName, "unknown");
			return errorResult("text", "unknown", `${err.message}; its outcome is unknown and it was not retried`, {
				extension: extensionName,
				tool: toolName,
			});
		}
		// An unexpected exception may have reached the server, so the outcome is not known.
		await finishCallQuietly(ctx, id, extensionName, toolName, "unknown");
		throw err;
	}
	let converted: ToolResult;
	try {
		converted = await convertExternalResult(resultValue as CallToolResult, {
			extension: extensionName,
			tool: toolName,
			...(ctx.imageCache ? { imageCache: ctx.imageCache } : {}),
		});
	} catch (err) {
		// The call reached the server but its result could not be converted; it must not stay running.
		await finishCallQuietly(ctx, id, extensionName, toolName, "unknown");
		throw err;
	}
	await finishCall(ctx, id, extensionName, toolName, "succeeded");
	return converted;
}

const callTool = define({
	name: "call_tool",
	description:
		"Call a tool of an extension with arguments (a JSON object matching the tool's input schema, as search_tools " +
		"returns it). The call may wait for the user's approval. A call that ends unknown may have run on the " +
		"extension; it is not retried.",
	input: z.object({
		extension: z.string().describe("The extension's name, as search_tools lists it"),
		tool: z.string().describe("The tool's name on that extension"),
		arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments; omit for no arguments"),
	}),
	readOnly: false,
	agentOnly: true,
	output: "text",
	handler: async (args, ctx) => runExtensionTool(ctx, args.extension, args.tool, args.arguments ?? {}),
});

/**
 * A task the caller may act on: started for the same user **and** for its own session or token (or a session
 * below it). Another session of the same user keeps its tasks (doc/design/agent-runtime.md "Cluster tools").
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
	copyFile,
	viewImage,
	taskWait,
	taskCancel,
	searchTools,
	callTool,
] as unknown as ClusterTool[];
