import { newId } from "../util/id.ts";
import type { Db } from "./db.ts";

/** v1 has exactly one organization; it is created on first use. */
export async function defaultOrgId(db: Db): Promise<string> {
	const existing = await db.selectFrom("orgs").select("id").orderBy("created_at").executeTakeFirst();
	if (existing) return existing.id;
	const id = newId();
	await db.insertInto("orgs").values({ id, name: "default", created_at: new Date().toISOString() }).execute();
	return id;
}
