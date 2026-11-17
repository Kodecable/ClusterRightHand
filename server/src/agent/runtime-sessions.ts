import type { ChatAttachment, SessionEntriesPage } from "@crh/api";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	type Conversation,
	type ConversationId,
	type Cursor,
	type EntryId,
	type EntryRecord as PiEntryRecord,
	type SnapshotEvent as PiSnapshotEvent,
	watchEvents,
} from "@earendil-works/pi-durable";
import { userActor } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { extensionNamesForUser, parseDisabledExtensionNames } from "../extensions/store.ts";
import { ruleRefs } from "../policy/refs.ts";
import type { Rule, RulePreset } from "../policy/rules.ts";
import { createRootRuleSet, deleteRuleSet, getRuleSet, setRulePreset } from "../policy/store.ts";
import { type SessionRow, sessionChain, sessionDescendants } from "../sessions/session-chain.ts";
import { forkedSessionTitle } from "../sessions/titles.ts";
import { defaultOrgId } from "../storage/org.ts";
import { getUserSettings } from "../users/settings.ts";
import { encodeCursor } from "../util/cursor.ts";
import { isUniqueViolation, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import { sessionExtensionViews } from "./extension.ts";
import { type ModelRef, modelRefView, thinkingLevelOf } from "./models.ts";
import { setQuota } from "./quota.ts";
import {
	type ReviewHistoryEntry,
	type ReviewToolCallRecord,
	reviewHistoryEntries,
	reviewToolCalls as reviewToolCallsOf,
} from "./review-history.ts";
import type { RuntimeHost, SessionEvent, SessionInfo, SessionView } from "./runtime-core.ts";
import { conversationOf, loadConversation, loadSession } from "./runtime-core.ts";
import { endSessionWork, refreshState } from "./runtime-state.ts";
import { submit } from "./runtime-submissions.ts";
import { toEntryRecord, toSessionEvent, toSnapshotEvent } from "./session-events.ts";
import { markSessionsIdle } from "./session-state.ts";

/**
 * Session lifecycle (doc/design/agent-runtime.md): creating a root (a user's session or a schedule run's), reading
 * and configuring it, stopping it, and reading its transcript. The session's run state lives in
 * runtime-state.ts; this module owns the row and the conversation around it.
 */

/** Entries a snapshot carries; older ones are paged through `GET /api/sessions/:id/entries`. */
const SNAPSHOT_ENTRIES = 100;

/** Whether a pi message is shown in the chat; the system prompt and tool schemas are not. */
function isShownMessage(message: { readonly role?: string }): boolean {
	return message.role !== "system";
}

/** System messages (the prompt and tool schemas) are not shown in the chat; neither is the entry that holds them. */
function isShownEntry(entry: { readonly model?: readonly { readonly role?: string }[] }): boolean {
	return (entry.model ?? []).every(isShownMessage);
}

/**
 * Whether a live pi event may reach the WebUI. The snapshot drops unseen entries; a live event that carries a
 * message or a full entry must apply the same rule here, or the system prompt would leak onto the live path only.
 */
function isShownEvent(event: AgentEvent): boolean {
	switch (event.type) {
		case "message_start":
			// `message_start` carries only the entry's first message (pi-durable emits `entry.model[0]`) while
			// `message_end` is judged on the whole entry; with today's one-message entries (the system prompt is
			// its own entry) they agree. If an entry ever mixed a shown first message with a later system
			// message, the start would pass while the end is dropped.
			return isShownMessage(event.message);
		case "message_end":
		case "entry_appended":
			return isShownEntry(event.entry);
		case "tool_execution_end":
			return event.entry === undefined || isShownEntry(event.entry);
		default:
			return true;
	}
}

/**
 * Drops each session's in-flight generation timing (doc/design/agent-runtime.md "Session statistics"). The timings are keyed by
 * provider session id, so each crh session id is resolved through the session cache first.
 */
function clearTimings(host: RuntimeHost, sessionIds: readonly string[]): void {
	for (const id of sessionIds) {
		const providerSessionId = host.sessionCaches.providerSessionIdFor(id);
		if (providerSessionId) host.generationTimings.clear(providerSessionId);
	}
}

export async function createSession(
	host: RuntimeHost,
	owner: SessionUser,
	input: {
		title?: string;
		model: ModelRef;
		rulePreset: RulePreset;
		instructions?: string;
		budgetRemaining?: number | null;
		/** The extensions the owner turned off on the draft; omitted means all available extensions are on. */
		disabledExtensions?: string[];
		/** The client request id that created this session and its first message. */
		createRequestId?: string;
	},
): Promise<SessionView> {
	const model = host.models.resolveRef(input.model);
	// The session selects the extensions its owner may use; the tool list is the same for its whole life
	// (doc/design/extensions.md "Tools for the model"). A draft may start with some turned off, so the row
	// carries the same list the session settings would and the first turn already leaves them out.
	const disabledExtensions = [...new Set(input.disabledExtensions ?? [])];
	const availableExtensions = await extensionNamesForUser(host.db, owner.userId);
	for (const name of disabledExtensions) {
		if (!availableExtensions.includes(name)) {
			throw new UserError(`no extension named ${name} is available to the session's owner`);
		}
	}
	const extensionNames = availableExtensions.filter((name) => !disabledExtensions.includes(name));
	const conversation = await host.harness().createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: { provider: model.provider, modelId: model.modelId },
				thinkingLevel: thinkingLevelOf(model),
				extensions: host.extensionsFor(extensionNames),
				...(input.instructions ? { instructions: input.instructions } : {}),
			},
		},
		host.context,
	);
	const id = newId();
	const now = new Date().toISOString();
	const title = input.title?.trim() || null;
	try {
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
					title,
					// A user-created root without a title wants one generated at its first run end.
					title_pending: title === null ? 1 : 0,
					create_request_id: input.createRequestId ?? null,
					model: JSON.stringify(model),
					status: "active",
					created_at: now,
					updated_at: now,
					archived_at: null,
					// A root without a remaining budget is unlimited and never charged; any level may have one.
					quota_tokens: input.budgetRemaining ?? null,
					disabled_extensions: disabledExtensions.length === 0 ? null : JSON.stringify(disabledExtensions),
					state: "idle",
					waiting_kind: null,
					waiting_level_id: null,
					waiting_handler_id: null,
					state_changed_at: now,
				})
				.execute();
			await createRootRuleSet(trx, orgId, { type: "session", id }, input.rulePreset);
		});
	} catch (err) {
		// The row did not commit (a concurrent create with the same request id, or a database failure): no
		// session owns this conversation, so stop it rather than leave it running unattached.
		await conversation.abort(host.context).catch((abortError: unknown) => {
			if (!host.closing()) console.error("agent runtime: aborting an unowned conversation failed:", abortError);
		});
		throw err;
	}
	void host.audit?.record({
		// An internal api_request carries the agent session as its actor on behalf of the owner.
		actor: userActor(owner),
		action: "session.created",
		target: { type: "session", id },
		detail: { model, rule_preset: input.rulePreset },
	});
	host.sessionList.publishSession(id);
	return (await getSession(host, id)) as SessionView;
}

