/**
 * Data connections: the transport of a file.push/file.pull transfer (doc/design/protocol.md "Data
 * connections"). A node opens a separate WebSocket to crhs for one transfer; crhs accepts it only
 * from an active node whose control connection is up, for a task that node accepted, once per
 * transfer id. Bytes stream in order with WebSocket backpressure and are verified before anything is
 * committed.
 */
import type { TransportCiphers } from "@crh/noise";
import {
	DATA_CHUNK_BYTES,
	DATA_IDLE_TIMEOUT_MS,
	type DataConnectionInit,
	type DataFrame,
	dataFrameCodec,
	decode as decodeCbor,
	encode as encodeCbor,
	type TaskExit,
	type TaskSpec,
} from "@crh/protocol";
import type { WebSocket } from "ws";
import type { TransferLocationJson, TransferWrite } from "../library/transfer-location.ts";
import { openTransferLocation } from "../library/transfer-location.ts";
import { closeReason, toBytes } from "./connection.ts";
import type { ClusterCore } from "./core.ts";
import { specFromRow } from "./spec.ts";
import { endTask, requestTaskCancel } from "./task-end.ts";
import { TERMINAL } from "./types.ts";

const EMPTY = new Uint8Array(0);
/** How long a transfer whose connection closed waits for the node's task.exit before failing as io_error. */
const EXIT_GRACE_MS = 5_000;
/** Bytes buffered per data connection before the socket is paused (backpressure). */
const RECEIVE_WINDOW = 8;

/** The node aborted a transfer with a protocol code; it fails the task once the transfer side stopped. */
class TransferAborted extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** The transfer descriptor stored on a task row. */
export interface TransferRecord {
	transferId: string;
	location: TransferLocationJson;
}

/** Reads and parses the stored transfer JSON of a task row. */
export function parseTransferRecord(json: string | null): TransferRecord | null {
	if (json === null) return null;
	try {
		const value = JSON.parse(json) as Record<string, unknown>;
		if (typeof value.transferId !== "string") return null;
		return { transferId: value.transferId, location: value.location as TransferLocationJson };
	} catch {
		return null;
	}
}

/** One accepted data connection. */
export interface DataTransfer {
	taskId: string;
	nodeId: string;
	/** The write side of a pull destination, kept until task.exit commits or discards it. */
	write?: TransferWrite;
	/** The finished content of a pull destination; set once [end] arrived. */
	finished?: { size: number; sha256: string };
	frames: FrameStream;
	/** Resolves when the transfer side stopped, after [end], an abort or a failure. */
	done: Promise<void>;
	/** A pull keeps its write for task.exit to verify and commit, so close must not drop it. */
	keepForExit?: boolean;
	/** Set when the idle timer fired: the transfer fails at once instead of waiting for task.exit. */
	idle?: boolean;
	close(): void;
}

/**
 * Refuse a data connection: nothing was accepted, so the socket is closed without a frame. crha sees
 * the close and fails the task.
 */
function refuse(ws: WebSocket, reason: string): void {
	try {
		ws.close(1008, closeReason(reason));
	} catch {
		ws.terminate();
	}
}

/**
 * Validates and accepts the data connection of one transfer, then runs it in the background. Errors
 * after acceptance fail the task, never the control connection.
 */
export async function acceptDataConnection(
	core: ClusterCore,
	nodeId: string,
	ws: WebSocket,
	ciphers: TransportCiphers,
	init: DataConnectionInit,
): Promise<void> {
	// Attach the message listener before the first await: the node starts sending as soon as its
	// handshake response arrives, and a message with no listener would be lost.
	const frames = new FrameStream(ws, ciphers);
	if (core.closing) return refuse(ws, "server shutting down");
	const link = core.links.get(nodeId);
	if (!link?.ready || link.conn.closed) return refuse(ws, "no active control connection");
	const row = await core.row(init.taskId);
	if (!row || row.node_id !== nodeId) return refuse(ws, "unknown task");
	if (row.state !== "dispatched" && row.state !== "running") return refuse(ws, "the task does not run");
	if (row.kind !== "file.push" && row.kind !== "file.pull") return refuse(ws, "the task is not a transfer");
	const record = parseTransferRecord(row.transfer);
	if (!record || record.transferId !== init.transferId) return refuse(ws, "unknown transfer");
	if (core.usedTransfers.has(init.transferId) || core.dataTransfers.has(row.id))
		return refuse(ws, "the transfer was already used");
	let spec: TaskSpec;
	try {
		spec = specFromRow(row.spec, "task");
	} catch {
		return refuse(ws, "the task spec cannot be read");
	}

	core.usedTransfers.add(init.transferId);
	const storage = openTransferLocation(core.transferContext(), record.location);
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const transfer: DataTransfer = {
		taskId: row.id,
		nodeId,
		frames,
		done,
		close: () => {
			frames.close();
			if (!transfer.keepForExit && core.dataTransfers.get(row.id) === transfer) core.dataTransfers.delete(row.id);
		},
	};
	core.dataTransfers.set(row.id, transfer);
	const transferId = row.id;
	void runTransfer(transfer, spec, storage).then(
		() => {
			transfer.close();
			resolveDone();
		},
		async (err: unknown) => {
			// The task.exit handler settles a transfer while holding the task queue, so the transfer
			// side must resolve before failing the task through that same queue.
			resolveDone();
			if (core.dataTransfers.get(transferId) !== transfer) return;
			// A closed connection without an abort frame usually means the node refused the bytes; its
			// task.exit carries the precise code (input_mismatch, ...), so give it a moment to arrive.
			// failTransfer leaves a task that already ended alone. An idle timeout has no exit coming.
			if (!(err instanceof TransferAborted) && transfer.idle !== true) {
				await new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS).unref());
			}
			const code = err instanceof TransferAborted ? err.code : "io_error";
			const message =
				transfer.idle === true
					? "the data connection was idle for too long"
					: err instanceof Error
						? err.message
						: String(err);
			await failTransfer(core, transferId, nodeId, code, message);
		},
	);
}

