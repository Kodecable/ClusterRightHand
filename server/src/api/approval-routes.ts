import type { ApprovalList, QuotaApproval } from "@crh/api";
import { type Context, Hono } from "hono";
import { type Audit, userActor } from "../audit/audit.ts";
import type { ApprovalDecision, Cluster, TaskView } from "../cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../cluster/task-groups.ts";
import { parseRulesForWrite } from "../policy/refs.ts";
import type { Rule } from "../policy/rules.ts";
import { appendRule, type RuleRef } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

type QuotaRequest = QuotaApproval;

/** After any rule change: settle what no longer needs approval. */
export async function reevaluateAfterRuleChange(cluster: Cluster, taskGroups: TaskGroups, ref: RuleRef): Promise<void> {
	await cluster.reevaluate(ref);
	await taskGroups.reevaluate(ref);
}

/** Approvals: only the root's owner decides (doc/access-control.md#审批). Expects requireUser. */
export function approvalRoutes(db: Db, cluster: Cluster, taskGroups: TaskGroups, audit: Audit) {
	const app = new Hono<AppEnv>();

	app.get("/approvals", async (c) => {
		const user = c.get("user");
		const approvalRows = await approvalRequestRows(db, user.userId);
		const signatureRows = await signatureRequestRows(db, user.userId);
		const tasks = await taskViews(cluster, approvalRows.tasks);
		const approvalTaskGroups = await taskGroupViews(taskGroups, approvalRows.taskGroups);
		const quotas = await quotaRequests(db, user.userId);
		const signatureTasks = await taskViews(cluster, signatureRows.tasks);
		const signatureTaskGroups = await taskGroupViews(taskGroups, signatureRows.taskGroups);
		const body: ApprovalList = {
			tasks,
			taskGroups: approvalTaskGroups,
			authorizations: { tasks: signatureTasks, taskGroups: signatureTaskGroups },
			quotas,
		};
		return c.json(body);
	});

	/**
	 * `{ decision: "approve" | "reject", reason?, always? }`. `always` is a rule (usually an allow
	 * prefilled from the task) appended to the root, so that similar calls pass from now on.
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
		},
	) => {
		const user = c.get("user");
		if (subject.userId !== user.userId || !subject.chain) return jsonError(c, 404, "no such approval");
		if (!subject.waiting) return jsonError(c, 409, "it is no longer waiting for approval");
		if (subject.handlerType === null) return jsonError(c, 409, "it is no longer waiting for approval");
		if (subject.handlerType !== "user") return jsonError(c, 409, "an agent is handling this request");
		const body = await readJsonObject(c);
		if (!body || (body.decision !== "approve" && body.decision !== "reject")) {
			return jsonError(c, 400, 'decision must be "approve" or "reject"');
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
			await reevaluateAfterRuleChange(cluster, taskGroups, root);
		}
		if (!ok) return jsonError(c, 409, "it is no longer waiting for approval");
		return c.json({ ok: true });
	};

	app.post("/tasks/:id/approval", async (c) => {
		const t = await cluster.getTask(c.req.param("id"));
		if (!t) return jsonError(c, 404, "no such approval");
		return decide(c, {
			kind: "task",
			id: t.id,
			userId: t.onBehalfOfUserId,
			chain: t.ruleChain,
			waiting: t.state === "awaiting_approval",
			handlerType: t.handlerType,
		});
	});

	app.post("/task-groups/:id/approval", async (c) => {
		const g = await taskGroups.get(c.req.param("id"));
		if (!g) return jsonError(c, 404, "no such approval");
		return decide(c, {
			kind: "task_group",
			id: g.id,
			userId: g.onBehalfOfUserId,
			chain: g.ruleChain,
			waiting: g.state === "awaiting_approval",
			handlerType: g.handlerType,
		});
	});

	return app;
}

/** Only requests whose handler is the user; requests routed to an agent are decided in that session. */
async function approvalRequestRows(db: Db, userId: string) {
	const tasks = await db
		.selectFrom("tasks")
		.select("id")
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.where("on_behalf_of_user_id", "=", userId)
		.orderBy("created_at")
		.execute();
	const taskGroups = await db
		.selectFrom("task_groups")
		.select("id")
		.where("state", "=", "awaiting_approval")
		.where("handler_type", "=", "user")
		.where("on_behalf_of_user_id", "=", userId)
		.orderBy("created_at")
		.execute();
	return { tasks, taskGroups };
}

/**
 * Tasks and task groups that passed their rules but still wait for this user's signature. Both entry
 * points share this one list: the approvals page shows them in their own section and the header
 * count adds them up (doc/privilege.md). A task that belongs to a task group is signed through the
 * task group, so only the task group is listed: one signature, one entry.
 */
async function signatureRequestRows(db: Db, userId: string) {
	const tasks = await db
		.selectFrom("tasks")
		.select("id")
		.where("state", "=", "awaiting_authorization")
		.where("on_behalf_of_user_id", "=", userId)
		.where("task_group_id", "is", null)
		.orderBy("created_at")
		.execute();
	const taskGroups = await db
		.selectFrom("task_groups")
		.select("id")
		.where("state", "=", "awaiting_authorization")
		.where("on_behalf_of_user_id", "=", userId)
		.orderBy("created_at")
		.execute();
	return { tasks, taskGroups };
}

async function taskViews(cluster: Cluster, rows: { id: string }[]): Promise<TaskView[]> {
	// One query for the whole list, not one per waiting row.
	return cluster.getTasks(rows.map((row) => row.id));
}

async function taskGroupViews(taskGroups: TaskGroups, rows: { id: string }[]): Promise<TaskGroupView[]> {
	return (await Promise.all(rows.map((r) => taskGroups.get(r.id)))).filter(Boolean) as TaskGroupView[];
}

/**
 * Roots whose quota is used up wait for this user: their own paused run and any subagent paused on the
 * same root are one request (doc/agent-runtime.md#配额). Shared users cannot decide, so only the owner
 * sees them; admins see only their own, like the approvals above.
 */
async function quotaRequests(db: Db, userId: string): Promise<QuotaRequest[]> {
	const pausedRows = await db
		.selectFrom("sessions")
		.select(["waiting_level_id", "owner_user_id"])
		.where("state", "=", "awaiting")
		.where("waiting_kind", "=", "quota")
		.where("waiting_handler_id", "is", null)
		.where("waiting_level_id", "is not", null)
		.execute();
	const quotas: QuotaRequest[] = [];
	const seenRoots = new Set<string>();
	for (const paused of pausedRows) {
		const levelId = paused.waiting_level_id;
		if (!levelId || seenRoots.has(levelId) || paused.owner_user_id !== userId) continue;
		const level = await db
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
			.where("id", "=", levelId)
			.executeTakeFirst();
		if (!level || level.parent_session_id !== null || level.owner_user_id !== userId) continue;
		if (level.quota_tokens === null) continue;
		const budgetRemaining = Number(level.quota_tokens);
		if (budgetRemaining > 0) continue;
		seenRoots.add(levelId);
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
