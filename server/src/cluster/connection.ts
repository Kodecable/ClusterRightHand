import type { TransportCiphers } from "@crh/noise";
import { CborError, ConnectionError, Peer, ProtocolError } from "@crh/protocol";
import type { WebSocket } from "ws";

const EMPTY = new Uint8Array(0);

/** An authenticated, encrypted frame stream to one crha. Frames are delivered in order. */
export class NodeConnection {
	readonly id: string;
	readonly nodeId: string;
	/** The wire protocol peer; commands and events are registered on it. */
	readonly peer: Peer;
	readonly #ws: WebSocket;
	readonly #ciphers: TransportCiphers;
	#onActivity: () => void = () => {};
	#onClose: (reason: string) => void = () => {};
	#closed = false;

	constructor(id: string, nodeId: string, ws: WebSocket, ciphers: TransportCiphers, negotiated: Iterable<string>) {
		this.id = id;
		this.nodeId = nodeId;
		this.#ws = ws;
		this.#ciphers = ciphers;
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

	close(reason: string): void {
		if (!this.#closed) this.#ws.close(1000, reason.slice(0, 120));
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
