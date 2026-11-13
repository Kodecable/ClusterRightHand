import type { JsonTaskResult, TaskSpec } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import type * as z from "zod/v4";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { TaskAuthorizationRecord } from "../src/cluster/authorization.ts";
import { type Cluster, countOutputLines, type TaskView } from "../src/cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { callTool } from "../src/tools/adapter.ts";
import { TOOLS, type ToolContext } from "../src/tools/catalog.ts";
import type { ToolResult } from "../src/tools/render.ts";
import { execResult, execTaskResult, readGroupResult, readTaskResult, taskDetails } from "../src/tools/task-render.ts";
import { createUser } from "../src/users/service.ts";
import { NotFoundError, UserError } from "../src/util/errors.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

type AnyTool = {
	name: string;
	input: z.ZodType;
	output: "text" | "json";
	handler: (args: never, ctx: ToolContext) => Promise<ToolResult>;
};

const tool = (name: string): AnyTool => {
	const found = TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`${name} tool missing`);
	return found as unknown as AnyTool;
};

const ctx = {
	approvalUrl: (kind: string, id: string) => `http://crh.test/approvals/${kind}/${id}`,
	taskUrl: (id: string) => `http://crh.test/tasks/${id}`,
	taskGroupUrl: (id: string) => `http://crh.test/task-groups/${id}`,
} as unknown as ToolContext;

function task(overrides: Partial<TaskView>): TaskView {
	return {
		id: "t1",
		nodeId: "n1",
		kind: "exec",
		summary: "true",
		operation: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "exited",
		exitCode: 0,
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
		notice: null,
		outputLines: null,
		maxLines: null,
		maxBytes: null,
		outputFile: null,
		outputMode: "full",
		privileged: false,
		authorization: null,
		result: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		taskGroupId: null,
		ruleChain: null,
		approval: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		...overrides,
	};
}

function group(overrides: Partial<TaskGroupView>): TaskGroupView {
	return {
		id: "g1",
		state: "finished",
		targets: ["n1"],
		refs: {},
		nodeIds: ["n1"],
		parallel: 1,
		failFast: false,
		outputMode: "status",
		nodeMaxLines: null,
		nodeMaxBytes: null,
		privileged: false,
		skipped: [],
		tasks: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:00.000Z",
		summary: "true",
		kind: "exec",
		ruleChain: null,
		approval: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		operation: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		purpose: null,
		...overrides,
	};
}

