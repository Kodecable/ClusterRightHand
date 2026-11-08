import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { type ConversationId, createRegistry, Harness, UsageDoc } from "@earendil-works/pi-durable";
import type { SessionUser } from "../auth/sessions.ts";
import type { RulePreset } from "../policy/rules.ts";
import { clusterExtension } from "./extension.ts";
import { ModelPresets } from "./model-presets.ts";
import type { ModelRef } from "./models.ts";
import { Reviewer } from "./review.ts";
import type { AgentRuntimeOptions, RuntimeHost, SessionEvent, SessionInfo, SessionView } from "./runtime-core.ts";
import { HandlerWakes } from "./runtime-host/handler-wakes.ts";
import { Inboxes } from "./runtime-host/inboxes.ts";
import { QuotaWaits } from "./runtime-host/quota-waits.ts";
import { SessionCaches } from "./runtime-host/session-caches.ts";
import { SessionFlags } from "./runtime-host/session-flags.ts";
import { StateRefreshes } from "./runtime-host/state-refreshes.ts";
import { chargeCompaction, decideRootQuota, rememberProviderSession, waitForQuota } from "./runtime-quota.ts";
import { decideAgentRequest, pendingAgentRequests, routeAwaiting } from "./runtime-requests.ts";
import {
	abort,
	type CreateSessionWithMessageInput,
	configure,
	createScheduledSession,
	createSession,
	createSessionWithMessage,
	entriesPage,
	findSessionByCreateRequestId,
	getSession,
	hasSubagents,
	sessionAt,
	watch,
} from "./runtime-sessions.ts";
import { endOrphanWaits, reconcileSessionStates, refreshState } from "./runtime-state.ts";
import {
	createSubagent,
	enforceDepthToolLimits,
	isDescendant,
	startSubagent,
	subagentSessions,
	waitSubagent,
} from "./runtime-subagents.ts";
import {
	type CompactTask,
	compact,
	submit,
	submitAsSchedule,
	unsettledSubmissionRequests,
	waitForSubmission,
} from "./runtime-submissions.ts";
import { SessionListHub } from "./session-list-hub.ts";
import type { SessionState } from "./session-state.ts";
import { backfillUsageTokens } from "./usage-backfill.ts";
import { wakePendingAgents } from "./wakes.ts";

/**
 * The agent runtime behind our own interface (doc/agent-runtime.md#agentruntime-抽象). In server/src, pi packages
 * are used only inside this directory and the storage adapters in server/src/storage/; the WebUI receives crh's
 * own types from `@crh/api`, converted in session-events.ts, and test/pi-boundary.test.ts keeps every other src
 * import out. One Harness over one Storage holds every session as a conversation.
 *
 * This is the facade: the public API the rest of the server calls, delegating to the modules that each own one
 * concern — session lifecycle (runtime-sessions), run state and reconciliation (runtime-state), submissions
 * (runtime-submissions), subagent requests (runtime-requests, runtime-subagents, wakes), quota waits
 * (runtime-quota) and the Harness extension (extension).
 */

export type { AgentRequestView, AgentRuntimeOptions, SessionEvent, SessionView } from "./runtime-core.ts";
export { depthLimitedSessions, MAX_SUBAGENT_DEPTH } from "./runtime-subagents.ts";

export class AgentRuntime {
	readonly #host: RuntimeHost;
	#harness: Harness;
	readonly #options: AgentRuntimeOptions;
	#closing = false;
	/** Times the Harness was reopened after a failure (tests, diagnostics). */
	reopened = 0;
	/** The instance the tools call back into; set once the Harness is open. */
	#runtimeRef: { current?: AgentRuntime } = {};
	/** Open WebUI session-list streams; writes publish here, coalesced per session. */
	readonly #sessionList: SessionListHub;
	/** The cached model presets (D116): the prompt sections and Auto Review read them synchronously. */
	readonly modelPresets: ModelPresets;

