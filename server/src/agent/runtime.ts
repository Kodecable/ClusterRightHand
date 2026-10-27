import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	createRegistry,
	defineDocFamily,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	Harness,
	hook,
	type SettledSubmissionRecord,
	type Storage,
	type Submission,
	type SubmissionId,
	section,
	type ToolRegistration,
	ToolTask,
	watchEvents,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import * as z from "zod/v4";
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
import type { ModelConfig, ModelRef } from "./models.ts";
import {
	awaitingQuotaChildren,
	awaitingQuotaSessions,
	exhaustedLevel,
	grantQuota,
	markSessionsStopped,
	parseQuota,
	recordUsage,
	type SessionState,
	sessionStateOf,
	setQuota,
	setSessionState,
	spentTokens,
} from "./quota.ts";
import { Reviewer } from "./review.ts";
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
	model: ModelRef;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	rules: StoredRuleSet | null;
	/** Subagent state (roots stay active). */
	state: SessionState;
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

/** What a UI receives: a snapshot to start from, then batches of events (pi-durable's agent events, for now). */
export type SessionEvent = AgentEvent;

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
}

const SYSTEM_PROMPT = `You are ClusterRightHand, an assistant that operates the user's servers ("nodes") through the cluster tools.

- Start with list_nodes or node_info when you do not know the nodes yet.
- Prefer reading (read_file, list_dir) before changing anything; explain what you are about to change.
- Commands and file changes may wait for the user's approval; a rejected task comes back with the user's reason. Respect it and do not try to get around it.
- exec returns the end of long outputs and, when truncated, the path of the full output on the node; read it with read_file when needed.
- A task can end "unknown": its outcome could not be confirmed. Check the node's state before retrying.
- Delegate self-contained work to subagent; settle a subagent's requests with subagent_decide, and fetch a background subagent's answer with subagent_wait.
- Be concise.`;

