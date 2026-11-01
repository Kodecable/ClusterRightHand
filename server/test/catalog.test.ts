import type { JsonTaskResult, TaskSpec } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { TaskAuthorizationRecord } from "../src/cluster/authorization.ts";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import type { TaskGroups, TaskGroupView } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
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
		result: null,
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
			await db.insertInto("node_groups").values({ node_id: nodeId, group_name: "prod", refreshed_at: now }).execute();
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
			await exec.handler({ targets: ["group:prod"], cmd: "true" }, toolCtx);
			await exec.handler({ targets: ["group:prod"], cmd: "true", output: "text" }, toolCtx);
			// The tool leaves exec's default (status) to the group; text is passed through.
			expect(created.map((input) => input.outputMode)).toEqual([undefined, "text"]);
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
		expect(r.notice).toBeUndefined();
	});

	it("shows the notice crhs kept for a status task", () => {
		const notice = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";
		const r = taskResult(task({ outputMode: "status", stderrBytes: notice.length, stderrHead: notice }), "ssh-1", ctx);
		expect(r.notice).toBe(notice);
		// The notice does not stand in for the missing output file.
		expect(r.output_file).toBeUndefined();
		expect(r.note).toContain("SSH nodes keep no output");
	});

	it("shows the notice crhs kept for a head task", () => {
		const notice = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";
		const r = taskResult(
			task({
				kind: "file.read",
				outputMode: "head",
				stdoutHead: "one\ntwo\n",
				stdoutBytes: 8,
				stderrBytes: notice.length,
				stderrHead: notice,
			}),
			"ssh-1",
			ctx,
		);
		expect(r.notice).toBe(notice);
		// The notice is not part of the page the node kept.
		expect(r.output).toBe("one\ntwo\n");
		expect(r.truncated).toBeUndefined();
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

describe("the statuses a wait publishes", () => {
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
			await exec.handler({ targets: ["web-1"], cmd: "true", wait: 1 }, toolCtx);
			// The first status carries only the id and the state: the WebUI follows the task by it.
			expect(statuses[0]).toEqual({ task_id: "t1", state: "awaiting_authorization" });
			expect(statuses[1]).toEqual({
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
			await db.insertInto("node_groups").values({ node_id: nodeId, group_name: "prod", refreshed_at: now }).execute();
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
			await exec.handler({ targets: ["group:prod"], cmd: "true", wait: 1 }, toolCtx);
			expect(statuses[0]).toEqual({ task_group_id: "g1", state: "awaiting_authorization" });
			expect(statuses[1]).toEqual({
				task_group_id: "g1",
				state: "awaiting_authorization",
				authorization_url: "/task-groups/g1",
			});
			expect(statuses.at(-1)).toEqual({ task_group_id: "g1", state: "finished" });
		} finally {
			await db.destroy();
		}
	}, 15_000);

	it("carries the task id before the first wait, with and without approval waits", async () => {
		const { db, nodeId, user } = await setup();
		try {
			const cluster = {
				createTask: async () => task({ id: "t1", nodeId, state: "running" }),
				getTask: async (id: string) => task({ id, nodeId, state: "running" }),
				waitTask: async (id: string) => task({ id, nodeId, state: "exited" }),
			};
			const exec = TOOLS.find((t) => t.name === "exec");
			if (!exec) throw new Error("exec tool missing");
			// An agent waits through approvals, an MCP caller does not; both publish the id before waiting.
			for (const waitThroughApproval of [true, false]) {
				const statuses: Record<string, unknown>[] = [];
				const toolCtx = {
					db,
					cluster: cluster as unknown as Cluster,
					groups: {} as TaskGroups,
					user,
					actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
					chain: [],
					approvalUrl: (kind: string, id: string) => `/approvals/${kind}/${id}`,
					waitThroughApproval,
					onStatus: async (status: Record<string, unknown>) => {
						statuses.push(status);
					},
				} as unknown as ToolContext;
				await exec.handler({ targets: ["web-1"], cmd: "true", wait: 1 }, toolCtx);
				expect(statuses[0], `waitThroughApproval=${waitThroughApproval}`).toEqual({
					task_id: "t1",
					state: "running",
				});
			}
		} finally {
			await db.destroy();
		}
	}, 15_000);

	it("carries the task group id before the first wait, with and without approval waits", async () => {
		const { db, nodeId, now, user } = await setup();
		try {
			await db.insertInto("node_groups").values({ node_id: nodeId, group_name: "prod", refreshed_at: now }).execute();
			const group = {
				id: "g1",
				state: "running",
				targets: ["web-1"],
				nodeIds: [nodeId],
				parallel: 1,
				failFast: false,
				outputMode: "status",
				skipped: [],
				tasks: [task({ id: "t1", nodeId, state: "running" })],
				createdAt: now,
				finishedAt: null,
			};
			const groups = {
				create: async () => "g1",
				get: async () => group,
				wait: async () => ({ ...group, state: "finished", tasks: [{ ...group.tasks[0], state: "exited" }] }),
			};
			const exec = TOOLS.find((t) => t.name === "exec");
			if (!exec) throw new Error("exec tool missing");
			for (const waitThroughApproval of [true, false]) {
				const statuses: Record<string, unknown>[] = [];
				const toolCtx = {
					db,
					cluster: {} as Cluster,
					groups: groups as unknown as TaskGroups,
					user,
					actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
					chain: [],
					approvalUrl: (kind: string, id: string) => `/approvals/${kind}/${id}`,
					waitThroughApproval,
					onStatus: async (status: Record<string, unknown>) => {
						statuses.push(status);
					},
				} as unknown as ToolContext;
				await exec.handler({ targets: ["group:prod"], cmd: "true", wait: 1 }, toolCtx);
				expect(statuses[0], `waitThroughApproval=${waitThroughApproval}`).toEqual({
					task_group_id: "g1",
					state: "running",
				});
			}
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
		exec: { targets: ["web-1"], cmd: "true" },
		read_file: { targets: ["web-1"], path: "/etc/hosts" },
		write_file: { targets: ["web-1"], path: "/tmp/x", content: "x" },
		edit_file: { node: "web-1", path: "/tmp/x", edits: [{ oldText: "a", newText: "b" }] },
		list_dir: { targets: ["web-1"], path: "/tmp" },
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
			await db.insertInto("node_groups").values({ node_id: nodeId, group_name: "prod", refreshed_at: now }).execute();
			const created: { privileged?: boolean }[] = [];
			const page = {
				stdoutHead: "127.0.0.1 localhost\n",
				result: { kind: "file.read", from: 1, to: 1, eof: true, total: 1, tooLong: false } satisfies JsonTaskResult,
			};
			const cluster = {
				createTask: async (input: { privileged?: boolean }) => {
					created.push(input);
					return task({ id: "t1", privileged: input.privileged === true, ...page });
				},
				waitTask: async () => task({ id: "t1", privileged: true, ...page }),
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
					tasks: [task({ id: "t1", privileged: true, ...page })],
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

			await tool("exec").handler({ targets: ["web-1"], cmd: "true", privileged: true }, toolCtx);
			await tool("exec").handler({ targets: ["web-1"], cmd: "true" }, toolCtx);
			expect(created.map((input) => input.privileged)).toEqual([true, false]);

			const single = (await tool("read_file").handler(
				{ targets: ["web-1"], path: "/etc/hosts", privileged: true },
				toolCtx,
			)) as Record<string, unknown>;
			expect(single.privileged).toBe(true);

			const batch = (await tool("exec").handler(
				{ targets: ["group:prod"], cmd: "true", privileged: true },
				toolCtx,
			)) as Record<string, unknown>;
			expect(batch.privileged).toBe(true);
			expect((batch.nodes as Record<string, unknown>[])[0]?.privileged).toBe(true);
		} finally {
			await db.destroy();
		}
	});
});

const tool = (name: string) => {
	const found = TOOLS.find((t) => t.name === name);
	if (!found) throw new Error(`${name} tool missing`);
	return found;
};

/** A user, their node and a tool context acting for them. */
async function seedToolContext(db: Db, name: string): Promise<{ user: SessionUser; nodeId: string; ctx: ToolContext }> {
	const user = await createUser(db, { username: name, kind: "member" });
	const sessionUser: SessionUser = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
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
	return {
		user: sessionUser,
		nodeId,
		ctx: {
			db,
			cluster: {} as Cluster,
			groups: {} as TaskGroups,
			user: sessionUser,
			actor: { type: "user", id: user.id, onBehalfOfUserId: user.id },
			chain: [],
			approvalUrl: (kind: string, id: string) => `http://crh.test/approvals/${kind}/${id}`,
		} as unknown as ToolContext,
	};
}

/** Inserts a node owned by `userId` and returns its id. */
async function addNode(db: Db, userId: string, name: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			owner_user_id: userId,
			name,
			transport: "client",
			status: "active",
			public_key: null,
			hostname: name,
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
	return id;
}

describe("targets decide the result shape", () => {
	it("runs one task for one node name and a task group for a group or several entries", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { user, ctx: baseCtx } = await seedToolContext(db, "group-user");
			for (const [name, group] of [
				["g-1", "prod"],
				["g-2", "prod"],
				["solo", "one"],
			] as const) {
				const id = await addNode(db, user.userId, name);
				await db
					.insertInto("node_groups")
					.values({ node_id: id, group_name: group, refreshed_at: new Date().toISOString() })
					.execute();
			}
			const created: { nodeId: string }[] = [];
			const groupInputs: { targets: string[]; nodeIds: string[]; outputMode?: string }[] = [];
			const cluster = {
				createTask: async (input: { nodeId: string }) => {
					created.push(input);
					return task({ id: "t1", nodeId: input.nodeId });
				},
				waitTask: async () => task({ id: "t1" }),
			} as unknown as Cluster;
			const groupViews = {
				create: async (input: { targets: string[]; nodeIds: string[]; outputMode?: string }) => {
					groupInputs.push(input);
					return "g1";
				},
				get: async () => ({
					id: "g1",
					state: "finished",
					targets: [],
					nodeIds: groupInputs[0]?.nodeIds ?? [],
					parallel: 10,
					failFast: false,
					outputMode: groupInputs[0]?.outputMode ?? "status",
					privileged: false,
					skipped: [],
					tasks: (groupInputs[0]?.nodeIds ?? []).map((nodeId, i) => task({ id: `t${i}`, nodeId })),
					createdAt: "2026-01-01T00:00:00.000Z",
					finishedAt: "2026-01-01T00:00:00.000Z",
					summary: "true",
					kind: "exec",
					ruleChain: null,
					approval: null,
					actorType: "user",
					actorId: user.userId,
					onBehalfOfUserId: user.userId,
					operation: null,
					rootSessionId: null,
					handlerType: null,
					handlerSessionId: null,
				}),
				wait: async () => (await groupViews.get("g1")) as unknown,
			} as unknown as TaskGroups;
			const ctx = { ...baseCtx, cluster, groups: groupViews } as ToolContext;

			// One node name: one task, one task result.
			await expect(tool("exec").handler({ targets: ["web-1"], cmd: "true" }, ctx)).resolves.toMatchObject({
				task_id: "t1",
			});
			expect(created).toHaveLength(1);
			expect(groupInputs).toHaveLength(0);

			// A group entry is a task group even when it resolves to one node.
			await tool("exec").handler({ targets: ["group:prod"], cmd: "true" }, ctx);
			expect(groupInputs).toHaveLength(1);
			expect(groupInputs[0]?.nodeIds).toHaveLength(2);
			// exec's default mode (status) and a file operation's head are the group's decision.
			expect(groupInputs[0]?.outputMode).toBeUndefined();

			// A group that resolves to one node is still a task group: the input, not the resolution, decides.
			await tool("exec").handler({ targets: ["group:one"], cmd: "true" }, ctx);
			expect(groupInputs).toHaveLength(2);
			expect(groupInputs[1]?.nodeIds).toHaveLength(1);

			// Several node names are a task group too.
			await tool("exec").handler({ targets: ["web-1", "g-1"], cmd: "true" }, ctx);
			expect(groupInputs).toHaveLength(3);

			// A file operation's group takes no output parameter at all: the group keeps each node's head.
			await tool("list_dir").handler({ targets: ["web-1", "g-1"], path: "/tmp" }, ctx);
			expect(groupInputs[3]?.outputMode).toBeUndefined();
			for (const name of ["read_file", "write_file", "list_dir"]) {
				expect(Object.keys((tool(name).input as unknown as { shape: object }).shape)).not.toContain("output");
			}
			expect(Object.keys((tool("exec").input as unknown as { shape: object }).shape)).toContain("output");

			// edit_file stays single-node: a group there is an error, never an arbitrary pick.
			await expect(
				tool("edit_file").handler({ node: "group:prod", path: "/tmp/x", edits: [{ oldText: "a", newText: "b" }] }, ctx),
			).rejects.toThrow(/matches 2 nodes/);
		} finally {
			await db.destroy();
		}
	});
});