	private constructor(harness: Harness, options: AgentRuntimeOptions, presets: ModelPresets) {
		this.#harness = harness;
		this.#options = options;
		this.modelPresets = presets;
		this.#sessionList = new SessionListHub({ db: options.db, ...(options.sessionList ?? {}) });
		this.#host = {
			db: options.db,
			options,
			models: options.models,
			audit: options.audit,
			cluster: options.cluster,
			taskGroups: options.taskGroups,
			context: BACKGROUND_CONTEXT,
			sessionList: this.#sessionList,
			modelPresets: presets,
			harness: () => this.#harness,
			closing: () => this.#closing,
			sessionCaches: new SessionCaches(),
			refreshes: new StateRefreshes(),
			inboxes: new Inboxes(),
			quotaWaits: new QuotaWaits(),
			wakes: new HandlerWakes(),
			sessionFlags: new SessionFlags(),
		};
		// Custom providers fill their session id fields from the crh session id, not durable's provider id
		// (doc/agent-runtime.md#自定义提供方). Auto Review asks for the reverse: the provider session id of
		// the session whose task it judges.
		options.models.setSessionResolver(
			(providerSessionId) => this.#host.sessionCaches.providerSessionOf(providerSessionId),
			(sessionId) => this.#host.sessionCaches.providerSessionIdFor(sessionId),
		);
	}

	static async #openHarness(
		options: AgentRuntimeOptions,
		ref: { current?: AgentRuntime },
		presets: ModelPresets,
	): Promise<Harness> {
		const registry = createRegistry();
		registry.install(clusterExtension(options, ref, presets));
		const storage = typeof options.storage === "function" ? await options.storage() : options.storage;
		const harness = await Harness.open(
			storage,
			{
				// Compaction's summarization is metered here; Auto Review charges itself (doc/agent-runtime.md#配额).
				models: options.models.metered(async (providerSessionId, message, context) => {
					await ref.current?.chargeCompaction(providerSessionId, message, context);
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
		// The preset cache is loaded once, before any request: the system prompt section reads it synchronously
		// and a write refreshes it (D116).
		const presets = new ModelPresets(options.db);
		await presets.load();
		const runtime = new AgentRuntime(await AgentRuntime.#openHarness(options, ref, presets), options, presets);
		runtime.#runtimeRef = ref;
		ref.current = runtime;
		// Resume only now: a resumed run must find the runtime (compaction and tool metering look it up).
		runtime.#harness.resume(); // runs and tool calls the last process left unfinished
		// Auto Review for roots whose rule preset asks for it (tokens, sessions and schedules alike), then route child
		// approvals to an ancestor's agent where the chain allows it.
		const reviewer = new Reviewer(options.db, options.models, options.cluster, options.taskGroups, presets);
		options.cluster.onAwaitingApproval = async (task) => {
			await reviewer.reviewTask(task);
			await routeAwaiting(runtime.#host, "task", task.actorId, task.id, task.approval);
			await runtime.refreshState(task.actorId);
		};
		options.taskGroups.onAwaitingApproval = async (group) => {
			await reviewer.reviewGroup(group);
			await routeAwaiting(runtime.#host, "task_group", group.actorId, group.id, group.approval);
			await runtime.refreshState(group.actorId);
		};
		// The cluster owns the durable approval rows; refresh the actor's cached state and request lists.
		const approvalChanged = (actorId: string) => {
			runtime.#host.inboxes.clear();
			void runtime.refreshState(actorId).catch((err: unknown) => {
				console.error("agent runtime: refreshing a subagent after an approval change failed:", err);
			});
		};
		options.cluster.onChange = approvalChanged;
		options.taskGroups.onChange = approvalChanged;
		runtime.#supervise();
		// Durable has resumed the runs; correct every cached session state before requests are accepted.
		await reconcileSessionStates(runtime.#host);
		// Waits whose session's run is over (stopped or ended while crhs was down) can never be acted on.
		await endOrphanWaits(runtime.#host);
		// Sessions created before the per-conversation tool filter existed may still offer subagent at the limit.
		await enforceDepthToolLimits(runtime.#host);
		// A session that predates the statistics measure gets it from durable's persisted usage (D101).
		await backfillUsageTokens(options.db, async (conversationId) =>
			runtime.#harness.snapshot(UsageDoc, Number(conversationId) as unknown as ConversationId, BACKGROUND_CONTEXT),
		);
		// A restart may have queued nothing for requests that were already waiting: wake idle parents now.
		await wakePendingAgents(runtime.#host);
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
					this.#harness = await AgentRuntime.#openHarness(this.#options, this.#runtimeRef, this.modelPresets);
					this.#harness.resume();
					this.#host.inboxes.clear();
					this.reopened++;
				} catch (err) {
					console.error("agent runtime: reopening failed:", err);
					continue;
				}
				this.#supervise();
				// The failed Harness rejected every pending wait, so no settlement wrote `idle` and no watch is
				// armed any more. Correct the states and re-arm the watches exactly as open() does, and end the
				// waits of the sessions whose run is over: nothing can decide them any more.
				try {
					await reconcileSessionStates(this.#host);
					await endOrphanWaits(this.#host);
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
		await this.#harness.close(this.#host.context);
		this.#sessionList.close();
	}

	// ---- sessions (runtime-sessions) ----

	async createSession(
		owner: SessionUser,
		input: {
			title?: string;
			model: ModelRef;
			rulePreset: RulePreset;
			instructions?: string;
			budgetRemaining?: number | null;
		},
	): Promise<SessionView> {
		return createSession(this.#host, owner, input);
	}

	async getSession(id: string): Promise<SessionView | undefined> {
		return getSession(this.#host, id);
	}
	/** Creates a session and submits its first message in one idempotent request (D117). */
	async createSessionWithMessage(
		owner: SessionUser,
		input: CreateSessionWithMessageInput,
	): Promise<{ session: SessionView; created: boolean }> {
		return createSessionWithMessage(this.#host, owner, input);
	}

	/** The session a user already created with this request id (D117). */
	async findSessionByCreateRequestId(ownerUserId: string, requestId: string): Promise<SessionView | undefined> {
		return findSessionByCreateRequestId(this.#host, ownerUserId, requestId);
	}

	async createScheduledSession(
		owner: SessionUser,
		input: { id: string; title: string; model: ModelRef; budgetRemaining: number | null; scheduleId: string },
	): Promise<SessionView> {
		return createScheduledSession(this.#host, owner, input);
	}

	async configure(
		sessionId: string,
		change: { title?: string; model?: ModelRef; rulePreset?: RulePreset; budgetRemaining?: number | null },
	): Promise<SessionView> {
		return configure(this.#host, sessionId, change);
	}

	/** Stops the current run: queued inputs are withdrawn and running tool calls aborted. */
	async abort(sessionId: string, by?: SessionUser): Promise<void> {
		return abort(this.#host, sessionId, by);
	}

	/**
	 * Streams the session's events: `onEvents` first gets a snapshot event, then batches as commits land.
	 * Returns a function that stops the stream.
	 */
	async watch(sessionId: string, onEvents: (events: SessionEvent[]) => Promise<void> | void, signal?: AbortSignal) {
		return watch(this.#host, sessionId, onEvents, signal);
	}

	/** A page of a session's history for `GET /sessions/:id/entries`, oldest first. */
	async entriesPage(sessionId: string, before: number | undefined, limit: number) {
		return entriesPage(this.#host, sessionId, before, limit);
	}

	/** The session a conversation belongs to, for tool calls that only know their conversation id. */
	async sessionAt(conversationId: string): Promise<SessionInfo | undefined> {
		return sessionAt(this.#host, conversationId);
	}

	/** Whether the session's tools need to look for subagent requests; cached after the first check. */
	async hasSubagents(sessionId: string): Promise<boolean> {
		return hasSubagents(this.#host, sessionId);
	}

	// ---- submissions and run state (runtime-submissions, runtime-state) ----

	/**
	 * Hands the user's message to the session; it runs at once or queues behind the current run. `requestId`
	 * makes a retried submit find the first one.
	 */
	async submit(sessionId: string, by: SessionUser, text: string, requestId: string): Promise<string> {
		return submit(this.#host, sessionId, by, text, requestId);
	}

	/** Manually compacts the session; the summary is made in the background (doc/agent-runtime.md#会话). */
	async compact(sessionId: string, by: SessionUser, instructions?: string): Promise<CompactTask> {
		return compact(this.#host, sessionId, by, instructions);
	}

	/** Submits a schedule run's fixed prompt (doc/scheduling.md#调度). */
	async submitAsSchedule(
		sessionId: string,
		scheduleId: string,
		text: string,
		requestId: string,
		options: { checkQuota?: boolean } = {},
	): Promise<string> {
		return submitAsSchedule(this.#host, sessionId, scheduleId, text, requestId, options);
	}

	/** Recomputes a session's state from durable and its wait sources (doc/agent-runtime.md#会话状态). */
	async refreshState(sessionId: string): Promise<SessionState> {
		return refreshState(this.#host, sessionId);
	}

	/** Waits for a submission to settle and says how it ended, without reading or committing its answer. */
	async waitForSubmission(
		submissionId: string,
		signal?: AbortSignal,
	): Promise<{ status: "done" } | { status: "unanswered"; reason: string }> {
		return waitForSubmission(this.#host, submissionId, signal);
	}

	/** Request ids of the submissions still queued or placed after a restart (doc/scheduling.md#调度). */
	async unsettledSubmissionRequests(): Promise<Set<string>> {
		return unsettledSubmissionRequests(this.#host);
	}

	// ---- subagents (runtime-subagents, runtime-requests) ----

	/** Creates (or, on a rerun of the same tool call, finds) a subagent's session (doc/agent-runtime.md#subagent). */
	async createSubagent(
		parentId: string,
		input: {
			callKey: string;
			task: string;
			rules: Parameters<typeof createSubagent>[2]["rules"];
			quota: number | null;
			model?: ModelRef;
		},
	): Promise<{ id: string; created: boolean }> {
		return createSubagent(this.#host, parentId, input);
	}

	/** Hands the parent's task text to the child; a rerun with the same requestId does not send it twice. */
	async startSubagent(childId: string, text: string, requestId: string): Promise<string> {
		return startSubagent(this.#host, childId, text, requestId);
	}

	/** Waits for the child's answer, or returns when a request needs this session's agent (doc/agent-runtime.md#subagent). */
	async waitSubagent(
		childId: string,
		options: { attention?: boolean; signal?: AbortSignal; handler?: string } = {},
	): ReturnType<typeof waitSubagent> {
		return waitSubagent(this.#host, childId, options);
	}

	/** The session's subagents, newest first, with what waits for this session's agent. */
	async subagentSessions(sessionId: string): ReturnType<typeof subagentSessions> {
		return subagentSessions(this.#host, sessionId);
	}

	/** True when `childId` is this session's own subagent or below one (so it may wait for or stop it). */
	async isDescendant(sessionId: string, childId: string): Promise<boolean> {
		return isDescendant(this.#host, sessionId, childId);
	}

	/** Requests waiting for this session's agent (doc/access-control.md#审批). */
	async pendingAgentRequests(sessionId: string) {
		return pendingAgentRequests(this.#host, sessionId);
	}

	/** The agent of `sessionId` settles a request it owns: approve, deny, or pass it on to the user. */
	async decideAgentRequest(
		sessionId: string,
		requestId: string,
		decision: "approve" | "deny" | "escalate",
		reason?: string,
		tokens?: number,
	): Promise<"task" | "task_group" | "quota"> {
		return decideAgentRequest(this.#host, sessionId, requestId, decision, reason, tokens);
	}

	// ---- quota waits and metering (runtime-quota) ----

	/** The owner's answer to a root whose quota is used up (doc/agent-runtime.md#配额). */
	async decideRootQuota(rootId: string, decision: "approve" | "deny", tokens?: number): Promise<string[]> {
		return decideRootQuota(this.#host, rootId, decision, tokens);
	}

	/** Pauses a tool call whose chain quota is used up (doc/agent-runtime.md#配额). */
	async waitForQuota(sessionId: string, context: Context): Promise<"ok" | "denied"> {
		return waitForQuota(this.#host, sessionId, context);
	}

	/** Remembers which session owns a conversation's provider session id, for metering its compaction (D92). */
	async rememberProviderSession(conversationId: string): Promise<void> {
		return rememberProviderSession(this.#host, conversationId);
	}

	/** Charges a compaction's summarization to the session it compacted (D92, D101). */
	async chargeCompaction(
		providerSessionId: string,
		message: Parameters<typeof chargeCompaction>[2],
		context: Parameters<typeof chargeCompaction>[3],
	): Promise<void> {
		return chargeCompaction(this.#host, providerSessionId, message, context);
	}

	/** Waits until nothing in the Harness runs (tests). */
	async waitForIdle(): Promise<void> {
		await this.#harness.waitForIdle(this.#host.context);
	}
}
