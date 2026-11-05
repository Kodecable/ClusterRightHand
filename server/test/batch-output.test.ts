import { describe, expect, it } from "vitest";
import {
	BATCH_GROUP_BYTES,
	BATCH_GROUP_LINES,
	BATCH_NODE_BYTES,
	BATCH_NODE_LINES,
	BatchAccumulator,
	checkedOutputLimits,
	createLiveTask,
	GroupBudget,
} from "../src/cluster/batch-output.ts";

function bytes(n: number, fill = 0x61): Buffer {
	return Buffer.alloc(n, fill);
}

function countNewlines(buf: Buffer): number {
	let count = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
	return count;
}

function totalTailBytes(nodes: BatchAccumulator[]): number {
	return nodes.reduce((sum, node) => sum + node.kept().length, 0);
}

/** Eight text nodes that each send one full-size chunk: the group budget runs out at the seventh. */
function drainedGroup(): { budget: GroupBudget; nodes: BatchAccumulator[] } {
	const budget = new GroupBudget();
	const nodes = Array.from({ length: 8 }, () => new BatchAccumulator("text", budget));
	for (const node of nodes) expect(node.append("stdout", 0, bytes(BATCH_NODE_BYTES))).toBe(true);
	return { budget, nodes };
}

describe("BatchAccumulator (text)", () => {
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
		expect(nodes.map((node) => node.kept().length)).toEqual([
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
		const byBytes = new BatchAccumulator("text", budget);
		expect(byBytes.append("stdout", 0, bytes(10 * 1024))).toBe(true);
		expect(byBytes.grant.bytes).toBe(BATCH_NODE_BYTES);
		expect(byBytes.kept().length).toBe(BATCH_NODE_BYTES);
		expect(byBytes.end("stdout")).toBe(10 * 1024);

		const byLines = new BatchAccumulator("text", budget);
		const manyLines = Buffer.from("x\n".repeat(200));
		expect(byLines.append("stdout", 0, manyLines)).toBe(true);
		expect(byLines.grant.lines).toBe(BATCH_NODE_LINES);
		expect(countNewlines(byLines.kept())).toBe(BATCH_NODE_LINES);
		expect(byLines.kept().toString()).toBe("x\n".repeat(BATCH_NODE_LINES));
	});

	it("keeps rolling inside a grant after the budget is exhausted, without returning bytes", () => {
		const { budget, nodes } = drainedGroup();
		const first = nodes[0] as BatchAccumulator;
		const before = first.grant.bytes;
		expect(first.append("stdout", BATCH_NODE_BYTES, Buffer.from("new-"))).toBe(true);
		expect(first.grant.bytes).toBe(before); // grants never shrink
		expect(first.kept().length).toBe(BATCH_NODE_BYTES);
		expect(first.kept().subarray(-4).toString()).toBe("new-");
		expect(budget.bytesLeft).toBe(0); // pushed-out bytes are not handed back

		const last = nodes[7] as BatchAccumulator;
		expect(last.append("stdout", BATCH_NODE_BYTES, Buffer.from("ignored"))).toBe(true);
		expect(last.kept().length).toBe(0);
		expect(last.end("stdout")).toBe(BATCH_NODE_BYTES + "ignored".length);
	});

	it("never holds more than the group budget with 200 nodes writing 1 MiB each", () => {
		const budget = new GroupBudget();
		const nodes = Array.from({ length: 200 }, () => new BatchAccumulator("text", budget));
		const chunk = Buffer.from("0123456789\n".repeat(Math.ceil((1024 * 1024) / 11)));
		let newlines = 0;
		for (const node of nodes) {
			expect(node.append("stdout", 0, chunk)).toBe(true);
			newlines += countNewlines(node.kept());
			expect(totalTailBytes(nodes)).toBeLessThanOrEqual(BATCH_GROUP_BYTES);
		}
		expect(newlines).toBeLessThanOrEqual(BATCH_GROUP_LINES);
		expect(budget.bytesLeft).toBe(0);
		// Lines cannot be granted without bytes, so the budget's line side need not be exhausted.
		expect(budget.linesLeft).toBe(BATCH_GROUP_LINES - newlines);
		// Every node acked the whole chunk even when nothing was kept.
		expect(nodes.every((node) => node.end("stdout") === chunk.length)).toBe(true);
	});

	it("does not grant lines to a node with no byte grant", () => {
		const { budget } = drainedGroup();
		const linesBefore = budget.linesLeft;
		for (let i = 0; i < 10; i++) {
			const node = new BatchAccumulator("text", budget);
			expect(node.append("stdout", 0, bytes(BATCH_NODE_LINES, 0x0a))).toBe(true);
			expect(node.grant).toEqual({ bytes: 0, lines: 0 });
			expect(node.kept()).toEqual(Buffer.alloc(0));
		}
		expect(budget.linesLeft).toBe(linesBefore);
	});

	it("never grants more lines than the node's byte grant", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("text", budget);
		expect(node.append("stdout", 0, Buffer.from("abcdefghij"))).toBe(true);
		expect(node.grant).toEqual({ bytes: 10, lines: 0 });
		// The group has no bytes left, so the next chunk can only draw lines within the 10-byte grant.
		budget.bytesLeft = 0;
		expect(node.append("stdout", 10, bytes(BATCH_NODE_LINES, 0x0a))).toBe(true);
		expect(node.grant).toEqual({ bytes: 10, lines: 10 });
		expect(countNewlines(node.kept())).toBe(10);
	});

	it("starts the tail on a character boundary after cutting to the byte grant", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("text", budget);
		const data = Buffer.from(`${"é".repeat(5000)}a`);
		expect(node.append("stdout", 0, data)).toBe(true);
		expect(node.kept().length).toBeLessThanOrEqual(BATCH_NODE_BYTES);
		const text = node.kept().toString("utf8");
		expect(text).not.toContain("\uFFFD");
		expect(Buffer.byteLength(text)).toBe(node.kept().length);
		expect(text.endsWith("a")).toBe(true);
	});

	it("detects gaps and skips overlapping resends", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("text", budget);
		expect(node.append("stdout", 0, Buffer.from("hello"))).toBe(true);
		expect(node.append("stdout", 2, Buffer.from("lloworld"))).toBe(true);
		expect(node.end("stdout")).toBe(10);
		expect(node.kept().toString()).toBe("helloworld");
		expect(node.grant.bytes).toBe(10); // only fresh bytes are granted
		expect(budget.bytesLeft).toBe(BATCH_GROUP_BYTES - 10);

		// A gap is refused and does not advance the end.
		expect(node.append("stdout", 20, Buffer.from("gap"))).toBe(false);
		expect(node.end("stdout")).toBe(10);
		expect(node.kept().toString()).toBe("helloworld");

		// A stale resend is acknowledged but changes nothing.
		expect(node.append("stdout", 0, Buffer.from("hello"))).toBe(true);
		expect(node.kept().toString()).toBe("helloworld");
		expect(node.grant.bytes).toBe(10);

		// The streams have independent offsets; text mode keeps both in one tail, in arrival order.
		expect(node.append("stderr", 0, Buffer.from("err"))).toBe(true);
		expect(node.end("stderr")).toBe(3);
		expect(node.kept().toString()).toBe("helloworlderr");
	});
});