/**
 * Runs one side of a transfer. A push reads the crhs-side location and sends its bytes; a pull
 * receives bytes into the location and keeps the write for task.exit to verify and commit.
 */
async function runTransfer(
	transfer: DataTransfer,
	spec: TaskSpec,
	storage: ReturnType<typeof openTransferLocation>,
): Promise<void> {
	const idle = idleTimer(() => {
		// Close the socket but leave the entry in the map: the rejection path below then fails the
		// task and discards a pull's partial write (close() alone would drop the entry and leak it).
		transfer.idle = true;
		transfer.frames.close();
	});
	try {
		if (spec.kind === "file.push") {
			for await (const chunk of storage.openRead()) {
				// A read stream may hand over more than one data frame holds.
				const bytes = new Uint8Array(chunk);
				for (let off = 0; off < bytes.length; off += DATA_CHUNK_BYTES) {
					await transfer.frames.send(
						encodeDataFrame({ kind: "data", bytes: bytes.subarray(off, off + DATA_CHUNK_BYTES) }),
					);
					idle.reset();
				}
			}
			await transfer.frames.send(encodeDataFrame({ kind: "end" }));
		} else if (spec.kind === "file.pull") {
			// crhs trusts the node's max_bytes check only as an early report: enforce it here too, so a
			// buggy or malicious node cannot fill the disk (doc/design/library.md "File plane").
			let received = 0;
			const write = storage.openWrite();
			transfer.write = write;
			for (;;) {
				const frame = decodeDataFrame(await transfer.frames.next());
				idle.reset();
				if (frame.kind === "data") {
					received += frame.bytes.length;
					if (received > spec.maxBytes) {
						throw new TransferAborted(
							"too_large",
							`the node sent more than the ${spec.maxBytes} bytes the pull accepts`,
						);
					}
					await write.write(frame.bytes);
				} else if (frame.kind === "end") {
					transfer.finished = await write.finish();
					// The result that verifies the bytes arrives with task.exit; keep the write.
					transfer.keepForExit = true;
					break;
				} else {
					await write.discard();
					delete transfer.write;
					throw new TransferAborted(frame.code, "the node aborted the transfer");
				}
			}
		}
		transfer.frames.close();
	} finally {
		idle.stop();
	}
}

function idleTimer(onIdle: () => void): { reset(): void; stop(): void } {
	let timer = setTimeout(onIdle, DATA_IDLE_TIMEOUT_MS);
	return {
		reset() {
			clearTimeout(timer);
			timer = setTimeout(onIdle, DATA_IDLE_TIMEOUT_MS);
		},
		stop() {
			clearTimeout(timer);
		},
	};
}

/**
 * Ends a transfer's task on the crhs side and tells the node to stop. The node may report an exit
 * later; onExit sees the recorded row and only acknowledges it.
 */
export async function failTransfer(
	core: ClusterCore,
	taskId: string,
	nodeId: string,
	code: string,
	message: string,
): Promise<void> {
	await core.taskQueue.run(taskId, async () => {
		const row = await core.row(taskId);
		if (!row || TERMINAL.has(row.state)) return;
		await endTask(core, taskId, {
			write: {
				from: ["dispatched", "running"],
				set: {
					state: "failed",
					error_code: code,
					error_message: message,
				},
			},
			live: "drop",
			group: "row",
			awaitGroup: true,
			onChange: row.actor_id,
		});
		requestTaskCancel(core, nodeId, taskId);
	});
	// A failed transfer never commits; drop its write (and the temporary file) now.
	const transfer = core.dataTransfers.get(taskId);
	if (transfer) {
		core.dataTransfers.delete(taskId);
		transfer.close();
		await transfer.write?.discard();
	}
}

