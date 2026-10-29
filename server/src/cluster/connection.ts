import type { TransportCiphers } from "@crh/noise";
import { CborError, ConnectionError, OPTIONAL_NAMES, Peer, ProtocolError, truncateUtf8 } from "@crh/protocol";
import type { WebSocket } from "ws";

const EMPTY = new Uint8Array(0);
// The WebSocket close frame allows at most 123 bytes of reason.
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Make a close reason well-formed and fit it into the 123 UTF-8 bytes the
 * WebSocket protocol allows; `ws.close` throws synchronously for a longer one.
 */
export function closeReason(reason: string): string {
	return truncateUtf8(reason.toWellFormed(), MAX_CLOSE_REASON_BYTES);
}

/** An authenticated, encrypted frame stream to one crha. Frames are delivered in order. */
export class NodeConnection {
	readonly id: string;
	readonly nodeId: string;
	/** The wire protocol peer; commands and events are registered on it. */
	readonly peer: Peer;
	/**
	 * The optional 1.1 names the peer negotiated. Empty for a 1.0 node, which cannot take part in
	 * `forward` (doc/protocol.md#握手载荷).
	 */
	readonly optional: ReadonlySet<string>;
	readonly #ws: WebSocket;
	readonly #ciphers: TransportCiphers;
	#onActivity: () => void = () => {};
	#onClose: (reason: string) => void = () => {};
	#closed = false;

	constructor(
		id: string,
		nodeId: string,
		ws: WebSocket,
		ciphers: TransportCiphers,
		negotiated: Iterable<string>,
		optional: Iterable<string> = [],
	) {
		this.id = id;
		this.nodeId = nodeId;
		this.#ws = ws;
		this.#ciphers = ciphers;
		this.optional = new Set(optional);
		this.peer = new Peer({
			negotiated,
			// Encrypt and hand to the socket synchronously, so nonce order equals wire order.
			send: (bytes) => {
				if (this.#closed) throw new ConnectionError("connection closed");
				this.#ws.send(this.#ciphers.send.encrypt(EMPTY, bytes));
			},
			// A throwing event handler leaves the two sides out of step; close as for a protocol error.
			onError: (error) => this.close(`event handler failed: ${error.message}`),
		});
		ws.on("message", (data, isBinary) => {
			if (this.#closed) return;
			if (!isBinary) return this.close("text message");
			let plain: Uint8Array;
			try {
				plain = this.#ciphers.receive.decrypt(EMPTY, toBytes(data));
			} catch {
				// A failed decryption desynchronizes the nonce; the session cannot continue.
				return this.close("bad message");
			}
			this.#onActivity();
			try {
				this.peer.receive(plain);
			} catch (err) {
				if (err instanceof ProtocolError || err instanceof CborError) {
					this.close(`protocol error: ${err.message}`);
				} else {
					this.close(`internal error: ${(err as Error).message}`);
				}
			}
		});
		ws.on("close", (_code, reason) => this.#finish(reason.toString() || "closed"));
		ws.on("error", (err) => this.#finish(err.message));
	}

	/** Runs on every decrypted frame, before it is dispatched (the idle timeout refreshes here). */
	onActivity(handler: () => void): void {
		this.#onActivity = handler;
	}

	onClose(handler: (reason: string) => void): void {
		this.#onClose = handler;
		if (this.#closed) handler("closed");
	}

	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * Whether the peer implements every optional 1.1 name. Such a node can take part in `forward`;
	 * one that only speaks 1.0 cannot, whatever its `privileged_mode` says.
	 */
	get supportsForward(): boolean {
		return OPTIONAL_NAMES.every((name) => this.optional.has(name));
	}

	close(reason: string): void {
		if (!this.#closed) {
			try {
				this.#ws.close(1000, closeReason(reason));
			} catch {
				// A failed close must not skip #finish or escape a ws listener.
			}
		}
		this.#finish(reason);
	}

	#finish(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.peer.close(reason);
		this.#onClose(reason);
	}
}

export function toBytes(data: unknown): Uint8Array {
	if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return data as Uint8Array;
}
