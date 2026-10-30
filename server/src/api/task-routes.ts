import type { TaskSpec } from "@crh/protocol";
import { Hono } from "hono";
import { sql } from "kysely";
import { type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { nodeAccess, visibleNodeIds } from "../cluster/nodes.ts";
import { resolveTargets, type TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";
import type { TaskState } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** Page size of GET /tasks: 50 by default, never more than 100. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

const TASK_STATES: ReadonlySet<string> = new Set<TaskState>([
	"awaiting_approval",
	"awaiting_authorization",
	"denied",
	"dispatched",
	"running",
	"exited",
	"failed",
	"rejected",
	"unknown",
]);
/** The stored actor types of doc/access-control.md#操作者. */
const ACTOR_TYPES: ReadonlySet<string> = new Set(["user", "session", "subagent", "schedule", "api_token", "system"]);

class BadRequest extends Error {}

/** Expects requireUser to have run. Policy and approval come with the authorization rules (M2). */
export function taskRoutes(db: Db, cluster: Cluster, groups: TaskGroups) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof BadRequest || err instanceof UserError) return jsonError(c, 400, err.message);
		throw err;
	});

	app.post("/nodes/:id/tasks", async (c) => {
		const user = c.get("user");
		const nodeId = c.req.param("id");
		const access = await nodeAccess(db, user, nodeId);
		if (!access) return jsonError(c, 404, "no such node");
		if (access === "view") return jsonError(c, 403, "view access only");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");

		const { spec, input } = parseTask(body);
		const timeoutMs = optionalInt(body, "timeoutMs");
		let task: TaskView = await cluster.createTask({
			nodeId,
			spec,
			input,
			timeoutMs,
			privileged: optionalBool(body, "privileged") === true,
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		});
		const wait = Math.min(optionalInt(body, "waitMs") ?? 0, MAX_WAIT_MS);
		if (wait > 0) task = (await cluster.waitTask(task.id, wait, c.req.raw.signal)) ?? task;
		return c.json({ task }, 201);
	});

	// Batch execution: one task per target node; see doc/agent-runtime.md#批量执行.
	app.post("/task-groups", async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const targets = body.targets;
		if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) {
			throw new BadRequest("targets must be an array of node names and group:<name>");
		}
		const outputMode = parseOutputMode(body);
		const nodeIds = await resolveTargets(db, user, targets);
		const { spec, input } = parseTask(body);
		const id = await groups.create({
			targets,
			nodeIds,
			spec,
			input,
			outputMode,
			timeoutMs: optionalInt(body, "timeoutMs"),
			parallel: optionalInt(body, "parallel"),
			failFast: body.failFast === true,
			privileged: optionalBool(body, "privileged") === true,
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		});
		const wait = Math.min(optionalInt(body, "waitMs") ?? 0, MAX_WAIT_MS);
		return c.json({ group: await groups.wait(id, wait) }, 201);
	});

	app.get("/task-groups/:id", async (c) => {
		const group = await visibleGroup(c.get("user"), c.req.param("id"));
		return group ? c.json({ group }) : jsonError(c, 404, "no such task group");
	});

	app.get("/task-groups/:id/wait", async (c) => {
		const group = await visibleGroup(c.get("user"), c.req.param("id"));
		if (!group) return jsonError(c, 404, "no such task group");
		const timeout = Math.min(Number(c.req.query("timeoutMs") ?? 30_000) || 0, MAX_WAIT_MS);
		return c.json({ group: await groups.wait(group.id, timeout) });
	});

	/** A group is visible to its creator and to administrators. */
	const visibleGroup = async (user: AppEnv["Variables"]["user"], id: string) => {
		const group = await groups.get(id);
		if (!group) return undefined;
		const row = await db
			.selectFrom("task_groups")
			.select("on_behalf_of_user_id")
			.where("id", "=", id)
			.executeTakeFirst();
		return user.kind === "admin" || row?.on_behalf_of_user_id === user.userId ? group : undefined;
	};

	app.get("/nodes/:id/tasks", async (c) => {
		const nodeId = c.req.param("id");
		if (!(await nodeAccess(db, c.get("user"), nodeId))) return jsonError(c, 404, "no such node");
		const rows = await db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			.orderBy("created_at", "desc")
			.limit(50)
			.execute();
		const tasks = await Promise.all(rows.map((r) => cluster.getTask(r.id)));
		return c.json({ tasks: tasks.filter(Boolean) });
	});

	const visibleTask = async (userId: AppEnv["Variables"]["user"], id: string) => {
		const task = await cluster.getTask(id);
		if (!task) return undefined;
		const access = await nodeAccess(db, userId, task.nodeId);
		return access ? { task, access } : undefined;
	};

	/**
	 * Every task on a node the user can see, newest first. Tasks that wait for this user come first
	 * unless a state was given: `awaiting_approval` ones it handles and `awaiting_authorization` ones
	 * it owns (doc/privilege.md, the WebUI's task page). Offset pagination, 50 per page at most.
	 */
	app.get("/tasks", async (c) => {
		const user = c.get("user");
		const state = c.req.query("state");
		if (state !== undefined && !TASK_STATES.has(state)) return jsonError(c, 400, `unknown state ${state}`);
		const actorType = c.req.query("actorType");
		if (actorType !== undefined && !ACTOR_TYPES.has(actorType)) {
			return jsonError(c, 400, `unknown actorType ${actorType}`);
		}
		const filterNode = c.req.query("nodeId");
		const nodeIds = await visibleNodeIds(db, user);
		if (filterNode !== undefined && !nodeIds.includes(filterNode)) return jsonError(c, 404, "no such node");
		const limit = pageSize(c.req.query("limit"));
		const offset = pageOffset(c.req.query("offset"));
		if (nodeIds.length === 0) return c.json({ tasks: [], offset, limit, nextOffset: null });

		let query = db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "in", filterNode === undefined ? nodeIds : [filterNode]);
		if (state !== undefined) query = query.where("state", "=", state as TaskState);
		if (actorType !== undefined) query = query.where("actor_type", "=", actorType);
		if (state === undefined) {
			// A task waiting for this user first: an approval it handles, or a signature it owns and signs
			// on the task page. A group member task is signed through the group (`/approvals` lists the
			// group), so it keeps its place in the list instead of jumping ahead once per node.
			query = query.orderBy(
				sql<number>`case when state = 'awaiting_approval' and handler_type = 'user' and on_behalf_of_user_id = ${user.userId} then 0
					when state = 'awaiting_authorization' and on_behalf_of_user_id = ${user.userId} and task_group_id is null then 0 else 1 end`,
				"asc",
			);
		}
		const rows = await query
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1)
			.offset(offset)
			.execute();
		const page = rows.slice(0, limit);
		const tasks = (await Promise.all(page.map((r) => cluster.getTask(r.id)))).filter(Boolean) as TaskView[];
		return c.json({ tasks, offset, limit, nextOffset: rows.length > limit ? offset + limit : null });
	});

	app.get("/tasks/:id", async (c) => {
		const found = await visibleTask(c.get("user"), c.req.param("id"));
		return found ? c.json({ task: found.task }) : jsonError(c, 404, "no such task");
	});

	app.get("/tasks/:id/wait", async (c) => {
		const found = await visibleTask(c.get("user"), c.req.param("id"));
		if (!found) return jsonError(c, 404, "no such task");
		const timeout = Math.min(Number(c.req.query("timeoutMs") ?? 30_000) || 0, MAX_WAIT_MS);
		const task = await cluster.waitTask(found.task.id, timeout, c.req.raw.signal);
		return c.json({ task });
	});

	app.post("/tasks/:id/cancel", async (c) => {
		const found = await visibleTask(c.get("user"), c.req.param("id"));
		if (!found) return jsonError(c, 404, "no such task");
		if (found.access === "view") return jsonError(c, 403, "view access only");
		return c.json({ cancelled: await cluster.cancelTask(found.task.id) });
	});

	return app;
}

