import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, SquareIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { ApprovalCard, DecisionView } from "@/components/approval-card";
import { ErrorState } from "@/components/error-state";
import type { KeyValueItem } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { TaskStatusBadge } from "@/components/status-badge";
import { TaskGone } from "@/components/task-gone";
import { TaskEvaluation, TaskFacts, TaskOutput } from "@/components/task-result";
import { Button } from "@/components/ui/button";
import { useApprovalLookups, useDecideApproval } from "@/features/approvals/api";
import { useAuth } from "@/features/auth/session";
import { AuthorizationWait } from "@/features/authorizations/authorization-wait";
import { useNodes } from "@/features/nodes/api";
import { useDirectory } from "@/features/users/api";
import { isNotFound } from "@/lib/api/client";
import { taskActor } from "./actor";
import { useCancelTask, useTask } from "./api";
import { isTerminal } from "./output";

/** A node link that shows the node's name, falling back to its id while the list loads. */
function NodeLink({ nodeId, names }: { nodeId: string; names: Map<string, string> }) {
	return (
		<Link to="/nodes/$nodeId" params={{ nodeId }} className="text-primary underline underline-offset-2">
			{names.get(nodeId) ?? nodeId}
		</Link>
	);
}

/** One task: header, one facts block, the approval or signature card, then the result (doc/webui.md "Task page"). */
export function TaskPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { taskId?: string };
	const id = params.taskId ?? "";
	const task = useTask(id, true);
	const currentUser = useAuth().user;
	const directory = useDirectory();
	const nodes = useNodes();
	const looks = useApprovalLookups();
	const decide = useDecideApproval();
	const cancel = useCancelTask(id);
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (task.isPending) {
		return (
			<p className="p-4 text-sm text-muted-foreground" role="status">
				<Trans>Loading…</Trans>
			</p>
		);
	}
	if (task.error !== null && task.error !== undefined) {
		if (isNotFound(task.error)) {
			return (
				<div className="p-4">
					<TaskGone />
				</div>
			);
		}
		return (
			<div className="p-4">
				<ErrorState error={task.error} retry={() => void task.refetch()} />
			</div>
		);
	}
	if (!task.data) return null;
	const view = task.data;
	const actor = taskActor(view, (uid) => (directory.data?.users ?? []).find((user) => user.id === uid)?.displayName);
	const running = !isTerminal(view.state);
	// Only an administrator and the task's on_behalf_of user may cancel or decide (doc/access-control.md).
	const canAct = currentUser?.kind === "admin" || view.onBehalfOfUserId === currentUser?.id;
	// Signing is the on_behalf_of user's own act, administrators included only when it is their task.
	const canSign = view.onBehalfOfUserId === currentUser?.id;

	const links: KeyValueItem[] = [
		...(view.rootSessionId !== null && view.rootSessionId !== undefined
			? [
					{
						label: <Trans>Session</Trans>,
						value: (
							<Link
								to="/sessions/$sessionId"
								params={{ sessionId: view.rootSessionId }}
								className="font-mono text-xs text-primary underline underline-offset-2"
							>
								{view.rootSessionId}
							</Link>
						),
					},
				]
			: []),
		...(view.taskGroupId !== null && view.taskGroupId !== undefined
			? [
					{
						label: <Trans>Task group</Trans>,
						value: (
							<Link
								to="/task-groups/$taskGroupId"
								params={{ taskGroupId: view.taskGroupId }}
								className="font-mono text-xs text-primary underline underline-offset-2"
							>
								{view.taskGroupId}
							</Link>
						),
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
				title={
					<span className="font-mono" title={view.summary || view.kind}>
						{view.summary || view.kind}
					</span>
				}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<TaskStatusBadge state={view.state} />
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

			<section className="rounded-lg border p-3" aria-label={t`Task details`}>
				<TaskFacts
					task={view}
					showSummary={false}
					showState={false}
					showWaiting={false}
					showDecision={false}
					node={<NodeLink nodeId={view.nodeId} names={names} />}
					askedBy={
						<span className="flex flex-wrap items-center gap-1.5">
							<span>{actor.name}</span>
							<span className="font-mono text-xs text-muted-foreground">{actor.id}</span>
						</span>
					}
					extra={links}
				/>
			</section>

			{view.state === "awaiting_approval" && canAct && (
				<ApprovalCard
					item={{ kind: "task", task: view }}
					nodeNames={looks.nodeNames}
					refNames={looks.refNames}
					tokenNames={looks.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					showFacts={false}
					showHeading={false}
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

			{view.state === "awaiting_authorization" && canSign && (
				<AuthorizationWait
					kind="task"
					id={view.id}
					onChanged={() => void task.refetch()}
					waiting={
						<p className="text-sm text-muted-foreground">
							<Trans>Waiting for the payload to sign; the card appears when it is ready.</Trans>
						</p>
					}
				/>
			)}

			{view.approval?.decision && (
				<section className="rounded-lg border p-3" aria-label={t`Approval`}>
					<DecisionView decision={view.approval.decision} tokenNames={looks.tokenNames} />
				</section>
			)}

			{view.state !== "awaiting_approval" && (
				<TaskEvaluation task={view} tokenNames={looks.tokenNames} className="rounded-lg border p-3" />
			)}

			<section className="rounded-lg border p-3" aria-label={t`Result`}>
				<TaskOutput task={view} />
			</section>
		</Page>
	);
}
