import type { Kysely } from "kysely";

/**
 * One output stream. `tasks` keeps a single `output_head` / `output_tail` / `output_bytes`
 * instead of separate stdout and stderr columns, and crhs's own line (the SSH privileged notice)
 * moves to `notice`. Rows written before this migration are merged stdout first, stderr second; a
 * `task.exit` from the 0039 era wrote a merged tail already, so that one is kept. The migration also
 * backfills `"createParentDirs": false` into stored `file.write` specs, because the JSON form now
 * requires it (doc/design/protocol.md "JSON storage forms").
 *
 * It is self-contained (doc/design/data-model.md): the notice text is copied from the SSH runner, not
 * imported.
 */

/** The notice the SSH runner wrote before the task's output (server/src/cluster/ssh/exec.ts). */
const SSH_PRIVILEGED_NOTICE = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";
const NOTICE_BYTES = Buffer.from(SSH_PRIVILEGED_NOTICE);

/** Rows per write: SQLite limits the number of parameters in one statement. */
const BATCH = 200;

interface TaskOutputRow {
	id: string;
	stdout_bytes: string | number;
	stderr_bytes: string | number;
	stdout_head: string | null;
	stdout_tail: string | null;
	stderr_head: string | null;
	stderr_tail: string | null;
	output_tail: string | null;
}

function decode(value: string | null): Buffer | null {
	return value === null ? null : Buffer.from(value, "base64");
}

function encode(value: Buffer | null): string | null {
	return value === null ? null : value.toString("base64");
}

/** Drops the old SSH notice line from the front of a merged buffer, if it starts with it. */
function stripNotice(value: Buffer | null): Buffer | null {
	if (value === null || !value.subarray(0, NOTICE_BYTES.length).equals(NOTICE_BYTES)) return value;
	return value.subarray(NOTICE_BYTES.length);
}

export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration over the tasks table
	const d = db as Kysely<any>;
	// SQLite only adds one column per ALTER TABLE.
	await db.schema.alterTable("tasks").addColumn("output_head", "text").execute();
	await db.schema
		.alterTable("tasks")
		.addColumn("output_bytes", "integer", (c) => c.notNull().defaultTo(0))
		.execute();
	await db.schema.alterTable("tasks").addColumn("notice", "text").execute();

	let last: string | null = null;
	for (;;) {
		let query = d
			.selectFrom("tasks")
			.select([
				"id",
				"stdout_bytes",
				"stderr_bytes",
				"stdout_head",
				"stdout_tail",
				"stderr_head",
				"stderr_tail",
				"output_tail",
			])
			.orderBy("id")
			.limit(BATCH);
		if (last !== null) query = query.where("id", ">", last);
		const rows: TaskOutputRow[] = await query.execute();
		if (rows.length === 0) break;
		for (const row of rows) {
			const stdoutHead = decode(row.stdout_head);
			const stderrHead = decode(row.stderr_head);
			const notice = stderrHead?.subarray(0, NOTICE_BYTES.length).equals(NOTICE_BYTES) ?? false;
			// The notice was written before the task's own output, so it is the first thing in stderr.
			const mergedHead =
				stdoutHead === null && stderrHead === null
					? null
					: Buffer.concat([stdoutHead ?? Buffer.alloc(0), stripNotice(stderrHead) ?? Buffer.alloc(0)]);
			// A 0039-era task.exit stored the merged tail already; otherwise the old tails are merged.
			const mergedTail =
				row.output_tail !== null
					? stripNotice(decode(row.output_tail))
					: (() => {
							const stdoutTail = decode(row.stdout_tail);
							const stderrTail = decode(row.stderr_tail);
							if (stdoutTail === null && stderrTail === null) return null;
							return Buffer.concat([stdoutTail ?? Buffer.alloc(0), stripNotice(stderrTail) ?? Buffer.alloc(0)]);
						})();
			await d
				.updateTable("tasks")
				.set({
					output_head: encode(mergedHead),
					output_tail: encode(mergedTail),
					output_bytes: Number(row.stdout_bytes) + Number(row.stderr_bytes),
					notice: notice ? SSH_PRIVILEGED_NOTICE : null,
				})
				.where("id", "=", row.id)
				.execute();
		}
		last = rows[rows.length - 1]?.id ?? last;
	}

	// The old columns hold no constraints or indexes, so both dialects can drop them in place.
	for (const column of ["stdout_bytes", "stderr_bytes", "stdout_head", "stdout_tail", "stderr_head", "stderr_tail"]) {
		await db.schema.alterTable("tasks").dropColumn(column).execute();
	}

	await backfillCreateParentDirs(d, "tasks");
	await backfillCreateParentDirs(d, "task_groups");
}

/** Adds `createParentDirs: false` to every stored file.write spec that predates the field. */
// biome-ignore lint/suspicious/noExplicitAny: two tables share this shape in the migration
async function backfillCreateParentDirs(d: Kysely<any>, table: "tasks" | "task_groups"): Promise<void> {
	let last: string | null = null;
	for (;;) {
		let query = d.selectFrom(table).select(["id", "spec"]).orderBy("id").limit(BATCH);
		if (last !== null) query = query.where("id", ">", last);
		const rows: { id: string; spec: string | null }[] = await query.execute();
		if (rows.length === 0) break;
		for (const row of rows) {
			if (typeof row.spec !== "string") continue;
			let spec: unknown;
			try {
				spec = JSON.parse(row.spec);
			} catch {
				// A spec 0019 could not convert stays unreadable; touching it would not help.
				continue;
			}
			if (typeof spec !== "object" || spec === null) continue;
			const object = spec as Record<string, unknown>;
			if (object.kind !== "file.write" || "createParentDirs" in object) continue;
			object.createParentDirs = false;
			await d
				.updateTable(table)
				.set({ spec: JSON.stringify(object) })
				.where("id", "=", row.id)
				.execute();
		}
		last = rows[rows.length - 1]?.id ?? last;
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// Best effort, like the other migrations: output goes back into the stdout columns, stderr stays empty.
	await db.schema
		.alterTable("tasks")
		.addColumn("stdout_bytes", "bigint", (c) => c.notNull().defaultTo(0))
		.execute();
	await db.schema
		.alterTable("tasks")
		.addColumn("stderr_bytes", "bigint", (c) => c.notNull().defaultTo(0))
		.execute();
	for (const column of ["stdout_head", "stdout_tail", "stderr_head", "stderr_tail"]) {
		await db.schema.alterTable("tasks").addColumn(column, "text").execute();
	}
	// biome-ignore lint/suspicious/noExplicitAny: data migration over the tasks table
	const d = db as Kysely<any>;
	const rows: { id: string; output_bytes: string | number; output_head: string | null; output_tail: string | null }[] =
		await d.selectFrom("tasks").select(["id", "output_bytes", "output_head", "output_tail"]).execute();
	for (const row of rows) {
		await d
			.updateTable("tasks")
			.set({
				stdout_bytes: row.output_bytes,
				stdout_head: row.output_head,
				stdout_tail: row.output_tail,
			})
			.where("id", "=", row.id)
			.execute();
	}
	for (const column of ["output_head", "output_bytes", "notice"]) {
		await db.schema.alterTable("tasks").dropColumn(column).execute();
	}
}
