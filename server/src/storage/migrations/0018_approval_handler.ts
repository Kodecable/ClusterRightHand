import type { Kysely } from "kysely";

/**
 * Pending approvals get an indexable handler (doc/design/access-control.md "Approvals"): `root_session_id` groups them by
 * session tree; `handler_type`/`handler_session_id` say whether an agent or the user must decide. Quota waits
 * get `sessions.waiting_handler_id`, the exhausted level's direct parent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	for (const table of ["tasks", "task_groups"]) {
		await db.schema.alterTable(table).addColumn("root_session_id", "text").execute();
		await db.schema.alterTable(table).addColumn("handler_type", "text").execute();
		await db.schema.alterTable(table).addColumn("handler_session_id", "text").execute();
	}
	await db.schema.alterTable("sessions").addColumn("waiting_handler_id", "text").execute();

	await backfillHandlers(db);

	for (const table of ["tasks", "task_groups"]) {
		await db.schema
			.createIndex(`${table}_handler_agent_idx`)
			.on(table)
			.columns(["state", "handler_type", "handler_session_id"])
			.execute();
		await db.schema
			.createIndex(`${table}_handler_user_idx`)
			.on(table)
			.columns(["state", "handler_type", "on_behalf_of_user_id"])
			.execute();
		await db.schema.createIndex(`${table}_root_session_idx`).on(table).column("root_session_id").execute();
	}
	await db.schema
		.createIndex("sessions_waiting_handler_idx")
		.on("sessions")
		.columns(["state", "waiting_handler_id"])
		.execute();
}

/** Backfills the handler columns from the rule chain and approval JSON (pending rows only). */
// biome-ignore lint/suspicious/noExplicitAny: migration backfill reads the tables it is migrating
export async function backfillHandlers(d: Kysely<any>): Promise<void> {
	for (const table of ["tasks", "task_groups"]) {
		const rows = await d
			.selectFrom(table)
			.select(["id", "rule_chain", "approval"])
			.where("state", "=", "awaiting_approval")
			.execute();
		for (const row of rows) {
			let root: string | null = null;
			try {
				const chain = row.rule_chain ? (JSON.parse(row.rule_chain) as { type?: string; id?: string }[]) : [];
				if (chain[0]?.type === "session") root = chain[0].id ?? null;
			} catch {}
			let type: "agent" | "user" | null = row.rule_chain ? "user" : null;
			let session: string | null = null;
			try {
				const approval = JSON.parse(row.approval ?? "{}") as {
					agent?: { session?: unknown; state?: unknown };
				};
				if (approval.agent?.state === "pending" && typeof approval.agent.session === "string") {
					type = "agent";
					session = approval.agent.session;
				}
			} catch {}
			await d
				.updateTable(table)
				.set({ root_session_id: root, handler_type: type, handler_session_id: session })
				.where("id", "=", row.id)
				.execute();
		}
	}

	const waits = await d
		.selectFrom("sessions")
		.select(["id", "waiting_level_id"])
		.where("state", "=", "awaiting")
		.where("waiting_level_id", "is not", null)
		.execute();
	for (const wait of waits) {
		const level = await d
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", wait.waiting_level_id)
			.executeTakeFirst();
		if (!level?.parent_session_id) continue;
		await d
			.updateTable("sessions")
			.set({ waiting_handler_id: level.parent_session_id })
			.where("id", "=", wait.id)
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("sessions_waiting_handler_idx").execute();
	for (const table of ["tasks", "task_groups"]) {
		await db.schema.dropIndex(`${table}_root_session_idx`).execute();
		await db.schema.dropIndex(`${table}_handler_user_idx`).execute();
		await db.schema.dropIndex(`${table}_handler_agent_idx`).execute();
	}
	await db.schema.alterTable("sessions").dropColumn("waiting_handler_id").execute();
	for (const table of ["tasks", "task_groups"]) {
		for (const col of ["handler_session_id", "handler_type", "root_session_id"]) {
			await db.schema.alterTable(table).dropColumn(col).execute();
		}
	}
}
