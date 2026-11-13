import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskListQuery } from "@crh/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import type { CreateTaskInput } from "../src/cluster/types.ts";
import type { TransferLocationJson } from "../src/library/transfer-location.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { TOOLS } from "../src/tools/catalog.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function view(overrides: Partial<TaskView>): TaskView {
	return {
		id: randomUUID(),
		nodeId: "n1",
		kind: "file.list",
		summary: "list",
		operation: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "exited",
		exitCode: null,
		signal: null,
		timedOut: false,
		cancelled: false,
		timeoutMs: null,
		errorCode: null,
		errorMessage: null,
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		maxLines: null,
		maxBytes: null,
		outputFile: null,
		outputMode: "status",
		privileged: false,
		authorization: null,
		result: null,
		createdAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		taskGroupId: null,
		ruleChain: null,
		approval: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		...overrides,
	} as TaskView;
}

/** A cluster for the browse routes: records each created task and answers with a finished one. */
function fakeCluster(root: string) {
	const created: CreateTaskInput[] = [];
	const tasks = new Map<string, TaskView>();
	let pulled: Buffer = Buffer.from("png");
	const createTask = async (input: CreateTaskInput) => {
		created.push(input);
		const id = newId();
		let result: TaskView["result"] = null;
		if (input.spec.kind === "file.list") {
			result = {
				kind: "file.list",
				entries: [{ name: "passwd", type: "file", size: 10, mode: "0644", mtime: "2026-01-01T00:00:00Z" }],
				truncated: false,
			};
		} else if (input.spec.kind === "file.stat") {
			result = {
				kind: "file.stat",
				path: input.spec.path,
				type: "file",
				size: 10,
				mode: "0644",
				uid: 0,
				gid: 0,
				owner: "root",
				group: "root",
				mtime: "2026-01-01T00:00:00Z",
				linkTarget: null,
			};
		}
		const task = view({ id, nodeId: input.nodeId, kind: input.spec.kind, result, purpose: input.purpose ?? null });
		tasks.set(id, task);
		return task;
	};
	const pullFile = async (input: {
		location: TransferLocationJson;
		path: string;
		nodeId: string;
		purpose?: string;
	}) => {
		created.push({
			...input,
			spec: { kind: "file.pull", path: input.path, maxBytes: 0, endpoint: { kind: "crhs", transferId: "x" } },
			actor: { type: "user", id: "u1", onBehalfOfUserId: "u1" },
		} as never);
		if (input.location.kind !== "staging") throw new Error("not staging");
		await writeFile(join(root, input.location.path), pulled);
		const task = view({
			id: newId(),
			kind: "file.pull",
			purpose: input.purpose ?? null,
			result: { kind: "file.pull", size: pulled.length, sha256: sha256Hex(pulled) },
		});
		tasks.set(task.id, task);
		return task;
	};
	const cluster = {
		waitsEnded: false,
		isConnected: () => true,
		libraryBackend: undefined,
		createTask,
		async getTask(id: string) {
			return tasks.get(id);
		},
		async waitTask(id: string) {
			return tasks.get(id);
		},
		async cancelTask() {
			return true;
		},
		stagingLocation() {
			return { kind: "staging" as const, path: randomUUID(), size: null, sha256: null };
		},
		pullFile,
		transferContext: () => ({ root }),
	} as unknown as Cluster;
	return {
		cluster,
		created,
		tasks,
		setPulled(data: Buffer) {
			pulled = data;
		},
	};
}

async function addNode(db: Db, userId: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name: "web-1",
			name_key: "web-1",
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "web-1",
			facts: null,
			client_version: null,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: null,
			ssh_port: null,
			ssh_user: null,
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	await db
		.insertInto("node_access_grants")
		.values({
			id: newId(),
			org_id: await defaultOrgId(db),
			grantee_type: "user",
			grantee_id: userId,
			target_type: "node",
			target_id: id,
			created_by_user_id: userId,
			created_at: now,
		})
		.execute();
	return id;
}

function png(width: number, height: number): Buffer {
	const header = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const size = Buffer.alloc(8);
	size.writeUInt32BE(width, 0);
	size.writeUInt32BE(height, 4);
	return Buffer.concat([header, size, Buffer.alloc(16, 2)]);
}

