import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	Harness,
	hook,
	type Storage,
	type SubmissionId,
	section,
	type ToolRegistration,
	watchEvents,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import * as z from "zod/v4";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Actor, Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Preset } from "../policy/rules.ts";
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
import { type Budget, exhaustedLevel, parseBudget, recordSpend, type Spend, setBudget, spendOf } from "./budget.ts";
import type { ModelConfig, ModelRef } from "./models.ts";
import { Reviewer } from "./review.ts";
import { sharedSessionAccess } from "./sharing.ts";

/**
 * The agent runtime behind our own interface (doc/agent-runtime.md#agentruntime-抽象): pi-durable types do not
 * leave this module. One Harness over one Storage holds every session as a conversation.
 */

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
	/** From the session's rule set; null: unlimited. */
	budget: Budget | null;
	/** Spent by this session and its subagents. */
	spend: Spend;
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

	private constructor(harness: Harness, options: AgentRuntimeOptions) {
		this.#db = options.db;
		this.#harness = harness;
		this.#options = options;
		this.#models = options.models;
		this.#audit = options.audit;
		this.#cluster = options.cluster;
		this.#groups = options.groups;
	}

	static async #openHarness(options: AgentRuntimeOptions): Promise<Harness> {
		const registry = createRegistry();
		registry.install(clusterExtension(options));
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
		const runtime = new AgentRuntime(await AgentRuntime.#openHarness(options), options);
		// Auto Review for roots whose preset asks for it (tokens and sessions alike).
		const reviewer = new Reviewer(options.db, options.models, options.cluster, options.groups);
		options.cluster.onAwaitingApproval = (task) => reviewer.reviewTask(task);
		options.groups.onAwaitingApproval = (group) => reviewer.reviewGroup(group);
		runtime.#supervise();
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
					this.#harness = await AgentRuntime.#openHarness(this.#options);
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
		input: { title?: string; model: ModelRef; preset: Preset; instructions?: string; budget?: Budget | null },
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
				})
				.execute();
			await createRootRuleSet(trx, orgId, { type: "session", id }, input.preset);
			if (input.budget) await setBudget(trx, { type: "session", id }, input.budget);
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
			budget: (rules?.budget as Budget | undefined) ?? null,
			spend: await spendOf(this.#db, row.id),
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
					? "the session's budget is used up; raise it to continue"
					: "a parent session's budget is used up",
			);
		}
		const submission = await conversation.submit({ type: "input", content: text, requestId }, this.#context);
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
		change: { title?: string; model?: ModelRef; preset?: Preset; budget?: Budget | null },
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
		if (change.budget !== undefined) await setBudget(this.#db, { type: "session", id: sessionId }, change.budget);
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

function clusterExtension(options: AgentRuntimeOptions): Extension {
	const sessionOf = async (conversationId: unknown) =>
		(
			await options.db
				.selectFrom("sessions")
				.select("id")
				.where("conversation_id", "=", String(conversationId))
				.executeTakeFirst()
		)?.id;
	const hooks = [
		hook(GenerationTask, {
			// Spend counts at every level; a level over budget stops its whole subtree (doc/agent-runtime.md#预算).
			afterResponse: async (message, api) => {
				const sessionId = await sessionOf(api.conversationId);
				if (!sessionId || !message.usage) return;
				await recordSpend(options.db, sessionId, message.usage.totalTokens, message.usage.cost.total);
				const over = await exhaustedLevel(options.db, sessionId);
				// The tool calls of this response end the run (below); a response without them ends it anyway.
				if (over) {
					void options.audit?.record({
						actor: { type: "system", id: "budget" },
						action: "session.budget_exhausted",
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
				// Over budget: run nothing and end the run without another model request.
				if (await exhaustedLevel(options.db, base.actor.id)) {
					return {
						output: [{ type: "text", text: "The budget is used up; nothing was run and the run ends here." }],
						control: { terminate: true },
					};
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
			"Delegate a self-contained task to a subagent: a separate session that uses the same tools and answers " +
			"back. Give it rules to narrow what it may do (it can never do more than you); its approvals go to the " +
			"user. Returns the subagent's answer.",
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
			budget: Type.Optional(
				Type.Object({ tokens: Type.Optional(Type.Integer()), costUsd: Type.Optional(Type.Number()) }),
			),
		}),
		// A rerun after a restart finds the child session, conversation and submission it made before.
		replay: "safe",
		execute: async (args, api, context) => {
			const parent = await options.db
				.selectFrom("sessions")
				.selectAll()
				.where("conversation_id", "=", String(api.conversationId))
				.executeTakeFirst();
			if (!parent) throw new Error("this conversation is not a ClusterRightHand session");
			let depth = 0;
			for (let id = parent.parent_session_id; id; depth++) {
				id =
					(await options.db.selectFrom("sessions").select("parent_session_id").where("id", "=", id).executeTakeFirst())
						?.parent_session_id ?? null;
			}
			if (depth >= MAX_SUBAGENT_DEPTH) throw new Error(`subagents nest at most ${MAX_SUBAGENT_DEPTH} levels deep`);
			const rules = args.rules ? parseRuleSet(args.rules, false) : { default: "inherit" as const, rules: [] };
			const budget = args.budget ? parseBudget(args.budget) : null;
			await checkChildBudget(options.db, parent.id, budget);

			const childId = derivedId(`subagent:${String(api.taskId)}`);
			const conversationId = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing !== undefined) return existing.id;
				// A copy of this conversation's agent; the subagent tool is gone at the depth limit.
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				if (depth + 1 >= MAX_SUBAGENT_DEPTH) await configure(tx, created.id, { tools: { remove: [subagent] } });
				return created.id;
			}, context);
			if (!(await options.db.selectFrom("sessions").select("id").where("id", "=", childId).executeTakeFirst())) {
				const now = new Date().toISOString();
				await options.db.transaction().execute(async (trx) => {
					await trx
						.insertInto("sessions")
						.values({
							id: childId,
							org_id: parent.org_id,
							owner_user_id: parent.owner_user_id,
							conversation_id: String(conversationId),
							parent_session_id: parent.id,
							title: args.task.slice(0, 80),
							model: parent.model,
							status: "active",
							created_at: now,
							updated_at: now,
							archived_at: null,
						})
						.execute();
					await createRuleSet(trx, parent.org_id, { type: "session", id: childId }, rules);
					if (budget) await setBudget(trx, { type: "session", id: childId }, budget);
				});
				void options.audit?.record({
					actor: { type: "session", id: parent.id, onBehalfOfUserId: parent.owner_user_id },
					action: "session.subagent_created",
					target: { type: "session", id: childId },
					detail: { rules, budget },
				});
			}
			// A UI watching the parent finds the child here.
			await api.details({ sessionId: childId }, context);
			const child = await api.conversation(conversationId, context);
			if (!child) throw new Error("the subagent's conversation is missing");
			const request = { type: "input", content: args.task, requestId: `subagent:${String(api.taskId)}` } as const;
			const settled = await (await child.submit(request, context)).wait(context);
			if (settled.status !== "done" || settled.type !== "input") {
				throw new Error(
					`the subagent did not answer (${settled.status === "unanswered" ? settled.reason : settled.status})`,
				);
			}
			const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
			const text = (message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
			return { output: [{ type: "text", text: text || "(no answer)" }], details: { sessionId: childId } };
		},
	}) as unknown as ToolRegistration;

	return defineExtension({
		name: "crh",
		tools: [...tools, subagent],
		sections: [section("crh", () => SYSTEM_PROMPT, { tag: false })],
		hooks,
	});
}

/** Subagent sessions nest at most this deep below a root session (doc/agent-runtime.md#subagent). */
export const MAX_SUBAGENT_DEPTH = 2;

/** A child's budget cannot exceed what is left of every level above it. */
async function checkChildBudget(db: Db, parentId: string, budget: Budget | null): Promise<void> {
	for (let id: string | null = parentId; id; ) {
		const rules = await db
			.selectFrom("rule_sets")
			.select("budget")
			.where("scope_type", "=", "session")
			.where("scope_id", "=", id)
			.executeTakeFirst();
		if (rules?.budget) {
			const limit = JSON.parse(rules.budget) as Budget;
			const spend = await spendOf(db, id);
			const left = {
				tokens: (limit.tokens ?? Infinity) - spend.tokens,
				costUsd: (limit.costUsd ?? Infinity) - spend.costUsd,
			};
			if (!budget) throw new Error("give the subagent a budget: a session above it has one");
			if ((budget.tokens ?? Infinity) > left.tokens || (budget.costUsd ?? Infinity) > left.costUsd) {
				throw new Error(`the subagent's budget exceeds what is left above it (${JSON.stringify(left)})`);
			}
		}
		id =
			(await db.selectFrom("sessions").select("parent_session_id").where("id", "=", id).executeTakeFirst())
				?.parent_session_id ?? null;
	}
}
