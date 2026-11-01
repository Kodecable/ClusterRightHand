import { StreamAccumulator, tailLines } from "./output.ts";

/**
 * Caps for one batch node, and for the whole group: exec `text` nodes keep a tail, file operations
 * (`head`) keep the head of each node's page (doc/execution-plane.md#输出).
 */
export const BATCH_NODE_BYTES = 8 * 1024;
export const BATCH_NODE_LINES = 128;
export const BATCH_GROUP_BYTES = 50 * 1024;
export const BATCH_GROUP_LINES = 2_000;

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
}

/**
 * The output budget of one batch group: every node draws grants from it in arrival order, and crhs
 * keeps no more than the sum of the grants. `text` (exec) and `head` (file operations) measure the
 * same budget; only what each node keeps of its output differs. See doc/execution-plane.md#输出.
 */
export class GroupBudget {
	bytesLeft = BATCH_GROUP_BYTES;
	linesLeft = BATCH_GROUP_LINES;
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
export function createLiveTask(mode: OutputModeKind, budget?: GroupBudget): LiveTask {
	switch (mode) {
		case "full":
			return new FullOutput();
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
		const bytes = Math.max(0, Math.min(fresh.length, BATCH_NODE_BYTES - this.#bytes, this.#budget.bytesLeft));
		this.#bytes += bytes;
		this.#budget.bytesLeft -= bytes;
		// A window of N bytes holds at most N newlines: never grant lines the node has no bytes for.
		const lines = Math.max(
			0,
			Math.min(countNewlines(fresh), BATCH_NODE_LINES - this.#lines, this.#budget.linesLeft, this.#bytes - this.#lines),
		);
		this.#lines += lines;
		this.#budget.linesLeft -= lines;
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
	readonly #grant: NodeGrant;
	readonly #ends: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
	/** The combined tail (`text`) or the stdout head (`head`). */
	#kept = Buffer.alloc(0);
	/** `head` only: the lines crhs writes itself (the SSH privileged notice), never the node's stderr. */
	#note: Buffer | null = null;

	constructor(mode: "text" | "head", budget: GroupBudget) {
		this.mode = mode;
		this.#grant = new NodeGrant(budget);
	}

	/** The grant this node has drawn from the group, in bytes and newline characters. */
	get grant(): { bytes: number; lines: number } {
		return { bytes: this.#grant.bytes, lines: this.#grant.lines };
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

		this.#grant.take(fresh);
		if (this.mode === "head") {
			// The grant is the cap on the whole head, in bytes and in lines like a text tail: keep the
			// first bytes of the stream, but no more lines than the node was granted.
			const room = this.#grant.bytes - this.#kept.length;
			if (room > 0) this.#kept = Buffer.concat([this.#kept, fresh.subarray(0, Math.min(room, fresh.length))]);
			this.#trimHead();
			return true;
		}

		// No byte grant: the whole node may be dropped; crha is still acked by the advanced end.
		if (this.#grant.bytes === 0) return true;
		this.#kept = Buffer.concat([this.#kept, fresh]);
		this.#trimTail();
		return true;
	}

	/** The combined tail of a text node, or the stdout head of a head node; never over the grant. */
	kept(): Buffer {
		return Buffer.from(this.#kept);
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
			};
		}
		return {
			stdoutBytes,
			stderrBytes,
			stdoutHead: null,
			stdoutTail: this.kept(),
			stderrHead: null,
			stderrTail: null,
		};
	}

	/** Cuts the head after its line grant, like the byte grant the append already applies. */
	#trimHead(): void {
		const head = headLines(this.#kept, this.#grant.lines);
		if (head.length !== this.#kept.length) this.#kept = Buffer.from(head);
	}

	/** Trims the tail from the front to the byte grant, then to the line grant. */
	#trimTail(): void {
		const before = this.#kept;
		let start = before.length > this.#grant.bytes ? before.length - this.#grant.bytes : 0;
		// The cut can land inside a multi-byte character: skip its continuation bytes so the tail decodes.
		while (start < before.length && ((before[start] ?? 0) & 0xc0) === 0x80) start++;
		const bytes = start > 0 ? before.subarray(start) : before;
		const tail = tailLines(bytes, this.#grant.lines);
		if (tail !== before) this.#kept = Buffer.from(tail);
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
		};
	}
}

/** A single task: the existing head/tail accumulator, unchanged. */
class FullOutput implements LiveTask {
	readonly mode = "full";
	readonly #stdout = new StreamAccumulator();
	readonly #stderr = new StreamAccumulator();

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
		return this.#stream(stream).append(offset, data);
	}

	snapshot(): OutputSnapshot {
		return {
			stdoutBytes: this.#stdout.end,
			stderrBytes: this.#stderr.end,
			stdoutHead: this.#stdout.head(),
			stdoutTail: this.#stdout.tail(),
			stderrHead: this.#stderr.head(),
			stderrTail: this.#stderr.tail(),
		};
	}
}

function countNewlines(buf: Buffer): number {
	let count = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
	return count;
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
