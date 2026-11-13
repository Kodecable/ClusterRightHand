/**
 * Libraries and their access rules (doc/design/library.md "Libraries"): a user library belongs to that
 * user, a group library to the group's members (read and write), and administrators reach every
 * library. A library is named `user:<username>` or `group:<group name>`.
 */
import type { LibraryCapabilities, LibraryLimits, LibraryUsage, LibraryView } from "@crh/api";
import type { Selectable } from "kysely";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { LibrariesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";

export type LibraryRow = Selectable<LibrariesTable>;

/** A library row with its owner's name, which the wire view and the reference use. */
export interface LibraryRecord {
	row: LibraryRow;
	ownerName: string;
	ownerDisplayName: string;
}

export interface LibraryRef {
	kind: "user" | "group";
	name: string;
}

/** Parses `user:<username>` or `group:<group name>`. */
export function parseLibraryRef(ref: string): LibraryRef {
	if (ref.startsWith("user:")) {
		const name = ref.slice("user:".length);
		if (name === "") throw new UserError("a library reference must name a user");
		return { kind: "user", name };
	}
	if (ref.startsWith("group:")) {
		const name = ref.slice("group:".length);
		if (name === "") throw new UserError("a library reference must name a user group");
		return { kind: "group", name };
	}
	throw new UserError("a library reference must look like user:<username> or group:<group name>");
}

/** The reference of a row and its owner's name. */
export function libraryRef(row: LibraryRow, ownerName: string): string {
	return `${row.owner_kind}:${ownerName}`;
}

/** The current limits of a row. */
export function libraryLimits(row: LibraryRow): LibraryLimits {
	return { files: row.max_files, fileBytes: row.max_file_bytes, totalBytes: row.max_total_bytes };
}

export function libraryUsage(row: LibraryRow): LibraryUsage {
	return { files: row.used_files, bytes: row.used_bytes };
}

/** The wire view of a record for `user`; callers must have checked access. */
export function libraryView(record: LibraryRecord, user: SessionUser): LibraryView {
	const capabilities: LibraryCapabilities = { write: true, manage: isAdmin(user) };
	return {
		id: record.row.id,
		ref: libraryRef(record.row, record.ownerName),
		ownerKind: record.row.owner_kind,
		ownerId: record.row.owner_id,
		ownerName: record.ownerName,
		ownerDisplayName: record.ownerDisplayName,
		usage: libraryUsage(record.row),
		limits: libraryLimits(record.row),
		capabilities,
	};
}

/** Looks up a library by its reference; undefined when the owner does not exist. */
export async function findLibraryByRef(db: Db, ref: string): Promise<LibraryRecord | undefined> {
	const parsed = parseLibraryRef(ref);
	if (parsed.kind === "user") {
		const owner = await db
			.selectFrom("users")
			.select(["id", "username", "display_name"])
			.where("username", "=", parsed.name.toLowerCase())
			.executeTakeFirst();
		if (!owner) return undefined;
		const row = await db
			.selectFrom("libraries")
			.selectAll()
			.where("owner_kind", "=", "user")
			.where("owner_id", "=", owner.id)
			.executeTakeFirst();
		if (!row) return undefined;
		return { row, ownerName: owner.username, ownerDisplayName: owner.display_name };
	}
	const owner = await db
		.selectFrom("user_groups")
		.select(["id", "name"])
		.where("name", "=", parsed.name.toLowerCase())
		.executeTakeFirst();
	if (!owner) return undefined;
	const row = await db
		.selectFrom("libraries")
		.selectAll()
		.where("owner_kind", "=", "group")
		.where("owner_id", "=", owner.id)
		.executeTakeFirst();
	if (!row) return undefined;
	return { row, ownerName: owner.name, ownerDisplayName: owner.name };
}

/** The library with this id, with its owner's name. */
export async function findLibraryById(db: Db, libraryId: string): Promise<LibraryRecord | undefined> {
	const row = await db.selectFrom("libraries").selectAll().where("id", "=", libraryId).executeTakeFirst();
	if (!row) return undefined;
	if (row.owner_kind === "user") {
		const owner = await db
			.selectFrom("users")
			.select(["username", "display_name"])
			.where("id", "=", row.owner_id)
			.executeTakeFirst();
		if (!owner) return undefined;
		return { row, ownerName: owner.username, ownerDisplayName: owner.display_name };
	}
	const owner = await db.selectFrom("user_groups").select(["name"]).where("id", "=", row.owner_id).executeTakeFirst();
	if (!owner) return undefined;
	return { row, ownerName: owner.name, ownerDisplayName: owner.name };
}

/** Whether `user` may use the library; administrators may use every library. */
export async function canAccessLibrary(db: Db, user: SessionUser, row: LibraryRow): Promise<boolean> {
	if (isAdmin(user)) return true;
	if (row.owner_kind === "user") return row.owner_id === user.userId;
	const membership = await db
		.selectFrom("user_group_members")
		.select("user_group_id")
		.where("user_group_id", "=", row.owner_id)
		.where("user_id", "=", user.userId)
		.executeTakeFirst();
	return membership !== undefined;
}

/**
 * Resolves a reference for `user`, or throws the 404 a missing library gets: a caller who may not
 * reach a library must not learn that it exists (doc/design/webui.md "Routing").
 */
export async function requireLibrary(db: Db, user: SessionUser, ref: string): Promise<LibraryRecord> {
	const record = await findLibraryByRef(db, ref);
	if (!record || !(await canAccessLibrary(db, user, record.row))) {
		throw new NotFoundError("no such library");
	}
	return record;
}

/** The libraries the caller can reach: their own and their user groups'. */
export async function listAccessibleLibraries(db: Db, user: SessionUser): Promise<LibraryRecord[]> {
	const rows = await db
		.selectFrom("libraries as l")
		.selectAll("l")
		.where((eb) =>
			eb.or([
				eb.and([eb("l.owner_kind", "=", "user"), eb("l.owner_id", "=", user.userId)]),
				eb.and([
					eb("l.owner_kind", "=", "group"),
					eb(
						"l.owner_id",
						"in",
						eb.selectFrom("user_group_members").select("user_group_id").where("user_id", "=", user.userId),
					),
				]),
			]),
		)
		.execute();
	const records: LibraryRecord[] = [];
	for (const row of rows) {
		const record = await findLibraryById(db, row.id);
		if (record) records.push(record);
	}
	return records.sort((a, b) => {
		if (a.row.owner_kind !== b.row.owner_kind) return a.row.owner_kind === "user" ? -1 : 1;
		return a.ownerName.localeCompare(b.ownerName);
	});
}
