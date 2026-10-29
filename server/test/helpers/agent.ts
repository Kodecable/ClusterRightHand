import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HandshakeState, type KeyPair } from "@crh/noise";
import {
	decode as decodeCbor,
	encode as encodeCbor,
	type HandshakeInit,
	type HandshakeResponse,
	handshakeInitCodec,
	handshakeResponseCodec,
	type LocalRequest,
	Peer,
	type Revocation,
	SUPPORTED_NAMES,
	type TaskExit,
	type TaskStart,
	type TrustReport,
} from "@crh/protocol";
import { WebSocket } from "ws";
import { AgentServer } from "../../src/cluster/agent-server.ts";
import type { Cluster } from "../../src/cluster/cluster.ts";
import type { ServerIdentity } from "../../src/cluster/identity.ts";
import type { Db } from "../../src/storage/db.ts";

const EMPTY = new Uint8Array(0);

function toBytes(data: unknown): Uint8Array {
	if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return data as Uint8Array;
}

export interface CloseInfo {
	code: number;
	reason: string;
}

/** A websocket that queues binary messages until a sink takes over (used after the handshake). */
class MessageQueue {
	#queue: Uint8Array[] = [];
	#sink: ((bytes: Uint8Array) => void) | undefined;
	#waiter: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | undefined;
	#closed: CloseInfo | undefined;

