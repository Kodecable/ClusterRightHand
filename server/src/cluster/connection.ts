import { create, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import type { TransportCiphers } from "@crh/noise";
import { type Envelope, EnvelopeSchema, MAX_ENVELOPE_BYTES } from "@crh/protocol";
import type { WebSocket } from "ws";

const EMPTY = new Uint8Array(0);

/** An authenticated, encrypted envelope stream to one crha. Envelopes are delivered in order. */
export class NodeConnection {
	readonly id: string;
	readonly nodeId: string;
	readonly #ws: WebSocket;
	readonly #ciphers: TransportCiphers;
	#onEnvelope: (env: Envelope) => void = () => {};
	#onClose: (reason: string) => void = () => {};
	#closed = false;

	constructor(id: string, nodeId: string, ws: WebSocket, ciphers: TransportCiphers) {
		this.id = id;
		this.nodeId = nodeId;
		this.#ws = ws;
		this.#ciphers = ciphers;
		ws.on("message", (data, isBinary) => {
			if (this.#closed) return;
			if (!isBinary) return this.close("text message");
			let env: Envelope;
			try {
				const plain = this.#ciphers.receive.decrypt(EMPTY, toBytes(data));
				env = fromBinary(EnvelopeSchema, plain);
			} catch {
				// A failed decryption desynchronizes the nonce; the session cannot continue.
				return this.close("bad message");
			}
			this.#onEnvelope(env);
		});
		ws.on("close", (_code, reason) => this.#finish(reason.toString() || "closed"));
		ws.on("error", (err) => this.#finish(err.message));
	}

	onEnvelope(handler: (env: Envelope) => void): void {
		this.#onEnvelope = handler;
	}

	onClose(handler: (reason: string) => void): void {
		this.#onClose = handler;
		if (this.#closed) handler("closed");
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(body: MessageInitShape<typeof EnvelopeSchema>["body"]): void {
		if (this.#closed) throw new Error("connection closed");
		const plain = toBinary(EnvelopeSchema, create(EnvelopeSchema, { body }));
		if (plain.length > MAX_ENVELOPE_BYTES) throw new RangeError(`envelope too large: ${plain.length} bytes`);
		// Encrypt and hand to the socket synchronously, so nonce order equals wire order.
		this.#ws.send(this.#ciphers.send.encrypt(EMPTY, plain));
	}

	close(reason: string): void {
		if (!this.#closed) this.#ws.close(1000, reason.slice(0, 120));
		this.#finish(reason);
	}

	#finish(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose(reason);
	}
}

export function toBytes(data: unknown): Uint8Array {
	if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return data as Uint8Array;
}
