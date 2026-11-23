import type { ApprovalBody } from "@crh/api";
import {
	ApprovalBodySchema,
	ApprovalListSchema,
	ErrorResponseSchema,
	ExternalCallResponseSchema,
	IdParamSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { alwaysRuleLifts, groupNodesNeedingApproval } from "../approvals/always-allow.ts";
import {
	approvalRequestForExternalCall,
	approvalRequestForPty,
	approvalRequestForTask,
	approvalRequestForTaskGroup,
} from "../approvals/request.ts";
import { type Audit, userActor } from "../audit/audit.ts";
import { pendingReviewIn } from "../cluster/approval.ts";
import type { ApprovalDecision, Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import {
	decideExternalCall,
	externalCallApprovalAudit,
	externalCallPhase,
	externalCallViews,
	getExternalCall,
	pendingExternalCallRows,
	reevaluateExternalCalls,
} from "../extensions/external-calls.ts";
import { parseRulesForWrite } from "../policy/refs.ts";
import type { Operation, Rule } from "../policy/rules.ts";
import { appendRule, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import type { TerminalService } from "../terminals/registry.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import type { AppEnv } from "./context.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Approvals"];

const listRoute = defineRoute({
	method: "get",
	path: "/approvals",
	tags: TAGS,
	summary: "Everything waiting for the caller: approvals, external calls, signatures and exhausted quotas",
	agent: "allow",
	responses: { 200: { description: "The caller's waiting work", ...json(ApprovalListSchema) } },
});

const decideTaskRoute = defineRoute({
	method: "post",
	path: "/tasks/{id}/approval",
	tags: TAGS,
	summary: "Approve or reject a waiting task, optionally appending an allow rule",
	agent: "deny", // an approval decision
	request: { params: IdParamSchema, body: { required: true, ...json(ApprovalBodySchema) } },
	responses: {
		200: { description: "The decision was taken", ...json(OkResponseSchema) },
		409: { description: "The request is no longer waiting for approval", ...json(ErrorResponseSchema) },
	},
});

const decideGroupRoute = defineRoute({
	method: "post",
	path: "/task-groups/{id}/approval",
	tags: TAGS,
	summary: "Approve or reject a waiting task group, optionally appending an allow rule",
	agent: "deny", // an approval decision
	request: { params: IdParamSchema, body: { required: true, ...json(ApprovalBodySchema) } },
	responses: {
		200: { description: "The decision was taken", ...json(OkResponseSchema) },
		409: { description: "The request is no longer waiting for approval", ...json(ErrorResponseSchema) },
	},
});

const externalCallRoute = defineRoute({
	method: "get",
	path: "/external-calls/{id}",
	tags: TAGS,
	summary: "One waiting external call, for the approval detail page",
	agent: "allow",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The external call", ...json(ExternalCallResponseSchema) } },
});

const decideExternalCallRoute = defineRoute({
	method: "post",
	path: "/external-calls/{id}/approval",
	tags: TAGS,
	summary: "Approve or reject a waiting external call, optionally appending an allow rule",
	agent: "deny", // an approval decision
	request: { params: IdParamSchema, body: { required: true, ...json(ApprovalBodySchema) } },
	responses: {
		200: { description: "The decision was taken", ...json(OkResponseSchema) },
		409: { description: "The request is no longer waiting for approval", ...json(ErrorResponseSchema) },
	},
});

/** After any rule change: settle what no longer needs approval, external calls included. */
export async function reevaluateAfterRuleChange(
	db: Db,
	cluster: Cluster,
	taskGroups: TaskGroups,
	ref: RuleRef,
): Promise<void> {
	await cluster.reevaluate(ref);
	await taskGroups.reevaluate(ref);
	await reevaluateExternalCalls(db, ref);
}

/** Approvals: only the root's owner decides (doc/design/access-control.md "Approvals"). Expects requireUser. */
/**
 * The answer to an "always" rule that would not end the approval: it goes to the root, and a lower level of
 * the chain (or a stricter root rule) still holds the request (doc/design/access-control.md "Evaluation").
 */
const NO_LIFT =
	'this "always allow" rule would not end the approval: the restriction comes from a lower level of the rule ' +
	"chain or a stricter rule, which the rule on the root cannot lift";

export function approvalRoutes(
	db: Db,
	cluster: Cluster,
	taskGroups: TaskGroups,
	audit: Audit,
	terminals?: TerminalService,
) {
	const app = apiRouter();

	app.openapi(listRoute, async (c) => {
		const user = c.get("user");
		const approvalRows = await approvalRequestRows(db, user.userId);
		const signatureRows = await signatureRequestRows(db, user.userId);
		const tasks = await taskViews(cluster, approvalRows.tasks);
		const approvalTaskGroups = await taskGroupViews(taskGroups, approvalRows.taskGroups);
		const quotas = await quotaRequests(db, user.userId);
		const signatureTasks = await taskViews(cluster, signatureRows.tasks);
		const signatureTaskGroups = await taskGroupViews(taskGroups, signatureRows.taskGroups);
		const externalCalls = await externalCallViews(db, await pendingExternalCallRows(db, user.userId));
		// Agent terminal requests are the same kind of wait (doc/design/pty.md "Rules"): the terminal's user
		// decides, on its page or through its own approval route.
		const ptys =
			terminals === undefined
				? []
				: await Promise.all(
						terminals
							.pendingApprovals()
							.filter(({ terminal }) => terminal.userId === user.userId)
							.map(async ({ terminal, approval }) => ({
								terminalId: terminal.id,
								nodeId: terminal.nodeId,
								nodeName: terminal.nodeName,
								userId: terminal.userId,
								username: terminal.username,
								createdAt: approval.createdAt,
								request: await approvalRequestForPty(db, terminal, approval),
							})),
					);
		// One compact request per waiting item, beside the kind-specific views (the WebUI and chat render it).
		const requests = [
			...(await Promise.all([...tasks, ...signatureTasks].map((task) => approvalRequestForTask(db, task)))),
			...(await Promise.all(
				[...approvalTaskGroups, ...signatureTaskGroups].map((group) => approvalRequestForTaskGroup(db, group)),
			)),
			...(await Promise.all(externalCalls.map((call) => approvalRequestForExternalCall(db, call)))),
			...ptys.map((item) => item.request),
		];
		return c.json(
			{
				tasks,
				taskGroups: approvalTaskGroups,
				externalCalls,
				ptys,
				authorizations: { tasks: signatureTasks, taskGroups: signatureTaskGroups },
				quotas,
				requests,
			},
			200,
		);
	});

	/**
	 * `{ decision: "approve" | "reject", reason?, always? }`. `always` is a rule, normally one of the
	 * request's own always-allow candidates, appended to the root so similar calls pass from now on.
	 */
	const decide = async (
		c: Context<AppEnv>,
		subject: {
			kind: "task" | "task_group";
			id: string;
			userId: string;
			chain: RuleRef[] | null;
			waiting: boolean;
			handlerType: "agent" | "user" | null;
			phase: "reviewing" | "awaiting_user" | "awaiting_signature";
			/** What is waiting, to check that an "always" rule would end the approval. */
			operation: { method: Operation["method"]; target: string } | null;
			privileged: boolean;
			nodeIds: readonly string[];
		},
		body: ApprovalBody,
	) => {
		const user = c.get("user");
		if (subject.userId !== user.userId || !subject.chain) throw new NotFoundError("no such approval");
		if (!subject.waiting) throw new HTTPException(409, { message: "it is no longer waiting for approval" });
		if (subject.handlerType === null) {
			throw new HTTPException(409, { message: "it is no longer waiting for approval" });
		}
		if (subject.handlerType !== "user") throw new HTTPException(409, { message: "an agent is handling this request" });
		// The decision belongs to the reviewer until it settles; a rule change or its verdict is the way out.
		if (subject.phase === "reviewing") {
			throw new HTTPException(409, { message: "Auto Review is still reviewing this request" });
		}
		const reason =
			typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : undefined;
		const decision: ApprovalDecision = {
			decision: body.decision === "approve" ? "approved" : "rejected",
			by: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
			at: new Date().toISOString(),
			...(reason ? { reason } : {}),
		};
		const root = subject.chain[0] as RuleRef;
		let always: Rule | undefined;
		if (body.decision === "approve" && body.always !== undefined) {
			const [rule] = await parseRulesForWrite(db, await defaultOrgId(db), [body.always]);
			if (rule?.action !== "allow") throw new UserError('an "always" rule must be an allow rule');
			if (!(await alwaysRuleLifts(db, subject.chain, subject.operation, subject.privileged, subject.nodeIds, rule))) {
				throw new UserError(NO_LIFT);
			}
			always = rule;
		}
		const ok =
			subject.kind === "task"
				? await cluster.decide(subject.id, decision, { handlerType: "user" })
				: await taskGroups.decide(subject.id, decision, { handlerType: "user" });
		// The rule is a consequence of the decision: a request that is no longer waiting must not leave it
		// behind, and neither must an approval that only ended the task because its node was deleted.
		if (ok && always && ok !== "node_deleted") {
			await appendRule(db, root, always);
			void audit.record({
				actor: userActor(user),
				action: "rules.changed",
				target: root,
				detail: { appended: always },
			});
			await reevaluateAfterRuleChange(db, cluster, taskGroups, root);
		}
		if (!ok) throw new HTTPException(409, { message: "it is no longer waiting for approval" });
		return { ok: true as const };
	};

	app.openapi(decideTaskRoute, async (c) => {
		const { id } = c.req.valid("param");
		const t = await cluster.getTask(id);
		if (!t) throw new NotFoundError("no such approval");
		return c.json(
			await decide(
				c,
				{
					kind: "task",
					id: t.id,
					userId: t.onBehalfOfUserId,
					chain: t.ruleChain,
					waiting: t.state === "awaiting_approval",
					handlerType: t.handlerType,
					phase: t.phase,
					operation: t.operation,
					privileged: t.privileged,
					nodeIds: [t.nodeId],
				},
				c.req.valid("json"),
			),
			200,
		);
	});

	app.openapi(decideGroupRoute, async (c) => {
		const { id } = c.req.valid("param");
		const g = await taskGroups.get(id);
		if (!g) throw new NotFoundError("no such approval");
		return c.json(
			await decide(
				c,
				{
					kind: "task_group",
					id: g.id,
					userId: g.onBehalfOfUserId,
					chain: g.ruleChain,
					waiting: g.state === "awaiting_approval",
					handlerType: g.handlerType,
					phase: g.phase,
					operation: g.operation,
					privileged: g.privileged,
					nodeIds: groupNodesNeedingApproval(g),
				},
				c.req.valid("json"),
			),
			200,
		);
	});

	/** One waiting external call, for the approval detail page. */
	app.openapi(externalCallRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const row = await getExternalCall(db, id);
		if (!row || row.on_behalf_of_user_id !== user.userId) throw new NotFoundError("no such approval");
		const view = (await externalCallViews(db, [row]))[0];
		if (!view) throw new NotFoundError("no such approval");
		const request = view.state === "awaiting_approval" ? await approvalRequestForExternalCall(db, view) : null;
		return c.json({ externalCall: view, request }, 200);
	});

	/** The owner approves or rejects a waiting external call; "always allow" writes an allow rule. */
	app.openapi(decideExternalCallRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const body = c.req.valid("json");
		const row = await getExternalCall(db, id);
		if (!row || row.on_behalf_of_user_id !== user.userId) throw new NotFoundError("no such approval");
		if (row.state !== "awaiting_approval" || row.handler_type !== "user") {
			throw new HTTPException(409, { message: "it is no longer waiting for approval" });
		}
		if (externalCallPhase(row) === "reviewing") {
			throw new HTTPException(409, { message: "Auto Review is still reviewing this request" });
		}
		const reason =
			typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : undefined;
		const chain = row.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null;
		const root = chain?.[0];
		let always: Rule | undefined;
		if (body.decision === "approve" && body.always !== undefined) {
			if (!root) throw new HTTPException(409, { message: "the call has no rule chain" });
			const [rule] = await parseRulesForWrite(db, await defaultOrgId(db), [body.always]);
			if (rule?.action !== "allow") throw new UserError('an "always" rule must be an allow rule');
			const operation = JSON.parse(row.operation) as { method: Operation["method"]; target: string };
			if (!(await alwaysRuleLifts(db, chain, operation, false, null, rule))) throw new UserError(NO_LIFT);
			always = rule;
		}
		const ok = await decideExternalCall(
			db,
			row.id,
			{
				decision: body.decision === "approve" ? "approved" : "rejected",
				by: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
				at: new Date().toISOString(),
				...(reason ? { reason } : {}),
			},
			reason,
		);
		if (!ok) throw new HTTPException(409, { message: "it is no longer waiting for approval" });
		void audit.record(externalCallApprovalAudit(userActor(user), row, body.decision, reason));
		if (always && root) {
			await appendRule(db, root, always);
			void audit.record({
				actor: userActor(user),
				action: "rules.changed",
				target: root,
				detail: { appended: always },
			});
			await reevaluateAfterRuleChange(db, cluster, taskGroups, root);
		}
		return c.json({ ok: true as const }, 200);
	});

	return app;
}

/** Only requests whose handler is the user; requests routed to an agent are decided in that session. */
async function approvalRequestRows(db: Db, userId: string) {
	const tasks = await db
		.selectFrom("tasks")
		.select(["id", "approval"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.where("on_behalf_of_user_id", "=", userId)
		.orderBy("created_at")
		.execute();
	const taskGroups = await db
		.selectFrom("task_groups")
		.select(["id", "approval"])
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.where("on_behalf_of_user_id", "=", userId)
		.orderBy("created_at")
		.execute();
	// A request Auto Review is still judging is not a user-facing approval yet (doc/design/access-control.md "Auto Review").
	return {
		tasks: tasks.filter((row) => !pendingReviewIn(row.approval)),
		taskGroups: taskGroups.filter((row) => !pendingReviewIn(row.approval)),
	};
}

/**
 * Tasks and task groups that passed their rules but still wait for this user's authorization. Both
 * entry points share this one list: the approvals page shows them in their own section and the header
 * count adds them up (doc/design/privilege.md). A task that belongs to a task group is authorized
 * through the task group, so only the task group is listed: one decision, one entry.
 */
async function signatureRequestRows(db: Db, userId: string) {
	const tasks = await db
		.selectFrom("tasks")
		.select(["id", "authorization"])
		.where("state", "=", "awaiting_authorization")
		.where("on_behalf_of_user_id", "=", userId)
		.where("task_group_id", "is", null)
		.orderBy("created_at")
		.execute();
	// A group whose members are partly running keeps the state `running`; it still waits while one member
	// is in `awaiting_authorization` (doc/design/execution.md "Task groups").
	const taskGroups = await db
		.selectFrom("task_groups")
		.select("id")
		.where("on_behalf_of_user_id", "=", userId)
		.where((eb) =>
			eb.or([
				eb("state", "=", "awaiting_authorization"),
				eb.exists(
					eb
						.selectFrom("tasks")
						.select("tasks.id")
						.whereRef("tasks.task_group_id", "=", "task_groups.id")
						.where("tasks.state", "=", "awaiting_authorization"),
				),
			]),
		)
		.orderBy("created_at")
		.execute();
	return { tasks, taskGroups };
}

async function taskViews(cluster: Cluster, rows: { id: string }[]) {
	// One query for the whole list, not one per waiting row.
	return cluster.getTasks(rows.map((row) => row.id));
}

async function taskGroupViews(taskGroups: TaskGroups, rows: { id: string }[]) {
	// One read for rows, members and reference names, not three per waiting group.
	return taskGroups.getMany(rows.map((row) => row.id));
}

/**
 * Roots whose quota is used up wait for this user: their own paused run and any subagent paused on the
 * same root are one request (doc/design/agent-runtime.md "Quota and token accounting"). Shared users cannot decide, so only the owner
 * sees them; admins see only their own, like the approvals above.
 */
async function quotaRequests(db: Db, userId: string) {
	// Only this user's paused rows; other users' rows never leave the database.
	const pausedRows = await db
		.selectFrom("sessions")
		.select("waiting_level_id")
		.where("state", "=", "awaiting")
		.where("waiting_kind", "=", "quota")
		.where("waiting_handler_id", "is", null)
		.where("owner_user_id", "=", userId)
		.where("waiting_level_id", "is not", null)
		.execute();
	// One level may carry several paused runs; keep the first sighting, so the list keeps its scan order.
	const levelIds = [
		...new Set(pausedRows.map((row) => row.waiting_level_id).filter((id): id is string => id !== null)),
	];
	if (levelIds.length === 0) return [];
	const levels = await db
		.selectFrom("sessions")
		.select([
			"id",
			"title",
			"parent_session_id",
			"quota_tokens",
			"budget_used_tokens",
			"state_changed_at",
			"owner_user_id",
		])
		.where("id", "in", levelIds)
		.execute();
	const byId = new Map(levels.map((level) => [level.id, level] as const));
	const quotas: {
		sessionId: string;
		levelId: string;
		title: string | null;
		since: string;
		budgetRemaining: number;
		budgetUsedTokens: number;
	}[] = [];
	for (const levelId of levelIds) {
		const level = byId.get(levelId);
		if (!level || level.parent_session_id !== null || level.owner_user_id !== userId) continue;
		if (level.quota_tokens === null) continue;
		const budgetRemaining = Number(level.quota_tokens);
		if (budgetRemaining > 0) continue;
		quotas.push({
			sessionId: level.id,
			levelId: level.id,
			title: level.title,
			since: level.state_changed_at ?? "",
			budgetRemaining,
			budgetUsedTokens: Number(level.budget_used_tokens),
		});
	}
	return quotas;
}
