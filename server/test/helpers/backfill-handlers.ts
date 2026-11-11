import type { Kysely } from "kysely";

/**
 * Recomputes the approval handler columns from the rule chain and approval JSON (pending rows only).
 * Tests use it to restore a row's handler state after clearing the columns.
 */
// biome-ignore lint/suspicious/noExplicitAny: the helper reads the tables under test
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
