import type { ApprovalBody, SessionView, TaskGroupView, TaskView } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApprovalCard } from "@/components/approval-card";
import { QuotaCard } from "@/components/quota-card";
import { useApprovalLookups, useApprovals, useDecideApproval } from "@/features/approvals/api";
import { AuthorizationWait } from "@/features/authorizations/authorization-wait";
import { linkClass } from "@/lib/utils";
import { sessionKeys, useDecideQuota } from "./api";

function SessionAuthorization({ kind, id, sessionId }: { kind: "task" | "task_group"; id: string; sessionId: string }) {
	const queryClient = useQueryClient();
	return (
		<AuthorizationWait
			kind={kind}
			id={id}
			onChanged={() => {
				void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
				void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
			}}
			waiting={(state) =>
				state === "loading" ? (
					<p className="text-sm text-muted-foreground">
						<Trans>Preparing the payload to sign…</Trans>
					</p>
				) : (
					<p className="text-sm text-muted-foreground">
						<Trans>The pending payload is being prepared…</Trans>{" "}
						{kind === "task" ? (
							<Link to="/tasks/$taskId" params={{ taskId: id }} className={linkClass}>
								<Trans>Open the task page</Trans>
							</Link>
						) : (
							<Link to="/task-groups/$taskGroupId" params={{ taskGroupId: id }} className={linkClass}>
								<Trans>Open the task group page</Trans>
							</Link>
						)}
					</p>
				)
			}
		/>
	);
}

/**
 * The waiting cards shown inside the session (doc/design/webui.md "Session interface"): an
 * approval, a signature or an exhausted quota, with the same cards as the
 * Approvals page. Decisions go through the same mutations, so the header badge
 * and the Approvals page see them at once.
 */
export function SessionWaits({
	session,
	deciding,
}: {
	session: SessionView;
	/** The in-flight history refresh after a decision (the session page reloads). */
	deciding?: boolean;
}) {
	const approvals = useApprovals();
	const lookups = useApprovalLookups();
	const queryClient = useQueryClient();
	const decide = useDecideApproval();
	const quota = useDecideQuota(session.id);

	const onDecide = (kind: "task" | "task_group", id: string, body: ApprovalBody) => {
		decide.mutate(
			{ kind, id, body },
			{
				onSuccess: () => {
					void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(session.id) });
					void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
				},
			},
		);
	};

	const tasks = (approvals.data?.tasks ?? []).filter((task: TaskView) => task.rootSessionId === session.id);
	const taskGroups = (approvals.data?.taskGroups ?? []).filter(
		(taskGroup: TaskGroupView) => taskGroup.rootSessionId === session.id,
	);
	const signatureTasks = (approvals.data?.authorizations.tasks ?? []).filter(
		(task: TaskView) => task.rootSessionId === session.id,
	);
	const signatureTaskGroups = (approvals.data?.authorizations.taskGroups ?? []).filter(
		(taskGroup: TaskGroupView) => taskGroup.rootSessionId === session.id,
	);

	const quotaWait =
		session.waitingKind === "quota" && session.capabilities.configure
			? {
					sessionId: session.id,
					levelId: session.waitingLevelId ?? session.id,
					title: session.title,
					since: session.updatedAt,
					budgetRemaining: session.budgetRemaining ?? 0,
					budgetUsedTokens: session.budgetUsedTokens,
				}
			: null;

	if (approvals.isPending) {
		return (
			<div className="shrink-0 bg-muted/30 px-3 py-2" data-testid="session-waits">
				<p className="text-sm text-muted-foreground">
					<Trans>Loading the waiting decisions…</Trans>
				</p>
			</div>
		);
	}

	return (
		<div className="grid shrink-0 gap-2 bg-muted/30 px-3 py-2" data-testid="session-waits">
			{quotaWait !== null && (
				<QuotaCard
					wait={quotaWait}
					busy={quota.isPending || deciding}
					error={quota.error}
					onDecide={(decision) => quota.mutate(decision)}
				/>
			)}
			{tasks.map((task) => (
				<ApprovalCard
					key={task.id}
					item={{ kind: "task", task }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					busy={(decide.isPending && decide.variables?.id === task.id) || Boolean(deciding)}
					error={decide.variables?.id === task.id ? decide.error : undefined}
					onDecide={(body) => onDecide("task", task.id, body)}
				/>
			))}
			{taskGroups.map((taskGroup) => (
				<ApprovalCard
					key={taskGroup.id}
					item={{ kind: "task_group", taskGroup }}
					nodeNames={lookups.nodeNames}
					refNames={lookups.refNames}
					tokenNames={lookups.tokenNames}
					busy={(decide.isPending && decide.variables?.id === taskGroup.id) || Boolean(deciding)}
					error={decide.variables?.id === taskGroup.id ? decide.error : undefined}
					onDecide={(body) => onDecide("task_group", taskGroup.id, body)}
				/>
			))}
			{signatureTasks.map((task) => (
				<SessionAuthorization key={task.id} kind="task" id={task.id} sessionId={session.id} />
			))}
			{signatureTaskGroups.map((taskGroup) => (
				<SessionAuthorization key={taskGroup.id} kind="task_group" id={taskGroup.id} sessionId={session.id} />
			))}
			{quotaWait === null &&
				tasks.length === 0 &&
				taskGroups.length === 0 &&
				signatureTasks.length === 0 &&
				signatureTaskGroups.length === 0 && (
					<p className="text-sm text-muted-foreground">
						<Trans>This session is waiting, but there is nothing for you to decide.</Trans>
					</p>
				)}
		</div>
	);
}
