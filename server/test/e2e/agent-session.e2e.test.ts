import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelConfig } from "../../src/agent/models.ts";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import type { SessionUser } from "../../src/auth/sessions.ts";
import { TaskGroups } from "../../src/cluster/task-groups.ts";
import { waitSubmission } from "../helpers/runtime.ts";
import { buildCrha, Env, goAvailable, waitFor } from "./harness.ts";

const hasGo = await goAvailable();

// The M3 core: a session drives a real node through the cluster tools, waits through approvals, and survives a
// crhs restart in the middle of a tool call (doc/design/testing/server.md "Agent runtime tests", fault injection).
describe.skipIf(!hasGo)("agent sessions against a real crha", () => {
	let tmp = "";
	let env: Env;
	let nodeName = "";
	let owner: SessionUser;
	const faux = fauxProvider();
	const model = { provider: faux.provider.id, modelId: faux.getModel().id };

	const open = async () => {
		const models = new ModelConfig(env.crhs.db, env.crhs.masterKey);
		models.addProvider(faux.provider);
		await models.reload();
		const storage = await openNodeSqliteStorage(join(tmp, "durable.sqlite"), { prefix: "pi_" });
		return AgentRuntime.open({
			db: env.crhs.db,
			storage,
			models,
			cluster: env.crhs.cluster,
			taskGroups: new TaskGroups(env.crhs.db, env.crhs.cluster),
			audit: env.crhs.audit,
		});
	};

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-agent-"));
		env = await Env.create(await buildCrha(tmp), tmp);
		await env.bringUp();
		nodeName = (await env.crhs.api(`/api/nodes/${env.nodeId}`)).json.node.name;
		const me = (await env.crhs.api("/api/me")).json.user;
		owner = { userId: me.id, username: me.username, kind: me.kind, sessionId: "test" };
	}, 180_000);

	afterAll(async () => {
		await env?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	it("runs a command under yolo and answers with the result", async () => {
		const runtime = await open();
		try {
			const session = await runtime.createSession(owner, { model, rulePreset: "yolo", title: "t1" });
			let seen = "";
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("exec", { targets: [nodeName], cmd: "echo from-agent" }, { id: "c1" })], {
					stopReason: "toolUse",
				}),
				(context) => {
					// The tool result the model sees is the JSON from the cluster tool.
					const last = context.messages.at(-1) as { content: { type: string; text: string }[] };
					seen = last.content[0]?.text ?? "";
					return fauxAssistantMessage([fauxText("done")]);
				},
			]);
			const sub = await runtime.submit(session.id, owner, "say hi on the node", "r1");
			expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "done" });
			// The tool result the model sees is text: the command's output, then the note block.
			expect(seen).toBe("from-agent\n");
		} finally {
			await runtime.close();
		}
	});

	it("waits through an approval under ask", async () => {
		const runtime = await open();
		try {
			const session = await runtime.createSession(owner, { model, rulePreset: "ask" });
			let seen = "";
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("exec", { targets: [nodeName], argv: ["echo", "approved"] }, { id: "c1" })],
					{
						stopReason: "toolUse",
					},
				),
				(context) => {
					seen = (context.messages.at(-1) as { content: { text: string }[] }).content[0]?.text ?? "";
					return fauxAssistantMessage([fauxText("ok")]);
				},
			]);
			const sub = await runtime.submit(session.id, owner, "run it", "r1");
			const waiting = await waitFor("a waiting task", async () => {
				const { tasks } = (await env.crhs.api("/api/approvals")).json;
				return tasks.find((t: { actorId: string }) => t.actorId === session.id);
			});
			expect(waiting).toMatchObject({ actorType: "session", ruleChain: [{ type: "session", id: session.id }] });
			const res = await env.crhs.api(`/api/tasks/${waiting.id}/approval`, { body: { decision: "approve" } });
			expect(res.status).toBe(200);
			expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "ok" });
			expect(seen).toBe("approved\n");
		} finally {
			await runtime.close();
		}
	});

	it("reopens the Harness after a storage failure and carries on", async () => {
		let failNext = false;
		// The official SQLite storage, with one commit made to fail on demand.
		const storage = async () => {
			const real = await openNodeSqliteStorage(join(tmp, "durable.sqlite"), { prefix: "pi_" });
			return new Proxy(real, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") return value;
					if (prop !== "commit") return value.bind(target);
					return (...args: unknown[]) => {
						if (failNext) {
							failNext = false;
							return Promise.reject(new Error("injected storage failure"));
						}
						return value.apply(target, args);
					};
				},
			});
		};
		const models = new ModelConfig(env.crhs.db, env.crhs.masterKey);
		models.addProvider(faux.provider);
		await models.reload();
		const runtime = await AgentRuntime.open({
			db: env.crhs.db,
			storage,
			models,
			cluster: env.crhs.cluster,
			taskGroups: new TaskGroups(env.crhs.db, env.crhs.cluster),
		});
		try {
			const session = await runtime.createSession(owner, { model, rulePreset: "yolo" });
			failNext = true;
			await expect(runtime.submit(session.id, owner, "boom", "r1")).rejects.toThrow();
			await waitFor("the Harness reopened", () => runtime.reopened === 1, 15_000);
			faux.setResponses([fauxAssistantMessage([fauxText("recovered")])]);
			const sub = await runtime.submit(session.id, owner, "again", "r2");
			expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "recovered" });
		} finally {
			await runtime.close();
		}
	});

	describe("auto review", () => {
		it("lets the reviewer approve a safe command, and leaves a risky one for the user", async () => {
			const runtime = await open();
			try {
				const session = await runtime.createSession(owner, { model, rulePreset: "auto_review" });
				const prompts: string[] = [];
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("exec", { targets: [nodeName], argv: ["uptime"] }, { id: "c1" })], {
						stopReason: "toolUse",
					}),
					// the reviewer, which sees only the operation
					(context) => {
						prompts.push(JSON.stringify(context.messages));
						return fauxAssistantMessage([fauxToolCall("submit_review", { decision: "approve", reason: "read-only" })]);
					},
					fauxAssistantMessage(
						[fauxToolCall("exec", { targets: [nodeName], argv: ["rm", "-rf", "/tmp/x"] }, { id: "c2" })],
						{
							stopReason: "toolUse",
						},
					),
					fauxAssistantMessage([fauxToolCall("submit_review", { decision: "escalate", reason: "deletes files" })]),
					fauxAssistantMessage([fauxText("all done")]),
				]);
				const sub = await runtime.submit(session.id, owner, "check and clean", "r1");
				const waiting = await waitFor("the risky task waiting with a review", async () => {
					const { tasks } = (await env.crhs.api("/api/approvals")).json;
					const t = tasks.find((x: { actorId: string }) => x.actorId === session.id);
					return t?.approval?.review ? t : undefined;
				});
				expect(waiting.approval.review).toMatchObject({ decision: "escalate", reason: "deletes files" });
				expect(waiting.operation).toEqual({ method: "exec", target: "rm -rf /tmp/x" });
				// The first one was approved by the reviewer, without the user.
				const first = await env.crhs.db
					.selectFrom("tasks")
					.selectAll()
					.where("actor_id", "=", session.id)
					.where("id", "!=", waiting.id)
					.executeTakeFirstOrThrow();
				expect(first.state).toBe("exited");
				expect(JSON.parse(first.approval ?? "{}").decision).toMatchObject({ by: { id: "auto-review" } });
				// The reviewer saw the operation only, not the conversation.
				expect(prompts[0]).toContain("uptime");
				expect(prompts[0]).not.toContain("check and clean");
				await env.crhs.api(`/api/tasks/${waiting.id}/approval`, { body: { decision: "approve" } });
				expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "all done" });
			} finally {
				await runtime.close();
			}
		});
	});

	describe("subagents", () => {
		const lastText = (context: { messages: { role: string; content: unknown }[] }) => {
			const m = context.messages.at(-1) as { content: { type: string; text?: string }[] | string };
			return typeof m.content === "string" ? m.content : (m.content[0]?.text ?? "");
		};

		it("runs a child session whose rules can only tighten the parent's", async () => {
			const runtime = await open();
			try {
				const session = await runtime.createSession(owner, { model, rulePreset: "yolo" });
				let childSaw = "";
				let parentSaw = "";
				faux.setResponses([
					// parent: delegate with a read-only rule set
					fauxAssistantMessage(
						[
							fauxToolCall(
								"subagent",
								{
									task: "check the node",
									rules: { default: "deny", rules: [{ action: "allow", method: "file.read" }] },
								},
								{ id: "p1" },
							),
						],
						{ stopReason: "toolUse" },
					),
					// child: tries a command, which its own rules deny although the parent is yolo
					fauxAssistantMessage([fauxToolCall("exec", { targets: [nodeName], cmd: "echo child" }, { id: "k1" })], {
						stopReason: "toolUse",
					}),
					(context) => {
						childSaw = lastText(context);
						return fauxAssistantMessage([fauxText("child: denied")]);
					},
					(context) => {
						parentSaw = lastText(context);
						return fauxAssistantMessage([fauxText("parent done")]);
					},
				]);
				const sub = await runtime.submit(session.id, owner, "delegate", "r1");
				expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "parent done" });
				// The exec result the model sees is text; a task denied by the rules renders as a note.
				expect(childSaw).toContain(`[${nodeName}, error policy_denied: denied by the authorization rules]`);
				expect(parentSaw).toBe("child: denied");
				const child = await env.crhs.db
					.selectFrom("sessions")
					.selectAll()
					.where("parent_session_id", "=", session.id)
					.executeTakeFirstOrThrow();
				const task = await env.crhs.db
					.selectFrom("tasks")
					.selectAll()
					.where("actor_id", "=", child.id)
					.executeTakeFirstOrThrow();
				expect(task).toMatchObject({ actor_type: "subagent", state: "denied" });
				expect(JSON.parse(task.rule_chain ?? "[]")).toEqual([
					{ type: "session", id: session.id },
					{ type: "session", id: child.id },
				]);
			} finally {
				await runtime.close();
			}
		});

		it("pauses a child whose quota runs out and lets the parent grant more", async () => {
			const runtime = await open();
			try {
				const session = await runtime.createSession(owner, { model, rulePreset: "yolo" });
				let n = 0;
				// Context-driven: the child and the parent consume responses in an order the test does not control.
				const next = (context: { messages: { role: string; content: unknown }[] }) => {
					const text = lastText(context);
					const all = context.messages
						.map((m) =>
							typeof m.content === "string"
								? m.content
								: ((m.content as { text?: string }[]).map((c) => c.text ?? "").join("") ?? ""),
						)
						.join("\n");
					const childId = /subagent_wait\("([0-9a-f-]{36})"\)/.exec(all)?.[1];
					if (text.includes("waiting for your decision")) {
						// The request is the JSON entry of the delimited <subagent-requests> block.
						const requestId = /"kind":"quota","id":"([0-9a-f-]{36})"/.exec(text)?.[1];
						return fauxAssistantMessage(
							[
								fauxToolCall(
									"subagent_decide",
									{ request_id: requestId ?? "", decision: "approve", tokens: 1_000_000 },
									{ id: `d${++n}` },
								),
							],
							{ stopReason: "toolUse" },
						);
					}
					if (text.includes("was granted")) {
						return fauxAssistantMessage([fauxToolCall("subagent_wait", { id: childId ?? "" }, { id: `w${++n}` })], {
							stopReason: "toolUse",
						});
					}
					if (text.includes("child-ran")) return fauxAssistantMessage([fauxText("child done")]);
					if (text.includes("child done")) return fauxAssistantMessage([fauxText("all done")]);
					return fauxAssistantMessage([fauxText("unexpected")]);
				};
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("subagent", { task: "run it", quota: 1 }, { id: "s1" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage([fauxToolCall("exec", { targets: [nodeName], cmd: "echo child-ran" }, { id: "e1" })], {
						stopReason: "toolUse",
					}),
					next,
					next,
					next,
					next,
					next,
				]);
				const sub = await runtime.submit(session.id, owner, "delegate", "q1");
				expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "all done" });
				const children = await env.crhs.db
					.selectFrom("sessions")
					.selectAll()
					.where("parent_session_id", "=", session.id)
					.execute();
				expect(children).toHaveLength(1);
				expect(children[0]?.quota_tokens).toBeGreaterThan(0);
			} finally {
				await runtime.close();
			}
		});

		it("sends a child's approval to the user", async () => {
			const runtime = await open();
			try {
				const session = await runtime.createSession(owner, { model, rulePreset: "ask" });
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("subagent", { task: "say hi" }, { id: "p1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage(
						[fauxToolCall("exec", { targets: [nodeName], argv: ["echo", "from-child"] }, { id: "k1" })],
						{
							stopReason: "toolUse",
						},
					),
					fauxAssistantMessage([fauxText("child ok")]),
					fauxAssistantMessage([fauxText("parent ok")]),
				]);
				const sub = await runtime.submit(session.id, owner, "delegate", "r1");
				const waiting = await waitFor("the child's task waiting", async () => {
					const { tasks } = (await env.crhs.api("/api/approvals")).json;
					return tasks.find((t: { actorType: string }) => t.actorType === "subagent");
				});
				expect(waiting.ruleChain[0]).toEqual({ type: "session", id: session.id });
				await env.crhs.api(`/api/tasks/${waiting.id}/approval`, { body: { decision: "approve" } });
				expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "parent ok" });
			} finally {
				await runtime.close();
			}
		});
	});

	it("reattaches to the same Cluster task after crhs restarts mid-call", async () => {
		let runtime = await open();
		const session = await runtime.createSession(owner, { model, rulePreset: "yolo" });
		let seen = "";
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: [nodeName], cmd: "sleep 2; echo survived" }, { id: "c1" })],
				{
					stopReason: "toolUse",
				},
			),
			(context) => {
				seen = (context.messages.at(-1) as { content: { text: string }[] }).content[0]?.text ?? "";
				return fauxAssistantMessage([fauxText("after restart")]);
			},
		]);
		const sub = await runtime.submit(session.id, owner, "slow one", "r1");
		const running = await waitFor("the task running", async () => {
			const rows = await env.crhs.db
				.selectFrom("tasks")
				.select(["id", "state"])
				.where("actor_id", "=", session.id)
				.execute();
			return rows.find((r) => r.state === "running");
		});
		// The process "dies": the Harness closes mid-call; a new one opens the same storage.
		await runtime.close();
		runtime = await open();
		try {
			expect(await waitSubmission(runtime, session.id, sub)).toEqual({ status: "done", answer: "after restart" });
			expect(seen).toBe("survived\n");
			const tasks = await env.crhs.db.selectFrom("tasks").select("id").where("actor_id", "=", session.id).execute();
			expect(tasks.map((t) => t.id)).toEqual([running.id]);
		} finally {
			await runtime.close();
		}
	});
});
