/**
 * The `subagent` job adapter: a child session's run (doc/design/jobs.md "Adapters"). The child can outlive its run
 * with background jobs of its own, so it is settled only when its stored state is idle **and** every job it owns
 * has settled. Everything the adapter needs from the agent runtime arrives through `SubagentJobRuntime`; the job
 * layer imports no pi-durable or agent types.
 */
import type { TaskOutcome } from "@crh/api";
import type { Db } from "../storage/db.ts";
import { errorResult, type ToolResult, textResult } from "../util/tool-result.ts";
import { actionText } from "./action.ts";
import type { JobProjection, JobRow, JobSource, SubagentJobRuntime } from "./types.ts";

export function subagentJobSource(db: Db, runtime: () => SubagentJobRuntime | undefined): JobSource {
	return {
		kind: "subagent",
		async project(job): Promise<JobProjection | undefined> {
			if (job.resource_type !== "session") return undefined;
			const source = runtime();
			if (!source) return undefined;
			const run = await source.project(job.resource_id);
			if (!run) return undefined;
			if (run.state === "awaiting") {
				return { state: "waiting", wait: run.wait ?? "approval", outcome: null };
			}
			if (run.state === "running") return { state: "running", wait: null, outcome: null };
			// Its run ended, but a child that started background work is not finished: its jobs' notices wake
			// it and its answer comes after them (doc/design/jobs.md "States").
			const owned = await db
				.selectFrom("jobs")
				.select(["id", "state"])
				.where("actor_type", "=", "subagent")
				.where("actor_id", "=", job.resource_id)
				.where("id", "!=", job.id)
				// A settled job whose notice is still pending will wake the child: its answer comes after that
				// turn, so the child is not finished yet (doc/design/jobs.md "States").
				.where((eb) => eb.or([eb("state", "!=", "settled"), eb("notice", "=", "pending")]))
				.execute();
			if (owned.some((row) => row.state !== "settled")) return { state: "running", wait: null, outcome: null };
			// A pending notice keeps the child unsettled only while its wake can still be delivered. Past
			// `jobs.max_consecutive_wakes` an idle child is never woken again, so its current answer is final.
			if (owned.length > 0 && (await source.noticeWakeAvailable(job.resource_id))) {
				return { state: "running", wait: null, outcome: null };
			}
			// A notice wake for the child is queued or being delivered: the woken turn has not ended.
			if (source.noticeBusy(job.resource_id)) return { state: "running", wait: null, outcome: null };
			return { state: "settled", wait: null, outcome: run.outcome ?? { kind: "succeeded", failed: false } };
		},
		async wait(job, ms, options): Promise<void> {
			if (job.resource_type !== "session" || ms <= 0) return;
			const source = runtime();
			if (!source) return;
			// The runtime's wait takes no millisecond budget of its own; attention is what ends it early. The
			// caller (Jobs.waitJob) enforces the deadline by re-projecting after each early return.
			const controller = new AbortController();
			// A foreground `subagent` wait has no deadline; only a real budget arms the timer.
			const timer = Number.isFinite(ms) ? setTimeout(() => controller.abort(), ms) : undefined;
			const onAbort = () => controller.abort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await source.wait(job.resource_id, {
					attention: options.attention,
					signal: controller.signal,
					...(job.actor_type === "session" || job.actor_type === "subagent" ? { handler: job.actor_id } : {}),
				});
			} catch (err) {
				// The wait ends on the timeout or the caller's abort; only an unexpected failure is an error.
				if (!controller.signal.aborted && !options.signal?.aborted) throw err;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			}
		},
		async cancel(job, by): Promise<boolean> {
			if (job.resource_type !== "session") return false;
			const source = runtime();
			if (!source) return false;
			return source.cancel(job.resource_id, by);
		},
		async render(job, _ctx): Promise<ToolResult> {
			const label = actionText(job) || "subagent";
			const source = runtime();
			if (!source) return goneResult();
			const outcome = parseOutcome(job);
			if (job.state === "settled") {
				if (outcome?.kind === "succeeded") {
					const answer = await source.answer(job.resource_id);
					return textResult([{ output: answer === undefined || answer === "" ? "(no answer)" : answer }]);
				}
				if (outcome?.kind === "cancelled") {
					return errorResult("text", "cancelled", `the subagent ${label} was stopped`, { job_id: job.id });
				}
				return errorResult("text", "error", `the subagent ${label} did not answer`, { job_id: job.id });
			}
			if (job.state === "waiting") {
				if (job.wait === "decision") {
					const block = await source.requestsBlock(job.resource_id);
					if (block !== undefined) {
						return textResult([
							{
								output:
									`Still waiting for your decision.\n${block}\n` +
									`Call subagent_decide(request_id, "approve" | "deny" | "escalate", reason?, tokens?), then ` +
									`job_wait("${job.id}") for its answer.`,
							},
						]);
					}
				}
				return textResult([{ note: `[${label}, ${waitText(job.wait)}, job ${job.id}: call job_wait with this id]` }]);
			}
			return textResult([{ note: `[${label}, still running, job ${job.id}: call job_wait with this id]` }]);
		},
	};
}

function waitText(wait: JobRow["wait"]): string {
	switch (wait) {
		case "signature":
			return "waiting for authorization";
		case "quota":
			return "waiting for more token quota";
		case "decision":
			return "waiting for your decision";
		default:
			return "waiting for approval";
	}
}

function parseOutcome(job: JobRow): TaskOutcome | null {
	if (!job.outcome) return null;
	try {
		return JSON.parse(job.outcome) as TaskOutcome;
	} catch {
		return null;
	}
}

function goneResult(): ToolResult {
	return textResult([{ note: "[the job's details are no longer kept]" }]);
}