function parseTask(body: Record<string, unknown>): { spec: TaskSpec; input?: Uint8Array } {
	const kind = str(body, "kind");
	switch (kind) {
		case "exec": {
			const argv = body.argv;
			if (argv !== undefined && !(Array.isArray(argv) && argv.every((a) => typeof a === "string"))) {
				throw new BadRequest("argv must be an array of strings");
			}
			const env = body.env ?? {};
			if (typeof env !== "object" || env === null || Object.values(env).some((v) => typeof v !== "string")) {
				throw new BadRequest("env must map names to strings");
			}
			const stdin = optionalStr(body, "stdin");
			const shell = optionalStr(body, "shell") ?? "";
			// An empty argv falls back to the shell, as the protobuf command did before M3.5.
			const command = (argv as string[] | undefined)?.length ? { argv: argv as string[] } : { shell };
			return {
				spec: {
					kind: "exec",
					command,
					env: env as Record<string, string>,
					cwd: optionalStr(body, "cwd") ?? "",
					stdin: null,
				},
				input: stdin === undefined ? undefined : Buffer.from(stdin),
			};
		}
		case "file.read":
			return {
				spec: {
					kind: "file.read",
					path: str(body, "path"),
					offset: optionalInt(body, "offset") ?? 0,
					limit: optionalInt(body, "limit") ?? 0,
				},
			};
		case "file.write": {
			const content = optionalStr(body, "content");
			const base64 = optionalStr(body, "contentBase64");
			if ((content === undefined) === (base64 === undefined)) {
				throw new BadRequest("exactly one of content and contentBase64 is required");
			}
			const input = content !== undefined ? Buffer.from(content) : Buffer.from(base64 as string, "base64");
			if (input.length > MAX_INPUT_BYTES) throw new BadRequest("content too large");
			return {
				spec: {
					kind: "file.write",
					path: str(body, "path"),
					content: EMPTY_INPUT_REF,
					overwrite: body.overwrite === true,
					mode: optionalInt(body, "mode") ?? 0,
					owner: optionalStr(body, "owner") ?? "",
					group: optionalStr(body, "group") ?? "",
				},
				input,
			};
		}
		case "file.edit": {
			const edits = body.edits;
			if (
				!Array.isArray(edits) ||
				!edits.every((e) => typeof e?.oldText === "string" && typeof e?.newText === "string")
			) {
				throw new BadRequest("edits must be an array of { oldText, newText }");
			}
			return {
				spec: {
					kind: "file.edit",
					path: str(body, "path"),
					edits: edits as { oldText: string; newText: string }[],
				},
			};
		}
		case "file.stat":
			return { spec: { kind: "file.stat", path: str(body, "path") } };
		case "file.list":
			return { spec: { kind: "file.list", path: str(body, "path"), limit: optionalInt(body, "limit") ?? 0 } };
		default:
			throw new BadRequest("kind must be exec, file.read, file.write, file.edit, file.stat or file.list");
	}
}

