import type {
	ApprovalDecision,
	ApprovalRecord,
	ExtensionToolAnnotations,
	ExternalCallState,
	ExternalCallView,
	Operation,
} from "@crh/api";
import type { Selectable } from "kysely";
import { agentRouting } from "../cluster/approval.ts";
import { type ChainLevel, evaluate } from "../policy/rules.ts";
import { loadChain, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { ExternalCallsTable } from "../storage/schema.ts";
import { UserError } from "../util/errors.ts";
import { derivedId } from "../util/id.ts";

/**
 * External extension calls and their approvals (doc/design/extensions.md "External calls"). An external call is the
 * small object an approval belongs to: it holds the rule chain, the approval record, the operation and the
 * state that must survive while the call is in progress. Its id is derived from the durable tool call, so a
 * replayed call finds its earlier row. A terminal row keeps only its state and `finished_at` (the "already
 * ran" marker) and clears its arguments: the result lives in the transcript and the decision in the audit log.
 *
 * A waiting call is woken in memory when a decision writes the row, so an approval, Auto Review or a rule
 * change wakes the call without another in-memory path. A call that was `running` when crhs stopped is
 * recovered as `unknown` and never repeated.
 */

/** The states a call ends in; only these rows are swept by retention (doc/design/data-model.md "Retention"). */
export const EXTERNAL_CALL_TERMINAL: readonly ExternalCallState[] = [
	"succeeded",
	"failed",
	"rejected",
	"cancelled",
	"unknown",
];

/**
 * In-memory waiters of waiting calls, woken when a decision settles the row (doc/design/extensions.md
 * "External calls"). crhs is one process, so an approval, Auto Review, a rule change, an agent decision
 * and a cancellation all write the row and wake the waiter here instead of the call polling for it.
 */
const waiters = new Map<string, Set<() => void>>();

function wakeExternalCall(id: string): void {
	const waiting = waiters.get(id);
	if (!waiting) return;
	waiters.delete(id);
	for (const wake of [...waiting]) wake();
}

export type ExternalCallRow = Selectable<ExternalCallsTable>;

export interface ExternalCallInput {
	/** The durable tool call's key; the row id is derived from it. */
	callKey: string;
	orgId: string;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	extension: string;
	tool: string;
	arguments: Record<string, unknown>;
	operation: Operation;
	annotations: ExtensionToolAnnotations | null;
	ruleChain: RuleRef[];
	rootSessionId: string | null;
	/** The transcript id of the tool call (model-supplied, may repeat), so Auto Review can find it. */
	sourceCallId?: string | null;
	approval: ApprovalRecord;
	state: "awaiting_approval" | "running";
}

function parseJson<T>(raw: string | null): T | null {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export function externalCallId(callKey: string): string {
	return derivedId(`external-call:${callKey}`);
}

/** Creates the call, or returns the row a replayed tool call already created. */
export async function createExternalCall(
	db: Db,
	input: ExternalCallInput,
): Promise<{ row: ExternalCallRow; created: boolean }> {
	const id = externalCallId(input.callKey);
	const now = new Date().toISOString();
	const existing = await db.selectFrom("external_calls").selectAll().where("id", "=", id).executeTakeFirst();
	if (existing) return { row: existing, created: false };
	await db
		.insertInto("external_calls")
		.values({
			id,
			org_id: input.orgId,
			actor_type: input.actorType,
			actor_id: input.actorId,
			on_behalf_of_user_id: input.onBehalfOfUserId,
			extension_name: input.extension,
			tool_name: input.tool,
			arguments: JSON.stringify(input.arguments),
			operation: JSON.stringify(input.operation),
			annotations: input.annotations ? JSON.stringify(input.annotations) : null,
			rule_chain: JSON.stringify(input.ruleChain),
			approval: JSON.stringify(input.approval),
			pending_input: null,
			root_session_id: input.rootSessionId,
			source_call_id: input.sourceCallId ?? null,
			handler_type: input.state === "awaiting_approval" ? "user" : null,
			handler_session_id: null,
			state: input.state,
			created_at: now,
			finished_at: null,
		})
		.execute();
	const row = await getExternalCall(db, id);
	if (!row) throw new Error("the external call row disappeared");
	return { row, created: true };
}

export async function getExternalCall(db: Db, id: string): Promise<ExternalCallRow | undefined> {
	return db.selectFrom("external_calls").selectAll().where("id", "=", id).executeTakeFirst();
}

/** The calls waiting for this user's decision, oldest first. */
export async function pendingExternalCallRows(db: Db, userId: string): Promise<ExternalCallRow[]> {
	return db
		.selectFrom("external_calls")
		.selectAll()
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.where("on_behalf_of_user_id", "=", userId)
		.orderBy("created_at")
		.execute();
}

export function externalCallOperation(row: ExternalCallRow): Operation {
	return (
		parseJson<Operation>(row.operation) ?? { method: "ext.write", target: `${row.extension_name}/${row.tool_name}` }
	);
}

export function externalCallArguments(row: ExternalCallRow): Record<string, unknown> {
	return parseJson<Record<string, unknown>>(row.arguments) ?? {};
}

export function externalCallApproval(row: Pick<ExternalCallRow, "approval">): ApprovalRecord | null {
	return parseJson<ApprovalRecord>(row.approval);
}

export function externalCallAnnotations(row: ExternalCallRow): ExtensionToolAnnotations | null {
	return parseJson<ExtensionToolAnnotations>(row.annotations);
}

/** One line naming what an ancestor agent is asked about, for its request list and its wake note. */
export function externalCallSummary(row: ExternalCallRow): string {
	const annotations = externalCallAnnotations(row);
	return (
		`${row.extension_name}/${row.tool_name} (${externalCallOperation(row).method})` +
		(annotations === null ? "" : ` annotations ${JSON.stringify(annotations)}`) +
		` arguments ${JSON.stringify(externalCallArguments(row))}`
	);
}

function toView(row: ExternalCallRow): ExternalCallView {
	return {
		id: row.id,
		extension: row.extension_name,
		tool: row.tool_name,
		arguments: externalCallArguments(row),
		operation: externalCallOperation(row),
		annotations: parseJson<ExtensionToolAnnotations>(row.annotations),
		state: row.state,
		approval: externalCallApproval(row),
		actorType: row.actor_type,
		actorId: row.actor_id,
		onBehalfOfUserId: row.on_behalf_of_user_id,
		rootSessionId: row.root_session_id,
		handlerType: row.handler_type as "agent" | "user" | null,
		handlerSessionId: row.handler_session_id,
		createdAt: row.created_at,
		finishedAt: row.finished_at,
	};
}

export async function externalCallViews(_db: Db, rows: readonly ExternalCallRow[]): Promise<ExternalCallView[]> {
	return rows.map(toView);
}

function withDecision(_row: ExternalCallRow, record: ApprovalRecord): string {
	return JSON.stringify({ ...record, decision: record.decision });
}

/**
 * Settles a waiting call. Approving moves it to `running`, so the tool that waits executes it; rejecting
 * ends it. The write is guarded on the state and, when given, the handler the caller read, so a decision
 * that arrived first is not overwritten and an agent decision lands only on that agent's request.
 */
export async function decideExternalCall(
	db: Db,
	id: string,
	decision: ApprovalDecision,
	reason: string | null = null,
	expect?: { handlerType: "agent" | "user"; handlerSessionId?: string | null },
): Promise<boolean> {
	const row = await getExternalCall(db, id);
	if (row?.state !== "awaiting_approval" || row.handler_type === null) return false;
	if (expect && row.handler_type !== expect.handlerType) return false;
	if (expect && expect.handlerSessionId !== undefined && row.handler_session_id !== expect.handlerSessionId)
		return false;
	const approval = {
		...(externalCallApproval(row) ?? { evaluation: { result: "require-approval", levels: [] } }),
		decision: reason === null ? decision : { ...decision, reason },
	};
	const approved = decision.decision === "approved";
	const now = new Date().toISOString();
	let update = db
		.updateTable("external_calls")
		.set({
			state: approved ? "running" : "rejected",
			approval: withDecision(row, approval as ApprovalRecord),
			handler_type: null,
			handler_session_id: null,
			// A rejected call is over: its arguments go, like any other terminal row.
			...(approved ? {} : { arguments: null, finished_at: now }),
		})
		.where("id", "=", id)
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "is not", null);
	if (expect) {
		update = update.where("handler_type", "=", expect.handlerType);
		if (expect.handlerSessionId !== undefined) {
			update =
				expect.handlerSessionId === null
					? update.where("handler_session_id", "is", null)
					: update.where("handler_session_id", "=", expect.handlerSessionId);
		}
	}
	const result = await update.executeTakeFirst();
	if (result.numUpdatedRows === 0n) return false;
	wakeExternalCall(id);
	return true;
}

/** Hands a waiting call's approval to an ancestor session's agent (doc/design/access-control.md "Approvals"). */
export function requestAgentDecision(db: Db, id: string, session: string): Promise<boolean> {
	return routeAgentDecision(db, id, session, "pending");
}

/** The agent passed the call on to the user: Auto Review then the approvals page takes it from here. */
export function escalateAgentDecision(db: Db, id: string, session: string): Promise<boolean> {
	return routeAgentDecision(db, id, session, "escalated");
}

/**
 * Routes a waiting call's approval to an agent or back to the user, guarded on the state and the handler
 * that was read, like a task's routing. A call already handled by another agent is not taken over.
 */
async function routeAgentDecision(
	db: Db,
	id: string,
	session: string,
	state: "pending" | "escalated",
): Promise<boolean> {
	const row = await getExternalCall(db, id);
	if (row?.state !== "awaiting_approval" || row.handler_type === null) return false;
	// An escalated call is the user's: routing it again would undo the agent's decision on a replay.
	if (state === "pending" && externalCallApproval(row)?.agent?.state === "escalated") return false;
	if (state === "escalated" && (row.handler_type !== "agent" || row.handler_session_id !== session)) return false;
	const routing = agentRouting(session, state);
	const approval = {
		...(externalCallApproval(row) ?? { evaluation: { result: "require-approval", levels: [] } }),
		agent: routing.agent,
	};
	let update = db
		.updateTable("external_calls")
		.set({ approval: JSON.stringify(approval), ...routing.handler })
		.where("id", "=", id)
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "is not", null);
	if (state === "escalated") {
		update = update.where("handler_type", "=", "agent").where("handler_session_id", "=", session);
	}
	const result = await update.executeTakeFirst();
	return result.numUpdatedRows > 0n;
}

