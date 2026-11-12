import type { AuditEvent } from "@crh/api";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../users/service.ts";
import { newId } from "../util/id.ts";

export interface AuditActor {
	type: string;
	id: string;
	/** The user the actor stands for; absent for the system. */
	onBehalfOfUserId?: string | null;
}

export interface AuditInput {
	actor: AuditActor;
	/** Dotted verb, e.g. "task.created", "auth.login_failed". */
	action: string;
	target?: { type: string; id: string };
	detail?: Record<string, unknown>;
}

export type { AuditEvent };

/** JSON with object keys sorted at every level and no whitespace; how a record's detail is stored. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Appends to the audit log. `seq` is assigned by the database (SQLite's rowid, PostgreSQL's identity), so
 * appends need no read of the last row and are not serialized: concurrent writers get distinct numbers.
 */
export class Audit {
	readonly #db: Db;
	#orgId: string | undefined;
	/** Appends that have not settled yet; flush() awaits them. */
	readonly #pending = new Set<Promise<void>>();

	constructor(db: Db) {
		this.#db = db;
	}

	/**
	 * Appends an event and fails if it cannot be written: for a caller that must not keep a change
	 * whose record is missing (a CLI action, or a transaction that includes its own event).
	 */
	async append(input: AuditInput): Promise<void> {
		await this.#append(input);
	}

	/** Records an event; failures are logged, never thrown, since the action already happened. */
	record(input: AuditInput): Promise<void> {
		const run = this.append(input).then(
			() => {},
			(err: unknown) => console.error(`audit: failed to record ${input.action}:`, err),
		);
		this.#pending.add(run);
		void run.finally(() => this.#pending.delete(run));
		return run;
	}

	async #append(input: AuditInput): Promise<void> {
		this.#orgId ??= await defaultOrgId(this.#db);
		await this.#db
			.insertInto("audit_events")
			.values({
				id: newId(),
				org_id: this.#orgId,
				ts: new Date().toISOString(),
				actor_type: input.actor.type,
				actor_id: input.actor.id,
				on_behalf_of_user_id: input.actor.onBehalfOfUserId ?? null,
				action: input.action,
				target_type: input.target?.type ?? null,
				target_id: input.target?.id ?? null,
				detail: canonicalJson(input.detail ?? {}),
			})
			.execute();
	}

	/** Resolves once every record() issued so far has been written (tests, shutdown). */
	async flush(): Promise<void> {
		await Promise.all(this.#pending);
	}
}

export function userActor(user: SessionUser): AuditActor {
	return { type: "user", id: user.userId, onBehalfOfUserId: user.userId };
}

export interface AuditQuery {
	action?: string;
	targetType?: string;
	targetId?: string;
	/** Page backwards from this position (exclusive): the `seq` and `id` of the last event of the previous page. */
	before?: { seq: number; id: string };
	limit?: number;
}

/**
 * Newest first. Administrators see everything; other users the events done on their behalf. `seq` is
 * unique, so it alone is the descending key; the cursor's id is carried for the shared cursor format.
 */
export async function listAuditEvents(db: Db, user: SessionUser, q: AuditQuery): Promise<AuditEvent[]> {
	let sel = db
		.selectFrom("audit_events")
		.selectAll()
		.orderBy("seq", "desc")
		.limit(Math.min(q.limit ?? 100, 500));
	if (!isAdmin(user)) sel = sel.where("on_behalf_of_user_id", "=", user.userId);
	if (q.action)
		sel = q.action.endsWith(".") ? sel.where("action", "like", `${q.action}%`) : sel.where("action", "=", q.action);
	if (q.targetType) sel = sel.where("target_type", "=", q.targetType);
	if (q.targetId) sel = sel.where("target_id", "=", q.targetId);
	if (q.before) sel = sel.where("seq", "<", q.before.seq);
	return (await sel.execute()).map((r) => ({
		// PostgreSQL returns bigint as a string; the API's seq is a number.
		seq: Number(r.seq),
		id: r.id,
		ts: r.ts,
		actorType: r.actor_type,
		actorId: r.actor_id,
		onBehalfOfUserId: r.on_behalf_of_user_id,
		action: r.action,
		targetType: r.target_type,
		targetId: r.target_id,
		detail: JSON.parse(r.detail) as Record<string, unknown>,
	}));
}
