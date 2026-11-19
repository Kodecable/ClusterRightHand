/**
 * The lock that serializes the shared node and node-group name namespace (doc/design/access-control.md
 * "Node groups and names"). It is a transaction concern rather than a name rule, so it lives here and
 * not in util/names.ts, which storage must be able to import without a module cycle.
 */
import type { Db } from "../storage/db.ts";
import { isPostgres } from "../storage/dialect.ts";

/**
 * Serializes the shared namespace of an organization before a name is checked and written: on
 * PostgreSQL every transaction that creates or renames a node or a node group locks the organization
 * row `FOR UPDATE` first, so two of them cannot both see a name as free (the check reads two tables, so
 * no single unique constraint covers it). SQLite needs nothing: one in-process writer serializes its
 * transactions, and its `begin immediate` already holds the write lock.
 */
export async function lockNameNamespace(db: Db, orgId: string): Promise<void> {
	if (!isPostgres(db)) return;
	await db.selectFrom("orgs").select("id").where("id", "=", orgId).forUpdate().execute();
}