/** Records Auto Review's verdict on a waiting call; the decision itself follows separately. */
export async function recordExternalCallReview(
	db: Db,
	id: string,
	review: NonNullable<ApprovalRecord["review"]>,
): Promise<void> {
	const row = await getExternalCall(db, id);
	if (row?.state !== "awaiting_approval") return;
	const approval = { ...(externalCallApproval(row) ?? {}), review } as ApprovalRecord;
	await db
		.updateTable("external_calls")
		.set({ approval: JSON.stringify(approval) })
		.where("id", "=", id)
		.where("state", "=", "awaiting_approval")
		.execute();
}

/**
 * Marks a call terminal. Only the state, `finished_at` and the cleared arguments and handler are kept: the
 * row is the "already ran" marker a replayed tool call finds, and the result itself is in the transcript. A
 * waiting call ends this way when it will not run (the extension is gone or the rules deny it). A terminal
 * row is never overwritten, so a late caller cannot replace a recovery's `unknown`.
 */
export async function finishExternalCall(
	db: Db,
	id: string,
	finish: { state: Extract<ExternalCallState, "succeeded" | "failed" | "rejected" | "cancelled" | "unknown"> },
): Promise<void> {
	const result = await db
		.updateTable("external_calls")
		.set({
			state: finish.state,
			handler_type: null,
			handler_session_id: null,
			arguments: null,
			finished_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.where("state", "not in", [...EXTERNAL_CALL_TERMINAL])
		.executeTakeFirst();
	if (result.numUpdatedRows > 0n) wakeExternalCall(id);
}

/** A call cancelled while it waited for approval; it never reached the server. */
export async function cancelWaitingExternalCall(db: Db, id: string): Promise<boolean> {
	const result = await db
		.updateTable("external_calls")
		.set({
			state: "cancelled",
			handler_type: null,
			handler_session_id: null,
			arguments: null,
			finished_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.where("state", "=", "awaiting_approval")
		.executeTakeFirst();
	if (result.numUpdatedRows === 0n) return false;
	wakeExternalCall(id);
	return true;
}

/**
 * Waits until the call leaves `awaiting_approval` (approved, rejected or cancelled), woken by whichever
 * path writes the decision (doc/design/extensions.md "External calls"). The waiter is registered before
 * `onWaiting` runs, so a decision made while the call is announced is not missed.
 */
export async function waitExternalCall(
	db: Db,
	id: string,
	options: { signal?: AbortSignal; cancelOnAbort?: boolean; onWaiting?: () => Promise<void> | void } = {},
): Promise<ExternalCallRow> {
	let announced = false;
	for (;;) {
		const row = await getExternalCall(db, id);
		if (!row) throw new UserError("the external call is gone", "not_found");
		if (row.state !== "awaiting_approval") return row;
		let resolveWake!: () => void;
		const changed = new Promise<void>((resolve) => {
			resolveWake = resolve;
		});
		const wake = () => resolveWake();
		const waiting = waiters.get(id) ?? new Set<() => void>();
		waiters.set(id, waiting);
		waiting.add(wake);
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<"aborted">((resolve) => {
			onAbort = () => resolve("aborted");
			if (options.signal?.aborted) onAbort();
			else options.signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			if (!announced) {
				announced = true;
				await options.onWaiting?.();
			}
			const outcome = await Promise.race([changed.then(() => "changed" as const), aborted]);
			if (outcome === "aborted") {
				if (options.cancelOnAbort !== false) {
					await cancelWaitingExternalCall(db, id);
					return (await getExternalCall(db, id)) ?? row;
				}
				return row;
			}
		} finally {
			waiting.delete(wake);
			if (waiting.size === 0 && waiters.get(id) === waiting) waiters.delete(id);
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * Judges waiting external calls again after rules on their chain changed (doc/design/access-control.md
 * "Approvals"): allow starts the call, deny rejects it, require-approval leaves it waiting. A chain whose
 * level is gone rejects: nothing may run under a deleted rule set.
 */
export async function reevaluateExternalCalls(db: Db, ref: RuleRef): Promise<void> {
	const rows = await db
		.selectFrom("external_calls")
		.selectAll()
		.where("state", "=", "awaiting_approval")
		.where("rule_chain", "is not", null)
		.execute();
	for (const row of rows) {
		const chain = parseJson<RuleRef[]>(row.rule_chain);
		if (!chain?.some((level) => level.type === ref.type && level.id === ref.id)) continue;
		let levels: ChainLevel[];
		try {
			levels = await loadChain(db, chain);
		} catch {
			await decideExternalCall(
				db,
				row.id,
				{ decision: "rejected", by: { type: "system", id: "rules" }, at: new Date().toISOString() },
				"the rule chain of this call no longer exists",
			);
			continue;
		}
		const evaluation = evaluate(levels, { ...externalCallOperation(row), privileged: false });
		if (evaluation.result === "allow") {
			await decideExternalCall(
				db,
				row.id,
				{
					decision: "approved",
					by: { type: "system", id: "rules" },
					at: new Date().toISOString(),
					reason: "allowed by the changed rules",
				},
				null,
			);
		} else if (evaluation.result === "deny") {
			await decideExternalCall(
				db,
				row.id,
				{ decision: "rejected", by: { type: "system", id: "rules" }, at: new Date().toISOString() },
				"denied by the authorization rules",
			);
		}
	}
}

/**
 * At startup, every call that was in flight ends `unknown`: the server may have run it, and an external
 * call is not assumed to be idempotent, so it is never repeated.
 */
export async function recoverExternalCalls(db: Db): Promise<number> {
	const rows = await db.selectFrom("external_calls").select("id").where("state", "=", "running").execute();
	if (rows.length === 0) return 0;
	await db
		.updateTable("external_calls")
		.set({
			state: "unknown",
			arguments: null,
			finished_at: new Date().toISOString(),
		})
		.where("state", "=", "running")
		.execute();
	return rows.length;
}
