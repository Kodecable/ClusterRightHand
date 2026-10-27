import { sql } from "kysely";
import type { RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";

/**
 * Budgets (doc/agent-runtime.md#预算): part of a session's rule set. Spend counts at every level of the chain,
 * so a subagent's use is also its parent's. durable 1.4.0 cannot refuse a model request, so the check runs
 * after each response: a run can go over by at most that one response.
 */
export interface Budget {
	tokens?: number;
	costUsd?: number;
}

export interface Spend {
	tokens: number;
	costUsd: number;
}

const MICRO = 1_000_000;

export function parseBudget(raw: unknown): Budget | null {
	if (raw === null) return null;
	const o = raw as Record<string, unknown> | undefined;
	if (!o || typeof o !== "object" || Array.isArray(o))
		throw new UserError("budget must be { tokens?, costUsd? } or null");
	const budget: Budget = {};
	if (o.tokens !== undefined) {
		if (!Number.isInteger(o.tokens) || (o.tokens as number) <= 0)
			throw new UserError("budget.tokens must be a positive integer");
		budget.tokens = o.tokens as number;
	}
	if (o.costUsd !== undefined) {
		if (typeof o.costUsd !== "number" || !(o.costUsd > 0))
			throw new UserError("budget.costUsd must be a positive number");
		budget.costUsd = o.costUsd;
	}
	if (budget.tokens === undefined && budget.costUsd === undefined) throw new UserError("give tokens and/or costUsd");
	return budget;
}

export async function setBudget(db: Db, ref: RuleRef, budget: Budget | null): Promise<void> {
	await db
		.updateTable("rule_sets")
		.set({ budget: budget ? JSON.stringify(budget) : null, updated_at: new Date().toISOString() })
		.where("scope_type", "=", ref.type)
		.where("scope_id", "=", ref.id)
		.execute();
}

/** The session and its ancestors, root last. */
async function lineage(db: Db, sessionId: string): Promise<string[]> {
	const ids: string[] = [];
	for (let id: string | null = sessionId; id; ) {
		ids.push(id);
		const row: { parent_session_id: string | null } | undefined = await db
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", id)
			.executeTakeFirst();
		id = row?.parent_session_id ?? null;
	}
	return ids;
}

export async function spendOf(db: Db, sessionId: string): Promise<Spend> {
	const row = await db
		.selectFrom("sessions")
		.select(["used_tokens", "used_cost_microusd"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return { tokens: Number(row?.used_tokens ?? 0), costUsd: Number(row?.used_cost_microusd ?? 0) / MICRO };
}

/** The highest level of the chain (root first) whose budget is used up, if any. */
export async function exhaustedLevel(db: Db, sessionId: string): Promise<string | undefined> {
	for (const id of (await lineage(db, sessionId)).reverse()) {
		const rules = await db
			.selectFrom("rule_sets")
			.select("budget")
			.where("scope_type", "=", "session")
			.where("scope_id", "=", id)
			.executeTakeFirst();
		if (!rules?.budget) continue;
		const budget = JSON.parse(rules.budget) as Budget;
		const spend = await spendOf(db, id);
		if (
			(budget.tokens !== undefined && spend.tokens >= budget.tokens) ||
			(budget.costUsd !== undefined && spend.costUsd >= budget.costUsd)
		) {
			return id;
		}
	}
	return undefined;
}

/** Adds one response's usage to the session and every level above it. */
export async function recordSpend(db: Db, sessionId: string, tokens: number, costUsd: number): Promise<void> {
	const micro = Math.round(costUsd * MICRO);
	const ids = await lineage(db, sessionId);
	await db
		.updateTable("sessions")
		.set({
			used_tokens: sql`used_tokens + ${Math.max(0, Math.round(tokens))}`,
			used_cost_microusd: sql`used_cost_microusd + ${Math.max(0, micro)}`,
		})
		.where("id", "in", ids)
		.execute();
}
