import { withAbortSignal } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	type Cursor,
	type EntryRecord,
	watchEvents,
} from "@earendil-works/pi-durable";
import { encodeCursor } from "../api/cursor.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Preset } from "../policy/rules.ts";
import { createRootRuleSet, createRuleSet, getRuleSet, setPreset } from "../policy/store.ts";
import { defaultOrgId } from "../users/service.ts";
import { newId } from "../util/id.ts";
import type { ModelRef } from "./models.ts";
import { setQuota, spentTokens } from "./quota.ts";
import type { RuntimeHost, SessionEvent, SessionInfo, SessionView } from "./runtime-core.ts";
import { conversationOf, loadConversation } from "./runtime-core.ts";
import { notifyQuotaWaiters } from "./runtime-quota.ts";
import { invalidateInboxes } from "./runtime-requests.ts";
import { endSessionWork, refreshState } from "./runtime-state.ts";
import { descendants } from "./runtime-subagents.ts";
import { type SessionRow, sessionChain } from "./session-chain.ts";
import { markSessionsIdle } from "./session-state.ts";

/**
 * Session lifecycle (doc/agent-runtime.md): creating a root (a user's session or a schedule run's), reading
 * and configuring it, stopping it, and reading its transcript. The session's run state lives in
 * runtime-state.ts; this module owns the row and the conversation around it.
 */

/** Entries a snapshot carries; older ones are paged through `GET /api/sessions/:id/entries`. */
const SNAPSHOT_ENTRIES = 100;

/** System messages (the prompt and tool schemas) are not shown in the chat; neither is the entry that holds them. */
function isShownEntry(entry: { readonly model?: readonly { readonly role?: string }[] }): boolean {
	return !(entry.model ?? []).some((message) => message.role === "system");
}

export async function createSession(
	host: RuntimeHost,
	owner: SessionUser,
	input: { title?: string; model: ModelRef; preset: Preset; instructions?: string; quota?: number | null },
): Promise<SessionView> {
	host.models.assertAvailable(input.model);
	const conversation = await host.harness().createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: { provider: input.model.provider, modelId: input.model.modelId },
				...(input.model.thinkingLevel ? { thinkingLevel: input.model.thinkingLevel } : {}),
				...(input.instructions ? { instructions: input.instructions } : {}),
			},
		},
		host.context,
	);
	const id = newId();
	const now = new Date().toISOString();
	const orgId = await defaultOrgId(host.db);
	await host.db.transaction().execute(async (trx) => {
		await trx
			.insertInto("sessions")
			.values({
				id,
				org_id: orgId,
				owner_user_id: owner.userId,
				conversation_id: String(conversation.id),
				parent_session_id: null,
				root_session_id: id,
				title: input.title?.trim() || "New session",
				model: JSON.stringify(input.model),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				// A root without a quota is unlimited and never charged; any level may have one (D92).
				quota_tokens: input.quota ?? null,
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: now,
			})
			.execute();
		await createRootRuleSet(trx, orgId, { type: "session", id }, input.preset);
	});
	void host.audit?.record({
		actor: { type: "user", id: owner.userId, onBehalfOfUserId: owner.userId },
		action: "session.created",
		target: { type: "session", id },
		detail: { model: input.model, preset: input.preset },
	});
	host.sessionList.publishSession(id);
	return (await getSession(host, id)) as SessionView;
}

/**
 * Creates the session a schedule run submits to (doc/scheduling.md): a root session with a fixed id derived
 * from the run, `schedule_id` set and `token_budget` as its root quota. Its rule set is a lower level (no
 * preset, `default: inherit`) under the schedule's root, so the chain is [schedule, session]. A retried call
 * finds the session its first attempt created.
 */
export async function createScheduledSession(
	host: RuntimeHost,
	owner: SessionUser,
	input: { id: string; title: string; model: ModelRef; quota: number | null; scheduleId: string },
): Promise<SessionView> {
	const existing = await getSession(host, input.id);
	if (existing) return existing;
	host.models.assertAvailable(input.model);
	const conversation = await host.harness().createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: { provider: input.model.provider, modelId: input.model.modelId },
				...(input.model.thinkingLevel ? { thinkingLevel: input.model.thinkingLevel } : {}),
			},
		},
		host.context,
	);
	const now = new Date().toISOString();
	const orgId = await defaultOrgId(host.db);
	await host.db.transaction().execute(async (trx) => {
		await trx
			.insertInto("sessions")
			.values({
				id: input.id,
				org_id: orgId,
				owner_user_id: owner.userId,
				conversation_id: String(conversation.id),
				parent_session_id: null,
				root_session_id: input.id,
				schedule_id: input.scheduleId,
				title: input.title.trim() || "Scheduled run",
				model: JSON.stringify(input.model),
				status: "active",
				created_at: now,
				updated_at: now,
				archived_at: null,
				// The budget is the new session's root quota; null means unlimited (D92).
				quota_tokens: input.quota,
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: now,
			})
			.execute();
		await createRuleSet(trx, orgId, { type: "session", id: input.id }, { default: "inherit", rules: [] });
	});
	void host.audit?.record({
		actor: { type: "schedule", id: input.scheduleId, onBehalfOfUserId: owner.userId },
		action: "session.created",
		target: { type: "session", id: input.id },
		detail: { model: input.model, preset: null, schedule_id: input.scheduleId },
	});
	host.sessionList.publishSession(input.id);
	return (await getSession(host, input.id)) as SessionView;
}

