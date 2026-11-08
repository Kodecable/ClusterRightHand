import { describe, expect, it, vi } from "vitest";
import { StateRefreshes } from "../src/agent/runtime-host/state-refreshes.ts";
import type { SessionState } from "../src/agent/session-state.ts";

/**
 * The D118 coalescing rule (doc/agent-runtime.md#会话状态): refreshes of one session are serialized, a request
 * while one runs shares its promise and asks for one more pass, and the entry disappears after the pass even
 * when it throws.
 */
describe("StateRefreshes", () => {
	it("turns concurrent requests into one pass plus at most one extra pass", async () => {
		const refreshes = new StateRefreshes();
		let release!: (state: SessionState) => void;
		const compute = vi.fn(async (): Promise<SessionState> => {
			return await new Promise<SessionState>((resolve) => {
				release = resolve;
			});
		});

		const first = refreshes.run("session", compute);
		const second = refreshes.run("session", compute);
		const third = refreshes.run("session", compute);
		// Every concurrent caller shares the running pass instead of starting one of its own.
		expect(first).toBe(second);
		expect(second).toBe(third);
		expect(compute).toHaveBeenCalledTimes(1);
		expect(refreshes.isRunning("session")).toBe(true);

		release("running");
		// The requests above arrived during the first pass: exactly one more pass reads the data again.
		await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2));
		expect(refreshes.isRunning("session")).toBe(true);

		release("awaiting");
		expect(await Promise.all([first, second, third])).toEqual(["awaiting", "awaiting", "awaiting"]);
		// No request arrived during the second pass, so no third pass is due.
		expect(compute).toHaveBeenCalledTimes(2);
		expect(refreshes.isRunning("session")).toBe(false);
	});

	it("removes the entry after a throwing pass", async () => {
		const refreshes = new StateRefreshes();
		const failed = refreshes.run("session", async () => {
			throw new Error("the state read failed");
		});
		await expect(failed).rejects.toThrow("the state read failed");
		expect(refreshes.isRunning("session")).toBe(false);

		// The next request starts a fresh pass instead of joining the rejected one.
		await expect(refreshes.run("session", async () => "running")).resolves.toBe("running");
	});

	it("shares a rejection with every concurrent caller", async () => {
		const refreshes = new StateRefreshes();
		let reject!: (error: Error) => void;
		const compute = vi.fn(async (): Promise<SessionState> => {
			return await new Promise<SessionState>((_resolve, rejectPromise) => {
				reject = rejectPromise;
			});
		});

		const first = refreshes.run("session", compute);
		const second = refreshes.run("session", compute);
		reject(new Error("the state read failed"));
		await expect(first).rejects.toThrow("the state read failed");
		await expect(second).rejects.toThrow("the state read failed");
		expect(compute).toHaveBeenCalledTimes(1);
		expect(refreshes.isRunning("session")).toBe(false);
	});
});
