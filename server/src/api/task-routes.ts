import {
	ErrorResponseSchema,
	IdParamSchema,
	TaskCancelledResponseSchema,
	TaskGroupResponseSchema,
	TaskIdParamSchema,
	TaskListQuerySchema,
	TaskListResponseSchema,
	TaskPageResponseSchema,
	TaskRequestSchema,
	TaskResponseSchema,
	TaskWaitQuerySchema,
} from "@crh/api/schemas";
import type { TaskSpec } from "@crh/protocol";
import { HTTPException } from "hono/http-exception";
import { approvalRequestForTask, approvalRequestForTaskGroup } from "../approvals/request.ts";
import { isAdmin } from "../auth/sessions.ts";
import { type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { nodeAccess } from "../cluster/nodes.ts";
import { resolveTargets, type TaskGroups } from "../cluster/task-groups.ts";
import { taskRelation } from "../cluster/task-visibility.ts";
import type { Db } from "../storage/db.ts";
import type { TaskState } from "../storage/schema.ts";
import { jsonBodyLimit, MAX_INPUT_BASE64_LENGTH, MAX_INPUT_BODY_BYTES, MAX_INPUT_BYTES } from "../util/body-limit.ts";
import {
	type CursorSpec,
	cursorRows,
	decodeCursor,
	descendingKeyset,
	encodeCursor,
	parseLimit,
} from "../util/cursor.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import type { AppEnv } from "./context.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Tasks"];

const MAX_WAIT_MS = 10 * 60 * 1000;
/** Lines a file.read reads when the request names none: pi's read default (doc/design/agent-runtime.md "Defaults"). */
const DEFAULT_READ_LINES = 2000;
/** GET /tasks orders by `created_at desc, id desc` (doc/design/webui.md "API conventions"). */
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
/** The stored actor types of doc/design/access-control.md "Actors" */
const ACTOR_TYPES: ReadonlySet<string> = new Set(["user", "session", "subagent", "schedule", "api_token", "system"]);

const createTaskRoute = defineRoute({
	method: "post",
	path: "/nodes/{id}/tasks",
	tags: TAGS,
	summary: "Run one task on a node; the body carries its kind and the kind's fields, and `waitMs` may wait",
	agent: "deny", // a task as the user with no rule chain bypasses the session's exec rules; the model has task tools
	middleware: [jsonBodyLimit(MAX_INPUT_BODY_BYTES)],
	request: { params: IdParamSchema, body: { required: true, ...json(TaskRequestSchema) } },
	responses: {
		201: { description: "The task as it stands after `waitMs`", ...json(TaskResponseSchema) },
		413: { description: "The input exceeds the task input limit", ...json(ErrorResponseSchema) },
	},
});

const createGroupRoute = defineRoute({
	method: "post",
	path: "/task-groups",
	tags: TAGS,
	summary: "Run one task on each target node or node group, as one batch",
	agent: "deny", // a task group as the user with no rule chain bypasses the session's exec rules; the model has task tools
	middleware: [jsonBodyLimit(MAX_INPUT_BODY_BYTES)],
	request: { body: { required: true, ...json(TaskRequestSchema) } },
	responses: {
		201: { description: "The task group, after `waitMs`", ...json(TaskGroupResponseSchema) },
		413: { description: "The input exceeds the task input limit", ...json(ErrorResponseSchema) },
	},
});

const getGroupRoute = defineRoute({
	method: "get",
	path: "/task-groups/{id}",
	tags: TAGS,
	summary: "One task group and its tasks",
	agent: "allow",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The task group", ...json(TaskGroupResponseSchema) } },
});

const waitGroupRoute = defineRoute({
	method: "get",
	path: "/task-groups/{id}/wait",
	tags: TAGS,
	summary: "Wait up to `timeoutMs` for a task group to change, then return its view",
	agent: "allow",
	request: { params: IdParamSchema, query: TaskWaitQuerySchema },
	responses: { 200: { description: "The task group as it stands", ...json(TaskGroupResponseSchema) } },
});

const nodeTasksRoute = defineRoute({
	method: "get",
	path: "/nodes/{id}/tasks",
	tags: TAGS,
	summary: "The node's newest ten ordinary tasks that the caller may see",
	agent: "allow",
	request: { params: IdParamSchema },
	responses: { 200: { description: "The tasks, newest first", ...json(TaskListResponseSchema) } },
});

const listTasksRoute = defineRoute({
	method: "get",
	path: "/tasks",
	tags: TAGS,
	summary: "Page through the tasks the caller may list, newest first",
	agent: "allow",
	request: { query: TaskListQuerySchema },
	responses: { 200: { description: "One page of tasks", ...json(TaskPageResponseSchema) } },
});

const getTaskRoute = defineRoute({
	method: "get",
	path: "/tasks/{id}",
	tags: TAGS,
	summary: "One task",
	agent: "allow",
	request: { params: TaskIdParamSchema },
	responses: { 200: { description: "The task", ...json(TaskResponseSchema) } },
});

const waitTaskRoute = defineRoute({
	method: "get",
	path: "/tasks/{id}/wait",
	tags: TAGS,
	summary: "Wait up to `timeoutMs` for a task to change, then return its view",
	agent: "allow",
	request: { params: TaskIdParamSchema, query: TaskWaitQuerySchema },
	responses: { 200: { description: "The task as it stands", ...json(TaskResponseSchema) } },
});

const cancelTaskRoute = defineRoute({
	method: "post",
	path: "/tasks/{id}/cancel",
	tags: TAGS,
	summary: "Cancel a task; only its owner or an administrator may",
	agent: "ask",
	request: { params: TaskIdParamSchema },
	responses: {
		200: { description: "Whether a running task was cancelled", ...json(TaskCancelledResponseSchema) },
		403: { description: "The caller neither owns the task nor is an administrator", ...json(ErrorResponseSchema) },
	},
});

/** Expects requireUser to have run. Policy and approval come with the authorization rules (M2). */
export function taskRoutes(db: Db, cluster: Cluster, taskGroups: TaskGroups) {
	const app = apiRouter();

	app.openapi(createTaskRoute, async (c) => {
		const user = c.get("user");
		const { id: nodeId } = c.req.valid("param");
		const access = await nodeAccess(db, user, nodeId);
		if (!access) throw new NotFoundError("no such node");
		const body = c.req.valid("json");

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

	// Batch execution: one task per target node; see doc/design/agent-runtime.md "Batch execution".
	app.openapi(createGroupRoute, async (c) => {
		const user = c.get("user");
		const body = c.req.valid("json");
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
		// The group exists; a wait that returns nothing (the row vanished under it) still answers its view.
		const taskGroup = (await taskGroups.wait(id, wait)) ?? (await taskGroups.get(id));
		if (!taskGroup) throw new NotFoundError("no such task group");
		return c.json({ taskGroup }, 201);
	});

	app.openapi(getGroupRoute, async (c) => {
		const { id } = c.req.valid("param");
		const taskGroup = await visibleTaskGroup(c.get("user"), id);
		if (!taskGroup) throw new NotFoundError("no such task group");
		const request =
			taskGroup.state === "awaiting_approval" || taskGroup.state === "awaiting_authorization"
				? await approvalRequestForTaskGroup(db, taskGroup)
				: null;
		return c.json({ taskGroup, request }, 200);
	});

	app.openapi(waitGroupRoute, async (c) => {
		const { id } = c.req.valid("param");
		const { timeoutMs } = c.req.valid("query");
		const taskGroup = await visibleTaskGroup(c.get("user"), id);
		if (!taskGroup) throw new NotFoundError("no such task group");
		const timeout = Math.min(Number(timeoutMs ?? 30_000) || 0, MAX_WAIT_MS);
		// A row removed while waiting still answers the view it was looked up with.
		return c.json({ taskGroup: (await taskGroups.wait(taskGroup.id, timeout)) ?? taskGroup }, 200);
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

	app.openapi(nodeTasksRoute, async (c) => {
		const { id: nodeId } = c.req.valid("param");
		const user = c.get("user");
		if (!(await nodeAccess(db, user, nodeId))) throw new NotFoundError("no such node");
		// The node's recent-tasks section shows the newest 10 (doc/design/webui.md "Task and task group pages"); "View
		// all tasks" continues on the tasks page with `?node=`. The node only narrows the list;
		// visibility still depends on the task's relation to the user.
		let query = db
			.selectFrom("tasks")
			.select("id")
			.where("node_id", "=", nodeId)
			// A feature's own tasks, such as node file browsing, stay out of the ordinary lists.
			.where("purpose", "is", null)
			.orderBy("created_at", "desc")
			.limit(10);
		if (!isAdmin(user)) query = query.where("on_behalf_of_user_id", "=", user.userId);
		const rows = await query.execute();
		const tasks = await Promise.all(rows.map((r) => cluster.getTask(r.id)));
		return c.json({ tasks: tasks.filter((task): task is TaskView => task !== undefined) }, 200);
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
	 * page at a time. Visibility is the task's relation to the user, never node access; session viewers
	 * reach a shared session's task by id instead. The filters are the task page's; there is no "waiting for
	 * me first" ordering any more (doc/design/webui.md "API conventions"): waiting approvals live on the approvals page.
	 */
	app.openapi(listTasksRoute, async (c) => {
		const user = c.get("user");
		const query = c.req.valid("query");
		const state = query.state;
		if (state !== undefined && !TASK_STATES.has(state)) throw new UserError(`unknown state ${state}`);
		const actorType = query.actorType;
		if (actorType !== undefined && !ACTOR_TYPES.has(actorType)) {
			throw new UserError(`unknown actorType ${actorType}`);
		}
		const filterNode = query.nodeId;
		const filterUser = query.userId;
		// Tasks a dedicated feature created (node file browsing) are left out unless asked for.
		const includePurpose = query.includePurpose === "true" || query.includePurpose === "1";
		const limit = parseLimit(query.limit);
		const rawCursor = query.cursor;
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, TASKS_CURSOR);

		let select = db.selectFrom("tasks").select(["id", "created_at"]);
		// (a)/(b) of doc/design/access-control.md: administrators list everything, everyone else their own tasks.
		// Session viewers reach a shared session's task by id, not through this list.
		if (!isAdmin(user)) select = select.where("on_behalf_of_user_id", "=", user.userId);
		if (filterNode !== undefined) select = select.where("node_id", "=", filterNode);
		// The "By" column shows `on_behalf_of_user_id`, so that is what a user's own task filter matches (a
		// session or token task still acts for its owner). Applied after the visibility rule above.
		if (filterUser !== undefined && filterUser !== "") select = select.where("on_behalf_of_user_id", "=", filterUser);
		if (!includePurpose) select = select.where("purpose", "is", null);
		if (state !== undefined) select = select.where("state", "=", state as TaskState);
		if (actorType !== undefined) select = select.where("actor_type", "=", actorType);
		if (cursor) select = select.where(descendingKeyset(["created_at"], cursor));
		const page = await cursorRows(
			limit,
			(limitPlusOne) => select.orderBy("created_at", "desc").orderBy("id", "desc").limit(limitPlusOne).execute(),
			(row) => encodeCursor([row.created_at], row.id),
		);
		const tasks = (await Promise.all(page.rows.map((r) => cluster.getTask(r.id)))).filter(
			(task): task is TaskView => task !== undefined,
		);
		return c.json({ items: tasks, nextCursor: page.nextCursor }, 200);
	});

	app.openapi(getTaskRoute, async (c) => {
		const { id } = c.req.valid("param");
		const found = await visibleTask(c.get("user"), id);
		if (!found) throw new NotFoundError("no such task");
		const request =
			found.task.state === "awaiting_approval" || found.task.state === "awaiting_authorization"
				? await approvalRequestForTask(db, found.task)
				: null;
		return c.json({ task: found.task, request }, 200);
	});

	app.openapi(waitTaskRoute, async (c) => {
		const { id } = c.req.valid("param");
		const { timeoutMs } = c.req.valid("query");
		const found = await visibleTask(c.get("user"), id);
		if (!found) throw new NotFoundError("no such task");
		const timeout = Math.min(Number(timeoutMs ?? 30_000) || 0, MAX_WAIT_MS);
		// A task removed while waiting still answers the view it was looked up with.
		const task = (await cluster.waitTask(found.task.id, timeout, c.req.raw.signal)) ?? found.task;
		return c.json({ task }, 200);
	});

	app.openapi(cancelTaskRoute, async (c) => {
		const { id } = c.req.valid("param");
		const found = await visibleTask(c.get("user"), id);
		if (!found) throw new NotFoundError("no such task");
		if (!found.relation.acts) {
			throw new HTTPException(403, { message: "only the task's owner or an administrator can do this" });
		}
		return c.json(
			{
				cancelled: await cluster.cancelTask(found.task.id, undefined, {
					type: "user",
					id: c.get("user").userId,
					onBehalfOfUserId: c.get("user").userId,
				}),
			},
			200,
		);
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
			// An empty argv falls back to the shell.
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

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new UserError(`${key} must be a string`);
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
 * for file operations), see doc/design/execution.md "Output".
 */
function parseOutputMode(body: Record<string, unknown>): "status" | "text" | "head" | undefined {
	const value = body.outputMode;
	if (value === undefined) return undefined;
	if (value !== "status" && value !== "text" && value !== "head") {
		throw new UserError('outputMode must be "status", "text" or "head"');
	}
	return value;
}