/** What the client sent to create a session and submit its first message in one request. */
export interface CreateSessionWithMessageInput {
	/** The client-generated idempotency key: one request id creates one session and one submission. */
	requestId: string;
	message: string;
	title?: string;
	model: ModelRef;
	rulePreset: RulePreset;
	budgetRemaining?: number | null;
	/** The first message's content blocks and attachments (doc/design/library.md "Chat attachments"). */
	content?: { type: "text"; text: string }[];
	attachments?: ChatAttachment[];
	/** The extensions the owner turned off on the draft; the first turn already leaves them out. */
	disabledExtensions?: string[];
	/** Where the first message came from: `web`, a chat thread id, or null. */
	lastUsedFrom?: string | null;
}

/**
 * Creates a session and submits its first message (doc/design/agent-runtime.md "Sessions"). The create request id is
 * stored on the session and makes a retry return the session the first attempt made, without a second
 * submission. The submission's own request id is derived from it, so retrying the submit is idempotent too.
 *
 * A failure after the row exists removes the session again: there is no durable conversation deletion, so its
 * conversation is aborted first (nothing of it may keep running unattached) and then forgotten; the row and its
 * rule set are deleted in one transaction.
 */
export async function createSessionWithMessage(
	host: RuntimeHost,
	owner: SessionUser,
	input: CreateSessionWithMessageInput,
): Promise<{ session: SessionView; created: boolean }> {
	const existing = await findSessionByCreateRequestId(host, owner.userId, input.requestId);
	if (existing) return { session: existing, created: false };

	let session: SessionView;
	try {
		session = await createSession(host, owner, {
			...(input.title === undefined ? {} : { title: input.title }),
			model: input.model,
			rulePreset: input.rulePreset,
			...(input.budgetRemaining === undefined ? {} : { budgetRemaining: input.budgetRemaining }),
			...(input.disabledExtensions === undefined ? {} : { disabledExtensions: input.disabledExtensions }),
			createRequestId: input.requestId,
		});
	} catch (err) {
		// A concurrent request with the same id won the unique index: return its session, not a second one.
		const raced = await findSessionByCreateRequestId(host, owner.userId, input.requestId).catch(() => undefined);
		if (raced) return { session: raced, created: false };
		throw err;
	}

	try {
		await submit(host, session.id, owner, input.message, submissionRequestIdFor(input.requestId), {
			...(input.content ? { content: input.content } : {}),
			...(input.attachments ? { attachments: input.attachments } : {}),
			...(input.lastUsedFrom === undefined ? {} : { lastUsedFrom: input.lastUsedFrom }),
		});
	} catch (err) {
		await removeCreatedSession(host, session.id).catch((cleanupError: unknown) => {
			console.error("agent runtime: removing a session whose first message failed failed:", cleanupError);
		});
		throw err;
	}
	return { session: (await getSession(host, session.id)) ?? session, created: true };
}

