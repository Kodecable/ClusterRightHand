import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { ErrorState } from "@/components/error-state";
import { NodeTargetList } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RequestSource } from "@/components/request-source";
import { Panel } from "@/components/section";
import { PageSkeleton } from "@/components/skeletons";
import { TaskGroupStatusBadge } from "@/components/status-badge";
import { TaskGroupFacts } from "@/components/task-facts";
import { TaskGone } from "@/components/task-gone";
import { useNodeNames } from "@/features/nodes/api";
import { isNotFound } from "@/lib/api/client";
import { usePageTitle } from "@/lib/page-title";
import { taskTitle } from "@/lib/task-title";
import { useTaskGroup } from "./api";
import { TaskGroupResult, TaskGroupSkippedNotice } from "./task-group-result";

/**
 * One task group from a link, e.g. a group that waits for the owner's signature
 * (doc/design/webui.md "Task and task group pages"). Its command is the page title, its state sits
 * under it, then the per-node results.
 */
export function TaskGroupPage() {
	const { t, i18n } = useLingui();
	const params = useParams({ strict: false }) as { taskGroupId?: string };
	const id = params.taskGroupId ?? "";
	const taskGroup = useTaskGroup(id, true);
	const names = useNodeNames();
	const summary = taskGroup.data === undefined ? undefined : taskTitle(i18n, taskGroup.data);
	// The shell header and the browser tab name the group by its command too.
	usePageTitle(summary);

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
			<PageHeader
				title={<span className="font-mono">{summary || <Trans>Task group</Trans>}</span>}
				titleText={summary}
				description={<TaskGroupStatusBadge state={taskGroup.data.state} />}
			/>
			<Panel as="section" aria-label={t`Task group details`}>
				<TaskGroupFacts
					taskGroup={taskGroup.data}
					nodes={<NodeTargetList ids={taskGroup.data.targets} refs={taskGroup.data.refs} nodeNames={names} />}
					source={<RequestSource source={taskGroup.data.source} />}
				/>
			</Panel>
			<TaskGroupSkippedNotice taskGroup={taskGroup.data} names={names} />
			<TaskGroupResult
				taskGroup={taskGroup.data}
				request={taskGroup.data.request}
				names={names}
				onChanged={() => void taskGroup.refetch()}
			/>
		</Page>
	);
}
