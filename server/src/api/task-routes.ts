import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { TaskSpecSchema } from "@crh/protocol";
import { Hono } from "hono";
import type { Cluster, TaskView } from "../cluster/cluster.ts";
import { nodeAccess } from "../cluster/nodes.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

const MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

class BadRequest extends Error {}

/** Expects requireUser to have run. Policy and approval come with the authorization rules (M2). */
export function taskRoutes(db: Db, cluster: Cluster) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof BadRequest) return jsonError(c, 400, err.message);
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
			spec: create(TaskSpecSchema, spec),
			input,
			timeoutMs,
			actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		});
		const wait = Math.min(optionalInt(body, "waitMs") ?? 0, MAX_WAIT_MS);
		if (wait > 0) task = (await cluster.waitTask(task.id, wait, c.req.raw.signal)) ?? task;
		return c.json({ task }, 201);
	});

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

type SpecInit = MessageInitShape<typeof TaskSpecSchema>;

function parseTask(body: Record<string, unknown>): { spec: SpecInit; input?: Uint8Array } {
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
			return {
				spec: {
					kind: {
						case: "exec",
						value: {
							argv: (argv as string[] | undefined) ?? [],
							shell: optionalStr(body, "shell") ?? "",
							env: env as Record<string, string>,
							cwd: optionalStr(body, "cwd") ?? "",
						},
					},
				},
				input: stdin === undefined ? undefined : Buffer.from(stdin),
			};
		}
		case "file.read":
			return {
				spec: {
					kind: {
						case: "fileRead",
						value: {
							path: str(body, "path"),
							offset: BigInt(optionalInt(body, "offset") ?? 0),
							limit: BigInt(optionalInt(body, "limit") ?? 0),
						},
					},
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
					kind: {
						case: "fileWrite",
						value: {
							path: str(body, "path"),
							overwrite: body.overwrite === true,
							mode: optionalInt(body, "mode") ?? 0,
							owner: optionalStr(body, "owner") ?? "",
							group: optionalStr(body, "group") ?? "",
						},
					},
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
					kind: {
						case: "fileEdit",
						value: { path: str(body, "path"), edits: edits as { oldText: string; newText: string }[] },
					},
				},
			};
		}
		case "file.stat":
			return { spec: { kind: { case: "fileStat", value: { path: str(body, "path") } } } };
		case "file.list":
			return {
				spec: {
					kind: { case: "fileList", value: { path: str(body, "path"), limit: optionalInt(body, "limit") ?? 0 } },
				},
			};
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