/** The session a user created with this request id, if one exists. */
export async function findSessionByCreateRequestId(
	host: RuntimeHost,
	ownerUserId: string,
	requestId: string,
): Promise<SessionView | undefined> {
	const row = await host.db
		.selectFrom("sessions")
		.select("id")
		.where("owner_user_id", "=", ownerUserId)
		.where("create_request_id", "=", requestId)
		.executeTakeFirst();
	return row ? getSession(host, row.id) : undefined;
}

/** The submission request id derived from the create one; the same create id always retries the same submit. */
function submissionRequestIdFor(createRequestId: string): string {
	return `create:${createRequestId}`;
}

/** What the client sent to fork a session at one of its final replies. */
export interface ForkSessionInput {
	/** The source's final assistant reply: a visible entry of the source conversation. */
	entryId: number;
	/** The client idempotency key: one request id creates one fork. */
	requestId: string;
}

/** A user's request to fork a session (doc/design/agent-runtime.md "Forking"). */
export async function forkSession(
	host: RuntimeHost,
	owner: SessionUser,
	sourceId: string,
	input: ForkSessionInput,
): Promise<{ session: SessionView; created: boolean }> {
	const requestId = input.requestId.trim();
	if (requestId === "" || requestId.length > 128) {
		throw new UserError("requestId is required and must be at most 128 characters");
	}
	const existing = await findSessionByCreateRequestId(host, owner.userId, requestId);
	if (existing) return { session: existing, created: false };

	const { row: source, conversation } = await loadConversation(host, sourceId);
	// The route checks ownership; the runtime checks again so an internal caller cannot fork someone else's session.
	if (source.owner_user_id !== owner.userId) throw new UserError("only the session owner can fork it");
	await assertForkableReply(host, conversation, source, input.entryId);

	// The fork copies the source's current agent configuration, not the state at the fork entry: a model,
	// thinking level or extension change the owner made after the reply still applies to the new session.
	const model = host.models.resolveRef(JSON.parse(source.model) as ModelRef);
	const sourceAgent = await conversation.agent(host.context);
	const sourceExtensions = sourceAgent.extensions.flatMap((extension) =>
		extension.name.startsWith("ext:") ? [extension.name.slice("ext:".length)] : [],
	);
	const availableExtensions = await extensionNamesForUser(host.db, owner.userId);
	const enabledExtensions = availableExtensions.filter((name) => sourceExtensions.includes(name));
	// The row lists every available extension the fork has off, so a root shows the same toggles as the source.
	const disabledExtensions = availableExtensions.filter((name) => !enabledExtensions.includes(name));
	// `null` clears a copied instruction: the fork keeps the source's *current* instructions, not the ones its
	// agent document had at the fork entry, which durable copies as of that entry.
	const instructions = sourceAgent.instructions ?? null;
	const id = newId();
	const locale = (await getUserSettings(host.db, owner.userId)).locale;
	const title = forkedSessionTitle(source.title, locale);
	const now = new Date().toISOString();

	// pi-durable forks the history by reference: the new conversation inherits the source's entries up to and
	// including the reply, copies the agent document as of that entry, and starts a fresh provider document
	// (`pi.provider` has fork: "initial"). The `agent` options below replace that copied configuration with the
	// source's current one.
	const forked = await conversation.fork(
		input.entryId as unknown as EntryId,
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: { provider: model.provider, modelId: model.modelId },
				thinkingLevel: thinkingLevelOf(model),
				extensions: host.extensionsFor(enabledExtensions),
				instructions,
			},
		},
		host.context,
	);

	try {
		const orgId = await defaultOrgId(host.db);
		await host.db.transaction().execute(async (trx) => {
			await trx
				.insertInto("sessions")
				.values({
					id,
					org_id: orgId,
					owner_user_id: source.owner_user_id,
					conversation_id: String(forked.id),
					// A fork is a new root, never a subagent of its source, and no chat thread or schedule owns it.
					parent_session_id: null,
					forked_from_session_id: sourceId,
					forked_from_entry_id: input.entryId,
					root_session_id: id,
					schedule_id: null,
					title,
					// The title is settled when the row is written; the fork never generates one.
					title_pending: 0,
					create_request_id: requestId,
					model: JSON.stringify(model),
					status: "active",
					created_at: now,
					updated_at: now,
					archived_at: null,
					last_submission_id: null,
					disabled_extensions: disabledExtensions.length === 0 ? null : JSON.stringify(disabledExtensions),
					// A fork starts idle with no waits, quota, unread marker or usage of its own.
					state: "idle",
					waiting_kind: null,
					waiting_level_id: null,
					waiting_handler_id: null,
					state_changed_at: now,
					reply_at: null,
					owner_read_at: null,
					last_used_from: null,
					quota_tokens: null,
					budget_used_tokens: 0,
					usage_tokens: 0,
					context_tokens: null,
					stat_turns: 0,
					stat_steps: 0,
					stat_ttft_ms: 0,
					stat_ttft_steps: 0,
					stat_decode_ms: 0,
					stat_decode_tokens: 0,
					counted_submission_id: null,
					prompt_tokens: 0,
					cache_read_tokens: 0,
				})
				.execute();
			// The source root's rule set is copied, never shared: a later edit to either side leaves the other
			// alone. A fork is a new root, so it starts from the chain root's preset and custom rules
			// (doc/design/access-control.md "Rule chain"). A scheduled run's root is an ordinary session too.
			const rootId = (await sessionChain(trx, sourceId)).at(-1);
			const copiedRules = rootId === undefined ? undefined : await getRuleSet(trx, { type: "session", id: rootId });
			if (copiedRules?.rulePreset == null) throw new UserError("the source session has no rule set to copy");
			await createRootRuleSet(trx, orgId, { type: "session", id }, copiedRules.rulePreset, copiedRules.rules);
		});
	} catch (err) {
		// The row did not commit: nothing owns the conversation, so stop it rather than leave it running.
		await forked.abort(host.context).catch((abortError: unknown) => {
			if (!host.closing()) console.error("agent runtime: aborting an unowned forked conversation failed:", abortError);
		});
		// A concurrent fork with the same request id won the unique index: return its session, not a second one.
		const raced = await findSessionByCreateRequestId(host, owner.userId, requestId).catch(() => undefined);
		if (raced) return { session: raced, created: false };
		throw err;
	}
	void host.audit?.record({
		actor: userActor(owner),
		action: "session.forked",
		target: { type: "session", id },
		detail: { source_session_id: sourceId, entry_id: input.entryId, session_id: id },
	});
	host.sessionList.publishSession(id);
	return { session: (await getSession(host, id)) as SessionView, created: true };
}

