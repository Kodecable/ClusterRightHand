/** What crhs keeps of a stream: the head and the tail, each limited by bytes and lines. */
export const OUTPUT_KEEP_BYTES = 50 * 1024;
export const OUTPUT_KEEP_LINES = 2000;

/**
 * Accumulates one output stream as it arrives in offset order (resends after a reconnect may overlap
 * what was already received). Keeps the first and the last OUTPUT_KEEP_BYTES.
 */
export class StreamAccumulator {
	#head = Buffer.alloc(0);
	#tail = Buffer.alloc(0);
	#end = 0;

	/** Bytes received so far: the offset the client resends from after a reconnect. */
	get end(): number {
		return this.#end;
	}

	/** Returns false if the chunk leaves a gap (data was lost). */
	append(offset: number, data: Uint8Array): boolean {
		if (offset > this.#end) return false;
		const skip = this.#end - offset;
		if (skip >= data.length) return true;
		const fresh = Buffer.from(data.subarray(skip));
		if (this.#head.length < OUTPUT_KEEP_BYTES) {
			this.#head = Buffer.concat([this.#head, fresh.subarray(0, OUTPUT_KEEP_BYTES - this.#head.length)]);
		}
		this.#tail = Buffer.concat([this.#tail, fresh]);
		if (this.#tail.length > OUTPUT_KEEP_BYTES * 2)
			this.#tail = this.#tail.subarray(this.#tail.length - OUTPUT_KEEP_BYTES);
		this.#end += fresh.length;
		return true;
	}

	head(): Buffer {
		return limitLines(this.#head, "head");
	}

	tail(): Buffer {
		const bytes =
			this.#tail.length > OUTPUT_KEEP_BYTES ? this.#tail.subarray(this.#tail.length - OUTPUT_KEEP_BYTES) : this.#tail;
		return limitLines(Buffer.from(bytes), "tail");
	}
}

function limitLines(buf: Buffer, side: "head" | "tail"): Buffer {
	let count = 0;
	if (side === "head") {
		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === 0x0a && ++count === OUTPUT_KEEP_LINES) return buf.subarray(0, i + 1);
		}
		return buf;
	}
	return tailLines(buf, OUTPUT_KEEP_LINES);
}

/**
 * Keeps the last `lines` lines of a tail: a trailing newline ends the last line, so at most `lines`
 * newline characters remain (none when `lines` is 0). Shared with the batch tail accumulator.
 */
export function tailLines(buf: Buffer, lines: number): Buffer {
	if (lines <= 0) {
		const nl = buf.lastIndexOf(0x0a);
		return nl < 0 ? buf : buf.subarray(nl + 1);
	}
	let count = 0;
	for (let i = buf.length - 2; i >= 0; i--) {
		if (buf[i] === 0x0a && ++count === lines) return buf.subarray(i + 1);
	}
	return buf;
}
