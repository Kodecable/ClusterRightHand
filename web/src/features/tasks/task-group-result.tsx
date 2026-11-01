import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ApprovalCard, DecisionView } from "@/components/approval-card";
import { StatusBadge, TaskStatusBadge } from "@/components/status-badge";
import { TaskOutcomeText, TaskResult } from "@/components/task-result";
import { Badge } from "@/components/ui/badge";
import { useApprovalLookups, useDecideApproval } from "@/features/approvals/api";
import { AuthorizationWait } from "@/features/authorizations/authorization-wait";
import type { TaskGroupView } from "@/lib/api/types";

const GROUP_STATES: Record<string, MessageDescriptor> = {
	awaiting_approval: msg`Awaiting approval`,
	awaiting_authorization: msg`Awaiting authorization`,
	running: msg`Running`,
	finished: msg`Finished`,
	interrupted: msg`Interrupted`,
	rejected: msg`Rejected`,
};

function groupTone(state: string): "ok" | "danger" | "info" | "warn" | "muted" {
	switch (state) {
		case "finished":
			return "ok";
		case "rejected":
		case "interrupted":
			return "danger";
		case "running":
			return "info";
		case "awaiting_approval":
		case "awaiting_authorization":
			return "warn";
		default:
			return "muted";
	}
}

/** The state pill of a task group; an unknown state keeps its raw name visible. */
export function GroupStateBadge({ state }: { state: string }) {
	const { i18n } = useLingui();
	const label = GROUP_STATES[state];
	return <StatusBadge tone={groupTone(state)}>{label === undefined ? state : i18n._(label)}</StatusBadge>;
}

/**
 * The result of one task group (doc/webui.md "Task group"): its state, the
 * group approval or signature when it waits, and one row per node with the
 * task's outcome and its full result. Shared by the task-group page and the
 * batch run.
 */
export function TaskGroupResult({
	group,
	names,
	onChanged,
}: {
	group: TaskGroupView;
	names: Map<string, string>;
	onChanged?: () => void;
}) {
	const { t } = useLingui();
	const lookups = useApprovalLookups();
	const decide = useDecideApproval();
	const nodeName = (id: string) => names.get(id) ?? id;
	const skipped = group.skipped.map(nodeName).join(", ");

	return (
		<section className="grid gap-3" data-testid="task-group-result" data-group-id={group.id}>
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="text-sm font-semibold">
					<Trans>Result</Trans>
				</h2>
				<GroupStateBadge state={group.state} />
				{group.privileged && (
					<Badge variant="secondary">
						<Trans>Privileged</Trans>
					</Badge>
				)}
				<span className="text-xs text-muted-foreground">
					<Plural value={group.nodeIds.length} one="# node" other="# nodes" />
				</span>
			</div>

			{(group.summary !== undefined || group.kind !== undefined) && (
				<p className="font-mono text-xs text-muted-foreground">{group.summary ?? group.kind}</p>
			)}

			{group.state === "awaiting_approval" && (
				<ApprovalCard
					item={{ kind: "group", group }}
					nodeNames={lookups.nodeNames}
					tokenNames={lookups.tokenNames}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body) =>
						decide.mutate(
							{ kind: "group", id: group.id, body },
							{ onSuccess: () => toast.success(t`Decision recorded.`) },
						)
					}
				/>
			)}

			{group.state === "awaiting_authorization" && (
				<AuthorizationWait
					kind="group"
					id={group.id}
					onChanged={onChanged}
					waiting={
						<p className="text-sm text-muted-foreground">
							<Trans>Waiting for the owner's authorization; the payload is being prepared.</Trans>
						</p>
					}
				/>
			)}

			{group.state === "rejected" && group.approval?.decision && <DecisionView decision={group.approval.decision} />}

			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full text-sm">
					<thead className="bg-muted/60 text-xs text-muted-foreground">
						<tr>
							<th className="px-2 py-1.5 text-left font-medium">
								<Trans>Node</Trans>
							</th>
							<th className="px-2 py-1.5 text-left font-medium">
								<Trans>State</Trans>
							</th>
							<th className="px-2 py-1.5 text-left font-medium">
								<Trans>Outcome</Trans>
							</th>
							<th className="px-2 py-1.5 text-left font-medium">
								<Trans>Output</Trans>
							</th>
						</tr>
					</thead>
					<tbody>
						{group.tasks.map((task) => (
							<tr key={task.id} className="border-t align-top" data-testid="task-group-member" data-task-id={task.id}>
								<td className="px-2 py-2">
									<Link
										to="/nodes/$nodeId"
										params={{ nodeId: task.nodeId }}
										className="text-primary underline underline-offset-2"
									>
										{nodeName(task.nodeId)}
									</Link>
								</td>
								<td className="px-2 py-2">
									<TaskStatusBadge state={task.state} exitCode={task.exitCode} signal={task.signal} />
								</td>
								<td className="px-2 py-2 text-xs">
									<TaskOutcomeText task={task} />
								</td>
								<td className="px-2 py-2">
									<details>
										<summary className="cursor-pointer text-xs text-primary underline underline-offset-2">
											<Trans>Show</Trans>
										</summary>
										<div className="mt-2 min-w-80">
											<TaskResult task={task} />
										</div>
									</details>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{group.skipped.length > 0 && (
				<p className="text-xs text-muted-foreground">
					<Trans>Skipped: {skipped}</Trans>
					{group.state === "interrupted" && <Trans> (the batch was interrupted)</Trans>}
				</p>
			)}
		</section>
	);
}