describe("BatchAccumulator (head)", () => {
	it("keeps the head of the page and drops the node's stderr", () => {
		const budget = new GroupBudget();
		const page = Buffer.from("one\\ntwo\\nthree\\n");
		const node = new BatchAccumulator("head", budget);
		expect(node.append("stdout", 0, page)).toBe(true);
		// A file task's result is task.exit.result, so a head node keeps no stderr (doc/protocol.md TaskResult).
		const stderr = Buffer.from("noise on stderr");
		expect(node.append("stderr", 0, stderr)).toBe(true);
		expect(node.snapshot()).toMatchObject({
			stdoutBytes: page.length,
			stderrBytes: stderr.length,
			stdoutHead: page,
			stdoutTail: null,
			stderrHead: null,
			stderrTail: null,
		});
	});

	it("keeps only the notice crhs writes itself", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("head", budget);
		node.note(Buffer.from("crh: privileged was ignored\\n"));
		expect(node.append("stderr", node.end("stderr"), Buffer.from("from the node"))).toBe(true);
		const snapshot = node.snapshot();
		expect(snapshot.stderrHead?.toString()).toBe("crh: privileged was ignored\\n");
		// The node's bytes are counted, so crha can release them, but they are not kept.
		expect(snapshot.stderrBytes).toBe("crh: privileged was ignored\\n".length + "from the node".length);
	});

	it("cuts the head at the byte grant and drops the rest", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("head", budget);
		const chunk = Buffer.from(`${"x".repeat(BATCH_NODE_BYTES)}more`);
		expect(node.append("stdout", 0, chunk)).toBe(true);
		expect(node.kept().length).toBe(BATCH_NODE_BYTES);
		expect(node.kept().toString()).toBe("x".repeat(BATCH_NODE_BYTES));
		// The acknowledged end still moves past what was kept, so crha can release its buffer.
		expect(node.end("stdout")).toBe(chunk.length);
		// A later chunk cannot grow a head that already used its grant.
		expect(node.append("stdout", chunk.length, Buffer.from("later"))).toBe(true);
		expect(node.kept().length).toBe(BATCH_NODE_BYTES);
	});

	it("caps the head at 128 newline characters", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("head", budget);
		const page = Buffer.from("line\n".repeat(BATCH_NODE_LINES * 2));
		expect(node.append("stdout", 0, page)).toBe(true);
		// The line grant is what caps the kept head, exactly like the text tail: the byte grant alone
		// would keep thousands of short lines.
		expect(node.grant.lines).toBe(BATCH_NODE_LINES);
		expect(countNewlines(node.kept())).toBe(BATCH_NODE_LINES);
		expect(node.kept().toString()).toBe("line\n".repeat(BATCH_NODE_LINES));
		// The acknowledged end still covers the whole chunk, so crha can release its buffer.
		expect(node.end("stdout")).toBe(page.length);
	});

	it("shares the group budget with the text nodes, in arrival order", () => {
		const budget = new GroupBudget();
		const first = new BatchAccumulator("head", budget);
		const second = new BatchAccumulator("head", budget);
		expect(first.append("stdout", 0, bytes(BATCH_NODE_BYTES))).toBe(true);
		expect(second.append("stdout", 0, bytes(BATCH_NODE_BYTES))).toBe(true);
		expect(budget.bytesLeft).toBe(BATCH_GROUP_BYTES - 2 * BATCH_NODE_BYTES);
	});

	it("keeps the page head inside the node's grant, not the group's budget", () => {
		const budget = new GroupBudget();
		const node = new BatchAccumulator("head", budget);
		expect(node.append("stdout", 0, bytes(BATCH_GROUP_BYTES))).toBe(true);
		expect(node.kept().length).toBe(BATCH_NODE_BYTES); // the node's page grant, not the group's budget
		expect(node.snapshot().stderrHead).toBeNull();
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
			outputTail: null,
		});
		// task.exit's ends override the totals for a status task.
		expect(live.snapshot({ stdout: 42, stderr: 7 })).toMatchObject({ stdoutBytes: 42, stderrBytes: 7 });
	});

	it("head needs a group budget and keeps the page head", () => {
		expect(() => createLiveTask("head")).toThrow("head output needs a group budget");
		const live = createLiveTask("head", new GroupBudget());
		live.append("stdout", 0, Buffer.from("hello\n"));
		live.append("stderr", 0, Buffer.from("{}"));
		expect(live.snapshot()).toMatchObject({
			stdoutHead: Buffer.from("hello\n"),
			stdoutTail: null,
			stderrHead: null,
			stderrTail: null,
		});
	});

	it("full keeps the head and the tail as before and one merged tail in arrival order", () => {
		const live = createLiveTask("full");
		live.append("stdout", 0, Buffer.from("a\n"));
		live.append("stderr", 0, Buffer.from("b\n"));
		live.append("stdout", 2, Buffer.from("c"));
		expect(live.snapshot()).toMatchObject({
			stdoutBytes: 3,
			stderrBytes: 2,
			stdoutHead: Buffer.from("a\nc"),
			stdoutTail: Buffer.from("a\nc"),
			stderrHead: Buffer.from("b\n"),
			stderrTail: Buffer.from("b\n"),
			// stdout and stderr interleaved as they arrived, not per stream.
			outputTail: Buffer.from("a\nb\nc"),
		});
	});

	it("full caps its merged tail at the task's limits", () => {
		const byLines = createLiveTask("full", undefined, { maxLines: 1, maxBytes: 100 });
		byLines.append("stdout", 0, Buffer.from("one\ntwo\n"));
		expect(byLines.snapshot().outputTail?.toString()).toBe("two\n");

		const byBytes = createLiveTask("full", undefined, { maxLines: 10, maxBytes: 5 });
		byBytes.append("stdout", 0, Buffer.from("one\ntwo\n"));
		// The byte cut lands after a newline, so the kept tail starts at "two\n".
		expect(byBytes.snapshot().outputTail?.toString()).toBe("two\n");
	});

	it("validates per-node limits and clamps them to the group total", () => {
		expect(checkedOutputLimits()).toEqual({ maxLines: null, maxBytes: null });
		expect(checkedOutputLimits(1, 1)).toEqual({ maxLines: 1, maxBytes: 1 });
		expect(() => checkedOutputLimits(0)).toThrow(/maxLines/);
		expect(() => checkedOutputLimits(BATCH_GROUP_LINES + 1)).toThrow(/maxLines/);
		expect(() => checkedOutputLimits(undefined, 0)).toThrow(/maxBytes/);
		expect(() => checkedOutputLimits(undefined, BATCH_GROUP_BYTES + 1)).toThrow(/maxBytes/);

		const budget = new GroupBudget({ node: { maxLines: 1, maxBytes: 4 }, total: { maxLines: 10, maxBytes: 20 } });
		expect(budget).toMatchObject({ nodeMaxLines: 1, nodeMaxBytes: 4, totalLines: 10, totalBytes: 20 });
		const first = new BatchAccumulator("text", budget);
		expect(first.append("stdout", 0, Buffer.from("abc\ndef\n"))).toBe(true);
		expect(first.grant).toEqual({ bytes: 4, lines: 1 });
		expect(first.kept().toString()).toBe("def\n");
		expect(first.keptLines).toBe(1);
		// The next node draws what is left from the same total.
		const second = new BatchAccumulator("text", budget);
		expect(second.append("stdout", 0, Buffer.from("ghi\n"))).toBe(true);
		expect(second.grant).toEqual({ bytes: 4, lines: 1 });
		expect(budget.bytesLeft).toBe(12);
	});
});
