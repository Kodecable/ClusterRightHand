import { describe, expect, it, vi } from "vitest";
import { KeyedReconciler } from "../src/util/keyed-reconciler.ts";
import { SingleFlight } from "../src/util/single-flight.ts";

/** The shared rules for level-triggered work (doc/design/architecture.md "Concurrency"). */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("KeyedReconciler", () => {
	it("runs once more when a request arrives during a run, and that pass observes the newer data", async () => {
		const reconciles = new KeyedReconciler<string>();
		let current = "old";
		let release!: () => void;
		const gate = deferred<void>();
		const compute = vi.fn(async () => {
			const seen = current;
			if (compute.mock.calls.length === 1) {
				release = () => gate.resolve();
				await gate.promise;
			}
			return seen;
		});

		const first = reconciles.run("key", compute);
		expect(reconciles.isRunning("key")).toBe(true);
		// The state change that arrives while the first pass runs marks it again instead of being lost.
		current = "new";
		const second = reconciles.run("key", compute);
		expect(second).toBe(first);
		expect(compute).toHaveBeenCalledTimes(1);

		release();
		await expect(first).resolves.toBe("new");
		expect(compute).toHaveBeenCalledTimes(2);
		expect(reconciles.isRunning("key")).toBe(false);
	});

	it("coalesces many requests during a run into exactly one rerun", async () => {
		const reconciles = new KeyedReconciler<number>();
		const gate = deferred<void>();
		let calls = 0;
		const compute = vi.fn(async () => {
			calls += 1;
			if (calls === 1) await gate.promise;
			return calls;
		});

		const first = reconciles.run("key", compute);
		const requests = Array.from({ length: 20 }, () => reconciles.run("key", compute));
		gate.resolve();
		await expect(first).resolves.toBe(2);
		// Every caller shares the same run and its final result.
		await expect(Promise.all(requests)).resolves.toEqual(Array.from({ length: 20 }, () => 2));
		expect(compute).toHaveBeenCalledTimes(2);
		expect(reconciles.isRunning("key")).toBe(false);
	});

	it("removes the entry when the pass throws, so the next request starts a fresh pass", async () => {
		const reconciles = new KeyedReconciler<string>();
		await expect(
			reconciles.run("key", async () => {
				throw new Error("the read failed");
			}),
		).rejects.toThrow("the read failed");
		expect(reconciles.isRunning("key")).toBe(false);
		await expect(reconciles.run("key", async () => "running")).resolves.toBe("running");
	});

	it("serializes one key while another key runs concurrently", async () => {
		const reconciles = new KeyedReconciler<string>();
		const gate = deferred<string>();
		const first = reconciles.run("a", () => gate.promise);
		const second = reconciles.run("b", async () => "b");
		await expect(second).resolves.toBe("b");
		expect(reconciles.isRunning("a")).toBe(true);
		gate.resolve("a");
		await expect(first).resolves.toBe("a");
	});
});

describe("SingleFlight", () => {
	it("shares one creation between concurrent callers and forgets it once settled", async () => {
		const flights = new SingleFlight<number>();
		const gate = deferred<number>();
		const create = vi.fn(() => gate.promise);

		const first = flights.run("key", create);
		const second = flights.run("key", create);
		expect(first).toBe(second);
		expect(flights.isRunning("key")).toBe(true);
		expect(flights.current("key")).toBe(first);

		gate.resolve(7);
		await expect(first).resolves.toBe(7);
		expect(create).toHaveBeenCalledTimes(1);
		expect(flights.isRunning("key")).toBe(false);

		// The entry is gone: a later call creates again.
		await expect(flights.run("key", async () => 8)).resolves.toBe(8);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("removes a rejected flight so a later caller can retry", async () => {
		const flights = new SingleFlight<void>();
		const first = flights.run("key", async () => {
			throw new Error("creation failed");
		});
		await expect(first).rejects.toThrow("creation failed");
		expect(flights.isRunning("key")).toBe(false);
		await expect(flights.run("key", async () => {})).resolves.toBeUndefined();
	});

	it("keeps different keys independent", async () => {
		const flights = new SingleFlight<string>();
		const gate = deferred<string>();
		const a = flights.run("a", () => gate.promise);
		const b = flights.run("b", async () => "b");
		await expect(b).resolves.toBe("b");
		expect(flights.size).toBe(1);
		gate.resolve("a");
		await expect(a).resolves.toBe("a");
		expect(flights.size).toBe(0);
	});
});
