/**
 * The turn tracking of KeyedQueue and the in-turn assertion (doc/design/execution.md "Task row concurrency").
 * Under vitest a wait that would run inside a task queue turn throws; outside one the same wait is fine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClusterCore } from "../src/cluster/core.ts";
import type { NodeLink } from "../src/cluster/links.ts";
import type { Db } from "../src/storage/db.ts";
import { currentTurns, KeyedQueue } from "../src/util/keyed-queue.ts";
import { openTestDb } from "./helpers/db.ts";

describe("queue turns", () => {
	it("tracks nested turns and forgets them once they settle", async () => {
		const taskQueue = new KeyedQueue("task queue");
		const groupQueue = new KeyedQueue("task group queue");
		expect(taskQueue.inTurn()).toBe(false);
		expect(currentTurns()).toEqual([]);
		const inNested = await taskQueue.run("task-1", async () => {
			expect(taskQueue.inTurn()).toBe(true);
			expect(groupQueue.inTurn()).toBe(false);
			expect(currentTurns()).toEqual([{ queue: "task queue", key: "task-1" }]);
			return groupQueue.run("group-1", async () => {
				expect(taskQueue.inTurn()).toBe(true);
				expect(groupQueue.inTurn()).toBe(true);
				return currentTurns();
			});
		});
		expect(inNested).toEqual([
			{ queue: "task queue", key: "task-1" },
			{ queue: "task group queue", key: "group-1" },
		]);
		expect(taskQueue.inTurn()).toBe(false);
		expect(currentTurns()).toEqual([]);
	});

	it("does not see a turn of another queue", async () => {
		const taskQueue = new KeyedQueue("task queue");
		const other = new KeyedQueue("other queue");
		await other.run("key", async () => {
			expect(taskQueue.inTurn()).toBe(false);
			expect(other.inTurn()).toBe(true);
		});
	});
});

describe("the in-turn assertion", () => {
	let db: Db;
	let core: ClusterCore;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		// No node in the database: the wait outside a turn fails at once instead of running out a grace.
		core = new ClusterCore(db, { nodeOfflineGraceMs: 0, trustWaitMs: 0 });
	});

	afterEach(async () => {
		core.endWaits();
		await db.destroy();
	});

	it("throws when waitNodeReady is called inside a task queue turn", async () => {
		await expect(core.taskQueue.run("task-1", () => core.waitNodeReady("node"))).rejects.toThrow(
			"waitNodeReady inside a task queue turn",
		);
	});

	it("throws when waitTrust is called inside a task queue turn, even for a fresh link", async () => {
		const link = {
			conn: { nodeId: "node" },
			active: true,
			ready: true,
			queried: new Set<string>(),
			trustFresh: true,
			trustWaiters: new Set<() => void>(),
		} as unknown as NodeLink;
		await expect(core.taskQueue.run("task-1", () => core.waitTrust(link))).rejects.toThrow(
			"waitTrust inside a task queue turn",
		);
	});

	it("does not throw for the same calls outside a turn", async () => {
		await expect(core.waitNodeReady("node")).resolves.toBeUndefined();
	});
});
