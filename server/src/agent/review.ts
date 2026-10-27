import type { ApprovalDecision, Cluster, TaskView } from "../cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../cluster/task-groups.ts";
import { getRuleSet, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { ModelConfig, ModelRef } from "./models.ts";

/**
 * Auto Review (doc/access-control.md#规则链): for a root whose preset is auto_review, a task that needs approval is
 * first judged by a model. It approves what is clearly safe and leaves the rest for the user. The reviewer sees
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
	readonly #groups: TaskGroups;

	constructor(db: Db, models: ModelConfig, cluster: Cluster, groups: TaskGroups) {
		this.#db = db;
		this.#models = models;
		this.#cluster = cluster;
		this.#groups = groups;
	}

	/** The model for one root: the configured review model, else (for a session) the session's own model. */
	async #modelFor(root: RuleRef): Promise<ModelRef | null> {
		const configured = await getReviewModel(this.#db);
		if (configured) return configured;
		if (root.type !== "session") return null;
		const row = await this.#db.selectFrom("sessions").select("model").where("id", "=", root.id).executeTakeFirst();
		return row ? (JSON.parse(row.model) as ModelRef) : null;
	}

	async #ask(model: ModelRef, operation: string): Promise<ReviewOutcome> {
		const resolved = this.#models.models.getModel(model.provider, model.modelId);
		const name = `${model.provider}/${model.modelId}`;
		if (!resolved) return { decision: "escalate", reason: `review model ${name} is not configured`, model: name };
		try {
			const answer = await this.#models.models.completeSimple(resolved, {
				systemPrompt: SYSTEM,
				messages: [{ role: "user", content: operation, timestamp: Date.now() }],
			});
			const text = answer.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
			return { ...parseOutcome(text), model: name };
		} catch (err) {
			return { decision: "escalate", reason: `review failed: ${(err as Error).message}`.slice(0, 300), model: name };
		}
	}

	async #wanted(chain: RuleRef[] | null): Promise<ModelRef | null> {
		const root = chain?.[0];
		if (!root) return null;
		if ((await getRuleSet(this.#db, root))?.preset !== "auto_review") return null;
		return (await this.#modelFor(root)) ?? null;
	}

	/** Called for a task that just started waiting; settles it if the reviewer approves. */
	async reviewTask(task: TaskView): Promise<void> {
		const model = await this.#wanted(task.ruleChain);
		if (!model || !task.operation) return;
		const outcome = await this.#ask(model, describe(task.operation, task.nodeId, task.actorType));
		await this.#cluster.recordReview(task.id, outcome);
		if (outcome.decision === "approve") await this.#cluster.decide(task.id, decision(outcome));
	}

	async reviewGroup(group: TaskGroupView): Promise<void> {
		const model = await this.#wanted(group.ruleChain);
		if (!model || !group.operation) return;
		const outcome = await this.#ask(
			model,
			describe(group.operation, `${group.nodeIds.length} nodes (${group.targets.join(", ")})`, group.actorType),
		);
		await this.#groups.recordReview(group.id, outcome);
		if (outcome.decision === "approve") await this.#groups.decide(group.id, decision(outcome));
	}
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
