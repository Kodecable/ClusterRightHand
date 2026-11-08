import type { TaskSpec } from "@crh/protocol";
import { Hono } from "hono";
import { isAdmin } from "../auth/sessions.ts";
import { type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { nodeAccess } from "../cluster/nodes.ts";
import { resolveTargets, type TaskGroups } from "../cluster/task-groups.ts";
import { taskRelation } from "../cluster/task-visibility.ts";
import type { Db } from "../storage/db.ts";
import type { TaskState } from "../storage/schema.ts";
import {
	type CursorSpec,
	cursorRows,
	decodeCursor,
	descendingKeyset,
	encodeCursor,
	parseLimit,
} from "../util/cursor.ts";
import { UserError } from "../util/errors.ts";
import { jsonBodyLimit, MAX_INPUT_BASE64_LENGTH, MAX_INPUT_BODY_BYTES, MAX_INPUT_BYTES } from "./body-limit.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";

const MAX_WAIT_MS = 10 * 60 * 1000;
/** Lines a file.read reads when the request names none: pi's read default (doc/agent-runtime.md#默认值). */
const DEFAULT_READ_LINES = 2000;
/** GET /tasks orders by `created_at desc, id desc` (doc/webui.md#api-约定). */
const TASKS_CURSOR: CursorSpec = { columns: [{ name: "created_at", type: "string" }], idType: "string" };

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

/** Expects requireUser to have run. Policy and approval come with the authorization rules (M2). */
export function taskRoutes(db: Db, cluster: Cluster, taskGroups: TaskGroups) {
	const app = new Hono<AppEnv>();

	app.post("/nodes/:id/tasks", jsonBodyLimit(MAX_INPUT_BODY_BYTES), async (c) => {
		const user = c.get("user");
		const nodeId = c.req.param("id");
		const access = await nodeAccess(db, user, nodeId);
		if (!access) return jsonError(c, 404, "no such node");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");

		const { spec, input } = parseTask(body);
		const timeoutMs = optionalInt(body, "timeoutMs");
		let task: TaskView = await cluster.createTask({
			nodeId,
			spec,
			input,
			timeoutMs,
			maxLines: optionalInt(body, "maxLines"),
			maxBytes: optionalInt(body, "maxBytes"),
			privileged: optionalBool(body, "privileged") === true,
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		});
		const wait = Math.min(optionalInt(body, "waitMs") ?? 0, MAX_WAIT_MS);
		if (wait > 0) task = (await cluster.waitTask(task.id, wait, c.req.raw.signal)) ?? task;
		return c.json({ task }, 201);
	});

	// Batch execution: one task per target node; see doc/agent-runtime.md#批量执行.
	app.post("/task-groups", jsonBodyLimit(MAX_INPUT_BODY_BYTES), async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const targets = body.targets;
		if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) {
			throw new UserError("targets must be an array of node or node-group names, ids or _all");
		}
		const outputMode = parseOutputMode(body);
		const resolved = await resolveTargets(db, user, targets);
		const { spec, input } = parseTask(body);
		const id = await taskGroups.create({
			targets: resolved.targets,
			nodeIds: resolved.nodeIds,
			spec,
			input,
			outputMode,
			timeoutMs: optionalInt(body, "timeoutMs"),
			maxLines: optionalInt(body, "maxLines"),
			maxBytes: optionalInt(body, "maxBytes"),
			parallel: optionalInt(body, "parallel"),
			failFast: body.failFast === true,
			privileged: optionalBool(body, "privileged") === true,
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		});
		const wait = Math.min(optionalInt(body, "waitMs") ?? 0, MAX_WAIT_MS);
		return c.json({ taskGroup: await taskGroups.wait(id, wait) }, 201);
	});

	app.get("/task-groups/:id", async (c) => {
		const taskGroup = await visibleTaskGroup(c.get("user"), c.req.param("id"));
		return taskGroup ? c.json({ taskGroup }) : jsonError(c, 404, "no such task group");
	});

	app.get("/task-groups/:id/wait", async (c) => {
		const taskGroup = await visibleTaskGroup(c.get("user"), c.req.param("id"));
		if (!taskGroup) return jsonError(c, 404, "no such task group");
		const timeout = Math.min(Number(c.req.query("timeoutMs") ?? 30_000) || 0, MAX_WAIT_MS);
		return c.json({ taskGroup: await taskGroups.wait(taskGroup.id, timeout) });
	});

	/** A task group is visible by its relation to the user (admins, its owner, or a session viewer). */
	const visibleTaskGroup = async (user: AppEnv["Variables"]["user"], id: string) => {
		const taskGroup = await taskGroups.get(id);
		if (!taskGroup) return undefined;
		const relation = await taskRelation(db, user, {
			onBehalfOfUserId: taskGroup.onBehalfOfUserId,
			actorType: taskGroup.actorType,
			actorId: taskGroup.actorId,
		});
		return relation.visible ? taskGroup : undefined;
	};

	app.get("/nodes/:id/tasks", async (c) => {
		const nodeId = c.req.param("id");
		const user = c.get("user");
		if (!(await nodeAccess(db, user, nodeId))) return jsonError(c, 404, "no such node");
		// The node only narrows the list; visibility still depends on the task's relation to the user.
		let query = db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			.orderBy("created_at", "desc")
			.limit(50);
		if (!isAdmin(user)) query = query.where("on_behalf_of_user_id", "=", user.userId);
		const rows = await query.execute();
		const tasks = await Promise.all(rows.map((r) => cluster.getTask(r.id)));
		return c.json({ tasks: tasks.filter(Boolean) });
	});

	const visibleTask = async (user: AppEnv["Variables"]["user"], id: string) => {
		const task = await cluster.getTask(id);
		if (!task) return undefined;
		const relation = await taskRelation(db, user, {
			onBehalfOfUserId: task.onBehalfOfUserId,
			actorType: task.actorType,
			actorId: task.actorId,
		});
		return relation.visible ? { task, relation } : undefined;
	};

	/**
	 * The tasks the user may list (administrators: all; everyone else: their own), newest first, one keyset
	 * page at a time. Visibility is the task's relation to the user, never node access (D108); session viewers
	 * reach a shared session's task by id instead. The filters are the task page's; there is no "waiting for
	 * me first" ordering any more (doc/webui.md#api-约定): waiting approvals live on the approvals page.
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
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, TASKS_CURSOR);

		let query = db.selectFrom("tasks").select(["id", "created_at"]);
		// (a)/(b) of doc/access-control.md: administrators list everything, everyone else their own tasks.
		// Session viewers reach a shared session's task by id, not through this list.
		if (!isAdmin(user)) query = query.where("on_behalf_of_user_id", "=", user.userId);
		if (filterNode !== undefined) query = query.where("node_id", "=", filterNode);
		if (state !== undefined) query = query.where("state", "=", state as TaskState);
		if (actorType !== undefined) query = query.where("actor_type", "=", actorType);
		if (cursor) query = query.where(descendingKeyset(["created_at"], cursor));
		const page = await cursorRows(
			limit,
			(limitPlusOne) => query.orderBy("created_at", "desc").orderBy("id", "desc").limit(limitPlusOne).execute(),
			(row) => encodeCursor([row.created_at], row.id),
		);
		const tasks = (await Promise.all(page.rows.map((r) => cluster.getTask(r.id)))).filter(Boolean) as TaskView[];
		return c.json({ items: tasks, nextCursor: page.nextCursor });
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
		if (!found.relation.acts) return jsonError(c, 403, "only the task's owner or an administrator can do this");
		return c.json({
			cancelled: await cluster.cancelTask(found.task.id, undefined, {
				type: "user",
				id: c.get("user").userId,
				onBehalfOfUserId: c.get("user").userId,
			}),
		});
	});

	return app;
}

function parseTask(body: Record<string, unknown>): { spec: TaskSpec; input?: Uint8Array } {
	const kind = str(body, "kind");
	switch (kind) {
		case "exec": {
			const argv = body.argv;
			if (argv !== undefined && !(Array.isArray(argv) && argv.every((a) => typeof a === "string"))) {
				throw new UserError("argv must be an array of strings");
			}
			const env = body.env ?? {};
			if (typeof env !== "object" || env === null || Object.values(env).some((v) => typeof v !== "string")) {
				throw new UserError("env must map names to strings");
			}
			const stdin = optionalString(body, "stdin");
			if (stdin !== undefined && Buffer.byteLength(stdin, "utf8") > MAX_INPUT_BYTES) {
				throw new UserError("stdin too large");
			}
			const shell = optionalString(body, "shell") ?? "";
			// An empty argv falls back to the shell, as the protobuf command did before M3.5.
			const command = (argv as string[] | undefined)?.length ? { argv: argv as string[] } : { shell };
			return {
				spec: {
					kind: "exec",
					command,
					env: env as Record<string, string>,
					cwd: optionalString(body, "cwd") ?? "",
					stdin: null,
				},
				input: stdin === undefined ? undefined : Buffer.from(stdin),
			};
		}
		case "file.read": {
			const startLine = optionalInt(body, "startLine") ?? 1;
			const lineCount = optionalInt(body, "lineCount") ?? DEFAULT_READ_LINES;
			if (startLine < 1 || lineCount < 1) throw new UserError("startLine and lineCount must be at least 1");
			return { spec: { kind: "file.read", path: str(body, "path"), startLine, lineCount } };
		}
		case "file.write": {
			const content = optionalString(body, "content");
			const base64 = optionalString(body, "contentBase64");
			if ((content === undefined) === (base64 === undefined)) {
				throw new UserError("exactly one of content and contentBase64 is required");
			}
			// Checked before decoding, so an oversized string never becomes a buffer.
			if (base64 !== undefined && base64.length > MAX_INPUT_BASE64_LENGTH) {
				throw new UserError("contentBase64 too large");
			}
			const input = content !== undefined ? Buffer.from(content) : Buffer.from(base64 as string, "base64");
			if (input.length > MAX_INPUT_BYTES) throw new UserError("content too large");
			return {
				spec: {
					kind: "file.write",
					path: str(body, "path"),
					content: EMPTY_INPUT_REF,
					overwrite: body.overwrite === true,
					mode: optionalInt(body, "mode") ?? 0,
					owner: optionalString(body, "owner") ?? "",
					group: optionalString(body, "group") ?? "",
					createParentDirs: optionalBool(body, "createParentDirs") === true,
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
				throw new UserError("edits must be an array of { oldText, newText }");
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
			throw new UserError("kind must be exec, file.read, file.write, file.edit, file.stat or file.list");
	}
}

function str(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value === "") throw new UserError(`${key} is required`);
	return value;
}

function optionalInt(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new UserError(`${key} must be a non-negative integer`);
	}
	return value;
}

/** Stricter than the other flags: a privileged task is a security decision, not a UI convenience. */
function optionalBool(body: Record<string, unknown>, key: string): boolean | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new UserError(`${key} must be a boolean`);
	return value;
}

/**
 * The batch output mode; omitted means the group's default for its kind (`status` for exec, `head`
 * for file operations), see doc/execution-plane.md#输出.
 */
function parseOutputMode(body: Record<string, unknown>): "status" | "text" | "head" | undefined {
	const value = body.outputMode;
	if (value === undefined) return undefined;
	if (value !== "status" && value !== "text" && value !== "head") {
		throw new UserError('outputMode must be "status", "text" or "head"');
	}
	return value;
}
