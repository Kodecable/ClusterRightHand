import type { Selectable } from "kysely";
import { describe, expect, it } from "vitest";
import { OUTPUT_KEEP_BYTES, OUTPUT_KEEP_LINES } from "../src/cluster/output.ts";
import { taskStartOf } from "../src/cluster/task-start.ts";
import type { OutputMode, TasksTable } from "../src/storage/schema.ts";

const DEFAULTS = { kind: "full", spillBytes: OUTPUT_KEEP_BYTES, spillLines: OUTPUT_KEEP_LINES };

function row(overrides: Partial<Selectable<TasksTable>> = {}): Selectable<TasksTable> {
	return {
		attempt: 1,
		timeout_ms: null,
		output_mode: "full",
		max_lines: null,
		max_bytes: null,
		...overrides,
	} as Selectable<TasksTable>;
}

function start(overrides: Partial<Selectable<TasksTable>> = {}) {
	return taskStartOf("t1", row(overrides), { kind: "file.stat", path: "/tmp" }, { privileged: false });
}

describe("taskStartOf output", () => {
	it("spills at the single task's own budgets when it has them", () => {
		expect(start({ max_lines: 100, max_bytes: 4096 }).output).toEqual({
			kind: "full",
			spillBytes: 4096,
			spillLines: 100,
		});
	});

	it("keeps the defaults without a budget and caps a larger one at them", () => {
		expect(start().output).toEqual(DEFAULTS);
		expect(start({ max_lines: OUTPUT_KEEP_LINES + 1, max_bytes: OUTPUT_KEEP_BYTES + 1 }).output).toEqual(DEFAULTS);
		expect(start({ max_lines: 10, max_bytes: OUTPUT_KEEP_BYTES + 1 }).output).toEqual({
			...DEFAULTS,
			spillBytes: OUTPUT_KEEP_BYTES,
			spillLines: 10,
		});
	});

	it("keeps the defaults for a head task even when its row has budgets", () => {
		expect(start({ output_mode: "head", max_lines: 10, max_bytes: 1024 }).output).toEqual(DEFAULTS);
	});

	it("passes a batch text or status mode through unchanged", () => {
		for (const mode of ["text", "status"] as OutputMode[]) {
			expect(start({ output_mode: mode }).output).toEqual({ kind: mode });
		}
	});
});
