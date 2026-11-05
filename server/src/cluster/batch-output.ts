import { UserError } from "../users/service.ts";
import { countOutputLines, StreamAccumulator } from "./output.ts";

/**
 * Caps for one batch node, and for the whole group: exec `text` nodes keep a tail, file operations
 * (`head`) keep the head of each node's page (doc/execution-plane.md#输出).
 */
export const BATCH_NODE_BYTES = 8 * 1024;
export const BATCH_NODE_LINES = 128;
export const BATCH_GROUP_BYTES = 50 * 1024;
export const BATCH_GROUP_LINES = 2_000;

/** The caps of one budget window, and of a single task's merged tail (D112). */
export interface OutputLimits {
	maxLines: number;
	maxBytes: number;
}

/** What a window keeps: the head of the stream, or its tail. */
export type Retention = "head" | "tail";

export type OutputStream = "stdout" | "stderr";
export type OutputModeKind = "full" | "text" | "status" | "head";

/** What crhs keeps of a task when it ends or is viewed while running. Null means "this mode keeps none". */
export interface OutputSnapshot {
	stdoutBytes: number;
	stderrBytes: number;
	stdoutHead: Buffer | null;
	stdoutTail: Buffer | null;
	stderrHead: Buffer | null;
	stderrTail: Buffer | null;
	/** A single task's merged stdout+stderr tail in arrival order (D112). */
	outputTail: Buffer | null;
}

/**
 * Validates a caller's per-node output budget (doc/agent-runtime.md#批量执行): 1..2000 lines and
 * 1..50KiB, which is also the whole group's budget. Undefined keeps the default for the mode.
 */
export function checkedOutputLimits(
	maxLines?: number,
	maxBytes?: number,
): { maxLines: number | null; maxBytes: number | null } {
	if (maxLines !== undefined && (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > BATCH_GROUP_LINES)) {
		throw new UserError(`maxLines must be between 1 and ${BATCH_GROUP_LINES}`);
	}
	if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > BATCH_GROUP_BYTES)) {
		throw new UserError(`maxBytes must be between 1 and ${BATCH_GROUP_BYTES}`);
	}
	return { maxLines: maxLines ?? null, maxBytes: maxBytes ?? null };
}

/**
 * The output budget of one batch group and of one single task's merged tail: every node draws grants
 * from it in arrival order, and crhs keeps no more than the sum of the grants
 * (doc/execution-plane.md#输出). `text` (exec) and `head` (file operations) measure the same budget;
 * only what each node keeps of its output differs.
 */
export class GroupBudget {
	/** The caps of one node's window; a node never draws more than these from the group. */
	readonly nodeMaxLines: number;
	readonly nodeMaxBytes: number;
	readonly totalLines: number;
	readonly totalBytes: number;
	bytesLeft: number;
	linesLeft: number;

	constructor(options: { node?: OutputLimits; total?: OutputLimits } = {}) {
		const total = options.total ?? { maxLines: BATCH_GROUP_LINES, maxBytes: BATCH_GROUP_BYTES };
		const node = options.node ?? { maxLines: BATCH_NODE_LINES, maxBytes: BATCH_NODE_BYTES };
		this.totalLines = total.maxLines;
		this.totalBytes = total.maxBytes;
		this.nodeMaxLines = Math.min(node.maxLines, this.totalLines);
		this.nodeMaxBytes = Math.min(node.maxBytes, this.totalBytes);
		this.bytesLeft = this.totalBytes;
		this.linesLeft = this.totalLines;
	}
}

/** The output side of a running task, uniform over the modes. */
export interface LiveTask {
	readonly mode: OutputModeKind;
	/** Returns false when the chunk leaves a gap; overlapping resends are skipped. */
	append(stream: OutputStream, offset: number, data: Uint8Array): boolean;
	/** Bytes received so far on a stream: the offset acknowledged to crha. */
	end(stream: OutputStream): number;
	/** `ends` overrides the byte totals, e.g. with task.exit's ends for a status task. */
	snapshot(ends?: Partial<Record<OutputStream, number>>): OutputSnapshot;
	/**
	 * A line crhs itself puts in front of the task's own output (the SSH privileged notice). It is stderr
	 * for the modes that keep output; a status task keeps no output but must still show this line.
	 */
	note(text: Uint8Array): void;
}