/** Whether the entry is a final assistant reply: one completed assistant message, no tool call, and answer text. */
function isFinalReplyEntry(entry: PiEntryRecord): boolean {
	if (entry.kind !== "pi.assistant" || entry.model?.length !== 1) return false;
	const message = entry.model[0];
	if (message?.role !== "assistant") return false;
	// A failed or interrupted message is not a final answer (doc/design/webui.md "Message view"); neither is an
	// intermediate message that announced a tool call, or one that has not finished yet.
	const stop = message.stopReason;
	if (stop === "toolUse" || stop === "error" || stop === "aborted" || stop === "pending" || stop === "deferred") {
		return false;
	}
	if (message.content.some((block) => block.type === "toolCall")) return false;
	return message.content.some((block) => block.type === "text" && block.text.trim() !== "");
}

/** Whether the entry starts a user turn; a compaction summary is a user message but not a turn start. */
function isUserTurnEntry(entry: PiEntryRecord): boolean {
	return entry.kind !== "pi.compaction" && entry.model?.[0]?.role === "user";
}

/**
 * Validates that `entryId` is the final reply of an ended turn of this conversation (fork-aware history). The
 * checks mirror the WebUI's final-answer rule (doc/design/webui.md "Message view"): an assistant message that
 * ended without tool calls, as the last non-compaction entry before the next user turn, and either a later user
 * turn exists or the session is idle. A compaction committed after the reply does not end its turn.
 */
async function assertForkableReply(
	host: RuntimeHost,
	conversation: Conversation,
	source: SessionRow,
	entryId: number,
): Promise<void> {
	if (!Number.isSafeInteger(entryId) || entryId < 0) throw new UserError("entryId must be an entry id");
	const page = await conversation.entries(
		{
			order: "ascending",
			minEntryId: entryId as unknown as EntryId,
			maxEntryId: entryId as unknown as EntryId,
		},
		1,
		undefined,
		host.context,
	);
	const entry = page.items[0];
	// The id may name an entry of another conversation, or no entry at all: neither is visible here.
	if (!entry) throw new UserError("no such entry in this session");
	if (!isFinalReplyEntry(entry)) throw new UserError("the entry is not a final assistant reply");

	let cursor: Cursor | undefined;
	let endedByUserTurn = false;
	for (;;) {
		const next = await conversation.entries(
			{ order: "ascending", minEntryId: (entryId + 1) as unknown as EntryId },
			200,
			cursor,
			host.context,
		);
		for (const later of next.items) {
			if (isUserTurnEntry(later)) {
				endedByUserTurn = true;
				break;
			}
			// Anything but a compaction after the reply means the reply is not the last item of its turn.
			if (later.kind !== "pi.compaction") {
				throw new UserError("the entry is not the last item of its turn");
			}
		}
		if (endedByUserTurn || !next.next) break;
		cursor = next.next;
	}
	if (!endedByUserTurn && source.state !== "idle") throw new UserError("the turn has not ended yet");
}

/**
 * Drops this process's caches of a session that no longer exists (a creation that failed, or any later
 * removal): the conversation mapping, the provider session ids learned from it, the subagent marker, its
 * request inbox and the waits and wakes held for it. Each is a lookup for work that can still arrive, so
 * none of them may outlive the row it describes. Durable keeps the conversation's records.
 */
