import { type Context, Hono } from "hono";
import { type Audit, listAuditEvents, userActor, verifyChain } from "../audit/audit.ts";
import { createApiToken, deleteApiToken, getApiToken, listApiTokens, revokeApiToken } from "../auth/api-tokens.ts";
import type { ApprovalDecision, Cluster, TaskView } from "../cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../cluster/task-groups.ts";
import { parseRules } from "../policy/rules.ts";
import { appendRule, parsePreset, type RuleRef, setPreset, setRules } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

/**
 * API tokens (with their rules), approvals and the audit log. Management needs a WebUI session: these
 * routes sit behind requireUser, and API tokens only work at /mcp.
 */
export function policyRoutes(db: Db, cluster: Cluster, groups: TaskGroups, audit: Audit) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError) return jsonError(c, 400, err.message);
		throw err;
	});

	/** After any rule change: settle what no longer needs approval. */
	const rulesChanged = async (ref: RuleRef) => {
		await cluster.reevaluate(ref);
		await groups.reevaluate(ref);
	};

	// ---- API tokens ----

	app.get("/api-tokens", async (c) => c.json({ tokens: await listApiTokens(db, c.get("user")) }));

	app.post("/api-tokens", async (c) => {
		const user = c.get("user");
		const body = (await readJsonObject(c)) ?? {};
		const days = body.days === null ? null : body.days === undefined ? undefined : Number(body.days);
		const { token, view } = await createApiToken(db, user, {
			name: typeof body.name === "string" ? body.name : "",
			preset: parsePreset(body.preset ?? "ask"),
			days,
		});
		void audit.record({
			actor: userActor(user),
			action: "api_token.created",
			target: { type: "api_token", id: view.id },
			detail: { name: view.name, preset: view.rules?.preset, expires_at: view.expiresAt },
		});
		return c.json({ token, apiToken: view }, 201);
	});

	app.post("/api-tokens/:id/revoke", async (c) => {
		const user = c.get("user");
		await revokeApiToken(db, user, c.req.param("id"));
		void audit.record({
			actor: userActor(user),
			action: "api_token.revoked",
			target: { type: "api_token", id: c.req.param("id") },
		});
		// What the token started and is still waiting for approval will not run.
		const decision: ApprovalDecision = {
			decision: "rejected",
			by: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
			at: new Date().toISOString(),
			reason: "the API token was revoked",
		};
		for (const table of ["tasks", "task_groups"] as const) {
			const rows = await db
				.selectFrom(table)
				.select("id")
				.where("state", "=", "awaiting_approval")
				.where("actor_type", "=", "api_token")
				.where("actor_id", "=", c.req.param("id"))
				.execute();
			for (const { id } of rows) {
				await (table === "tasks" ? cluster.decide(id, decision) : groups.decide(id, decision));
			}
		}
		return c.json({ apiToken: await getApiToken(db, user, c.req.param("id")) });
	});

	app.delete("/api-tokens/:id", async (c) => {
		const user = c.get("user");
		await deleteApiToken(db, user, c.req.param("id"));
		void audit.record({
			actor: userActor(user),
			action: "api_token.deleted",
			target: { type: "api_token", id: c.req.param("id") },
		});
		return c.json({ ok: true });
	});

	/** Changes a token's preset and/or the rules added on top; `{ preset?, rules? }`. */
	app.put("/api-tokens/:id/rules", async (c) => {
		const user = c.get("user");
		const id = c.req.param("id");
		if (!(await getApiToken(db, user, id))) return jsonError(c, 404, "no such token");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const ref: RuleRef = { type: "api_token", id };
		const preset = body.preset === undefined ? undefined : parsePreset(body.preset);
		const rules = body.rules === undefined ? undefined : parseRules(body.rules);
		if (preset) await setPreset(db, ref, preset);
		if (rules) await setRules(db, ref, rules);
		void audit.record({
			actor: userActor(user),
			action: "rules.changed",
			target: { type: "api_token", id },
			detail: { preset, rules },
		});
		await rulesChanged(ref);
		return c.json({ apiToken: await getApiToken(db, user, id) });
	});

	// ---- approvals: only the root's owner decides (doc/access-control.md#审批) ----

	app.get("/approvals", async (c) => {
		const user = c.get("user");
		// Only requests whose handler is the user; requests routed to an agent are decided in that session.
		const taskRows = await db
			.selectFrom("tasks")
			.select("id")
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "user")
			.where("on_behalf_of_user_id", "=", user.userId)
			.orderBy("created_at")
			.execute();
		const groupRows = await db
			.selectFrom("task_groups")
			.select("id")
			.where("state", "=", "awaiting_approval")
			.where("handler_type", "=", "user")
			.where("on_behalf_of_user_id", "=", user.userId)
			.orderBy("created_at")
			.execute();
		const tasks = (await Promise.all(taskRows.map((r) => cluster.getTask(r.id)))).filter(Boolean) as TaskView[];
		const taskGroups = (await Promise.all(groupRows.map((r) => groups.get(r.id)))).filter(Boolean) as TaskGroupView[];
		return c.json({ tasks, taskGroups });
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
		let always: unknown;
		if (body.decision === "approve" && body.always !== undefined) {
			const [rule] = parseRules([body.always]);
			if (rule?.action !== "allow") throw new UserError('an "always" rule must be an allow rule');
			always = rule;
			await appendRule(db, root, rule);
			void audit.record({ actor: userActor(user), action: "rules.changed", target: root, detail: { appended: rule } });
		}
		const ok =
			subject.kind === "task" ? await cluster.decide(subject.id, decision) : await groups.decide(subject.id, decision);
		if (always) await rulesChanged(root);
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
		const g = await groups.get(c.req.param("id"));
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

	// ---- audit ----

	app.get("/audit", async (c) => {
		const q = c.req.query();
		const action = q.action && /^[a-z_.]{1,64}$/.test(q.action) ? q.action : undefined;
		const events = await listAuditEvents(db, c.get("user"), {
			action,
			targetType: q.targetType || undefined,
			targetId: q.targetId || undefined,
			beforeSeq: q.beforeSeq ? Number(q.beforeSeq) || undefined : undefined,
			limit: q.limit ? Number(q.limit) || undefined : undefined,
		});
		return c.json({ events });
	});

	app.get("/audit/verify", async (c) => {
		if (c.get("user").kind !== "admin") return jsonError(c, 403, "administrators only");
		return c.json(await verifyChain(db));
	});

	return app;
}