describe("read_file line paging", () => {
	/** The lines of a file, each with its newline; a last line without one stays unterminated. */
	function linesOf(content: string): string[] {
		if (content === "") return [];
		const parts = content.split("\n");
		if (parts.at(-1) === "") parts.pop();
		return parts.map((line, i) => (i === parts.length - 1 && !content.endsWith("\n") ? line : `${line}\n`));
	}

	/** A fake node: it pages like crha's executor (whole lines, the byte cap, the result JSON). */
	function pageOf(
		content: string,
		startLine: number,
		lineCount: number,
		cap = 50 * 1024,
	): { page: string; result: JsonTaskResult } {
		const lines = linesOf(content);
		if (startLine > lines.length) {
			return {
				page: "",
				result: { kind: "file.read", from: 0, to: 0, eof: true, total: lines.length, tooLong: false },
			};
		}
		const picked: string[] = [];
		let bytes = 0;
		for (let i = startLine - 1; i < lines.length && picked.length < lineCount; i++) {
			const size = Buffer.byteLength(lines[i] as string);
			if (bytes + size > cap) {
				if (picked.length === 0) {
					return { page: "", result: { kind: "file.read", from: 0, to: 0, eof: false, total: null, tooLong: true } };
				}
				break;
			}
			picked.push(lines[i] as string);
			bytes += size;
		}
		const reached = startLine - 1 + picked.length >= lines.length;
		return {
			page: picked.join(""),
			result: {
				kind: "file.read",
				from: startLine,
				to: startLine + picked.length - 1,
				eof: reached,
				total: reached ? lines.length : null,
				tooLong: false,
			},
		};
	}

	/** A tool context whose cluster serves reads from `files`, recording the specs it asked for. */
	async function readContext(ctx: ToolContext, files: Record<string, string>) {
		const specs: TaskSpec[] = [];
		const tasks = new Map<string, TaskView>();
		let n = 0;
		const cluster = {
			createTask: async (input: { id?: string; spec: TaskSpec; nodeId: string }) => {
				specs.push(input.spec);
				const spec = input.spec as Extract<TaskSpec, { kind: "file.read" }>;
				const { page, result } = pageOf(files[spec.path] ?? "", spec.startLine, spec.lineCount);
				const id = input.id ?? `read-${++n}`;
				const t = task({
					id,
					nodeId: input.nodeId,
					kind: "file.read",
					stdoutBytes: Buffer.byteLength(page),
					stdoutHead: page,
					result,
				});
				tasks.set(id, t);
				return t;
			},
			waitTask: async (id: string) => tasks.get(id),
		} as unknown as Cluster;
		return { ctx: { ...ctx, cluster } as ToolContext, specs };
	}

	it("reads a page of lines with one task and returns its bytes exactly", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "read-user");
			const path = "/var/log/app.log";
			const read = await readContext(ctx, { [path]: "one\ntwo\nthree\n" });
			const all = (await tool("read_file").handler({ targets: ["web-1"], path }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
				total?: number;
				truncated?: { note: string };
			};

			// One call is one line-based task, and the page keeps the file's final newline.
			expect(read.specs).toEqual([{ kind: "file.read", path, startLine: 1, lineCount: 2_000 }]);
			expect(all.stdout).toBe("one\ntwo\nthree\n");
			expect(all.lines).toEqual({ from: 1, to: 3 });
			expect(all.total).toBe(3);
			expect(all.truncated).toBeUndefined();

			// A page that stops at the line limit keeps the newline of its last line and gives the cursor.
			const page = (await tool("read_file").handler({ targets: ["web-1"], path, limit: 2 }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
				total?: number;
				truncated?: { note: string };
			};
			expect(page.stdout).toBe("one\ntwo\n");
			expect(page.lines).toEqual({ from: 1, to: 2 });
			expect(page.total).toBeUndefined();
			expect(page.truncated).toEqual({ note: "Use offset=3 to continue." });

			// The cursor continues where the page stopped; the node pages by line, so the tool just asks.
			const next = (await tool("read_file").handler({ targets: ["web-1"], path, offset: 3 }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
			};
			expect(next.stdout).toBe("three\n");
			expect(next.lines).toEqual({ from: 3, to: 3 });
			expect(read.specs.at(-1)).toMatchObject({ kind: "file.read", startLine: 3 });

			// A start line in the middle reads just that page, without reading the file before it again.
			const mid = (await tool("read_file").handler({ targets: ["web-1"], path, offset: 2, limit: 1 }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
			};
			expect(mid.stdout).toBe("two\n");
			expect(mid.lines).toEqual({ from: 2, to: 2 });

			// A file whose last line has no newline is returned without one.
			const bare = await readContext(ctx, { [path]: "one\ntwo" });
			const noNewline = (await tool("read_file").handler({ targets: ["web-1"], path }, bare.ctx)) as {
				stdout: string;
			};
			expect(noNewline.stdout).toBe("one\ntwo");
		} finally {
			await db.destroy();
		}
	});

	it("reports the end of the file and its line count only when the page reaches it", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "read-eof-user");
			const path = "/var/log/short.log";
			const read = await readContext(ctx, { [path]: `${Array.from({ length: 2_500 }, () => "x").join("\n")}\n` });
			const first = (await tool("read_file").handler({ targets: ["web-1"], path }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
				total?: number;
				truncated?: { note: string };
			};
			expect(first.lines).toEqual({ from: 1, to: 2_000 });
			expect(first.stdout).toBe("x\n".repeat(2_000));
			expect(first.total).toBeUndefined();
			expect(first.truncated).toEqual({ note: "Use offset=2001 to continue." });
			const second = (await tool("read_file").handler({ targets: ["web-1"], path, offset: 2_001 }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
				total?: number;
				truncated?: { note: string };
			};
			expect(second.lines).toEqual({ from: 2_001, to: 2_500 });
			expect(second.stdout).toBe("x\n".repeat(500));
			expect(second.total).toBe(2_500);
			expect(second.truncated).toBeUndefined();
		} finally {
			await db.destroy();
		}
	});

	it("stops a page at 50KB with whole lines and continues at the next line", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "read-big-user");
			const lines = Array.from({ length: 200 }, (_, i) => `${String(i + 1).padStart(4, "0")} ${"x".repeat(1_000)}`);
			const read = await readContext(ctx, { "/var/log/big.log": `${lines.join("\n")}\n` });
			const page = (await tool("read_file").handler({ targets: ["web-1"], path: "/var/log/big.log" }, read.ctx)) as {
				stdout: string;
				lines: { from: number; to: number };
				total?: number;
				truncated?: { note: string };
			};
			expect(Buffer.byteLength(page.stdout)).toBe(50 * 1_006);
			expect(page.stdout.endsWith("\n")).toBe(true);
			expect(page.stdout.startsWith("0001 ")).toBe(true);
			expect(page.lines).toEqual({ from: 1, to: 50 });
			expect(page.total).toBeUndefined();
			expect(page.truncated).toEqual({ note: "Use offset=51 to continue." });
		} finally {
			await db.destroy();
		}
	});

	it("shows nothing and says so when the file is empty, and refuses a line past its end", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "read-empty-user");
			const path = "/var/log/empty.log";
			const empty = await readContext(ctx, { [path]: "" });
			const nothing = (await tool("read_file").handler({ targets: ["web-1"], path }, empty.ctx)) as {
				stdout: string;
				note?: string;
			};
			expect(nothing.stdout).toBe("");
			expect(nothing.note).toBe("the file is empty");

			const tiny = await readContext(ctx, { [path]: "one\ntwo\n" });
			await expect(tool("read_file").handler({ targets: ["web-1"], path, offset: 5 }, tiny.ctx)).rejects.toThrow(
				"the file /var/log/empty.log has 2 lines; line 5 is past its end",
			);
		} finally {
			await db.destroy();
		}
	});

	it("refuses a line that alone is longer than a page, and points at exec", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "read-long-user");
			const path = "/var/log/long.log";
			const read = await readContext(ctx, { [path]: `${"x".repeat(50 * 1024)}\n` });
			await expect(tool("read_file").handler({ targets: ["web-1"], path }, read.ctx)).rejects.toThrow(
				/line 1 alone is longer than the 50 KB a page keeps; read it with exec.*sed -n '1p'/,
			);
		} finally {
			await db.destroy();
		}
	});

	it("reads the same file on several nodes: each node keeps its own head and cursor", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { user, nodeId, ctx: baseCtx } = await seedToolContext(db, "read-group-user");
			const secondId = await addNode(db, user.userId, "web-2");
			const path = "/var/log/app.log";
			// The second node's page is cut by the batch budget (144 bytes), the first fits.
			const first = "one\ntwo\n";
			const second = "alpha\nbeta\ngamma\ndelta\n";
			let n = 0;
			const cluster = {
				createTask: async (input: { spec: TaskSpec; nodeId: string }) => {
					const spec = input.spec as Extract<TaskSpec, { kind: "file.read" }>;
					const content = input.nodeId === nodeId ? first : second;
					const { page, result } = pageOf(content, spec.startLine, spec.lineCount);
					const id = `g-${++n}`;
					return task({
						id,
						nodeId: input.nodeId,
						kind: "file.read",
						stdoutBytes: Buffer.byteLength(page),
						stdoutHead: input.nodeId === nodeId ? page : page.slice(0, 12),
						result,
						outputMode: "head",
					});
				},
				waitTask: async () => undefined,
			} as unknown as Cluster;
			const groupTasks: TaskView[] = [];
			const groups = {
				create: async (input: { nodeIds: string[]; spec: TaskSpec }) => {
					for (const id of input.nodeIds) {
						groupTasks.push(
							await cluster.createTask({
								spec: input.spec,
								nodeId: id,
							} as Parameters<typeof cluster.createTask>[0]),
						);
					}
					return "g1";
				},
				get: async () => groupView(),
				wait: async () => groupView(),
			} as unknown as TaskGroups;
			const groupView = () => ({
				id: "g1",
				state: "finished" as const,
				targets: [],
				nodeIds: [nodeId, secondId],
				parallel: 10,
				failFast: false,
				outputMode: "head" as const,
				privileged: false,
				skipped: [],
				tasks: groupTasks,
				createdAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:00.000Z",
				summary: path,
				kind: "file.read",
				ruleChain: null,
				approval: null,
				actorType: "user",
				actorId: user.userId,
				onBehalfOfUserId: user.userId,
				operation: null,
				rootSessionId: null,
				handlerType: null,
				handlerSessionId: null,
			});
			const ctx = { ...baseCtx, cluster, groups } as ToolContext;
			const result = (await tool("read_file").handler({ targets: ["web-1", "web-2"], path }, ctx)) as {
				nodes: { node: string; stdout: string; lines: { from: number; to: number }; truncated?: { note: string } }[];
			};
			expect(result.nodes.map((n) => n.node)).toEqual(["web-1", "web-2"]);
			expect(result.nodes[0]).toMatchObject({ stdout: "one\ntwo\n", lines: { from: 1, to: 2 } });
			// The second node's head stops inside "gamma": only whole lines are shown, and the cursor is its own.
			expect(result.nodes[1]).toMatchObject({
				stdout: "alpha\nbeta\n",
				lines: { from: 1, to: 2 },
				truncated: { note: "Use offset=3 to continue." },
			});
		} finally {
			await db.destroy();
		}
	});
});