export function forgetSessionCaches(host: RuntimeHost, sessionId: string, conversationId?: string): void {
	// Clear the timing before the cache mapping is forgotten: the map is keyed by the provider session id.
	clearTimings(host, [sessionId]);
	host.sessionCaches.forgetSession(sessionId, conversationId);
	host.inboxes.forget(sessionId);
	host.wakes.forget(sessionId);
	host.sessionFlags.endTitle(sessionId);
	host.quotaWaits.forget(sessionId);
}

/**
 * Removes a session whose creation did not finish. Durable has no conversation deletion, so the conversation is
 * aborted (a submission admitted just before the failure must not keep running without its session) and then
 * forgotten by this process; its records stay in durable storage. The rule set is deleted before the row in one
 * transaction, and the list stream is told about the removal before the row goes away.
 */
async function removeCreatedSession(host: RuntimeHost, sessionId: string): Promise<void> {
	const row = await host.db
		.selectFrom("sessions")
		.select("conversation_id")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	const conversationId = row?.conversation_id;
	if (conversationId !== undefined) {
		const conversation = await conversationOf(host, { conversation_id: conversationId });
		if (conversation) {
			try {
				await conversation.abort(host.context);
			} catch (err) {
				if (!host.closing()) console.error("agent runtime: aborting a failed session's conversation failed:", err);
			}
		}
	}
	forgetSessionCaches(host, sessionId, conversationId);
	await host.sessionList.publishSessionRemoved(sessionId);
	await host.db.transaction().execute(async (trx) => {
		await deleteRuleSet(trx, { type: "session", id: sessionId });
		await trx.deleteFrom("sessions").where("id", "=", sessionId).execute();
	});
}

/**
 * Creates the session a schedule run submits to (doc/design/scheduling.md): an ordinary root session with a fixed id
 * derived from the run, `schedule_id` recording which schedule it belongs to, `token_budget` as its root quota,
 * and its own root rule set copied from the schedule's preset and custom rules. The schedule is never part of a
 * rule chain. A retried call finds the session its first attempt created; when two concurrent calls build the
 * same derived id, the losing call aborts the conversation it opened and returns the winner's session.
 */
export async function createScheduledSession(
	host: RuntimeHost,
	owner: SessionUser,
	input: {
		id: string;
		title: string;
		model: ModelRef;
		budgetRemaining: number | null;
		scheduleId: string;
		rulePreset: RulePreset;
		rules?: Rule[];
	},
): Promise<SessionView> {
	const existing = await getSession(host, input.id);
	if (existing) return existing;
	const model = host.models.resolveRef(input.model);
	const extensionNames = await extensionNamesForUser(host.db, owner.userId);
	const conversation = await host.harness().createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: { provider: model.provider, modelId: model.modelId },
				thinkingLevel: thinkingLevelOf(model),
				extensions: host.extensionsFor(extensionNames),
			},
		},
		host.context,
	);
	const now = new Date().toISOString();
	try {
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
					// A scheduled run's title is its schedule's name; it never generates one.
					title_pending: 0,
					model: JSON.stringify(model),
					status: "active",
					created_at: now,
					updated_at: now,
					archived_at: null,
					// The budget is the new session's root remaining; null means unlimited.
					quota_tokens: input.budgetRemaining,
					state: "idle",
					waiting_kind: null,
					waiting_level_id: null,
					waiting_handler_id: null,
					state_changed_at: now,
				})
				.execute();
			// The run gets its own root rule set, copied from the schedule as it is now: the schedule is a template,
			// never a level of this session's chain (doc/design/scheduling.md "Rules and quotas").
			await createRootRuleSet(trx, orgId, { type: "session", id: input.id }, input.rulePreset, input.rules ?? []);
		});
	} catch (err) {
		// The row did not commit: no session owns this conversation, so stop it rather than leave it running
		// unattached. A unique conflict on the derived id means a concurrent call inserted it first; return that
		// session instead of failing the retry.
		await conversation.abort(host.context).catch((abortError: unknown) => {
			if (!host.closing()) console.error("agent runtime: aborting an unowned conversation failed:", abortError);
		});
		if (isUniqueViolation(err)) {
			const winner = await getSession(host, input.id);
			if (winner) return winner;
		}
		throw err;
	}
	void host.audit?.record({
		actor: { type: "schedule", id: input.scheduleId, onBehalfOfUserId: owner.userId },
		action: "session.created",
		target: { type: "session", id: input.id },
		detail: { model, rule_preset: input.rulePreset, schedule_id: input.scheduleId },
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
		// The API resolves the source title and whether the caller may see it (doc/design/agent-runtime.md "Forking").
		forkedFrom:
			row.forked_from_session_id === null || row.forked_from_entry_id === null
				? null
				: { sessionId: row.forked_from_session_id, entryId: Number(row.forked_from_entry_id) },
		scheduleId: row.schedule_id,
		model: modelRefView(JSON.parse(row.model) as ModelRef),
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		rules,
		refs: rules ? await ruleRefs(host.db, row.org_id, rules.rules) : {},
		state: row.state,
		waitingKind: row.waiting_kind,
		waitingLevelId: row.waiting_level_id,
		budgetRemaining: row.quota_tokens === null ? null : Number(row.quota_tokens),
		// The row already carries the token counters `sessionTokens` would read, so `getSession` costs no extra query.
		budgetUsedTokens: Number(row.budget_used_tokens),
		usageTokens: Number(row.usage_tokens),
		contextTokens: row.context_tokens === null ? null : Number(row.context_tokens),
		// The session's own generation statistics (doc/design/agent-runtime.md "Session statistics"); prompt/cache are tree totals.
		stats: {
			turns: Number(row.stat_turns),
			steps: Number(row.stat_steps),
			ttftMs: Number(row.stat_ttft_ms),
			ttftSteps: Number(row.stat_ttft_steps),
			decodeMs: Number(row.stat_decode_ms),
			decodeTokens: Number(row.stat_decode_tokens),
			promptTokens: Number(row.prompt_tokens),
			cacheReadTokens: Number(row.cache_read_tokens),
		},
		extensions: await sessionExtensionViews(
			host.options,
			row.owner_user_id,
			parseDisabledExtensionNames(row.disabled_extensions),
		),
	};
}

