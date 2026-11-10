import { type Kysely, sql } from "kysely";

/**
 * API tokens support only Ask and Yolo (doc/design/access-control.md "API tokens"), so a token root that still carries
 * auto_review moves to ask. Session and schedule roots keep their preset.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		update rule_sets
		set rule_preset = 'ask'
		where scope_type = 'api_token' and rule_preset = 'auto_review'
	`.execute(db);
}

/** The rewrite is one-way: an `ask` token may have been ask before, so auto_review cannot be restored. */
export async function down(_db: Kysely<unknown>): Promise<void> {}
