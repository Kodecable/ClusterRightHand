import type { ChatAttachment, JobNotice, SessionExtension as SessionExtensionView } from "@crh/api";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	createRegistry,
	type Extension,
	Harness,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SessionUser } from "../auth/sessions.ts";
import { pendingReviewIn } from "../cluster/approval.ts";
import type { Actor } from "../cluster/types.ts";
import { externalCallApproval, getExternalCall } from "../extensions/external-calls.ts";
import { extensionOf } from "../extensions/registry.ts";
import { getExtensionRow, listExtensionRows } from "../extensions/store.ts";
import { createJobs } from "../jobs/jobs.ts";
import type { JobRow } from "../jobs/types.ts";
import type { Rule, RulePreset } from "../policy/rules.ts";
import type { RuleApprovalRequest } from "../terminals/approval.ts";
import { TodoLists } from "../todos/todos.ts";
import { TOOLS } from "../tools/catalog.ts";
import { execJobRenderers } from "../tools/job-renderers.ts";
import { KeyedQueue } from "../util/keyed-queue.ts";
import { clusterExtension, directToolsExtension, sessionExtensionViews, syncSessionExtensions } from "./extension.ts";
import { GenerationTimings } from "./latency.ts";
import { ModelPresets } from "./model-presets.ts";
import { CLIENT_IDENTITY, type ModelRef } from "./models.ts";
import { Reviewer } from "./review.ts";
import type { AgentRuntimeOptions, RuntimeHost, SessionEvent, SessionInfo, SessionView } from "./runtime-core.ts";
import { HandlerWakes } from "./runtime-host/handler-wakes.ts";
import { Inboxes } from "./runtime-host/inboxes.ts";
import { NoticeActivity } from "./runtime-host/notice-activity.ts";
import { QuotaWaits } from "./runtime-host/quota-waits.ts";
import { SessionCaches } from "./runtime-host/session-caches.ts";
import { SessionFlags } from "./runtime-host/session-flags.ts";
import { StateRefreshes } from "./runtime-host/state-refreshes.ts";
import { chargeCompaction, decideRootQuota, rememberProviderSession, waitForQuota } from "./runtime-quota.ts";
import { decideAgentRequest, pendingAgentRequests, routeAwaiting } from "./runtime-requests.ts";
import {
	abort,
	type ChatHistoryMessage,
	type CreateSessionWithMessageInput,
	chatHistory,
	configure,
	createScheduledSession,
	createSession,
	createSessionWithMessage,
	entriesPage,
	type ForkSessionInput,
	findSessionByCreateRequestId,
	forkSession,
	getSession,
	hasSubagents,
	latestEntryId,
	outlinePage,
	type RunReportContent,
	reviewHistory,
	reviewToolCall,
	runReport,
	type SessionStopOptions,
	sessionAt,
	transcriptEntries,
	watch,
} from "./runtime-sessions.ts";
import { endOrphanWaits, reconcileSessionStates, refreshState } from "./runtime-state.ts";
import {
	createSubagent,
	isDescendant,
	startSubagent,
	subagentJobAnswer,
	subagentJobRequestsBlock,
	subagentJobState,
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
import { streamSessionId } from "./stream-session-id.ts";
import {
	jobNoticeBusy,
	jobNoticeSettled,
	noticeWakeAvailable,
	takePendingJobNotices,
	waitForSessionQuiet,
	wakePendingAgents,
	wakePendingJobNotices,
} from "./wakes.ts";

/**
 * The agent runtime behind our own interface (doc/design/agent-runtime.md "The AgentRuntime interface"). In server/src, pi packages
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
export { MAX_SUBAGENT_DEPTH } from "./runtime-subagents.ts";

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
	/** The cached model presets: the prompt sections and Auto Review read them synchronously. */
	readonly modelPresets: ModelPresets;
	/** The registry, so MCP server extensions can be installed and replaced when their tool list changes. */
	readonly #registry: Registry<ToolRegistration>;
	/** Every installed extension by name: `crh` and one `ext:<extension>` per extension. */
	readonly #extensions: Map<string, Extension>;
	/** Told after any approval row changed, whoever the actor is (an API token has no session to refresh). */
	#approvalListener: ((actorId: string) => void) | undefined;

	private constructor(
		harness: Harness,
		options: AgentRuntimeOptions,
		presets: ModelPresets,
		registry: Registry<ToolRegistration>,
		extensions: Map<string, Extension>,
	) {
		this.#harness = harness;
		this.#options = options;
		this.modelPresets = presets;
		this.#registry = registry;
		this.#extensions = extensions;
		this.#sessionList = new SessionListHub({ db: options.db, ...(options.sessionList ?? {}) });
		this.#host = {
			db: options.db,
			options,
			models: options.models,
			audit: options.audit,
			cluster: options.cluster,
			taskGroups: options.taskGroups,
			jobs: options.jobs,
			callRunner: options.callRunner,
			imageCache: options.imageCache,
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
			noticeDelivery: new KeyedQueue("job notice delivery"),
			noticeActivity: new NoticeActivity(),
			sessionFlags: new SessionFlags(),
			generationTimings: new GenerationTimings(),
			extensionsFor: (serverNames) => this.#extensionsFor(serverNames),
		};
		// The extension is built before the runtime and the Harness's metered Models resolve the map per request;
		// both read it through the options, so every Harness (a reopen included) shares this instance
		// (doc/design/agent-runtime.md "Session statistics").
		options.generationTimings = this.#host.generationTimings;
		// Custom providers fill their session id fields from the crh session id, not durable's provider id
		// (doc/design/agent-runtime.md "Custom providers"). Auto Review asks for the reverse: the provider session id of
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
		registry: Registry<ToolRegistration>,
		extensions: Map<string, Extension>,
	): Promise<Harness> {
		const crh = clusterExtension(options, ref, presets);
		registry.install(crh);
		extensions.set("crh", crh);
		const storage = typeof options.storage === "function" ? await options.storage() : options.storage;
		const harness = await Harness.open(
			storage,
			{
				// Compaction's summarization is metered here; Auto Review charges itself (doc/design/agent-runtime.md "Quota and token accounting").
				// Generation streams are timed as they run, independently of any viewer
				// (doc/design/agent-runtime.md "Session statistics").
				models: options.models.metered(
					async (providerSessionId, message, context) => {
						await ref.current?.chargeCompaction(providerSessionId, message, context);
					},
					() => options.generationTimings,
					// Compaction is its own request stream: durable's provider session id becomes the session's
					// compaction id, or a derived id while the mapping is unknown.
					(providerSessionId) =>
						ref.current?.compactionStreamId(providerSessionId) ?? streamSessionId(providerSessionId, "compaction"),
				),
				registry,
				identity: CLIENT_IDENTITY,
				settings: {
					// pi's coding-agent defaults (doc/design/agent-runtime.md "Defaults").
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
		// The job service first: the tools that start jobs read it through the options, and the startup
		// reconciliation runs before requests are served (doc/design/jobs.md "Job model").
		const jobs =
			options.jobs ??
			createJobs({
				db: options.db,
				cluster: options.cluster,
				taskGroups: options.taskGroups,
				execRenderers: execJobRenderers,
				callRunner: options.callRunner,
				...(options.audit ? { audit: options.audit } : {}),
			});
		options.jobs = jobs;
		// The todo change bus: the tool writes through it and the session event stream forwards the writes.
		const todoLists = options.todoLists ?? new TodoLists();
		options.todoLists = todoLists;
		// The preset cache is loaded once, before any request: the system prompt section reads it synchronously
		// and a write refreshes it.
		const presets = new ModelPresets(options.db);
		await presets.load();
		const registry = createRegistry();
		const extensions = new Map<string, Extension>();
		const runtime = new AgentRuntime(
			await AgentRuntime.#openHarness(options, ref, presets, registry, extensions),
			options,
			presets,
			registry,
			extensions,
		);
		runtime.#runtimeRef = ref;
		ref.current = runtime;
		// The subagent adapter needs the runtime's waits, stop and answer; everything else about a child is read
		// from its row (doc/design/jobs.md "Adapters").
		jobs.attachSubagent({
			project: (childId) => subagentJobState(runtime.#host, childId),
			wait: async (childId, waitOptions) => {
				const result = await waitSubagent(runtime.#host, childId, {
					attention: waitOptions.attention,
					...(waitOptions.signal ? { signal: waitOptions.signal } : {}),
					...(waitOptions.handler ? { handler: waitOptions.handler } : {}),
				});
				if (result.status === "attention") return { status: "attention" };
				if (result.status === "done") return { status: "done" };
				return { status: "unanswered", reason: result.reason };
			},
			cancel: async (childId, by) => {
				await abort(runtime.#host, childId, sessionUserForActor(by), { source: "internal" });
				return true;
			},
			noticeBusy: (childId) => jobNoticeBusy(runtime.#host, childId),
			noticeWakeAvailable: (childId) => noticeWakeAvailable(runtime.#host, childId),
			answer: (childId) => subagentJobAnswer(runtime.#host, childId),
			requestsBlock: (childId) => subagentJobRequestsBlock(runtime.#host, childId),
		});
		// A settled job whose notice no live wait collected wakes its owner or waits for the next tool result
		// (doc/design/jobs.md "Completion notices"). The runtime supplies the delivery; the job layer only says
		// when a job settled.
		jobs.attachNoticeSink((job) => jobNoticeSettled(runtime.#host, job));
		// A job is part of its session tree's list item (doc/design/webui.md "Session list API"): its creation,
		// every state or wait change and its settle publish the tree's root through the same coalesced path a
		// session state change takes. A job a subagent started publishes its own session, which resolves to the
		// root below; an MCP client's job has no session and stays out of the list.
		jobs.onChanged((job) => {
			if (job.session_id !== null) runtime.#sessionList.publishSession(job.session_id);
		});
		// One extension per row, empty until its first tool listing arrives: a session selects the extensions
		// it may use by name, and the tools appear once the MCP server is connected or the built-in supplies
		// them (doc/design/extensions.md).
		for (const row of await listExtensionRows(options.db)) {
			runtime.installExtensionTools(row, extensionOf(row, options.mcp)?.tools() ?? []);
		}
		options.mcp?.setToolsChangedHandler((row, tools) => runtime.installExtensionTools(row, tools));
		// Auto Review for roots whose rule preset asks for it (tokens and sessions), then route child approvals to an
		// ancestor's agent where the chain allows it.
		const reviewer = new Reviewer(
			options.db,
			options.models,
			options.cluster,
			options.taskGroups,
			presets,
			{
				history: (sessionId) => reviewHistory(runtime.#host, sessionId),
				toolCall: (sessionId, toolTaskId) => reviewToolCall(runtime.#host, sessionId, toolTaskId),
				builtinToolDescription: async (toolName) => {
					return TOOLS.find((tool) => tool.name === toolName)?.description ?? null;
				},
				toolDescription: async (extensionName, toolName) => {
					const row = await getExtensionRow(options.db, extensionName);
					return row
						? (extensionOf(row, options.mcp)
								?.tools()
								.find((tool) => tool.name === toolName)?.description ?? null)
						: null;
				},
			},
			options.audit,
		);
		// The cluster owns the durable approval rows; refresh the actor's cached state and request lists.
		const approvalChanged = (actorId: string) => {
			// An approval that settles during shutdown (endWaits, the terminal service) must not read the
			// closing Harness: the next process reconciles every state at startup (reconcileSessionStates).
			if (runtime.#closing) return;
			runtime.#host.inboxes.clear();
			void runtime.refreshState(actorId).catch((err: unknown) => {
				console.error("agent runtime: refreshing a subagent after an approval change failed:", err);
			});
			// Channels also follow requests without a session (an API token's or a user's direct task).
			runtime.#approvalListener?.(actorId);
		};
		options.approvalChanged = approvalChanged;
		options.willReview = (chain) => reviewer.willReview(chain);
		options.cluster.onReviewPlanned = options.willReview;
		options.reviewPty = async (actor, request: RuleApprovalRequest, screen: string) =>
			reviewer.reviewTerminalRequest(actor, request, screen);
		options.reviewExternalCall = async (id, signal) => {
			await reviewer.reviewExternalCall(id, signal);
			// The call may have been approved (running), escalated or dropped its marker: the session's
			// wait and the chat notification follow the row now (doc/design/agent-runtime.md "Session state").
			const row = await getExternalCall(options.db, id);
			if (row?.actor_type === "session" || row?.actor_type === "subagent") approvalChanged(row.actor_id);
		};
		// A waiting external call goes up the chain like a task; only when no ancestor agent takes it does
		// Auto Review (and otherwise the owner) decide (doc/design/access-control.md "Approvals").
		options.routeExternalCall = async (id) => {
			const row = await getExternalCall(options.db, id);
			if (row?.state !== "awaiting_approval") return row?.handler_type === "agent";
			if (row.handler_type === "agent") return true;
			const routed = await routeAwaiting(runtime.#host, "external_call", row.actor_id, id, externalCallApproval(row));
			// The handler's cached request list did not have this request before it was routed.
			if (routed) runtime.#host.inboxes.clear();
			return routed;
		};
		options.cluster.onAwaitingApproval = async (task, signal) => {
			await reviewer.reviewTask(task, signal);
			await routeAwaiting(runtime.#host, "task", task.actorId, task.id, task.approval);
			await runtime.refreshState(task.actorId);
		};
		options.taskGroups.onAwaitingApproval = async (group, signal) => {
			await reviewer.reviewGroup(group, signal);
			await routeAwaiting(runtime.#host, "task_group", group.actorId, group.id, group.approval);
			await runtime.refreshState(group.actorId);
		};
		options.cluster.onChange = approvalChanged;
		options.taskGroups.onChange = approvalChanged;
		// Resume only now: a resumed run finds the runtime (compaction and tool metering look it up) and the
		// review hooks above, so it cannot create a marked request nobody reviews.
		runtime.#harness.resume(); // runs and tool calls the last process left unfinished
		runtime.#supervise();
		// Durable has resumed the runs; correct every cached session state before requests are accepted.
		await reconcileSessionStates(runtime.#host);
		// Waits whose session's run is over (stopped or ended while crhs was down) can never be acted on.
		await endOrphanWaits(runtime.#host);
		// Every unsettled job is reconciled with its record before requests are served (doc/design/jobs.md).
		await jobs.reconcile();
		// Reviews cut short by the last process run again: a pending marker is durable, the review is not.
		void resumePendingReviews(options).catch((err: unknown) => {
			console.error("agent runtime: resuming pending reviews failed:", err);
		});
		// A restart may have queued nothing for requests that were already waiting: wake idle parents now.
		await wakePendingAgents(runtime.#host);
		// Completion notices of jobs that settled while crhs was down reach their owners the same way.
		await wakePendingJobNotices(runtime.#host);
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
					this.#harness = await AgentRuntime.#openHarness(
						this.#options,
						this.#runtimeRef,
						this.modelPresets,
						this.#registry,
						this.#extensions,
					);
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
					await this.#options.jobs?.reconcile();
					void resumePendingReviews(this.#options).catch((err: unknown) => {
						console.error("agent runtime: resuming pending reviews failed:", err);
					});
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

	/** How many provider sessions hold an unfinished timing (tests): it must not outlive the message. */
	get pendingTimingCount(): number {
		return this.#host.generationTimings.size;
	}

	/** The job service this runtime uses, so an HTTP surface built beside it shares one projection queue. */
	get jobs() {
		return this.#options.jobs;
	}

	/** The todo change bus, so the session event stream forwards `todo.changed` (doc/design/todo.md "API"). */
	get todoLists(): TodoLists {
		return this.#options.todoLists as TodoLists;
	}

	/** The session list's event hub, for `GET /api/sessions` and `GET /api/sessions/stream`. */
	get sessionList(): SessionListHub {
		return this.#sessionList;
	}

	/** The extensions a session selects: the crh extension and the extensions it may use. */
	#extensionsFor(extensionNames: readonly string[]): Extension[] {
		const selected: Extension[] = [];
		const crh = this.#extensions.get("crh");
		if (crh) selected.push(crh);
		for (const name of extensionNames) {
			const extension = this.#extensions.get(`ext:${name}`);
			if (extension) selected.push(extension);
		}
		return selected;
	}

	/**
	 * Installs or replaces one extension's direct tools (doc/design/extensions.md "Tools for the model"). Only an
	 * enabled extension marked "list directly" contributes its tools; other extensions keep an empty
	 * extension, so a session can select the extension by name and its tools never reach the model's tool
	 * list. A disabled extension loses its tools at once, even in a session whose selection has not been
	 * recomputed yet.
	 */
	installExtensionTools(
		row: { name: string; list_directly: number; enabled: number },
		tools: Parameters<typeof directToolsExtension>[3],
	): void {
		const extension = directToolsExtension(
			this.#options,
			this.#runtimeRef,
			row.name,
			row.list_directly === 1 && row.enabled === 1 ? tools : [],
		);
		this.#registry.install(extension);
		this.#extensions.set(`ext:${row.name}`, extension);
	}

	/**
	 * Re-selects a session's extensions from the rows read now, so a grant, an enable/disable or a session
	 * change applies from the next request (doc/design/extensions.md "Extensions"). The conversation is only
	 * written when the selection actually changed.
	 */
	async syncExtensions(conversationId: string): Promise<void> {
		const row = await this.#options.db
			.selectFrom("sessions")
			.select(["id", "conversation_id", "owner_user_id", "disabled_extensions"])
			.where("conversation_id", "=", conversationId)
			.executeTakeFirst();
		if (row) await syncSessionExtensions(this.#host, row);
	}

	/**
	 * Rebuilds the cluster extension with the current settings: the pty tools disappear from the next
	 * request while the terminal subsystem is off, and come back when it is turned on.
	 */
	setTerminalToolsEnabled(_enabled: boolean): void {
		const replacement = clusterExtension(this.#options, this.#runtimeRef, this.modelPresets);
		this.#registry.install(replacement);
		this.#extensions.set("crh", replacement);
	}

	/** Removes an extension's direct tools after an administrator deletes it or turns it off for all sessions. */
	removeExtension(name: string): void {
		const extension = this.#extensions.get(`ext:${name}`);
		if (!extension) return;
		this.#extensions.delete(`ext:${name}`);
		this.#registry.uninstall(extension);
	}

	async close(): Promise<void> {
		this.#closing = true;
		// A state refresh already in flight may still read the Harness (`inputSettled`), so it must finish before
		// the Harness closes; none races the close. A refresh requested from here on skips the Harness
		// (`refreshState`), and the next process reconciles every state at startup (`reconcileSessionStates`).
		await this.#host.refreshes.drain();
		this.#host.generationTimings.clearAll();
		await this.#harness.close(this.#host.context);
		this.#sessionList.close();
		// Projections started by record changes are awaited before the database closes (doc/design/jobs.md).
		await this.#options.jobs?.drain();
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
			disabledExtensions?: string[];
		},
	): Promise<SessionView> {
		return createSession(this.#host, owner, input);
	}

	/**
	 * The extensions a new session of this user reaches, all on (doc/design/extensions.md "Extensions"). The draft
	 * page offers its toggles from this list, which is the same resolution a created session's `extensions` uses.
	 */
	async availableExtensions(ownerUserId: string): Promise<SessionExtensionView[]> {
		return sessionExtensionViews(this.#options, ownerUserId, []);
	}

	async getSession(id: string): Promise<SessionView | undefined> {
		return getSession(this.#host, id);
	}

	/** The last messages a chat replays when it switches to a session (doc/design/channels.md "Conversations"). */
	async chatHistory(id: string, limit = 10): Promise<ChatHistoryMessage[]> {
		return chatHistory(this.#host, id, limit);
	}

	/** A finished run's report content: its first turn's final reply and the files it offered (doc/design/scheduling.md "Reports"). */
	async runReport(sessionId: string): Promise<RunReportContent> {
		return runReport(this.#host, sessionId);
	}

	/** Follows session run-state changes, for chat channels that send approvals and progress. */
	onSessionStateChanged(listener: ((sessionId: string) => void) | undefined): void {
		this.#host.stateChanged = listener;
	}

	/**
	 * Follows placed completion notices, for chat channels that send the notice line where the session's text
	 * goes (doc/design/channels.md "Notifications").
	 */
	onJobNotices(listener: ((sessionId: string, notices: readonly JobNotice[]) => void) | undefined): void {
		this.#host.jobNoticePlaced = listener;
	}

	/** A busy session's pending completion notices, marked delivered; the next tool result carries them. */
	async takePendingJobNotices(sessionId: string): Promise<JobRow[]> {
		return takePendingJobNotices(this.#host, sessionId);
	}

	/**
	 * Waits until the session is idle and owns no unsettled job, and no completion notice can still start a
	 * turn: a scheduled run is final only then (doc/design/scheduling.md "Finish").
	 */
	async waitForSessionQuiet(sessionId: string, signal?: AbortSignal): Promise<void> {
		await waitForSessionQuiet(this.#host, sessionId, signal);
	}

	/**
	 * Follows every approval change by actor id, for chat channels. Unlike `onSessionStateChanged` this also
	 * reports a request made by an API token or a user directly, which has no session to refresh.
	 */
	onApprovalChanged(listener: ((actorId: string) => void) | undefined): void {
		this.#approvalListener = listener;
	}
	/** Creates a session and submits its first message in one idempotent request. */
	async createSessionWithMessage(
		owner: SessionUser,
		input: CreateSessionWithMessageInput,
	): Promise<{ session: SessionView; created: boolean }> {
		return createSessionWithMessage(this.#host, owner, input);
	}

	/** The session a user already created with this request id. */
	async findSessionByCreateRequestId(ownerUserId: string, requestId: string): Promise<SessionView | undefined> {
		return findSessionByCreateRequestId(this.#host, ownerUserId, requestId);
	}

	/** Forks a session at one of its final replies into a new root (doc/design/agent-runtime.md "Forking"). */
	async forkSession(
		owner: SessionUser,
		sourceId: string,
		input: ForkSessionInput,
	): Promise<{ session: SessionView; created: boolean }> {
		return forkSession(this.#host, owner, sourceId, input);
	}

	async createScheduledSession(
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
		return createScheduledSession(this.#host, owner, input);
	}

	async configure(
		sessionId: string,
		change: {
			title?: string;
			model?: ModelRef;
			rulePreset?: RulePreset;
			budgetRemaining?: number | null;
			disabledExtensions?: string[];
		},
	): Promise<SessionView> {
		return configure(this.#host, sessionId, change);
	}

	/** Stops the current run: queued inputs are withdrawn and running tool calls aborted. */
	async abort(sessionId: string, by?: SessionUser, stop?: SessionStopOptions): Promise<void> {
		return abort(this.#host, sessionId, by, stop);
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

	/** A page of a session's user messages for `GET /sessions/:id/outline`, oldest first. */
	async outlinePage(sessionId: string, before: number | undefined, limit: number, budget?: number) {
		return outlinePage(this.#host, sessionId, before, limit, budget);
	}

	/** The newest visible entry id of a conversation, for per-conversation derived state (the image hook). */
	async latestEntryId(conversationId: string): Promise<number | undefined> {
		return latestEntryId(this.#host, conversationId);
	}

	/** A conversation's transcript entries, oldest first, for per-conversation derived state (the image hook). */
	async transcriptEntries(conversationId: string) {
		return transcriptEntries(this.#host, conversationId);
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
	 * makes a retried submit find the first one. `lastUsedFrom` says where the message came from: `web`, a
	 * chat thread id, or null for a submitter that is neither the WebUI nor a chat.
	 */
	async submit(
		sessionId: string,
		by: SessionUser,
		text: string,
		requestId: string,
		options: {
			content?: { type: "text"; text: string }[];
			attachments?: ChatAttachment[];
			lastUsedFrom?: string | null;
			timeZone?: string;
		} = {},
	): Promise<string> {
		return submit(this.#host, sessionId, by, text, requestId, options);
	}

	/** Manually compacts the session; the summary is made in the background (doc/design/agent-runtime.md "Sessions"). */
	async compact(sessionId: string, by: SessionUser, instructions?: string): Promise<CompactTask> {
		return compact(this.#host, sessionId, by, instructions);
	}

	/** Submits a schedule run's fixed prompt (doc/design/scheduling.md "Triggering and submission"). */
	async submitAsSchedule(
		sessionId: string,
		scheduleId: string,
		text: string,
		requestId: string,
		options: { checkQuota?: boolean; timeZone?: string } = {},
	): Promise<string> {
		return submitAsSchedule(this.#host, sessionId, scheduleId, text, requestId, options);
	}

	/** Recomputes a session's state from durable and its wait sources (doc/design/agent-runtime.md "Session state"). */
	async refreshState(sessionId: string): Promise<SessionState> {
		return refreshState(this.#host, sessionId);
	}

	/** Runs the reviews a previous process left pending; startup calls this, and so may a reopened runtime. */
	async resumePendingReviews(): Promise<void> {
		return resumePendingReviews(this.#options);
	}

	/** Waits for a submission to settle and says how it ended, without reading or committing its answer. */
	async waitForSubmission(
		submissionId: string,
		signal?: AbortSignal,
	): Promise<{ status: "done" } | { status: "unanswered"; reason: string }> {
		return waitForSubmission(this.#host, submissionId, signal);
	}

	/** Request ids of the submissions still queued or placed after a restart (doc/design/scheduling.md "Triggering and submission"). */
	async unsettledSubmissionRequests(): Promise<Set<string>> {
		return unsettledSubmissionRequests(this.#host);
	}

	// ---- subagents (runtime-subagents, runtime-requests) ----

	/** Creates (or, on a rerun of the same tool call, finds) a subagent's session (doc/design/agent-runtime.md "Subagents"). */
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

	/** Waits for the child's answer, or returns when a request needs this session's agent (doc/design/agent-runtime.md "Subagents"). */
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

	/** Requests waiting for this session's agent (doc/design/access-control.md "Approvals"). */
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
	): Promise<"task" | "task_group" | "quota" | "external_call"> {
		return decideAgentRequest(this.#host, sessionId, requestId, decision, reason, tokens);
	}

	// ---- quota waits and metering (runtime-quota) ----

	/** The owner's answer to a root whose quota is used up (doc/design/agent-runtime.md "Quota and token accounting"). */
	async decideRootQuota(rootId: string, decision: "approve" | "deny", tokens?: number): Promise<string[]> {
		return decideRootQuota(this.#host, rootId, decision, tokens);
	}

	/** Pauses a tool call whose chain quota is used up (doc/design/agent-runtime.md "Quota and token accounting"). */
	async waitForQuota(sessionId: string, context: Context): Promise<"ok" | "denied"> {
		return waitForQuota(this.#host, sessionId, context);
	}

	/** Remembers which session owns a conversation's provider session id, for metering its compaction. */
	async rememberProviderSession(conversationId: string): Promise<void> {
		return rememberProviderSession(this.#host, conversationId);
	}

	/**
	 * The compaction stream id of a provider session id: the mapped crh session's derived id, else one derived
	 * from the provider session id itself (doc/design/agent-runtime.md "Custom providers").
	 */
	compactionStreamId(providerSessionId: string): string {
		return streamSessionId(
			this.#host.sessionCaches.providerSessionOf(providerSessionId) ?? providerSessionId,
			"compaction",
		);
	}

	/** Charges a compaction's summarization to the session it compacted. */
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

/**
 * Replays the reviews a previous process did not finish: a task, task group or external call still in
 * `awaiting_approval` with the pending marker is judged again through the ordinary hook (which also routes it
 * and refreshes its session). The reviewer's single-flight keeps a tool call that replays at the same time from
 * judging it twice (doc/design/access-control.md "Auto Review"). Startup does not wait for the review: it may
 * take until the stream limits.
 */
async function resumePendingReviews(options: AgentRuntimeOptions): Promise<void> {
	const tasks = await options.db
		.selectFrom("tasks")
		.select(["id", "approval"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.execute();
	for (const row of tasks) {
		if (!pendingReviewIn(row.approval)) continue;
		const view = await options.cluster.getTask(row.id);
		if (view) {
			void options.cluster.onAwaitingApproval?.(view).catch((err: unknown) => {
				console.error(`agent runtime: resuming the review of task ${row.id} failed:`, err);
			});
		}
	}
	const groups = await options.db
		.selectFrom("task_groups")
		.select(["id", "approval"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.execute();
	for (const row of groups) {
		if (!pendingReviewIn(row.approval)) continue;
		const view = await options.taskGroups.get(row.id);
		if (view) {
			void options.taskGroups.onAwaitingApproval?.(view).catch((err: unknown) => {
				console.error(`agent runtime: resuming the review of task group ${row.id} failed:`, err);
			});
		}
	}
	const calls = await options.db
		.selectFrom("external_calls")
		.select(["id", "approval"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.execute();
	for (const row of calls) {
		if (!pendingReviewIn(row.approval)) continue;
		// A call goes up the chain first, as it does when it is created: an ancestor agent may take it,
		// and Auto Review only judges it when none does.
		void (async () => {
			if (await options.routeExternalCall?.(row.id)) {
				const routed = await getExternalCall(options.db, row.id);
				if (routed?.actor_type === "session" || routed?.actor_type === "subagent")
					options.approvalChanged?.(routed.actor_id);
				return;
			}
			await options.reviewExternalCall?.(row.id);
		})().catch((err: unknown) => {
			console.error(`agent runtime: resuming the review of external call ${row.id} failed:`, err);
		});
	}
}

/** A SessionUser for audit records written by a job's cancel, which carries only an Actor. */
function sessionUserForActor(actor: Actor): SessionUser {
	return {
		sessionId: `actor:${actor.type}:${actor.id}`,
		userId: actor.onBehalfOfUserId,
		username: "",
		kind: "member",
		actor: { type: actor.type, id: actor.id },
	};
}
