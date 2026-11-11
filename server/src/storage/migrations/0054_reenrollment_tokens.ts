import type { Kysely } from "kysely";

/**
 * An enrollment token may be bound to an existing crha node. Enrolling with such a token replaces that
 * node's key instead of creating a node (doc/design/protocol.md "Rotation and revocation").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("enrollment_tokens").addColumn("bound_node_id", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("enrollment_tokens").dropColumn("bound_node_id").execute();
}
