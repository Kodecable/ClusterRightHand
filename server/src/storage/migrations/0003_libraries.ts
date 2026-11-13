import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { DEFAULT_GROUP_LIBRARY_LIMITS, DEFAULT_USER_LIBRARY_LIMITS } from "../../config.ts";

/**
 * Libraries and their files (doc/design/library.md "Libraries" and "Metadata and objects").
 *
 * Every existing user and user group gets a library with the defaults of this release: a user's
 * 256 files / 32 MiB / 256 MiB, a group's 0/0/0. Later libraries copy the defaults from System
 * settings when their owner is created.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("libraries")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("owner_kind", "text", (c) => c.notNull())
		.addColumn("owner_id", "text", (c) => c.notNull())
		.addColumn("max_files", "integer", (c) => c.notNull())
		.addColumn("max_file_bytes", "integer", (c) => c.notNull())
		.addColumn("max_total_bytes", "integer", (c) => c.notNull())
		.addColumn("used_files", "integer", (c) => c.notNull())
		.addColumn("used_bytes", "integer", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("libraries_owner_unique", ["owner_kind", "owner_id"])
		.execute();

	await db.schema
		.createTable("library_files")
		.addColumn("library_id", "text", (c) => c.notNull().references("libraries.id").onDelete("cascade"))
		.addColumn("path", "text", (c) => c.notNull())
		.addColumn("size", "integer", (c) => c.notNull())
		.addColumn("sha256", "text", (c) => c.notNull())
		.addColumn("media_type", "text", (c) => c.notNull())
		.addColumn("backend", "text", (c) => c.notNull())
		.addColumn("object_key", "text", (c) => c.notNull())
		.addColumn("created_by", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("library_files_library_path_unique", ["library_id", "path"])
		.execute();
	await db.schema.createIndex("library_files_object_key_idx").on("library_files").column("object_key").execute();

	const now = new Date().toISOString();
	const users = (await sql<{ id: string; created_at: string }>`select id, created_at from users`.execute(db)).rows;
	for (const user of users) {
		await insertLibraryRow(db, randomUUID(), "user", user.id, DEFAULT_USER_LIBRARY_LIMITS, user.created_at ?? now);
	}
	const groups = (await sql<{ id: string; created_at: string }>`select id, created_at from user_groups`.execute(db))
		.rows;
	for (const group of groups) {
		await insertLibraryRow(db, randomUUID(), "group", group.id, DEFAULT_GROUP_LIBRARY_LIMITS, group.created_at ?? now);
	}
}

/** One migrated library row; raw SQL because the migration's Kysely has no schema type. */
async function insertLibraryRow(
	db: Kysely<unknown>,
	id: string,
	ownerKind: "user" | "group",
	ownerId: string,
	limits: { files: number; fileBytes: number; totalBytes: number },
	createdAt: string,
): Promise<void> {
	await sql`
		insert into libraries (
			id, owner_kind, owner_id, max_files, max_file_bytes, max_total_bytes, used_files, used_bytes, created_at
		) values (
			${id}, ${ownerKind}, ${ownerId}, ${limits.files}, ${limits.fileBytes}, ${limits.totalBytes}, 0, 0, ${createdAt}
		)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("library_files").execute();
	await db.schema.dropTable("libraries").execute();
}
