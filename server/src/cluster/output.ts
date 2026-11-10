/** What crhs keeps of a task's output head: at most this many bytes and lines. */
export const OUTPUT_KEEP_BYTES = 50 * 1024;
export const OUTPUT_KEEP_LINES = 2000;

/**
 * Accumulates the single output stream as it arrives in offset order (resends after a reconnect may
 * overlap what was already received). The kept tail is the budget component's job (batch-output.ts);
 * this class keeps only the head.
 */
export class StreamAccumulator {
	#head = Buffer.alloc(0);
	#end = 0;

	/** Bytes received so far: the offset the client resends from after a reconnect. */
	get end(): number {
		return this.#end;
	}

	/**
	 * Appends what is fresh in a chunk and returns it, or null if the chunk leaves a gap (data was
	 * lost). An overlapping resend returns an empty buffer: it was already received.
	 */
	append(offset: number, data: Uint8Array): Buffer | null {
		if (offset > this.#end) return null;
		const skip = this.#end - offset;
		if (skip >= data.length) return Buffer.alloc(0);
		const fresh = Buffer.from(data.subarray(skip));
		if (this.#head.length < OUTPUT_KEEP_BYTES) {
			this.#head = Buffer.concat([this.#head, fresh.subarray(0, OUTPUT_KEEP_BYTES - this.#head.length)]);
		}
		this.#end += fresh.length;
		return fresh;
	}

	head(): Buffer {
		let count = 0;
		for (let i = 0; i < this.#head.length; i++) {
			if (this.#head[i] === 0x0a && ++count === OUTPUT_KEEP_LINES) return this.#head.subarray(0, i + 1);
		}
		return this.#head;
	}
}

/**
 * Lines in output, by the protocol's rule (doc/design/protocol.md "Events".output_lines): newline characters,
 * plus one for a non-empty last line that has no newline. Zero for no output.
 */
export function countOutputLines(data: string | Uint8Array): number {
	const length = data.length;
	if (length === 0) return 0;
	let newlines = 0;
	if (typeof data === "string") {
		for (let i = 0; i < length; i++) if (data.charCodeAt(i) === 0x0a) newlines++;
		return newlines + (data.charCodeAt(length - 1) === 0x0a ? 0 : 1);
	}
	for (let i = 0; i < length; i++) if (data[i] === 0x0a) newlines++;
	return newlines + (data[length - 1] === 0x0a ? 0 : 1);
}

/**
 * Counts the lines of a merged output as chunks arrive (an SSH task's output, which crhs sees in full):
 * newline characters, plus one for a non-empty last line that has no newline.
 */
export class LineCounter {
	#newlines = 0;
	#bytes = 0;
	#last = 0;

	add(data: Uint8Array): void {
		if (data.length === 0) return;
		for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) this.#newlines++;
		this.#bytes += data.length;
		this.#last = data[data.length - 1] ?? 0;
	}

	get lines(): number {
		return this.#bytes === 0 ? 0 : this.#newlines + (this.#last === 0x0a ? 0 : 1);
	}
}
