import { describe, expect, it } from "vitest";
import { TransferBusyError, TransferScheduler } from "../src/cluster/transfer-scheduler.ts";

describe("transfer scheduler", () => {
	it("runs one transfer per node, queues the next and refuses a full queue", async () => {
		const scheduler = new TransferScheduler({ runningPerNode: 1, queuedPerNode: 1 });
		await scheduler.acquire("t1", "n1");
		expect(scheduler.holds("t1")).toBe(true);
		let promoted = false;
		const queued = scheduler.acquire("t2", "n1").then(() => {
			promoted = true;
		});
		await expect(scheduler.acquire("t3", "n1")).rejects.toBeInstanceOf(TransferBusyError);
		expect(promoted).toBe(false);
		scheduler.release("t1");
		await queued;
		expect(promoted).toBe(true);
		expect(scheduler.holds("t2")).toBe(true);
		scheduler.release("t2");
		expect(scheduler.holds("t2")).toBe(false);
	});

	it("allows a transfer on a different node while one node is busy", async () => {
		const scheduler = new TransferScheduler({ runningPerNode: 1, runningTotal: 16 });
		await scheduler.acquire("t1", "n1");
		await scheduler.acquire("t2", "n2");
		expect(scheduler.holds("t2")).toBe(true);
	});
});
