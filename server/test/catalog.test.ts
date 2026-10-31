import { describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { TaskAuthorizationRecord } from "../src/cluster/authorization.ts";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import type { TaskGroups } from "../src/cluster/task-groups.ts";
import { TOOLS, type ToolContext, taskResult } from "../src/tools/catalog.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

const ctx = {
	approvalUrl: (kind: string, id: string) => `http://crh.test/approvals/${kind}/${id}`,
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
		errorCode: null,
		errorMessage: null,
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutHead: "",
		stdoutTail: "",
		stderrHead: "",
		stderrTail: "",
		outputFile: null,
		outputMode: "full",
		privileged: false,
		authorization: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		taskGroupId: null,
		ruleChain: null,
		approval: null,
		rootSessionId: null,
		handlerType: null,
		handlerSessionId: null,
		...overrides,
	};
}

describe("batch output tool parameter", () => {
	const exec = TOOLS.find((tool) => tool.name === "exec");
	if (!exec) throw new Error("exec tool missing");

	it("defaults to status and only accepts status or text", () => {
		const parsed = exec.input.parse({ targets: ["web-1"], cmd: "true" }) as { output?: string };
		// Omitted in the schema (the handler applies the default) so a model may leave it out.
		expect(parsed.output).toBeUndefined();
		expect(exec.input.safeParse({ targets: ["web-1"], cmd: "true", output: "text" }).success).toBe(true);
		expect(exec.input.safeParse({ targets: ["web-1"], cmd: "true", output: "full" }).success).toBe(false);
	});

	it("hands the group status by default and text when asked", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "tool-user", kind: "member" });
			const sessionUser: SessionUser = {
				sessionId: "s",
				userId: user.id,
				username: user.username,
				kind: "member",
			};
			const nodeId = newId();
			const now = new Date().toISOString();
			await db
				.insertInto("nodes")
				.values({
					id: nodeId,
					org_id: await defaultOrgId(db),
					owner_user_id: user.id,
					name: "web-1",
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
					ssh_host_key: null,
					ssh_credential_id: null,
					ssh_jumps: null,
				})
				.execute();
			const created: { outputMode?: string }[] = [];
			const groups = {
				create: async (input: { outputMode?: string }) => {
					created.push(input);
					return "g1";
				},
				wait: async () => ({
					id: "g1",
					state: "finished",
					targets: ["web-1"],
					nodeIds: [nodeId],
					parallel: 1,
					failFast: false,
					outputMode: "status",
					skipped: [],
					tasks: [],
					createdAt: now,
					finishedAt: now,
				}),
			};
			const toolCtx = {
				db,
				cluster: {} as Cluster,
				groups: groups as unknown as TaskGroups,
				user: sessionUser,
				actor: { type: "system", id: "test", onBehalfOfUserId: user.id },
				chain: [],
				approvalUrl: () => "http://crh.test/",
			} as unknown as ToolContext;
			await exec.handler({ targets: ["web-1"], cmd: "true" }, toolCtx);
			await exec.handler({ targets: ["web-1"], cmd: "true", output: "text" }, toolCtx);
			expect(created.map((input) => input.outputMode)).toEqual(["status", "text"]);
		} finally {
			await db.destroy();
		}
	});
});