function jsonOf(result: ToolResult): Record<string, unknown> {
	return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

function texts(result: ToolResult): string[] {
	return result.content.map((block) => block.text);
}

function execResultText(g: TaskGroupView, names: Map<string, string>): ToolResult {
	return execResult(ctx, { kind: "task_group", taskGroup: g, names });
}

function execResultStatus(g: TaskGroupView, names: Map<string, string>): ToolResult {
	return execResult(ctx, { kind: "task_group", taskGroup: { ...g, outputMode: "status" }, names });
}

/** A direct node grant for the tool tests: nodes belong to the organization. */
async function grantNode(db: Db, userId: string, nodeId: string): Promise<void> {
	await db
		.insertInto("node_access_grants")
		.values({
			id: newId(),
			org_id: await defaultOrgId(db),
			grantee_type: "user",
			grantee_id: userId,
			target_type: "node",
			target_id: nodeId,
			created_by_user_id: userId,
			created_at: new Date().toISOString(),
		})
		.execute();
}

async function addNode(
	db: Db,
	userId: string,
	input: {
		name: string;
		transport?: "client" | "ssh";
		status?: "active" | "pending";
		facts?: Record<string, unknown> | null;
		clientVersion?: string | null;
		lastSeenAt?: string | null;
	},
): Promise<{ id: string; name: string }> {
	const id = newId();
	const now = new Date().toISOString();
	const transport = input.transport ?? "client";
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name: input.name,
			name_key: input.name.toLowerCase(),
			transport,
			status: input.status ?? "active",
			public_key: null,
			hostname: input.name,
			facts: input.facts === undefined || input.facts === null ? null : JSON.stringify(input.facts),
			client_version: input.clientVersion ?? null,
			privileged_mode: null,
			last_seen_at: input.lastSeenAt ?? null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: transport === "ssh" ? "10.0.0.1" : null,
			ssh_port: transport === "ssh" ? 22 : null,
			ssh_user: transport === "ssh" ? "root" : null,
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	await grantNode(db, userId, id);
	return { id, name: input.name };
}

async function addGroup(db: Db, nodeId: string, name: string): Promise<void> {
	const groupId = newId();
	await db
		.insertInto("node_groups")
		.values({
			id: groupId,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		})
		.execute();
	await db.insertInto("node_group_members").values({ node_group_id: groupId, node_id: nodeId }).execute();
}

interface Fixture {
	db: Db;
	user: SessionUser;
	nodeId: string;
	now: string;
	base: ToolContext;
}

/** A member user with one accessible active node (named `web-1`). */
async function fixture(name = "tool-user", nodeName = "web-1"): Promise<Fixture> {
	const db = await openTestDb("sqlite");
	const created = await createUser(db, { username: name, kind: "member" });
	const node = await addNode(db, created.id, { name: nodeName });
	const user: SessionUser = { sessionId: "s", userId: created.id, username: created.username, kind: "member" };
	return {
		db,
		user,
		nodeId: node.id,
		now: new Date().toISOString(),
		base: {
			db,
			cluster: {} as Cluster,
			taskGroups: {} as TaskGroups,
			user,
			actor: { type: "user", id: created.id, onBehalfOfUserId: created.id },
			chain: [],
			approvalUrl: (kind, id) => `http://crh.test/approvals/${kind}/${id}`,
			taskUrl: (id) => `http://crh.test/tasks/${id}`,
			taskGroupUrl: (id) => `http://crh.test/task-groups/${id}`,
		},
	};
}

/** A page result for the read_file tests. */
function page(overrides: Partial<Extract<JsonTaskResult, { kind: "file.read" }>> = {}): JsonTaskResult {
	return { kind: "file.read", from: 1, to: 1, eof: true, total: 1, tooLong: false, ...overrides };
}

describe("the tool catalog", () => {
	it("lists every tool with its renderer", () => {
		expect(TOOLS.map((entry) => entry.name)).toEqual([
			"list_nodes",
			"node_info",
			"exec",
			"read_file",
			"write_file",
			"edit_file",
			"list_dir",
			"stat",
			"copy_file",
			"view_image",
			"task_wait",
			"task_cancel",
		]);
		expect(Object.fromEntries(TOOLS.map((entry) => [entry.name, entry.output]))).toMatchObject({
			list_nodes: "json",
			node_info: "json",
			exec: "text",
			read_file: "text",
			write_file: "json",
			edit_file: "json",
			list_dir: "json",
			stat: "json",
			task_wait: "text",
			task_cancel: "json",
		});
	});

	it("names parameters and fields in snake_case", () => {
		expect(
			tool("edit_file").input.parse({
				targets: ["web-1"],
				path: "/x",
				edits: [{ old_text: "a", new_text: "b" }],
			}),
		).toBeDefined();
		expect(
			tool("edit_file").input.safeParse({
				targets: ["web-1"],
				path: "/x",
				edits: [{ oldText: "a", newText: "b" }],
			}).success,
		).toBe(false);
		expect(tool("exec").input.safeParse({ targets: ["web-1"], cmd: "true", max_lines: 1 }).success).toBe(true);
		expect(tool("exec").input.safeParse({ targets: ["web-1"], cmd: "true", with_output: false }).success).toBe(true);
		// `node` and the old `output` parameter are gone: every node tool takes targets.
		expect(tool("node_info").input.safeParse({ node: "web-1" }).success).toBe(false);
		expect(
			tool("edit_file").input.safeParse({ node: "web-1", path: "/x", edits: [{ old_text: "a", new_text: "b" }] })
				.success,
		).toBe(false);
		const parsedExec = tool("exec").input.parse({ targets: ["web-1"], cmd: "true", output: "status" }) as Record<
			string,
			unknown
		>;
		expect(parsedExec).not.toHaveProperty("output");
		expect(parsedExec).not.toHaveProperty("with_output");
		expect(
			tool("write_file").input.safeParse({
				targets: ["web-1"],
				path: "/x",
				content: "a",
				mode: "0644",
				create_parent_dirs: true,
			}).success,
		).toBe(true);
		expect(
			tool("write_file").input.safeParse({ targets: ["web-1"], path: "/x", content: "a", mode: 644 }).success,
		).toBe(false);
		expect(tool("read_file").input.safeParse({ targets: ["web-1"], path: "/x", max_bytes: 10 }).success).toBe(true);
		// A blocking file tool has no wait parameter: the schema drops it.
		const parsedRead = tool("read_file").input.parse({ targets: ["web-1"], path: "/x", wait: 1 }) as Record<
			string,
			unknown
		>;
		expect(parsedRead).not.toHaveProperty("wait");
		expect(tool("stat").input.safeParse({ targets: ["web-1"], path: "/x" }).success).toBe(true);
	});
});

describe("non-task tools", () => {
	it("lists connected state, node groups and whether tasks can run", async () => {
		const f = await fixture("list-user");
		try {
			const client = await addNode(f.db, f.user.userId, {
				name: "client-1",
				facts: { hostname: "client-1", osId: "debian", osPrettyName: "Debian 12" },
				clientVersion: "3.0.0",
				lastSeenAt: "2026-01-02T00:00:00.000Z",
			});
			await addNode(f.db, f.user.userId, { name: "ssh-1", transport: "ssh" });
			await addNode(f.db, f.user.userId, { name: "off-1", status: "pending" });
			await addGroup(f.db, client.id, "prod");
			const cluster = { isConnected: (id: string) => id === client.id } as unknown as Cluster;
			const result = await tool("list_nodes").handler({} as never, { ...f.base, cluster });
			const nodes = jsonOf(result).nodes as Record<string, unknown>[];
			expect(nodes.find((n) => n.name === "client-1")).toMatchObject({
				connected: true,
				node_groups: ["prod"],
				os: "Debian 12",
				client_version: "3.0.0",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				can_run_tasks: true,
			});
			expect(nodes.find((n) => n.name === "ssh-1")).toMatchObject({ connected: null, can_run_tasks: true });
			expect(nodes.find((n) => n.name === "off-1")).toMatchObject({ connected: false, can_run_tasks: false });
			expect(nodes.find((n) => n.name === "web-1")).toMatchObject({ connected: false, can_run_tasks: false });
			expect(result.isError).toBe(false);
		} finally {
			await f.db.destroy();
		}
	});

	it("returns facts with snake_case keys and the node's notes", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "facts-user", kind: "member" });
			const node = await addNode(db, user.id, {
				name: "web-1",
				facts: {
					hostname: "web-1",
					osId: "ubuntu",
					osVersionId: "24.04",
					osPrettyName: "Ubuntu 24.04",
					kernel: "6.8",
					arch: "x86_64",
					initSystem: "systemd",
					packageManagers: ["apt"],
					privilegeTools: ["sudo"],
					notesPath: "/etc/crh/notes.md",
					clockOffsetMs: 1200,
					shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
				},
				clientVersion: "3.0.0",
				lastSeenAt: "2026-01-02T00:00:00.000Z",
			});
			await addGroup(db, node.id, "prod");
			const sessionUser: SessionUser = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
			const cluster = {
				evaluateFor: async () => ({ result: "allow" }),
				createTask: async () => task({ id: "notes-task", nodeId: node.id }),
				waitTask: async () =>
					task({
						id: "notes-task",
						nodeId: node.id,
						kind: "file.read",
						outputHead: "# web-1\n",
						result: page({ from: 1, to: 1, eof: true, total: 1 }),
					}),
			} as unknown as Cluster;
			const context = {
				...f2base(db, sessionUser),
				cluster,
			} as ToolContext;
			const info = await tool("node_info").handler({ targets: ["web-1"] } as never, context);
			const value = jsonOf(info);
			expect(value).toMatchObject({
				name: "web-1",
				node_groups: ["prod"],
				client_version: "3.0.0",
				last_seen_at: "2026-01-02T00:00:00.000Z",
				facts: {
					hostname: "web-1",
					os_id: "ubuntu",
					os_version_id: "24.04",
					os_pretty_name: "Ubuntu 24.04",
					kernel: "6.8",
					arch: "x86_64",
					init_system: "systemd",
					package_managers: ["apt"],
					privilege_tools: ["sudo"],
					notes_path: "/etc/crh/notes.md",
					clock_offset_ms: 1200,
					shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
				},
				notes: { path: "/etc/crh/notes.md", content: "# web-1\n" },
			});
			// Diffable: the JSON block has no indentation.
			expect(info.content[0]?.text).not.toContain("\n");
		} finally {
			await db.destroy();
		}
	});

	it("returns one entry per node for a batch and reads each node's notes under the batch budget", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "batch-facts-user", kind: "member" });
			const nodes: { id: string; name: string }[] = [];
			for (const name of ["web-1", "web-2"]) {
				nodes.push(
					await addNode(db, user.id, {
						name,
						facts: { hostname: name, notesPath: `/etc/crh/${name}.md` },
					}),
				);
			}
			const sessionUser: SessionUser = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
			const created: Record<string, unknown>[] = [];
			const byTask = new Map<string, string>();
			const cluster = {
				evaluateFor: async () => ({ result: "allow" }),
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					const nodeId = String(input.nodeId);
					byTask.set(`notes-${nodeId}`, nodeId);
					return task({ id: `notes-${nodeId}`, nodeId, kind: "file.read" });
				},
				waitTask: async (id: string) => {
					const nodeId = byTask.get(id) as string;
					const name = nodeId === nodes[0]?.id ? "web-1" : "web-2";
					const content = `# ${name}\n`;
					const lines = countOutputLines(content);
					return task({
						id,
						nodeId,
						kind: "file.read",
						outputHead: content,
						outputBytes: Buffer.byteLength(content),
						result: page({ from: 1, to: lines, eof: true, total: lines }),
					});
				},
			} as unknown as Cluster;
			const result = await tool("node_info").handler({ targets: ["web-1", "web-2"] } as never, {
				...f2base(db, sessionUser),
				cluster,
			});
			const value = jsonOf(result);
			expect(value).not.toHaveProperty("name");
			const entries = value.nodes as Record<string, unknown>[];
			expect(entries.map((entry) => entry.name)).toEqual(["web-1", "web-2"]);
			expect(entries[0]).toMatchObject({
				notes: { path: "/etc/crh/web-1.md", content: "# web-1\n" },
			});
			expect(entries[1]?.notes).toMatchObject({ path: "/etc/crh/web-2.md", content: "# web-2\n" });
			expect(result.content[0]?.text).not.toContain("task_id");
			expect(created).toHaveLength(2);
			for (const input of created) {
				expect(input).toMatchObject({ outputMode: "head", maxLines: 128, maxBytes: 8192 });
			}
		} finally {
			await db.destroy();
		}
	});

	it("keeps a batch's notes within one shared budget and names a node that got nothing", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "notes-budget-user", kind: "member" });
			const names = Array.from({ length: 8 }, (_, i) => `web-${i + 1}`);
			for (const name of names) {
				await addNode(db, user.id, { name, facts: { notesPath: `/etc/crh/${name}.md` } });
			}
			const sessionUser: SessionUser = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
			const content = `${"x".repeat(8191)}\n`;
			const cluster = {
				evaluateFor: async () => ({ result: "allow" }),
				createTask: async (input: Record<string, unknown>) =>
					task({ id: `notes-${String(input.nodeId)}`, nodeId: String(input.nodeId), kind: "file.read" }),
				waitTask: async (id: string) =>
					task({
						id,
						kind: "file.read",
						outputHead: content,
						outputBytes: Buffer.byteLength(content),
						result: page({ from: 1, to: 1, eof: true, total: 1 }),
					}),
			} as unknown as Cluster;
			const result = await tool("node_info").handler({ targets: names } as never, {
				...f2base(db, sessionUser),
				cluster,
			});
			const entries = jsonOf(result).nodes as {
				notes: { content: string | null; truncated?: string; note?: string };
			}[];
			// Six nodes fill 6 x 8 KB of the 50 KB batch budget; the seventh keeps the rest, the eighth nothing.
			expect(Buffer.byteLength(entries[5]?.notes.content ?? "")).toBe(8192);
			expect(Buffer.byteLength(entries[6]?.notes.content ?? "")).toBe(2048);
			expect(entries[6]?.notes.truncated).toContain("first 2048 bytes");
			expect(entries[7]?.notes.content).toBeNull();
			expect(entries[7]?.notes.note).toContain("batch budget");
		} finally {
			await db.destroy();
		}
	});

	it("leaves a node's notes alone in a batch when reading them would need approval", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "notes-approval-user", kind: "member" });
			const first = await addNode(db, user.id, { name: "web-1", facts: { notesPath: "/etc/crh/web-1.md" } });
			await addNode(db, user.id, { name: "web-2", facts: { notesPath: "/etc/crh/web-2.md" } });
			const sessionUser: SessionUser = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
			const created: Record<string, unknown>[] = [];
			const cluster = {
				evaluateFor: async (node: { id: string }) => ({
					result: node.id === first.id ? "allow" : "require-approval",
				}),
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					return task({ id: "notes-1", nodeId: String(input.nodeId), kind: "file.read" });
				},
				waitTask: async () =>
					task({
						id: "notes-1",
						kind: "file.read",
						outputHead: "# web-1\n",
						outputBytes: 8,
						result: page({ from: 1, to: 1, eof: true, total: 1 }),
					}),
			} as unknown as Cluster;
			const result = await tool("node_info").handler({ targets: ["web-1", "web-2"] } as never, {
				...f2base(db, sessionUser),
				cluster,
			});
			const entries = jsonOf(result).nodes as { notes: { content: string | null; note?: string } }[];
			expect(entries[0]?.notes.content).toBe("# web-1\n");
			expect(entries[1]?.notes).toMatchObject({ content: null, note: expect.stringContaining("approval") });
			expect(created).toHaveLength(1);
		} finally {
			await db.destroy();
		}
	});

	it("maps an unknown node to a no_such_node error result", async () => {
		const f = await fixture("unknown-node-user");
		try {
			const result = await callTool(tool("node_info") as never, { targets: ["nope"] }, f.base, { via: "mcp" });
			expect(result.isError).toBe(true);
			expect(jsonOf(result)).toEqual({
				error: { code: "no_such_node", message: "no node or node group nope that you can access" },
			});
		} finally {
			await f.db.destroy();
		}
	});
});

