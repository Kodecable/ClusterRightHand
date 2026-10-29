import { StreamAccumulator, tailLines } from "./output.ts";

/** Caps for one batch `text` node, and for the whole group (doc/execution-plane.md#输出). */
export const BATCH_NODE_BYTES = 8 * 1024;
export const BATCH_NODE_LINES = 128;
export const BATCH_GROUP_BYTES = 50 * 1024;
export const BATCH_GROUP_LINES = 2_000;

export type OutputStream = "stdout" | "stderr";
export type OutputModeKind = "full" | "text" | "status";

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
 * The output budget of one batch `text` group: every node draws grants from it in arrival order, and
 * crhs keeps no more than the sum of the grants. See doc/execution-plane.md#输出.
 */
export class GroupBudget {
	bytesLeft = BATCH_GROUP_BYTES;
	linesLeft = BATCH_GROUP_LINES;
}

/** The output side of a running task, uniform over the three modes. */
export interface LiveTask {
	readonly mode: OutputModeKind;
	/** Returns false when the chunk leaves a gap; overlapping resends are skipped. */
	append(stream: OutputStream, offset: number, data: Uint8Array): boolean;
	/** Bytes received so far on a stream: the offset acknowledged to crha. */
	end(stream: OutputStream): number;
	/** `ends` overrides the byte totals, e.g. with task.exit's ends for a status task. */
	snapshot(ends?: Partial<Record<OutputStream, number>>): OutputSnapshot;
}

/** Picks the accumulator for the mode; a `text` task must share its group's budget. */
export function createLiveTask(mode: OutputModeKind, budget?: GroupBudget): LiveTask {
	switch (mode) {
		case "full":
			return new FullOutput();
		case "text":
			if (!budget) throw new Error("text output needs a group budget");
			return new TailAccumulator(budget);
		case "status":
			return new StatusOutput();
	}
}

/**
 * A batch `text` node: it keeps one combined tail of stdout and stderr in arrival order, inside the grant
 * it has from the group budget. Grants grow with the bytes that arrive, up to the per-node caps; bytes
 * pushed out of the tail are never returned to the budget, so the memory held is the sum of the grants.
 */
export class TailAccumulator implements LiveTask {
	readonly mode = "text";
	readonly #budget: GroupBudget;
	readonly #ends: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
	#tail = Buffer.alloc(0);
	#grantBytes = 0;
	#grantLines = 0;

	constructor(budget: GroupBudget) {
		this.#budget = budget;
	}

	/** The grant this node has drawn from the group, in bytes and newline characters. */
	get grant(): { bytes: number; lines: number } {
		return { bytes: this.#grantBytes, lines: this.#grantLines };
	}

	end(stream: OutputStream): number {
		return this.#ends[stream];
	}

	append(stream: OutputStream, offset: number, data: Uint8Array): boolean {
		const end = this.#ends[stream];
		if (offset > end) return false;
		const skip = end - offset;
		if (skip >= data.length) return true;
		const fresh = Buffer.from(data.subarray(skip));
		this.#ends[stream] = end + fresh.length;

		const addBytes = Math.max(0, Math.min(fresh.length, BATCH_NODE_BYTES - this.#grantBytes, this.#budget.bytesLeft));
		this.#grantBytes += addBytes;
		this.#budget.bytesLeft -= addBytes;
		const addLines = Math.max(
			0,
			Math.min(countNewlines(fresh), BATCH_NODE_LINES - this.#grantLines, this.#budget.linesLeft),
		);
		this.#grantLines += addLines;
		this.#budget.linesLeft -= addLines;

		// No byte grant: the whole node may be dropped; crha is still acked by the advanced end.
		if (this.#grantBytes === 0) return true;
		this.#tail = Buffer.concat([this.#tail, fresh]);
		this.#trim();
		return true;
	}

	/** A copy of the combined tail; never longer than the node's byte grant. */
	tail(): Buffer {
		return Buffer.from(this.#tail);
	}

	snapshot(ends?: Partial<Record<OutputStream, number>>): OutputSnapshot {
		return {
			stdoutBytes: ends?.stdout ?? this.#ends.stdout,
			stderrBytes: ends?.stderr ?? this.#ends.stderr,
			stdoutHead: null,
			stdoutTail: this.tail(),
			stderrHead: null,
			stderrTail: null,
		};
	}

	/** Trims from the front to the byte grant, then to the line grant; copies so the old tail is released. */
	#trim(): void {
		const before = this.#tail;
		const bytes = before.length > this.#grantBytes ? before.subarray(before.length - this.#grantBytes) : before;
		const tail = tailLines(bytes, this.#grantLines);
		if (tail !== before) this.#tail = Buffer.from(tail);
	}
}

/** A `status` task: crhs keeps only per-stream byte counts. */
class StatusOutput implements LiveTask {
	readonly mode = "status";
	readonly #ends: Record<OutputStream, number> = { stdout: 0, stderr: 0 };

	end(stream: OutputStream): number {
		return this.#ends[stream];
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
			stderrHead: null,
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
