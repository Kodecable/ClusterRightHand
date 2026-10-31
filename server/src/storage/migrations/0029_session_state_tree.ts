import { type Kysely, sql } from "kysely";

/**
 * Session state for roots and subagents alike (D97, doc/agent-runtime.md#会话状态): `idle` / `running` /
 * `awaiting`, with `waiting_kind` saying what an awaiting session waits for (`quota` / `approval` /
 * `authorization`). `root_session_id` makes a session tree addressable, so the WebUI's session list can
 * aggregate a whole tree's state in one query (doc/webui.md#会话列表).
 *
 * Existing rows map as follows: a root's `active` and a subagent's `stopped` are both `idle`; a subagent's
 * `active` is `idle` too, because the startup reconciliation corrects the ones that are really live. An
 * `awaiting` row keeps its state and gets `waiting_kind = quota` when it points at an exhausted level; rows
 * without one are left for the same reconciliation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").addColumn("waiting_kind", "text").execute();
	await db.schema.alterTable("sessions").addColumn("root_session_id", "text").execute();
	// biome-ignore lint/suspicious/noExplicitAny: data migration on the sessions table
	const d = db as Kysely<any>;
	await d
		.updateTable("sessions")
		.set({ state: "idle" })
		.where("parent_session_id", "is", null)
		.where("state", "=", "active")
		.execute();
	await d
		.updateTable("sessions")
		.set({ state: "idle" })
		.where("parent_session_id", "is not", null)
		.where("state", "in", ["active", "stopped"])
		.execute();
	await d
		.updateTable("sessions")
		.set({ waiting_kind: "quota" })
		.where("state", "=", "awaiting")
		.where("waiting_level_id", "is not", null)
		.execute();

	// Fill every row's tree root in one statement: roots are their own root, each child inherits its parent's.
	// The recursive CTE works on SQLite and PostgreSQL alike and visits a row once per level of depth at most.
	await sql`
		with recursive tree(id, root_id) as (
			select id, id from sessions where parent_session_id is null
			union all
			select child.id, tree.root_id
			from sessions as child
			join tree on child.parent_session_id = tree.id
		)
		update sessions
		set root_session_id = (select root_id from tree where tree.id = sessions.id)
		where exists (select 1 from tree where tree.id = sessions.id)
	`.execute(d);

	// The list aggregates a tree by its root and by state; the leftmost column also serves root lookups.
	await db.schema.createIndex("sessions_root_state_idx").on("sessions").columns(["root_session_id", "state"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("sessions_root_state_idx").execute();
	await db.schema.alterTable("sessions").dropColumn("root_session_id").execute();
	await db.schema.alterTable("sessions").dropColumn("waiting_kind").execute();
	// The old `active` / `stopped` values cannot be reconstructed from `idle`; the columns are dropped instead.
}