	constructor(ws: WebSocket) {
		ws.on("message", (data, isBinary) => {
			if (!isBinary) return;
			const bytes = toBytes(data);
			if (this.#sink) this.#sink(bytes);
			else if (this.#waiter) {
				const waiter = this.#waiter;
				this.#waiter = undefined;
				waiter.resolve(bytes);
			} else this.#queue.push(bytes);
		});
		ws.once("close", (code, reason) => {
			this.#closed = { code, reason: reason.toString() };
			this.#waiter?.reject(new Error(`closed: ${code} ${reason.toString()}`));
			this.#waiter = undefined;
		});
	}

	next(): Promise<Uint8Array> {
		const queued = this.#queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.#closed) return Promise.reject(new Error(`closed: ${this.#closed.code} ${this.#closed.reason}`));
		return new Promise((resolve, reject) => {
			this.#waiter = { resolve, reject };
		});
	}

	setSink(sink: (bytes: Uint8Array) => void): void {
		this.#sink = sink;
		for (const bytes of this.#queue.splice(0)) sink(bytes);
	}

	get closed(): CloseInfo | undefined {
		return this.#closed;
	}
}

/** crhs's agent endpoint on an ephemeral localhost port, for a fake crha to connect to. */
export class TestAgentServer {
	readonly identity: ServerIdentity;
	readonly #server: Server;
	readonly #agents: AgentServer;
	readonly port: number;

	private constructor(server: Server, agents: AgentServer, identity: ServerIdentity, port: number) {
		this.#server = server;
		this.#agents = agents;
		this.identity = identity;
		this.port = port;
	}

	static async start(db: Db, identity: ServerIdentity, cluster: Cluster): Promise<TestAgentServer> {
		const server = createServer();
		const agents = new AgentServer(db, identity, cluster);
		server.on("upgrade", (req, socket, head) => {
			if (!agents.handleUpgrade(req, socket, head)) socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return new TestAgentServer(server, agents, identity, (server.address() as AddressInfo).port);
	}

	get url(): string {
		return `ws://127.0.0.1:${this.port}/agent`;
	}

	async close(): Promise<void> {
		this.#agents.close();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	/** Opens a pending handshake. The caller sends message 1 itself, so it can observe a rejection. */
	async prepare(staticKey: KeyPair): Promise<{
		ws: WebSocket;
		messages: MessageQueue;
		hs: HandshakeState;
		closed: Promise<CloseInfo>;
	}> {
		const ws = new WebSocket(this.url);
		// The challenge may arrive before the open event is handled; listen first.
		const messages = new MessageQueue(ws);
		const closed = new Promise<CloseInfo>((resolve) => {
			ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		});
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		const challenge = await messages.next();
		const hs = HandshakeState.initiator({
			prologue: Buffer.concat([Buffer.from("crh/1"), Buffer.from(challenge)]),
			staticKey,
			remoteStaticKey: this.identity.keyPair.publicKey,
		});
		return { ws, messages, hs, closed };
	}

	/** Performs the full handshake and returns a wire peer for the fake crha. */
	async connect(
		staticKey: KeyPair,
		init: HandshakeInit,
		negotiated: readonly string[] = SUPPORTED_NAMES,
	): Promise<FakeCrha> {
		const { ws, messages, hs, closed } = await this.prepare(staticKey);
		ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(init))));
		const message2 = await messages.next();
		const response = handshakeResponseCodec.decode(decodeCbor(hs.readMessage(message2)));
		const ciphers = hs.split();
		const sendRaw = (bytes: Uint8Array): void => {
			ws.send(ciphers.send.encrypt(EMPTY, bytes));
		};
		const peer = new Peer({ negotiated, send: sendRaw });
		messages.setSink((bytes) => {
			let plain: Uint8Array;
			try {
				plain = ciphers.receive.decrypt(EMPTY, bytes);
			} catch {
				return;
			}
			peer.receive(plain);
		});
		ws.once("close", (code, reason) => peer.close(reason.toString() || `closed (${code})`));
		return new FakeCrha(ws, peer, response, closed, sendRaw);
	}
}

/**
 * A fake crha that speaks protocol 1.1 (doc/protocol.md#m4提权). It records everything crhs sends to a
 * node and answers the optional commands like a node would; tests override `answerStart` (or register
 * their own handler) to script a rejection, and push trust summaries with `trust`.
 */
export class FakeCrha {
	readonly ws: WebSocket;
	readonly peer: Peer;
	readonly response: HandshakeResponse;
	readonly closed: Promise<CloseInfo>;
	/** Send one raw plaintext frame, bypassing Peer's encode and validation. */
	readonly sendRaw: (bytes: Uint8Array) => void;
	/** Every task.start the server sent, in order. */
	readonly starts: TaskStart[] = [];
	/** Every revocations.add batch, in order. */
	readonly revocations: Revocation[][] = [];
	/** Every local.request the server sent, in order. */
	readonly localRequests: LocalRequest[] = [];
	/** The task ids of every task.exit.ack, in order. */
	readonly exitAcks: string[] = [];
	/**
	 * Answers task.start; throw RemoteError(code, message) to reject it before acceptance. The start is
	 * recorded first, so a test sees it even when it is rejected.
	 */
	answerStart: (start: TaskStart) => void | Promise<void> = () => {};

	constructor(
		ws: WebSocket,
		peer: Peer,
		response: HandshakeResponse,
		closed: Promise<CloseInfo>,
		sendRaw: (bytes: Uint8Array) => void,
	) {
		this.ws = ws;
		this.peer = peer;
		this.response = response;
		this.closed = closed;
		this.sendRaw = sendRaw;
		peer.onRequest("task.start", async (start) => {
			this.starts.push(start);
			await this.answerStart(start);
			return {};
		});
		peer.onRequest("task.input", () => ({}));
		peer.onRequest("task.cancel", () => ({}));
		peer.onRequest("revocations.add", (body) => {
			this.revocations.push(body.entries);
			return {};
		});
		peer.onRequest("local.request", (request) => {
			this.localRequests.push(request);
			return { kind: "pending" };
		});
		peer.onRequest("local.withdraw", () => ({}));
		peer.onEvent("task.exit.ack", (ack) => {
			this.exitAcks.push(ack.taskId);
		});
		peer.onEvent("local.decision", () => {});
	}

	/** Pushes a trust.summary event (doc/protocol.md#trustsummary). */
	trust(report: TrustReport): void {
		this.peer.emit("trust.summary", report);
	}

	/** Reports a finished task to crhs, as the node would after task.start was accepted. */
	exit(taskId: string, outcome: TaskExit["outcome"] = { kind: "code", value: 0 }, extra: Partial<TaskExit> = {}): void {
		this.peer.emit("task.exit", {
			taskId,
			outcome,
			timedOut: false,
			cancelled: false,
			stdoutEnd: 0,
			stderrEnd: 0,
			outputFile: "",
			...extra,
		});
	}
}

export function handshakeInit(overrides: Partial<HandshakeInit> = {}): HandshakeInit {
	return {
		protocolMajor: 1,
		protocolMinor: 0,
		commands: [...SUPPORTED_NAMES],
		crhaVersion: "test",
		clientTimeMs: Date.now(),
		enroll: null,
		...overrides,
	};
}

export async function waitFor<T>(
	what: string,
	fn: () => T | undefined | false | Promise<T | undefined | false>,
	timeoutMs = 5_000,
	intervalMs = 10,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
