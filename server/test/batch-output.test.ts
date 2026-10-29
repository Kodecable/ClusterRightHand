import { describe, expect, it } from "vitest";
import {
	BATCH_GROUP_BYTES,
	BATCH_GROUP_LINES,
	BATCH_NODE_BYTES,
	BATCH_NODE_LINES,
	createLiveTask,
	GroupBudget,
	TailAccumulator,
} from "../src/cluster/batch-output.ts";

function bytes(n: number, fill = 0x61): Buffer {
	return Buffer.alloc(n, fill);
}

function countNewlines(buf: Buffer): number {
	let count = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
	return count;
}

function totalTailBytes(nodes: TailAccumulator[]): number {
	return nodes.reduce((sum, node) => sum + node.tail().length, 0);
}

/** Eight text nodes that each send one full-size chunk: the group budget runs out at the seventh. */
function drainedGroup(): { budget: GroupBudget; nodes: TailAccumulator[] } {
	const budget = new GroupBudget();
	const nodes = Array.from({ length: 8 }, () => new TailAccumulator(budget));
	for (const node of nodes) expect(node.append("stdout", 0, bytes(BATCH_NODE_BYTES))).toBe(true);
	return { budget, nodes };
}

describe("TailAccumulator", () => {
	it("grants in arrival order until the group budget is exhausted", () => {
		const { budget, nodes } = drainedGroup();
		expect(nodes.map((node) => node.grant.bytes)).toEqual([
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			2048,
			0,
		]);
		expect(nodes.map((node) => node.tail().length)).toEqual([
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			BATCH_NODE_BYTES,
			2048,
			0,
		]);
		expect(totalTailBytes(nodes)).toBe(BATCH_GROUP_BYTES);
		expect(budget.bytesLeft).toBe(0);
		// A node that got no grant still advances its acknowledged offset, so crha can release its buffer.
		expect(nodes[7]?.end("stdout")).toBe(BATCH_NODE_BYTES);
	});

	it("caps one node at 8 KiB and 128 newline characters", () => {
		const budget = new GroupBudget();
		const byBytes = new TailAccumulator(budget);
		expect(byBytes.append("stdout", 0, bytes(10 * 1024))).toBe(true);
		expect(byBytes.grant.bytes).toBe(BATCH_NODE_BYTES);
		expect(byBytes.tail().length).toBe(BATCH_NODE_BYTES);
		expect(byBytes.end("stdout")).toBe(10 * 1024);

		const byLines = new TailAccumulator(budget);
		const manyLines = Buffer.from("x\n".repeat(200));
		expect(byLines.append("stdout", 0, manyLines)).toBe(true);
		expect(byLines.grant.lines).toBe(BATCH_NODE_LINES);
		expect(countNewlines(byLines.tail())).toBe(BATCH_NODE_LINES);
		expect(byLines.tail().toString()).toBe("x\n".repeat(BATCH_NODE_LINES));
	});

	it("keeps rolling inside a grant after the budget is exhausted, without returning bytes", () => {
		const { budget, nodes } = drainedGroup();
		const first = nodes[0] as TailAccumulator;
		const before = first.grant.bytes;
		expect(first.append("stdout", BATCH_NODE_BYTES, Buffer.from("new-"))).toBe(true);
		expect(first.grant.bytes).toBe(before); // grants never shrink
		expect(first.tail().length).toBe(BATCH_NODE_BYTES);
		expect(first.tail().subarray(-4).toString()).toBe("new-");
		expect(budget.bytesLeft).toBe(0); // pushed-out bytes are not handed back

		const last = nodes[7] as TailAccumulator;
		expect(last.append("stdout", BATCH_NODE_BYTES, Buffer.from("ignored"))).toBe(true);
		expect(last.tail().length).toBe(0);
		expect(last.end("stdout")).toBe(BATCH_NODE_BYTES + "ignored".length);
	});

	it("never holds more than the group budget with 200 nodes writing 1 MiB each", () => {
		const budget = new GroupBudget();
		const nodes = Array.from({ length: 200 }, () => new TailAccumulator(budget));
		const chunk = Buffer.from("0123456789\n".repeat(Math.ceil((1024 * 1024) / 11)));
		let newlines = 0;
		for (const node of nodes) {
			expect(node.append("stdout", 0, chunk)).toBe(true);
			newlines += countNewlines(node.tail());
			expect(totalTailBytes(nodes)).toBeLessThanOrEqual(BATCH_GROUP_BYTES);
		}
		expect(newlines).toBeLessThanOrEqual(BATCH_GROUP_LINES);
		expect(budget.bytesLeft).toBe(0);
		expect(budget.linesLeft).toBe(0);
		// Every node acked the whole chunk even when nothing was kept.
		expect(nodes.every((node) => node.end("stdout") === chunk.length)).toBe(true);
	});

	it("detects gaps and skips overlapping resends", () => {
		const budget = new GroupBudget();
		const node = new TailAccumulator(budget);
		expect(node.append("stdout", 0, Buffer.from("hello"))).toBe(true);
		expect(node.append("stdout", 2, Buffer.from("lloworld"))).toBe(true);
		expect(node.end("stdout")).toBe(10);
		expect(node.tail().toString()).toBe("helloworld");
		expect(node.grant.bytes).toBe(10); // only fresh bytes are granted
		expect(budget.bytesLeft).toBe(BATCH_GROUP_BYTES - 10);

		// A gap is refused and does not advance the end.
		expect(node.append("stdout", 20, Buffer.from("gap"))).toBe(false);
		expect(node.end("stdout")).toBe(10);
		expect(node.tail().toString()).toBe("helloworld");

		// A stale resend is acknowledged but changes nothing.
		expect(node.append("stdout", 0, Buffer.from("hello"))).toBe(true);
		expect(node.tail().toString()).toBe("helloworld");
		expect(node.grant.bytes).toBe(10);

		// The streams have independent offsets; text mode keeps both in one tail, in arrival order.
		expect(node.append("stderr", 0, Buffer.from("err"))).toBe(true);
		expect(node.end("stderr")).toBe(3);
		expect(node.tail().toString()).toBe("helloworlderr");
	});
});

describe("createLiveTask", () => {
	it("status counts bytes without keeping output", () => {
		const live = createLiveTask("status");
		expect(live.append("stdout", 0, Buffer.from("hello"))).toBe(true);
		expect(live.append("stdout", 2, Buffer.from("lloworld"))).toBe(true);
		expect(live.append("stderr", 0, Buffer.from("oops"))).toBe(true);
		const snapshot = live.snapshot();
		expect(snapshot).toEqual({
			stdoutBytes: 10,
			stderrBytes: 4,
			stdoutHead: null,
			stdoutTail: null,
			stderrHead: null,
			stderrTail: null,
		});
		// task.exit's ends override the totals for a status task.
		expect(live.snapshot({ stdout: 42, stderr: 7 })).toMatchObject({ stdoutBytes: 42, stderrBytes: 7 });
	});

	it("full keeps the head and the tail as before", () => {
		const live = createLiveTask("full");
		live.append("stdout", 0, Buffer.from("hello"));
		live.append("stderr", 0, Buffer.from("oops"));
		expect(live.snapshot()).toMatchObject({
			stdoutBytes: 5,
			stderrBytes: 4,
			stdoutHead: Buffer.from("hello"),
			stdoutTail: Buffer.from("hello"),
			stderrHead: Buffer.from("oops"),
			stderrTail: Buffer.from("oops"),
		});
	});
});
