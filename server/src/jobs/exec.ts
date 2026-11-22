/**
 * The `exec` job adapter: a Cluster task or task group (doc/design/jobs.md "Adapters"). It reads the views the
 * Cluster API exposes, waits with the Cluster's own waits (through approval and signature in an agent session,
 * as `task_wait` did), cancels through the task's cancel path and renders through the exec renderers the tools
 * layer supplies, so `job_wait` returns exactly what `exec` returned.
 */
import type { TaskOutcome } from "@crh/api";
import { isPendingReview } from "../cluster/approval.ts";
import type { Cluster, TaskView } from "../cluster/cluster.ts";
import { taskGroupOutcome, taskOutcome } from "../cluster/outcome.ts";
import type { TaskGroups, TaskGroupView } from "../cluster/task-groups.ts";
import { GROUP_TERMINAL } from "../cluster/types.ts";
import type { NodePrivilege, NodeTransport } from "../tools/task-tool.ts";
import { textResult } from "../util/tool-result.ts";
import type { ExecJobRenderers, JobProjection, JobSource } from "./types.ts";

export function execJobSource(cluster: Cluster, taskGroups: TaskGroups, renderers: ExecJobRenderers): JobSource {
	return {
		kind: "exec",
		async project(job): Promise<JobProjection | undefined> {
			if (job.resource_type === "task") {
				const task = await cluster.getTask(job.resource_id);
				if (!task) return undefined;
				return projectTask(task);
			}
			if (job.resource_type === "task_group") {
				const group = await taskGroups.get(job.resource_id);
				if (!group) return undefined;
				return projectGroup(group);
			}
			return undefined;
		},
		async wait(job, ms, options): Promise<void> {
			// An approval or signature on a task is the user's, never this agent's to decide: `attention` is
			// ignored here (doc/design/jobs.md "Tools"). The tool layer's wait keeps its old behaviour, which is
			// to sit through approval and signature in an agent session and to stop at `ms` over MCP.
			if (job.resource_type === "task") {
				if (options.ctx) {
					await renderers.waitTask(options.ctx, job.resource_id, ms);
					return;
				}
				await cluster.waitTask(job.resource_id, ms, options.signal);
				return;
			}
			if (job.resource_type === "task_group") {
				if (options.ctx) {
					await renderers.waitGroup(options.ctx, job.resource_id, ms);
					return;
				}
				await taskGroups.wait(job.resource_id, ms, options.signal);
			}
		},
		async cancel(job, by): Promise<boolean> {
			if (job.resource_type === "task") return cluster.cancelTask(job.resource_id, undefined, by);
			if (job.resource_type === "task_group") return taskGroups.cancel(job.resource_id, undefined, by);
			return false;
		},
		async render(job, ctx) {
			if (job.resource_type === "task") {
				const task = await cluster.getTask(job.resource_id);
				if (!task) return goneResult();
				const node = await ctx.db
					.selectFrom("nodes")
					.select(["name", "transport", "privileged_mode", "ssh_user"])
					.where("id", "=", task.nodeId)
					.executeTakeFirst();
				return renderers.task(
					ctx,
					task,
					node?.name ?? task.nodeId,
					(node?.transport as NodeTransport | undefined) ?? "client",
					node === undefined
						? undefined
						: { transport: node.transport as NodeTransport, mode: node.privileged_mode, sshUser: node.ssh_user },
					job.id,
				);
			}
			if (job.resource_type === "task_group") {
				const group = await taskGroups.get(job.resource_id);
				if (!group) return goneResult();
				const nodes = await ctx.db
					.selectFrom("nodes")
					.select(["id", "name", "transport", "privileged_mode", "ssh_user"])
					.where("id", "in", group.nodeIds)
					.execute();
				const names = new Map(nodes.map((node) => [node.id, node.name] as const));
				const transports = new Map(nodes.map((node) => [node.id, node.transport as NodeTransport] as const));
				const privileges = new Map<string, NodePrivilege>(
					nodes.map((node) => [
						node.id,
						{
							transport: node.transport as NodeTransport,
							mode: node.privileged_mode,
							sshUser: node.ssh_user,
						},
					]),
				);
				return renderers.group(
					ctx,
					{ kind: "task_group", taskGroup: group, names, transports, privileges, jobId: job.id },
					job.id,
				);
			}
			return goneResult();
		},
	};
}

function projectTask(task: TaskView): JobProjection {
	if (task.state === "awaiting_authorization") {
		return { state: "waiting", wait: "signature", outcome: null };
	}
	if (task.state === "awaiting_approval") {
		// A row without a handler is the instant before dispatch, and a request Auto Review is still judging is
		// not a wait either (doc/design/jobs.md "States").
		if (task.handlerType === null || isPendingReview(task.approval?.review)) {
			return { state: "running", wait: null, outcome: null };
		}
		return { state: "waiting", wait: "approval", outcome: null };
	}
	const outcome: TaskOutcome | null = task.outcome ?? taskOutcome(task);
	if (outcome !== null) return { state: "settled", wait: null, outcome };
	return { state: "running", wait: null, outcome: null };
}

function projectGroup(group: TaskGroupView): JobProjection {
	if (group.state === "awaiting_authorization") {
		return { state: "waiting", wait: "signature", outcome: null };
	}
	if (group.state === "awaiting_approval") {
		if (group.handlerType === null || isPendingReview(group.approval?.review)) {
			return { state: "running", wait: null, outcome: null };
		}
		return { state: "waiting", wait: "approval", outcome: null };
	}
	if (GROUP_TERMINAL.has(group.state)) {
		const outcome: TaskOutcome | null = group.outcome ?? taskGroupOutcome(group);
		if (outcome !== null) return { state: "settled", wait: null, outcome };
	}
	return { state: "running", wait: null, outcome: null };
}

function goneResult() {
	return textResult([{ note: "[the job's details are no longer kept]" }]);
}
