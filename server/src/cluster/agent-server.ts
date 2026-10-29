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
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	peekProtocolMajor,
	SUPPORTED_NAMES,
} from "@crh/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Audit } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import { newId } from "../util/id.ts";
import type { Cluster } from "./cluster.ts";
import { NodeConnection, toBytes } from "./connection.ts";
import { EnrollmentError, enrollNode } from "./enrollment.ts";
import type { ServerIdentity } from "./identity.ts";
import { findNodeByPublicKey, type NodeRow } from "./nodes.ts";

export const AGENT_PATH = "/agent";
const CHALLENGE_LEN = 32;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_NOISE_MESSAGE = 65535;

/**
 * The crha endpoint: WebSocket, server challenge, Noise IK handshake bound to the challenge.
 * See doc/execution-plane.md#握手 and doc/protocol.md#握手载荷.
 */
export class AgentServer {
	readonly #db: Db;
	readonly #identity: ServerIdentity;
	readonly #cluster: Cluster;
	readonly #audit: Audit | undefined;
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NOISE_MESSAGE });

	constructor(db: Db, identity: ServerIdentity, cluster: Cluster, audit?: Audit) {
		this.#audit = audit;
		this.#db = db;
		this.#identity = identity;
		this.#cluster = cluster;
	}

	/** Attach to the HTTP server's `upgrade` event. Returns false for other paths. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		if (new URL(req.url ?? "/", "http://x").pathname !== AGENT_PATH) return false;
		this.#wss.handleUpgrade(req, socket, head, (ws) => {
			this.#accept(ws).catch((err: unknown) => {
				console.error("agent connection failed:", err);
				ws.terminate();
			});
		});
		return true;
	}

	close(): void {
		for (const ws of this.#wss.clients) ws.terminate();
		this.#wss.close();
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
			prologue: Buffer.concat([Buffer.from("crh/1"), challenge]),
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

		// Only names both sides implement may be sent; 1.0 requires every name in doc/protocol.md.
		const offered = new Set(init.commands);
		const missing = SUPPORTED_NAMES.find((name) => !offered.has(name));
		if (missing !== undefined) return reject(ws, `missing required command: ${missing}`);
		const negotiated = SUPPORTED_NAMES.filter((name) => offered.has(name));

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
		if (node.status === "disabled") return reject(ws, "node disabled");

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
		const conn = new NodeConnection(connectionId, node.id, ws, hs.split(), negotiated);
		this.#cluster.attach(conn, node as NodeRow);
	}
}

function reject(ws: WebSocket, reason: string): void {
	// Policy violation; the reason tells crha whether retrying can help.
	ws.close(1008, reason.slice(0, 120));
}
