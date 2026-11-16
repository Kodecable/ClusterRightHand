import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { ApprovalPanel, DecisionView, RequestDetails } from "@/components/decision";
import { ErrorState } from "@/components/error-state";
import { InternalLink } from "@/components/internal-link";
import type { KeyValueItem } from "@/components/key-value";
import { NodeTargetList } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RequestSource } from "@/components/request-source";
import { Panel } from "@/components/section";
import { PageSkeleton } from "@/components/skeletons";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskFacts } from "@/components/task-facts";
import { TaskGone } from "@/components/task-gone";
import { TaskOutcomeBadge } from "@/components/task-outcome";
import { hasTaskOutput, TaskOutput } from "@/components/task-result";
import { Button } from "@/components/ui/button";
import { useApprovalLookups, useDecideApproval } from "@/features/approvals/api";
import { SignatureWait } from "@/features/authorizations/signature-wait";
import { useNodeNames } from "@/features/nodes/api";
import { useUserNames } from "@/features/users/api";
import { isNotFound } from "@/lib/api/client";
import { usePageTitle } from "@/lib/page-title";
import { useAuth } from "@/lib/session";
import { isTerminal } from "@/lib/task-output";
import { taskTitle } from "@/lib/task-title";
import { useCancelTask, useTask } from "./api";

/** One task: header, one facts block, the approval or signature decision, then the result (doc/design/webui.md "Task and task group pages"). */
export function TaskPage() {
	const { t, i18n } = useLingui();
	const params = useParams({ strict: false }) as { taskId?: string };
	const id = params.taskId ?? "";
	const task = useTask(id, true);
	const currentUser = useAuth().user;
	const looks = useApprovalLookups();
	const decide = useDecideApproval();
	const cancel = useCancelTask(id);
	const names = useNodeNames();
	const userNames = useUserNames();
	// The shell title names the task by its command, like the page heading does.
	usePageTitle(task.data === undefined ? undefined : taskTitle(i18n, task.data));

	if (task.isPending) {
		return (
			<Page width="detail">
				<PageSkeleton />
			</Page>
		);
	}
	if (task.error !== null && task.error !== undefined) {
		if (isNotFound(task.error)) {
			return (
				<Page width="detail">
					<TaskGone />
				</Page>
			);
		}
		return (
			<Page width="detail">
				<ErrorState error={task.error} retry={() => void task.refetch()} />
			</Page>
		);
	}
	if (!task.data) return null;
	const view = task.data;
	// The server sends the compact request with the task while it waits; the panel renders only that model.
	const request = view.request ?? undefined;
	const running = !isTerminal(view.state);
	// Only an administrator and the task's on_behalf_of user may cancel or decide (doc/design/access-control.md).
	const canAct = currentUser?.kind === "admin" || view.onBehalfOfUserId === currentUser?.id;
	// Signing is the on_behalf_of user's own act, administrators included only when it is their task.
	const canSign = view.onBehalfOfUserId === currentUser?.id;
	// While Auto Review decides the request is not the user's yet: show the notice, not decision controls.
	const reviewing = view.state === "awaiting_approval" && view.phase === "reviewing";

	const links: KeyValueItem[] = [
		...(view.rootSessionId !== null && view.rootSessionId !== undefined
			? [
					{
						label: <Trans>Session</Trans>,
						value: (
							<InternalLink to="/sessions/$sessionId" params={{ sessionId: view.rootSessionId }}>
								{view.rootSessionId}
							</InternalLink>
						),
						mono: true,
					},
				]
			: []),
		...(view.taskGroupId !== null && view.taskGroupId !== undefined
			? [
					{
						label: <Trans>Task group</Trans>,
						value: (
							<InternalLink to="/task-groups/$taskGroupId" params={{ taskGroupId: view.taskGroupId }}>
								{view.taskGroupId}
							</InternalLink>
						),
						mono: true,
					},
				]
			: []),
	];

	return (
		<Page width="detail" data-testid="task-page">
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
				title={<span className="font-mono">{taskTitle(i18n, view)}</span>}
				titleText={taskTitle(i18n, view)}
				description={
					<span className="inline-flex flex-wrap items-center gap-1">
						<TaskStatusBadge state={view.state} />
						{view.outcome !== null && (
							<>
								<span className="text-muted-foreground">{" · "}</span>
								<TaskOutcomeBadge outcome={view.outcome} />
							</>
						)}
					</span>
				}
				actions={
					running && canAct ? (
						<Button
							type="button"
							variant="destructive"
							data-testid="cancel-task"
							disabled={cancel.isPending}
							onClick={() => cancel.mutate(undefined, { onSuccess: () => toast.success(t`Cancellation requested.`) })}
						>
							<SquareIcon />
							<Trans>Stop task</Trans>
						</Button>
					) : undefined
				}
			/>

			<Panel as="section" aria-label={t`Task details`}>
				<TaskFacts
					task={view}
					showSummary={false}
					showState={false}
					showOutcome={false}
					showWaiting={false}
					showDecision={false}
					node={<NodeTargetList ids={[view.nodeId]} nodeNames={names} />}
					source={<RequestSource source={view.source} />}
					userNames={userNames}
					extra={links}
				/>
			</Panel>

			{view.state === "awaiting_approval" && request !== undefined && (canAct || reviewing) && (
				<ApprovalPanel
					request={request}
					variant="page"
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) =>
						decide.mutate(
							{ kind: "task", id: view.id, body },
							{
								onSuccess: () => {
									void task.refetch();
								},
							},
						)
					}
				/>
			)}

			{view.state === "awaiting_authorization" && canSign && request !== undefined && (
				<SignatureWait request={request} variant="page" onChanged={() => void task.refetch()} />
			)}

			{view.approval && (
				<RequestDetails
					source={{ kind: "task", task: view }}
					nodeNames={looks.nodeNames}
					refNames={looks.refNames}
					tokenNames={looks.tokenNames}
				/>
			)}

			{view.approval?.decision && (
				<Panel as="section" aria-label={t`Approval`}>
					<DecisionView decision={view.approval.decision} tokenNames={looks.tokenNames} userNames={userNames} />
				</Panel>
			)}

			{hasTaskOutput(view) && (
				<Panel as="section" aria-label={t`Result`}>
					<TaskOutput task={view} />
				</Panel>
			)}
		</Page>
	);
}
