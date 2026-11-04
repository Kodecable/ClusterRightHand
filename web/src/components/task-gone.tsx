import { Trans } from "@lingui/react/macro";
import { cn } from "@/lib/utils";

/**
 * A neutral notice for a task or task group the API answers 404 for: the retention sweep deletes old finished
 * tasks, so a link in the audit log can outlive its target. Not an error, and nothing to retry.
 */
export function TaskGone({ taskGroup = false, className }: { taskGroup?: boolean; className?: string }) {
	return (
		<p
			data-testid={taskGroup ? "task-group-gone" : "task-gone"}
			className={cn("text-sm text-muted-foreground", className)}
		>
			{taskGroup ? (
				<Trans>The task group was cleaned up or does not exist</Trans>
			) : (
				<Trans>The task was cleaned up or does not exist</Trans>
			)}
		</p>
	);
}