function str(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value === "") throw new BadRequest(`${key} is required`);
	return value;
}

function optionalStr(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new BadRequest(`${key} must be a string`);
	return value;
}

function optionalInt(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new BadRequest(`${key} must be a non-negative integer`);
	}
	return value;
}

/** Stricter than the other flags: a privileged task is a security decision, not a UI convenience. */
function optionalBool(body: Record<string, unknown>, key: string): boolean | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new BadRequest(`${key} must be a boolean`);
	return value;
}

/** The page size of GET /tasks: 50 by default and never above the cap. */
function pageSize(value: string | undefined): number {
	const n = Number(value ?? DEFAULT_PAGE);
	if (!Number.isSafeInteger(n) || n < 1) throw new BadRequest("limit must be a positive integer");
	return Math.min(n, MAX_PAGE);
}

/** The offset of GET /tasks; pages are positions in the same newest-first order. */
function pageOffset(value: string | undefined): number {
	const n = Number(value ?? 0);
	if (!Number.isSafeInteger(n) || n < 0) throw new BadRequest("offset must be a non-negative integer");
	return n;
}

/** The batch output mode; omitted means the group's default (`status`), see doc/execution-plane.md#输出. */
function parseOutputMode(body: Record<string, unknown>): "status" | "text" | undefined {
	const value = body.outputMode;
	if (value === undefined) return undefined;
	if (value !== "status" && value !== "text") throw new BadRequest('outputMode must be "status" or "text"');
	return value;
}
