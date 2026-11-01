import { Trans } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { useNodes } from "@/features/nodes/api";
import { useTaskGroup } from "./api";
import { TaskGroupResult } from "./task-group-result";

/** One task group from a link, e.g. a group that waits for the owner's signature. */
export function TaskGroupPage() {
	const params = useParams({ strict: false }) as { taskGroupId?: string };
	const id = params.taskGroupId ?? "";
	const group = useTaskGroup(id, true);
	const nodes = useNodes();
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (group.isPending) {
		return (
			<p className="p-4 text-sm text-muted-foreground" role="status">
				<Trans>Loading…</Trans>
			</p>
		);
	}
	if (group.error !== null && group.error !== undefined) {
		return (
			<div className="p-4">
				<ErrorState error={group.error} retry={() => void group.refetch()} />
			</div>
		);
	}
	if (!group.data) return null;

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
			<TaskGroupResult group={group.data} names={names} onChanged={() => void group.refetch()} />
		</Page>
	);
}
