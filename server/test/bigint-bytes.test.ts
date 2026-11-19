/**
 * Byte columns above 2^31 (migration 0013, storage/pg-int8.ts): PostgreSQL's `integer` overflowed, and a
 * `bigint` read by the pg driver without the int8 parser arrives as a string, which would turn e.g.
 * `used_bytes + delta` into string concatenation. The values here are above 2^31 and below 2^53.
 */
import pg from "pg";
import { expect, it, vi } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { configurePgInt8AsNumber } from "../src/storage/pg-int8.ts";
import { newId } from "../src/util/id.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

// Every case migrates a fresh PostgreSQL schema, which is slow when the suite runs in parallel.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const BIG = 2 ** 31 + 12_345;

/** Asserts the row's column is a number with the exact value; the pg driver would otherwise return a string. */
function expectNumber(value: unknown): void {
	expect(typeof value).toBe("number");
	expect(value).toBe(BIG);
}

async function seedTask(db: Db): Promise<string> {
	const id = newId();
	await db
		.insertInto("tasks")
		.values({
			id,
			org_id: await defaultOrgId(db),
			node_id: "node-1",
			task_group_id: null,
			kind: "exec",
			spec: "{}",
			input_size: BIG,
			input_sha256: null,
			privileged: 0,
			attempt: 1,
			timeout_ms: null,
			output_mode: "text",
			state: "exited",
			exit_code: 0,
			signal: null,
			timed_out: 0,
			error_code: null,
			error_message: null,
			actor_type: "user",
			actor_id: "user-1",
			on_behalf_of_user_id: "user-1",
			created_at: "2026-01-01T00:00:00.000Z",
			dispatched_at: null,
			accepted_at: null,
			finished_at: null,
			output_bytes: BIG,
			output_head: null,
			output_tail: null,
			output_lines: null,
			notice: null,
			result: null,
			output_file: null,
			late_result: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: null,
			handler_session_id: null,
			max_lines: null,
			max_bytes: BIG,
			transfer: null,
			purpose: null,
		})
		.execute();
	return id;
}

it("reads a PostgreSQL int8 as a number", () => {
	// The driver's default returns int8 as a string; every read path here expects a number.
	configurePgInt8AsNumber();
	const parse = (value: string) => pg.types.getTypeParser(pg.types.builtins.INT8)(value) as unknown;
	expect(parse("2147483648")).toBe(2_147_483_648);
	expect(parse("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
	expect(parse("0")).toBe(0);
});

describeBackends("byte columns above 2^31", (backend) => {
	it("stores and reads a task's input, output and cap sizes as numbers", async () => {
		const db = await openTestDb(backend);
		try {
			const id = await seedTask(db);
			const row = await db
				.selectFrom("tasks")
				.select(["input_size", "max_bytes", "output_bytes"])
				.where("id", "=", id)
				.executeTakeFirstOrThrow();
			expectNumber(row.input_size);
			expectNumber(row.max_bytes);
			expectNumber(row.output_bytes);
		} finally {
			await db.destroy();
		}
	});

	it("stores a task group's per-node byte cap and a library's size accounting as numbers", async () => {
		const db = await openTestDb(backend);
		try {
			const groupId = newId();
			await db
				.insertInto("task_groups")
				.values({
					id: groupId,
					org_id: await defaultOrgId(db),
					targets: "[]",
					node_ids: "[]",
					kind: "exec",
					parallel: 1,
					fail_fast: 0,
					output_mode: "text",
					node_max_lines: null,
					node_max_bytes: BIG,
					privileged: 0,
					skipped: "[]",
					state: "finished",
					actor_type: "user",
					actor_id: "user-1",
					on_behalf_of_user_id: "user-1",
					created_at: "2026-01-01T00:00:00.000Z",
					finished_at: null,
					spec: null,
					timeout_ms: null,
					purpose: null,
					rule_chain: null,
					approval: null,
					pending_input: null,
					root_session_id: null,
					handler_type: null,
					handler_session_id: null,
				})
				.execute();
			const group = await db
				.selectFrom("task_groups")
				.select("node_max_bytes")
				.where("id", "=", groupId)
				.executeTakeFirstOrThrow();
			expectNumber(group.node_max_bytes);

			const libraryId = newId();
			await db
				.insertInto("libraries")
				.values({
					id: libraryId,
					owner_kind: "user",
					owner_id: "user-1",
					max_files: 10,
					max_file_bytes: BIG,
					max_total_bytes: BIG,
					used_files: 1,
					used_bytes: BIG,
					created_at: "2026-01-01T00:00:00.000Z",
				})
				.execute();
			const library = await db
				.selectFrom("libraries")
				.select(["max_file_bytes", "max_total_bytes", "used_bytes"])
				.where("id", "=", libraryId)
				.executeTakeFirstOrThrow();
			expectNumber(library.max_file_bytes);
			expectNumber(library.max_total_bytes);
			expectNumber(library.used_bytes);

			await db
				.insertInto("library_files")
				.values({
					library_id: libraryId,
					path: "big.bin",
					size: BIG,
					sha256: "0".repeat(64),
					media_type: "application/octet-stream",
					backend: "local",
					object_key: "objects/big",
					created_by: "user-1",
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-01T00:00:00.000Z",
				})
				.execute();
			const file = await db
				.selectFrom("library_files")
				.select("size")
				.where("library_id", "=", libraryId)
				.where("path", "=", "big.bin")
				.executeTakeFirstOrThrow();
			expectNumber(file.size);
		} finally {
			await db.destroy();
		}
	});

	it("stores and reads the image cache's byte count as a number", async () => {
		const db = await openTestDb(backend);
		try {
			await db
				.insertInto("image_cache")
				.values({
					sha256: "1".repeat(64),
					bytes: BIG,
					mime: "image/png",
					last_used_at: "2026-01-01T00:00:00.000Z",
					stored_at: "2026-01-01T00:00:00.000Z",
				})
				.execute();
			const row = await db
				.selectFrom("image_cache")
				.select("bytes")
				.where("sha256", "=", "1".repeat(64))
				.executeTakeFirstOrThrow();
			expectNumber(row.bytes);
		} finally {
			await db.destroy();
		}
	});
});
