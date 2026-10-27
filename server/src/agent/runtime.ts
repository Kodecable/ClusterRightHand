import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
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
	watchEvents,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import * as z from "zod/v4";
import type { Audit } from "../audit/audit.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Actor, Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Preset } from "../policy/rules.ts";
import { createRootRuleSet, getRuleSet, type RuleRef, type StoredRuleSet, setPreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { TOOLS, type ToolContext } from "../tools/catalog.ts";
import { defaultOrgId, NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import { type Budget, exhaustedLevel, recordSpend, type Spend, setBudget, spendOf } from "./budget.ts";
import type { ModelConfig, ModelRef } from "./models.ts";

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
	storage: Storage;
	models: ModelConfig;
	cluster: Cluster;
	groups: TaskGroups;
	audit?: Audit;
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
	readonly #harness: Harness;
	readonly #models: ModelConfig;
	readonly #audit: Audit | undefined;
	readonly #context: Context = BACKGROUND_CONTEXT;

	private constructor(db: Db, harness: Harness, models: ModelConfig, audit: Audit | undefined) {
		this.#db = db;
		this.#harness = harness;
		this.#models = models;
		this.#audit = audit;
	}

	static async open(options: AgentRuntimeOptions): Promise<AgentRuntime> {
		const registry = createRegistry();
		registry.install(clusterExtension(options));
		const harness = await Harness.open(
			options.storage,
			{
				models: options.models.models,
				registry,
				identity: { attribution: { name: "ClusterRightHand", url: "https://github.com/Kodecable/ClusterRightHand" } },
				settings: {
					// pi's coding-agent defaults (doc/agent-runtime.md#默认值).
					compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
					retry: { maxRetries: 3 },
				},
			},
			BACKGROUND_CONTEXT,
		);
		const runtime = new AgentRuntime(options.db, harness, options.models, options.audit);
		harness.resume(); // runs and tool calls the last process left unfinished
		return runtime;
	}

	async close(): Promise<void> {
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

	/** Root sessions the user owns (administrators: everyone's), newest first. */
	async listSessions(user: SessionUser): Promise<SessionView[]> {
		let q = this.#db
			.selectFrom("sessions")
			.selectAll()
			.where("parent_session_id", "is", null)
			.orderBy("created_at", "desc");
		if (user.kind !== "admin") q = q.where("owner_user_id", "=", user.userId);
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
	async abort(sessionId: string): Promise<void> {
		const { conversation } = await this.#conversation(sessionId);
		await conversation.abort(this.#context);
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
		stream.start(async (events) => onEvents(events as SessionEvent[]));
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
	return defineExtension({
		name: "crh",
		tools,
		sections: [section("crh", () => SYSTEM_PROMPT, { tag: false })],
		hooks,
	});
}
