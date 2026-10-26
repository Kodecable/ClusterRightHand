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

export interface UserGroupsTable {
	id: string;
	org_id: string;
	name: string;
	source: "local";
	created_at: CreatedAt;
}

export interface UserGroupMembersTable {
	group_id: string;
	user_id: string;
	created_at: CreatedAt;
}

export interface WebSessionsTable {
	id: string;
	/** Hex SHA-256 of the cookie token. */
	token_hash: string;
	user_id: string;
	created_at: CreatedAt;
	expires_at: string;
	last_seen_at: string;
	ip: string | null;
	user_agent: string | null;
}

export interface SharesTable {
	id: string;
	org_id: string;
	resource_type: "node" | "session";
	/** No foreign key: resources live in different tables. */
	resource_id: string;
	grantee_type: "user" | "user_group";
	/** No foreign key: points at users or user_groups depending on grantee_type. */
	grantee_id: string;
	/** node: "view" | "operate"; session: "view" | "chat". */
	access: "view" | "operate" | "chat";
	created_by_user_id: string;
	created_at: CreatedAt;
}

export interface ServerMetaTable {
	key: string;
	value: string;
}

export interface SecretsTable {
	id: string;
	org_id: string;
	/** What the secret is; also bound into the ciphertext as associated data. */
	kind: string;
	ciphertext: string;
	created_at: CreatedAt;
}

export interface Database {
	orgs: OrgsTable;
	users: UsersTable;
	user_groups: UserGroupsTable;
	user_group_members: UserGroupMembersTable;
	web_sessions: WebSessionsTable;
	shares: SharesTable;
	server_meta: ServerMetaTable;
	secrets: SecretsTable;
}
