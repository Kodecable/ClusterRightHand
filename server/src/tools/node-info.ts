/**
 * What node_info returns for one node (doc/design/agent-runtime.md "Cluster tools"): its facts and its notes, a
 * Markdown file on the node read through an ordinary file.read task, with one shared budget for a batch.
 */
import type { JsonFacts, TaskSpec } from "@crh/protocol";
import { BATCH_GROUP_BYTES, BATCH_GROUP_LINES, BATCH_NODE_BYTES, BATCH_NODE_LINES } from "../cluster/batch-output.ts";
import type { TaskView } from "../cluster/cluster.ts";
import { getNode, type PublicNode } from "../cluster/nodes.ts";
import { derivedId } from "../util/id.ts";
import type { ToolContext } from "./catalog.ts";
import { READ_PAGE_LINES } from "./task-tool.ts";

/** Node notes shown by node_info are cut here; read_file gives the rest (doc/design/agent-runtime.md "Defaults"). */
const NOTES_BYTES = 8 * 1024;
/** A batch keeps this many lines of each node's notes; the whole batch shares one budget. */
const NOTES_LINES = BATCH_NODE_LINES;
/** How long node_info waits for one node's notes read. */
const NOTES_WAIT_MS = 15_000;

/** Facts in their snake_case JSON form (the protocol's wire keys, doc/design/protocol.md "Events"). */
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

/** The read of a node's notes: the same page size as read_file; node_info caps what it shows. */
function notesSpec(path: string): TaskSpec {
	return { kind: "file.read", path, startLine: 1, lineCount: READ_PAGE_LINES };
}

/** The notes fields node_info returns: the path, the kept content and why some of it is missing. */
function notesFields(
	path: string,
	content: string | null,
	extra: { note?: string; truncated?: string } = {},
): Record<string, unknown> {
	return {
		path,
		content,
		...(extra.note === undefined ? {} : { note: extra.note }),
		...(extra.truncated === undefined ? {} : { truncated: extra.truncated }),
	};
}

/** The notes of a read task that did not finish; undefined when it read the file. */
function notesUnavailable(path: string, task: TaskView): Record<string, unknown> | undefined {
	if (task.state === "exited" && task.errorCode === null) return undefined;
	const missing = task.errorCode === "not_found";
	return notesFields(path, null, {
		note: missing ? "no notes yet; create the file with write_file" : `could not read: ${task.errorCode ?? task.state}`,
	});
}

/** A single node's notes: its head cut at 8 KB; only a page that reached the end is the whole file. */
function singleNotes(path: string, task: TaskView): Record<string, unknown> {
	const unavailable = notesUnavailable(path, task);
	if (unavailable !== undefined) return unavailable;
	const text = task.outputHead;
	const page = task.result?.kind === "file.read" ? task.result : undefined;
	const cut = Buffer.byteLength(text) > NOTES_BYTES || page?.eof !== true;
	const content = cut
		? Buffer.from(text)
				.subarray(0, NOTES_BYTES)
				.toString("utf8")
				.replace(/\uFFFD+$/, "")
		: text;
	return notesFields(
		path,
		content,
		cut ? { truncated: `first ${NOTES_BYTES} bytes shown; read the whole file with read_file` } : {},
	);
}

/** The shared notes budget of one node_info batch: 8 KB / 128 lines per node, 50 KB / 2000 lines total. */
interface NotesBudget {
	bytes: number;
	lines: number;
}

function notesBudget(): NotesBudget {
	return { bytes: BATCH_GROUP_BYTES, lines: BATCH_GROUP_LINES };
}

/** The first `lines` lines of a head; a last line without a newline stays. */
function headLines(text: string, lines: number): string {
	let seen = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) !== 0x0a) continue;
		if (++seen === lines) return text.slice(0, i + 1);
	}
	return text;
}

function newlineCount(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) count++;
	return count;
}

/** Takes one node's notes head from the batch budget; null means the batch kept nothing for it. */
function takeNotes(text: string, budget: NotesBudget): string | null {
	if (text === "") return "";
	if (budget.bytes <= 0 || budget.lines <= 0) return null;
	const bytes = Math.min(Buffer.byteLength(text), BATCH_NODE_BYTES, budget.bytes);
	let kept = Buffer.from(text)
		.subarray(0, bytes)
		.toString("utf8")
		.replace(/\uFFFD+$/, "");
	kept = headLines(kept, Math.min(NOTES_LINES, budget.lines));
	budget.bytes -= Buffer.byteLength(kept);
	budget.lines -= newlineCount(kept);
	return kept;
}

