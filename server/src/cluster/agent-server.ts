import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { HandshakeState } from "@crh/noise";
import {
	type DataConnectionInit,
	dataConnectionInitCodec,
	dataConnectionResponseCodec,
	decode as decodeCbor,
	encode as encodeCbor,
	factsToJson,
	type HandshakeInit,
	type HandshakeResponse,
	handshakeInitCodec,
	handshakeResponseCodec,
	majorFromSubprotocols,
	OPTIONAL_NAMES,
	offeredNames,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	peekProtocolMajor,
	REQUIRED_NAMES,
	SUBPROTOCOL_PREFIX,
} from "@crh/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { Audit } from "../audit/audit.ts";
import type { Db } from "../storage/db.ts";
import { newId } from "../util/id.ts";
import type { Cluster } from "./cluster.ts";
import { closeReason, NodeConnection, toBytes } from "./connection.ts";
import { EnrollmentError, type EnrollmentResult, enrollNodeWithResult } from "./enrollment.ts";
import type { ServerIdentity } from "./identity.ts";
import { refusalResponse, SERVED_MAJORS, type ServedMajor, servedMajor } from "./majors.ts";
import { findNodeByPublicKey, type NodeRow } from "./nodes.ts";

export const AGENT_PATH = "/agent";
/** The data connection's path: the control path plus `/data` (doc/design/protocol.md "Data connections"). */
export const AGENT_DATA_PATH = `${AGENT_PATH}/data`;
/**
 * A terminal's data connection path: the control path plus `/pty` (doc/design/pty.md "crha"). The
 * terminal names are optional and no handler accepts this path until the terminal subsystem lands.
 */
export const AGENT_PTY_PATH = `${AGENT_PATH}/pty`;
const CHALLENGE_LEN = 32;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const MAX_NOISE_MESSAGE = 65535;

/**
 * The commands and events both sides implement (doc/design/protocol.md "Version negotiation"). Every
 * required name must be offered, or `missing` is the first one absent. `negotiated` holds the required
 * names present plus the optional names the peer also offered; an optional name neither side offers is
 * simply absent.
 */