describe("tool task scope", () => {
	it("acts only on its own session, its subtree and its own token's tasks", async () => {
		const db = await openTestDb("sqlite");
		try {
			const user = await createUser(db, { username: "scope-user", kind: "member" });
			const other = await createUser(db, { username: "scope-other", kind: "member" });
			const orgId = await defaultOrgId(db);
			const now = new Date().toISOString();
			const sessionRow = (id: string, parent: string | null) => ({
				id,
				org_id: orgId,
				owner_user_id: user.id,
				conversation_id: `conv-${id}`,
				parent_session_id: parent,
				root_session_id: parent ?? id,
				title: id,
				model: JSON.stringify({ provider: "faux", modelId: "faux" }),
				status: "active" as const,
				created_at: now,
				updated_at: now,
				state: "idle" as const,
			});
			const parentSession = newId();
			const childSession = newId();
			const siblingSession = newId();
			await db
				.insertInto("sessions")
				.values([
					sessionRow(parentSession, null),
					sessionRow(childSession, parentSession),
					sessionRow(siblingSession, null),
				])
				.execute();

			const tasks = new Map<string, TaskView>();
			tasks.set("own", task({ id: "own", actorType: "session", actorId: parentSession, onBehalfOfUserId: user.id }));
			tasks.set(
				"child",
				task({ id: "child", actorType: "subagent", actorId: childSession, onBehalfOfUserId: user.id }),
			);
			tasks.set(
				"sibling",
				task({ id: "sibling", actorType: "session", actorId: siblingSession, onBehalfOfUserId: user.id }),
			);
			tasks.set("token", task({ id: "token", actorType: "api_token", actorId: "tok-1", onBehalfOfUserId: user.id }));
			tasks.set(
				"foreign",
				task({ id: "foreign", actorType: "session", actorId: parentSession, onBehalfOfUserId: other.id }),
			);
			const cluster = {
				getTask: async (id: string) => tasks.get(id),
				waitTask: async (id: string) => tasks.get(id),
				cancelTask: async () => true,
			} as unknown as Cluster;
			const base = {
				db,
				cluster,
				groups: {} as TaskGroups,
				user: { sessionId: "s", userId: user.id, username: user.username, kind: "member" as const },
				chain: [],
				approvalUrl: (kind: string, id: string) => `http://crh.test/approvals/${kind}/${id}`,
			};
			const sessionCtx = {
				...base,
				actor: { type: "session", id: parentSession, onBehalfOfUserId: user.id },
			} as unknown as ToolContext;
			const tokenCtx = {
				...base,
				actor: { type: "api_token", id: "tok-1", onBehalfOfUserId: user.id },
			} as unknown as ToolContext;

			const wait = (ctx: ToolContext, id: string) => tool("task_wait").handler({ task_id: id }, ctx);
			const cancel = (ctx: ToolContext, id: string) => tool("task_cancel").handler({ task_id: id }, ctx);
			await expect(wait(sessionCtx, "own")).resolves.toMatchObject({ task_id: "own" });
			await expect(wait(sessionCtx, "child")).resolves.toMatchObject({ task_id: "child" });
			await expect(cancel(sessionCtx, "child")).resolves.toMatchObject({ task_id: "child" });
			// Another session of the same user, another user's task, and a token's task are out of reach.
			await expect(wait(sessionCtx, "sibling")).rejects.toThrow(/no such task/);
			await expect(cancel(sessionCtx, "sibling")).rejects.toThrow(/no such task/);
			await expect(wait(sessionCtx, "foreign")).rejects.toThrow(/no such task/);
			await expect(wait(sessionCtx, "token")).rejects.toThrow(/no such task/);
			// The token reaches its own tasks only.
			await expect(wait(tokenCtx, "token")).resolves.toMatchObject({ task_id: "token" });
			await expect(wait(tokenCtx, "own")).rejects.toThrow(/no such task/);
		} finally {
			await db.destroy();
		}
	});
});

