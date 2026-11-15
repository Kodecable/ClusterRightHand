/**
 * A transfer side that fails is failed through the task queue; that failure handler can itself fail
 * (the database is gone). It must be tracked like any other background write, not left as an
 * unhandled rejection (data-transfer.ts).
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CipherState, type TransportCiphers } from "@crh/noise";
import {
	type DataConnectionInit,
	dataFrameCodec,
	encode as encodeCbor,
	type TaskSpec,
	taskSpecToJson,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterCore } from "../src/cluster/core.ts";
import { acceptDataConnection } from "../src/cluster/data-transfer.ts";

const EMPTY = new Uint8Array(0);

/** Only the FrameStream surface a data connection uses. */
class FakeSocket extends EventEmitter {
	close(): void {}
	terminate(): void {}
	pause(): void {}
	resume(): void {}
}

describe("a transfer failure whose handler fails", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "crhs-transfer-failure-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it("logs the failure and keeps it tracked instead of rejecting unhandled", async () => {
		const nodeId = "node-1";
		const taskId = "task-1";
		const transferId = "transfer-1";
		const spec: TaskSpec = {
			kind: "file.pull",
			path: "/etc/app.conf",
			maxBytes: 1024,
			endpoint: { kind: "crhs", transferId },
		};
		const pending = new Set<Promise<void>>();
		const background = vi.fn((what: string, work: Promise<unknown>) => {
			const tracked: Promise<void> = work
				.catch((err: unknown) => {
					console.error(`${what}:`, err);
				})
				.then(() => {
					pending.delete(tracked);
				});
			pending.add(tracked);
		});
		const core = {
			closing: false,
			links: new Map([[nodeId, { ready: true, conn: { closed: false } }]]),
			usedTransfers: new Set<string>(),
			dataTransfers: new Map(),
			dataIdleTimeoutMs: 1_000,
			transferContext: () => ({ root }),
			row: async () => ({
				id: taskId,
				node_id: nodeId,
				state: "running",
				kind: "file.pull",
				transfer: JSON.stringify({
					transferId,
					location: { kind: "staging", path: "incoming", size: null, sha256: null },
				}),
				spec: JSON.stringify(taskSpecToJson(spec)),
				actor_id: "user-1",
			}),
			taskQueue: {
				run: async () => {
					throw new Error("database is gone");
				},
			},
			background,
		} as unknown as ClusterCore;
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const socket = new FakeSocket();
		const ciphers: TransportCiphers = {
			send: new CipherState(Buffer.alloc(32)),
			receive: new CipherState(Buffer.alloc(32)),
			handshakeHash: new Uint8Array(32),
		};
		const init: DataConnectionInit = { protocolMajor: 1, taskId, transferId };

		await acceptDataConnection(core, nodeId, socket as never, ciphers, init);
		// The node aborts; the transfer side rejects and its failure handler (the task queue) throws.
		socket.emit(
			"message",
			ciphers.send.encrypt(EMPTY, encodeCbor(dataFrameCodec.encode({ kind: "abort", code: "input_mismatch" }))),
			true,
		);

		await vi.waitFor(() => expect(background).toHaveBeenCalledWith("failing a transfer failed", expect.any(Promise)));
		await vi.waitFor(() => expect(pending.size).toBe(0));
		expect(log).toHaveBeenCalledWith(
			"failing a transfer failed:",
			expect.objectContaining({ message: "database is gone" }),
		);
		// The transfer is still the map's entry: failing the task failed before that cleanup ran, and the
		// next task turn (or close) must still be able to see it.
		expect(core.dataTransfers.has(taskId)).toBe(true);
	});
});