export function negotiateCommands(offered: Iterable<string>): {
	missing: string | undefined;
	negotiated: string[];
} {
	const have = new Set(offered);
	const missing = REQUIRED_NAMES.find((name) => !have.has(name));
	const negotiated = [...REQUIRED_NAMES, ...OPTIONAL_NAMES].filter((name) => have.has(name));
	return { missing, negotiated };
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
	readonly #majors: readonly ServedMajor[];
	// crha names its major as the subprotocol `crh.<major>`; echoing it tells crha that crhs read it
	// (doc/design/protocol.md "The major in the clear").
	readonly #wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_NOISE_MESSAGE,
		handleProtocols: (protocols) => [...protocols].find((entry) => entry.startsWith(SUBPROTOCOL_PREFIX)) ?? false,
	});
	/** Cleared at shutdown: no new node connection may be accepted. */
	#accepting = true;
	/** Handshakes in flight; close() waits for them so none attaches after the cluster closed. */
	readonly #handshakes = new Set<Promise<void>>();

	constructor(
		db: Db,
		identity: ServerIdentity,
		cluster: Cluster,
		audit?: Audit,
		majors: readonly ServedMajor[] = SERVED_MAJORS,
	) {
		this.#audit = audit;
		this.#majors = majors;
		this.#db = db;
		this.#identity = identity;
		this.#cluster = cluster;
	}

	/** Attach to the HTTP server's `upgrade` event. Returns false for other paths. */
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		if (!this.#accepting) return false;
		let path: string;
		try {
			path = new URL(req.url ?? "/", "http://x").pathname;
		} catch {
			// Request targets like `//` throw here. This runs synchronously inside the HTTP server's
			// `upgrade` emit, where a throw is an uncaught exception: refuse the upgrade instead.
			return false;
		}
		if (path !== AGENT_PATH && path !== AGENT_DATA_PATH) return false;
		const data = path === AGENT_DATA_PATH;
		// The major comes before the handshake, so a node crhs does not serve is told why in plain HTTP
		// instead of failing the Noise handshake. A request that names no crh.<major> is refused the same
		// way (doc/design/protocol.md "The major in the clear").
		const header = req.headers["sec-websocket-protocol"];
		const clientMajor = majorFromSubprotocols(Array.isArray(header) ? header.join(",") : header);
		const served = servedMajor(clientMajor, this.#majors);
		if (served === undefined || !served.current) {
			// Only the current major is served until an older codec exists; the window is in majors.ts.
			console.warn(
				`agent connection refused: protocol major ${clientMajor ?? "unreadable"} from ${req.socket.remoteAddress ?? "unknown address"}; crhs serves ${this.#majors.map((entry) => entry.major).join(", ")}`,
			);
			// The peer may reset the connection before the response is written; an unhandled socket
			// error here would end the process.
			socket.on("error", () => {});
			socket.end(refusalResponse(clientMajor, this.#majors));
			return true;
		}
		this.#wss.handleUpgrade(req, socket, head, (ws) => {
			// Until the handshake attaches a message listener nothing owns this socket's protocol errors
			// (an oversized frame, a bad frame, a reset), and an unhandled ws `error` event ends the process.
			ws.on("error", () => {});
			const accepted: Promise<void> = (data ? this.#acceptData(ws, served) : this.#accept(ws, served))
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

	async #accept(ws: WebSocket, served: ServedMajor): Promise<void> {
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
			prologue: Buffer.concat([Buffer.from(served.prologue), challenge]),
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
		if (clientMajor !== served.major) {
			return reject(ws, `protocol_major mismatch: request named ${served.major}, payload ${clientMajor}`);
		}
		let init: HandshakeInit;
		try {
			init = handshakeInitCodec.decode(decodeCbor(payload));
		} catch {
			return reject(ws, "handshake failed");
		}
		const clientKey = hs.remoteStaticKey as Uint8Array;

		// Only names both sides offer may be sent; every required name must be present, while an optional
		// name is negotiated by intersection. The minor version is not refused: it may only add names.
		const { missing, negotiated } = negotiateCommands(init.commands);
		if (missing !== undefined) return reject(ws, `missing required command: ${missing}`);

		let node = await findNodeByPublicKey(this.#db, clientKey);
		let enrolled: EnrollmentResult | undefined;
		if (!node && init.enroll) {
			try {
				enrolled = await enrollNodeWithResult(this.#db, {
					secret: init.enroll.tokenSecret,
					publicKey: clientKey,
					hostname: init.enroll.hostname,
					facts: factsToJson(init.enroll.facts),
					clientVersion: init.crhaVersion,
					audit: this.#audit,
				});
				node = enrolled.node;
			} catch (err) {
				if (err instanceof EnrollmentError) return reject(ws, err.message);
				throw err;
			}
		}
		if (!node) return reject(ws, "unknown node");
		// The version a node runs changes when it is upgraded, so it is recorded on every handshake, not
		// only at enrollment (doc/design/distribution.md "crha self-upgrade").
		if (node.client_version !== init.crhaVersion) {
			await this.#db.updateTable("nodes").set({ client_version: init.crhaVersion }).where("id", "=", node.id).execute();
			node = { ...node, client_version: init.crhaVersion };
		}

		// A re-enrolled node's old key no longer authenticates. Close the connection that authenticated
		// with it now, even if this new handshake dies before attaching; attach() would otherwise wait.
		if (enrolled?.reenrolled) this.#cluster.disconnect(node.id, "node re-enrolled");

		// The lookups above are async, so the client may have closed meanwhile. Attaching now would
		// replace the same node's newer live connection with this already-dead one.
		if (ws.readyState !== WebSocket.OPEN) return;

		const connectionId = newId();
		const response: HandshakeResponse = {
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: PROTOCOL_MINOR,
			commands: offeredNames(),
			connectionId,
			serverTimeMs: Date.now(),
			nodeState: node.status === "active" ? "active" : "pending",
			nodeId: node.id,
		};
		ws.send(hs.writeMessage(encodeCbor(handshakeResponseCodec.encode(response))));
		const conn = new NodeConnection(connectionId, node.id, ws, hs.split(), negotiated, !served.current);
		this.#cluster.attach(conn, node as NodeRow);
	}

	/**
	 * The data connection endpoint: the same challenge and Noise IK, with the `crh-data/0` prologue and
	 * the small data handshake payload (doc/design/protocol.md "Data connections"). Only an active node
	 * whose control connection is up gets past the handshake; the task and transfer are checked by the
	 * cluster once the channel exists.
	 */
	async #acceptData(ws: WebSocket, served: ServedMajor): Promise<void> {
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
			prologue: Buffer.concat([Buffer.from(served.dataPrologue), challenge]),
			staticKey: this.#identity.keyPair,
		});
		let payload: Uint8Array;
		try {
			payload = hs.readMessage(message1);
		} catch {
			return reject(ws, "handshake failed");
		}
		let clientMajor: number;
		try {
			clientMajor = peekProtocolMajor(payload);
		} catch {
			return reject(ws, "handshake failed");
		}
		if (clientMajor !== served.major) {
			return reject(ws, `protocol_major mismatch: request named ${served.major}, payload ${clientMajor}`);
		}
		let init: DataConnectionInit;
		try {
			init = dataConnectionInitCodec.decode(decodeCbor(payload));
		} catch {
			return reject(ws, "handshake failed");
		}
		const clientKey = hs.remoteStaticKey as Uint8Array;
		const node = await findNodeByPublicKey(this.#db, clientKey);
		if (!node) return reject(ws, "unknown node");
		if (node.status !== "active") return reject(ws, "node_pending");
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(hs.writeMessage(encodeCbor(dataConnectionResponseCodec.encode({ protocolMajor: PROTOCOL_MAJOR }))));
		this.#cluster.attachData(ws, hs.split(), node.id, init);
	}
}

function reject(ws: WebSocket, reason: string): void {
	// Policy violation; the reason tells crha whether retrying can help.
	ws.close(1008, closeReason(reason));
}
