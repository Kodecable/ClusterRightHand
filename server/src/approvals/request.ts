/**
 * The one compact, locale-free approval description (doc/design/access-control.md "Approvals"): the
 * channel manager, the approvals API and (later) the WebUI render this model instead of each building its
 * own summary. It is built here from the task, task group or external call row and view, never from prose.
 */
import type {
	ApprovalAction,
	ApprovalAlwaysAllow,
	ApprovalRequest,
	ApprovalRequester,
	ApprovalReviewSummary,
	ExternalCallView,
	Operation,
	Rule,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import { taskSpecFromJson } from "@crh/protocol";
import { rootSessionIdOf } from "../sessions/session-chain.ts";
import type { Db } from "../storage/db.ts";
import { shellQuote } from "../util/shell-quote.ts";

/** Commands and paths stay one line in chat; the command itself is capped as the model asks. */
const COMMAND_LIMIT = 300;
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

function clipCommand(command: string): string {
	const oneLine = command.replace(/[\r\n]+/g, " ").trim();
	return oneLine.length <= COMMAND_LIMIT ? oneLine : `${oneLine.slice(0, COMMAND_LIMIT - 1)}…`;
}

function execCommand(spec: { command: { argv: string[] } | { shell: string } }): string {
	return "argv" in spec.command ? spec.command.argv.map((arg) => shellQuote(arg)).join(" ") : spec.command.shell;
}

function actionOfSpec(specJson: string | null, fallbackKind: string, fallbackSummary: string): ApprovalAction {
	let spec: ReturnType<typeof taskSpecFromJson> | undefined;
	try {
		spec = taskSpecFromJson(JSON.parse(specJson ?? "null"));
	} catch {
		spec = undefined;
	}
	if (!spec) {
		// An unreadable stored spec is still worth showing; the approval pages carry the exact row.
		return { type: "exec", command: clipCommand(fallbackSummary || fallbackKind) };
	}
	switch (spec.kind) {
		case "exec":
			return { type: "exec", command: clipCommand(execCommand(spec)) };
		case "file.read":
			return {
				type: "file",
				operation: "read",
				path: spec.path,
				lines: { start: spec.startLine, end: spec.startLine + spec.lineCount - 1 },
			};
		case "file.write":
			return { type: "file", operation: "write", path: spec.path };
		case "file.push":
			return { type: "file", operation: "push", path: spec.path };
		case "file.pull":
			return { type: "file", operation: "pull", path: spec.path };
		case "file.edit":
			return { type: "file", operation: "edit", path: spec.path };
		case "file.stat":
			return { type: "file", operation: "stat", path: spec.path };
		case "file.list":
			return { type: "file", operation: "list", path: spec.path };
	}
}

async function requesterFor(
	db: Db,
	actorType: string,
	actorId: string,
	onBehalfOfUserId: string,
): Promise<ApprovalRequester> {
	if (actorType === "session" || actorType === "subagent") {
		// A subagent's request is shown against the root session the user knows; the stored title may be empty.
		const rootId = (await rootSessionIdOf(db, actorId)) ?? actorId;
		const session = await db.selectFrom("sessions").select(["id", "title"]).where("id", "=", rootId).executeTakeFirst();
		if (session) return { type: "session", sessionId: session.id, title: session.title ?? "" };
	}
	if (actorType === "api_token") {
		const token = await db.selectFrom("api_tokens").select(["id", "name"]).where("id", "=", actorId).executeTakeFirst();
		return { type: "api_token", tokenId: actorId, name: token?.name ?? actorId };
	}
	if (actorType === "schedule") {
		const schedule = await db
			.selectFrom("schedules")
			.select(["id", "name"])
			.where("id", "=", actorId)
			.executeTakeFirst();
		return { type: "schedule", scheduleId: actorId, name: schedule?.name ?? actorId };
	}
	const user = await db
		.selectFrom("users")
		.select(["id", "username"])
		.where("id", "=", actorType === "user" ? actorId : onBehalfOfUserId)
		.executeTakeFirst();
	return {
		type: "user",
		userId: user?.id ?? onBehalfOfUserId,
		username: user?.username ?? (actorType === "user" ? actorId : onBehalfOfUserId),
	};
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
function apiRequestAction(call: ExternalCallView): ApprovalAction | undefined {
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
	const stored = await db.selectFrom("tasks").select("spec").where("id", "=", task.id).executeTakeFirst();
	const action = actionOfSpec(stored?.spec ?? null, task.kind, task.summary);
	const names = await nodeNames(db, [task.nodeId]);
	const nodeList = cappedNodes(names);
	const review = reviewSummary(task.approval);
	return {
		kind: "task",
		id: task.id,
		phase: task.phase,
		requester: await requesterFor(db, task.actorType, task.actorId, task.onBehalfOfUserId),
		action,
		...nodeList,
		privileged: task.privileged,
		...(review ? { review } : {}),
		alwaysAllow: taskAlwaysAllow(task.operation, names, task.privileged),
	};
}

export async function approvalRequestForTaskGroup(db: Db, group: TaskGroupView): Promise<ApprovalRequest> {
	const stored = await db.selectFrom("task_groups").select("spec").where("id", "=", group.id).executeTakeFirst();
	const action = actionOfSpec(stored?.spec ?? null, group.kind, group.summary);
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
		requester: await requesterFor(db, group.actorType, group.actorId, group.onBehalfOfUserId),
		action,
		...nodeList,
		privileged: group.privileged,
		...(review ? { review } : {}),
		alwaysAllow: taskAlwaysAllow(group.operation, names, group.privileged),
	};
}

export async function approvalRequestForExternalCall(db: Db, call: ExternalCallView): Promise<ApprovalRequest> {
	const apiAction = apiRequestAction(call);
	const action: ApprovalAction = apiAction ?? { type: "extension_tool", extension: call.extension, tool: call.tool };
	const review = reviewSummary(call.approval);
	return {
		kind: "external_call",
		id: call.id,
		phase: call.phase,
		requester: await requesterFor(db, call.actorType, call.actorId, call.onBehalfOfUserId),
		action,
		privileged: false,
		...(review ? { review } : {}),
		alwaysAllow: externalCallAlwaysAllow(call, apiAction !== undefined),
	};
}
