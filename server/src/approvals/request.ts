/**
 * The one compact, locale-free approval description (doc/design/access-control.md "Approvals"): the
 * channel manager, the approvals API and the WebUI render this model instead of each building its own
 * summary. It is built here from the task, task group or external call row and view, never from prose.
 */
import type {
	ApprovalAlwaysAllow,
	ApprovalRequest,
	ApprovalReviewSummary,
	ExternalCallView,
	Operation,
	Rule,
	RuleRef,
	TaskAction,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import { externalCallTaskAction, getExternalCall } from "../extensions/external-calls.ts";
import type { ChainLevel, Operation as RuleOperation } from "../policy/rules.ts";
import { requestSourceFor } from "../request-source.ts";
import type { Db } from "../storage/db.ts";
import type { Terminal, TerminalApproval } from "../terminals/types.ts";
import { groupNodesNeedingApproval, liftsWithRule, loadRequestChain, waitingOperations } from "./always-allow.ts";

/** A chat card names at most this many nodes; `moreNodes` carries the rest. */
const NODE_LIMIT = 10;

type ReviewShape = { review?: { risk?: string; reason?: unknown; status?: unknown } } | null | undefined;

function reviewSummary(approval: ReviewShape): ApprovalReviewSummary | undefined {
	const review = approval?.review;
	// A pending marker is not a verdict: the request is still reviewing, so no review line is shown.
	if (!review || review.status !== undefined) return undefined;
	const risk = review.risk;
	const reason = review.reason;
	if (risk !== "low" && risk !== "medium" && risk !== "high") return undefined;
	if (typeof reason !== "string") return undefined;
	return { risk, reason };
}

/** Node names in the order given; a deleted or unknown node keeps its id so the card still names it. */
async function nodeNames(db: Db, nodeIds: readonly string[]): Promise<string[]> {
	const ids = [...new Set(nodeIds)];
	if (ids.length === 0) return [];
	const rows = await db.selectFrom("nodes").select(["id", "name"]).where("id", "in", ids).execute();
	const names = new Map(rows.map((row) => [row.id, row.name] as const));
	return nodeIds.map((id) => names.get(id) ?? id);
}

function cappedNodes(all: readonly string[]): { nodes?: string[]; moreNodes?: number } {
	if (all.length === 0) return {};
	const nodes = [...all.slice(0, NODE_LIMIT)];
	return all.length > NODE_LIMIT ? { nodes, moreNodes: all.length - NODE_LIMIT } : { nodes };
}

/**
 * A task's or task group's always-allow candidates: this target or this prefix, on these nodes. The rule shown
 * names the nodes; the one tested names their ids, as a stored rule would. A candidate that would not end the
 * approval (doc/design/access-control.md "Evaluation") is left out.
 */
async function taskAlwaysAllow(
	db: Db,
	chain: Parameters<typeof loadRequestChain>[1],
	operation: Operation | null,
	nodeIds: readonly string[],
	names: readonly string[],
	privileged: boolean,
): Promise<ApprovalAlwaysAllow[]> {
	if (!operation) return [];
	const levels = await loadRequestChain(db, chain);
	const operations = await waitingOperations(db, operation, privileged, nodeIds);
	const base: Rule = {
		action: "allow",
		method: operation.method,
		...(names.length > 0 ? { nodes: [...names] } : {}),
		privileged,
	};
	const candidates: ApprovalAlwaysAllow[] = [
		{ option: "exact", rule: { ...base, exact: operation.target } },
		{ option: "prefix", rule: { ...base, prefix: operation.target } },
	];
	return candidates.filter((candidate) =>
		liftsWithRule(levels, operations, {
			...candidate.rule,
			...(nodeIds.length > 0 ? { nodes: [...nodeIds] } : {}),
		}),
	);
}

/** Keeps the candidates that would end the approval of these operations. */
function lifting(
	levels: ChainLevel[] | null,
	operations: readonly RuleOperation[],
	candidates: ApprovalAlwaysAllow[],
): ApprovalAlwaysAllow[] {
	return candidates.filter((candidate) => liftsWithRule(levels, operations, candidate.rule));
}

/** An extension call's always-allow candidates: this tool or the whole extension, or this request or route. */
function externalCallAlwaysAllow(call: ExternalCallView, apiRequest: boolean): ApprovalAlwaysAllow[] {
	const method = call.operation.method;
	if (apiRequest) {
		return [
			{ option: "request", rule: { action: "allow", method, exact: call.operation.target } },
			{ option: "route", rule: { action: "allow", method, prefix: call.operation.target } },
		];
	}
	return [
		{ option: "tool", rule: { action: "allow", method, exact: `${call.extension}/${call.tool}` } },
		{ option: "extension", rule: { action: "allow", method, prefix: `${call.extension}/` } },
	];
}

/** `api_request` arguments as the tool receives them; the model may send them as a JSON string. */
function apiRequestAction(call: ExternalCallView): TaskAction | undefined {
	const action = externalCallTaskAction(call.extension, call.tool, call.arguments);
	return action.type === "api_request" ? action : undefined;
}

/**
 * The job a waiting task, task group or external call belongs to (doc/design/jobs.md "Approvals and jobs").
 * A record only gets one when a tool call started it: a task the WebUI's Run task dialog created has no job.
 */
async function jobRefFor(
	db: Db,
	resourceType: "task" | "task_group" | "external_call",
	resourceId: string,
	action: TaskAction,
): Promise<NonNullable<ApprovalRequest["job"]> | undefined> {
	const row = await db
		.selectFrom("jobs")
		.select(["id", "kind", "action"])
		.where("resource_type", "=", resourceType)
		.where("resource_id", "=", resourceId)
		.executeTakeFirst();
	if (!row) return undefined;
	let stored: TaskAction | undefined;
	try {
		stored = JSON.parse(row.action) as TaskAction;
	} catch {
		stored = undefined;
	}
	return { id: row.id, kind: row.kind, action: stored ?? action };
}

export async function approvalRequestForTask(db: Db, task: TaskView): Promise<ApprovalRequest> {
	const names = await nodeNames(db, [task.nodeId]);
	const nodeList = cappedNodes(names);
	const review = reviewSummary(task.approval);
	const job = await jobRefFor(db, "task", task.id, task.action);
	return {
		kind: "task",
		id: task.id,
		phase: task.phase,
		source: task.source,
		action: task.action,
		...nodeList,
		privileged: task.privileged,
		...(review ? { review } : {}),
		...(job ? { job } : {}),
		alwaysAllow: await taskAlwaysAllow(db, task.ruleChain, task.operation, [task.nodeId], names, task.privileged),
	};
}

export async function approvalRequestForTaskGroup(db: Db, group: TaskGroupView): Promise<ApprovalRequest> {
	// Only the nodes whose rule result needs approval are named; the group is approved once for all of them.
	const needing = groupNodesNeedingApproval(group);
	const names = await nodeNames(db, needing);
	const nodeList = cappedNodes(names);
	const review = reviewSummary(group.approval);
	const alwaysAllow = await taskAlwaysAllow(db, group.ruleChain, group.operation, needing, names, group.privileged);
	const job = await jobRefFor(db, "task_group", group.id, group.action);
	return {
		kind: "task_group",
		id: group.id,
		phase: group.phase,
		source: group.source,
		action: group.action,
		...nodeList,
		privileged: group.privileged,
		...(review ? { review } : {}),
		...(job ? { job } : {}),
		alwaysAllow,
	};
}

/**
 * A terminal rule approval as the one compact request every surface renders (doc/design/pty.md "Rules"):
 * the acting session is the source, the node is named, and the action is the argv a `pty_open` would run
 * or the input and keys a `pty_write` would send. The screen stays on the server as Auto Review's
 * context and never reaches a client. The terminal keeps the same approval in its view, so the terminal
 * page and the approvals page show one model.
 */
export async function approvalRequestForPty(
	db: Db,
	terminal: Terminal,
	approval: TerminalApproval,
): Promise<ApprovalRequest> {
	const names = await nodeNames(db, [terminal.nodeId]);
	const nodeList = cappedNodes(names);
	const source = await requestSourceFor(db, "session", approval.sessionId, terminal.userId);
	return {
		kind: "pty",
		id: terminal.id,
		phase: "awaiting_user",
		source,
		action:
			approval.method === "pty.create"
				? { type: "pty.create", argv: [...approval.argv] }
				: {
						type: "pty.io",
						input: approval.input,
						keys: [...approval.keys],
					},
		...nodeList,
		privileged: approval.privileged,
		alwaysAllow: approval.alwaysAllow.map((candidate) => ({
			option: candidate.option,
			rule: { ...candidate.rule, ...(candidate.rule.nodes ? { nodes: [...candidate.rule.nodes] } : {}) },
		})),
	};
}

/**
 * The compact request of an agent-created privileged terminal's signature wait: the same kind `pty`,
 * with phase `awaiting_signature` and the open's argv, so the shared signature panel renders it beside a
 * task's wait (doc/design/pty.md "Approvals"). It has no always-allow candidates: a signature is not a
 * rule decision.
 */
export async function approvalRequestForPtyAuthorization(db: Db, terminal: Terminal): Promise<ApprovalRequest> {
	const names = await nodeNames(db, [terminal.nodeId]);
	const nodeList = cappedNodes(names);
	const sessionId = terminal.createdBySessionId as string;
	const source = await requestSourceFor(db, "session", sessionId, terminal.userId);
	return {
		kind: "pty",
		id: terminal.id,
		phase: "awaiting_signature",
		source,
		action: { type: "pty.create", argv: [...terminal.argv] },
		...nodeList,
		privileged: terminal.privileged,
		alwaysAllow: [],
	};
}

export async function approvalRequestForExternalCall(db: Db, call: ExternalCallView): Promise<ApprovalRequest> {
	const apiAction = apiRequestAction(call);
	const action: TaskAction = apiAction ?? { type: "extension_tool", extension: call.extension, tool: call.tool };
	const review = reviewSummary(call.approval);
	const row = await getExternalCall(db, call.id);
	const levels = await loadRequestChain(db, row?.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null);
	const operations = await waitingOperations(db, call.operation, false, null);
	const job = await jobRefFor(db, "external_call", call.id, action);
	return {
		kind: "external_call",
		id: call.id,
		phase: call.phase,
		source: call.source,
		action,
		privileged: false,
		...(review ? { review } : {}),
		...(job ? { job } : {}),
		alwaysAllow: lifting(levels, operations, externalCallAlwaysAllow(call, apiAction !== undefined)),
	};
}
