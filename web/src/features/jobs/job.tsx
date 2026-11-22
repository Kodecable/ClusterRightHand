/**
 * The one vocabulary the background bar, the tool rows and the notice lines share (doc/design/jobs.md "WebUI"):
 * a job's kind icon, its state and wait in words, and the page its resource has. Everything that shows a job
 * reads these helpers, so the same job reads the same everywhere.
 */
import type { JobResource, JobView } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { BotIcon, CableIcon, SquareTerminalIcon } from "lucide-react";

/** The page a job's resource has; an extension call has none, which is why its row offers Stop instead. */
export function jobResourceLink(resource: JobResource): { to: string; params: Record<string, string> } | undefined {
	switch (resource.type) {
		case "task":
			return { to: "/tasks/$taskId", params: { taskId: resource.id } };
		case "task_group":
			return { to: "/task-groups/$taskGroupId", params: { taskGroupId: resource.id } };
		case "session":
			return { to: "/sessions/$sessionId", params: { sessionId: resource.id } };
		case "external_call":
			return undefined;
	}
}

/** A job's state, naming the wait while it waits (doc/design/jobs.md "States"). */
export function jobStateText(i18n: I18n, job: Pick<JobView, "state" | "wait">): string {
	if (job.state === "settled") return i18n._(msg`Finished`);
	if (job.state === "running") return i18n._(msg`Running`);
	switch (job.wait) {
		case "approval":
			return i18n._(msg`Waiting for approval`);
		case "signature":
			return i18n._(msg`Waiting for a signature`);
		case "quota":
			return i18n._(msg`Waiting for quota`);
		case "decision":
			return i18n._(msg`Waiting for a decision`);
		default:
			return i18n._(msg`Waiting`);
	}
}

/** The record behind a job, in words: an exec job is a task or a task group. */
export function jobKindText(i18n: I18n, job: Pick<JobView, "kind" | "resource">): string {
	if (job.kind === "call") return i18n._(msg`Extension call`);
	if (job.kind === "subagent") return i18n._(msg`Subagent`);
	return job.resource.type === "task_group" ? i18n._(msg`Task group`) : i18n._(msg`Task`);
}

/** A job's kind icon, the leading mark of its background-bar row. */
export function JobKindIcon({ job, className }: { job: Pick<JobView, "kind">; className?: string }) {
	const classes = className ?? "size-3.5 shrink-0";
	switch (job.kind) {
		case "call":
			return <CableIcon className={classes} aria-hidden="true" />;
		case "subagent":
			return <BotIcon className={classes} aria-hidden="true" />;
		default:
			return <SquareTerminalIcon className={classes} aria-hidden="true" />;
	}
}