/** A batch node's notes: its kept head under the shared budget, and whether the file had more. */
function batchNotes(path: string, task: TaskView, budget: NotesBudget): Record<string, unknown> {
	const unavailable = notesUnavailable(path, task);
	if (unavailable !== undefined) return unavailable;
	const text = task.outputHead;
	const kept = takeNotes(text, budget);
	if (kept === null) {
		return notesFields(path, null, {
			note: "no part of the notes was kept (batch budget); read the file with read_file",
		});
	}
	const page = task.result?.kind === "file.read" ? task.result : undefined;
	const more =
		page?.eof !== true ||
		Buffer.byteLength(text) > Buffer.byteLength(kept) ||
		task.outputBytes > Buffer.byteLength(text);
	return notesFields(
		path,
		kept,
		more ? { truncated: `first ${Buffer.byteLength(kept)} bytes shown; read the whole file with read_file` } : {},
	);
}

/**
 * One node's notes, read through an ordinary (audited) file.read task, but only when the rules allow that
 * read outright: node_info never leaves an approval request behind.
 */
export async function readNotes(ctx: ToolContext, nodeId: string, path: string): Promise<Record<string, unknown>> {
	const node = await getNode(ctx.db, nodeId);
	if (node?.status !== "active") return notesFields(path, null, { note: "the node is not active" });
	if ((await ctx.cluster.evaluateFor(node, notesSpec(path), ctx.chain, false)).result !== "allow") {
		return notesFields(path, null, { note: "reading it needs approval here; use read_file" });
	}
	const id = ctx.callKey ? derivedId(`notes:${ctx.callKey}`) : undefined;
	const created = await ctx.cluster.createTask({
		nodeId,
		spec: notesSpec(path),
		actor: ctx.actor,
		chain: ctx.chain,
		...(id ? { id } : {}),
	});
	const t = (await ctx.cluster.waitTask(created.id, NOTES_WAIT_MS, ctx.signal)) ?? created;
	return singleNotes(path, t);
}

/**
 * The notes of a batch's nodes, read only where the rules allow it outright. Each node gets its own
 * head-mode task, so its notes path can differ; the batch shares one 50 KB / 2000 line budget.
 */
export async function readNotesBatch(
	ctx: ToolContext,
	nodes: readonly PublicNode[],
): Promise<Map<string, Record<string, unknown>>> {
	const out = new Map<string, Record<string, unknown>>();
	const readable: { node: PublicNode; path: string }[] = [];
	for (const node of nodes) {
		const path = node.facts?.notesPath;
		if (path === undefined || path === "") continue;
		const row = await getNode(ctx.db, node.id);
		if (row?.status !== "active") {
			out.set(node.id, notesFields(path, null, { note: "the node is not active" }));
			continue;
		}
		if ((await ctx.cluster.evaluateFor(row, notesSpec(path), ctx.chain, false)).result !== "allow") {
			out.set(node.id, notesFields(path, null, { note: "reading it needs approval here; use read_file" }));
			continue;
		}
		readable.push({ node, path });
	}
	const created = await Promise.all(
		readable.map(({ node, path }) => {
			const id = ctx.callKey ? derivedId(`notes:${ctx.callKey}:${node.id}`) : undefined;
			return ctx.cluster.createTask({
				nodeId: node.id,
				spec: notesSpec(path),
				outputMode: "head",
				maxLines: NOTES_LINES,
				maxBytes: NOTES_BYTES,
				actor: ctx.actor,
				chain: ctx.chain,
				...(id ? { id } : {}),
			});
		}),
	);
	const tasks = await Promise.all(created.map((t) => ctx.cluster.waitTask(t.id, NOTES_WAIT_MS, ctx.signal)));
	const budget = notesBudget();
	readable.forEach(({ node, path }, i) => {
		out.set(node.id, batchNotes(path, tasks[i] ?? (created[i] as TaskView), budget));
	});
	return out;
}

/** The JSON fields of one node in node_info (doc/design/agent-runtime.md "Cluster tools"). */
export async function nodeInfoFields(
	ctx: ToolContext,
	node: PublicNode,
	notes: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	const row = await getNode(ctx.db, node.id);
	return {
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
		notes,
	};
}