function f2base(db: Db, user: SessionUser): ToolContext {
	return {
		db,
		cluster: {} as Cluster,
		taskGroups: {} as TaskGroups,
		user,
		actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		chain: [],
		approvalUrl: (kind, id) => `http://crh.test/approvals/${kind}/${id}`,
		taskUrl: (id) => `http://crh.test/tasks/${id}`,
		taskGroupUrl: (id) => `http://crh.test/task-groups/${id}`,
	};
}

describe("expected tool errors", () => {
	it("renders a UserError code in the note block of a text tool", async () => {
		const f = await fixture("error-user");
		try {
			const result = await callTool(tool("exec") as never, { targets: ["web-1"] }, f.base, { via: "mcp" });
			expect(result.isError).toBe(true);
			expect(texts(result)).toEqual(["[error invalid_argument: give either cmd or argv]"]);
		} finally {
			await f.db.destroy();
		}
	});

	it("falls back to invalid_argument and not_found without an explicit code", async () => {
		const f = await fixture("fallback-user");
		try {
			const invalid = {
				name: "fake",
				output: "json" as const,
				handler: async () => {
					throw new UserError("bad argument");
				},
			};
			const bad = await callTool(invalid as never, {}, f.base, { via: "mcp" });
			expect(jsonOf(bad)).toEqual({ error: { code: "invalid_argument", message: "bad argument" } });
			const missing = {
				name: "missing",
				output: "json" as const,
				handler: async () => {
					throw new NotFoundError("gone");
				},
			};
			const gone = await callTool(missing as never, {}, f.base, { via: "mcp" });
			expect(jsonOf(gone)).toEqual({ error: { code: "not_found", message: "gone" } });
		} finally {
			await f.db.destroy();
		}
	});
});

