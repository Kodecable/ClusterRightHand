import type { TaskOutcome } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { StatusDot, StatusText } from "@/components/status-badge";
import type { StatusTone } from "@/lib/status";
import { taskErrorText } from "@/lib/task-output";
import { cn } from "@/lib/utils";

/** The tone of a terminal result: succeeded green, cancelled muted, every failure red. */
export function taskOutcomeTone(outcome: TaskOutcome): StatusTone {
	if (!outcome.failed) return outcome.kind === "succeeded" ? "ok" : "muted";
	return "danger";
}

/** The one localized line of a task's or task group's outcome (doc/design/webui.md "Task and task group pages"). */
export function taskOutcomeText(i18n: I18n, outcome: TaskOutcome): string {
	switch (outcome.kind) {
		case "succeeded":
			return outcome.exitCode === undefined ? i18n._(msg`Done`) : i18n._(msg`Exit code ${outcome.exitCode}`);
		case "exit":
			return i18n._(msg`Exit code ${outcome.exitCode ?? "?"}`);
		case "signal":
			return i18n._(msg`Killed by signal ${outcome.signal ?? "?"}`);
		case "timed_out":
			return i18n._(msg`Timed out`);
		case "cancelled":
			return i18n._(msg`Cancelled`);
		case "rejected":
			return i18n._(msg`Rejected`);
		case "denied":
			return i18n._(msg`Denied by rules`);
		case "unknown":
			return i18n._(msg`Result unknown`);
		case "error": {
			const text = taskErrorText(i18n, outcome.errorCode ?? null, outcome.errorMessage ?? null);
			return text === "" ? i18n._(msg`Failed`) : text;
		}
	}
}

/**
 * The one result badge: a status dot in the outcome's colour and the one line naming it. Every surface
 * that shows a finished task, task group or node result renders this, and a terminal status takes its tone
 * from `outcome.failed`, so the same exit code cannot be green here and red there.
 */
export function TaskOutcomeBadge({
	outcome,
	className,
}: {
	outcome: TaskOutcome | null | undefined;
	className?: string;
}) {
	const { i18n } = useLingui();
	if (outcome === null || outcome === undefined) return null;
	const tone = taskOutcomeTone(outcome);
	return (
		<span
			data-testid="task-outcome"
			data-tone={tone}
			className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
		>
			<StatusDot tone={tone} />
			<StatusText tone={tone} className="truncate">
				{taskOutcomeText(i18n, outcome)}
			</StatusText>
		</span>
	);
}
