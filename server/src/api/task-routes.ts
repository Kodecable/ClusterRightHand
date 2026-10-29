import type { TaskSpec } from "@crh/protocol";
import { Hono } from "hono";
import { type Cluster, EMPTY_INPUT_REF, type TaskView } from "../cluster/cluster.ts";
import { nodeAccess } from "../cluster/nodes.ts";
import { resolveTargets, type TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

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
		if (body.privileged === true) return jsonError(c, 400, "privileged tasks are not supported yet");

		const { spec, input } = parseTask(body);
		const timeoutMs = optionalInt(body, "timeoutMs");
		let task: TaskView = await cluster.createTask({
			nodeId,
			spec,
			input,
			timeoutMs,
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
		if (body.privileged === true) return jsonError(c, 400, "privileged tasks are not supported yet");
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

/** The batch output mode; omitted means the group's default (`status`), see doc/execution-plane.md#输出. */
function parseOutputMode(body: Record<string, unknown>): "status" | "text" | undefined {
	const value = body.outputMode;
	if (value === undefined) return undefined;
	if (value !== "status" && value !== "text") throw new BadRequest('outputMode must be "status" or "text"');
	return value;
}
