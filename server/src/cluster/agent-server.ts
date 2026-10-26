import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { HandshakeState } from "@crh/noise";
import {
	FactsSchema,
	type HandshakeInit,
	HandshakeInitSchema,
	HandshakeResponseSchema,
	NodeState,
} from "@crh/protocol";
import { type WebSocket, WebSocketServer } from "ws";
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
 * See doc/execution-plane.md#握手.
 */
export class AgentServer {
	readonly #db: Db;
	readonly #identity: ServerIdentity;
	readonly #cluster: Cluster;
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NOISE_MESSAGE });

	constructor(db: Db, identity: ServerIdentity, cluster: Cluster) {
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
		let init: HandshakeInit;
		try {
			init = fromBinary(HandshakeInitSchema, hs.readMessage(message1));
		} catch {
			return reject(ws, "handshake failed");
		}
		const clientKey = hs.remoteStaticKey as Uint8Array;

		let node = await findNodeByPublicKey(this.#db, clientKey);
		if (!node && init.enroll) {
			try {
				node = await enrollNode(this.#db, {
					secret: init.enroll.tokenSecret,
					publicKey: clientKey,
					hostname: init.enroll.hostname,
					facts: init.enroll.facts ? toJson(FactsSchema, init.enroll.facts) : null,
					clientVersion: init.crhaVersion,
				});
			} catch (err) {
				if (err instanceof EnrollmentError) return reject(ws, err.message);
				throw err;
			}
		}
		if (!node) return reject(ws, "unknown node");
		if (node.status === "disabled") return reject(ws, "node disabled");

		const connectionId = newId();
		const response = create(HandshakeResponseSchema, {
			connectionId,
			serverTimeUnixMs: BigInt(Date.now()),
			nodeState: node.status === "active" ? NodeState.ACTIVE : NodeState.PENDING,
			nodeId: node.id,
		});
		ws.send(hs.writeMessage(toBinary(HandshakeResponseSchema, response)));
		const conn = new NodeConnection(connectionId, node.id, ws, hs.split());
		this.#cluster.attach(conn, node as NodeRow, init);
	}
}

function reject(ws: WebSocket, reason: string): void {
	// Policy violation; the reason tells crha whether retrying can help.
	ws.close(1008, reason.slice(0, 120));
}
