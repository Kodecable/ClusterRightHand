/**
 * The `call` job adapter: one external_calls row (doc/design/jobs.md "Adapters" and "Background extension calls").
 * The MCP request itself runs in the crhs-owned call runner, not in the tool invocation; this adapter follows the
 * approval and then the runner's in-flight call, cancels through it, and renders the result the runner kept in
 * `jobs.result` while the job is kept.
 */
import type { TaskOutcome } from "@crh/api";
import type { Audit } from "../audit/audit.ts";
import { type CallRunner, callRunningResult, callWaitingResult, settledCallResult } from "../extensions/call-runner.ts";
import {
	cancelWaitingExternalCall,
	type ExternalCallRow,
	externalCallPhase,
	getExternalCall,
	waitExternalCall,
} from "../extensions/external-calls.ts";
import type { Db } from "../storage/db.ts";
import type { ToolResult } from "../util/tool-result.ts";
import { textResult } from "../util/tool-result.ts";
import type { JobProjection, JobSource } from "./types.ts";

/** What `jobs.result` stores for a settled call: the rendered result the starting tool returned. */
export interface StoredCallResult {
	content: ToolResult["content"];
	isError: boolean;
	details?: Record<string, unknown>;
}

export function serializeCallResult(result: ToolResult): string {
	const stored: StoredCallResult = {
		content: result.content,
		isError: result.isError,
		...(result.details === undefined ? {} : { details: result.details }),
	};
	return JSON.stringify(stored);
}

/** The stored result as a tool result, or undefined when none was kept. */
export function parseCallResult(json: string | null): StoredCallResult | undefined {
	if (!json) return undefined;
	try {
		const parsed = JSON.parse(json) as StoredCallResult;
		if (!Array.isArray(parsed.content) || typeof parsed.isError !== "boolean") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function callJobSource(db: Db, callRunner: CallRunner, audit?: Audit): JobSource {
	return {
		kind: "call",
		async project(job): Promise<JobProjection | undefined> {
			if (job.resource_type !== "external_call") return undefined;
			const row = await getExternalCall(db, job.resource_id);
			if (!row) return undefined;
			return projectCall(row);
		},
		async wait(job, ms, options): Promise<void> {
			// An approval on a call is the user's (or an ancestor agent's), never something this agent's
			// `job_wait` may end on: `options.attention` is for subagent jobs only.
			if (job.resource_type !== "external_call") return;
			const deadline = Date.now() + Math.max(0, ms);
			for (;;) {
				const row = await getExternalCall(db, job.resource_id);
				if (!row || (row.state !== "awaiting_approval" && row.state !== "running")) return;
				if (options.signal?.aborted) return;
				const left = deadline - Date.now();
				if (left <= 0) return;
				if (row.state === "awaiting_approval") {
					// The approval wait is woken by the decision; the deadline only stops us waiting.
					await waitForApprovalChange(db, row.id, left, options.signal);
					continue;
				}
				if (await callRunner.wait(row.id, left, options.signal)) continue;
				// A call running in another process (or one whose runner is gone) cannot be followed by an
				// in-memory wait; hold the caller's budget rather than returning before its deadline.
				if (callRunner.get(row.id) === undefined) await sleep(left, options.signal);
				return;
			}
		},
		async cancel(job, by): Promise<boolean> {
			if (job.resource_type !== "external_call") return false;
			const row = await getExternalCall(db, job.resource_id);
			if (row?.state === "awaiting_approval") {
				// A call that never reached the extension is simply cancelled (doc/design/jobs.md "Lifecycle").
				const cancelled = await cancelWaitingExternalCall(db, row.id);
				if (cancelled) {
					void audit?.record({
						actor: by,
						action: "external_call.finished",
						target: { type: "external_call", id: row.id },
						detail: {
							extension: row.extension_name,
							tool: row.tool_name,
							state: "cancelled",
							reason: "the job was cancelled",
						},
					});
				}
				return cancelled;
			}
			if (row?.state !== "running") return false;
			// A running call gets the MCP cancellation the runner sends for an aborted tool call; it ends
			// `unknown`, because the extension may have run it.
			return callRunner.cancel(row.id, "the job was cancelled");
		},
		async render(job, ctx): Promise<ToolResult> {
			if (job.resource_type !== "external_call") return goneResult();
			const stored = parseCallResult(job.result);
			if (stored) {
				return {
					content: stored.content,
					isError: stored.isError,
					details: { ...(stored.details ?? {}), external_call_id: job.resource_id },
				};
			}
			const row = await getExternalCall(db, job.resource_id);
			if (!row) return goneResult();
			if (row.state === "awaiting_approval") {
				return callWaitingResult(row, job.id, ctx.externalCallUrl ?? ((id) => `/approvals/external-calls/${id}`));
			}
			if (row.state === "running") return callRunningResult(row, job.id);
			return settledCallResult(row);
		},
	};
}

/** Waits up to `ms` for a decision, without cancelling the call when the deadline or the caller ends the wait. */
async function waitForApprovalChange(db: Db, id: string, ms: number, signal?: AbortSignal): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	timer.unref?.();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) controller.abort();
	try {
		await waitExternalCall(db, id, { signal: controller.signal, cancelOnAbort: false });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Holds a wait to its deadline when no in-memory change can be observed; the caller's abort ends it at once. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		timer.unref?.();
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function projectCall(row: ExternalCallRow): JobProjection {
	if (row.state === "awaiting_approval") {
		if (row.handler_type === null || externalCallPhase(row) === "reviewing") {
			return { state: "running", wait: null, outcome: null };
		}
		return { state: "waiting", wait: "approval", outcome: null };
	}
	if (row.state === "running") return { state: "running", wait: null, outcome: null };
	return { state: "settled", wait: null, outcome: callOutcome(row) };
}

function callOutcome(row: ExternalCallRow): TaskOutcome {
	switch (row.state) {
		case "succeeded":
			return { kind: "succeeded", failed: false };
		case "failed":
			return { kind: "error", failed: true };
		case "rejected":
			return { kind: "rejected", failed: true };
		case "cancelled":
			return { kind: "cancelled", failed: false };
		case "unknown":
			return { kind: "unknown", failed: true };
		case "awaiting_approval":
		case "running":
			return { kind: "unknown", failed: true };
	}
}

function goneResult(): ToolResult {
	return textResult([{ note: "[the job's details are no longer kept]" }]);
}
