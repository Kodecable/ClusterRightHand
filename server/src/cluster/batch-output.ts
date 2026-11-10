import { UserError } from "../util/errors.ts";
import { countOutputLines, StreamAccumulator } from "./output.ts";

/**
 * Caps for one batch node, and for the whole group: exec `text` nodes keep a tail, file operations
 * (`head`) keep the head of each node's page (doc/design/execution.md "Output").
 */
export const BATCH_NODE_BYTES = 8 * 1024;
export const BATCH_NODE_LINES = 128;
export const BATCH_GROUP_BYTES = 50 * 1024;
export const BATCH_GROUP_LINES = 2_000;

/** The caps of one budget window, and of a single task's merged tail. */
export interface OutputLimits {
	maxLines: number;
	maxBytes: number;
}

/** What a window keeps: the head of the stream, or its tail. */
export type Retention = "head" | "tail";

export type OutputModeKind = "full" | "text" | "status" | "head";

/** What crhs keeps of a task when it ends or is viewed while running. Null means "this mode keeps none". */
export interface OutputSnapshot {
	/** Bytes of the single output stream. */
	outputBytes: number;
	/** The kept head of the stream, for the modes that keep one. */
	outputHead: Buffer | null;
	/** The kept tail of the stream, for the modes that keep one. */
	outputTail: Buffer | null;
}

/**
 * Validates a caller's per-node output budget (doc/design/agent-runtime.md "Batch execution"): 1..2000 lines and
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
 * (doc/design/execution.md "Output"). `text` (exec) and `head` (file operations) measure the same budget;
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

/** The output side of a running task, uniform over the modes (one stream). */
export interface LiveTask {
	readonly mode: OutputModeKind;
	/** Returns false when the chunk leaves a gap; overlapping resends are skipped. */
	append(offset: number, data: Uint8Array): boolean;
	/** Bytes received so far: the offset acknowledged to crha. */
	get end(): number;
	/** `bytes` overrides the total, e.g. with task.exit's output end for a status task. */
	snapshot(bytes?: number): OutputSnapshot;
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
 * never returned to the group, so the memory held is the sum of the grants (doc/design/execution.md "Output").
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
 * A batch node: an exec node (`text`) keeps the tail of the single output stream; a file operation
 * (`head`) keeps the head of it, so every node's page can be continued from its own next line. Grants
 * grow with the bytes that arrive, up to the per-node caps; output past a grant is dropped.
 * crhs's own notice is not output any more: it is stored in `tasks.notice`.
 */
export class BatchAccumulator implements LiveTask {
	readonly mode: "text" | "head";
	readonly #window: BudgetedWindow;
	#end = 0;

	constructor(mode: "text" | "head", budget: GroupBudget) {
		this.mode = mode;
		this.#window = new BudgetedWindow(budget, mode === "text" ? "tail" : "head");
	}

	/** The grant this node has drawn from the group, in bytes and newline characters. */
	get grant(): { bytes: number; lines: number } {
		return this.#window.grant;
	}

	/** Lines the kept window shows (the tail, or the page head). */
	get keptLines(): number {
		return this.#window.keptLines;
	}

	get end(): number {
		return this.#end;
	}

	append(offset: number, data: Uint8Array): boolean {
		if (offset > this.#end) return false;
		const skip = this.#end - offset;
		if (skip >= data.length) return true;
		const fresh = Buffer.from(data.subarray(skip));
		this.#end += fresh.length;
		this.#window.append(fresh);
		return true;
	}

	/** The tail of a text node, or the head of a head node; never over the grant. */
	kept(): Buffer {
		return this.#window.kept();
	}

	snapshot(bytes = this.#end): OutputSnapshot {
		const kept = this.kept();
		const value = kept.length > 0 ? kept : null;
		return this.mode === "head"
			? { outputBytes: bytes, outputHead: value, outputTail: null }
			: { outputBytes: bytes, outputHead: null, outputTail: value };
	}
}

/** A `status` task: crhs keeps only the output stream's byte count. */
class StatusOutput implements LiveTask {
	readonly mode = "status";
	#end = 0;

	get end(): number {
		return this.#end;
	}

	append(offset: number, data: Uint8Array): boolean {
		if (offset > this.#end) return false;
		const skip = this.#end - offset;
		if (skip < data.length) this.#end = offset + data.length;
		return true;
	}

	snapshot(bytes = this.#end): OutputSnapshot {
		return { outputBytes: bytes, outputHead: null, outputTail: null };
	}
}

/**
 * A single task: the head and the tail of the single output stream. The tail is the one the
 * model sees, capped by the task's own budget; the head is the WebUI's.
 */
class FullOutput implements LiveTask {
	readonly mode = "full";
	readonly #stream = new StreamAccumulator();
	readonly #tail: BudgetedWindow;

	constructor(limits?: OutputLimits) {
		const total = limits ?? { maxLines: BATCH_GROUP_LINES, maxBytes: BATCH_GROUP_BYTES };
		// A single task's total budget is its own cap; the budget component still does the rolling.
		this.#tail = new BudgetedWindow(new GroupBudget({ node: total, total }), "tail");
	}

	get end(): number {
		return this.#stream.end;
	}

	append(offset: number, data: Uint8Array): boolean {
		const fresh = this.#stream.append(offset, data);
		if (fresh === null) return false;
		if (fresh.length > 0) this.#tail.append(fresh);
		return true;
	}

	/** Lines the tail shows; the same count the stored output_tail has. */
	get outputTailLines(): number {
		return this.#tail.keptLines;
	}

	snapshot(bytes = this.#stream.end): OutputSnapshot {
		const tail = this.#tail.kept();
		return {
			outputBytes: bytes,
			outputHead: this.#stream.head(),
			outputTail: tail.length > 0 ? tail : null,
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
