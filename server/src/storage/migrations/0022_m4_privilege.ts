import type { Kysely } from "kysely";

/**
 * M4 privilege storage (doc/m4.md#crhs-侧数据): signed authorizations, the owner's credentials, the
 * cached TrustSummary on nodes, the authorization state of a task, and the awaiting_authorization
 * state (entered by the next wave's dispatch code, not by this migration).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("authorizations")
		// Hex SHA-256 of the payload bytes (doc/protocol.md#授权对象).
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		// Base64 CBOR payload bytes, kept verbatim so the id stays verifiable.
		.addColumn("payload", "text", (c) => c.notNull())
		// JSON Signature[] of doc/protocol.md#授权对象.
		.addColumn("signatures", "text", (c) => c.notNull())
		// The owner who signed it; null for a crhs-only authorization.
		.addColumn("issuer_user_id", "text", (c) => c.references("users.id"))
		// JSON string[] for a one-shot authorization; null for a reusable one.
		.addColumn("task_ids", "text")
		// ISO 8601 UTC, from the payload's deadline_ms; null when it has none.
		.addColumn("deadline", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("revoked_at", "text")
		.execute();
	await db.schema
		.createIndex("authorizations_org_created_idx")
		.on("authorizations")
		.columns(["org_id", "created_at"])
		.execute();
	await db.schema.createIndex("authorizations_deadline_idx").on("authorizations").column("deadline").execute();

	await db.schema
		.createTable("user_credentials")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		// ssh: an authorized_keys line; webauthn: base64 COSE public key.
		.addColumn("public_key", "text", (c) => c.notNull())
		// ssh only: the OpenSSH SHA256:… fingerprint that TrustSummary reports.
		.addColumn("fingerprint", "text")
		// webauthn only: base64url credential id.
		.addColumn("credential_id", "text")
		// webauthn only.
		.addColumn("rp_id", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("user_credentials_user_fingerprint_unique", ["user_id", "fingerprint"])
		.addUniqueConstraint("user_credentials_user_credential_unique", ["user_id", "credential_id"])
		.execute();
	await db.schema.createIndex("user_credentials_user_id_idx").on("user_credentials").column("user_id").execute();

	for (const name of ["trust_report", "trust_digest", "trust_updated_at"] as const) {
		await db.schema.alterTable("nodes").addColumn(name, "text").execute();
	}
	// JSON plan/history of the authorization path (doc/m4.md#crhs-侧数据).
	await db.schema.alterTable("tasks").addColumn("authorization", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("authorization").execute();
	for (const name of ["trust_updated_at", "trust_digest", "trust_report"] as const) {
		await db.schema.alterTable("nodes").dropColumn(name).execute();
	}
	await db.schema.dropTable("user_credentials").execute();
	await db.schema.dropTable("authorizations").execute();
}