/** Picks the accumulator for the mode; a `text` or `head` task must share its group's budget. */
export function createLiveTask(mode: OutputModeKind, budget?: GroupBudget, limits?: OutputLimits): LiveTask {
	switch (mode) {
		case "full":
			return new FullOutput(limits);
		case "text":
			if (!budget) throw new Error("text output needs a group budget");
			return new BatchAccumulator("text", budget);
		case "head":
			if (!budget) throw new Error("head output needs a group budget");
			return new BatchAccumulator("head", budget);
		case "status":
			return new StatusOutput();
	}
}

/**
 * One node's share of its group's budget. A grant only grows: bytes that leave a kept window are
 * never returned to the group, so the memory held is the sum of the grants (doc/execution-plane.md#输出).
 */
class NodeGrant {
	readonly #budget: GroupBudget;
	#bytes = 0;
	#lines = 0;

	constructor(budget: GroupBudget) {
		this.#budget = budget;
	}

	/** The grant this node has drawn from the group, in bytes and newline characters. */
	get bytes(): number {
		return this.#bytes;
	}

	get lines(): number {
		return this.#lines;
	}

	/** Takes what it can of one chunk: at most the per-node caps and what the group has left. */
	take(fresh: Buffer): void {
		const bytes = Math.max(0, Math.min(fresh.length, this.#budget.nodeMaxBytes - this.#bytes, this.#budget.bytesLeft));
		this.#bytes += bytes;
		this.#budget.bytesLeft -= bytes;
		// A window of N bytes holds at most N newlines: never grant lines the node has no bytes for.
		const lines = Math.max(
			0,
			Math.min(
				countNewlines(fresh),
				this.#budget.nodeMaxLines - this.#lines,
				this.#budget.linesLeft,
				this.#bytes - this.#lines,
			),
		);
		this.#lines += lines;
		this.#budget.linesLeft -= lines;
	}
}

/**
 * One node's kept window over the shared budget: the same grant bookkeeping for both retention kinds.
 * It records how many lines the window shows, so the tool layer can write "lines X-Y of N".
 */
class BudgetedWindow {
	readonly #grant: NodeGrant;
	readonly #retention: Retention;
	#kept = Buffer.alloc(0);

	constructor(budget: GroupBudget, retention: Retention) {
		this.#grant = new NodeGrant(budget);
		this.#retention = retention;
	}

	get grant(): { bytes: number; lines: number } {
		return { bytes: this.#grant.bytes, lines: this.#grant.lines };
	}

	/** Lines the kept window shows; a last line without a newline counts as one. */
	get keptLines(): number {
		return countOutputLines(this.#kept);
	}

	append(fresh: Buffer): void {
		this.#grant.take(fresh);
		if (this.#retention === "head") {
			// The grant is the cap on the whole head, in bytes and in lines like a text tail: keep the
			// first bytes of the stream, but no more lines than the node was granted.
			const room = this.#grant.bytes - this.#kept.length;
			if (room > 0) this.#kept = Buffer.concat([this.#kept, fresh.subarray(0, Math.min(room, fresh.length))]);
			this.#trimHead();
			return;
		}
		// No byte grant: the whole node may be dropped; crha is still acked by the advanced end.
		if (this.#grant.bytes === 0) return;
		this.#kept = Buffer.concat([this.#kept, fresh]);
		this.#trimTail();
	}

	kept(): Buffer {
		return Buffer.from(this.#kept);
	}

	/** Cuts the head after its line grant, like the byte grant the append already applies. */
	#trimHead(): void {
		const head = headLines(this.#kept, this.#grant.lines);
		if (head.length !== this.#kept.length) this.#kept = Buffer.from(head);
	}

	/** Cuts the tail to its byte grant from a line boundary, then to its line grant. */
	#trimTail(): void {
		const before = this.#kept;
		if (before.length === 0) return;
		const start = before.length > this.#grant.bytes ? before.length - this.#grant.bytes : 0;
		if (start > 0) {
			// The cut can land inside a multi-byte character: skip its continuation bytes so the tail decodes.
			let from = start;
			while (from < before.length && ((before[from] ?? 0) & 0xc0) === 0x80) from++;
			let bytes = before.subarray(from);
			// A rolled tail starts at a whole line: drop the partial first line unless the cut already
			// landed on a line boundary. One unfinished line with no newline at all is still the last
			// line, so it stays.
			if (before[from - 1] !== 0x0a) {
				const newline = bytes.indexOf(0x0a);
				if (newline >= 0) bytes = bytes.subarray(newline + 1);
			}
			const tail = tailByNewlines(bytes, this.#grant.lines);
			if (tail.length !== before.length) this.#kept = Buffer.from(tail);
			return;
		}
		const tail = tailByNewlines(before, this.#grant.lines);
		if (tail !== before) this.#kept = Buffer.from(tail);
	}
}

/**
 * A batch node: an exec node (`text`) keeps one combined tail of stdout and stderr in arrival order;
 * a file operation (`head`) keeps the head of stdout, so every node's page can be continued from its
 * own next line, and no node stderr: a file task's structured result is `task.exit.result`, not a line
 * in a stream. Grants grow with the bytes that arrive, up to the per-node caps; output past a grant
 * is dropped.
 */
export class BatchAccumulator implements LiveTask {
	readonly mode: "text" | "head";
	readonly #window: BudgetedWindow;
	readonly #ends: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
	/** `head` only: the lines crhs writes itself (the SSH privileged notice), never the node's stderr. */
	#note: Buffer | null = null;

	constructor(mode: "text" | "head", budget: GroupBudget) {
		this.mode = mode;
		this.#window = new BudgetedWindow(budget, mode === "text" ? "tail" : "head");
	}

	/** The grant this node has drawn from the group, in bytes and newline characters. */
	get grant(): { bytes: number; lines: number } {
		return this.#window.grant;
	}

	/** Lines the kept window shows (the merged tail, or the page head). */
	get keptLines(): number {
		return this.#window.keptLines;
	}

	end(stream: OutputStream): number {
		return this.#ends[stream];
	}

	note(text: Uint8Array): void {
		const bytes = Buffer.from(text);
		if (this.mode === "head") {
			// A status-like line of crhs's own: a head node keeps no other stderr.
			this.#ends.stderr += bytes.length;
			this.#note = this.#note === null ? bytes : Buffer.concat([this.#note, bytes]);
			return;
		}
		this.append("stderr", this.end("stderr"), bytes);
	}

	append(stream: OutputStream, offset: number, data: Uint8Array): boolean {
		const end = this.#ends[stream];
		if (offset > end) return false;
		const skip = end - offset;
		if (skip >= data.length) return true;
		const fresh = Buffer.from(data.subarray(skip));
		this.#ends[stream] = end + fresh.length;

		if (this.mode === "head" && stream === "stderr") {
			// A head node keeps no stderr: a file task reports its result in task.exit, and the count
			// above is all crhs needs to acknowledge the bytes (doc/protocol.md TaskResult).
			return true;
		}

		this.#window.append(fresh);
		return true;
	}

	/** The combined tail of a text node, or the stdout head of a head node; never over the grant. */
	kept(): Buffer {
		return this.#window.kept();
	}

	snapshot(ends?: Partial<Record<OutputStream, number>>): OutputSnapshot {
		const stdoutBytes = ends?.stdout ?? this.#ends.stdout;
		const stderrBytes = ends?.stderr ?? this.#ends.stderr;
		if (this.mode === "head") {
			return {
				stdoutBytes,
				stderrBytes,
				stdoutHead: this.kept(),
				stdoutTail: null,
				stderrHead: this.#note === null ? null : Buffer.from(this.#note),
				stderrTail: null,
				outputTail: null,
			};
		}
		return {
			stdoutBytes,
			stderrBytes,
			stdoutHead: null,
			stdoutTail: this.kept(),
			stderrHead: null,
			stderrTail: null,
			outputTail: null,
		};
	}
}

/** A `status` task: crhs keeps only per-stream byte counts, plus the notices crhs writes itself. */
class StatusOutput implements LiveTask {
	readonly mode = "status";
	readonly #ends: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
	/** Lines crhs adds before the task's own output: the only stderr text a status task keeps. */
	#note: Buffer | null = null;

	end(stream: OutputStream): number {
		return this.#ends[stream];
	}

	note(text: Uint8Array): void {
		const bytes = Buffer.from(text);
		this.#ends.stderr += bytes.length;
		this.#note = this.#note === null ? bytes : Buffer.concat([this.#note, bytes]);
	}

	append(stream: OutputStream, offset: number, data: Uint8Array): boolean {
		const end = this.#ends[stream];
		if (offset > end) return false;
		const skip = end - offset;
		if (skip < data.length) this.#ends[stream] = end + data.length - skip;
		return true;
	}

	snapshot(ends?: Partial<Record<OutputStream, number>>): OutputSnapshot {
		return {
			stdoutBytes: ends?.stdout ?? this.#ends.stdout,
			stderrBytes: ends?.stderr ?? this.#ends.stderr,
			stdoutHead: null,
			stdoutTail: null,
			stderrHead: this.#note,
			stderrTail: null,
			outputTail: null,
		};
	}
}

/**
 * A single task: the existing per-stream head and tail, unchanged for the WebUI, plus one merged
 * stdout+stderr tail in arrival order (D112). The merged tail is what the model sees.
 */
class FullOutput implements LiveTask {
	readonly mode = "full";
	readonly #stdout = new StreamAccumulator();
	readonly #stderr = new StreamAccumulator();
	readonly #merged: BudgetedWindow;

	constructor(limits?: OutputLimits) {
		const total = limits ?? { maxLines: BATCH_GROUP_LINES, maxBytes: BATCH_GROUP_BYTES };
		// A single task's total budget is its own cap; the budget component still does the rolling.
		this.#merged = new BudgetedWindow(new GroupBudget({ node: total, total }), "tail");
	}

	#stream(stream: OutputStream): StreamAccumulator {
		return stream === "stderr" ? this.#stderr : this.#stdout;
	}

	end(stream: OutputStream): number {
		return this.#stream(stream).end;
	}

	note(text: Uint8Array): void {
		this.append("stderr", this.end("stderr"), text);
	}

	append(stream: OutputStream, offset: number, data: Uint8Array): boolean {
		const fresh = this.#stream(stream).append(offset, data);
		if (fresh === null) return false;
		if (fresh.length > 0) this.#merged.append(fresh);
		return true;
	}

	/** Lines the merged tail shows; the same count the stored output_tail has. */
	get outputTailLines(): number {
		return this.#merged.keptLines;
	}

	snapshot(): OutputSnapshot {
		return {
			stdoutBytes: this.#stdout.end,
			stderrBytes: this.#stderr.end,
			stdoutHead: this.#stdout.head(),
			stdoutTail: this.#stdout.tail(),
			stderrHead: this.#stderr.head(),
			stderrTail: this.#stderr.tail(),
			outputTail: this.#merged.kept().length > 0 ? this.#merged.kept() : null,
		};
	}
}

function countNewlines(buf: Buffer): number {
	let count = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
	return count;
}

/**
 * Keeps a tail with at most `maxNewlines` newline characters, starting after the earliest excess
 * newline so the window still starts at a line boundary. A partial last line is not counted, so it
 * stays until its newline arrives (or the line grant is 0 and it is all that is left).
 */
function tailByNewlines(buf: Buffer, maxNewlines: number): Buffer {
	const excess = countNewlines(buf) - maxNewlines;
	if (excess <= 0) return buf;
	let seen = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== 0x0a) continue;
		seen++;
		if (seen === excess) return buf.subarray(i + 1);
	}
	return buf.subarray(buf.length);
}

/**
 * Keeps the first `lines` lines of a head: the buffer ends after the newline that ends the last kept
 * line. A first line that has not ended yet stays until more arrives, like a tail keeps its
 * unfinished last line; with no line granted, only bytes before the first newline can stay.
 */
function headLines(buf: Buffer, lines: number): Buffer {
	let count = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== 0x0a) continue;
		count++;
		if (count === lines) return buf.subarray(0, i + 1);
	}
	if (lines <= 0 && count > 0) return buf.subarray(0, 0);
	return buf;
}
