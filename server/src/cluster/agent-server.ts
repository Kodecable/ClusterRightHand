import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { HandshakeState } from "@crh/noise";
import {
	decode as decodeCbor,
	encode as encodeCbor,
	factsToJson,
	type HandshakeInit,
	type HandshakeResponse,
	handshakeInitCodec,
	handshakeResponseCodec,
	NOISE_PROLOGUE_PREFIX,
	OPTIONAL_NAMES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	peekProtocolMajor,
	REQUIRED_NAMES,
	SUPPORTED_NAMES,
} from "@crh/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { Audit } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import { newId } from "../util/id.ts";
import type { Cluster } from "./cluster.ts";
import { closeReason, NodeConnection, toBytes } from "./connection.ts";
import { EnrollmentError, enrollNode } from "./enrollment.ts";
import type { ServerIdentity } from "./identity.ts";
import { findNodeByPublicKey, type NodeRow } from "./nodes.ts";

export const AGENT_PATH = "/agent";
const CHALLENGE_LEN = 32;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_NOISE_MESSAGE = 65535;

/**
 * The commands and events both sides implement (doc/design/protocol.md "Handshake payloads"). The M3.5 names are
 * required; the M4 names are optional, so an older peer without them still connects. `missing` is
 * the first required name the peer does not offer.
 */
export function negotiateCommands(offered: Iterable<string>): {
	missing: string | undefined;
	negotiated: string[];
	optional: string[];
} {
	const have = new Set(offered);
	const missing = REQUIRED_NAMES.find((name) => !have.has(name));
	const negotiated = SUPPORTED_NAMES.filter((name) => have.has(name));
	const optional = OPTIONAL_NAMES.filter((name) => have.has(name));
	return { missing, negotiated, optional };
}

/**
 * The crha endpoint: WebSocket, server challenge, Noise IK handshake bound to the challenge.
 * See doc/design/protocol.md "Handshake and replay protection" and doc/design/protocol.md "Handshake payloads".
 */
export class AgentServer {
	readonly #db: Db;
	readonly #identity: ServerIdentity;
	readonly #cluster: Cluster;
	readonly #audit: Audit | undefined;
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NOISE_MESSAGE });
	/** Cleared at shutdown: no new node connection may be accepted. */
	#accepting = true;
	/** Handshakes in flight; close() waits for them so none attaches after the cluster closed. */
	readonly #handshakes = new Set<Promise<void>>();

	constructor(db: Db, identity: ServerIdentity, cluster: Cluster, audit?: Audit) {
		this.#audit = audit;
		this.#db = db;
		this.#identity = identity;
		this.#cluster = cluster;
	}

	/** Attach to the HTTP server's `upgrade` event. Returns false for other paths. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		if (!this.#accepting) return false;
		if (new URL(req.url ?? "/", "http://x").pathname !== AGENT_PATH) return false;
		this.#wss.handleUpgrade(req, socket, head, (ws) => {
			const accepted: Promise<void> = this.#accept(ws)
				.catch((err: unknown) => {
					console.error("agent connection failed:", err);
					ws.terminate();
				})
				.then(() => {
					this.#handshakes.delete(accepted);
				});
			this.#handshakes.add(accepted);
		});
		return true;
	}

	/** Stops accepting new node connections; the existing ones stay until close(). */
	stopAccepting(): void {
		this.#accepting = false;
	}

	/** Closes every node connection and resolves once no handshake can attach any more. */
	async close(): Promise<void> {
		this.#accepting = false;
		for (const ws of this.#wss.clients) ws.terminate();
		while (this.#handshakes.size > 0) await Promise.all(this.#handshakes);
		// A handshake that completed while the loop ran may have registered its socket late.
		for (const ws of this.#wss.clients) ws.terminate();
		await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
	}

	async #accept(ws: WebSocket): Promise<void> {
		const challenge = randomBytes(CHALLENGE_LEN);
		const first = new Promise<Uint8Array>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("handshake timeout")), HANDSHAKE_TIMEOUT_MS);
			ws.once("message", (data, isBinary) => {
				clearTimeout(timer);
				if (isBinary) resolve(toBytes(data));
				else reject(new Error("text message"));
			});
			ws.once("close", () => reject(new Error("closed")));
		});
		ws.send(challenge);

		let message1: Uint8Array;
		try {
			message1 = await first;
		} catch {
			return ws.terminate();
		}
		const hs = HandshakeState.responder({
			prologue: Buffer.concat([Buffer.from(NOISE_PROLOGUE_PREFIX), challenge]),
			staticKey: this.#identity.keyPair,
		});
		let payload: Uint8Array;
		try {
			payload = hs.readMessage(message1);
		} catch {
			return reject(ws, "handshake failed");
		}
		// The major version comes first, so a future client layout is rejected without parsing it.
		let clientMajor: number;
		try {
			clientMajor = peekProtocolMajor(payload);
		} catch {
			return reject(ws, "handshake failed");
		}
		if (clientMajor !== PROTOCOL_MAJOR) {
			return reject(ws, `protocol_major mismatch: server ${PROTOCOL_MAJOR}, client ${clientMajor}`);
		}
		let init: HandshakeInit;
		try {
			init = handshakeInitCodec.decode(decodeCbor(payload));
		} catch {
			return reject(ws, "handshake failed");
		}
		const clientKey = hs.remoteStaticKey as Uint8Array;

		// Only names both sides implement may be sent; the M3.5 names are required, the M4 names
		// optional. The minor version is not refused: it only adds optional names, negotiated here.
		const { missing, negotiated, optional } = negotiateCommands(init.commands);
		if (missing !== undefined) return reject(ws, `missing required command: ${missing}`);

		let node = await findNodeByPublicKey(this.#db, clientKey);
		if (!node && init.enroll) {
			try {
				node = await enrollNode(this.#db, {
					secret: init.enroll.tokenSecret,
					publicKey: clientKey,
					hostname: init.enroll.hostname,
					facts: factsToJson(init.enroll.facts),
					clientVersion: init.crhaVersion,
					audit: this.#audit,
				});
			} catch (err) {
				if (err instanceof EnrollmentError) return reject(ws, err.message);
				throw err;
			}
		}
		if (!node) return reject(ws, "unknown node");

		// The lookups above are async, so the client may have closed meanwhile. Attaching now would
		// replace the same node's newer live connection with this already-dead one.
		if (ws.readyState !== WebSocket.OPEN) return;

		const connectionId = newId();
		const response: HandshakeResponse = {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: PROTOCOL_MINOR,
			commands: [...SUPPORTED_NAMES],
			connectionId,
			serverTimeMs: Date.now(),
			nodeState: node.status === "active" ? "active" : "pending",
			nodeId: node.id,
		};
		ws.send(hs.writeMessage(encodeCbor(handshakeResponseCodec.encode(response))));
		const conn = new NodeConnection(connectionId, node.id, ws, hs.split(), negotiated, optional);
		this.#cluster.attach(conn, node as NodeRow);
	}
}

function reject(ws: WebSocket, reason: string): void {
	// Policy violation; the reason tells crha whether retrying can help.
	ws.close(1008, closeReason(reason));
}
