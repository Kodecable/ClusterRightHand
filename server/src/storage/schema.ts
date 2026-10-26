import type { ColumnType } from "kysely";

/** Timestamps are stored as ISO 8601 UTC strings on both dialects; see doc/data-model.md. */
type CreatedAt = ColumnType<string, string, never>;

export interface OrgsTable {
	id: string;
	name: string;
	created_at: CreatedAt;
}

export interface UsersTable {
	id: string;
	org_id: string;
	username: string;
	display_name: string;
	email: string | null;
	kind: "admin" | "member";
	password_hash: string | null;
	status: "active" | "disabled";
	created_at: CreatedAt;
}

export interface Database {
	orgs: OrgsTable;
	users: UsersTable;
}