type Row = {
	id: string;
	owner_user_id: string;
	conversation_id: string;
	parent_session_id: string | null;
	title: string;
	model: string;
	status: "active" | "archived";
	created_at: string;
	updated_at: string;
	last_submission_id: string | null;
	quota_tokens: string | number | null;
	state: SessionState;
	waiting_level_id: string | null;
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

	private constructor(harness: Harness, options: AgentRuntimeOptions) {
		this.#db = options.db;
		this.#harness = harness;
		this.#options = options;
		this.#models = options.models;
		this.#audit = options.audit;
		this.#cluster = options.cluster;
		this.#groups = options.groups;
	}

	static async #openHarness(options: AgentRuntimeOptions, ref: { current?: AgentRuntime }): Promise<Harness> {
		const registry = createRegistry();
		registry.install(clusterExtension(options, ref));
		const storage = typeof options.storage === "function" ? await options.storage() : options.storage;
		const harness = await Harness.open(
			storage,
			{
				models: options.models.models,
				registry,
				identity: { attribution: { name: "ClusterRightHand", url: "https://github.com/Kodecable/ClusterRightHand" } },
				settings: {
					// pi's coding-agent defaults (doc/agent-runtime.md#默认值).
					compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
					retry: { maxRetries: 3 },
					...(options.retentionMs !== undefined
						? { contextRetentionMs: options.retentionMs, documentRetentionMs: options.retentionMs }
						: {}),
				},
			},
			BACKGROUND_CONTEXT,
		);
		harness.resume(); // runs and tool calls the last process left unfinished
		return harness;
	}

	static async open(options: AgentRuntimeOptions): Promise<AgentRuntime> {
		const ref: { current?: AgentRuntime } = {};
		const runtime = new AgentRuntime(await AgentRuntime.#openHarness(options, ref), options);
		runtime.#runtimeRef = ref;
		ref.current = runtime;
		// Auto Review for roots whose preset asks for it (tokens and sessions alike), then route child approvals
		// to an ancestor's agent where the chain allows it.
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
		runtime.#supervise();
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
					this.reopened++;
					this.#supervise();
					return;
				} catch (err) {
					console.error("agent runtime: reopening failed:", err);
				}
			}
		});
	}

	async close(): Promise<void> {
		this.#closing = true;
		await this.#harness.close(this.#context);
	}

	async createSession(
		owner: SessionUser,
		input: { title?: string; model: ModelRef; preset: Preset; instructions?: string },
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
					title: input.title?.trim() || "New session",
					model: JSON.stringify(input.model),
					status: "active",
					created_at: now,
					updated_at: now,
					archived_at: null,
					// Root sessions have no quota (0) and are never charged; quotas manage subagents (D76).
					quota_tokens: 0,
					state: "active",
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
		return (await this.getSession(id)) as SessionView;
	}

	async getSession(id: string): Promise<SessionView | undefined> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
		return row ? this.#view(row) : undefined;
	}

	/** Root sessions the user owns or that are shared with them (administrators: everyone's), newest first. */
	async listSessions(user: SessionUser): Promise<SessionView[]> {
		let q = this.#db
			.selectFrom("sessions")
			.selectAll()
			.where("parent_session_id", "is", null)
			.orderBy("created_at", "desc");
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
			model: JSON.parse(row.model) as ModelRef,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			rules,
			state: row.state,
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
		const { row, conversation } = await this.#conversation(sessionId);
		if (row.status !== "active") throw new UserError("the session is archived");
		const over = await exhaustedLevel(this.#db, sessionId);
		if (over) {
			throw new UserError(
				over === sessionId
					? "the session's token quota is used up; raise it to continue"
					: "a parent session's token quota is used up",
			);
		}
		const submission = await conversation.submit({ type: "input", content: text, requestId }, this.#context);
		await this.#reviveOnInput(sessionId, submission);
		await this.#db
			.updateTable("sessions")
			.set({ updated_at: new Date().toISOString() })
			.where("id", "=", sessionId)
			.execute();
		void this.#audit?.record({
			actor: { type: "user", id: by.userId, onBehalfOfUserId: row.owner_user_id },
			action: "session.message",
			target: { type: "session", id: sessionId },
			detail: { submission_id: String(submission.id), chars: text.length },
		});
		return String(submission.id);
	}

	/**
	 * A new input revives a stopped subagent (`stopped` is sticky until the next input). A retried submission that
	 * is already settled is not new work and leaves the state alone.
	 */
	async #reviveOnInput(sessionId: string, submission: Submission): Promise<void> {
		const { status } = await submission.status(this.#context);
		if (status !== "queued" && status !== "placed") return;
		// Only a stopped subagent is revived; an input must not clear an approval or quota wait.
		if ((await sessionStateOf(this.#db, sessionId)) !== "stopped") return;
		await setSessionState(this.#db, sessionId, "active", null);
	}

	/** Stops the current run: queued inputs are withdrawn and running tool calls aborted. */
	async abort(sessionId: string, by?: SessionUser): Promise<void> {
		const { conversation } = await this.#conversation(sessionId);
		await conversation.abort(this.#context);
		// Stopping means stopping the work too. This is done here, not on the tool's abort signal, which also fires
		// when crhs shuts down: after a restart the call reattaches to its task instead.
		const sessions = [sessionId, ...(await this.#descendants(sessionId))];
		const decision = {
			decision: "rejected" as const,
			by: { type: "user", id: by?.userId ?? "system", ...(by ? { onBehalfOfUserId: by.userId } : {}) },
			at: new Date().toISOString(),
			reason: "the session was stopped",
		};
		for (const table of ["tasks", "task_groups"] as const) {
			const rows = await this.#db
				.selectFrom(table)
				.select(["id", "state"])
				.where("actor_id", "in", sessions)
				.where("state", "in", ["awaiting_approval", "dispatched", "running"])
				.execute();
			for (const row of rows) {
				if (row.state === "awaiting_approval") {
					await (table === "tasks" ? this.#cluster.decide(row.id, decision) : this.#groups.decide(row.id, decision));
				} else if (table === "tasks") {
					await this.#cluster.cancelTask(row.id);
				} else {
					const tasks = await this.#db
						.selectFrom("tasks")
						.select("id")
						.where("task_group_id", "=", row.id)
						.where("state", "in", ["dispatched", "running"])
						.execute();
					for (const t of tasks) await this.#cluster.cancelTask(t.id);
				}
			}
		}
		await markSessionsStopped(this.#db, sessions);
		// Subagents are ownerless conversations, so their abort is explicit (doc/agent-runtime.md#abort).
		for (const id of sessions.slice(1)) {
			const row = await this.#db
				.selectFrom("sessions")
				.select("conversation_id")
				.where("id", "=", id)
				.executeTakeFirst();
			if (!row) continue;
			const conversation = await this.#harness.conversation(
				Number(row.conversation_id) as unknown as ConversationId,
				this.#context,
			);
			await conversation?.abort(this.#context);
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
			// Only subagents carry a quota; a root session is never charged (D76).
			if (row.parent_session_id === null)
				throw new UserError("a root session has no quota; give one to a subagent instead");
			await setQuota(this.#db, sessionId, change.quota);
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
		return (await this.getSession(sessionId)) as SessionView;
	}

	/**
	 * Streams the session's events: `onEvents` first gets a snapshot event, then batches as commits land.
	 * Returns a function that stops the stream.
	 */
	async watch(sessionId: string, onEvents: (events: SessionEvent[]) => Promise<void> | void, signal?: AbortSignal) {
		const { row } = await this.#conversation(sessionId);
		const context = signal ? withAbortSignal(signal, this.#context) : this.#context;
		const stream = await watchEvents(this.#harness, Number(row.conversation_id) as unknown as ConversationId, context);
		await onEvents([{ type: "snapshot", snapshot: stream.snapshot } as unknown as SessionEvent]);
		// The system prompt and tool schemas come as system messages: large, and nothing a chat UI shows.
		const shown = (e: AgentEvent) => (e as { message?: { role?: string } }).message?.role !== "system";
		stream.start(async (events) => onEvents((events as SessionEvent[]).filter(shown)));
		return () => stream.stop();
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
		if (depth >= MAX_SUBAGENT_DEPTH) throw new UserError(`subagents nest at most ${MAX_SUBAGENT_DEPTH} levels deep`);

		const childId = derivedId(`subagent:${input.callKey}`);
		if (await this.#db.selectFrom("sessions").select("id").where("id", "=", childId).executeTakeFirst()) {
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
					title: input.task.slice(0, 80),
					model: parent.model,
					status: "active",
					created_at: now,
					updated_at: now,
					archived_at: null,
					quota_tokens: input.quota,
					state: "active",
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
		await this.#reviveOnInput(childId, submission);
		await this.#db
			.updateTable("sessions")
			.set({ last_submission_id: String(submission.id), updated_at: new Date().toISOString() })
			.where("id", "=", childId)
			.execute();
		void this.#audit?.record({
			actor: { type: "subagent", id: row.parent_session_id ?? childId, onBehalfOfUserId: row.owner_user_id },
			action: "session.message",
			target: { type: "session", id: childId },
			detail: { submission_id: String(submission.id), chars: text.length },
		});
		void submission
			.wait(this.#context)
			.then(() => setSessionState(this.#db, childId, "stopped", null))
			.catch(() => {});
		return String(submission.id);
	}

	/**
	 * Waits for the child's answer. With `attention`, an approval handed to this session's agent ends the wait early:
	 * the parent decides with subagent_decide() and then waits again.
	 */
	async waitSubagent(
		childId: string,
		options: { attention?: boolean; signal?: AbortSignal } = {},
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

		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const attention = new Promise<AgentRequestView[]>((resolve) => {
			const poll = async () => {
				if (stopped) return;
				try {
					const requests = await this.pendingAgentRequests(row.parent_session_id ?? childId);
					if (requests.length > 0) return resolve(requests);
				} catch {}
				if (!stopped) timer = setTimeout(poll, 300);
			};
			timer = setTimeout(poll, 300);
		});
		const first = await Promise.race([
			settled.then((s) => ({ kind: "settled" as const, s })),
			attention.then((requests) => ({ kind: "attention" as const, requests })),
		]);
		stopped = true;
		if (timer) clearTimeout(timer);
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
		const out: AgentRequestView[] = [];
		const tasks = await this.#db
			.selectFrom("tasks")
			.select(["id", "actor_id", "node_id", "spec", "created_at"])
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "agent")
			.where("handler_session_id", "=", sessionId)
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
			.where("handler_session_id", "=", sessionId)
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
		for (const wait of await awaitingQuotaChildren(this.#db, sessionId)) {
			out.push({
				kind: "quota",
				id: wait.sessionId,
				sessionId: wait.sessionId,
				summary: `${wait.levelTitle} is at ${wait.levelQuota ?? "unlimited"} tokens; the subagent is paused`,
				nodeId: null,
				createdAt: wait.since,
			});
		}
		return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
			await this.refreshState(task.actor_id);
			return "task";
		}
		const waiting = await this.#db.selectFrom("sessions").selectAll().where("id", "=", requestId).executeTakeFirst();
		if (waiting?.state === "awaiting" && waiting.waiting_level_id) {
			const levelId = waiting.waiting_level_id;
			if ((await this.#parentOf(levelId)) !== sessionId) {
				throw new UserError("this quota wait is not handled by this session's agent");
			}
			if (decision === "escalate") {
				throw new UserError("a quota wait goes to the direct parent only; approve or deny it");
			}
			if (decision === "deny") {
				await markSessionsStopped(this.#db, [requestId]);
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
			// A denial already left the session stopped; do not recompute it while the paused tool is still live.
			if (decision !== "deny") await this.refreshState(requestId);
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
		await this.refreshState(group.actor_id);
		return "group";
	}

	/**
	 * Pauses a tool call whose chain quota is used up (doc/agent-runtime.md#配额): asks the first ancestor with
	 * quota to spare (its agent), or the owner, and waits until the whole chain is above zero or the request is
	 * denied. A rerun after a restart finds the same request.
	 */
	async waitForQuota(sessionId: string, context: Context): Promise<"ok" | "denied"> {
		for (;;) {
			// A denied wait (or an abort) set `stopped`: end the paused call before writing `awaiting` again.
			if ((await sessionStateOf(this.#db, sessionId)) === "stopped") return "denied";
			const level = await exhaustedLevel(this.#db, sessionId);
			if (!level) {
				await setSessionState(this.#db, sessionId, "active", null);
				return "ok";
			}
			const parent = await this.#parentOf(level);
			const since = await setSessionState(this.#db, sessionId, "awaiting", level);
			if (parent) await this.#wakeQuota(parent, sessionId, level, since);
			await new Promise((r) => setTimeout(r, 300));
			if (context.abortSignal?.aborted) throw new Error("the quota wait was aborted");
			if ((await sessionStateOf(this.#db, sessionId)) === "stopped") return "denied";
		}
	}

	/**
	 * Recomputes a subagent's cached state (doc/agent-runtime.md#subagent): `awaiting` when one of its tool calls
	 * waits for approval or its quota is exhausted while it runs, `stopped` once its run has ended (sticky until a
	 * new input), `active` otherwise. Roots stay active.
	 */
	async refreshState(sessionId: string): Promise<SessionState> {
		const row = await this.#db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
		if (!row || row.parent_session_id === null) return "active";
		const live = await this.#isLive(row);
		const level = await exhaustedLevel(this.#db, sessionId);
		// `stopped` is sticky until a new input (#reviveOnInput). A denied quota wait is still live while its tool
		// call ends, so the live run alone does not revive it; an exhausted level keeps it stopped meanwhile.
		if (row.state === "stopped" && (!live || level !== undefined)) return "stopped";
		const approval =
			(await this.#db
				.selectFrom("tasks")
				.select("id")
				.where("actor_id", "=", sessionId)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst()) ??
			(await this.#db
				.selectFrom("task_groups")
				.select("id")
				.where("actor_id", "=", sessionId)
				.where("state", "=", "awaiting_approval")
				.executeTakeFirst());
		// A quota wait set by the paused tool stays until the quota is restored; a live run also counts.
		const quotaWait = level !== undefined && (row.waiting_level_id !== null || live);
		const awaiting = approval !== undefined || quotaWait;
		const state: SessionState = awaiting ? "awaiting" : "active";
		await setSessionState(this.#db, sessionId, state, quotaWait ? (level ?? null) : null);
		return state;
	}

	/** Whether the session's conversation has a live run. */
	async #isLive(row: Row): Promise<boolean> {
		const conversation = await this.#harness.conversation(
			Number(row.conversation_id) as unknown as ConversationId,
			this.#context,
		);
		if (!conversation) return false;
		const state = await conversation.viewState(this.#context);
		const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
		state.dispose();
		return live?.run !== undefined;
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
		const pending = await this.pendingAgentRequests(sessionId);
		const rows = await this.#db
			.selectFrom("sessions")
			.selectAll()
			.where("parent_session_id", "=", sessionId)
			.orderBy("created_at", "desc")
			.execute();
		const states = new Map<string, SessionState>();
		for (const r of rows) states.set(r.id, await this.refreshState(r.id));
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

	/** After a restart, wakes the parents of requests that were already waiting (deduplicated by requestId). */
	async #wakePendingAgents(): Promise<void> {
		// Reconcile cached states with durable truth: a run that ended while the process was down is stopped,
		// and the quota/approval sources decide active vs awaiting.
		const children = await this.#db
			.selectFrom("sessions")
			.selectAll()
			.where("parent_session_id", "is not", null)
			.execute();
		for (const child of children) {
			if (child.last_submission_id) {
				const submission = await this.#harness.submission(
					Number(child.last_submission_id) as unknown as SubmissionId,
					this.#context,
				);
				const settled = await submission?.status(this.#context);
				if (settled?.status === "done" || settled?.status === "unanswered") {
					await setSessionState(this.#db, child.id, "stopped", null);
					continue;
				}
			}
			await this.refreshState(child.id);
		}
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

	/** One wake path for every subagent request: a follow-up input to an idle handler. */
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
		if (live?.run) return;
		const submission = await conversation.submit({ type: "input", content, requestId }, this.#context);
		await this.#reviveOnInput(handlerId, submission);
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
	for (let s: typeof session | undefined = session; s; ) {
		chain.unshift({ type: "session", id: s.id });
		s = s.parent_session_id
			? await db.selectFrom("sessions").selectAll().where("id", "=", s.parent_session_id).executeTakeFirst()
			: undefined;
	}
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
		approvalUrl: (kind, id) => `#/approvals/${kind === "task" ? "tasks" : "task-groups"}/${id}`,
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
			// Usage counts at every level; a level whose quota is not above zero stops its whole subtree (doc/agent-runtime.md#配额).
			afterResponse: async (message, api) => {
				const sessionId = await sessionOf(api.conversationId);
				if (!sessionId || !message.usage) return;
				await recordUsage(options.db, sessionId, message.usage.totalTokens);
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
			const result = await runtime.waitSubagent(child.id, { attention: true, signal: context.abortSignal });
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

	return defineExtension({
		name: "crh",
		tools: [...tools, subagent, subagentWait, subagentList, subagentCancel, subagentDecide],
		sections: [section("crh", () => SYSTEM_PROMPT, { tag: false })],
		hooks,
	});
}

/** Subagent sessions nest at most this deep below a root session (doc/agent-runtime.md#subagent). */
export const MAX_SUBAGENT_DEPTH = 2;
