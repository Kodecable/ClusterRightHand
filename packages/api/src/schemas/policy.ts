/**
 * Runtime schemas for authorization rules (`../policy.ts`). The rule input schemas are strict, so a
 * misspelled field is rejected instead of being silently ignored.
 */
import { z } from "zod";

export const RuleActionSchema = z.enum(["allow", "deny", "require-approval"]);
export const RuleMethodSchema = z.enum([
	"exec",
	"file.read",
	"file.write",
	"ext.read",
	"ext.write",
	"api.read",
	"api.write",
]);
export const RulePresetSchema = z.enum(["ask", "auto_review", "yolo"]);
/** A level's own result; only a lower level than the root may inherit. */
export const DefaultActionSchema = z.enum(["allow", "deny", "require-approval", "inherit"]);

export const RuleSchema = z
	.object({
		action: RuleActionSchema,
		method: RuleMethodSchema.optional(),
		nodes: z.array(z.string()).optional().describe("Node or node-group names or ids on input; the server stores ids."),
		privileged: z.boolean().optional().describe("true matches only privileged tasks, false only ordinary ones."),
		exact: z.string().optional(),
		prefix: z.string().optional(),
	})
	.meta({ id: "Rule", description: "One authorization rule." });

/** A rule in a request: unknown fields are a 400 rather than something the caller believes took effect. */
export const RuleInputSchema = RuleSchema.strict();

export const RuleRefSchema = z
	.object({
		type: z.string().describe("The kind of object the rule set belongs to, e.g. `api_token`."),
		id: z.string(),
	})
	.meta({ id: "RuleRef" });

/** The rule chain stored for one object (doc/design/access-control.md "Authorization rules"). */
export const StoredRuleSetSchema = z
	.object({
		scope: RuleRefSchema,
		rulePreset: RulePresetSchema.nullable(),
		rules: z.array(RuleSchema),
		default: DefaultActionSchema,
		updatedAt: z.string(),
	})
	.meta({ id: "StoredRuleSet" });

/** What a task does, in the terms rules match on. */
export const OperationSchema = z
	.object({
		method: RuleMethodSchema,
		target: z.string(),
	})
	.meta({ id: "Operation" });

/** The result of one rule chain level (doc/design/access-control.md "Authorization rules"). */
export const LevelResultSchema = z
	.object({
		scope: RuleRefSchema,
		own: DefaultActionSchema,
		rule: z.number().optional().describe("Index of the deciding rule in this level; absent when the default applied."),
		matched: RuleSchema.optional().describe("The deciding rule itself, kept with the evaluation."),
		effective: RuleActionSchema,
	})
	.meta({ id: "LevelResult" });

export const EvaluationSchema = z
	.object({
		result: RuleActionSchema,
		levels: z.array(LevelResultSchema),
	})
	.meta({ id: "Evaluation" });

/** How an approval was settled. */
export const ApprovalDecisionSchema = z
	.object({
		decision: z.enum(["approved", "rejected"]),
		by: z.object({ type: z.string(), id: z.string(), onBehalfOfUserId: z.string().optional() }),
		at: z.string(),
		reason: z.string().optional(),
		taskGroupId: z.string().optional().describe("The task group whose approval covered this task."),
	})
	.meta({ id: "ApprovalDecision" });

/** A request handed to an ancestor session's agent instead of going to the user. */
export const AgentRequestSchema = z
	.object({
		session: z.string().describe("The session whose agent decides."),
		state: z.enum(["pending", "escalated"]),
	})
	.meta({ id: "AgentRequest" });

const ReviewSchema = z
	.object({
		decision: z.enum(["approve", "escalate"]),
		reason: z.string(),
		model: z.string(),
	})
	.meta({ id: "Review" });

/** The approval state of a tool call: how the rules judged it, then how it was settled. */
export const ApprovalRecordSchema = z
	.object({
		evaluation: EvaluationSchema,
		decision: ApprovalDecisionSchema.optional(),
		review: ReviewSchema.optional().describe("Auto Review's verdict, when the root's rule preset asked for one."),
		agent: AgentRequestSchema.optional(),
	})
	.meta({ id: "ApprovalRecord" });

/** The approval record of a task group: one evaluation per target node, then one decision. */
export const TaskGroupApprovalRecordSchema = z
	.object({
		nodes: z.array(z.object({ nodeId: z.string(), evaluation: EvaluationSchema })),
		decision: ApprovalDecisionSchema.optional(),
		review: ReviewSchema.optional(),
		agent: AgentRequestSchema.optional(),
	})
	.meta({ id: "TaskGroupApprovalRecord" });

/** Body of `POST /api/tasks/{id}/approval` and `POST /api/task-groups/{id}/approval`. */
export const ApprovalBodySchema = z.object({
	decision: z.enum(["approve", "reject"]),
	reason: z.string().optional().describe("Why; stored as the task's error message when it is not empty."),
	always: RuleInputSchema.optional().describe("An allow rule appended to the root after an approval."),
});
