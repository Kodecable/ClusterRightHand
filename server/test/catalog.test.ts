import { describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { Cluster, TaskView } from "../src/cluster/cluster.ts";
import type { TaskGroups } from "../src/cluster/task-groups.ts";
import { TOOLS, type ToolContext, taskResult } from "../src/tools/catalog.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

const ctx = {
	approvalUrl: (kind: string, id: string) => `http://crh.test/#/approvals/${kind}/${id}`,
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
});