describe("exec text results", () => {
	it("returns the raw merged tail and a note block with the exit status", () => {
		const result = execTaskResult(
			ctx,
			task({ outputTail: "hello\nworld\n", outputTailLines: 2, outputLines: 2 }),
			"web-1",
		);
		expect(texts(result)).toEqual(["hello\nworld\n", "[web-1, exit 0]"]);
		expect(result.isError).toBe(false);
		expect(result.details).toMatchObject({ task_id: "t1", node: "web-1", state: "exited", exit_code: 0 });
	});

	it("shows the line range and the full output path when truncated", () => {
		const result = execTaskResult(
			ctx,
			task({
				outputTail: "b\nc\n",
				outputTailLines: 2,
				outputLines: 5,
				outputFile: "/var/lib/crha/output/t1.log",
			}),
			"web-1",
		);
		expect(texts(result)[1]).toBe(
			"[web-1, exit 0]\n[Showing lines 4-5 of 5. Full output: /var/lib/crha/output/t1.log (read it with read_file).]",
		);
	});

	it("names the missing full output by transport and writes no line numbers without truncation", () => {
		const truncated = execTaskResult(
			ctx,
			task({ outputTail: "b\nc\n", outputTailLines: 2, outputLines: 5, outputFile: null }),
			"ssh-1",
			"ssh",
		);
		expect(texts(truncated)[1]).toContain("This is an SSH node; no full output is kept.");
		const crha = execTaskResult(
			ctx,
			task({ outputTail: "b\nc\n", outputTailLines: 2, outputLines: 5, outputFile: null }),
			"web-1",
		);
		expect(texts(crha)[1]).toContain("The node kept no full output.");
		expect(texts(crha)[1]).not.toContain("SSH");
		const whole = execTaskResult(ctx, task({ outputTail: "a\n", outputTailLines: 1, outputLines: 1 }), "web-1");
		expect(texts(whole)[1]).toBe("[web-1, exit 0]");
	});

	it("brackets every synthesized note line, the notice included", () => {
		const result = execTaskResult(
			ctx,
			task({
				outputTail: "x\n",
				outputTailLines: 1,
				outputBytes: 2,
				outputLines: 100,
				outputFile: "/out/t1",
				notice: "the node runs SSH; privileged was ignored\n",
			}),
			"web-1",
		);
		const lines = texts(result)[1]?.split("\n") ?? [];
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(line).toMatch(/^\[.*\]$/);
		expect(lines).toEqual([
			"[web-1, exit 0]",
			"[Showing lines 100-100 of 100. Full output: /out/t1 (read it with read_file).]",
			"[the node runs SSH; privileged was ignored]",
		]);
	});

	it("marks nonzero exits, timeouts, signals and task errors as errors", () => {
		const exit = execTaskResult(ctx, task({ state: "exited", exitCode: 2 }), "web-1");
		expect(exit.isError).toBe(true);
		expect(texts(exit).at(-1)).toBe("[web-1, exit 2]");

		const timeout = execTaskResult(ctx, task({ state: "failed", timedOut: true, timeoutMs: 30_000 }), "web-1");
		expect(timeout.isError).toBe(true);
		expect(texts(timeout).at(-1)).toBe("[web-1, timed out after 30 s]");

		const signal = execTaskResult(ctx, task({ state: "failed", signal: "SIGKILL" }), "web-1");
		expect(signal.isError).toBe(true);
		expect(texts(signal).at(-1)).toBe("[web-1, killed by SIGKILL]");

		const failed = execTaskResult(
			ctx,
			task({ state: "failed", exitCode: null, errorCode: "node_offline", errorMessage: "the node is not connected" }),
			"web-1",
		);
		expect(failed.isError).toBe(true);
		expect(texts(failed).at(-1)).toBe("[web-1, error node_offline: the node is not connected]");

		const unknown = execTaskResult(
			ctx,
			task({
				state: "unknown",
				exitCode: null,
				errorCode: "connection_lost",
				errorMessage: "the connection was lost",
			}),
			"web-1",
		);
		expect(unknown.isError).toBe(true);
		expect(texts(unknown).at(-1)).toContain("error connection_lost:");
	});

	it("returns notes with the id while a task still runs or waits", () => {
		const running = execTaskResult(ctx, task({ state: "running" }), "web-1");
		expect(running.isError).toBe(false);
		expect(texts(running)).toEqual(["[web-1, still running, task_id t1. Call task_wait with this task_id.]"]);

		const approval = execTaskResult(ctx, task({ state: "awaiting_approval" }), "web-1");
		expect(texts(approval)[0]).toBe(
			"[web-1, waiting for approval: http://crh.test/approvals/task/t1, task_id t1. Call task_wait with this task_id.]",
		);

		const authorization = execTaskResult(
			ctx,
			task({ state: "awaiting_authorization", privileged: true, authorization: authorizationRecord() }),
			"web-1",
		);
		expect(texts(authorization)[0]).toContain("waiting for authorization: http://crh.test/tasks/t1");
		expect(texts(authorization)[0]).toContain("task_id t1");
	});

	it("keeps the UI details shape for privileges and authorization", () => {
		expect(taskDetails(task({ privileged: true }), "web-1")).toMatchObject({ privileged: true });
		const details = taskDetails(task({ state: "awaiting_authorization", privileged: true }), "web-1");
		expect(details).toMatchObject({
			task_id: "t1",
			node: "web-1",
			state: "awaiting_authorization",
			privileged: true,
		});
	});
});

