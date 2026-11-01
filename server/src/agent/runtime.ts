import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	AssistantEntry,
	type CompactionSettings,
	CompactionTask,
	type Conversation,
	type ConversationId,
	type Cursor,
	createRegistry,
	defineDocFamily,
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	GenerationTask,
	Harness,
	hook,
	ProviderDoc,
	SessionFailed,
	type SettledSubmissionRecord,
	type Storage,
	type Submission,
	type SubmissionId,
	section,
	type ToolRegistration,
	ToolTask,
	watchEvents,
} from "@earendil-works/pi-durable";
import { sql } from "kysely";
import { Type } from "typebox";
import * as z from "zod/v4";
import { encodeCursor } from "../api/cursor.ts";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import { type Actor, type ApprovalRecord, type Cluster, summarize } from "../cluster/cluster.ts";
import type { GroupApprovalRecord, TaskGroups } from "../cluster/task-groups.ts";
import type { Preset, RuleSet } from "../policy/rules.ts";
import { parseRuleSet } from "../policy/rules.ts";
import {
	createRootRuleSet,
	createRuleSet,
	getRuleSet,
	type RuleRef,
	type StoredRuleSet,
	setPreset,
} from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { TOOLS, type ToolContext } from "../tools/catalog.ts";
import { defaultOrgId, NotFoundError, UserError } from "../users/service.ts";
import { derivedId, newId } from "../util/id.ts";
import { meteredModels } from "./metering.ts";
import type { ModelConfig, ModelRef } from "./models.ts";
import {
	type AccountedMessage,
	accountedOutputTokens,
	awaitingQuotaChildren,
	awaitingQuotaSessions,
	exhaustedLevel,
	grantQuota,
	parseQuota,
	recordUsage,
	sessionChain,
	setQuota,
	spentTokens,
} from "./quota.ts";
import { Reviewer } from "./review.ts";
import { SessionListHub } from "./session-list.ts";
import {
	markSessionsIdle,
	nonIdleSessions,
	type SessionState,
	type SessionWait,
	sessionsWithSubmissions,
	setSessionState,
	type WaitingKind,
} from "./session-state.ts";
import { sharedSessionAccess } from "./sharing.ts";

/**
 * The agent runtime behind our own interface (doc/agent-runtime.md#agentruntime-抽象): pi-durable types do not
 * leave this module. One Harness over one Storage holds every session as a conversation.
 */

/**
 * Durable link from a subagent tool call (the key is its tool task id) to the ownerless conversation it created.
 * The conversation and the link are committed together, so a rerun after a crash reuses the conversation instead
 * of starting another one.
 */
const SubagentConversationLink = defineDocFamily<{ conversationId: string | null }, null>({
	kind: "crh.subagent_conversation",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ conversationId: null }),
	checkpointWhen: () => true,
});

export interface SessionView {
	id: string;
	title: string;
	ownerUserId: string;
	parentSessionId: string | null;
	/** The schedule whose run created this session; null for every other session (doc/scheduling.md). */
	scheduleId: string | null;
	model: ModelRef;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	rules: StoredRuleSet | null;
	/** The session's own run state (doc/agent-runtime.md#会话状态). */
	state: SessionState;
	/** Why the session waits; null unless `state` is `awaiting`. */
	waitingKind: WaitingKind | null;
	/** While awaiting a quota: the exhausted level to top up. */
	waitingLevelId: string | null;
	/** Remaining token quota; null: unlimited. Signed: a response may overspend it. */
	quota: number | null;
	/** Tokens spent by this session and its subagents. */
	spentTokens: number;
}

/** An approval handed to an ancestor session's agent (doc/agent-runtime.md#处理子会话的请求). */
export interface AgentRequestView {
	kind: "task" | "group" | "quota";
	id: string;
	/** The subagent session whose task waits. */
	sessionId: string;
	summary: string;
	nodeId: string | null;
	createdAt: string;
}

/** Requests waiting for one handler's agent, loaded from the database and invalidated on approval changes. */
interface Inbox {
	requests: Map<string, AgentRequestView>;
	loaded: boolean;
	/** Resolved when the pending set may have changed; `waitSubagent` uses this instead of polling. */
	waiters: Set<() => void>;
}

function requestKey(request: AgentRequestView): string {
	return `${request.kind}:${request.id}`;
}

function isNewerSubmission(candidate: string, current: string | null): boolean {
	if (current === null) return true;
	try {
		return BigInt(candidate) > BigInt(current);
	} catch {
		return false;
	}
}

/** Request key behind a wake request id, for checking that the request is still pending before flushing. */
function wakeRequestKey(requestId: string): string | undefined {
	if (requestId.startsWith("agent-request:task:")) return `task:${requestId.slice("agent-request:task:".length)}`;
	if (requestId.startsWith("agent-request:group:")) return `group:${requestId.slice("agent-request:group:".length)}`;
	if (requestId.startsWith("quota-request:")) {
		const rest = requestId.slice("quota-request:".length);
		const end = rest.indexOf(":");
		if (end > 0) return `quota:${rest.slice(0, end)}`;
	}
	return undefined;
}

/** What a UI receives: a snapshot to start from, then batches of events (pi-durable's agent events, for now). */
export type SessionEvent = AgentEvent;

/** Entries a snapshot carries; older ones are paged through `GET /api/sessions/:id/entries`. */
const SNAPSHOT_ENTRIES = 100;

/** Sessions per `IN (...)` lookup at startup; SQLite caps bound parameters far below the session count. */
const RECONCILE_CHUNK = 500;

/** System messages (the prompt and tool schemas) are not shown in the chat; neither is the entry that holds them. */
function isShownEntry(entry: { readonly model?: readonly { readonly role?: string }[] }): boolean {
	return !(entry.model ?? []).some((message) => message.role === "system");
}

export interface AgentRuntimeOptions {
	db: Db;
	/**
	 * The durable storage, or a function that opens it. With a function, a Harness that fails (a storage error
	 * closes it, doc/agent-runtime.md#测试策略) is reopened on fresh storage, with backoff.
	 */
	storage: Storage | (() => Promise<Storage>);
	models: ModelConfig;
	cluster: Cluster;
	groups: TaskGroups;
	audit?: Audit;
	/**
	 * How long idle conversations keep their context and documents in memory (durable's default: 10 minutes).
	 * Memory grows with what was active within this window (doc/agent-runtime.md#2-性能和内存回归).
	 */
	retentionMs?: number;
	/** Set by clusterExtension; removed from a conversation that has reached the subagent depth limit. */
	subagentTool?: ToolRegistration;
	/**
	 * Compaction policy override; the pi defaults when omitted (doc/agent-runtime.md#默认值). Tests use it to
	 * make a compaction happen with a few messages.
	 */
	compaction?: CompactionSettings;
	/** How long session-list writes are coalesced before one SSE upsert; 150 ms by default. */
	sessionList?: { coalesceMs?: number };
}

const SYSTEM_PROMPT = `You are ClusterRightHand, an assistant that operates the user's servers ("nodes") through the cluster tools.

- Start with list_nodes or node_info when you do not know the nodes yet.
- Prefer reading (read_file, list_dir) before changing anything; explain what you are about to change.
- Commands and file changes may wait for the user's approval; a rejected task comes back with the user's reason. Respect it and do not try to get around it.
- exec cmd runs in the node's POSIX sh (sh -c); for bash syntax use argv ["bash", "-c", …] after checking node_info facts.shells.bash.
- exec returns the end of long outputs and, when truncated, the path of the full output on the node; read it with read_file when needed.
- A task can end "unknown": its outcome could not be confirmed. Check the node's state before retrying.
- Delegate self-contained work to subagent; settle a subagent's requests with subagent_decide, and fetch a background subagent's answer with subagent_wait.
- Be concise.`;

type Row = {
	id: string;
	owner_user_id: string;
	conversation_id: string;
	parent_session_id: string | null;
	schedule_id: string | null;
	title: string;
	model: string;
	status: "active" | "archived";
	created_at: string;
	updated_at: string;
	last_submission_id: string | null;
	quota_tokens: string | number | null;
	state: SessionState;
	waiting_kind: WaitingKind | null;
	waiting_level_id: string | null;
	waiting_handler_id: string | null;
	state_changed_at: string | null;
};

export class AgentRuntime {
	readonly #db: Db;
	#harness: Harness;
	readonly #options: AgentRuntimeOptions;
	readonly #models: ModelConfig;
	readonly #audit: Audit | undefined;
	readonly #cluster: Cluster;
	readonly #groups: TaskGroups;
	readonly #context: Context = BACKGROUND_CONTEXT;
	#closing = false;
	/** Times the Harness was reopened after a failure (tests, diagnostics). */
	reopened = 0;
	/** The instance the tools call back into; set once the Harness is open. */
	#runtimeRef: { current?: AgentRuntime } = {};
	/** conversation id -> session, for the tools' per-call lookups (the mapping never changes). */
	#sessionsByConversation = new Map<
		string,
		{ id: string; ownerUserId: string; orgId: string; parentSessionId: string | null }
	>();
	/** Sessions known to have subagents; checked once per session, then cheap. */
	#subagentParents = new Set<string>();
	/** Pending requests by handler, a cache over tasks/task_groups/quota waits. */
	#inboxes = new Map<string, Inbox>();
	/** Waiters for a quota wait's session; grant/deny/abort/quota edit wakes them. */
	#quotaWaiters = new Map<string, Set<() => void>>();
	/** Provider session id -> session, so a compaction's summarization is charged to its conversation (D92). */
	#providerSessions = new Map<string, string>();
	/** Conversations whose provider document was already read. */
	#learnedProviders = new Set<string>();
	/** Sessions whose paused call was denied but whose tool has not ended yet: their wait must not be re-created. */
	#deniedWaits = new Set<string>();
	/** Follow-up inputs held while the handler runs; flushed once it is idle. */
	#pendingWakes = new Map<string, Map<string, string>>();
	/** Handlers with a `waitForIdle` observer attached. */
	#idleWatchers = new Set<string>();
	/** Sessions being stopped: their run ends during the stop, and the stop, not the run end, ends their waits. */
	#stopping = new Set<string>();
	/** Open WebUI session-list streams; writes publish here, coalesced per session. */
	readonly #sessionList: SessionListHub;

	private constructor(harness: Harness, options: AgentRuntimeOptions) {
		this.#db = options.db;
		this.#harness = harness;
		this.#options = options;
		this.#models = options.models;
		this.#audit = options.audit;
		this.#cluster = options.cluster;
		this.#groups = options.groups;
		this.#sessionList = new SessionListHub({ db: options.db, ...(options.sessionList ?? {}) });
	}

