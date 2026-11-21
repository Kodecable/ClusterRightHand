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
	"upgrade",
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

/**
 * Auto Review in progress: written in the same row write that enters `awaiting_approval`, so a request that
 * the reviewer will judge is not shown to the user (doc/design/access-control.md "Auto Review"). The verdict
 * replaces it; a request whose review never ran drops it and becomes a user-facing approval again.
 */
export const ReviewPendingSchema = z
	.object({
		status: z.literal("pending"),
		startedAt: z.string(),
	})
	.meta({ id: "ReviewPending" });

/** Auto Review's answer: the decision, risk, reason and the model that gave it. */
export const ReviewVerdictSchema = z
	.object({
		decision: z.enum(["approve", "escalate"]),
		risk: z.enum(["low", "medium", "high"]).describe("The risk level the reviewer assigned."),
		reason: z.string(),
		model: z.string(),
	})
	.meta({ id: "ReviewVerdict" });

/** A stored review: pending or settled. The older settled shape has no `status` field. */
export const ReviewSchema = z.union([ReviewPendingSchema, ReviewVerdictSchema]).meta({ id: "Review" });

/**
 * What a waiting approval looks like from outside. `reviewing` means Auto Review is still deciding, so the
 * operation counts as running and is not yet a user-facing approval; `awaiting_user` is the ordinary wait;
 * `awaiting_signature` is a task or task group that passed its rules but needs the user's signature.
 */
export const ApprovalPhaseSchema = z
	.enum(["reviewing", "awaiting_user", "awaiting_signature"])
	.describe(
		"`reviewing` only while awaiting_approval with Auto Review still deciding; `awaiting_signature` while awaiting_authorization.",
	);

/** The approval state of a tool call: how the rules judged it, then how it was settled. */
export const ApprovalRecordSchema = z
	.object({
		evaluation: EvaluationSchema,
		decision: ApprovalDecisionSchema.optional(),
		review: ReviewSchema.optional().describe("Auto Review's pending marker or its verdict, when it applies."),
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
