import { randomBytes } from "node:crypto";
import { type Kysely, sql } from "kysely";

/** A UUIDv7 for the seeded row; kept here so the migration does not depend on code that may change. */
function uuidv7(): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(Date.now(), 0, 6);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Built-in extensions can have settings (doc/design/extensions.md "Built-in extensions"): `config` is JSON
 * `{ values, secrets }` with the plain values and the names of the secret ones that are set, and
 * `config_secret_id` points at one `secrets` row with the secret values, encrypted with the master key like
 * an MCP extension's headers.
 *
 * Adds the `crhs-ds-search` built-in, disabled: it is billed per call and needs an API key first. The
 * description is not stored (see 0014).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("extensions").addColumn("config", "text").execute();
	await db.schema.alterTable("extensions").addColumn("config_secret_id", "text").execute();
	const org = (await sql<{ id: string }>`select id from orgs order by created_at`.execute(db)).rows[0];
	if (!org) return;
	const now = new Date().toISOString();
	await sql`
		insert into extensions (
			id, org_id, name, kind, description, url, headers_secret_id, identity_headers, enabled,
			list_directly, availability, trust_annotations, timeout_ms, created_at, updated_at
		) values (
			${uuidv7()}, ${org.id}, 'crhs-ds-search', 'builtin', null, null, null, null, 0,
			1, 'everyone', null, null, ${now}, ${now}
		)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`delete from extensions where name = 'crhs-ds-search' and kind = 'builtin'`.execute(db);
	await db.schema.alterTable("extensions").dropColumn("config_secret_id").execute();
	await db.schema.alterTable("extensions").dropColumn("config").execute();
}