	static async #openHarness(options: AgentRuntimeOptions, ref: { current?: AgentRuntime }): Promise<Harness> {
		const registry = createRegistry();
		registry.install(clusterExtension(options, ref));
		const storage = typeof options.storage === "function" ? await options.storage() : options.storage;
		const harness = await Harness.open(
			storage,
			{
				// Compaction's summarization is metered here; Auto Review charges itself (doc/agent-runtime.md#配额).
				models: meteredModels(options.models.models, async (providerSessionId, message) => {
					await ref.current?.chargeCompaction(providerSessionId, message);
				}),
				registry,
				identity: { attribution: { name: "ClusterRightHand", url: "https://github.com/Kodecable/ClusterRightHand" } },
				settings: {
					// pi's coding-agent defaults (doc/agent-runtime.md#默认值).
					compaction: { reserveTokens: 16384, keepRecentTokens: 20000, ...options.compaction },
					retry: { maxRetries: 3 },
					...(options.retentionMs !== undefined
						? { contextRetentionMs: options.retentionMs, documentRetentionMs: options.retentionMs }
						: {}),
				},
			},
			BACKGROUND_CONTEXT,
		);
		return harness;
	}

	static async open(options: AgentRuntimeOptions): Promise<AgentRuntime> {
		const ref: { current?: AgentRuntime } = {};
		const runtime = new AgentRuntime(await AgentRuntime.#openHarness(options, ref), options);
		runtime.#runtimeRef = ref;
		ref.current = runtime;
		// Resume only now: a resumed run must find the runtime (compaction and tool metering look it up).
		runtime.#harness.resume(); // runs and tool calls the last process left unfinished
		// Auto Review for roots whose preset asks for it (tokens, sessions and schedules alike), then route child
		// approvals to an ancestor's agent where the chain allows it.
		const reviewer = new Reviewer(options.db, options.models, options.cluster, options.groups);
		options.cluster.onAwaitingApproval = async (task) => {
			await reviewer.reviewTask(task);
			await runtime.#routeAwaiting("task", task.actorId, task.id, task.approval);
			await runtime.refreshState(task.actorId);
		};
		options.groups.onAwaitingApproval = async (group) => {
			await reviewer.reviewGroup(group);
			await runtime.#routeAwaiting("group", group.actorId, group.id, group.approval);
			await runtime.refreshState(group.actorId);
		};
		// The cluster owns the durable approval rows; refresh the actor's cached state and request lists.
		const approvalChanged = (actorId: string) => {
			runtime.#invalidateInboxes();
			void runtime.refreshState(actorId).catch((err: unknown) => {
				console.error("agent runtime: refreshing a subagent after an approval change failed:", err);
			});
		};
		options.cluster.onChange = approvalChanged;
		options.groups.onChange = approvalChanged;
		runtime.#supervise();
		// Durable has resumed the runs; correct every cached session state before requests are accepted.
		await runtime.#reconcileSessionStates();
		// Waits whose session's run is over (stopped or ended while crhs was down) can never be acted on.
		await runtime.#endOrphanWaits();
		// Sessions created before the per-conversation tool filter existed may still offer subagent at the limit.
		await runtime.#enforceDepthToolLimits();
		// A restart may have queued nothing for requests that were already waiting: wake idle parents now.
		await runtime.#wakePendingAgents();
		return runtime;
	}

	/** Reopens a Harness that failed; commits are atomic, so the store is consistent and work resumes. */
	#supervise(): void {
		void this.#harness.closed.then(async (end) => {
			if (end.reason !== "failed" || this.#closing || typeof this.#options.storage !== "function") return;
			console.error("agent runtime: the Harness failed, reopening:", end.error);
			for (let attempt = 0; !this.#closing; attempt++) {
				await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
				try {
					this.#harness = await AgentRuntime.#openHarness(this.#options, this.#runtimeRef);
					this.#harness.resume();
					this.#invalidateInboxes();
					this.reopened++;
				} catch (err) {
					console.error("agent runtime: reopening failed:", err);
					continue;
				}
				this.#supervise();
				// The failed Harness rejected every pending wait, so no settlement wrote `idle` and no watch is
				// armed any more. Correct the states and re-arm the watches exactly as open() does.
				try {
					await this.#reconcileSessionStates();
				} catch (err) {
					console.error("agent runtime: reconciling after a reopen failed:", err);
				}
				return;
			}
		});
	}

	/** Whether close() has begun: the Harness refuses every new operation from here on (shutdown, main.ts). */
	get closing(): boolean {
		return this.#closing;
	}

	/** The session list's event hub, for `GET /api/sessions` and `GET /api/sessions/stream`. */
	get sessionList(): SessionListHub {
		return this.#sessionList;
	}

	async close(): Promise<void> {
		this.#closing = true;
		await this.#harness.close(this.#context);
		this.#sessionList.close();
	}

	async createSession(
		owner: SessionUser,
		input: { title?: string; model: ModelRef; preset: Preset; instructions?: string; quota?: number | null },
	): Promise<SessionView> {
		this.#models.assertAvailable(input.model);
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: { provider: input.model.provider, modelId: input.model.modelId },
					...(input.model.thinkingLevel ? { thinkingLevel: input.model.thinkingLevel } : {}),
					...(input.instructions ? { instructions: input.instructions } : {}),
				},
			},
			this.#context,
		);
		const id = newId();
		const now = new Date().toISOString();
		const orgId = await defaultOrgId(this.#db);
		await this.#db.transaction().execute(async (trx) => {
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
		void this.#audit?.record({
			actor: { type: "user", id: owner.userId, onBehalfOfUserId: owner.userId },
			action: "session.created",
			target: { type: "session", id },
			detail: { model: input.model, preset: input.preset },
		});
		this.#sessionList.publishSession(id);
		return (await this.getSession(id)) as SessionView;
	}

	async getSession(id: string): Promise<SessionView | undefined> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
		return row ? this.#view(row) : undefined;
	}

	/**
	 * Creates the session a schedule run submits to (doc/scheduling.md): a root session with a fixed id derived
	 * from the run, `schedule_id` set and `token_budget` as its root quota. Its rule set is a lower level (no
	 * preset, `default: inherit`) under the schedule's root, so the chain is [schedule, session]. A retried call
	 * finds the session its first attempt created.
	 */
	async createScheduledSession(
		owner: SessionUser,
		input: { id: string; title: string; model: ModelRef; quota: number | null; scheduleId: string },
	): Promise<SessionView> {
		const existing = await this.getSession(input.id);
		if (existing) return existing;
		this.#models.assertAvailable(input.model);
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: { provider: input.model.provider, modelId: input.model.modelId },
					...(input.model.thinkingLevel ? { thinkingLevel: input.model.thinkingLevel } : {}),
				},
			},
			this.#context,
		);
		const now = new Date().toISOString();
		const orgId = await defaultOrgId(this.#db);
		await this.#db.transaction().execute(async (trx) => {
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
		void this.#audit?.record({
			actor: { type: "schedule", id: input.scheduleId, onBehalfOfUserId: owner.userId },
			action: "session.created",
			target: { type: "session", id: input.id },
			detail: { model: input.model, preset: null, schedule_id: input.scheduleId },
		});
		this.#sessionList.publishSession(input.id);
		return (await this.getSession(input.id)) as SessionView;
	}

	/** Root sessions the user owns or that are shared with them (administrators: everyone's), newest first. */
	async listSessions(user: SessionUser, filter: { scheduleId?: string } = {}): Promise<SessionView[]> {
		let q = this.#db
			.selectFrom("sessions")
			.selectAll()
			.where("parent_session_id", "is", null)
			.orderBy("created_at", "desc");
		if (filter.scheduleId !== undefined) q = q.where("schedule_id", "=", filter.scheduleId);
		if (user.kind !== "admin") {
			const shared = [...(await sharedSessionAccess(this.#db, user.userId)).keys()];
			q = q.where((eb) =>
				shared.length > 0
					? eb.or([eb("owner_user_id", "=", user.userId), eb("id", "in", shared)])
					: eb("owner_user_id", "=", user.userId),
			);
		}
		return Promise.all((await q.execute()).map((r) => this.#view(r)));
	}

	async #view(row: Row): Promise<SessionView> {
		const rules = (await getRuleSet(this.#db, { type: "session", id: row.id })) ?? null;
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
			spentTokens: await spentTokens(this.#db, row.id),
		};
	}

	async #conversation(sessionId: string) {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
		if (!row) throw new NotFoundError("no such session");
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) throw new NotFoundError("the session's conversation is missing");
		return { row, conversation };
	}

	/**
	 * Hands the user's message to the session; it runs at once or queues behind the current run. `requestId`
	 * makes a retried submit find the first one. `by` is who typed it (the owner, or a user the session is shared with).
	 */
	async submit(sessionId: string, by: SessionUser, text: string, requestId: string): Promise<string> {
		// A user driving a session shared with them still acts on behalf of its owner (doc/access-control.md).
		return this.#submitInput(sessionId, text, requestId, { type: "user", id: by.userId });
	}

	/**
	 * Submits a schedule run's fixed prompt (doc/scheduling.md#调度). The request id is derived from the
	 * schedule and the fire time, so a resubmitted run returns its first submission instead of sending twice;
	 * `checkQuota: false` is for that recovery path, where the run may have exhausted the quota by finishing.
	 */
	async submitAsSchedule(
		sessionId: string,
		scheduleId: string,
		text: string,
		requestId: string,
		options: { checkQuota?: boolean } = {},
	): Promise<string> {
		return this.#submitInput(
			sessionId,
			text,
			requestId,
			{ type: "schedule", id: scheduleId },
			options.checkQuota !== false,
		);
	}

	async #submitInput(
		sessionId: string,
		text: string,
		requestId: string,
		actor: { type: string; id: string },
		checkQuota = true,
	): Promise<string> {
		const { row, conversation } = await this.#conversation(sessionId);
		if (row.status !== "active") throw new UserError("the session is archived");
		if (checkQuota) {
			const over = await exhaustedLevel(this.#db, sessionId);
			if (over) {
				throw new UserError(
					over === sessionId
						? "the session's token quota is used up; raise it to continue"
						: "a parent session's token quota is used up",
				);
			}
		}
		const submission = await conversation.submit({ type: "input", content: text, requestId }, this.#context);
		await this.#recordInput(sessionId, submission);
		void this.#audit?.record({
			actor: { ...actor, onBehalfOfUserId: row.owner_user_id },
			action: "session.message",
			target: { type: "session", id: sessionId },
			detail: { submission_id: String(submission.id), chars: text.length },
		});
		return String(submission.id);
	}

	/**
	 * Records a new input and revives an idle session in one row update. A retried older submission is ignored,
	 * so it cannot roll `last_submission_id` back or revive a session that a newer input is driving. An input
	 * that queues behind a running one changes nothing: the session already runs or waits.
	 */
	async #recordInput(sessionId: string, submission: Submission): Promise<boolean> {
		const id = String(submission.id);
		for (let attempt = 0; attempt < 3; attempt++) {
			const row = await this.#db
				.selectFrom("sessions")
				.select("last_submission_id")
				.where("id", "=", sessionId)
				.executeTakeFirst();
			if (!row || !isNewerSubmission(id, row.last_submission_id)) return false;
			const at = new Date().toISOString();
			let update = this.#db
				.updateTable("sessions")
				.set({
					last_submission_id: id,
					updated_at: at,
					// Only a new input revives an idle session; a wait that is already there stays until it ends.
					state: sql`case when state = 'idle' then 'running' else state end`,
					state_changed_at: sql`case when state = 'idle' then ${at} else state_changed_at end`,
				})
				.where("id", "=", sessionId);
			update =
				row.last_submission_id === null
					? update.where("last_submission_id", "is", null)
					: update.where("last_submission_id", "=", row.last_submission_id);
			const res = await update.executeTakeFirst();
			if (res.numUpdatedRows === 0n) continue;
			this.#sessionList.publishSession(sessionId);
			// The list shows "last activity": a user message at submission, the assistant's at run end. Streaming
			// commits in between do not touch the row (doc/webui.md#会话列表).
			void submission
				.wait(this.#context)
				.then(async () => {
					await this.#settleInput(sessionId, id);
				})
				.catch((err: unknown) => {
					// A closed Harness rejects every pending wait; #supervise reopens and reconciles, and the
					// re-armed watch records the end then. Anything else must not vanish.
					if (this.#closing || err instanceof SessionFailed) return;
					if (err instanceof Error && err.message === "Harness is closed") return;
					console.error("agent runtime: recording a run's end failed:", err);
				});
			return true;
		}
		return false;
	}

	/**
	 * Reconciles old conversations with the depth limit; new children are handled in createSubagent. Only a
	 * session at the limit can be affected, so `depthLimitedSessions` walks up from the subagent rows and finds
	 * exactly those, instead of loading every session's parent at startup (doc/webui.md: 100,000 sessions).
	 */
	async #enforceDepthToolLimits(): Promise<void> {
		const limited = await depthLimitedSessions().execute(this.#db);
		for (const row of limited.rows) {
			const conversation = await this.#harness.conversation(
				Number(row.conversation_id) as unknown as ConversationId,
				this.#context,
			);
			if (!conversation) continue;
			const agent = await conversation.agent(this.#context);
			if (agent.tools.some((tool) => tool.name === "subagent")) await this.#hideSubagentTool(conversation);
		}
	}

	/** Keeps a conversation at the depth limit from offering the subagent tool to its model. */
	async #hideSubagentTool(conversation: Conversation): Promise<void> {
		const tool = this.#options.subagentTool;
		if (!tool) return;
		await conversation.configure({ tools: { remove: [tool] } }, this.#context);
	}

	/** The tool names offered to a session's model (diagnostics and tests). */
	async toolNames(sessionId: string): Promise<string[]> {
		const { conversation } = await this.#conversation(sessionId);
		const agent = await conversation.agent(this.#context);
		return agent.tools.map((tool) => tool.name);
	}

	/**
	 * Ends the session's run when its latest input settles (done, rejected or aborted alike): the session is
	 * idle until a new input. Only the latest input's settlement writes idle, so an older run cannot stop a
	 * newer one (doc/agent-runtime.md#会话状态).
	 */
	async #settleInput(sessionId: string, submissionId: string): Promise<void> {
		if (this.#closing) return;
		const row = await this.#db
			.selectFrom("sessions")
			.select(["last_submission_id", "state"])
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!row || row.last_submission_id !== submissionId) return;
		const at = new Date().toISOString();
		await this.#db
			.updateTable("sessions")
			.set({
				state: "idle",
				waiting_kind: null,
				waiting_level_id: null,
				waiting_handler_id: null,
				state_changed_at: sql`case when state = 'idle' then state_changed_at else ${at} end`,
				updated_at: at,
			})
			.where("id", "=", sessionId)
			.where("last_submission_id", "=", submissionId)
			.execute();
		this.#sessionList.publishSession(sessionId);
		this.#forgetInbox(sessionId);
		// A tool call that ended without its task (aborted by durable, abandoned after restarts) left the task
		// waiting for a decision nobody will act on: the run is over, so end those waits too.
		if (!this.#stopping.has(sessionId)) {
			await this.#endSessionWork([sessionId], "the session's run ended", { includeRunning: false });
		}
	}

	/**
	 * Ends what sessions left waiting when their work stopped: approvals are rejected and signature waits
	 * cancelled with `reason`; with `includeRunning` (a stop) dispatched and running tasks are cancelled too.
	 * The tools' own abort signal is not used for this, because it also fires when crhs shuts down and the call
	 * must then reattach to its task after the restart.
	 */
	async #endSessionWork(
		sessions: readonly string[],
		reason: string,
		options: { includeRunning: boolean; by?: SessionUser },
	): Promise<void> {
		if (sessions.length === 0) return;
		const { includeRunning, by } = options;
		const decision = {
			decision: "rejected" as const,
			by: { type: "user", id: by?.userId ?? "system", ...(by ? { onBehalfOfUserId: by.userId } : {}) },
			at: new Date().toISOString(),
			reason,
		};
		const waiting = ["awaiting_approval", "awaiting_authorization"] as const;
		const live = ["dispatched", "running"] as const;
		const tasks = await this.#db
			.selectFrom("tasks")
			.select(["id", "state"])
			.where("actor_id", "in", sessions)
			.where("task_group_id", "is", null)
			.where("state", "in", includeRunning ? [...waiting, ...live] : [...waiting])
			.execute();
		for (const row of tasks) {
			if (row.state === "awaiting_approval") await this.#cluster.decide(row.id, decision);
			else
				await this.#cluster.cancelTask(
					row.id,
					reason,
					by ? { type: "user", id: by.userId, onBehalfOfUserId: by.userId } : undefined,
				);
		}
		const groups = await this.#db
			.selectFrom("task_groups")
			.select(["id", "state"])
			.where("actor_id", "in", sessions)
			.where("state", "in", [...waiting, "running"])
			.execute();
		for (const group of groups) {
			if (group.state === "awaiting_approval") {
				await this.#groups.decide(group.id, decision);
				continue;
			}
			// A running group may still have members waiting for their signature; a stop also cancels the rest.
			const members = await this.#db
				.selectFrom("tasks")
				.select("id")
				.where("task_group_id", "=", group.id)
				.where("state", "in", includeRunning ? ["awaiting_authorization", ...live] : ["awaiting_authorization"])
				.execute();
			for (const t of members)
				await this.#cluster.cancelTask(
					t.id,
					reason,
					by ? { type: "user", id: by.userId, onBehalfOfUserId: by.userId } : undefined,
				);
		}
	}

	/** Stops the current run: queued inputs are withdrawn and running tool calls aborted. */
	async abort(sessionId: string, by?: SessionUser): Promise<void> {
		const { conversation } = await this.#conversation(sessionId);
		const sessions = [sessionId, ...(await this.#descendants(sessionId))];
		for (const id of sessions) this.#stopping.add(id);
		try {
			await conversation.abort(this.#context);
			// Subagents are ownerless conversations: their abort is explicit, and it must come before the work is
			// ended. A subagent that is still running can otherwise dispatch a task after the select below, which
			// nothing would cancel (doc/agent-runtime.md#abort).
			for (const id of sessions.slice(1)) {
				const row = await this.#db
					.selectFrom("sessions")
					.select("conversation_id")
					.where("id", "=", id)
					.executeTakeFirst();
				if (!row) continue;
				const child = await this.#harness.conversation(
					Number(row.conversation_id) as unknown as ConversationId,
					this.#context,
				);
				await child?.abort(this.#context);
			}
			// Stopping means stopping the work too. This is done here, not on the tool's abort signal, which also
			// fires when crhs shuts down: after a restart the call reattaches to its task instead.
			await this.#endSessionWork(sessions, "the session was stopped", { includeRunning: true, by });
			// The stop stays marked until every conversation and every wait of the tree is settled: a run that
			// ends after it is cleared would take the "run ended" path and miss its running tasks.
			await markSessionsIdle(this.#db, sessions);
			for (const id of sessions) this.#sessionList.publishSession(id);
			for (const id of sessions) this.#deniedWaits.delete(id);
			// Clear a quota wait of an ancestor that only the aborted subtree caused.
			const root = (await sessionChain(this.#db, sessionId)).at(-1);
			if (root) await this.refreshState(root);
			this.#notifyQuotaWaiters();
			this.#invalidateInboxes();
			for (const id of sessions) this.#pendingWakes.delete(id);
		} finally {
			for (const id of sessions) this.#stopping.delete(id);
		}
	}

	async #descendants(sessionId: string): Promise<string[]> {
		const children = await this.#db
			.selectFrom("sessions")
			.select("id")
			.where("parent_session_id", "=", sessionId)
			.execute();
		const out: string[] = [];
		for (const c of children) out.push(c.id, ...(await this.#descendants(c.id)));
		return out;
	}

	async configure(
		sessionId: string,
		change: { title?: string; model?: ModelRef; preset?: Preset; quota?: number | null },
	): Promise<SessionView> {
		const { row, conversation } = await this.#conversation(sessionId);
		if (change.model) {
			this.#models.assertAvailable(change.model);
			await conversation.configure(
				{
					model: { provider: change.model.provider, modelId: change.model.modelId },
					thinkingLevel: change.model.thinkingLevel ?? null,
				},
				this.#context,
			);
		}
		if (change.preset && row.parent_session_id === null)
			await setPreset(this.#db, { type: "session", id: sessionId }, change.preset);
		if (change.quota !== undefined) {
			// Setting a quota replaces the remainder at any level, the root included; null removes the limit (D92).
			await setQuota(this.#db, sessionId, change.quota);
			this.#notifyQuotaWaiters();
			this.#invalidateInboxes();
			// A wait on this level (or on a root above it) may be over now.
			await this.refreshState(sessionId);
		}
		await this.#db
			.updateTable("sessions")
			.set({
				...(change.title?.trim() ? { title: change.title.trim() } : {}),
				...(change.model ? { model: JSON.stringify(change.model) } : {}),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", sessionId)
			.execute();
		this.#sessionList.publishSession(sessionId);
		return (await this.getSession(sessionId)) as SessionView;
	}

	/**
	 * Streams the session's events: `onEvents` first gets a snapshot event, then batches as commits land.
	 * Returns a function that stops the stream.
	 */
	async watch(sessionId: string, onEvents: (events: SessionEvent[]) => Promise<void> | void, signal?: AbortSignal) {
		const { row, conversation } = await this.#conversation(sessionId);
		const context = signal ? withAbortSignal(signal, this.#context) : this.#context;
		const stream = await watchEvents(this.#harness, Number(row.conversation_id) as unknown as ConversationId, context);
		await onEvents([await this.#snapshotEvent(conversation, stream.snapshot)]);
		// The client may have gone while the snapshot was being sent; starting the watch then would throw.
		if (signal?.aborted) return () => stream.stop();
		// The system prompt and tool schemas come as system messages: large, and nothing a chat UI shows.
		const shown = (e: AgentEvent) => (e as { message?: { role?: string } }).message?.role !== "system";
		stream.start(async (events) => onEvents((events as SessionEvent[]).filter(shown)));
		return () => stream.stop();
	}

	/**
	 * The first event of a watch, cut down to what the WebUI renders: the newest `SNAPSHOT_ENTRIES` shown entries
	 * (system messages are not shown) and a `historyCursor` for `GET /sessions/:id/entries` when older records
	 * exist (doc/webui.md#会话事件流和历史). The cursor points just before the oldest returned entry, so the
	 * snapshot and the pages that follow it never overlap or skip.
	 */
	async #snapshotEvent(
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
			if (oldestEntry && (await this.#hasEntryBefore(conversation, Number(oldestEntry.id)))) {
				historyCursor = encodeCursor([], Number(oldestEntry.id));
			}
		}
		return {
			type: "snapshot",
			snapshot: { ...snapshot, entries: kept, historyCursor },
		} as unknown as SessionEvent;
	}

	/** Whether the conversation has any record (shown or not) older than `entryId`; one indexed read. */
	async #hasEntryBefore(conversation: Conversation, entryId: number): Promise<boolean> {
		const page = await conversation.entries(
			{ order: "descending" },
			1,
			{ after: entryId, order: "descending" },
			this.#context,
		);
		return page.items.length > 0;
	}

	/**
	 * A page of a session's history for `GET /sessions/:id/entries`: shown entries only, oldest first, ending
	 * immediately before `before`. The durable scan is indexed by (conversation, entry id), so a page costs
	 * O(page) reads; fork chains are walked segment by segment. New entries append at higher ids and cannot
	 * disturb pages that walk backwards.
	 */
	async entriesPage(
		sessionId: string,
		before: number | undefined,
		limit: number,
	): Promise<{ entries: EntryRecord[]; historyCursor: string | null }> {
		const { conversation } = await this.#conversation(sessionId);
		const wanted = limit + 1;
		const collected: EntryRecord[] = [];
		let cursor: Cursor | undefined = before === undefined ? undefined : { after: before, order: "descending" };
		while (collected.length < wanted) {
			const page = await conversation.entries(
				{ order: "descending" },
				wanted - collected.length,
				cursor,
				this.#context,
			);
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
	async sessionAt(
		conversationId: string,
	): Promise<{ id: string; ownerUserId: string; orgId: string; parentSessionId: string | null } | undefined> {
		const cached = this.#sessionsByConversation.get(conversationId);
		if (cached) return cached;
		const row = await this.#db
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
		this.#sessionsByConversation.set(conversationId, session);
		return session;
	}

	/** Whether the session's tools need to look for subagent requests; cached after the first check. */
	async hasSubagents(sessionId: string): Promise<boolean> {
		if (this.#subagentParents.has(sessionId)) return true;
		const row = await this.#db
			.selectFrom("sessions")
			.select("id")
			.where("parent_session_id", "=", sessionId)
			.limit(1)
			.executeTakeFirst();
		if (row) this.#subagentParents.add(sessionId);
		return row !== undefined;
	}

	/**
	 * Creates (or, on a rerun of the same tool call, finds) a subagent's session: its own conversation, rule set and
	 * quota, below the parent's chain (doc/agent-runtime.md#subagent). The child is ownerless so that a parent's
	 * earlier return or abort does not kill it; the runtime cancels it explicitly.
	 */
	async createSubagent(
		parentId: string,
		input: { callKey: string; task: string; rules: RuleSet; quota: number | null },
	): Promise<{ id: string; created: boolean }> {
		const parent = await this.#db.selectFrom("sessions").selectAll().where("id", "=", parentId).executeTakeFirst();
		if (!parent) throw new NotFoundError("no such session");
		let depth = 0;
		for (let id = parent.parent_session_id; id; depth++) {
			id =
				(await this.#db.selectFrom("sessions").select("parent_session_id").where("id", "=", id).executeTakeFirst())
					?.parent_session_id ?? null;
		}
		if (depth >= MAX_SUBAGENT_DEPTH) {
			// Also fix a session created before the tool was removed at the limit.
			const parentConversation = await this.#harness.conversation(
				Number(parent.conversation_id) as unknown as ConversationId,
				this.#context,
			);
			if (parentConversation) await this.#hideSubagentTool(parentConversation);
			throw new UserError(`subagents nest at most ${MAX_SUBAGENT_DEPTH} levels deep`);
		}

		const childId = derivedId(`subagent:${input.callKey}`);
		const existing = await this.#db
			.selectFrom("sessions")
			.select(["id", "conversation_id"])
			.where("id", "=", childId)
			.executeTakeFirst();
		if (existing) {
			if (depth + 1 >= MAX_SUBAGENT_DEPTH) {
				const existingConversation = await this.#harness.conversation(
					Number(existing.conversation_id) as unknown as ConversationId,
					this.#context,
				);
				if (existingConversation) await this.#hideSubagentTool(existingConversation);
			}
			return { id: childId, created: false };
		}
		const model = JSON.parse(parent.model) as ModelRef;
		const parentConversation = await this.#harness.conversation(
			Number(parent.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!parentConversation) throw new NotFoundError("the parent's conversation is missing");
		// Create the ownerless conversation and the link to it in one commit; a rerun after a crash finds the link
		// instead of creating a second, orphaned conversation.
		const conversationId = await parentConversation.commit(async (tx) => {
			const link = await tx.doc(SubagentConversationLink, input.callKey, null);
			if (link.conversationId) return link.conversationId;
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			link.conversationId = String(created.id);
			return String(created.id);
		}, this.#context);
		const conversation = await this.#harness.conversation(
			Number(conversationId) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) throw new NotFoundError("the subagent's conversation is missing");
		await conversation.configure(
			{
				model: { provider: model.provider, modelId: model.modelId },
				...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
			},
			this.#context,
		);
		if (depth + 1 >= MAX_SUBAGENT_DEPTH) await this.#hideSubagentTool(conversation);
		const now = new Date().toISOString();
		await this.#db.transaction().execute(async (trx) => {
			await trx
				.insertInto("sessions")
				.values({
					id: childId,
					org_id: parent.org_id,
					owner_user_id: parent.owner_user_id,
					conversation_id: String(conversation.id),
					parent_session_id: parent.id,
					root_session_id: parent.root_session_id ?? parent.id,
					title: input.task.slice(0, 80),
					model: parent.model,
					status: "active",
					created_at: now,
					updated_at: now,
					archived_at: null,
					quota_tokens: input.quota,
					state: "idle",
					waiting_kind: null,
					waiting_level_id: null,
					waiting_handler_id: null,
					state_changed_at: now,
				})
				.execute();
			await createRuleSet(trx, parent.org_id, { type: "session", id: childId }, input.rules);
		});
		this.#subagentParents.add(parent.id);
		void this.#audit?.record({
			actor: {
				type: parent.parent_session_id ? "subagent" : "session",
				id: parent.id,
				onBehalfOfUserId: parent.owner_user_id,
			},
			action: "session.subagent_created",
			target: { type: "session", id: childId },
			detail: { rules: input.rules, quota: input.quota },
		});
		return { id: childId, created: true };
	}

	/** Hands the parent's task text to the child; a rerun with the same requestId does not send it twice. */
	async startSubagent(childId: string, text: string, requestId: string): Promise<string> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", childId).executeTakeFirst();
		if (!row) throw new NotFoundError("no such session");
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) throw new NotFoundError("the subagent's conversation is missing");
		const submission = await conversation.submit({ type: "input", content: text, requestId }, this.#context);
		await this.#recordInput(childId, submission);
		void this.#audit?.record({
			actor: { type: "subagent", id: row.parent_session_id ?? childId, onBehalfOfUserId: row.owner_user_id },
			action: "session.message",
			target: { type: "session", id: childId },
			detail: { submission_id: String(submission.id), chars: text.length },
		});
		return String(submission.id);
	}

	/**
	 * Waits for the child's answer. With `attention`, an approval handed to this session's agent ends the wait early:
	 * the parent decides with subagent_decide() and then waits again.
	 */
	async waitSubagent(
		childId: string,
		options: { attention?: boolean; signal?: AbortSignal; handler?: string } = {},
	): Promise<
		| { status: "done"; answer: string }
		| { status: "unanswered"; reason: string }
		| { status: "attention"; requests: AgentRequestView[] }
	> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", childId).executeTakeFirst();
		if (!row) throw new NotFoundError("no such subagent session");
		const submissionId = row.last_submission_id;
		if (!submissionId) return { status: "unanswered", reason: "the subagent was never started" };
		const context = options.signal ? withAbortSignal(options.signal, this.#context) : this.#context;
		const submission = await this.#harness.submission(Number(submissionId) as unknown as SubmissionId, context);
		if (!submission) return { status: "unanswered", reason: "the subagent's input is gone" };
		const settled = submission.wait(context);
		if (!options.attention) return this.#answerOf(childId, await settled);

		const abort = new AbortController();
		const attentionRun = this.#nextRequests(options.handler ?? row.parent_session_id ?? childId, abort.signal);
		void attentionRun.catch(() => {});
		const attention = attentionRun.then((requests) => ({ kind: "attention" as const, requests }));
		const first = await Promise.race([settled.then((s) => ({ kind: "settled" as const, s })), attention]);
		abort.abort();
		if (first.kind === "attention") {
			void settled.catch(() => {});
			return { status: "attention", requests: first.requests };
		}
		return this.#answerOf(childId, first.s);
	}

	async #answerOf(
		childId: string,
		settled: SettledSubmissionRecord,
	): Promise<{ status: "done"; answer: string } | { status: "unanswered"; reason: string }> {
		if (settled.status !== "done" || settled.type !== "input") {
			return {
				status: "unanswered",
				reason: settled.status === "unanswered" ? String(settled.reason) : settled.status,
			};
		}
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", childId).executeTakeFirst();
		if (!row) throw new NotFoundError("no such subagent session");
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) throw new NotFoundError("the subagent's conversation is missing");
		const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), this.#context);
		const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
		const answer = (message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
		return { status: "done", answer };
	}

	/** Requests waiting for this session's agent (doc/access-control.md#审批). */
	async pendingAgentRequests(sessionId: string): Promise<AgentRequestView[]> {
		const inbox = await this.#ensureInbox(sessionId);
		return [...inbox.requests.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	#inboxOf(handlerId: string): Inbox {
		let inbox = this.#inboxes.get(handlerId);
		if (!inbox) {
			inbox = { requests: new Map(), loaded: false, waiters: new Set() };
			this.#inboxes.set(handlerId, inbox);
		}
		return inbox;
	}

	async #ensureInbox(handlerId: string): Promise<Inbox> {
		for (;;) {
			const inbox = this.#inboxOf(handlerId);
			if (inbox.loaded) return inbox;
			const requests = await this.#queryRequests(handlerId);
			// An approval change during the read deleted the entry; load the replacement instead of caching stale data.
			if (this.#inboxes.get(handlerId) !== inbox) continue;
			inbox.requests = new Map(requests.map((request) => [requestKey(request), request]));
			inbox.loaded = true;
			return inbox;
		}
	}

	async #queryRequests(handlerId: string): Promise<AgentRequestView[]> {
		const out: AgentRequestView[] = [];
		const tasks = await this.#db
			.selectFrom("tasks")
			.select(["id", "actor_id", "node_id", "spec", "created_at"])
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.where("handler_session_id", "=", handlerId)
			.execute();
		for (const row of tasks) {
			out.push({
				kind: "task",
				id: row.id,
				sessionId: row.actor_id,
				summary: summarize(row.spec),
				nodeId: row.node_id,
				createdAt: row.created_at,
			});
		}
		const groups = await this.#db
			.selectFrom("task_groups")
			.select(["id", "actor_id", "spec", "created_at"])
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.where("handler_session_id", "=", handlerId)
			.execute();
		for (const row of groups) {
			out.push({
				kind: "group",
				id: row.id,
				sessionId: row.actor_id,
				summary: row.spec ? summarize(row.spec) : "",
				nodeId: null,
				createdAt: row.created_at,
			});
		}
		for (const wait of await awaitingQuotaChildren(this.#db, handlerId)) {
			out.push({
				kind: "quota",
				id: wait.sessionId,
				sessionId: wait.sessionId,
				summary: `${wait.levelTitle} is at ${wait.levelQuota ?? "unlimited"} tokens; the subagent is paused`,
				nodeId: null,
				createdAt: wait.since,
			});
		}
		return out;
	}

	/** Forgets one handler's request cache; waiters are woken before the entry disappears. */
	#forgetInbox(handlerId: string): void {
		const inbox = this.#inboxes.get(handlerId);
		if (!inbox) return;
		for (const wake of inbox.waiters) wake();
		inbox.waiters.clear();
		this.#inboxes.delete(handlerId);
	}

	/** Drops cached request lists and wakes `waitSubagent`; the cluster calls this on any approval change. */
	#invalidateInboxes(): void {
		for (const handlerId of [...this.#inboxes.keys()]) this.#forgetInbox(handlerId);
	}

	/** Resolves with the handler's next pending requests; no polling (the inbox notifies it). */
	async #nextRequests(handlerId: string, signal: AbortSignal): Promise<AgentRequestView[]> {
		for (;;) {
			if (signal.aborted) throw new Error("aborted");
			const inbox = this.#inboxOf(handlerId);
			let resolve!: () => void;
			const changed = new Promise<void>((r) => {
				resolve = r;
				inbox.waiters.add(r);
			});
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<"aborted">((r) => {
				onAbort = () => r("aborted");
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				const requests = await this.pendingAgentRequests(handlerId);
				if (requests.length > 0) return requests;
				const outcome = await Promise.race([changed.then(() => "changed" as const), aborted]);
				if (outcome === "aborted") throw new Error("aborted");
			} finally {
				inbox.waiters.delete(resolve);
				if (onAbort) signal.removeEventListener("abort", onAbort);
			}
		}
	}

	/** The agent of `sessionId` settles a request it owns: approve, deny, or pass it on to the user. */
	async decideAgentRequest(
		sessionId: string,
		requestId: string,
		decision: "approve" | "deny" | "escalate",
		reason?: string,
		tokens?: number,
	): Promise<"task" | "group" | "quota"> {
		const session = await this.#db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
		if (!session) throw new NotFoundError("no such session");
		const by = {
			type: session.parent_session_id ? "subagent" : "session",
			id: sessionId,
			onBehalfOfUserId: session.owner_user_id,
		};
		const task = await this.#db
			.selectFrom("tasks")
			.select(["id", "state", "approval", "on_behalf_of_user_id", "actor_id"])
			.where("id", "=", requestId)
			.executeTakeFirst();
		if (task) {
			const approval = JSON.parse(task.approval ?? "{}") as ApprovalRecord;
			if (approval.agent?.session !== sessionId || approval.agent.state !== "pending") {
				throw new UserError("this request is not waiting for this session's agent");
			}
			if (decision === "escalate") {
				if (!(await this.#cluster.escalateAgentDecision(requestId, sessionId)))
					throw new UserError("the request is no longer waiting");
			} else {
				const at = new Date().toISOString();
				const ok = await this.#cluster.decide(requestId, {
					decision: decision === "approve" ? "approved" : "rejected",
					by: { ...by, onBehalfOfUserId: task.on_behalf_of_user_id },
					at,
					...(reason ? { reason } : {}),
				});
				if (!ok) throw new UserError("the request is no longer waiting");
			}
			this.#dropWake(sessionId, `agent-request:task:${requestId}`);
			await this.refreshState(task.actor_id);
			return "task";
		}
		const waiting = await this.#db.selectFrom("sessions").selectAll().where("id", "=", requestId).executeTakeFirst();
		if (waiting?.state === "awaiting" && waiting.waiting_kind === "quota" && waiting.waiting_level_id) {
			const levelId = waiting.waiting_level_id;
			if ((await this.#parentOf(levelId)) !== sessionId) {
				throw new UserError("this quota wait is not handled by this session's agent");
			}
			if (decision === "escalate") {
				throw new UserError("a quota wait goes to the direct parent only; approve or deny it");
			}
			if (decision === "deny") {
				// A call paused right now is told by the in-memory mark, so it ends instead of waiting again.
				if (this.#quotaWaiters.get(requestId)?.size) this.#deniedWaits.add(requestId);
				await markSessionsIdle(this.#db, [requestId]);
			} else {
				if (tokens === undefined) throw new UserError("give the quota wait tokens to grant");
				// No cap: the whole chain is charged for every response, so the parent's own remainder does
				// not limit what it can add for its child (D77).
				await grantQuota(this.#db, levelId, tokens);
			}
			void this.#audit?.record({
				actor: by,
				action: decision === "deny" ? "quota.denied" : "quota.granted",
				target: { type: "session", id: requestId },
				detail: { level: levelId, ...(reason ? { reason } : {}), ...(tokens ? { tokens } : {}) },
			});
			this.#dropWakePrefix(sessionId, `quota-request:${requestId}:`);
			this.#notifyQuotaWaiters();
			this.#invalidateInboxes();
			// A denial already left the session idle; a grant lets the paused call resume and write `running` itself.
			if (decision === "deny") await this.refreshState(requestId);
			return "quota";
		}
		const group = await this.#db
			.selectFrom("task_groups")
			.select(["id", "state", "approval", "on_behalf_of_user_id", "actor_id"])
			.where("id", "=", requestId)
			.executeTakeFirst();
		if (!group) throw new NotFoundError("no such request");
		const approval = JSON.parse(group.approval ?? "{}") as GroupApprovalRecord;
		if (approval.agent?.session !== sessionId || approval.agent.state !== "pending") {
			throw new UserError("this request is not waiting for this session's agent");
		}
		if (decision === "escalate") {
			if (!(await this.#groups.escalateAgentDecision(requestId, sessionId)))
				throw new UserError("the request is no longer waiting");
		} else {
			const ok = await this.#groups.decide(requestId, {
				decision: decision === "approve" ? "approved" : "rejected",
				by: { ...by, onBehalfOfUserId: group.on_behalf_of_user_id },
				at: new Date().toISOString(),
				...(reason ? { reason } : {}),
			});
			if (!ok) throw new UserError("the request is no longer waiting");
		}
		this.#dropWake(sessionId, `agent-request:group:${requestId}`);
		await this.refreshState(group.actor_id);
		return "group";
	}

	/**
	 * The owner's answer to a root whose quota is used up (doc/agent-runtime.md#配额): add N tokens (additive, no
	 * cap) or deny and stop the paused runs. The wait may belong to the root's own run or to a subagent paused on
	 * the root level, so the paused sessions carry it (not the root row alone). Returns them, for the audit.
	 */
	async decideRootQuota(rootId: string, decision: "approve" | "deny", tokens?: number): Promise<string[]> {
		const root = await this.#db.selectFrom("sessions").selectAll().where("id", "=", rootId).executeTakeFirst();
		if (!root) throw new NotFoundError("no such session");
		if (root.parent_session_id !== null) throw new UserError("only a root session's quota can be decided");
		const paused = await this.#db
			.selectFrom("sessions")
			.select(["id", "state", "waiting_level_id"])
			.where("state", "=", "awaiting")
			.where("waiting_kind", "=", "quota")
			.where("waiting_level_id", "=", rootId)
			.execute();
		const exhausted = root.quota_tokens !== null && Number(root.quota_tokens) <= 0;
		if (paused.length === 0 || !exhausted) {
			throw new UserError("the session is not waiting for a token quota decision");
		}
		if (decision === "deny") {
			// The paused calls end like an agent's deny; a call waiting right now is told by the in-memory mark,
			// so it ends instead of waiting again.
			for (const row of paused) if (this.#quotaWaiters.get(row.id)?.size) this.#deniedWaits.add(row.id);
			await markSessionsIdle(
				this.#db,
				paused.map((row) => row.id),
			);
		} else {
			if (tokens === undefined) throw new UserError("give the quota wait tokens to grant");
			await grantQuota(this.#db, rootId, tokens);
		}
		this.#notifyQuotaWaiters();
		this.#invalidateInboxes();
		// On a deny every paused run already ended idle; on a grant each paused call resumes and writes `running`.
		if (decision === "deny") for (const row of paused) await this.refreshState(row.id);
		await this.refreshState(rootId);
		return paused.map((row) => row.id);
	}

	/** Remembers which session owns a conversation's provider session id, for metering its compaction (D92). */
	async rememberProviderSession(conversationId: string): Promise<void> {
		if (this.#learnedProviders.has(conversationId)) return;
		const provider = await this.#harness.snapshot(
			ProviderDoc,
			Number(conversationId) as unknown as ConversationId,
			this.#context,
		);
		const providerSessionId = provider?.sessionId;
		if (typeof providerSessionId !== "string") return;
		const row = await this.#db
			.selectFrom("sessions")
			.select("id")
			.where("conversation_id", "=", conversationId)
			.executeTakeFirst();
		if (!row) return;
		this.#providerSessions.set(providerSessionId, row.id);
		this.#learnedProviders.add(conversationId);
	}

	/** Charges a compaction's summarization to the session it compacted (D92); the next tool call pauses if it emptied the quota. */
	async chargeCompaction(providerSessionId: string, message: AccountedMessage): Promise<void> {
		const sessionId = this.#providerSessions.get(providerSessionId);
		if (!sessionId) return;
		const tokens = accountedOutputTokens(message);
		if (tokens <= 0) return;
		await recordUsage(this.#db, sessionId, tokens);
		const over = await exhaustedLevel(this.#db, sessionId);
		if (over) {
			void this.#audit?.record({
				actor: { type: "system", id: "quota" },
				action: "session.quota_exhausted",
				target: { type: "session", id: over },
			});
		}
	}

	/**
	 * Pauses a tool call whose chain quota is used up (doc/agent-runtime.md#配额): asks the exhausted level's direct
	 * parent (its agent), or, when that level is the root, the owner; waits until the whole chain is above zero or the
	 * request is denied. A rerun after a restart finds the same request.
	 */
	async waitForQuota(sessionId: string, context: Context): Promise<"ok" | "denied"> {
		for (;;) {
			// The owner denied while this call was setting up or between waits: end it instead of waiting again.
			if (this.#deniedWaits.delete(sessionId)) return "denied";
			const waiter = this.#quotaWaiter(sessionId, context.abortSignal);
			try {
				const level = await exhaustedLevel(this.#db, sessionId);
				if (!level) {
					const write = await setSessionState(this.#db, sessionId, "running", null, { onlyIfLive: true });
					this.#sessionList.publishSession(sessionId);
					// The quota request is gone; drop it from the handler's cache before returning.
					this.#invalidateInboxes();
					// The run ended while this call waited: do not revive it or run the task.
					if (!write.applied) return "denied";
					return "ok";
				}
				const parent = await this.#parentOf(level);
				const quotaWait: SessionWait = { kind: "quota", levelId: level };
				// A tool call pausing is a real transition of its run, not a recompute; only its resume checks the
				// row is still live (a run that ended while it waited must not be revived).
				const { since } = await setSessionState(this.#db, sessionId, "awaiting", quotaWait);
				this.#sessionList.publishSession(sessionId);
				// A root level has no parent to handle its wait: the owner sees it in the approvals API, and the
				// session paused on that level already carries the wait (doc/agent-runtime.md#配额).
				// A deny/abort could have landed between the check and the write; do not wake for an ended wait.
				if (this.#deniedWaits.delete(sessionId)) return "denied";
				// The handler's inbox cache must see the new quota request.
				this.#invalidateInboxes();
				if (parent) await this.#wakeQuota(parent, sessionId, level, since);
				// Grant/deny/abort/quota edit resolves this; the next loop re-checks the durable state.
				await waiter.promise;
				if (context.abortSignal?.aborted) throw new Error("the quota wait was aborted");
			} finally {
				waiter.cancel();
			}
		}
	}

	/** Resolves when the quota wait may have changed (grant, deny, abort, or a quota edit). */
	#quotaWaiter(sessionId: string, signal: AbortSignal | undefined): { promise: Promise<void>; cancel: () => void } {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		const waiters = this.#quotaWaiters.get(sessionId) ?? new Set<() => void>();
		waiters.add(resolve);
		this.#quotaWaiters.set(sessionId, waiters);
		const onAbort = () => resolve();
		if (signal) {
			if (signal.aborted) resolve();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		return {
			promise,
			cancel: () => {
				waiters.delete(resolve);
				if (waiters.size === 0) this.#quotaWaiters.delete(sessionId);
				signal?.removeEventListener("abort", onAbort);
			},
		};
	}

	#notifyQuotaWaiters(): void {
		for (const waiters of this.#quotaWaiters.values()) for (const wake of waiters) wake();
	}

	/**
	 * Recomputes a session's state from durable and its wait sources (doc/agent-runtime.md#会话状态): a quota wait
	 * first, then a task waiting for approval or a signature, otherwise running while its latest input is
	 * unsettled. An idle session is never revived here — only a new input does that — so a late correction
	 * cannot restart a run that already ended.
	 */
	async refreshState(sessionId: string): Promise<SessionState> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
		if (!row) return "idle";
		if (row.state === "idle") return "idle";
		const settled = await this.#inputSettled(row);
		const desired = await this.#desiredState(row, settled);
		// The write is conditional on the row still being live: the run may have settled while the reads above
		// ran, and a recompute must not revive it (doc/agent-runtime.md#会话状态).
		const write = await setSessionState(this.#db, sessionId, desired.state, desired.wait, { onlyIfLive: true });
		if (!write.applied) return "idle";
		this.#sessionList.publishSession(sessionId);
		// Approval/quota changes alter the handler's inbox; write-state and cache invalidation are adjacent.
		const changed =
			row.state !== desired.state ||
			row.waiting_kind !== (desired.wait?.kind ?? null) ||
			row.waiting_level_id !== (desired.wait?.levelId ?? null);
		if (changed) this.#invalidateInboxes();
		return desired.state;
	}

	/** The state a live (or stale) row deserves; `settled` says its latest input's run is over. */
	async #desiredState(row: Row, settled: boolean): Promise<{ state: SessionState; wait: SessionWait | null }> {
		const quotaLevel = await this.#quotaWaitLevel(row);
		if (quotaLevel) return { state: "awaiting", wait: { kind: "quota", levelId: quotaLevel } };
		if (settled) return { state: "idle", wait: null };
		const kind = await this.#taskWaitKind(row.id);
		if (kind) return { state: "awaiting", wait: { kind, levelId: null } };
		return { state: "running", wait: null };
	}

	/** Whether the latest input's run is over (done or unanswered); no input at all counts as settled. */
	async #inputSettled(row: Pick<Row, "last_submission_id">): Promise<boolean> {
		if (!row.last_submission_id) return true;
		const submission = await this.#harness.submission(
			Number(row.last_submission_id) as unknown as SubmissionId,
			this.#context,
		);
		if (!submission) return true;
		const status = await submission.status(this.#context);
		return status.status === "done" || status.status === "unanswered";
	}

	/**
	 * The level a quota wait still points at: recomputed from the chain, because a grant of one level may expose
	 * the next one, and no longer exhausted at all ends the wait.
	 */
	async #quotaWaitLevel(row: Row): Promise<string | undefined> {
		if (row.state !== "awaiting" || row.waiting_kind !== "quota") return undefined;
		return exhaustedLevel(this.#db, row.id);
	}

	/** What the session's own tool calls wait for: an approval outranks a signature (doc/agent-runtime.md#会话状态). */
	async #taskWaitKind(sessionId: string): Promise<"approval" | "authorization" | undefined> {
		const waiting = async (state: "awaiting_approval" | "awaiting_authorization"): Promise<boolean> => {
			for (const table of ["tasks", "task_groups"] as const) {
				const row = await this.#db
					.selectFrom(table)
					.select("id")
					.where("actor_type", "in", ["session", "subagent"])
					.where("actor_id", "=", sessionId)
					.where("state", "=", state)
					.limit(1)
					.executeTakeFirst();
				if (row) return true;
			}
			return false;
		};
		if (await waiting("awaiting_approval")) return "approval";
		if (await waiting("awaiting_authorization")) return "authorization";
		return undefined;
	}

	/** The direct parent of a level; the only session that handles its quota wait. */
	async #parentOf(levelId: string): Promise<string | null> {
		const row = await this.#db
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", levelId)
			.executeTakeFirst();
		return row?.parent_session_id ?? null;
	}

	/** Wakes an idle handler with a follow-up input; a running one sees the request through afterTool. */
	async #wakeQuota(handlerId: string, sessionId: string, levelId: string, since: string): Promise<void> {
		// `since` keeps one pause's wake stable across polls and restarts, and makes the next pause a new request.
		await this.#wake(
			handlerId,
			`quota-request:${sessionId}:${levelId}:${since}`,
			`A subagent is paused: its token quota is used up (session ${sessionId}, level ${levelId}). ` +
				`Check it with subagent_list, then subagent_decide("${sessionId}", "approve", tokens: <positive integer>) ` +
				'to add quota, or "deny" to stop it.',
		);
	}

	/** The session's subagents, newest first, with what waits for this session's agent. */
	async subagentSessions(sessionId: string): Promise<
		{
			id: string;
			title: string;
			state: SessionState;
			createdAt: string;
			lastSubmissionId: string | null;
			pending: AgentRequestView[];
		}[]
	> {
		const rows = await this.#db
			.selectFrom("sessions")
			.selectAll()
			.where("parent_session_id", "=", sessionId)
			.orderBy("created_at", "desc")
			.execute();
		const states = new Map<string, SessionState>();
		for (const r of rows) states.set(r.id, await this.refreshState(r.id));
		const pending = await this.pendingAgentRequests(sessionId);
		return rows.map((r) => ({
			id: r.id,
			title: r.title,
			state: states.get(r.id) ?? r.state,
			createdAt: r.created_at,
			lastSubmissionId: r.last_submission_id,
			pending: pending.filter((p) => p.sessionId === r.id),
		}));
	}

	/** True when `childId` is this session's own subagent or below one (so it may wait for or stop it). */
	async isDescendant(sessionId: string, childId: string): Promise<boolean> {
		return (await this.#descendants(sessionId)).includes(childId);
	}

	/**
	 * Routes a waiting approval up the chain (doc/agent-runtime.md#处理子会话的请求): the first ancestor whose effective
	 * result is allow decides through its agent; the root's owner always decides.
	 */
	async #routeAwaiting(
		kind: "task" | "group",
		actorId: string,
		requestId: string,
		approval: ApprovalRecord | GroupApprovalRecord | null,
	): Promise<void> {
		if (!approval) return;
		const evaluations = "evaluation" in approval ? [approval.evaluation] : approval.nodes.map((n) => n.evaluation);
		if (evaluations.length === 0) return;
		const actor = await this.#db.selectFrom("sessions").selectAll().where("id", "=", actorId).executeTakeFirst();
		if (!actor?.parent_session_id) return;
		// Walk up from the immediate parent; the root's approvals always go to its owner.
		for (let id: string | null = actor.parent_session_id; id; ) {
			const parent = await this.#db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
			if (!parent) return;
			if (parent.parent_session_id === null) return;
			const allows = evaluations.every((evaluation) => {
				const level = evaluation.levels.find((l) => l.scope.type === "session" && l.scope.id === parent.id);
				return level?.effective === "allow";
			});
			if (allows) {
				const routed =
					kind === "task"
						? await this.#cluster.requestAgentDecision(requestId, parent.id)
						: await this.#groups.requestAgentDecision(requestId, parent.id);
				if (routed) await this.#wakeParent(parent, kind, requestId);
				return;
			}
			id = parent.parent_session_id;
		}
	}

	/**
	 * Startup reconciliation (doc/agent-runtime.md#会话状态), run after durable resumed the runs and before
	 * crhs accepts requests: the cached state of every stale candidate is corrected against durable and the
	 * wait sources. A session is a candidate only when its row is not `idle` (it claims a live run or a wait),
	 * or when its latest durable input is still unsettled:
	 * - a run whose latest input already settled becomes idle;
	 * - an unsettled one is awaiting on its quota wait or on a task waiting for approval/signature, else running;
	 * - an idle row with an unsettled input becomes running.
	 * An idle row outside that set needs no check: `#recordInput` writes `running` in the same statement that
	 * advances `last_submission_id`, and `#settleInput` writes `idle` only after the latest input settled (a new
	 * session starts idle with no input at all), so "idle and settled" holds by construction. The `0029`
	 * migration maps old `active`/`stopped` rows to `idle` without knowing which runs survived; those are
	 * exactly the rows candidate 2 finds through their unsettled submission. The system is sized for far more
	 * idle sessions than active ones (doc/webui.md: 100,000 sessions), so only candidates may cost a durable
	 * read. Each correction is logged, not audited. The write is conditional on the row read, so a state write
	 * by a resumed run wins the race instead of being clobbered.
	 */
	async #reconcileSessionStates(): Promise<void> {
		const candidates = new Map<string, Row>();
		// Candidate 1: rows that claim a live run or a wait.
		const stale = await nonIdleSessions(this.#db).execute();
		for (const row of stale) candidates.set(row.id, row);
		// Candidate 2: queued and placed submissions are durable's one answer to "what has not settled"; map
		// them back to their sessions through `last_submission_id`, in chunks, never with a query per row.
		const { submissions } = await this.#harness.inspect(this.#context);
		const unsettled = new Set(
			submissions.flatMap((submission) => (submission.type === "input" ? [String(submission.id)] : [])),
		);
		const unresolved = [...unsettled];
		for (let start = 0; start < unresolved.length; start += RECONCILE_CHUNK) {
			const rows = await sessionsWithSubmissions(this.#db, unresolved.slice(start, start + RECONCILE_CHUNK)).execute();
			for (const row of rows) if (!candidates.has(row.id)) candidates.set(row.id, row);
		}
		for (const row of candidates.values()) {
			// A candidate found through an unsettled submission is already known not to have settled; the others
			// have a non-idle row, whose latest input must be read to tell idle from running.
			const settled =
				row.last_submission_id !== null && unsettled.has(row.last_submission_id)
					? false
					: await this.#inputSettled(row);
			let desired: { state: SessionState; wait: SessionWait | null };
			if (settled) {
				desired = { state: "idle", wait: null };
			} else {
				const quotaLevel = await this.#quotaWaitLevel(row);
				const waitKind = quotaLevel ? undefined : await this.#taskWaitKind(row.id);
				desired = quotaLevel
					? { state: "awaiting", wait: { kind: "quota", levelId: quotaLevel } }
					: waitKind
						? { state: "awaiting", wait: { kind: waitKind, levelId: null } }
						: { state: "running", wait: null };
			}
			// A resumed run was not recorded by #recordInput, so nothing would write idle when it ends: watch it.
			if (!settled && row.last_submission_id) this.#watchSubmission(row.id, row.last_submission_id);
			const kind = desired.wait?.kind ?? null;
			const levelId = desired.wait?.levelId ?? null;
			if (row.state === desired.state && row.waiting_kind === kind && row.waiting_level_id === levelId) continue;
			const at = new Date().toISOString();
			let update = this.#db
				.updateTable("sessions")
				.set({
					state: desired.state,
					waiting_kind: kind,
					waiting_level_id: levelId,
					waiting_handler_id: kind === "quota" && levelId ? await this.#parentOf(levelId) : null,
					state_changed_at: at,
				})
				.where("id", "=", row.id)
				.where("state", "=", row.state);
			update =
				row.state_changed_at === null
					? update.where("state_changed_at", "is", null)
					: update.where("state_changed_at", "=", row.state_changed_at);
			const res = await update.executeTakeFirst();
			if (res.numUpdatedRows === 0n) continue;
			const before = row.state === "awaiting" ? `awaiting/${row.waiting_kind ?? "?"}` : row.state;
			const after = desired.state === "awaiting" ? `awaiting/${kind ?? "?"}` : desired.state;
			console.log(`session state reconciled: ${row.id} ${before} -> ${after}`);
		}
	}

	/** Records the end of a submission that survived a restart (its input was recorded by the previous process). */
	#watchSubmission(sessionId: string, submissionId: string): void {
		void (async () => {
			const submission = await this.#harness.submission(Number(submissionId) as unknown as SubmissionId, this.#context);
			if (!submission) return;
			await submission.wait(this.#context);
			await this.#settleInput(sessionId, submissionId);
		})().catch((err: unknown) => {
			console.error("agent runtime: recording a resumed run's end failed:", err);
		});
	}

	/**
	 * Startup reconciliation of approval and signature waits (doc/agent-runtime.md#会话状态): a task or group
	 * acting for a session that is idle after #reconcileSessionStates belongs to a run that is over, so its wait
	 * is ended. Only waiting rows are read, never every session.
	 */
	async #endOrphanWaits(): Promise<void> {
		const waiting = ["awaiting_approval", "awaiting_authorization"] as const;
		const orphaned = new Set<string>();
		for (const table of ["tasks", "task_groups"] as const) {
			const rows = await this.#db
				.selectFrom(table)
				.innerJoin("sessions", "sessions.id", `${table}.actor_id`)
				.select(`${table}.actor_id as actorId`)
				.where(`${table}.actor_type`, "in", ["session", "subagent"])
				.where(`${table}.state`, "in", [...waiting])
				.where("sessions.state", "=", "idle")
				.execute();
			for (const row of rows) orphaned.add(row.actorId);
		}
		const running = await this.#db
			.selectFrom("tasks")
			.innerJoin("task_groups", "task_groups.id", "tasks.task_group_id")
			.innerJoin("sessions", "sessions.id", "task_groups.actor_id")
			.select("task_groups.actor_id as actorId")
			.where("task_groups.state", "=", "running")
			.where("tasks.state", "=", "awaiting_authorization")
			.where("sessions.state", "=", "idle")
			.execute();
		for (const row of running) orphaned.add(row.actorId);
		if (orphaned.size === 0) return;
		console.log(`agent runtime: ending the waits of ${orphaned.size} session(s) whose run is over`);
		await this.#endSessionWork([...orphaned], "the session's run ended", { includeRunning: false });
	}

	/** After a restart, wakes the parents of requests that were already waiting (deduplicated by requestId). */
	async #wakePendingAgents(): Promise<void> {
		const requests: { kind: "task" | "group"; id: string; session: string }[] = [];
		const tasks = await this.#db
			.selectFrom("tasks")
			.select(["id", "handler_session_id"])
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.execute();
		for (const row of tasks) {
			if (row.handler_session_id) requests.push({ kind: "task", id: row.id, session: row.handler_session_id });
		}
		const groups = await this.#db
			.selectFrom("task_groups")
			.select(["id", "handler_session_id"])
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.execute();
		for (const row of groups) {
			if (row.handler_session_id) requests.push({ kind: "group", id: row.id, session: row.handler_session_id });
		}
		for (const request of requests) {
			const parent = await this.#db
				.selectFrom("sessions")
				.selectAll()
				.where("id", "=", request.session)
				.executeTakeFirst();
			if (!parent) continue;
			try {
				await this.#wakeParent(parent, request.kind, request.id);
			} catch (err) {
				console.error("agent runtime: waking for a subagent request failed:", err);
			}
		}
		for (const wait of await awaitingQuotaSessions(this.#db)) {
			// A root-level wait has no handler: the owner sees it in the approvals API.
			const parent = wait.handlerId || (await this.#parentOf(wait.levelId));
			if (!parent) continue;
			try {
				await this.#wakeQuota(parent, wait.sessionId, wait.levelId, wait.since);
			} catch (err) {
				console.error("agent runtime: waking for a quota wait failed:", err);
			}
		}
	}

	/** Wakes an idle parent with a follow-up input; a running parent sees the request through afterTool. */
	async #wakeParent(parent: Row, kind: "task" | "group", requestId: string): Promise<void> {
		await this.#wake(
			parent.id,
			`agent-request:${kind}:${requestId}`,
			`A subagent request is waiting for you: ${kind} ${requestId}. ` +
				`Check it with subagent_list, then call subagent_decide("${requestId}", "approve" | "deny" | "escalate", reason?).`,
		);
	}

	/** One wake path for every subagent request: a follow-up input to an idle handler, or one queued until idle. */
	async #wake(handlerId: string, requestId: string, content: string): Promise<void> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
		if (!row) return;
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) return;
		const state = await conversation.viewState(this.#context);
		const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
		state.dispose();
		if (live?.run) {
			// The handler is running; afterTool shows the request. If it ends without handling it, flush the wake.
			this.#queueWake(handlerId, requestId, content);
			this.#watchIdle(handlerId);
			return;
		}
		this.#dropWake(handlerId, requestId);
		await this.#submitWake(handlerId, requestId, content);
	}

	async #submitWake(handlerId: string, requestId: string, content: string): Promise<void> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
		if (!row) return;
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) return;
		const submission = await conversation.submit({ type: "input", content, requestId }, this.#context);
		await this.#recordInput(handlerId, submission);
	}

	#queueWake(handlerId: string, requestId: string, content: string): void {
		const wakes = this.#pendingWakes.get(handlerId) ?? new Map<string, string>();
		wakes.set(requestId, content);
		this.#pendingWakes.set(handlerId, wakes);
	}

	#dropWake(handlerId: string, requestId: string): void {
		const wakes = this.#pendingWakes.get(handlerId);
		if (!wakes) return;
		wakes.delete(requestId);
		if (wakes.size === 0) this.#pendingWakes.delete(handlerId);
	}

	#dropWakePrefix(handlerId: string, prefix: string): void {
		const wakes = this.#pendingWakes.get(handlerId);
		if (!wakes) return;
		for (const requestId of wakes.keys()) if (requestId.startsWith(prefix)) wakes.delete(requestId);
		if (wakes.size === 0) this.#pendingWakes.delete(handlerId);
	}

	/** Watches a running handler once; `waitForIdle` resolves when its own run ends, not by polling. */
	#watchIdle(handlerId: string): void {
		if (this.#idleWatchers.has(handlerId)) return;
		this.#idleWatchers.add(handlerId);
		void (async () => {
			try {
				const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
				if (!row) return;
				const conversation = await this.#harness.conversation(
					Number(row.conversation_id) as unknown as ConversationId,
					this.#context,
				);
				if (!conversation) return;
				await conversation.waitForIdle(this.#context);
			} finally {
				this.#idleWatchers.delete(handlerId);
			}
			await this.#flushWakes(handlerId);
		})().catch((err: unknown) => {
			this.#idleWatchers.delete(handlerId);
			console.error("agent runtime: flushing a subagent wake failed:", err);
		});
	}

	async #flushWakes(handlerId: string): Promise<void> {
		const wakes = this.#pendingWakes.get(handlerId);
		if (!wakes?.size) return;
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", handlerId).executeTakeFirst();
		if (!row) {
			this.#pendingWakes.delete(handlerId);
			return;
		}
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) {
			this.#pendingWakes.delete(handlerId);
			return;
		}
		const state = await conversation.viewState(this.#context);
		const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
		state.dispose();
		if (live?.run) {
			// A new run started between idle and the flush; wait for that one too.
			this.#watchIdle(handlerId);
			return;
		}
		// A rule change, token revoke or a decision may have settled the request after it was queued.
		const pending = new Set((await this.pendingAgentRequests(handlerId)).map(requestKey));
		this.#pendingWakes.delete(handlerId);
		for (const [requestId, content] of wakes) {
			const key = wakeRequestKey(requestId);
			if (key && !pending.has(key)) continue;
			try {
				await this.#submitWake(handlerId, requestId, content);
			} catch (err) {
				console.error("agent runtime: waking a subagent handler failed:", err);
			}
		}
	}

	/** Waits for a submission to settle: the answer's text, or why it went unanswered. */
	async waitSubmission(
		sessionId: string,
		submissionId: string,
		signal?: AbortSignal,
	): Promise<{ status: "done"; answer: string } | { status: "unanswered"; reason: string }> {
		const { conversation } = await this.#conversation(sessionId);
		const context = signal ? withAbortSignal(signal, this.#context) : this.#context;
		const submission = await this.#harness.submission(Number(submissionId) as unknown as SubmissionId, context);
		if (!submission) throw new NotFoundError("no such submission");
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			return {
				status: "unanswered",
				reason: settled.status === "unanswered" ? String(settled.reason) : settled.status,
			};
		}
		const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
		const answer = (message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
		return { status: "done", answer };
	}

	/** Waits for a submission to settle and says how it ended, without reading or committing its answer. */
	async waitForSubmission(
		submissionId: string,
		signal?: AbortSignal,
	): Promise<{ status: "done" } | { status: "unanswered"; reason: string }> {
		const context = signal ? withAbortSignal(signal, this.#context) : this.#context;
		const submission = await this.#harness.submission(Number(submissionId) as unknown as SubmissionId, context);
		if (!submission) return { status: "unanswered", reason: "missing" };
		const settled = await submission.wait(context);
		return settled.status === "done" ? { status: "done" } : { status: "unanswered", reason: settled.reason };
	}

	/**
	 * Request ids of the submissions still queued or placed (doc/scheduling.md#调度): a scheduled run whose
	 * submission has not settled is still active after a restart, even when its run row already says `preempted`.
	 */
	async unsettledSubmissionRequests(): Promise<Set<string>> {
		const { submissions } = await this.#harness.inspect(this.#context);
		return new Set(
			submissions.flatMap((submission) => (submission.requestId === undefined ? [] : [submission.requestId])),
		);
	}

	/** Waits until nothing in the Harness runs (tests). */
	async waitForIdle(): Promise<void> {
		await this.#harness.waitForIdle(this.#context);
	}
}

// ---- the cluster tools as durable tools ----

/** Session-side context of a tool call: whose session it is and which rule chain applies. */
async function toolContextFor(
	options: AgentRuntimeOptions,
	conversationId: string,
): Promise<Omit<ToolContext, "callKey" | "signal" | "onStatus">> {
	const { db } = options;
	const session = await db
		.selectFrom("sessions")
		.selectAll()
		.where("conversation_id", "=", conversationId)
		.executeTakeFirst();
	if (!session) throw new Error("this conversation is not a ClusterRightHand session");
	const owner = await db
		.selectFrom("users")
		.select(["id", "username", "kind", "status"])
		.where("id", "=", session.owner_user_id)
		.executeTakeFirst();
	if (owner?.status !== "active") throw new UserError("the session's owner is disabled");
	// The chain from the root session down to this one.
	const chain: RuleRef[] = [];
	let top = session;
	for (let s: typeof session | undefined = session; s; ) {
		chain.unshift({ type: "session", id: s.id });
		top = s;
		s = s.parent_session_id
			? await db.selectFrom("sessions").selectAll().where("id", "=", s.parent_session_id).executeTakeFirst()
			: undefined;
	}
	// A scheduled run's root session sits below its schedule (doc/scheduling.md#授权规则与配额).
	if (top.schedule_id) chain.unshift({ type: "schedule", id: top.schedule_id });
	const actor: Actor = {
		type: session.parent_session_id ? "subagent" : "session",
		id: session.id,
		onBehalfOfUserId: owner.id,
	};
	return {
		db,
		cluster: options.cluster,
		groups: options.groups,
		user: { userId: owner.id, username: owner.username, kind: owner.kind, sessionId: `session:${session.id}` },
		actor,
		chain,
		approvalUrl: (kind, id) => `/approvals/${kind === "task" ? "tasks" : "task-groups"}/${id}`,
		taskUrl: (id) => `/tasks/${id}`,
		groupUrl: (id) => `/task-groups/${id}`,
		defaultWaitS: 600,
		waitThroughApproval: true,
	};
}

function clusterExtension(options: AgentRuntimeOptions, runtimeRef: { current?: AgentRuntime }): Extension {
	const requestJson = (r: AgentRequestView) => ({
		kind: r.kind,
		id: r.id,
		session_id: r.sessionId,
		summary: r.summary,
		node_id: r.nodeId,
		created_at: r.createdAt,
	});
	const sessionOf = async (conversationId: unknown) =>
		(
			await options.db
				.selectFrom("sessions")
				.select("id")
				.where("conversation_id", "=", String(conversationId))
				.executeTakeFirst()
		)?.id;
	const hooks = [
		hook(ToolTask, {
			// Every tool result reminds the parent of subagent requests it must settle (doc/agent-runtime.md#处理子会话的请求).
			afterTool: async (call, result, api) => {
				if (call.parent) return undefined;
				const runtime = runtimeRef.current;
				if (!runtime) return undefined;
				const session = await runtime.sessionAt(String(api.conversationId));
				if (!session || !(await runtime.hasSubagents(session.id))) return undefined;
				const pending = await runtime.pendingAgentRequests(session.id);
				if (pending.length === 0) return undefined;
				const lines = pending.map((r) => `${r.kind} ${r.id}: ${r.summary}`);
				const hint =
					`\n\nSubagent requests waiting for your decision:\n- ${lines.join("\n- ")}\n` +
					'Call subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?).';
				return { ...result, output: [...(result.output ?? []), { type: "text", text: hint }] };
			},
		}),
		hook(GenerationTask, {
			// Output tokens count at every level; a level whose quota is not above zero stops its whole subtree (doc/agent-runtime.md#配额).
			afterResponse: async (message, api) => {
				const sessionId = await sessionOf(api.conversationId);
				if (!sessionId) return;
				const runtime = runtimeRef.current;
				// The provider document is written for this request; remember it for metering a later compaction.
				if (runtime) await runtime.rememberProviderSession(String(api.conversationId));
				await recordUsage(options.db, sessionId, accountedOutputTokens(message));
				const over = await exhaustedLevel(options.db, sessionId);
				// The tool calls of this response end the run (below); a response without them ends it anyway.
				if (over) {
					void options.audit?.record({
						actor: { type: "system", id: "quota" },
						action: "session.quota_exhausted",
						target: { type: "session", id: over },
					});
				}
			},
		}),
		hook(CompactionTask, {
			// Durable's summarizer runs through the metered Models; remember the session its provider id belongs to.
			beforeCompact: async (_compaction, api) => {
				await runtimeRef.current?.rememberProviderSession(String(api.conversationId));
				return undefined;
			},
		}),
	];
	const tools = TOOLS.map((tool) =>
		defineTool({
			name: tool.name,
			description: tool.description,
			parameters: Type.Unsafe(z.toJSONSchema(tool.input, { target: "draft-7" }) as Record<string, unknown>),
			// Every call is idempotent: tasks get ids derived from the durable task id, so a rerun after a restart
			// reattaches to the Cluster task its first run started (doc/agent-runtime.md#exec-工具的语义).
			replay: "safe",
			execute: async (args, api, context) => {
				const base = await toolContextFor(options, String(api.conversationId));
				// Quota at or below zero: pause this call and ask an ancestor's agent, or the owner, for more
				// (doc/agent-runtime.md#配额). A denial ends the run without another model request.
				if (await exhaustedLevel(options.db, base.actor.id)) {
					const outcome = runtimeRef.current ? await runtimeRef.current.waitForQuota(base.actor.id, context) : "denied";
					if (outcome === "denied") {
						return {
							output: [
								{
									type: "text",
									text: "The token quota is used up and no more was granted; nothing was run and the run ends here.",
								},
							],
							control: { terminate: true },
						};
					}
				}
				void options.audit?.record({
					actor: { type: base.actor.type, id: base.actor.id, onBehalfOfUserId: base.actor.onBehalfOfUserId },
					action: "tool.call",
					target: { type: "tool", id: tool.name },
					detail: { via: "session" },
				});
				const ctx: ToolContext = {
					...base,
					callKey: String(api.taskId),
					...(context.abortSignal ? { signal: context.abortSignal } : {}),
					onStatus: (status) => api.details(status as never, context),
				};
				try {
					const result = await tool.handler(args as never, ctx);
					return { output: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (err) {
					if (err instanceof UserError || err instanceof NotFoundError) throw new Error(err.message);
					throw err;
				}
			},
		}),
	);
	const subagent: ToolRegistration = defineTool({
		name: "subagent",
		description:
			"Delegate a self-contained task to a subagent: a separate session with the same tools that answers back. " +
			"Give it rules to narrow what it may do (it can never do more than you). Its approvals may come to you " +
			"(subagent_decide); in the background it returns at once and the answer comes with subagent_wait.",
		parameters: Type.Object({
			task: Type.String({ description: "What the subagent should do, with all the context it needs" }),
			rules: Type.Optional(
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description:
						'Rules on top of yours, e.g. {"default":"deny","rules":[{"action":"allow","method":"file.read"}]}; ' +
						"actions allow|deny|require-approval, methods exec|file.read|file.write, nodes, exact|prefix",
				}),
			),
			quota: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Token quota for the subagent; omitted means unlimited",
				}),
			),
			background: Type.Optional(
				Type.Boolean({ description: "Return at once with the session id; fetch the answer with subagent_wait" }),
			),
		}),
		// A rerun after a restart finds the child session and submission it made before.
		replay: "safe",
		execute: async (args, api, context) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const parent = await runtime.sessionAt(String(api.conversationId));
			if (!parent) throw new Error("this conversation is not a ClusterRightHand session");
			const rules = args.rules ? parseRuleSet(args.rules, false) : { default: "inherit" as const, rules: [] };
			const quota = args.quota === undefined ? null : parseQuota(args.quota);
			const child = await runtime.createSubagent(parent.id, {
				callKey: String(api.taskId),
				task: args.task,
				rules,
				quota,
			});
			// A UI watching the parent finds the child here.
			await api.details({ sessionId: child.id }, context);
			await runtime.startSubagent(child.id, args.task, `subagent:${String(api.taskId)}`);
			if (args.background) {
				return {
					output: [
						{
							type: "text",
							text: `Subagent started in the background (session ${child.id}). Get its answer with subagent_wait("${child.id}").`,
						},
					],
					details: { sessionId: child.id, requests: [] },
				};
			}
			const result = await runtime.waitSubagent(child.id, {
				attention: true,
				signal: context.abortSignal,
				handler: parent.id,
			});
			if (result.status === "attention") {
				const what = result.requests
					.map((r) =>
						r.kind === "quota"
							? `${r.kind} ${r.id} (${r.summary}; approve with tokens: N or deny)`
							: `${r.kind} ${r.id} (${r.summary})`,
					)
					.join("; ");
				return {
					output: [
						{
							type: "text",
							text:
								`The subagent is waiting for your decision: ${what}. ` +
								`Call subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?), then ` +
								`subagent_wait("${child.id}") for its answer.`,
						},
					],
					details: { sessionId: child.id, requests: result.requests.map(requestJson) },
				};
			}
			if (result.status === "unanswered") throw new Error(`the subagent did not answer (${result.reason})`);
			return {
				output: [{ type: "text", text: result.answer || "(no answer)" }],
				details: { sessionId: child.id, requests: [] },
			};
		},
	}) as unknown as ToolRegistration;

	const subagentWait: ToolRegistration = defineTool({
		name: "subagent_wait",
		description: "Wait for a subagent's answer; returns at once if it waits for your decision.",
		parameters: Type.Object({
			id: Type.String({ description: "The subagent's session id" }),
			attention: Type.Optional(
				Type.Boolean({ description: "Stop waiting when it needs your decision (default true)" }),
			),
		}),
		execute: async (args, api, context) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			if (!(await runtime.isDescendant(session.id, args.id))) throw new Error("not one of your subagents");
			const result = await runtime.waitSubagent(args.id, {
				attention: args.attention !== false,
				signal: context.abortSignal,
				handler: session.id,
			});
			if (result.status === "attention") {
				const what = result.requests
					.map((r) =>
						r.kind === "quota"
							? `${r.kind} ${r.id} (${r.summary}; approve with tokens: N or deny)`
							: `${r.kind} ${r.id} (${r.summary})`,
					)
					.join("; ");
				return {
					output: [{ type: "text", text: `Still waiting for your decision: ${what}.` }],
					details: { requests: result.requests.map(requestJson) },
				};
			}
			if (result.status === "unanswered") throw new Error(`the subagent did not answer (${result.reason})`);
			return { output: [{ type: "text", text: result.answer || "(no answer)" }] };
		},
	}) as unknown as ToolRegistration;

	const subagentList: ToolRegistration = defineTool({
		name: "subagent_list",
		description: "List your subagents and the requests waiting for your decision.",
		parameters: Type.Object({}),
		execute: async (_args, api) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			return {
				output: [
					{ type: "text", text: JSON.stringify({ subagents: await runtime.subagentSessions(session.id) }, null, 2) },
				],
			};
		},
	}) as unknown as ToolRegistration;

	const subagentCancel: ToolRegistration = defineTool({
		name: "subagent_cancel",
		description: "Stop one of your subagents and its running work.",
		parameters: Type.Object({ id: Type.String({ description: "The subagent's session id" }) }),
		execute: async (args, api) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			if (!(await runtime.isDescendant(session.id, args.id))) throw new Error("not one of your subagents");
			await runtime.abort(args.id);
			return { output: [{ type: "text", text: `Stopped subagent ${args.id}.` }] };
		},
	}) as unknown as ToolRegistration;

	const subagentDecide: ToolRegistration = defineTool({
		name: "subagent_decide",
		description:
			"Settle a subagent request that was handed to you: approve it, deny it, or escalate an approval to the user. " +
			"Quota requests (add tokens: N) are approved or denied only. Only requests listed by subagent_list or " +
			"attached to a tool result are yours.",
		parameters: Type.Object({
			request_id: Type.String({
				description: "The task or task group id, or the paused subagent's session id for a quota wait",
			}),
			decision: Type.Union([Type.Literal("approve"), Type.Literal("deny"), Type.Literal("escalate")]),
			reason: Type.Optional(Type.String({ description: "Why; shown to the subagent and in the audit log" })),
			tokens: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Quota requests only: tokens to add; not capped by this session's own remainder",
				}),
			),
		}),
		execute: async (args, api) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			const kind = await runtime.decideAgentRequest(
				session.id,
				args.request_id,
				args.decision,
				args.reason,
				args.tokens,
			);
			const what =
				args.decision === "escalate"
					? "passed to the user"
					: args.decision === "approve"
						? kind === "quota"
							? `granted ${args.tokens ?? 0} tokens`
							: "approved"
						: "denied";
			return { output: [{ type: "text", text: `The ${kind} request ${args.request_id} was ${what}.` }] };
		},
	}) as unknown as ToolRegistration;

	options.subagentTool = subagent;
	return defineExtension({
		name: "crh",
		tools: [...tools, subagent, subagentWait, subagentList, subagentCancel, subagentDecide],
		sections: [section("crh", () => SYSTEM_PROMPT, { tag: false })],
		hooks,
	});
}

