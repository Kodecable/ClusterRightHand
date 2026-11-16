/**
 * Token quotas (doc/design/agent-runtime.md "Quota and token accounting"). `quotaStatus` is pure and lives
 * here so the server's chat replies and every WebUI surface classify a budget the same way.
 */

export interface QuotaStatus {
	kind: "unlimited" | "remaining" | "exhausted";
	/** Remaining tokens when positive, 0 otherwise. Never negative. */
	remaining: number;
	/** How many tokens the level is over budget (0 unless exhausted); never negative. */
	over: number;
	used: number;
}

/** Remaining quota against what the session and its subagents have used. */
export function quotaStatus(budgetRemaining: number | null, used: number): QuotaStatus {
	if (budgetRemaining === null) return { kind: "unlimited", remaining: 0, over: 0, used };
	if (budgetRemaining <= 0) return { kind: "exhausted", remaining: 0, over: Math.abs(budgetRemaining), used };
	return { kind: "remaining", remaining: budgetRemaining, over: 0, used };
}
