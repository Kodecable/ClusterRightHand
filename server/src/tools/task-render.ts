/**
 * How a crh task tool's result reaches the model and the UI (doc/design/agent-runtime.md "Tool output"):
 * `exec` and `read_file` are text (raw block plus note block per node, a task group leading with a group
 * note), every other tool is one compact JSON block. UI details keep the shape the WebUI reads today
 * (task_id / task_group_id, state, per-node states, error codes).
 */
import type { JsonTaskResult } from "@crh/protocol";
import { countOutputLines, type TaskView } from "../cluster/cluster.ts";
import type { TaskGroupView } from "../cluster/task-groups.ts";
import { GROUP_TERMINAL } from "../cluster/types.ts";
import type { ToolContext } from "./catalog.ts";
import { jsonResult, type TextBlock, type ToolResult, textResult } from "./render.ts";
import { MAX_OUTPUT_BYTES, type NodePrivilege, type NodeTransport, type Started } from "./task-tool.ts";

// ---- details for the UI ----

/** One task's details, the shape the WebUI's tool cards read today (doc/design/agent-runtime.md "Tool output"). */
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

/** Whether a task result counts as failed (doc/design/agent-runtime.md "Tool output"): denied/rejected/unknown, a nonzero exit, a signal, a timeout or a cancel. */
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

/** One synthesized note line: fields inside square brackets, separated by ", ". */
function noteLine(fields: readonly string[]): string {
	return `[${fields.join(", ")}]`;
}

/**
 * How a privileged task was applied, as the note line says: the node's mode, or the SSH notice already
 * recorded on the task (doc/design/privilege.md "Privilege modes").
 */
function privilegeField(task: TaskView, info: NodePrivilege | undefined): string | undefined {
	if (!task.privileged) return undefined;
	if (info?.transport === "ssh") return `privileged ignored: SSH runs as ${info.sshUser ?? "the SSH user"}`;
	if (info?.mode === "forward" || info?.mode === "native") return `privileged via ${info.mode}`;
	if (info?.mode === "ignore") return "privileged ignored";
	return "privileged";
}