function authorizationRecord(): TaskAuthorizationRecord {
	return {
		plan: { paths: [{ path: "user", entries: [{ name: "alice", role: "user", credential: "sshsig" }] }] },
		tried: ["crhs"],
		dispatchedPath: null,
		payloadId: "6d4a",
		attempt: 2,
		trustDigest: "abc",
		pending: null,
		local: null,
		lastRejection: null,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("exec task groups", () => {
	it("renders text mode with a leading group note and one pair per node", () => {
		const g = group({
			outputMode: "text",
			nodeIds: ["n1", "n2"],
			tasks: [
				task({ id: "t1", nodeId: "n1", outputMode: "text", outputTail: "ok\n", outputLines: 1, outputFile: "/out/1" }),
				task({
					id: "t2",
					nodeId: "n2",
					outputMode: "text",
					state: "failed",
					exitCode: 1,
					outputTail: "bad\n",
					outputLines: 1,
					outputFile: "/out/2",
				}),
			],
		});
		const names = new Map([
			["n1", "web-1"],
			["n2", "db-1"],
		]);
		const result = execResultText(g, names);
		expect(result.isError).toBe(true);
		expect(texts(result)[0]).toBe("[task group g1, 2 nodes, 1 succeeded, 1 failed]");
		expect(texts(result)).toEqual(expect.arrayContaining(["ok\n", "[web-1, exit 0]", "bad\n", "[db-1, exit 1]"]));
		expect(result.details).toMatchObject({
			task_group_id: "g1",
			state: "finished",
			nodes: [
				{ task_id: "t1", node: "web-1", state: "exited", exit_code: 0 },
				{ task_id: "t2", node: "db-1", state: "failed", exit_code: 1 },
			],
		});
	});

	it("puts the truncation hint in each node's text note", () => {
		const g = group({
			outputMode: "text",
			tasks: [
				task({
					id: "t1",
					nodeId: "n1",
					outputMode: "text",
					outputTail: "tail\n",
					outputLines: 10,
					outputFile: "/out/1",
				}),
			],
		});
		const result = execResultText(g, new Map([["n1", "web-1"]]));
		expect(texts(result).at(-1)).toBe(
			"[web-1, exit 0]\n[Showing lines 10-10 of 10. Full output: /out/1 (read it with read_file).]",
		);
	});

	it("keeps status mode JSON and marks a group with a failed node as an error", () => {
		const g = group({
			outputMode: "status",
			tasks: [
				task({ id: "t1", nodeId: "n1", outputMode: "status", exitCode: 0, outputFile: "/out/1" }),
				task({ id: "t2", nodeId: "n2", outputMode: "status", state: "failed", exitCode: 1 }),
			],
		});
		const result = execResultStatus(
			g,
			new Map([
				["n1", "web-1"],
				["n2", "db-1"],
			]),
		);
		expect(result.isError).toBe(true);
		expect(jsonOf(result)).toMatchObject({
			task_group_id: "g1",
			state: "finished",
			nodes: [
				{ task_id: "t1", node: "web-1", state: "exited", exit_code: 0, output_file: "/out/1" },
				{ task_id: "t2", node: "db-1", state: "failed", exit_code: 1 },
			],
		});
		expect(result.details).toMatchObject({ task_group_id: "g1", nodes: expect.any(Array) });
	});

	it("shows the group id and how to follow it while it is still waiting", () => {
		const g = group({ state: "running", tasks: [task({ id: "t1", nodeId: "n1", state: "running" })] });
		const result = execResultStatus(g, new Map([["n1", "web-1"]]));
		expect(jsonOf(result)).toMatchObject({
			task_group_id: "g1",
			state: "running",
			next: "still running: call task_wait with this task_group_id",
		});
		expect(result.isError).toBe(false);
	});
});

describe("exec budgets", () => {
	it("caps a single task's merged tail through createTask", async () => {
		const f = await fixture("single-budget-user");
		try {
			const created: Record<string, unknown>[] = [];
			const cluster = {
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					return task({ id: "t1", nodeId: f.nodeId });
				},
				waitTask: async () => task({ id: "t1", nodeId: f.nodeId, outputTail: "last\n", outputTailLines: 1 }),
			} as unknown as Cluster;
			await tool("exec").handler({ targets: ["web-1"], cmd: "true", max_lines: 1, max_bytes: 10, wait: 0 } as never, {
				...f.base,
				cluster,
			});
			expect(created[0]).toMatchObject({ maxLines: 1, maxBytes: 10 });
		} finally {
			await f.db.destroy();
		}
	});

	it("uses text mode for a group and passes max_lines 1 to the group", async () => {
		const f = await fixture("group-budget-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const created: Record<string, unknown>[] = [];
			const taskGroups = {
				create: async (input: Record<string, unknown>) => {
					created.push(input);
					return "g1";
				},
				get: async () =>
					group({
						id: "g1",
						state: "finished",
						nodeIds: [f.nodeId],
						outputMode: "text",
						tasks: [],
					}),
				wait: async () =>
					group({
						id: "g1",
						state: "finished",
						nodeIds: [f.nodeId],
						outputMode: "text",
						tasks: [],
					}),
			} as unknown as TaskGroups;
			const result = await tool("exec").handler({ targets: ["prod"], cmd: "true", max_lines: 1, wait: 0 } as never, {
				...f.base,
				taskGroups,
			});
			expect(created[0]).toMatchObject({ outputMode: "text", maxLines: 1 });
			expect(result.isError).toBe(false);
			expect(texts(result)[0]).toContain("task group g1");
		} finally {
			await f.db.destroy();
		}
	});

	it("rejects with_output: false together with a budget as invalid_argument", async () => {
		const f = await fixture("status-budget-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			for (const budgets of [{ max_lines: 1 }, { max_bytes: 10 }]) {
				const result = await callTool(
					tool("exec") as never,
					{ targets: ["prod"], cmd: "true", with_output: false, ...budgets },
					f.base,
					{ via: "mcp" },
				);
				expect(result.isError).toBe(true);
				expect(texts(result)[0]).toContain("[error invalid_argument:");
			}
		} finally {
			await f.db.destroy();
		}
	});

	it("returns status JSON for a single task with with_output: false", async () => {
		const f = await fixture("single-status-user");
		try {
			const created: Record<string, unknown>[] = [];
			const cluster = {
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					return task({ id: "t1", nodeId: f.nodeId, kind: "exec", outputMode: "status" });
				},
				waitTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						kind: "exec",
						outputMode: "status",
						exitCode: 0,
						outputFile: "/var/lib/crha/output/t1.log",
					}),
			} as unknown as Cluster;
			const result = await tool("exec").handler(
				{ targets: ["web-1"], cmd: "true", with_output: false, wait: 0 } as never,
				{
					...f.base,
					cluster,
				},
			);
			expect(created[0]).toMatchObject({ outputMode: "status" });
			expect(result.isError).toBe(false);
			expect(jsonOf(result)).toMatchObject({
				task_id: "t1",
				node: "web-1",
				state: "exited",
				exit_code: 0,
				output_file: "/var/lib/crha/output/t1.log",
			});
			expect(result.content[0]?.text).not.toContain("task_wait");
		} finally {
			await f.db.destroy();
		}
	});

	it("defaults a batch to text with output", async () => {
		const f = await fixture("default-output-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const created: Record<string, unknown>[] = [];
			const taskGroups = {
				create: async (input: Record<string, unknown>) => {
					created.push(input);
					return "g1";
				},
				get: async () => group({ id: "g1", state: "finished", nodeIds: [f.nodeId], outputMode: "text", tasks: [] }),
				wait: async () => group({ id: "g1", state: "finished", nodeIds: [f.nodeId], outputMode: "text", tasks: [] }),
			} as unknown as TaskGroups;
			await tool("exec").handler({ targets: ["prod"], cmd: "true", wait: 0 } as never, {
				...f.base,
				taskGroups,
			});
			expect(created[0]?.outputMode).toBe("text");
		} finally {
			await f.db.destroy();
		}
	});

	it("passes exec's timeout to each member of a batch", async () => {
		const f = await fixture("batch-timeout-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const created: Record<string, unknown>[] = [];
			const taskGroups = {
				create: async (input: Record<string, unknown>) => {
					created.push(input);
					return "g1";
				},
				get: async () => group({ id: "g1", state: "finished", nodeIds: [f.nodeId], outputMode: "text", tasks: [] }),
				wait: async () => group({ id: "g1", state: "finished", nodeIds: [f.nodeId], outputMode: "text", tasks: [] }),
			} as unknown as TaskGroups;
			await tool("exec").handler({ targets: ["prod"], cmd: "true", timeout: 30, wait: 0 } as never, {
				...f.base,
				taskGroups,
			});
			expect(created[0]?.timeoutMs).toBe(30_000);
		} finally {
			await f.db.destroy();
		}
	});

	it("returns status JSON for a batch with with_output: false", async () => {
		const f = await fixture("batch-status-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const created: Record<string, unknown>[] = [];
			const statusGroup = () =>
				group({
					id: "g1",
					state: "finished",
					nodeIds: [f.nodeId],
					outputMode: "status",
					tasks: [task({ id: "t1", nodeId: f.nodeId, outputMode: "status", outputFile: "/out/1" })],
				});
			const taskGroups = {
				create: async (input: Record<string, unknown>) => {
					created.push(input);
					return "g1";
				},
				get: async () => statusGroup(),
				wait: async () => statusGroup(),
			} as unknown as TaskGroups;
			const result = await tool("exec").handler(
				{ targets: ["prod"], cmd: "true", with_output: false, wait: 0 } as never,
				{
					...f.base,
					taskGroups,
				},
			);
			expect(created[0]).toMatchObject({ outputMode: "status" });
			expect(result.isError).toBe(false);
			expect(jsonOf(result)).toMatchObject({
				task_group_id: "g1",
				state: "finished",
				nodes: [{ task_id: "t1", output_file: "/out/1" }],
			});
		} finally {
			await f.db.destroy();
		}
	});

	it("passes read_file's group budgets and limit", async () => {
		const f = await fixture("read-budget-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const created: Record<string, unknown>[] = [];
			const taskGroups = {
				create: async (input: Record<string, unknown>) => {
					created.push(input);
					return "g1";
				},
				get: async () => group({ id: "g1", state: "finished", nodeIds: [f.nodeId], outputMode: "head", tasks: [] }),
			} as unknown as TaskGroups;
			await tool("read_file").handler({ targets: ["prod"], path: "/etc/hosts", limit: 50, max_bytes: 2048 } as never, {
				...f.base,
				taskGroups,
			});
			expect(created[0]).toMatchObject({
				maxLines: 50,
				maxBytes: 2048,
				spec: { kind: "file.read", path: "/etc/hosts", startLine: 1, lineCount: 50 },
			});
			created.length = 0;
			await tool("read_file").handler({ targets: ["prod"], path: "/etc/hosts" } as never, {
				...f.base,
				taskGroups,
			});
			expect(created[0]).toMatchObject({ maxLines: 128, spec: { lineCount: 2000 } });
		} finally {
			await f.db.destroy();
		}
	});
});