export async function getSession(host: RuntimeHost, id: string): Promise<SessionView | undefined> {
	const row = await host.db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
	return row ? sessionView(host, row) : undefined;
}

async function sessionView(host: RuntimeHost, row: SessionRow): Promise<SessionView> {
	const rules = (await getRuleSet(host.db, { type: "session", id: row.id })) ?? null;
	return {
		id: row.id,
		title: row.title,
		ownerUserId: row.owner_user_id,
		parentSessionId: row.parent_session_id,
		scheduleId: row.schedule_id,
		model: JSON.parse(row.model) as ModelRef,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		rules,
		state: row.state,
		waitingKind: row.waiting_kind,
		waitingLevelId: row.waiting_level_id,
		quota: row.quota_tokens === null ? null : Number(row.quota_tokens),
		spentTokens: await spentTokens(host.db, row.id),
	};
}

export async function configure(
	host: RuntimeHost,
	sessionId: string,
	change: { title?: string; model?: ModelRef; preset?: Preset; quota?: number | null },
): Promise<SessionView> {
	const { row, conversation } = await loadConversation(host, sessionId);
	if (change.model) {
		host.models.assertAvailable(change.model);
		await conversation.configure(
			{
				model: { provider: change.model.provider, modelId: change.model.modelId },
				thinkingLevel: change.model.thinkingLevel ?? null,
			},
			host.context,
		);
	}
	if (change.preset && row.parent_session_id === null)
		await setPreset(host.db, { type: "session", id: sessionId }, change.preset);
	if (change.quota !== undefined) {
		// Setting a quota replaces the remainder at any level, the root included; null removes the limit (D92).
		await setQuota(host.db, sessionId, change.quota);
		notifyQuotaWaiters(host);
		invalidateInboxes(host);
		// A wait on this level (or on a root above it) may be over now.
		await refreshState(host, sessionId);
	}
	await host.db
		.updateTable("sessions")
		.set({
			...(change.title?.trim() ? { title: change.title.trim() } : {}),
			...(change.model ? { model: JSON.stringify(change.model) } : {}),
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", sessionId)
		.execute();
	host.sessionList.publishSession(sessionId);
	return (await getSession(host, sessionId)) as SessionView;
}

/** Stops the current run: queued inputs are withdrawn and running tool calls aborted. */
export async function abort(host: RuntimeHost, sessionId: string, by?: SessionUser): Promise<void> {
	const { conversation } = await loadConversation(host, sessionId);
	const sessions = [sessionId, ...(await descendants(host, sessionId))];
	for (const id of sessions) host.stopping.add(id);
	try {
		await conversation.abort(host.context);
		// Subagents are ownerless conversations: their abort is explicit, and it must come before the work is
		// ended. A subagent that is still running can otherwise dispatch a task after the select below, which
		// nothing would cancel (doc/agent-runtime.md#abort).
		for (const id of sessions.slice(1)) {
			const row = await host.db
				.selectFrom("sessions")
				.select("conversation_id")
				.where("id", "=", id)
				.executeTakeFirst();
			if (!row) continue;
			const child = await conversationOf(host, row);
			await child?.abort(host.context);
		}
		// Stopping means stopping the work too. This is done here, not on the tool's abort signal, which also
		// fires when crhs shuts down: after a restart the call reattaches to its task instead.
		await endSessionWork(host, sessions, "the session was stopped", { includeRunning: true, ...(by ? { by } : {}) });
		// The stop stays marked until every conversation and every wait of the tree is settled: a run that
		// ends after it is cleared would take the "run ended" path and miss its running tasks.
		await markSessionsIdle(host.db, sessions);
		for (const id of sessions) host.sessionList.publishSession(id);
		for (const id of sessions) host.deniedWaits.delete(id);
		// Clear a quota wait of an ancestor that only the aborted subtree caused.
		const root = (await sessionChain(host.db, sessionId)).at(-1);
		if (root) await refreshState(host, root);
		notifyQuotaWaiters(host);
		invalidateInboxes(host);
		for (const id of sessions) host.pendingWakes.delete(id);
	} finally {
		for (const id of sessions) host.stopping.delete(id);
	}
}

/**
 * Streams the session's events: `onEvents` first gets a snapshot event, then batches as commits land.
 * Returns a function that stops the stream.
 */
export async function watch(
	host: RuntimeHost,
	sessionId: string,
	onEvents: (events: SessionEvent[]) => Promise<void> | void,
	signal?: AbortSignal,
) {
	const { row, conversation } = await loadConversation(host, sessionId);
	const context = signal ? withAbortSignal(signal, host.context) : host.context;
	const stream = await watchEvents(host.harness(), Number(row.conversation_id) as unknown as ConversationId, context);
	await onEvents([await snapshotEvent(host, conversation, stream.snapshot)]);
	// The client may have gone while the snapshot was being sent; starting the watch then would throw.
	if (signal?.aborted) return () => stream.stop();
	// The system prompt and tool schemas come as system messages: large, and nothing a chat UI shows.
	const shown = (e: SessionEvent) => (e as { message?: { role?: string } }).message?.role !== "system";
	stream.start(async (events) => onEvents((events as SessionEvent[]).filter(shown)));
	return () => stream.stop();
}

/**
 * The first event of a watch, cut down to what the WebUI renders: the newest `SNAPSHOT_ENTRIES` shown entries
 * (system messages are not shown) and a `historyCursor` for `GET /sessions/:id/entries` when older records
 * exist (doc/webui.md#会话事件流和历史). The cursor points just before the oldest returned entry, so the
 * snapshot and the pages that follow it never overlap or skip.
 */
async function snapshotEvent(
	host: RuntimeHost,
	conversation: Conversation,
	snapshot: { readonly entries: readonly EntryRecord[] },
): Promise<SessionEvent> {
	const entries = snapshot.entries.filter(isShownEntry);
	const kept = entries.slice(-SNAPSHOT_ENTRIES);
	let historyCursor: string | null = null;
	if (entries.length > SNAPSHOT_ENTRIES) {
		// The kept page starts inside the snapshot: the entries before its oldest one are the next page.
		const oldestKept = kept[0];
		if (oldestKept) historyCursor = encodeCursor([], Number(oldestKept.id));
	} else {
		// Everything shown in the snapshot is here; history can only start before the whole snapshot.
		const oldestEntry = snapshot.entries[0];
		if (oldestEntry && (await hasEntryBefore(host, conversation, Number(oldestEntry.id)))) {
			historyCursor = encodeCursor([], Number(oldestEntry.id));
		}
	}
	return {
		type: "snapshot",
		snapshot: { ...snapshot, entries: kept, historyCursor },
	} as unknown as SessionEvent;
}

/** Whether the conversation has any record (shown or not) older than `entryId`; one indexed read. */
async function hasEntryBefore(host: RuntimeHost, conversation: Conversation, entryId: number): Promise<boolean> {
	const page = await conversation.entries(
		{ order: "descending" },
		1,
		{ after: entryId, order: "descending" },
		host.context,
	);
	return page.items.length > 0;
}

/**
 * A page of a session's history for `GET /sessions/:id/entries`: shown entries only, oldest first, ending
 * immediately before `before`. The durable scan is indexed by (conversation, entry id), so a page costs
 * O(page) reads; fork chains are walked segment by segment. New entries append at higher ids and cannot
 * disturb pages that walk backwards.
 */
export async function entriesPage(
	host: RuntimeHost,
	sessionId: string,
	before: number | undefined,
	limit: number,
): Promise<{ entries: EntryRecord[]; historyCursor: string | null }> {
	const { conversation } = await loadConversation(host, sessionId);
	const wanted = limit + 1;
	const collected: EntryRecord[] = [];
	let cursor: Cursor | undefined = before === undefined ? undefined : { after: before, order: "descending" };
	while (collected.length < wanted) {
		const page = await conversation.entries({ order: "descending" }, wanted - collected.length, cursor, host.context);
		for (const entry of page.items) if (isShownEntry(entry)) collected.push(entry);
		if (!page.next) break;
		cursor = page.next;
	}
	const pageEntries = collected.slice(0, limit);
	const oldest = pageEntries[pageEntries.length - 1];
	return {
		entries: pageEntries.reverse(),
		historyCursor: collected.length > limit && oldest ? encodeCursor([], Number(oldest.id)) : null,
	};
}

/** The session a conversation belongs to, for tool calls that only know their conversation id. */
export async function sessionAt(host: RuntimeHost, conversationId: string): Promise<SessionInfo | undefined> {
	const cached = host.sessionsByConversation.get(conversationId);
	if (cached) return cached;
	const row = await host.db
		.selectFrom("sessions")
		.select(["id", "owner_user_id", "org_id", "parent_session_id"])
		.where("conversation_id", "=", conversationId)
		.executeTakeFirst();
	if (!row) return undefined;
	const session = {
		id: row.id,
		ownerUserId: row.owner_user_id,
		orgId: row.org_id,
		parentSessionId: row.parent_session_id,
	};
	host.sessionsByConversation.set(conversationId, session);
	return session;
}

/** Whether the session's tools need to look for subagent requests; cached after the first check. */
export async function hasSubagents(host: RuntimeHost, sessionId: string): Promise<boolean> {
	if (host.subagentParents.has(sessionId)) return true;
	const row = await host.db
		.selectFrom("sessions")
		.select("id")
		.where("parent_session_id", "=", sessionId)
		.limit(1)
		.executeTakeFirst();
	if (row) host.subagentParents.add(sessionId);
	return row !== undefined;
}
