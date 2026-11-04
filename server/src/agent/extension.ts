import {
	CompactionTask,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	hook,
	section,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import * as z from "zod/v4";
import type { Actor } from "../cluster/cluster.ts";
import { parseRuleSetForWrite } from "../policy/refs.ts";
import type { RuleRef } from "../policy/store.ts";
import { callTool } from "../tools/adapter.ts";
import { TOOLS, type ToolContext } from "../tools/catalog.ts";
import { UserError } from "../users/service.ts";
import { chargeCall, exhaustedLevel, parseQuota, setContextTokens } from "./quota.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { AgentRequestView, AgentRuntimeOptions } from "./runtime-core.ts";
import { sessionAncestors } from "./session-chain.ts";
import { callTokens, estimateRequestTokens, RequestEstimates } from "./tokens.ts";

/**
 * The Harness extension (doc/agent-runtime.md#cluster-工具): the cluster tools as durable tools, the subagent
 * tools, the follow-up that reminds a parent of its subagent requests, output-token metering, and the system
 * prompt. A tool call runs through runtime-requests/state/quota, so a quota-paused call and a subagent request
 * behave exactly as the runtime documents.
 */

const SYSTEM_PROMPT = `You are ClusterRightHand, an assistant that operates the user's servers ("nodes") through the cluster tools.

- Start with list_nodes or node_info when you do not know the nodes yet.
- Prefer reading (read_file, list_dir) before changing anything; explain what you are about to change.
- Commands and file changes may wait for the user's approval; a rejected task comes back with the user's reason. Respect it and do not try to get around it.
- exec cmd runs in the node's POSIX sh (sh -c); for bash syntax use argv ["bash", "-c", …] after checking node_info facts.shells.bash.
- exec returns the end of long outputs and, when truncated, the path of the full output on the node; read it with read_file when needed.
- A task can end "unknown": its outcome could not be confirmed. Check the node's state before retrying.
- Delegate self-contained work to subagent; settle a subagent's requests with subagent_decide, and fetch a background subagent's answer with subagent_wait.
- Be concise.`;

// ---- the cluster tools as durable tools ----

/** Session-side context of a tool call: whose session it is and which rule chain applies. */
async function toolContextFor(
	options: AgentRuntimeOptions,
	conversationId: string,
): Promise<Omit<ToolContext, "callKey" | "signal" | "onStatus">> {
	const { db } = options;
	const session = await db
		.selectFrom("sessions")
		.selectAll()
		.where("conversation_id", "=", conversationId)
		.executeTakeFirst();
	if (!session) throw new Error("this conversation is not a ClusterRightHand session");
	const owner = await db
		.selectFrom("users")
		.select(["id", "username", "kind", "status"])
		.where("id", "=", session.owner_user_id)
		.executeTakeFirst();
	if (owner?.status !== "active") throw new UserError("the session's owner is disabled");
	// The chain from the root session down to this one.
	const chain: RuleRef[] = [];
	let top = session;
	for await (const row of sessionAncestors(db, session.id)) {
		chain.unshift({ type: "session", id: row.id });
		top = row;
	}
	// A scheduled run's root session sits below its schedule (doc/scheduling.md#授权规则与配额).
	if (top.schedule_id) chain.unshift({ type: "schedule", id: top.schedule_id });
	const actor: Actor = {
		type: session.parent_session_id ? "subagent" : "session",
		id: session.id,
		onBehalfOfUserId: owner.id,
	};
	return {
		db,
		cluster: options.cluster,
		taskGroups: options.taskGroups,
		user: { userId: owner.id, username: owner.username, kind: owner.kind, sessionId: `session:${session.id}` },
		actor,
		chain,
		approvalUrl: (kind, id) => `/approvals/${kind === "task" ? "tasks" : "task-groups"}/${id}`,
		taskUrl: (id) => `/tasks/${id}`,
		taskGroupUrl: (id) => `/task-groups/${id}`,
		defaultWaitS: 600,
		waitThroughApproval: true,
	};
}

export function clusterExtension(options: AgentRuntimeOptions, runtimeRef: { current?: AgentRuntime }): Extension {
	// The input estimate of each conversation's current request, from `beforeRequest` for its `afterResponse`
	// (D101: the request's serialized messages are the generation basis for input tokens the upstream does not
	// report; durable's hook sees no system prompt or tool declarations).
	const requestInput = new RequestEstimates();
	const requestJson = (r: AgentRequestView) => ({
		kind: r.kind,
		id: r.id,
		session_id: r.sessionId,
		summary: r.summary,
		node_id: r.nodeId,
		created_at: r.createdAt,
	});
	const sessionOf = async (conversationId: unknown) =>
		(
			await options.db
				.selectFrom("sessions")
				.select("id")
				.where("conversation_id", "=", String(conversationId))
				.executeTakeFirst()
		)?.id;
	const hooks = [
		hook(ToolTask, {
			// Every tool result reminds the parent of subagent requests it must settle (doc/agent-runtime.md#处理子会话的请求).
			afterTool: async (call, result, api) => {
				if (call.parent) return undefined;
				const runtime = runtimeRef.current;
				if (!runtime) return undefined;
				const session = await runtime.sessionAt(String(api.conversationId));
				if (!session || !(await runtime.hasSubagents(session.id))) return undefined;
				const pending = await runtime.pendingAgentRequests(session.id);
				if (pending.length === 0) return undefined;
				const lines = pending.map((r) => `${r.kind} ${r.id}: ${r.summary}`);
				const hint =
					`\n\nSubagent requests waiting for your decision:\n- ${lines.join("\n- ")}\n` +
					'Call subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?).';
				return { ...result, output: [...(result.output ?? []), { type: "text", text: hint }] };
			},
		}),
		hook(GenerationTask, {
			// The serialized messages are the input basis when the upstream reports no usage (D101). durable's
			// `beforeRequest` exposes only those; the system prompt and tool declarations are not part of it.
			beforeRequest: async (request, api) => {
				requestInput.set(String(api.conversationId), estimateRequestTokens(request.messages));
				return undefined;
			},
			// The budget measure counts the output at every level; a level whose quota is not above zero stops its
			// whole subtree (doc/agent-runtime.md#配额). The usage measure and the context fill are D101.
			afterResponse: async (message, api) => {
				const conversationId = String(api.conversationId);
				// Take the estimate now: it belongs to this one request, whether or not the response can be charged.
				const estimatedInput = requestInput.take(conversationId);
				const sessionId = await sessionOf(conversationId);
				if (!sessionId) return;
				const runtime = runtimeRef.current;
				// The provider document is written for this request; remember it for metering a later compaction.
				if (runtime) await runtime.rememberProviderSession(conversationId);
				const tokens = callTokens(message, estimatedInput);
				await chargeCall(options.db, sessionId, tokens);
				// The context fill is the session's own last main-agent call, never a compaction or review (D101).
				await setContextTokens(options.db, sessionId, tokens.context);
				const over = await exhaustedLevel(options.db, sessionId);
				// The WebUI reads the counters from GET /sessions/:id; the tree's list row makes it refetch.
				runtime?.sessionList.publishSession(sessionId);
				// The tool calls of this response end the run (below); a response without them ends it anyway.
				if (over) {
					void options.audit?.record({
						actor: { type: "system", id: "quota" },
						action: "session.quota_exhausted",
						target: { type: "session", id: over },
					});
				}
			},
		}),
		hook(CompactionTask, {
			// Durable's summarizer runs through the metered Models; remember the session its provider id belongs to.
			beforeCompact: async (_compaction, api) => {
				await runtimeRef.current?.rememberProviderSession(String(api.conversationId));
				return undefined;
			},
		}),
	];
	const tools = TOOLS.map((tool) =>
		defineTool({
			name: tool.name,
			description: tool.description,
			parameters: Type.Unsafe(z.toJSONSchema(tool.input, { target: "draft-7" }) as Record<string, unknown>),
			// Every call is idempotent: tasks get ids derived from the durable task id, so a rerun after a restart
			// reattaches to the Cluster task its first run started (doc/agent-runtime.md#exec-工具的语义).
			replay: "safe",
			execute: async (args, api, context) => {
				const base = await toolContextFor(options, String(api.conversationId));
				// Quota at or below zero: pause this call and ask an ancestor's agent, or the owner, for more
				// (doc/agent-runtime.md#配额). A denial ends the run without another model request.
				if (await exhaustedLevel(options.db, base.actor.id)) {
					const outcome = runtimeRef.current ? await runtimeRef.current.waitForQuota(base.actor.id, context) : "denied";
					if (outcome === "denied") {
						return {
							output: [
								{
									type: "text",
									text: "The token quota is used up and no more was granted; nothing was run and the run ends here.",
								},
							],
							control: { terminate: true },
						};
					}
				}
				const ctx: ToolContext = {
					...base,
					callKey: String(api.taskId),
					...(context.abortSignal ? { signal: context.abortSignal } : {}),
					onStatus: (status) => api.details(status as never, context),
				};
				const call = await callTool(tool, args, ctx, {
					via: "session",
					...(options.audit ? { audit: options.audit } : {}),
				});
				if (!call.ok) throw new Error(call.error);
				return { output: [{ type: "text", text: JSON.stringify(call.result, null, 2) }] };
			},
		}),
	);
	const subagent: ToolRegistration = defineTool({
		name: "subagent",
		description:
			"Delegate a self-contained task to a subagent: a separate session with the same tools that answers back. " +
			"Give it rules to narrow what it may do (it can never do more than you). Its approvals may come to you " +
			"(subagent_decide); in the background it returns at once and the answer comes with subagent_wait.",
		parameters: Type.Object({
			task: Type.String({ description: "What the subagent should do, with all the context it needs" }),
			rules: Type.Optional(
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description:
						'Rules on top of yours, e.g. {"default":"deny","rules":[{"action":"allow","method":"file.read"}]}; ' +
						"actions allow|deny|require-approval, methods exec|file.read|file.write, nodes, exact|prefix",
				}),
			),
			quota: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Token quota for the subagent; omitted means unlimited",
				}),
			),
			background: Type.Optional(
				Type.Boolean({ description: "Return at once with the session id; fetch the answer with subagent_wait" }),
			),
		}),
		// A rerun after a restart finds the child session and submission it made before.
		replay: "safe",
		execute: async (args, api, context) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const parent = await runtime.sessionAt(String(api.conversationId));
			if (!parent) throw new Error("this conversation is not a ClusterRightHand session");
			const rules = args.rules
				? await parseRuleSetForWrite(options.db, parent.orgId, args.rules, false)
				: { default: "inherit" as const, rules: [] };
			const quota = args.quota === undefined ? null : parseQuota(args.quota);
			const child = await runtime.createSubagent(parent.id, {
				callKey: String(api.taskId),
				task: args.task,
				rules,
				quota,
			});
			// A UI watching the parent finds the child here.
			await api.details({ sessionId: child.id }, context);
			await runtime.startSubagent(child.id, args.task, `subagent:${String(api.taskId)}`);
			if (args.background) {
				return {
					output: [
						{
							type: "text",
							text: `Subagent started in the background (session ${child.id}). Get its answer with subagent_wait("${child.id}").`,
						},
					],
					details: { sessionId: child.id, requests: [] },
				};
			}
			const result = await runtime.waitSubagent(child.id, {
				attention: true,
				signal: context.abortSignal,
				handler: parent.id,
			});
			if (result.status === "attention") {
				const what = result.requests
					.map((r) =>
						r.kind === "quota"
							? `${r.kind} ${r.id} (${r.summary}; approve with tokens: N or deny)`
							: `${r.kind} ${r.id} (${r.summary})`,
					)
					.join("; ");
				return {
					output: [
						{
							type: "text",
							text:
								`The subagent is waiting for your decision: ${what}. ` +
								`Call subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?), then ` +
								`subagent_wait("${child.id}") for its answer.`,
						},
					],
					details: { sessionId: child.id, requests: result.requests.map(requestJson) },
				};
			}
			if (result.status === "unanswered") throw new Error(`the subagent did not answer (${result.reason})`);
			return {
				output: [{ type: "text", text: result.answer || "(no answer)" }],
				details: { sessionId: child.id, requests: [] },
			};
		},
	}) as unknown as ToolRegistration;

	const subagentWait: ToolRegistration = defineTool({
		name: "subagent_wait",
		description: "Wait for a subagent's answer; returns at once if it waits for your decision.",
		parameters: Type.Object({
			id: Type.String({ description: "The subagent's session id" }),
			attention: Type.Optional(
				Type.Boolean({ description: "Stop waiting when it needs your decision (default true)" }),
			),
		}),
		execute: async (args, api, context) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			if (!(await runtime.isDescendant(session.id, args.id))) throw new Error("not one of your subagents");
			const result = await runtime.waitSubagent(args.id, {
				attention: args.attention !== false,
				signal: context.abortSignal,
				handler: session.id,
			});
			if (result.status === "attention") {
				const what = result.requests
					.map((r) =>
						r.kind === "quota"
							? `${r.kind} ${r.id} (${r.summary}; approve with tokens: N or deny)`
							: `${r.kind} ${r.id} (${r.summary})`,
					)
					.join("; ");
				return {
					output: [{ type: "text", text: `Still waiting for your decision: ${what}.` }],
					details: { requests: result.requests.map(requestJson) },
				};
			}
			if (result.status === "unanswered") throw new Error(`the subagent did not answer (${result.reason})`);
			return { output: [{ type: "text", text: result.answer || "(no answer)" }] };
		},
	}) as unknown as ToolRegistration;

	const subagentList: ToolRegistration = defineTool({
		name: "subagent_list",
		description: "List your subagents and the requests waiting for your decision.",
		parameters: Type.Object({}),
		execute: async (_args, api) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			return {
				output: [
					{ type: "text", text: JSON.stringify({ subagents: await runtime.subagentSessions(session.id) }, null, 2) },
				],
			};
		},
	}) as unknown as ToolRegistration;

	const subagentCancel: ToolRegistration = defineTool({
		name: "subagent_cancel",
		description: "Stop one of your subagents and its running work.",
		parameters: Type.Object({ id: Type.String({ description: "The subagent's session id" }) }),
		execute: async (args, api) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			if (!(await runtime.isDescendant(session.id, args.id))) throw new Error("not one of your subagents");
			await runtime.abort(args.id);
			return { output: [{ type: "text", text: `Stopped subagent ${args.id}.` }] };
		},
	}) as unknown as ToolRegistration;

	const subagentDecide: ToolRegistration = defineTool({
		name: "subagent_decide",
		description:
			"Settle a subagent request that was handed to you: approve it, deny it, or escalate an approval to the user. " +
			"Quota requests (add tokens: N) are approved or denied only. Only requests listed by subagent_list or " +
			"attached to a tool result are yours.",
		parameters: Type.Object({
			request_id: Type.String({
				description: "The task or task group id, or the paused subagent's session id for a quota wait",
			}),
			decision: Type.Union([Type.Literal("approve"), Type.Literal("deny"), Type.Literal("escalate")]),
			reason: Type.Optional(Type.String({ description: "Why; shown to the subagent and in the audit log" })),
			tokens: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Quota requests only: tokens to add; not capped by this session's own remainder",
				}),
			),
		}),
		execute: async (args, api) => {
			const runtime = runtimeRef.current;
			if (!runtime) throw new Error("the agent runtime is not ready");
			const session = await runtime.sessionAt(String(api.conversationId));
			if (!session) throw new Error("this conversation is not a ClusterRightHand session");
			const kind = await runtime.decideAgentRequest(
				session.id,
				args.request_id,
				args.decision,
				args.reason,
				args.tokens,
			);
			const what =
				args.decision === "escalate"
					? "passed to the user"
					: args.decision === "approve"
						? kind === "quota"
							? `granted ${args.tokens ?? 0} tokens`
							: "approved"
						: "denied";
			return { output: [{ type: "text", text: `The ${kind} request ${args.request_id} was ${what}.` }] };
		},
	}) as unknown as ToolRegistration;

	options.subagentTool = subagent;
	return defineExtension({
		name: "crh",
		tools: [...tools, subagent, subagentWait, subagentList, subagentCancel, subagentDecide],
		sections: [section("crh", () => SYSTEM_PROMPT, { tag: false })],
		hooks,
	});
}
