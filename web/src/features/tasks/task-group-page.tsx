import { Trans } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { TaskGone } from "@/components/task-gone";
import { useNodes } from "@/features/nodes/api";
import { isNotFound } from "@/lib/api/client";
import { useTaskGroup } from "./api";
import { TaskGroupResult } from "./task-group-result";

/** One task group from a link, e.g. a group that waits for the owner's signature. */
export function TaskGroupPage() {
	const params = useParams({ strict: false }) as { taskGroupId?: string };
	const id = params.taskGroupId ?? "";
	const taskGroup = useTaskGroup(id, true);
	const nodes = useNodes();
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (taskGroup.isPending) {
		return (
			<Page width="detail">
				<PageSkeleton />
			</Page>
		);
	}
	if (taskGroup.error !== null && taskGroup.error !== undefined) {
		if (isNotFound(taskGroup.error)) {
			return (
				<Page width="detail">
					<TaskGone taskGroup />
				</Page>
			);
		}
		return (
			<Page width="detail">
				<ErrorState error={taskGroup.error} retry={() => void taskGroup.refetch()} />
			</Page>
		);
	}
	if (!taskGroup.data) return null;

	return (
		<Page width="detail" data-testid="task-group-page">
			<div>
				<Link
					to="/tasks"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All tasks</Trans>
				</Link>
			</div>
			<PageHeader title={<Trans>Task group</Trans>} />
			<TaskGroupResult taskGroup={taskGroup.data} names={names} onChanged={() => void taskGroup.refetch()} />
		</Page>
	);
}
