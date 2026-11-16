/**
 * Authorization rules and approvals (doc/design/access-control.md "Authorization rules" and
 * "Approvals"). The server stores the same shapes; its `Action` / `Method` names are
 * aliases of `RuleAction` / `RuleMethod`.
 */

import type { z } from "zod";
import type {
	AgentRequestSchema,
	ApprovalBodySchema,
	ApprovalDecisionSchema,
	ApprovalPhaseSchema,
	ApprovalRecordSchema,
	DefaultActionSchema,
	EvaluationSchema,
	LevelResultSchema,
	OperationSchema,
	ReviewPendingSchema,
	ReviewSchema,
	ReviewVerdictSchema,
	RuleActionSchema,
	RuleMethodSchema,
	RulePresetSchema,
	RuleRefSchema,
	RuleSchema,
	StoredRuleSetSchema,
	TaskGroupApprovalRecordSchema,
} from "./schemas/policy.ts";

export type RuleAction = z.infer<typeof RuleActionSchema>;
/**
 * What a rule matches on. `ext.read` is a read-only extension tool on an extension whose annotations are
 * trusted; every other extension tool is `ext.write`. `api.read`/`api.write` are the built-in API request
 * extension's own operations (doc/design/extensions.md "Rules and approvals").
 */
export type RuleMethod = z.infer<typeof RuleMethodSchema>;
export type RulePreset = z.infer<typeof RulePresetSchema>;
/** A level's own result; only a lower level than the root may inherit. */
export type DefaultAction = z.infer<typeof DefaultActionSchema>;

export type Rule = z.infer<typeof RuleSchema>;

/** One level of a rule chain, as stored on tasks: root first. */
export type RuleRef = z.infer<typeof RuleRefSchema>;

export type StoredRuleSet = z.infer<typeof StoredRuleSetSchema>;

/** What a task does, in the terms rules match on. */
export type Operation = z.infer<typeof OperationSchema>;

export type LevelResult = z.infer<typeof LevelResultSchema>;

export type Evaluation = z.infer<typeof EvaluationSchema>;

/** How an approval was settled. */
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * A request handed to the agent of an ancestor session instead of going
 * straight to the user (doc/design/agent-runtime.md "Handling subagent requests").
 */
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/** A review record: either Auto Review's pending marker or its settled verdict. */
export type Review = z.infer<typeof ReviewSchema>;

/** Auto Review's settled answer; the pending marker is `ReviewPending`. */
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewPending = z.infer<typeof ReviewPendingSchema>;

/** `reviewing` while Auto Review decides, otherwise `awaiting_user` (only meaningful while awaiting approval). */
export type ApprovalPhase = z.infer<typeof ApprovalPhaseSchema>;

/** The approval state of a tool call: how the rules judged it, then how it was settled. */
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** The approval record of a task group: one evaluation per target node, then one decision. */
export type TaskGroupApprovalRecord = z.infer<typeof TaskGroupApprovalRecordSchema>;

/** Body of `POST /tasks/:id/approval` and `POST /task-groups/:id/approval`. */
export type ApprovalBody = z.infer<typeof ApprovalBodySchema>;