/** `<node, exit 0>`, `<node, error <code>: <message>>`, and the waiting variants. */
function taskStatusLine(task: TaskView, label: string, info?: NodePrivilege): string {
	const privilege = privilegeField(task, info);
	const withPrivilege = (fields: string[]): string =>
		noteLine(privilege === undefined ? fields : [...fields, privilege]);
	if (task.timedOut) {
		const timeout = task.timeoutMs === null ? "timed out" : `timed out after ${seconds(task.timeoutMs)}`;
		return withPrivilege([label, timeout]);
	}
	if (task.signal !== null && task.signal !== "") return withPrivilege([label, `killed by ${task.signal}`]);
	if (task.state === "unknown") {
		const code = task.errorCode ?? "unknown";
		const reason = task.errorMessage === null ? "" : ` (${task.errorMessage})`;
		return withPrivilege([label, `error ${code}: execution failed; the outcome is unknown${reason}`]);
	}
	if (task.errorCode !== null) return withPrivilege([label, `error ${task.errorCode}: ${task.errorMessage ?? ""}`]);
	if (task.state === "exited") {
		const fields = [label, `exit ${task.exitCode ?? 0}`];
		if (task.cancelled) fields.push("cancelled");
		return withPrivilege(fields);
	}
	if (task.exitCode !== null) {
		const fields = [label, `exit ${task.exitCode}`];
		if (task.cancelled) fields.push("cancelled");
		return withPrivilege(fields);
	}
	if (task.state === "failed" || task.state === "denied" || task.state === "rejected") {
		const error = taskError(task);
		return withPrivilege([label, `error ${error?.code ?? task.state}: ${error?.message ?? ""}`]);
	}
	return withPrivilege([label, task.state]);
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

/** The "Showing lines X-Y of N …" hint that follows truncated exec output, as its own bracketed line. */
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

/** crhs's own note about the task (the SSH privileged notice), bracketed on its own line. */
function noticeLine(task: TaskView, info?: NodePrivilege): string | undefined {
	if (task.notice === null || task.notice.trim() === "") return undefined;
	// The status line already says how privilege was applied; the notice only repeats it.
	if (privilegeField(task, info)?.startsWith("privileged ignored") && task.notice.includes("privileged was ignored")) {
		return undefined;
	}
	return task.notice
		.trim()
		.split(/\r?\n/)
		.map((line) => noteLine([line.trim()]))
		.join("\n");
}

/** Adds the task's notice as the last line of a note block. */
function withNotice(note: string, task: TaskView, info?: NodePrivilege): string {
	const notice = noticeLine(task, info);
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
	privilege?: NodePrivilege,
): ToolResult {
	const details = taskDetails(task, nodeName);
	// with_output: false keeps only the status; the model gets JSON, like a status batch.
	if (task.outputMode === "status") {
		return jsonResult(statusNode(ctx, task, nodeName), { isError: taskFailed(task), details });
	}
	const waiting = waitingLine(task, nodeName, ctx, true);
	if (waiting !== undefined) {
		// A long-running task still returns the output it has produced so far (doc/design/agent-runtime.md "exec tool semantics").
		const { text } = taskSourceText(task);
		const note = [waiting, noticeLine(task, privilege)].filter((line): line is string => line !== undefined).join("\n");
		return textResult([{ output: text, note }], { details });
	}
	const { text, keptLines } = taskSourceText(task);
	const note = [
		taskStatusLine(task, nodeName, privilege),
		truncationHint(keptLines, task.outputLines, task.outputFile, transport, bytesTruncated(task, text)),
		noticeLine(task, privilege),
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
	} else if (group.state === "cancelled") {
		fields.push("cancelled");
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
	privileges?: Map<string, NodePrivilege>,
): ToolResult {
	const blocks: TextBlock[] = [{ note: groupTextNote(ctx, group, true) }];
	for (const task of group.tasks) {
		const nodeName = names.get(task.nodeId) ?? task.nodeId;
		const transport = transports?.get(task.nodeId) ?? "client";
		const privilege = privileges?.get(task.nodeId);
		const waiting = waitingLine(task, nodeName, ctx, false);
		if (waiting !== undefined) {
			const { text } = taskSourceText(task);
			const note = [waiting, noticeLine(task, privilege)]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			blocks.push({ output: text, note });
			continue;
		}
		const { text, keptLines } = taskSourceText(task);
		const note = [
			taskStatusLine(task, nodeName, privilege),
			truncationHint(keptLines, task.outputLines, task.outputFile, transport, bytesTruncated(task, text)),
			noticeLine(task, privilege),
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
	if (started.kind === "task") {
		return execTaskResult(ctx, started.task, started.nodeName, started.transport, started.privilege);
	}
	const { taskGroup, names, transports, privileges } = started;
	return taskGroup.outputMode === "text"
		? groupTextResult(ctx, taskGroup, names, transports, privileges)
		: execGroupStatusResult(ctx, taskGroup, names);
}

// ---- file results (JSON for everything but read_file) ----

/** The fields of a task's structured result in their snake_case JSON form (doc/design/protocol.md "Task results"). */
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
		case "file.pull":
			return { size: result.size, sha256: result.sha256 };
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
	// crhs's own line (the SSH privileged notice) is not part of the output.
	if (task.notice !== null) out.notice = task.notice;
	const error = taskError(task);
	if (error !== undefined) out.error = error;
	return out;
}

/** A single blocking file task as JSON; a failure is the bare `{"error": …}`. */
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

/** The page one file.read task reports as its result (doc/design/protocol.md "Task results"). */
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
 * total is never reported for a page that did not reach the end (doc/design/agent-runtime.md "Tool output").
 */
function readPage(
	ctx: ToolContext,
	task: TaskView,
	label: string,
	path: string,
	startLine: number,
	maxBytes: number | undefined,
	privilege?: NodePrivilege,
): PageRead {
	// Every note line says how privilege was applied when the task was privileged.
	const privileged = privilegeField(task, privilege);
	const noteFor = (fields: string[]): string => noteLine(privileged === undefined ? fields : [...fields, privileged]);
	if (isWaiting(task) || isRunning(task)) {
		return { output: "", note: waitingLine(task, label, ctx, false) ?? taskStatusLine(task, label, privilege) };
	}
	if (task.state !== "exited" || task.errorCode !== null) {
		const status = taskStatusLine(task, label, privilege);
		return { output: "", note: status, ...(taskError(task) ? { error: taskError(task) } : {}) };
	}
	const page = pageResultOf(task.result);
	if (!page) {
		const error = { code: PAGE_MISSING, message: "the node reported no file.read result" };
		return { output: "", note: noteFor([label, `error ${error.code}: ${error.message}`]), error };
	}
	const failure = pageFailure(page, startLine, path);
	if (failure) {
		return { output: "", note: noteFor([label, `error ${failure.code}: ${failure.message}`]), error: failure };
	}
	if (page.from === 0) return { output: "", note: noteFor([label, "the file is empty"]) };

	// The page may be cut by the per-node byte budget (single task `max_bytes`, or a batch node's grant).
	// A batch head that dropped its whole grant, or cut it mid-line, is finished at its last whole line.
	if (task.outputBytes > 0 && task.outputHead === "" && page.to >= page.from) {
		return {
			output: "",
			note: noteFor([label, "no page was kept for this node (batch budget); read it on its own"]),
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
		return { output: "", note: noteFor([label, `error ${error.code}: ${error.message}`]), error };
	}
	const to = page.from + keptLines - 1;
	const more = !page.eof || to < page.to;
	const note = more
		? noteFor([label, `lines ${page.from}-${to}. Use offset=${to + 1} to continue.`])
		: noteFor([label, `lines ${page.from}-${to}${page.total === null ? "" : ` of ${page.total}`} (end of file)`]);
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
	privilege?: NodePrivilege,
): ToolResult {
	const details = taskDetails(task, nodeName);
	const page = readPage(ctx, task, `${nodeName}:${path}`, path, startLine, maxBytes, privilege);
	return textResult([{ output: page.output, note: withNotice(page.note, task, privilege) }], {
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
	privileges?: Map<string, NodePrivilege>,
): ToolResult {
	const pages = group.tasks.map((task) => {
		const nodeName = names.get(task.nodeId) ?? task.nodeId;
		return {
			task,
			privilege: privileges?.get(task.nodeId),
			page: readPage(ctx, task, `${nodeName}:${path}`, path, startLine, maxBytes, privileges?.get(task.nodeId)),
		};
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
	for (const { task, page, privilege } of pages) {
		blocks.push({ output: page.output, note: withNotice(page.note, task, privilege) });
	}
	return textResult(blocks, {
		isError: groupFailed(group) || failedPages > 0,
		details: groupDetails(group, names),
	});
}
