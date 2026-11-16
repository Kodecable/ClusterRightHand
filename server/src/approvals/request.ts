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
	TaskAction,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import type { Db } from "../storage/db.ts";

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

function taskAlwaysAllow(
	operation: Operation | null,
	nodes: readonly string[],
	privileged: boolean,
): ApprovalAlwaysAllow[] {
	if (!operation) return [];
	const base: Rule = {
		action: "allow",
		method: operation.method,
		...(nodes.length > 0 ? { nodes: [...nodes] } : {}),
		privileged,
	};
	return [
		{ option: "exact", rule: { ...base, exact: operation.target } },
		{ option: "prefix", rule: { ...base, prefix: operation.target } },
	];
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
	if (call.extension !== "crhs-api" || call.tool !== "api_request") return undefined;
	let args = call.arguments;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			return undefined;
		}
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const method = (args as Record<string, unknown>).method;
	const path = (args as Record<string, unknown>).path;
	if (typeof method !== "string" || typeof path !== "string") return undefined;
	return { type: "api_request", method: method.toUpperCase(), path };
}

export async function approvalRequestForTask(db: Db, task: TaskView): Promise<ApprovalRequest> {
	const names = await nodeNames(db, [task.nodeId]);
	const nodeList = cappedNodes(names);
	const review = reviewSummary(task.approval);
	return {
		kind: "task",
		id: task.id,
		phase: task.phase,
		source: task.source,
		action: task.action,
		...nodeList,
		privileged: task.privileged,
		...(review ? { review } : {}),
		alwaysAllow: taskAlwaysAllow(task.operation, names, task.privileged),
	};
}

export async function approvalRequestForTaskGroup(db: Db, group: TaskGroupView): Promise<ApprovalRequest> {
	// Only the nodes whose rule result needs approval are named; the group is approved once for all of them.
	const needing = group.approval
		? group.approval.nodes.filter((node) => node.evaluation.result === "require-approval").map((node) => node.nodeId)
		: group.nodeIds;
	const names = await nodeNames(db, needing);
	const nodeList = cappedNodes(names);
	const review = reviewSummary(group.approval);
	return {
		kind: "task_group",
		id: group.id,
		phase: group.phase,
		source: group.source,
		action: group.action,
		...nodeList,
		privileged: group.privileged,
		...(review ? { review } : {}),
		alwaysAllow: taskAlwaysAllow(group.operation, names, group.privileged),
	};
}

export async function approvalRequestForExternalCall(db: Db, call: ExternalCallView): Promise<ApprovalRequest> {
	const apiAction = apiRequestAction(call);
	const action: TaskAction = apiAction ?? { type: "extension_tool", extension: call.extension, tool: call.tool };
	const review = reviewSummary(call.approval);
	return {
		kind: "external_call",
		id: call.id,
		phase: call.phase,
		source: call.source,
		action,
		privileged: false,
		...(review ? { review } : {}),
		alwaysAllow: externalCallAlwaysAllow(call, apiAction !== undefined),
	};
}
