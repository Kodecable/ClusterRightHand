/**
 * One terminal's data connection (doc/design/pty.md "crha", doc/design/protocol.md "Data connections"):
 * a Noise-encrypted `[data, bytes]` / `[end]` frame stream in both directions. Output frames carry
 * crha's bytes to crhs; input frames carry the viewers' and agents' bytes back. The transport is the
 * transfer transport (`FrameStream`), so decrypt order is wire order and sending waits for the socket.
 */

import type { TransportCiphers } from "@crh/noise";
import {
	DATA_CHUNK_BYTES,
	type DataFrame,
	dataFrameCodec,
	decode as decodeCbor,
	encode as encodeCbor,
} from "@crh/protocol";
import type { WebSocket } from "ws";
import { FrameStream } from "../cluster/data-transfer.ts";

/** How the terminal service hears about one connection's frames. */
export interface PtyWireHandlers {
	/** A chunk of terminal output, in order. */
	onData(bytes: Uint8Array): void;
	/** crha ended the stream: the process's output is complete. */
	onEnd(): void;
	/** crha aborted the connection: `code` is `stream_lost` when a byte stream cannot continue. */
	onAbort(code: string): void;
	/** The socket is gone; `reason` is "end" for crha's [end], otherwise a failure or crhs's own close. */
	onClose(reason: string): void;
}

/** A terminal data connection's encoded frame. */
export function encodePtyFrame(frame: DataFrame): Uint8Array {
	return Uint8Array.from(encodeCbor(dataFrameCodec.encode(frame)));
}

/** One accepted terminal data connection. */
export class PtyWire {
	readonly #frames: FrameStream;
	readonly #handlers: PtyWireHandlers;
	#sendQueue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(ws: WebSocket, ciphers: TransportCiphers, handlers: PtyWireHandlers) {
		this.#handlers = handlers;
		this.#frames = new FrameStream(ws, ciphers);
		void this.#receive();
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Sends output bytes to crha, chunked at the protocol's chunk size and in order with other sends. */
	send(bytes: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("terminal data connection closed"));
		for (let off = 0; off < bytes.length; off += DATA_CHUNK_BYTES) {
			const chunk = bytes.subarray(off, off + DATA_CHUNK_BYTES);
			this.#sendQueue = this.#sendQueue.then(() => this.#frames.send(encodePtyFrame({ kind: "data", bytes: chunk })));
		}
		const queued = this.#sendQueue;
		return queued;
	}

	/**
	 * Answers with `[abort, code]` and closes the connection. The frame is handed to the socket before
	 * the close, so the peer sees why the stream ended.
	 */
	async abort(code: string): Promise<void> {
		if (this.#closed) return;
		try {
			await this.#frames.send(encodePtyFrame({ kind: "abort", code }));
		} catch {
			// A socket already gone is the same outcome.
		} finally {
			this.close(`abort: ${code}`);
		}
	}

	/** Ends the connection politely; the terminal itself stays. */
	close(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#frames.close();
		} catch {
			// A socket already gone is the same outcome.
		}
		this.#handlers.onClose(reason);
	}

	async #receive(): Promise<void> {
		try {
			for (;;) {
				const bytes = await this.#frames.next();
				const frame = dataFrameCodec.decode(decodeCbor(bytes));
				if (frame.kind === "data") {
					if (frame.bytes.length > 0) this.#handlers.onData(frame.bytes);
				} else if (frame.kind === "end") {
					this.#handlers.onEnd();
					return this.close("end");
				} else {
					this.#handlers.onAbort(frame.code);
					return this.close(`abort: ${frame.code}`);
				}
			}
		} catch (err) {
			if (this.#closed) return;
			this.#closed = true;
			this.#handlers.onClose(err instanceof Error ? err.message : String(err));
		}
	}
}