/** Subagent sessions nest at most this deep below a root session (doc/agent-runtime.md#subagent). */
export const MAX_SUBAGENT_DEPTH = 2;

/**
 * The sessions at the subagent depth limit, with the conversation that may still offer the subagent tool:
 * `#enforceDepthToolLimits` fixes them at startup (a session created before the per-conversation filter may
 * still offer it). Walking up from the subagent rows costs one covering range scan of
 * `sessions_parent_updated_idx` for the seed, a primary-key lookup per ancestor, and one for each affected
 * session; roots and unrelated sessions are never read. A session deeper than the limit (data from an older
 * version) is reported once, at the limit, exactly like the old per-row walk.
 */
export function depthLimitedSessions() {
	return sql<{ id: string; conversation_id: string }>`
		with recursive ancestry(id, ancestor_id, depth) as (
			select id, parent_session_id, 1 from sessions where parent_session_id is not null
			union all
			select ancestry.id, parent.parent_session_id, ancestry.depth + 1
			from ancestry
			join sessions as parent on parent.id = ancestry.ancestor_id
			where ancestry.depth < ${MAX_SUBAGENT_DEPTH} and parent.parent_session_id is not null
		)
		select sessions.id, sessions.conversation_id
		from ancestry
		join sessions on sessions.id = ancestry.id
		where ancestry.depth >= ${MAX_SUBAGENT_DEPTH}
	`;
}