describe("read_file pages", () => {
	it("returns the page bytes and says how to continue", () => {
		const result = execRead(
			task({
				kind: "file.read",
				outputHead: "one\ntwo\n",
				outputBytes: 8,
				result: page({ from: 1, to: 2, eof: false, total: null }),
			}),
			"/var/log/x",
			1,
			undefined,
		);
		expect(texts(result)).toEqual(["one\ntwo\n", "[web-1:/var/log/x, lines 1-2. Use offset=3 to continue.]"]);
		expect(result.isError).toBe(false);
	});

	it("reports the total and the end of the file only when the page reached it", () => {
		const result = execRead(
			task({
				kind: "file.read",
				outputHead: "three\n",
				outputBytes: 6,
				result: page({ from: 3, to: 3, eof: true, total: 3 }),
			}),
			"/x",
			3,
			undefined,
		);
		expect(texts(result)[1]).toBe("[web-1:/x, lines 3-3 of 3 (end of file)]");
	});

	it("says the file is empty", () => {
		const result = execRead(
			task({ kind: "file.read", result: page({ from: 0, to: 0, eof: true, total: 0 }) }),
			"/x",
			1,
			undefined,
		);
		expect(texts(result)).toEqual(["[web-1:/x, the file is empty]"]);
		expect(result.isError).toBe(false);
	});

	it("reports a too-long line and a start past the end with their codes", () => {
		const tooLong = execRead(
			task({ kind: "file.read", result: page({ from: 0, to: 0, eof: false, total: null, tooLong: true }) }),
			"/x",
			4,
			undefined,
		);
		expect(tooLong.isError).toBe(true);
		expect(texts(tooLong)[0]).toContain("[web-1:/x, error line_too_long:");
		expect(texts(tooLong)[0]).toContain("sed -n '4p' '/x'");

		const pastEnd = execRead(
			task({ kind: "file.read", result: page({ from: 0, to: 0, eof: false, total: 5 }) }),
			"/x",
			9,
			undefined,
		);
		expect(pastEnd.isError).toBe(true);
		expect(texts(pastEnd)[0]).toContain("[web-1:/x, error offset_out_of_range:");
		expect(texts(pastEnd)[0]).toContain("has 5 lines");
	});

	it("cuts a page at max_bytes on a whole line and continues from there", () => {
		const result = execRead(
			task({
				kind: "file.read",
				outputHead: "one\ntwo\nthree\n",
				outputBytes: 14,
				outputLines: 3,
				result: page({ from: 1, to: 3, eof: true, total: 3 }),
			}),
			"/x",
			1,
			4,
		);
		expect(texts(result)).toEqual(["one\n", "[web-1:/x, lines 1-1. Use offset=2 to continue.]"]);
	});

	it("reads several nodes with their own pages and cursors", () => {
		const g = group({
			outputMode: "head",
			kind: "file.read",
			nodeIds: ["n1", "n2"],
			tasks: [
				task({
					id: "t1",
					nodeId: "n1",
					kind: "file.read",
					outputMode: "head",
					outputHead: "one\n",
					outputBytes: 4,
					result: page({ from: 1, to: 1, eof: true, total: 1 }),
				}),
				task({
					id: "t2",
					nodeId: "n2",
					kind: "file.read",
					outputMode: "head",
					outputHead: "a\nb\n",
					outputBytes: 4,
					result: page({ from: 2, to: 3, eof: false, total: null }),
				}),
			],
		});
		const result = readGroup(
			g,
			new Map([
				["n1", "web-1"],
				["n2", "db-1"],
			]),
			"/x",
			1,
			undefined,
		);
		expect(texts(result)).toEqual([
			"[task group, 2 nodes, 2 succeeded, 0 failed]",
			"one\n",
			"[web-1:/x, lines 1-1 of 1 (end of file)]",
			"a\nb\n",
			"[db-1:/x, lines 2-3. Use offset=4 to continue.]",
		]);
		expect(result.details).toMatchObject({
			task_group_id: "g1",
			nodes: [
				{ task_id: "t1", node: "web-1" },
				{ task_id: "t2", node: "db-1" },
			],
		});
	});
});

/** Runs readTaskResult with the default page context. */
function execRead(t: TaskView, path: string, startLine: number, maxBytes: number | undefined): ToolResult {
	return readTaskResult(ctx, t, "web-1", path, startLine, maxBytes);
}

function readGroup(g: TaskGroupView, names: Map<string, string>, path: string, start: number, maxBytes?: number) {
	return readGroupResult(ctx, g, names, path, start, maxBytes);
}

describe("file tool JSON results", () => {
	it("returns list_dir entries and write/edit fields without a task id in the content", async () => {
		const f = await fixture("file-json-user");
		try {
			const results: JsonTaskResult[] = [
				{
					kind: "file.list",
					entries: [{ name: "a.txt", type: "file", size: 1, mode: "0644", mtime: "t" }],
					truncated: false,
				},
				{ kind: "file.write", bytes: 3, created: true },
				{ kind: "file.edit", replacements: 1 },
			];
			const cluster = {
				createTask: async (input: Record<string, unknown>) =>
					task({ id: "t1", nodeId: f.nodeId, kind: (input.spec as TaskSpec).kind }),
				getTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.list", state: "running" }),
				waitTask: async () => {
					const result = results.shift();
					return task({ id: "t1", nodeId: f.nodeId, kind: result?.kind ?? "file.list", result: result ?? null });
				},
			} as unknown as Cluster;
			const context = { ...f.base, cluster };
			const listing = await tool("list_dir").handler({ targets: ["web-1"], path: "/tmp" } as never, context);
			expect(jsonOf(listing)).toMatchObject({
				node: "web-1",
				state: "exited",
				entries: [expect.objectContaining({ name: "a.txt" })],
				truncated: false,
			});
			expect(listing.content[0]?.text).not.toContain("task_id");
			expect(jsonOf(listing)).not.toHaveProperty("task_id");
			expect(listing.details).toMatchObject({ task_id: "t1", node: "web-1", state: "exited" });

			const written = await tool("write_file").handler(
				{ targets: ["web-1"], path: "/tmp/x", content: "abc" } as never,
				context,
			);
			expect(jsonOf(written)).toMatchObject({ bytes: 3, created: true });
			expect(written.details).toMatchObject({ task_id: "t1" });

			const edited = await tool("edit_file").handler(
				{ targets: ["web-1"], path: "/tmp/x", edits: [{ old_text: "a", new_text: "b" }] } as never,
				context,
			);
			expect(jsonOf(edited)).toMatchObject({ replacements: 1 });
		} finally {
			await f.db.destroy();
		}
	});

	it("maps edit_file's snake_case edits to the protocol's task spec", async () => {
		const f = await fixture("edit-spec-user");
		try {
			const created: Record<string, unknown>[] = [];
			const cluster = {
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					return task({ id: "t1", nodeId: f.nodeId, kind: "file.edit" });
				},
				getTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.edit", state: "running" }),
				waitTask: async () =>
					task({ id: "t1", nodeId: f.nodeId, kind: "file.edit", result: { kind: "file.edit", replacements: 1 } }),
			} as unknown as Cluster;
			await tool("edit_file").handler(
				{ targets: ["web-1"], path: "/tmp/x", edits: [{ old_text: "a", new_text: "b" }] } as never,
				{ ...f.base, cluster },
			);
			expect(created[0]?.spec).toMatchObject({ kind: "file.edit", edits: [{ oldText: "a", newText: "b" }] });
		} finally {
			await f.db.destroy();
		}
	});

	it("takes mode as an octal string and passes create_parent_dirs to the task spec", async () => {
		const f = await fixture("write-mode-user");
		try {
			const created: Record<string, unknown>[] = [];
			const cluster = {
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					return task({ id: "t1", nodeId: f.nodeId, kind: "file.write" });
				},
				getTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.write", state: "running" }),
				waitTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						kind: "file.write",
						result: { kind: "file.write", bytes: 1, created: true },
					}),
			} as unknown as Cluster;
			const context = { ...f.base, cluster };
			const write = (body: Record<string, unknown>) =>
				tool("write_file").handler({ targets: ["web-1"], path: "/x", content: "a", ...body } as never, context);

			await write({ mode: "0644", create_parent_dirs: true });
			expect(created[0]?.spec).toMatchObject({ mode: 0o644, createParentDirs: true });
			await write({ mode: "755" });
			expect(created[1]?.spec).toMatchObject({ mode: 0o755, createParentDirs: false });

			for (const mode of ["0o644", "0648", "77777", "077777", "rw-r--r--"]) {
				const bad = await callTool(
					tool("write_file") as never,
					{ targets: ["web-1"], path: "/x", content: "a", mode },
					context,
					{ via: "mcp" },
				);
				expect(bad.isError, mode).toBe(true);
				expect(jsonOf(bad)).toMatchObject({ error: { code: "invalid_argument" } });
			}
		} finally {
			await f.db.destroy();
		}
	});

	it("edits several nodes as a task group and lets one node fail alone", async () => {
		const f = await fixture("edit-group-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const created: Record<string, unknown>[] = [];
			const taskGroups = {
				create: async (input: Record<string, unknown>) => {
					created.push(input);
					return "g1";
				},
				get: async () =>
					group({
						id: "g1",
						kind: "file.edit",
						outputMode: "head",
						nodeIds: ["n1", "n2"],
						tasks: [
							task({
								id: "t1",
								nodeId: "n1",
								kind: "file.edit",
								result: { kind: "file.edit", replacements: 1 },
							}),
							task({
								id: "t2",
								nodeId: "n2",
								kind: "file.edit",
								state: "failed",
								exitCode: null,
								errorCode: "edit_no_match",
								errorMessage: "could not find edits[0] in /x",
							}),
						],
					}),
			} as unknown as TaskGroups;
			const result = await tool("edit_file").handler(
				{ targets: ["prod"], path: "/x", edits: [{ old_text: "a", new_text: "b" }] } as never,
				{ ...f.base, taskGroups },
			);
			expect(created[0]).toMatchObject({
				spec: { kind: "file.edit", path: "/x", edits: [{ oldText: "a", newText: "b" }] },
			});
			expect(result.isError).toBe(true);
			expect(jsonOf(result)).toMatchObject({
				state: "finished",
				nodes: [
					{ node: "n1", replacements: 1 },
					{ node: "n2", error: { code: "edit_no_match" } },
				],
			});
			expect(result.details).toMatchObject({ task_group_id: "g1" });
		} finally {
			await f.db.destroy();
		}
	});

	it("returns stat's attributes and a link target", async () => {
		const f = await fixture("stat-user");
		try {
			const cluster = {
				createTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.stat" }),
				getTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.stat", state: "running" }),
				waitTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						kind: "file.stat",
						result: {
							kind: "file.stat",
							path: "/tmp/link",
							type: "symlink",
							size: 5,
							mode: "0777",
							uid: 0,
							gid: 0,
							owner: "root",
							group: "root",
							mtime: "2026-01-01T00:00:00Z",
							linkTarget: "/tmp/target",
						},
					}),
			} as unknown as Cluster;
			const result = await tool("stat").handler({ targets: ["web-1"], path: "/tmp/link" } as never, {
				...f.base,
				cluster,
			});
			expect(jsonOf(result)).toMatchObject({
				path: "/tmp/link",
				type: "symlink",
				size: 5,
				mode: "0777",
				owner: "root",
				link_target: "/tmp/target",
			});
			expect(result.details).toMatchObject({ task_id: "t1", node: "web-1" });
		} finally {
			await f.db.destroy();
		}
	});

	it("renders a failed file task as the bare error object", async () => {
		const f = await fixture("file-error-user");
		try {
			const cluster = {
				createTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.write" }),
				getTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.write", state: "running" }),
				waitTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						kind: "file.write",
						state: "failed",
						exitCode: null,
						errorCode: "permission_denied",
						errorMessage: "permission denied",
					}),
			} as unknown as Cluster;
			const result = await tool("write_file").handler({ targets: ["web-1"], path: "/x", content: "a" } as never, {
				...f.base,
				cluster,
			});
			expect(result.isError).toBe(true);
			expect(jsonOf(result)).toEqual({ error: { code: "permission_denied", message: "permission denied" } });
			expect(result.details).toMatchObject({ task_id: "t1", state: "failed" });
		} finally {
			await f.db.destroy();
		}
	});

	it("renders a group of file tasks with per-node errors and no group id in the content", async () => {
		const f = await fixture("file-group-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const taskGroups = {
				create: async () => "g1",
				get: async () =>
					group({
						id: "g1",
						state: "finished",
						kind: "file.stat",
						outputMode: "head",
						nodeIds: ["n1", "n2"],
						tasks: [
							task({
								id: "t1",
								nodeId: "n1",
								kind: "file.stat",
								result: {
									kind: "file.stat",
									path: "/x",
									type: "file",
									size: 1,
									mode: "0644",
									uid: 0,
									gid: 0,
									owner: "root",
									group: "root",
									mtime: "t",
									linkTarget: null,
								},
							}),
							task({
								id: "t2",
								nodeId: "n2",
								kind: "file.stat",
								state: "failed",
								exitCode: null,
								errorCode: "not_found",
								errorMessage: "no such file",
							}),
						],
					}),
			} as unknown as TaskGroups;
			const result = await tool("stat").handler({ targets: ["prod"], path: "/x" } as never, {
				...f.base,
				taskGroups,
			});
			const value = jsonOf(result);
			expect(result.isError).toBe(true);
			expect(value).toMatchObject({
				state: "finished",
				nodes: [
					{ node: "n1", type: "file" },
					{ node: "n2", error: { code: "not_found" } },
				],
			});
			expect(value).not.toHaveProperty("task_group_id");
			expect(result.details).toMatchObject({ task_group_id: "g1", nodes: [{ task_id: "t1" }, { task_id: "t2" }] });
		} finally {
			await f.db.destroy();
		}
	});
});