export async function configure(
	host: RuntimeHost,
	sessionId: string,
	change: {
		title?: string;
		model?: ModelRef;
		rulePreset?: RulePreset;
		budgetRemaining?: number | null;
		disabledExtensions?: string[];
	},
): Promise<SessionView> {
	const { row, conversation } = await loadConversation(host, sessionId);
	// Only a chain root has a rule preset; a subagent's rules come from its parent (doc/design/access-control.md "Authorization rules").
	if (change.rulePreset !== undefined && row.parent_session_id !== null)
		throw new UserError("a subagent's rule preset is set by its parent");
	let disabledExtensions: string[] | undefined;
	if (change.disabledExtensions !== undefined) {
		const available = await extensionNamesForUser(host.db, row.owner_user_id);
		disabledExtensions = [...new Set(change.disabledExtensions)];
		for (const name of disabledExtensions) {
			if (!available.includes(name))
				throw new UserError(`no extension named ${name} is available to the session's owner`);
		}
		if (row.parent_session_id !== null) {
			// A subagent inherits its parent's set and can only turn more off (doc/design/extensions.md "Extensions").
			const parent = await host.db
				.selectFrom("sessions")
				.select("disabled_extensions")
				.where("id", "=", row.parent_session_id)
				.executeTakeFirst();
			for (const name of parseDisabledExtensionNames(parent?.disabled_extensions ?? null)) {
				if (!disabledExtensions.includes(name))
					throw new UserError(`the extension ${name} is turned off in the parent session`);
			}
		}
	}
	let model: ModelRef | undefined;
	if (change.model) {
		// A model change without a level keeps the session's level, clamped to the new model.
		const stored = JSON.parse(row.model) as ModelRef;
		model = host.models.resolveRef(change.model, thinkingLevelOf(stored));
	}
	const previousPreset =
		change.rulePreset === undefined
			? undefined
			: (await getRuleSet(host.db, { type: "session", id: sessionId }))?.rulePreset;
	const ref = { type: "session" as const, id: sessionId };
	const restoreRow = {
		...(change.title === undefined ? {} : { title: row.title, title_pending: row.title_pending }),
		...(model ? { model: row.model } : {}),
		...(change.budgetRemaining === undefined ? {} : { quota_tokens: row.quota_tokens }),
		...(disabledExtensions === undefined ? {} : { disabled_extensions: row.disabled_extensions }),
		updated_at: row.updated_at,
	};
	// All SQL writes go in one transaction. The session's conversation lives in pi-durable's storage on another
	// connection to the same SQLite file: that connection would wait for this transaction's write lock, which
	// cannot commit until the conversation call returns (doc/design/data-model.md), so the conversation is configured
	// after the commit and a failure there restores the SQL side with a compensating write.
	await host.db.transaction().execute(async (trx) => {
		// Setting the remaining budget replaces it at any level, the root included; null removes the limit.
		if (change.budgetRemaining !== undefined) await setQuota(trx, sessionId, change.budgetRemaining);
		await trx
			.updateTable("sessions")
			.set({
				// Any manual title ends generation, a blank one included: null shows the default name and stays.
				...(change.title === undefined ? {} : { title: change.title.trim() || null, title_pending: 0 }),
				...(model ? { model: JSON.stringify(model) } : {}),
				...(disabledExtensions === undefined
					? {}
					: { disabled_extensions: disabledExtensions.length === 0 ? null : JSON.stringify(disabledExtensions) }),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", sessionId)
			.execute();
		if (change.rulePreset !== undefined) await setRulePreset(trx, ref, change.rulePreset);
	});
	if (model) {
		try {
			await conversation.configure(
				{
					model: { provider: model.provider, modelId: model.modelId },
					thinkingLevel: thinkingLevelOf(model),
				},
				host.context,
			);
		} catch (err) {
			// The row now names a model the conversation did not take: put the previous values back, in one
			// transaction, so a reader never sees a configuration the conversation does not have.
			try {
				await host.db.transaction().execute(async (trx) => {
					await trx.updateTable("sessions").set(restoreRow).where("id", "=", sessionId).execute();
					if (previousPreset) await setRulePreset(trx, ref, previousPreset);
				});
			} catch (restoreError) {
				console.error("agent runtime: restoring a session after a failed model change failed:", restoreError);
			}
			throw err;
		}
	}
	if (disabledExtensions !== undefined) {
		// The conversation's selected extensions follow the toggle; an MCP extension's tools appear once it is connected.
		const names = await extensionNamesForUser(host.db, row.owner_user_id, disabledExtensions);
		await conversation.configure({ extensions: host.extensionsFor(names) }, host.context);
	}
	if (change.budgetRemaining !== undefined) {
		host.quotaWaits.wakeAll();
		host.inboxes.clear();
		// A wait on this level (or on a root above it) may be over now.
		await refreshState(host, sessionId);
	}
	host.sessionList.publishSession(sessionId);
	return (await getSession(host, sessionId)) as SessionView;
}

/** Where a stop came from, recorded as `session.stop`'s source (doc/design/access-control.md "Recorded events"). */
export type SessionStopSource = "web" | "channel_command" | "channel_draft_stop" | "internal";

export interface SessionStopOptions {
	source?: SessionStopSource;
	/** The channel and chat account/thread the stop came from, when it came from a chat. */
	channel?: string;
	platform?: string;
	accountId?: string;
	threadId?: string;
}

/** Stops the current run: queued inputs are withdrawn and running tool calls aborted. */
export async function abort(
	host: RuntimeHost,
	sessionId: string,
	by?: SessionUser,
	stop: SessionStopOptions = {},
): Promise<void> {
	const { conversation } = await loadConversation(host, sessionId);
	const sessions = [sessionId, ...(await sessionDescendants(host.db, sessionId))];
	// A stopped message produces no timing; its attempt must not be read by a later run.
	clearTimings(host, sessions);
	for (const id of sessions) host.sessionFlags.beginStop(id);
	try {
		await conversation.abort(host.context);
		// Subagents are ownerless conversations: their abort is explicit, and it must come before the work is
		// ended. A subagent that is still running can otherwise dispatch a task after the select below, which
		// nothing would cancel (doc/design/agent-runtime.md "Subagents").
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
		for (const id of sessions) host.quotaWaits.clearDenied(id);
		// Clear a quota wait of an ancestor that only the aborted subtree caused.
		const root = (await sessionChain(host.db, sessionId)).at(-1);
		if (root) await refreshState(host, root);
		host.quotaWaits.wakeAll();
		host.inboxes.clear();
		for (const id of sessions) host.wakes.dropAll(id);
		// One event for every stop path: the WebUI, /stop, a stopped progress draft and internal stops alike.
		void host.audit?.record({
			actor: by ? userActor(by) : { type: "system", id: "system" },
			action: "session.stop",
			target: { type: "session", id: sessionId },
			detail: {
				source: stop.source ?? "internal",
				...(stop.channel ? { channel: stop.channel } : {}),
				...(stop.platform ? { via: stop.platform } : {}),
				...(stop.accountId ? { channel_account: stop.accountId } : {}),
				...(stop.threadId ? { thread_id: stop.threadId } : {}),
				...(sessions.length > 1 ? { subagents: sessions.slice(1) } : {}),
			},
		});
	} finally {
		for (const id of sessions) host.sessionFlags.endStop(id);
		// A stream event may have landed after the first clear; nothing will read it for this stopped run.
		clearTimings(host, sessions);
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
	stream.start(async (events) => {
		// The system prompt and tool schemas come as system messages: large, and nothing a chat UI shows. The
		// snapshot path filters them out; the live path must not reintroduce them through message_end.
		const converted = events
			.filter(isShownEvent)
			.map(toSessionEvent)
			.filter((event): event is SessionEvent => event !== null);
		if (converted.length > 0) await onEvents(converted);
	});
	return () => stream.stop();
}

/**
 * The first event of a watch, cut down to what the WebUI renders: the newest `SNAPSHOT_ENTRIES` shown entries
 * (system messages are not shown) and a `historyCursor` for `GET /sessions/:id/entries` when older records
 * exist (doc/design/webui.md "Session event stream and history"). The cursor points just before the oldest returned entry, so the
 * snapshot and the pages that follow it never overlap or skip.
 */
async function snapshotEvent(
	host: RuntimeHost,
	conversation: Conversation,
	snapshot: PiSnapshotEvent,
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
	return toSnapshotEvent(snapshot, kept, historyCursor);
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
): Promise<SessionEntriesPage> {
	const { conversation } = await loadConversation(host, sessionId);
	const wanted = limit + 1;
	const collected: PiEntryRecord[] = [];
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
		entries: pageEntries.reverse().map(toEntryRecord),
		historyCursor: collected.length > limit && oldest ? encodeCursor([], Number(oldest.id)) : null,
	};
}

/**
 * The newest visible entry id of a conversation; one indexed read. The image hook compares it with the id
 * its in-memory derivation covered, so new entries invalidate the cache (doc/design/library.md "view_image").
 */
export async function latestEntryId(host: RuntimeHost, conversationId: string): Promise<number | undefined> {
	const conversation = await conversationOf(host, { conversation_id: conversationId });
	if (!conversation) return undefined;
	const page = await conversation.entries({ order: "descending" }, 1, undefined, host.context);
	const newest = page.items[0];
	return newest === undefined ? undefined : Number(newest.id);
}

/** A conversation's visible entries, oldest first, including the system entries the chat does not show. */
export async function transcriptEntries(host: RuntimeHost, conversationId: string): Promise<PiEntryRecord[]> {
	const conversation = await conversationOf(host, { conversation_id: conversationId });
	if (!conversation) return [];
	const entries: PiEntryRecord[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, 200, cursor, host.context);
		entries.push(...page.items);
		if (!page.next) return entries;
		cursor = page.next;
	}
}

/** The reviewer's ordered history of a session: user instructions, the latest checkpoint and tool calls only. */
export async function reviewHistory(host: RuntimeHost, sessionId: string): Promise<ReviewHistoryEntry[]> {
	const row = await host.db
		.selectFrom("sessions")
		.select("conversation_id")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return [];
	return reviewHistoryEntries(await transcriptEntries(host, row.conversation_id));
}

/** The session transcript's tool calls, pending ones included, for the reviewer's operation block. */
export async function reviewToolCalls(host: RuntimeHost, sessionId: string): Promise<ReviewToolCallRecord[]> {
	const row = await host.db
		.selectFrom("sessions")
		.select("conversation_id")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return [];
	return reviewToolCallsOf(await transcriptEntries(host, row.conversation_id));
}

/** One message of a chat's history replay (doc/design/channels.md "Conversations"). */
export interface ChatHistoryMessage {
	role: "user" | "assistant";
	text: string;
}

/**
 * The last messages a chat shows when it switches to a session: user messages and each turn's final answer, without
 * intermediate text, tool calls, thinking or attachments. A final answer is an assistant message with text and no
 * tool call; a message that streams text before its tool call therefore does not count. `limit` counts messages.
 */
export async function chatHistory(host: RuntimeHost, sessionId: string, limit = 10): Promise<ChatHistoryMessage[]> {
	const row = await loadSession(host, sessionId);
	const entries = await transcriptEntries(host, row.conversation_id);
	const messages: ChatHistoryMessage[] = [];
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		if (entry.kind === "pi.user" || entry.kind === "crh.user_input") {
			const text = userText(message);
			if (text !== null) messages.push({ role: "user", text });
			continue;
		}
		if (entry.kind === "pi.assistant") {
			const text = assistantFinalText(message);
			if (text !== null) messages.push({ role: "assistant", text });
		}
	}
	return messages.slice(-limit);
}

