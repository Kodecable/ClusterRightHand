import type { Api, Model, TextContent, ThinkingContent, Tool, ToolCall, ToolChoice } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ApprovalDecision, Cluster, TaskView } from "../cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../cluster/task-groups.ts";
import { getRuleSet, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import type { ModelPresets } from "./model-presets.ts";
import { type ModelConfig, type ModelRef, thinkingLevelOf } from "./models.ts";
import { chargeCall } from "./quota.ts";
import { type CallTokens, callTokens, estimateRequestTokens } from "./tokens.ts";

/**
 * Auto Review (doc/access-control.md#规则链): for a root whose rule preset is auto_review (a token, a session, or the
 * schedule a scheduled run's chain starts with), a task that needs approval is first judged by a model. It approves what is clearly safe and leaves the rest for the user. The reviewer sees
 * only the operation itself, never the conversation or node output, so one injected text cannot steer both the
 * agent and its reviewer (doc/agent-runtime.md#提示注入).
 *
 * D116: the reviewer answers through the forced tool `submit_review`; a model that ignores `toolChoice` still
 * works through the old one-line-JSON fallback, and anything unreadable escalates.
 */

/** The default review prompt: the criteria. A custom prompt replaces it. */
export const DEFAULT_REVIEW_PROMPT = `You review operations an automated agent wants to run on a user's servers. You see one operation at a time.
Approve only when it is clearly low-risk: it does not destroy or overwrite data, does not change security settings,
credentials, users, firewall or network configuration, does not install or remove software, and does not stop
important services. Anything else, or anything you are unsure about, escalate to the human.`;

/** The review protocol: the decision tool and the instruction to answer through it. Always appended. */
export const REVIEW_PROTOCOL = `The submit_review tool takes:
- decision: "approve" or "escalate"
- reason: one short sentence explaining the decision.

Answer by calling submit_review.`;

/** The full review system prompt: the custom prompt when set, else the default, then the fixed protocol. */
export function reviewSystemPrompt(custom: string | null | undefined): string {
	return `${custom ?? DEFAULT_REVIEW_PROMPT}\n\n${REVIEW_PROTOCOL}`;
}

export const REVIEW_TOOL_NAME = "submit_review";

/** The forced decision tool; its arguments carry the outcome (doc/agent-runtime.md#模型预设). */
export const REVIEW_TOOL: Tool = {
	name: REVIEW_TOOL_NAME,
	description: "Submit the review decision for the operation.",
	parameters: Type.Object({
		decision: Type.Union([Type.Literal("approve"), Type.Literal("escalate")]),
		reason: Type.String(),
	}),
};

export interface ReviewOutcome {
	decision: "approve" | "escalate";
	reason: string;
	model: string;
}

/**
 * A forced tool choice in the shape the model's protocol expects. pi-ai's provider-neutral `ToolChoice`
 * is only `"auto" | "none"`; every provider implementation passes a forced choice through and accepts its
 * own shape, so the value is cast where it leaves the simple option's nominal type.
 */
function forcedToolChoice(model: Model<Api>, name: string): ToolChoice {
	switch (model.api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
			return { type: "tool", name } as unknown as ToolChoice;
		case "google-generative-ai":
		case "google-vertex":
			// Gemini has no named forced choice here; ANY forces a function call, and submit_review is the only tool.
			return "any" as ToolChoice;
		case "openai-codex-responses":
			return "required" as ToolChoice;
		case "openai-responses":
		case "azure-openai-responses":
			return { type: "function", name } as unknown as ToolChoice;
		default:
			return { type: "function", function: { name } } as unknown as ToolChoice;
	}
}

type AnswerContent = TextContent | ThinkingContent | ToolCall;

/**
 * The outcome a `submit_review` call carries, or undefined when the answer has no such call (then the text
 * fallback decides). Arguments that do not match the schema escalate.
 */
function outcomeFromToolCalls(
	content: readonly AnswerContent[],
): { decision: "approve" | "escalate"; reason: string } | undefined {
	const call = content.find((block): block is ToolCall => block.type === "toolCall" && block.name === REVIEW_TOOL_NAME);
	if (!call) return undefined;
	if (!Value.Check(REVIEW_TOOL.parameters, call.arguments)) {
		return { decision: "escalate", reason: "the reviewer's answer could not be read" };
	}
	const args = call.arguments as { decision: "approve" | "escalate"; reason: string };
	return {
		decision: args.decision === "approve" ? "approve" : "escalate",
		reason: args.reason.slice(0, 300),
	};
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
	readonly #presets: ModelPresets;

	constructor(db: Db, models: ModelConfig, cluster: Cluster, taskGroups: TaskGroups, presets: ModelPresets) {
		this.#db = db;
		this.#models = models;
		this.#cluster = cluster;
		this.#taskGroups = taskGroups;
		this.#presets = presets;
	}

	/** The model for one root: the configured review model, else (for a session or schedule) the root's own model. */
	async #modelFor(root: RuleRef): Promise<ModelRef | null> {
		const configured = this.#presets.get("review").model;
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
				systemPrompt: reviewSystemPrompt(this.#presets.get("review").systemPrompt),
				messages: [{ role: "user" as const, content: operation, timestamp: Date.now() }],
				tools: [REVIEW_TOOL],
			};
			const providerSessionId = sessionId ? this.#models.providerSessionIdFor(sessionId) : undefined;
			const providerRequestId = providerSessionId ?? sessionId;
			const level = thinkingLevelOf(model);
			const answer = await this.#models.models.completeSimple(resolved, request, {
				...(providerRequestId ? { sessionId: providerRequestId } : {}),
				// The review runs at the review model's thinking level; `off` is pi-ai's "no reasoning" option.
				...(level === "off" ? {} : { reasoning: level }),
				toolChoice: forcedToolChoice(resolved, REVIEW_TOOL_NAME),
			});
			const text = answer.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
			const outcome = outcomeFromToolCalls(answer.content) ?? parseOutcome(text);
			return {
				outcome: { ...outcome, model: name },
				// The review's request (system prompt plus messages) is the input basis when no usage is reported.
				tokens: callTokens(
					answer,
					estimateRequestTokens({ systemPrompt: request.systemPrompt, messages: request.messages }),
				),
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