describe("blocking file tools", () => {
	it("cancels its task when the call is aborted", async () => {
		const f = await fixture("abort-user");
		try {
			let state: TaskView["state"] = "running";
			let cancelled = false;
			const statuses: Record<string, unknown>[] = [];
			const cluster = {
				createTask: async () => task({ id: "t1", nodeId: f.nodeId, kind: "file.write", state: "running" }),
				getTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						kind: "file.write",
						state,
						...(state === "rejected" ? { cancelled: true, errorCode: "cancelled", errorMessage: "aborted" } : {}),
					}),
				waitTask: (_id: string, _ms: number, signal?: AbortSignal) =>
					new Promise<TaskView>((resolve) => {
						const done = () => resolve(task({ id: "t1", nodeId: f.nodeId, kind: "file.write", state: "running" }));
						if (signal?.aborted) done();
						else signal?.addEventListener("abort", done, { once: true });
					}),
				cancelTask: async () => {
					cancelled = true;
					state = "rejected";
					return true;
				},
			} as unknown as Cluster;
			const controller = new AbortController();
			const call = tool("write_file").handler({ targets: ["web-1"], path: "/tmp/x", content: "a" } as never, {
				...f.base,
				cluster,
				signal: controller.signal,
				onStatus: async (status) => {
					statuses.push(status);
				},
			});
			setTimeout(() => controller.abort(), 20);
			const result = await call;
			expect(cancelled).toBe(true);
			expect(statuses[0]).toEqual({ task_id: "t1", state: "running" });
			expect(result.isError).toBe(true);
			expect(jsonOf(result)).toEqual({ error: { code: "cancelled", message: "aborted" } });
			expect(result.details).toMatchObject({ task_id: "t1", state: "rejected", cancelled: true });
		} finally {
			await f.db.destroy();
		}
	});
});