/** The typed text of a user message; an attachment's note is not part of it. */
function userText(message: { readonly role?: string; readonly content?: unknown }): string | null {
	if (message.role !== "user") return null;
	const content = message.content;
	if (typeof content === "string") return content.trim() === "" ? null : content;
	if (!Array.isArray(content)) return null;
	const first = content.find(
		(block): block is { type: "text"; text: string } =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string",
	);
	return first === undefined || first.text.trim() === "" ? null : first.text;
}

/** A final answer's text: text blocks when the message has no tool call and no error. */
function assistantFinalText(message: {
	readonly role?: string;
	readonly content?: unknown;
	readonly stopReason?: string;
	readonly errorMessage?: string;
}): string | null {
	if (message.role !== "assistant" || message.errorMessage !== undefined) return null;
	if (!Array.isArray(message.content)) return null;
	const hasToolCall = message.content.some(
		(block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall",
	);
	if (hasToolCall) return null;
	const text = message.content
		.flatMap((block) => {
			if (typeof block !== "object" || block === null) return [];
			const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
			if (typed.type === "thinking") return [];
			return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
		})
		.join("");
	return text.trim() === "" ? null : text;
}

/** The session a conversation belongs to, for tool calls that only know their conversation id. */
export async function sessionAt(host: RuntimeHost, conversationId: string): Promise<SessionInfo | undefined> {
	const cached = host.sessionCaches.sessionFor(conversationId);
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
	host.sessionCaches.rememberSession(conversationId, session);
	return session;
}

/** Whether the session's tools need to look for subagent requests; cached after the first check. */
export async function hasSubagents(host: RuntimeHost, sessionId: string): Promise<boolean> {
	if (host.sessionCaches.hasSubagentParent(sessionId)) return true;
	const row = await host.db
		.selectFrom("sessions")
		.select("id")
		.where("parent_session_id", "=", sessionId)
		.limit(1)
		.executeTakeFirst();
	if (row) host.sessionCaches.rememberSubagentParent(sessionId);
	return row !== undefined;
}
