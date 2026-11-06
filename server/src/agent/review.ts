import type { ApprovalDecision, Cluster, TaskView } from "../cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../cluster/task-groups.ts";
import { getRuleSet, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { ModelConfig, ModelRef } from "./models.ts";
import { chargeCall } from "./quota.ts";
import { type CallTokens, callTokens, estimateRequestTokens } from "./tokens.ts";

/**
 * Auto Review (doc/access-control.md#规则链): for a root whose rule preset is auto_review (a token, a session, or the
 * schedule a scheduled run's chain starts with), a task that needs approval is first judged by a model. It approves what is clearly safe and leaves the rest for the user. The reviewer sees
 * only the operation itself, never the conversation or node output, so one injected text cannot steer both the
 * agent and its reviewer (doc/agent-runtime.md#提示注入).
 */

const META_KEY = "review_model";

const SYSTEM = `You review operations an automated agent wants to run on a user's servers. You see one operation at a time.
Approve only when it is clearly low-risk: it does not destroy or overwrite data, does not change security settings,
credentials, users, firewall or network configuration, does not install or remove software, and does not stop
important services. Anything else, or anything you are unsure about, escalate to the human.
Answer with exactly one line of JSON: {"decision":"approve"|"escalate","reason":"<one short sentence>"}`;

export interface ReviewOutcome {
	decision: "approve" | "escalate";
	reason: string;
	model: string;
}

export async function getReviewModel(db: Db): Promise<ModelRef | null> {
	const row = await db.selectFrom("server_meta").select("value").where("key", "=", META_KEY).executeTakeFirst();
	return row ? (JSON.parse(row.value) as ModelRef) : null;
}

export async function setReviewModel(db: Db, model: ModelRef | null): Promise<void> {
	await db.deleteFrom("server_meta").where("key", "=", META_KEY).execute();
	if (model)
		await db
			.insertInto("server_meta")
			.values({ key: META_KEY, value: JSON.stringify(model) })
			.execute();
}

function parseOutcome(text: string): { decision: "approve" | "escalate"; reason: string } {
	const match = /\{[^{}]*\}/.exec(text);
	try {
		const o = JSON.parse(match?.[0] ?? "") as { decision?: string; reason?: string };
		if (o.decision === "approve") return { decision: "approve", reason: String(o.reason ?? "").slice(0, 300) };
		return { decision: "escalate", reason: String(o.reason ?? "the reviewer did not approve").slice(0, 300) };
	} catch {
		return { decision: "escalate", reason: "the reviewer's answer could not be read" };
	}
}

export class Reviewer {
	readonly #db: Db;
	readonly #models: ModelConfig;
	readonly #cluster: Cluster;
	readonly #taskGroups: TaskGroups;

	constructor(db: Db, models: ModelConfig, cluster: Cluster, taskGroups: TaskGroups) {
		this.#db = db;
		this.#models = models;
		this.#cluster = cluster;
		this.#taskGroups = taskGroups;
	}

	/** The model for one root: the configured review model, else (for a session or schedule) the root's own model. */
	async #modelFor(root: RuleRef): Promise<ModelRef | null> {
		const configured = await getReviewModel(this.#db);
		if (configured) return configured;
		if (root.type === "schedule") {
			// A scheduled run's chain root is the schedule, which carries the model its sessions run on.
			const row = await this.#db.selectFrom("schedules").select("model").where("id", "=", root.id).executeTakeFirst();
			return row ? (JSON.parse(row.model) as ModelRef) : null;
		}
		if (root.type !== "session") return null;
		const row = await this.#db.selectFrom("sessions").select("model").where("id", "=", root.id).executeTakeFirst();
		return row ? (JSON.parse(row.model) as ModelRef) : null;
	}

	/**
	 * Asks the reviewer, and reports what the answer costs so the owning session can be charged (D92, D101).
	 * `sessionId` is the crh session whose task is judged: a custom provider's session id fields carry it
	 * (D115). Durability passes provider session ids in its own requests, so resolve the reverse mapping here.
	 */
	async #ask(
		model: ModelRef,
		operation: string,
		sessionId: string | undefined,
	): Promise<{ outcome: ReviewOutcome; tokens: CallTokens }> {
		const resolved = this.#models.models.getModel(model.provider, model.modelId);
		const name = `${model.provider}/${model.modelId}`;
		if (!resolved)
			return {
				outcome: { decision: "escalate", reason: `review model ${name} is not configured`, model: name },
				tokens: { budget: 0, usage: 0, context: 0 },
			};
		try {
			const request = {
				systemPrompt: SYSTEM,
				messages: [{ role: "user" as const, content: operation, timestamp: Date.now() }],
			};
			const providerSessionId = sessionId ? this.#models.providerSessionIdFor(sessionId) : undefined;
			const answer = await this.#models.models.completeSimple(
				resolved,
				request,
				(providerSessionId ?? sessionId) ? { sessionId: providerSessionId ?? sessionId } : undefined,
			);
			const text = answer.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
			return {
				outcome: { ...parseOutcome(text), model: name },
				// The review's request (system prompt plus messages) is the input basis when no usage is reported.
				tokens: callTokens(answer, estimateRequestTokens(request)),
			};
		} catch (err) {
			return {
				outcome: {
					decision: "escalate",
					reason: `review failed: ${(err as Error).message}`.slice(0, 300),
					model: name,
				},
				tokens: { budget: 0, usage: 0, context: 0 },
			};
		}
	}

	/**
	 * Charges a review's tokens to the session whose task it judged, walking up the chain as any other model call
	 * (doc/agent-runtime.md#配额, D101). A task without a session (an API token) is not charged. A review never
	 * moves the context fill: that is the session's own last main-agent call.
	 */
	async #charge(actorType: string, actorId: string, tokens: CallTokens): Promise<void> {
		if (tokens.budget === 0 && tokens.usage === 0) return;
		if (actorType !== "session" && actorType !== "subagent") return;
		await chargeCall(this.#db, actorId, tokens);
	}

	async #wanted(chain: RuleRef[] | null): Promise<ModelRef | null> {
		const root = chain?.[0];
		if (!root) return null;
		if ((await getRuleSet(this.#db, root))?.rulePreset !== "auto_review") return null;
		return (await this.#modelFor(root)) ?? null;
	}

	/** Called for a task that just started waiting; settles it if the reviewer approves. */
	async reviewTask(task: TaskView): Promise<void> {
		const model = await this.#wanted(task.ruleChain);
		if (!model || !task.operation) return;
		const { outcome, tokens } = await this.#ask(
			model,
			describe(task.operation, task.nodeId, task.actorType),
			sessionOfActor(task.actorType, task.actorId),
		);
		await this.#charge(task.actorType, task.actorId, tokens);
		await this.#cluster.recordReview(task.id, outcome);
		if (outcome.decision === "approve") await this.#cluster.decide(task.id, decision(outcome));
	}

	async reviewGroup(group: TaskGroupView): Promise<void> {
		const model = await this.#wanted(group.ruleChain);
		if (!model || !group.operation) return;
		const { outcome, tokens } = await this.#ask(
			model,
			describe(group.operation, `${group.nodeIds.length} nodes (${group.targets.join(", ")})`, group.actorType),
			sessionOfActor(group.actorType, group.actorId),
		);
		await this.#charge(group.actorType, group.actorId, tokens);
		await this.#taskGroups.recordReview(group.id, outcome);
		if (outcome.decision === "approve") await this.#taskGroups.decide(group.id, decision(outcome));
	}
}

/** A task's actor names the session that requested it; API tokens have no session. */
function sessionOfActor(actorType: string, actorId: string): string | undefined {
	return actorType === "session" || actorType === "subagent" ? actorId : undefined;
}

function describe(op: { method: string; target: string }, where: string, actor: string): string {
	return `Operation: ${op.method}\nTarget: ${op.target}\nOn: ${where}\nRequested by: ${actor}`;
}

function decision(outcome: ReviewOutcome): ApprovalDecision {
	return {
		decision: "approved",
		by: { type: "system", id: "auto-review" },
		at: new Date().toISOString(),
		reason: `auto review (${outcome.model}): ${outcome.reason}`,
	};
}