/**
 * Settles the crhs-side location when the task ends. A pull's received bytes are verified against
 * the pull result and committed; a failed or aborted pull discards its temporary file. Returns the
 * failure to record on the task, if any.
 */
export async function settleTransferOnExit(
	core: ClusterCore,
	row: { id: string; kind: string; transfer: string | null },
	exit: TaskExit,
): Promise<{ code: string; message: string } | undefined> {
	const transfer = core.dataTransfers.get(row.id);
	if (!transfer) return undefined;
	const result = exit.result;
	const success = exit.outcome.kind === "code" && result !== null && result.kind === "file.pull";
	// The node sends task.exit right after [end]; the two sockets are independent, so the exit can
	// arrive while the last data frames are still queued here. Wait for the transfer side to stop
	// before deciding, or the commit would see a truncated file.
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		transfer.done,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, DATA_IDLE_TIMEOUT_MS);
			timer.unref();
		}),
	]);
	if (timer) clearTimeout(timer);
	core.dataTransfers.delete(row.id);
	transfer.close();
	if (!success) {
		await transfer.write?.discard();
		return undefined;
	}
	if (!transfer.write || !transfer.finished) {
		await transfer.write?.discard();
		return { code: "io_error", message: "the data connection ended before the transfer did" };
	}
	try {
		await transfer.write.commit({ size: result.size, sha256: Buffer.from(result.sha256).toString("hex") });
		return undefined;
	} catch (err) {
		await transfer.write.discard();
		return {
			code: "input_mismatch",
			message: `the received file does not match the pull result: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

function encodeDataFrame(frame: DataFrame): Uint8Array {
	return encodeCbor(dataFrameCodec.encode(frame));
}

function decodeDataFrame(bytes: Uint8Array): DataFrame {
	return dataFrameCodec.decode(decodeCbor(bytes));
}

/**
 * The encrypted frame stream of one data connection: decryption happens on receipt (the nonce order
 * is the wire order), the socket is paused while more than RECEIVE_WINDOW frames wait, and sending
 * resolves when the WebSocket flushed the message to the kernel.
 */
export class FrameStream {
	readonly #ws: WebSocket;
	readonly #ciphers: TransportCiphers;
	readonly #queue: Uint8Array[] = [];
	#waiter: { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void } | undefined;
	#closed: Error | undefined;
	#paused = false;

	constructor(ws: WebSocket, ciphers: TransportCiphers) {
		this.#ws = ws;
		this.#ciphers = ciphers;
		ws.on("message", (data, isBinary) => {
			if (this.#closed) return;
			if (!isBinary) return this.#fail(new Error("text message"));
			let plain: Uint8Array;
			try {
				plain = ciphers.receive.decrypt(EMPTY, toBytes(data));
			} catch {
				return this.#fail(new Error("bad message"));
			}
			this.#push(plain);
		});
		ws.on("close", () => this.#fail(new Error("data connection closed")));
		ws.on("error", (err) => this.#fail(err));
	}

	async next(): Promise<Uint8Array> {
		const queued = this.#queue.shift();
		if (queued) {
			if (this.#paused && this.#queue.length < RECEIVE_WINDOW) {
				this.#paused = false;
				this.#ws.resume();
			}
			return queued;
		}
		if (this.#closed) throw this.#closed;
		return new Promise((resolve, reject) => {
			this.#waiter = { resolve, reject };
		});
	}

	async send(plain: Uint8Array): Promise<void> {
		if (this.#closed) throw this.#closed;
		const ciphertext = this.#ciphers.send.encrypt(EMPTY, plain);
		await new Promise<void>((resolve, reject) => {
			this.#ws.send(ciphertext, (err) => (err ? reject(err) : resolve()));
		});
	}

	close(): void {
		this.#fail(new Error("data connection closed"));
		try {
			this.#ws.close(1000, "transfer done");
		} catch {
			this.#ws.terminate();
		}
	}

	#push(bytes: Uint8Array): void {
		if (this.#waiter) {
			const waiter = this.#waiter;
			this.#waiter = undefined;
			waiter.resolve(bytes);
			return;
		}
		this.#queue.push(bytes);
		if (this.#queue.length >= RECEIVE_WINDOW && !this.#paused) {
			this.#paused = true;
			this.#ws.pause();
		}
	}

	#fail(err: Error): void {
		if (this.#closed) return;
		this.#closed = err;
		this.#waiter?.reject(err);
		this.#waiter = undefined;
	}
}