describe("taskResult output modes", () => {
	it("shows a text task's combined tail and notes the truncation", () => {
		const short = taskResult(
			task({ outputMode: "text", stdoutTail: "out\nerr\n", stdoutBytes: 4, stderrBytes: 4, outputFile: "/out" }),
			"web-1",
			ctx,
		);
		expect(short).toMatchObject({ output: "out\nerr\n" });
		expect(short.stdout).toBeUndefined();
		expect(short.truncated).toBeUndefined();

		const cut = taskResult(
			task({ outputMode: "text", stdoutTail: "tail\n", stdoutBytes: 90 * 1024, stderrBytes: 10 * 1024 }),
			"web-1",
			ctx,
		);
		expect(cut).toMatchObject({
			output: "tail\n",
			truncated: { stdout_bytes: 90 * 1024, stderr_bytes: 10 * 1024, note: expect.stringContaining("only the end") },
		});
	});

	it("shows only the output file for a status task", () => {
		const r = taskResult(
			task({ outputMode: "status", stdoutBytes: 1024, outputFile: "/var/lib/crha/output/t.log" }),
			"web-1",
			ctx,
		);
		expect(r).toMatchObject({
			output_file: "/var/lib/crha/output/t.log",
			note: "full output is on the node; read it with read_file",
		});
		expect(r.stdout).toBeUndefined();
		expect(r.output).toBeUndefined();
	});

	it("says SSH nodes keep no output when no file was reported", () => {
		const r = taskResult(task({ outputMode: "status", stdoutBytes: 10 }), "ssh-1", ctx);
		expect(r.output_file).toBeUndefined();
		expect(r.note).toContain("SSH nodes keep no output");
	});

	it("does not blame SSH when a status task never ran", () => {
		const r = taskResult(
			task({
				outputMode: "status",
				state: "failed",
				exitCode: null,
				errorCode: "node_offline",
				errorMessage: "the node is not connected",
			}),
			"web-1",
			ctx,
		);
		expect(r.note).toBeUndefined();
		expect(r.error).toEqual({ code: "node_offline", message: "the node is not connected" });
	});

	it("leaves full-mode results as they were", () => {
		const r = taskResult(task({ stdoutHead: "hello\n", stdoutBytes: 6 }), "web-1", ctx);
		expect(r).toMatchObject({ stdout: "hello\n" });
		expect(r.output).toBeUndefined();
	});

	it("shows that a task was privileged", () => {
		expect(taskResult(task({ privileged: true }), "web-1", ctx)).toMatchObject({ privileged: true });
		expect(taskResult(task({ privileged: false }), "web-1", ctx).privileged).toBeUndefined();
	});

	it("shows the authorization plan of a task that waits for a signature", () => {
		const authorization: TaskAuthorizationRecord = {
			plan: {
				paths: [{ path: "user", entries: [{ name: "alice", role: "user", credential: "sshsig" }] }],
			},
			tried: ["crhs"],
			dispatchedPath: null,
			payloadId: "6d4a",
			attempt: 2,
			trustDigest: "abc",
			pending: null,
			local: null,
			lastRejection: { code: "authorization_rejected", message: "denied", attempt: 1, at: "2026-01-01T00:00:00.000Z" },
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const r = taskResult(task({ state: "awaiting_authorization", privileged: true, authorization }), "web-1", ctx);
		expect(r).toMatchObject({ state: "awaiting_authorization", privileged: true });
		expect(r.authorization).toMatchObject({
			status: "waiting for the owner's authorization",
			attempt: 2,
			paths: ["user: alice"],
			last_rejection: { code: "authorization_rejected", message: "denied", attempt: 1 },
		});
		// The implicit context has no absolute URLs: the session UI gets the in-app hash link.
		expect((r.authorization as Record<string, unknown>).url).toBe("/tasks/t1");
		expect((r.authorization as Record<string, unknown>).next).toContain("authorize it in the WebUI");
		expect(r.next).toBe("call task_wait with this task_id to keep waiting");

		// With a local path and a task URL the model is told both ways to authorize it.
		const withLocal: TaskAuthorizationRecord = {
			...authorization,
			plan: {
				paths: [
					{ path: "user", entries: [{ name: "alice", role: "user", credential: "sshsig" }] },
					{ path: "local", entries: [{ name: "local-admins", role: "local" }] },
				],
			},
		};
		const withUrl = {
			approvalUrl: (kind: string, id: string) => `http://crh.test/approvals/${kind}/${id}`,
			taskUrl: (id: string) => `http://crh.test/tasks/${id}`,
		} as unknown as ToolContext;
		const local = taskResult(
			task({ state: "awaiting_authorization", privileged: true, authorization: withLocal }),
			"web-1",
			withUrl,
		);
		expect((local.authorization as Record<string, unknown>).url).toBe("http://crh.test/tasks/t1");
		expect((local.authorization as Record<string, unknown>).next).toContain('"crha approve t1"');
	});
});

describe("node facts", () => {
	/** A node of the user with stored facts JSON; returns the db, its node_info result and its list_nodes entry. */
	async function withNode(name: string, facts: Record<string, unknown>) {
		const db = await openTestDb("sqlite");
		const user = await createUser(db, { username: `${name}-user`, kind: "member" });
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				owner_user_id: user.id,
				name,
				transport: "client",
				status: "active",
				public_key: null,
				hostname: name,
				facts: JSON.stringify(facts),
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		const toolCtx = {
			db,
			cluster: { isConnected: () => false } as unknown as Cluster,
			groups: {} as TaskGroups,
			user: {
				sessionId: "s",
				userId: user.id,
				username: user.username,
				kind: "member",
			} satisfies SessionUser,
			actor: { type: "user", id: user.id, onBehalfOfUserId: user.id },
			chain: [],
			approvalUrl: () => "http://crh.test/",
		} as unknown as ToolContext;
		const info = (await (
			TOOLS.find((tool) => tool.name === "node_info") as { handler: (a: unknown, c: ToolContext) => Promise<unknown> }
		).handler({ node: name }, toolCtx)) as { facts: Record<string, unknown>; notes: unknown };
		const nodes = (await (
			TOOLS.find((tool) => tool.name === "list_nodes") as {
				handler: (a: unknown, c: ToolContext) => Promise<unknown>;
			}
		).handler({}, toolCtx)) as { nodes: { name: string; os?: string }[] };
		const listed = nodes.nodes.find((n) => n.name === name);
		if (!listed) throw new Error(`list_nodes does not list ${name}`);
		return { db, info, listed };
	}

	it("shows the shells a node reported", async () => {
		const { db, info } = await withNode("web-1", {
			hostname: "web-1",
			osId: "ubuntu",
			osVersionId: "24.04",
			osPrettyName: "Ubuntu 24.04",
			kernel: "6.8",
			arch: "x86_64",
			initSystem: "systemd",
			packageManagers: ["apt"],
			privilegeTools: ["sudo"],
			notesPath: "",
			groups: [],
			clockOffsetMs: 0,
			shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
		});
		try {
			expect(info.facts.shells).toEqual({ sh: "/bin/sh", bash: "/usr/bin/bash" });
		} finally {
			await db.destroy();
		}
	});

	it("leaves facts the node did not report absent", async () => {
		const { db, info } = await withNode("web-2", {
			hostname: "web-2",
			groups: ["db"],
			shells: { sh: "/bin/sh" },
		});
		try {
			// The absent optional keys stay absent: no notes path, no bash, no clock offset.
			expect(info.facts).toEqual({ hostname: "web-2", groups: ["db"], shells: { sh: "/bin/sh" } });
			expect(info.notes).toBeNull();
		} finally {
			await db.destroy();
		}
	});

	it("reports the OS pretty name in list_nodes", async () => {
		const { db, listed } = await withNode("web-3", {
			hostname: "web-3",
			groups: [],
			osId: "ubuntu",
			osPrettyName: "Ubuntu 24.04",
		});
		try {
			expect(listed.os).toBe("Ubuntu 24.04");
		} finally {
			await db.destroy();
		}
	});

	it("falls back to the OS id in list_nodes when the pretty name is absent", async () => {
		const { db, listed } = await withNode("web-4", { hostname: "web-4", groups: [], osId: "debian" });
		try {
			expect(listed.os).toBe("debian");
		} finally {
			await db.destroy();
		}
	});

	it("has no OS in list_nodes for a node whose facts do not carry one", async () => {
		const { db, listed } = await withNode("web-5", { shells: { sh: "/bin/sh" } });
		try {
			expect(listed.os).toBeUndefined();
		} finally {
			await db.destroy();
		}
	});
});

describe("the authorization wait status", () => {
	/** A node of the user, so resolveTargets finds it. */
	async function setup() {
		const db = await openTestDb("sqlite");
		const user = await createUser(db, { username: "wait-user", kind: "member" });
		const nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				owner_user_id: user.id,
				name: "web-1",
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
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		const sessionUser: SessionUser = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
		return { db, nodeId, now, user: sessionUser };
	}

	it("reports the signing page while a task waits for the user's signature", async () => {
		const { db, nodeId, now, user } = await setup();
		try {
			const states = ["awaiting_authorization", "exited"];
			let reads = 0;
			const cluster = {
				createTask: async () => task({ id: "t1", nodeId, state: "awaiting_authorization" }),
				getTask: async (id: string) => task({ id, nodeId, state: (states[Math.min(reads++, 1)] ?? "exited") as never }),
				waitTask: async (id: string) => task({ id, nodeId, state: "exited" }),
			};
			const statuses: Record<string, unknown>[] = [];
			const toolCtx = {
				db,
				cluster: cluster as unknown as Cluster,
				groups: {} as TaskGroups,
				user,
				actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
				chain: [],
				approvalUrl: (kind: string, id: string) => `/approvals/${kind}/${id}`,
				taskUrl: (id: string) => `/tasks/${id}`,
				waitThroughApproval: true,
				onStatus: async (status: Record<string, unknown>) => {
					statuses.push(status);
				},
			} as unknown as ToolContext;
			const exec = TOOLS.find((t) => t.name === "exec");
			if (!exec) throw new Error("exec tool missing");
			await exec.handler({ node: "web-1", cmd: "true", wait: 1 }, toolCtx);
			expect(statuses[0]).toEqual({
				task_id: "t1",
				state: "awaiting_authorization",
				authorization_url: "/tasks/t1",
			});
			expect(statuses.at(-1)).toEqual({ task_id: "t1", state: "exited" });
			expect(now).toBeDefined();
		} finally {
			await db.destroy();
		}
	}, 15_000);

	it("reports the group page while a group waits for the user's signature", async () => {
		const { db, nodeId, now, user } = await setup();
		try {
			const group = {
				id: "g1",
				state: "awaiting_authorization",
				targets: ["web-1"],
				nodeIds: [nodeId],
				parallel: 1,
				failFast: false,
				outputMode: "status",
				skipped: [],
				tasks: [task({ id: "t1", nodeId, state: "awaiting_authorization" })],
				createdAt: now,
				finishedAt: null,
			};
			const groups = {
				create: async () => "g1",
				get: async () => group,
				wait: async () => ({ ...group, state: "finished", tasks: [{ ...group.tasks[0], state: "exited" }] }),
			};
			const statuses: Record<string, unknown>[] = [];
			const toolCtx = {
				db,
				cluster: {} as Cluster,
				groups: groups as unknown as TaskGroups,
				user,
				actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
				chain: [],
				approvalUrl: (kind: string, id: string) => `/approvals/${kind}/${id}`,
				groupUrl: (id: string) => `/task-groups/${id}`,
				waitThroughApproval: true,
				onStatus: async (status: Record<string, unknown>) => {
					statuses.push(status);
				},
			} as unknown as ToolContext;
			const exec = TOOLS.find((t) => t.name === "exec");
			if (!exec) throw new Error("exec tool missing");
			await exec.handler({ targets: ["web-1"], cmd: "true", wait: 1 }, toolCtx);
			expect(statuses[0]).toEqual({
				task_group_id: "g1",
				state: "awaiting_authorization",
				authorization_url: "/task-groups/g1",
			});
		} finally {
			await db.destroy();
		}
	}, 15_000);
});

describe("the privileged tool parameter", () => {
	const tool = (name: string) => {
		const found = TOOLS.find((t) => t.name === name);
		if (!found) throw new Error(`${name} tool missing`);
		return found;
	};
	const valid: Record<string, Record<string, unknown>> = {
		exec: { node: "web-1", cmd: "true" },
		read_file: { node: "web-1", path: "/etc/hosts" },
		write_file: { node: "web-1", path: "/tmp/x", content: "x" },
		edit_file: { node: "web-1", path: "/tmp/x", edits: [{ oldText: "a", newText: "b" }] },
		list_dir: { node: "web-1", path: "/tmp" },
	};

	it("is an optional boolean on every task tool", () => {
		for (const [name, body] of Object.entries(valid)) {
			const t = tool(name);
			expect(t.input.safeParse(body).success, name).toBe(true);
			expect(t.input.safeParse({ ...body, privileged: true }).success, name).toBe(true);
			expect(t.input.safeParse({ ...body, privileged: "true" }).success, name).toBe(false);
		}
	});

	it("passes it to task creation and reports it in the result", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "priv-tool-user", kind: "member" });
			const sessionUser: SessionUser = {
				sessionId: "s",
				userId: user.id,
				username: user.username,
				kind: "member",
			};
			const nodeId = newId();
			const now = new Date().toISOString();
			await db
				.insertInto("nodes")
				.values({
					id: nodeId,
					org_id: await defaultOrgId(db),
					owner_user_id: user.id,
					name: "web-1",
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
					ssh_host_key: null,
					ssh_credential_id: null,
					ssh_jumps: null,
				})
				.execute();
			const created: { privileged?: boolean }[] = [];
			const cluster = {
				createTask: async (input: { privileged?: boolean }) => {
					created.push(input);
					return task({ id: "t1", privileged: input.privileged === true });
				},
				waitTask: async () => task({ id: "t1", privileged: true }),
			} as unknown as Cluster;
			const groups = {
				create: async () => "g1",
				wait: async () => ({
					id: "g1",
					state: "finished",
					targets: ["web-1"],
					nodeIds: [nodeId],
					parallel: 1,
					failFast: false,
					outputMode: "status",
					privileged: true,
					skipped: [],
					tasks: [task({ id: "t1", privileged: true })],
					createdAt: now,
					finishedAt: now,
				}),
			} as unknown as TaskGroups;
			const toolCtx = {
				db,
				cluster,
				groups,
				user: sessionUser,
				actor: { type: "system", id: "test", onBehalfOfUserId: user.id },
				chain: [],
				approvalUrl: () => "http://crh.test/",
			} as unknown as ToolContext;

			await tool("exec").handler({ node: "web-1", cmd: "true", privileged: true }, toolCtx);
			await tool("exec").handler({ node: "web-1", cmd: "true" }, toolCtx);
			expect(created.map((input) => input.privileged)).toEqual([true, false]);

			const single = (await tool("read_file").handler(
				{ node: "web-1", path: "/etc/hosts", privileged: true },
				toolCtx,
			)) as Record<string, unknown>;
			expect(single.privileged).toBe(true);

			const batch = (await tool("exec").handler(
				{ targets: ["web-1"], cmd: "true", privileged: true },
				toolCtx,
			)) as Record<string, unknown>;
			expect(batch.privileged).toBe(true);
			expect((batch.nodes as Record<string, unknown>[])[0]?.privileged).toBe(true);
		} finally {
			await db.destroy();
		}
	});
});