describe("following up exec", () => {
	it("rejects a file task with no_such_task", async () => {
		const f = await fixture("wait-file-user");
		try {
			const fileTask = task({
				id: "t1",
				nodeId: f.nodeId,
				kind: "file.read",
				actorType: "user",
				actorId: f.user.userId,
				onBehalfOfUserId: f.user.userId,
			});
			const cluster = { getTask: async () => fileTask } as unknown as Cluster;
			const result = await callTool(
				tool("task_wait") as never,
				{ task_id: "t1", wait: 0 },
				{ ...f.base, cluster },
				{ via: "mcp" },
			);
			expect(result.isError).toBe(true);
			expect(texts(result)).toEqual(["[error no_such_task: no such task]"]);
		} finally {
			await f.db.destroy();
		}
	});

	it("rejects a file task group with no_such_task", async () => {
		const f = await fixture("wait-file-group-user");
		try {
			const taskGroups = {
				get: async () =>
					group({
						id: "g1",
						kind: "file.read",
						outputMode: "head",
						state: "finished",
						actorType: "user",
						actorId: f.user.userId,
						onBehalfOfUserId: f.user.userId,
					}),
			} as unknown as TaskGroups;
			const result = await callTool(
				tool("task_wait") as never,
				{ task_group_id: "g1", wait: 0 },
				{ ...f.base, taskGroups },
				{ via: "mcp" },
			);
			expect(result.isError).toBe(true);
			expect(texts(result)).toEqual(["[error no_such_task: no such task group]"]);
		} finally {
			await f.db.destroy();
		}
	});

	it("renders an exec task as text with its details", async () => {
		const f = await fixture("wait-exec-user");
		try {
			const cluster = {
				getTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						actorType: "user",
						actorId: f.user.userId,
						onBehalfOfUserId: f.user.userId,
						outputTail: "done\n",
						outputTailLines: 1,
						outputLines: 1,
					}),
				waitTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						actorType: "user",
						actorId: f.user.userId,
						onBehalfOfUserId: f.user.userId,
						outputTail: "done\n",
						outputTailLines: 1,
						outputLines: 1,
					}),
			} as unknown as Cluster;
			const result = await tool("task_wait").handler({ task_id: "t1", wait: 0 } as never, {
				...f.base,
				cluster,
			});
			expect(texts(result)).toEqual(["done\n", "[web-1, exit 0]"]);
			expect(result.details).toMatchObject({ task_id: "t1", node: "web-1", state: "exited" });
		} finally {
			await f.db.destroy();
		}
	});

	it("acts only on its own tasks", async () => {
		const f = await fixture("scope-user");
		try {
			const cluster = {
				getTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						actorType: "user",
						actorId: "someone-else",
						onBehalfOfUserId: "someone-else",
					}),
			} as unknown as Cluster;
			const result = await callTool(
				tool("task_wait") as never,
				{ task_id: "t1", wait: 0 },
				{ ...f.base, cluster },
				{
					via: "mcp",
				},
			);
			expect(result.isError).toBe(true);
			expect(texts(result)).toEqual(["[error no_such_task: no such task]"]);
		} finally {
			await f.db.destroy();
		}
	});

	it("cancels an exec task and returns JSON", async () => {
		const f = await fixture("cancel-user");
		try {
			const cluster = {
				getTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						actorType: "user",
						actorId: f.user.userId,
						onBehalfOfUserId: f.user.userId,
					}),
				cancelTask: async () => true,
			} as unknown as Cluster;
			const result = await tool("task_cancel").handler({ task_id: "t1" } as never, { ...f.base, cluster });
			expect(jsonOf(result)).toEqual({ task_id: "t1", cancel_sent: true });
		} finally {
			await f.db.destroy();
		}
	});
});

describe("the statuses a wait publishes", () => {
	it("publishes the task id before waiting and the approval link while waiting", async () => {
		const f = await fixture("status-user");
		try {
			let reads = 0;
			const cluster = {
				createTask: async () => task({ id: "t1", nodeId: f.nodeId, state: "awaiting_approval" }),
				getTask: async () =>
					task({ id: "t1", nodeId: f.nodeId, state: reads++ === 0 ? "awaiting_approval" : "exited" }),
				waitTask: async () => task({ id: "t1", nodeId: f.nodeId, state: "exited" }),
			} as unknown as Cluster;
			const statuses: Record<string, unknown>[] = [];
			const context = {
				...f.base,
				cluster,
				waitThroughApproval: true,
				onStatus: async (status: Record<string, unknown>) => {
					statuses.push(status);
				},
			};
			const call = tool("exec").handler({ targets: ["web-1"], cmd: "true", wait: 1 } as never, context);
			// The approval wait polls once a second; the first status is already out.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(statuses[0]).toEqual({ task_id: "t1", state: "awaiting_approval" });
			expect(statuses[1]).toEqual({
				task_id: "t1",
				state: "awaiting_approval",
				approval_url: "http://crh.test/approvals/task/t1",
			});
			await call;
		} finally {
			await f.db.destroy();
		}
	}, 15_000);

	it("publishes the group id before waiting and the group authorization link", async () => {
		const f = await fixture("group-status-user");
		try {
			await addGroup(f.db, f.nodeId, "prod");
			const states = ["awaiting_authorization", "awaiting_authorization", "exited"];
			let reads = 0;
			const taskGroups = {
				create: async () => "g1",
				get: async () => {
					const state = (states[Math.min(reads++, 2)] ?? "exited") as TaskGroupView["state"];
					return group({
						id: "g1",
						state,
						kind: "exec",
						outputMode: "status",
						nodeIds: [f.nodeId],
						tasks: [
							task({
								id: "t1",
								nodeId: f.nodeId,
								state: state === "awaiting_authorization" ? "awaiting_authorization" : "exited",
							}),
						],
					});
				},
				wait: async () =>
					group({
						id: "g1",
						state: "finished",
						kind: "exec",
						outputMode: "status",
						nodeIds: [f.nodeId],
						tasks: [task({ id: "t1", nodeId: f.nodeId, state: "exited" })],
					}),
			} as unknown as TaskGroups;
			const statuses: Record<string, unknown>[] = [];
			const context = {
				...f.base,
				taskGroups,
				waitThroughApproval: true,
				onStatus: async (status: Record<string, unknown>) => {
					statuses.push(status);
				},
			};
			await tool("exec").handler({ targets: ["prod"], cmd: "true", wait: 1 } as never, context);
			expect(statuses[0]).toEqual({ task_group_id: "g1", state: "awaiting_authorization" });
			expect(statuses[1]).toEqual({
				task_group_id: "g1",
				state: "awaiting_authorization",
				authorization_url: "http://crh.test/task-groups/g1",
			});
			expect(statuses.at(-1)).toEqual({ task_group_id: "g1", state: "finished" });
		} finally {
			await f.db.destroy();
		}
	}, 15_000);
});

describe("the privileged tool parameter", () => {
	it("is an optional boolean on every task tool", () => {
		const valid: Record<string, Record<string, unknown>> = {
			exec: { targets: ["web-1"], cmd: "true" },
			read_file: { targets: ["web-1"], path: "/etc/hosts" },
			write_file: { targets: ["web-1"], path: "/tmp/x", content: "x" },
			edit_file: { targets: ["web-1"], path: "/tmp/x", edits: [{ old_text: "a", new_text: "b" }] },
			list_dir: { targets: ["web-1"], path: "/tmp" },
			stat: { targets: ["web-1"], path: "/tmp" },
		};
		for (const [name, body] of Object.entries(valid)) {
			const candidate = tool(name);
			expect(candidate.input.safeParse(body).success, name).toBe(true);
			expect(candidate.input.safeParse({ ...body, privileged: true }).success, name).toBe(true);
			expect(candidate.input.safeParse({ ...body, privileged: "true" }).success, name).toBe(false);
		}
	});

	it("passes it to task creation and reports it in the details", async () => {
		const f = await fixture("priv-tool-user");
		try {
			const created: Record<string, unknown>[] = [];
			const cluster = {
				createTask: async (input: Record<string, unknown>) => {
					created.push(input);
					return task({ id: "t1", nodeId: f.nodeId, kind: "file.write", privileged: true });
				},
				getTask: async () =>
					task({ id: "t1", nodeId: f.nodeId, kind: "file.write", state: "running", privileged: true }),
				waitTask: async () =>
					task({
						id: "t1",
						nodeId: f.nodeId,
						kind: "file.write",
						privileged: true,
						result: { kind: "file.write", bytes: 1, created: true },
					}),
			} as unknown as Cluster;
			const result = await tool("write_file").handler(
				{ targets: ["web-1"], path: "/tmp/x", content: "a", privileged: true } as never,
				{ ...f.base, cluster },
			);
			expect(created[0]).toMatchObject({ privileged: true });
			expect(jsonOf(result)).toMatchObject({ bytes: 1, created: true });
			expect(result.details).toMatchObject({ task_id: "t1", privileged: true });
		} finally {
			await f.db.destroy();
		}
	});
});
