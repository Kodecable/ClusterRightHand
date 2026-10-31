import { createHash } from "node:crypto";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { AuditEventsTable } from "../storage/schema.ts";
import { defaultOrgId } from "../users/service.ts";
import { newId } from "../util/id.ts";

/** The chain starts from this hash. */
export const GENESIS_HASH = "0".repeat(64);

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

export interface AuditEvent {
	seq: number;
	id: string;
	ts: string;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	hash: string;
}

/** JSON with object keys sorted at every level and no whitespace; the hashed form of a record. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

type Row = Omit<AuditEventsTable, "hash" | "prev_hash">;

/** hash = SHA-256(prev_hash || "\n" || canonical record), hex; see doc/access-control.md#防篡改. */
export function eventHash(prevHash: string, row: Row): string {
	const record = canonicalJson({ ...row, detail: JSON.parse(row.detail) });
	return createHash("sha256").update(`${prevHash}\n${record}`).digest("hex");
}

/**
 * Appends to the audit hash chain. crhs is a single process (doc/agent-runtime.md), so appends are
 * serialized in memory; the unique seq would reject a second writer.
 */
export class Audit {
	readonly #db: Db;
	#queue: Promise<unknown> = Promise.resolve();
	#orgId: string | undefined;

	constructor(db: Db) {
		this.#db = db;
	}

	/** Records an event; failures are logged, never thrown, since the action already happened. */
	record(input: AuditInput): Promise<void> {
		const run = this.#queue.then(() => this.#append(input));
		this.#queue = run.catch(() => {});
		return run.then(
			() => {},
			(err: unknown) => console.error(`audit: failed to record ${input.action}:`, err),
		);
	}

	async #append(input: AuditInput): Promise<void> {
		this.#orgId ??= await defaultOrgId(this.#db);
		const last = await this.#db
			.selectFrom("audit_events")
			.select(["seq", "hash"])
			.orderBy("seq", "desc")
			.limit(1)
			.executeTakeFirst();
		const row: Row = {
			seq: (last?.seq ?? 0) + 1,
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
		};
		const prevHash = last?.hash ?? GENESIS_HASH;
		await this.#db
			.insertInto("audit_events")
			.values({ ...row, prev_hash: prevHash, hash: eventHash(prevHash, row) })
			.execute();
	}

	/** Resolves once every record() issued so far has been written (tests, shutdown). */
	async flush(): Promise<void> {
		await this.#queue;
	}
}

export function userActor(user: SessionUser): AuditActor {
	return { type: "user", id: user.userId, onBehalfOfUserId: user.userId };
}

export interface ChainCheck {
	ok: boolean;
	count: number;
	/** The first record whose link or hash does not check out. */
	brokenAt?: number;
	reason?: string;
}

/** Recomputes the whole chain. Detects edits that bypass crhs; see the limits in access-control.md. */
export async function verifyChain(db: Db, batch = 1000): Promise<ChainCheck> {
	let prev = GENESIS_HASH;
	let expectedSeq = 1;
	let count = 0;
	for (;;) {
		const rows = await db
			.selectFrom("audit_events")
			.selectAll()
			.where("seq", ">=", expectedSeq)
			.orderBy("seq")
			.limit(batch)
			.execute();
		for (const r of rows) {
			if (r.seq !== expectedSeq) return { ok: false, count, brokenAt: expectedSeq, reason: "missing record" };
			if (r.prev_hash !== prev) return { ok: false, count, brokenAt: r.seq, reason: "broken link" };
			const { hash, prev_hash: _p, ...row } = r;
			if (eventHash(prev, row) !== hash) return { ok: false, count, brokenAt: r.seq, reason: "hash mismatch" };
			prev = hash;
			expectedSeq++;
			count++;
		}
		if (rows.length < batch) return { ok: true, count };
	}
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
	if (user.kind !== "admin") sel = sel.where("on_behalf_of_user_id", "=", user.userId);
	if (q.action)
		sel = q.action.endsWith(".") ? sel.where("action", "like", `${q.action}%`) : sel.where("action", "=", q.action);
	if (q.targetType) sel = sel.where("target_type", "=", q.targetType);
	if (q.targetId) sel = sel.where("target_id", "=", q.targetId);
	if (q.before) sel = sel.where("seq", "<", q.before.seq);
	return (await sel.execute()).map((r) => ({
		seq: r.seq,
		id: r.id,
		ts: r.ts,
		actorType: r.actor_type,
		actorId: r.actor_id,
		onBehalfOfUserId: r.on_behalf_of_user_id,
		action: r.action,
		targetType: r.target_type,
		targetId: r.target_id,
		detail: JSON.parse(r.detail) as Record<string, unknown>,
		hash: r.hash,
	}));
}
