import type { PendingPayloadView, TaskAuthorizationView } from "@crh/api";

/** The authorization state of one task, as `tasks.authorization` stores it and the task views show it. */
export type TaskAuthorizationRecord = TaskAuthorizationView;

/** The stored record; malformed rows are treated as absent (a fresh plan replaces them). */
export function parseTaskAuthorization(json: string | null): TaskAuthorizationRecord | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<TaskAuthorizationRecord> | null;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (!value.plan || !Array.isArray(value.plan.paths) || !Array.isArray(value.tried)) return null;
		return {
			plan: value.plan,
			tried: value.tried,
			dispatchedPath: value.dispatchedPath ?? null,
			payloadId: value.payloadId ?? null,
			attempt: value.attempt ?? 1,
			trustDigest: value.trustDigest ?? null,
			pending: parsePending(value.pending),
			local: parseLocal(value.local),
			lastRejection: value.lastRejection ?? null,
			updatedAt: value.updatedAt ?? "",
		};
	} catch {
		return null;
	}
}

function parsePending(value: unknown): PendingPayloadView | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const pending = value as Record<string, unknown>;
	if (
		typeof pending.payload !== "string" ||
		typeof pending.id !== "string" ||
		!Array.isArray(pending.taskIds) ||
		typeof pending.attempt !== "number" ||
		typeof pending.deadline !== "string"
	) {
		return null;
	}
	return {
		payload: pending.payload,
		id: pending.id,
		deadline: pending.deadline,
		taskIds: pending.taskIds.filter((id): id is string => typeof id === "string"),
		attempt: pending.attempt,
	};
}

function parseLocal(value: unknown): { attempt: number } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const attempt = (value as Record<string, unknown>).attempt;
	return typeof attempt === "number" ? { attempt } : null;
}
