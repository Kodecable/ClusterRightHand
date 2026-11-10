/**
 * Authorization rules and approvals (doc/design/access-control.md "Authorization rules" and
 * "Approvals"). The server stores the same shapes; its `Action` / `Method` names are
 * aliases of `RuleAction` / `RuleMethod`.
 */

export type RuleAction = "allow" | "deny" | "require-approval";
export type RuleMethod = "exec" | "file.read" | "file.write";
export type RulePreset = "ask" | "auto_review" | "yolo";
/** A level's own result; only a lower level than the root may inherit. */
export type DefaultAction = RuleAction | "inherit";

export interface Rule {
	action: RuleAction;
	method?: RuleMethod;
	/** Node/node-group names or ids on input; the server stores UUIDs or `_all`. */
	nodes?: string[];
	/** true matches only privileged tasks, false only ordinary ones; omitted matches both. */
	privileged?: boolean;
	exact?: string;
	prefix?: string;
}

/** One level of a rule chain, as stored on tasks: root first. */
export interface RuleRef {
	type: string;
	id: string;
}

export interface StoredRuleSet {
	scope: RuleRef;
	rulePreset: RulePreset | null;
	rules: Rule[];
	default: DefaultAction;
	updatedAt: string;
}

/** What a task does, in the terms rules match on. */
export interface Operation {
	method: RuleMethod;
	target: string;
}

export interface LevelResult {
	scope: RuleRef;
	own: DefaultAction;
	/** Index of the deciding rule in this level's rules; absent when the default applied. */
	rule?: number;
	/** The deciding rule itself, kept with the evaluation so later edits do not change history. */
	matched?: Rule;
	effective: RuleAction;
}

export interface Evaluation {
	result: RuleAction;
	levels: LevelResult[];
}

/** How an approval was settled. */
export interface ApprovalDecision {
	decision: "approved" | "rejected";
	by: { type: string; id: string; onBehalfOfUserId?: string };
	at: string;
	reason?: string;
	/** The task group whose approval covered this task. */
	taskGroupId?: string;
}

/**
 * A request handed to the agent of an ancestor session instead of going
 * straight to the user (doc/design/agent-runtime.md "Handling subagent requests").
 */
export interface AgentRequest {
	/** The session whose agent decides; its agent calls subagent_decide. */
	session: string;
	/** `escalated`: its agent passed it on to the user. */
	state: "pending" | "escalated";
}

/** The approval state of a tool call: how the rules judged it, then how it was settled. */
export interface ApprovalRecord {
	evaluation: Evaluation;
	decision?: ApprovalDecision;
	/** Auto Review's verdict, when the root's rule preset asked for one. */
	review?: { decision: "approve" | "escalate"; reason: string; model: string };
	/** Set while (or after) an ancestor's agent had the request. */
	agent?: AgentRequest;
}

/** The approval record of a task group: one evaluation per target node, then one decision. */
export interface TaskGroupApprovalRecord {
	nodes: { nodeId: string; evaluation: Evaluation }[];
	decision?: ApprovalDecision;
	review?: { decision: "approve" | "escalate"; reason: string; model: string };
	agent?: AgentRequest;
}

/** Body of `POST /tasks/:id/approval` and `POST /task-groups/:id/approval`. */
export interface ApprovalBody {
	decision: "approve" | "reject";
	reason?: string;
	always?: Rule;
}