describe("node file browsing", () => {
	let db: Db;
	let root: string;
	let app: ReturnType<typeof makeApp>;
	let cookie: string;
	let userId: string;
	let nodeId: string;
	let fake: ReturnType<typeof fakeCluster>;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-node-files-"));
		fake = fakeCluster(root);
		app = makeApp(db, undefined, { cluster: fake.cluster });
		const user = await createUser(db, { username: "alice", kind: "member", password: "alice-password" });
		userId = user.id;
		cookie = await login(app, "alice", "alice-password");
		nodeId = await addNode(db, user.id);
	});

	afterEach(async () => {
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	it("creates browse tasks as the signed-in user, unprivileged, and returns the listing", async () => {
		const res = await call(app, `/api/nodes/${nodeId}/files?path=/etc`, { cookie });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; entries: { path: string; name: string; type: string }[] };
		expect(body.path).toBe("/etc");
		expect(body.entries).toEqual([expect.objectContaining({ path: "/etc/passwd", name: "passwd", type: "file" })]);
		expect(fake.created[0]?.privileged ?? false).toBe(false);
		expect(fake.created[0]).toMatchObject({
			nodeId,
			purpose: "browse",
			actor: { type: "user", id: userId, onBehalfOfUserId: userId },
			spec: { kind: "file.list", path: "/etc" },
		});

		const stat = await call(app, `/api/nodes/${nodeId}/stat?path=/etc/passwd`, { cookie });
		expect(stat.status).toBe(200);
		expect(await stat.json()).toEqual({
			file: expect.objectContaining({ path: "/etc/passwd", type: "file", size: 10, owner: "root" }),
		});
		expect(fake.created[1]).toMatchObject({ purpose: "browse", spec: { kind: "file.stat", path: "/etc/passwd" } });
	});

	it("pulls a node image into staging and streams it with safe headers", async () => {
		fake.setPulled(png(40, 30));
		const res = await call(app, `/api/nodes/${nodeId}/file?path=/srv/pic.png&preview=1`, { cookie });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toBe("sandbox");
		expect(res.headers.get("content-disposition")).toContain("inline");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(png(40, 30));
		expect(fake.created[0]?.privileged ?? false).toBe(false);
		expect(fake.created[0]).toMatchObject({ purpose: "browse", spec: { kind: "file.pull", path: "/srv/pic.png" } });
		// The staging file is gone once the response body is consumed.
		const staging = join(root, (fake.created[0] as unknown as { location: { path: string } }).location.path);
		await expect(readFile(staging)).rejects.toThrow();
	});

	it("refuses a preview that is not one of the four image types", async () => {
		fake.setPulled(Buffer.from("plain text"));
		const res = await call(app, `/api/nodes/${nodeId}/file?path=/srv/a.txt&preview=1`, { cookie });
		expect(res.status).toBe(400);
	});

	it("sets no purpose through the task API and lists purpose tasks only on request", async () => {
		const truthy = view({ id: newId(), nodeId, summary: "true", kind: "exec", purpose: "browse" });
		const ordinary = view({ id: newId(), nodeId, summary: "true", kind: "exec", purpose: null });
		fake.tasks.set(truthy.id, truthy);
		fake.tasks.set(ordinary.id, ordinary);
		for (const task of [truthy, ordinary]) {
			await db
				.insertInto("tasks")
				.values({
					id: task.id,
					org_id: await defaultOrgId(db),
					node_id: nodeId,
					task_group_id: null,
					kind: "exec",
					spec: JSON.stringify({ kind: "exec", command: { shell: "true" }, env: {}, cwd: "", stdin: null }),
					input_size: null,
					input_sha256: null,
					attempt: 1,
					privileged: 0,
					timeout_ms: null,
					output_mode: "full",
					max_lines: null,
					max_bytes: null,
					state: "exited",
					exit_code: 0,
					signal: null,
					timed_out: 0,
					cancelled: 0,
					error_code: null,
					error_message: null,
					actor_type: "user",
					actor_id: userId,
					on_behalf_of_user_id: userId,
					created_at: task.createdAt,
					dispatched_at: null,
					accepted_at: null,
					finished_at: task.finishedAt,
					output_bytes: 0,
					output_head: null,
					output_tail: null,
					notice: null,
					output_lines: null,
					output_file: null,
					result: null,
					late_result: null,
					transfer: null,
					purpose: task.purpose,
				})
				.execute();
		}
		const list = await call(app, "/api/tasks", { cookie });
		const body = (await list.json()) as { items: TaskView[] };
		expect(body.items.map((task) => task.id)).toEqual([ordinary.id]);
		const all = await call(app, "/api/tasks?includePurpose=true", { cookie });
		const allBody = (await all.json()) as { items: TaskView[] };
		expect(allBody.items.map((task) => task.id).sort()).toEqual([ordinary.id, truthy.id].sort());
		expect((await call(app, "/api/tasks", { cookie })).status).toBe(200);

		// The task API's request body has no purpose field: it is not part of the created task.
		const res = await call(app, `/api/nodes/${nodeId}/tasks`, {
			cookie,
			body: { kind: "exec", shell: "true", purpose: "browse" },
		});
		expect(res.status).toBe(201);
		const last = fake.created.at(-1) as CreateTaskInput;
		expect(last.purpose).toBeUndefined();

		// The agent tools do not declare a purpose either; the field is simply not part of any schema.
		for (const entry of TOOLS) {
			const schema = entry.input as unknown as { shape?: Record<string, unknown> };
			expect(Object.keys(schema.shape ?? {}), entry.name).not.toContain("purpose");
		}
		const query: TaskListQuery = { includePurpose: true };
		expect(query.includePurpose).toBe(true);
	});
});