describe("file tool results", () => {
	/** A tool context whose cluster serves the given task for every call. */
	function serving(ctx: ToolContext, t: TaskView): ToolContext {
		const cluster = { createTask: async () => t, waitTask: async () => t } as unknown as Cluster;
		return { ...ctx, cluster } as ToolContext;
	}

	it("list_dir returns the entries of the task's result, not JSON on stdout", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "list-result-user");
			const t = task({
				kind: "file.list",
				result: {
					kind: "file.list",
					truncated: true,
					entries: [
						{ name: "a.txt", type: "file", size: 3, mode: "0644", mtime: "2026-01-01T00:00:00Z" },
						{ name: "sub", type: "dir", size: 0, mode: "0755", mtime: "2026-01-01T00:00:00Z" },
					],
				},
			});
			const out = (await tool("list_dir").handler({ targets: ["web-1"], path: "/tmp" }, serving(ctx, t))) as Record<
				string,
				unknown
			>;
			expect(out.entries).toEqual(t.result?.kind === "file.list" ? t.result.entries : []);
			expect(out.truncated).toBe(true);
			expect(out.stdout).toBe("");
		} finally {
			await db.destroy();
		}
	});

	it("write_file and edit_file report what they changed", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { ctx } = await seedToolContext(db, "write-result-user");
			const written = task({ kind: "file.write", result: { kind: "file.write", bytes: 9, created: true } });
			const writeOut = (await tool("write_file").handler(
				{ targets: ["web-1"], path: "/tmp/x", content: "something" },
				serving(ctx, written),
			)) as Record<string, unknown>;
			expect(writeOut).toMatchObject({ bytes: 9, created: true });

			const edited = task({ kind: "file.edit", result: { kind: "file.edit", replacements: 2 } });
			const editOut = (await tool("edit_file").handler(
				{ node: "web-1", path: "/tmp/x", edits: [{ oldText: "a", newText: "b" }] },
				serving(ctx, edited),
			)) as Record<string, unknown>;
			expect(editOut).toMatchObject({ replacements: 2 });
		} finally {
			await db.destroy();
		}
	});

	it("task_wait on a file.read task shows its page and line range", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { user, ctx } = await seedToolContext(db, "wait-result-user");
			const t = task({
				id: "read-1",
				kind: "file.read",
				// The task belongs to the tool context's actor (doc/agent-runtime.md#cluster-工具).
				actorType: ctx.actor.type,
				actorId: ctx.actor.id,
				onBehalfOfUserId: user.userId,
				stdoutBytes: 8,
				stdoutHead: "one\ntwo\n",
				result: { kind: "file.read", from: 1, to: 2, eof: true, total: 2, tooLong: false },
			});
			const cluster = {
				getTask: async () => t,
				waitTask: async () => t,
			} as unknown as Cluster;
			const out = (await tool("task_wait").handler({ task_id: t.id }, { ...ctx, cluster })) as Record<string, unknown>;
			expect(out).toMatchObject({ stdout: "one\ntwo\n", lines: { from: 1, to: 2 }, total: 2 });
		} finally {
			await db.destroy();
		}
	});

	it("a list_dir group shows each node's entries", async () => {
		const db = await openTestDb("sqlite");
		try {
			const { user, nodeId, ctx } = await seedToolContext(db, "list-group-user");
			const secondId = await addNode(db, user.userId, "web-2");
			const tasks: TaskView[] = [
				task({
					id: "l-1",
					nodeId,
					kind: "file.list",
					outputMode: "head",
					result: {
						kind: "file.list",
						truncated: false,
						entries: [{ name: "a", type: "file", size: 1, mode: "0644", mtime: "2026-01-01T00:00:00Z" }],
					},
				}),
				task({
					id: "l-2",
					nodeId: secondId,
					kind: "file.list",
					outputMode: "head",
					result: {
						kind: "file.list",
						truncated: false,
						entries: [{ name: "b", type: "dir", size: 0, mode: "0755", mtime: "2026-01-01T00:00:00Z" }],
					},
				}),
			];
			const group = (): TaskGroupView => ({
				id: "g-list",
				state: "finished",
				targets: [],
				nodeIds: [nodeId, secondId],
				parallel: 10,
				failFast: false,
				outputMode: "head",
				privileged: false,
				skipped: [],
				tasks,
				createdAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:00.000Z",
				summary: "/tmp",
				kind: "file.list",
				ruleChain: null,
				approval: null,
				actorType: "user",
				actorId: user.userId,
				onBehalfOfUserId: user.userId,
				operation: null,
				rootSessionId: null,
				handlerType: null,
				handlerSessionId: null,
			});
			const groups = {
				create: async () => "g-list",
				get: async () => group(),
				wait: async () => group(),
			} as unknown as TaskGroups;
			const out = (await tool("list_dir").handler({ targets: ["web-1", "web-2"], path: "/tmp" }, {
				...ctx,
				groups,
			} as ToolContext)) as { nodes: Record<string, unknown>[] };
			expect(out.nodes.map((n) => n.node)).toEqual(["web-1", "web-2"]);
			expect(out.nodes[0]).toMatchObject({ entries: [{ name: "a" }], truncated: false });
			expect(out.nodes[1]).toMatchObject({ entries: [{ name: "b" }], truncated: false });
		} finally {
			await db.destroy();
		}
	});
});
