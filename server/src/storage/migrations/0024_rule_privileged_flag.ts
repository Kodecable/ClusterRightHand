import type { Kysely } from "kysely";

/**
 * Rules created before M4 have no `privileged` value, which matches privileged and ordinary tasks
 * alike (doc/design/access-control.md "Authorization rules"). Upgrading must not turn them into an implicit allowance
 * for privileged execution, so every rule that does not say `privileged` is pinned to `false`.
 * The rules of a root preset live in code (they already carry the flag) and "always allow" appends
 * into the same `rule_sets.rules` JSON, so this one pass covers both.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on the rule_sets table
	const d = db as Kysely<any>;
	const rows = await d.selectFrom("rule_sets").select(["id", "rules"]).execute();
	for (const row of rows) {
		let rules: unknown;
		try {
			rules = JSON.parse(row.rules);
		} catch (err) {
			console.warn(`0024_rule_privileged_flag: leaving rule set ${row.id} unchanged: ${message(err)}`);
			continue;
		}
		if (!Array.isArray(rules)) {
			console.warn(`0024_rule_privileged_flag: leaving rule set ${row.id} unchanged: rules is not a list`);
			continue;
		}
		let changed = false;
		for (const rule of rules) {
			if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
			const record = rule as Record<string, unknown>;
			if (record.privileged === undefined || record.privileged === null) {
				record.privileged = false;
				changed = true;
			}
		}
		if (!changed) continue;
		await d
			.updateTable("rule_sets")
			.set({ rules: JSON.stringify(rules) })
			.where("id", "=", row.id)
			.execute();
	}
}

export async function down(): Promise<void> {
	// The flag cannot be told apart from one the user set to false afterwards, so the previous
	// values cannot be reconstructed.
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
