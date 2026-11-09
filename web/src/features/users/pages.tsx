import type { SessionListItem, User } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyHint, EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime, RelativeTime } from "@/components/relative-time";
import { PageSkeleton } from "@/components/skeletons";
import { SessionStatusBadge, StatusText } from "@/components/status-badge";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { GranteeNodeAccessSection } from "@/features/nodes/access-grants";
import { useNodes } from "@/features/nodes/api";
import { useSessions } from "@/features/sessions/api";
import { sessionTitle } from "@/features/sessions/session-item";
import { useTasks } from "@/features/tasks/api";
import { useTaskColumns } from "@/features/tasks/task-columns";
import { isNotFound } from "@/lib/api/client";
import { linkClass } from "@/lib/utils";
import { useUpdateUser, useUser, useUsers } from "./api";
import { KindSelect } from "./kind-select";
import { NewUserDialog } from "./new-user-dialog";
import { ResetPasswordDialog } from "./reset-password-dialog";
import { UserGroupsSection } from "./user-groups-section";

/**
 * Users (administrators only, doc/webui.md "Users"): every account with its
 * role and status. Editing lives on the user's page; the list only navigates,
 * and user groups are a read-only section under it.
 */
export function UsersPage() {
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const users = useUsers();
	const [creating, setCreating] = useState(false);

	const columns = useMemo<DataTableColumn<User>[]>(
		() => [
			{
				id: "username",
				header: t`Username`,
				minSize: 140,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.username}</span>,
				meta: { title: (user: User) => user.username },
			},
			{
				id: "displayName",
				header: t`Display name`,
				minSize: 140,
				cell: ({ row }) =>
					row.original.displayName === "" ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="truncate">{row.original.displayName}</span>
					),
				meta: { title: (user: User) => user.displayName },
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 120,
				cell: ({ row }) => (
					<span className="truncate">
						{row.original.kind === "admin" ? <Trans>Administrator</Trans> : <Trans>Member</Trans>}
					</span>
				),
			},
			{
				id: "status",
				header: t`Status`,
				size: 90,
				cell: ({ row }) => (
					<StatusText tone={row.original.status === "active" ? "ok" : "muted"}>
						{row.original.status === "active" ? t`Active` : t`Disabled`}
					</StatusText>
				),
			},
			{
				id: "created",
				header: t`Created`,
				size: timeWidth,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
		],
		[t, timeWidth],
	);

	return (
		<Page data-testid="users-page">
			<PageHeader
				title={<Trans>Users</Trans>}
				actions={
					<Button type="button" onClick={() => setCreating(true)} data-testid="new-user">
						<PlusIcon />
						<Trans>New user</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`Users`}
				columns={columns}
				data={users.data ?? []}
				getRowId={(user) => user.id}
				loading={users.isLoading}
				error={users.isError ? users.error : undefined}
				onRetry={() => void users.refetch()}
				rowLink={(user) => ({ to: "/users/$userId", params: { userId: user.id } })}
				rowLabel={(user) => user.username}
				empty={<EmptyState bare title={<Trans>No users yet</Trans>} />}
			/>
			<UserGroupsSection />
			{creating && <NewUserDialog onClose={() => setCreating(false)} />}
		</Page>
	);
}

/** The user's recent sessions and tasks; rendered only for an administrator or the user themselves. */
function UserActivity({ user }: { user: User }) {
	const { t } = useLingui();
	const admin = useAuth().user?.kind === "admin";
	const sessions = useSessions({ scope: admin ? "all" : "visible", ownerId: user.id });
	const tasks = useTasks({ userId: user.id, limit: 10 });
	const nodes = useNodes();
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);
	const users = useMemo(
		() => new Map([[user.id, user.displayName || user.username]]),
		[user.displayName, user.id, user.username],
	);
	const taskColumns = useTaskColumns({ users, nodeNames: names });
	// Only the first page: these are a summary of the account, not another list page.
	const sessionRows = sessions.data?.pages[0]?.items ?? [];
	const taskRows = tasks.data?.pages[0]?.items ?? [];

	const sessionColumns = useMemo<DataTableColumn<SessionListItem>[]>(
		() => [
			{
				id: "title",
				header: t`Session`,
				minSize: 160,
				cell: ({ row }) => <span className="truncate">{sessionTitle(row.original, t`New Session`)}</span>,
				meta: { title: (session: SessionListItem) => sessionTitle(session, t`New Session`) },
			},
			{
				id: "state",
				header: t`Status`,
				size: 90,
				cell: ({ row }) => <SessionStatusBadge state={row.original.state} />,
			},
			{
				id: "updated",
				header: t`Updated`,
				size: 110,
				cell: ({ row }) => <RelativeTime value={row.original.updatedAt} />,
			},
		],
		[t],
	);

	return (
		<>
			<section className="grid gap-2" aria-labelledby="user-sessions-heading" data-testid="user-sessions">
				<h2 id="user-sessions-heading" className="text-sm font-medium">
					<Trans>Recent sessions</Trans>
				</h2>
				<DataTable
					label={t`Sessions of ${user.username}`}
					columns={sessionColumns}
					data={sessionRows}
					getRowId={(session) => session.id}
					loading={sessions.isLoading}
					error={sessions.isError ? sessions.error : undefined}
					onRetry={() => void sessions.refetch()}
					rowLink={(session) => ({ to: "/sessions/$sessionId", params: { sessionId: session.id } })}
					rowLabel={(session) => sessionTitle(session, t`New Session`)}
					empty={<EmptyState bare title={<Trans>No sessions yet</Trans>} />}
				/>
			</section>
			<section className="grid gap-2" aria-labelledby="user-tasks-heading" data-testid="user-tasks">
				<h2 id="user-tasks-heading" className="text-sm font-medium">
					<Trans>Recent tasks</Trans>
				</h2>
				<DataTable
					label={t`Tasks of ${user.username}`}
					columns={taskColumns}
					data={taskRows}
					getRowId={(task) => task.id}
					loading={tasks.isLoading}
					error={tasks.isError ? tasks.error : undefined}
					onRetry={() => void tasks.refetch()}
					rowLink={(task) => ({ to: "/tasks/$taskId", params: { taskId: task.id } })}
					rowLabel={(task) => task.summary || task.kind}
					rowLinkColumn="task"
					empty={<EmptyState bare title={<Trans>No tasks yet</Trans>} />}
				/>
			</section>
		</>
	);
}

/**
 * One user (doc/webui.md "Users"): identity and status, the groups it belongs
 * to, its node access, its recent sessions and tasks, and — for administrators
 * — the account edits that used to sit in the users list. A member may open
 * only their own page; every other id renders the same no-access message as a
 * missing one.
 */
export function UserDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { userId?: string };
	const id = params.userId ?? "";
	const me = useAuth().user;
	const admin = me?.kind === "admin";
	const self = me?.id === id;
	const detail = useUser(id);
	const update = useUpdateUser();
	const [confirmDisable, setConfirmDisable] = useState(false);
	const [resetting, setResetting] = useState(false);

	if (detail.isPending) {
		return (
			<Page width="detail">
				<PageSkeleton />
			</Page>
		);
	}
	if (detail.isError) {
		if (isNotFound(detail.error)) {
			return (
				<Page width="detail">
					<ErrorState error={t`This user doesn't exist or you don't have access.`} />
				</Page>
			);
		}
		return (
			<Page width="detail">
				<ErrorState error={detail.error} retry={() => void detail.refetch()} />
			</Page>
		);
	}
	const user = detail.data.user;
	const groups = detail.data.userGroups;

	return (
		<Page width="detail" data-testid="user-detail">
			<div>
				<Link
					to="/users"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All users</Trans>
				</Link>
			</div>
			<PageHeader
				title={user.displayName || user.username}
				actions={
					admin ? (
						<>
							<Button
								type="button"
								size="sm"
								variant={user.status === "active" ? "destructive" : "outline"}
								disabled={self || update.isPending}
								title={self ? t`You cannot disable your own account.` : undefined}
								onClick={() => {
									if (user.status === "active") setConfirmDisable(true);
									else update.mutate({ id: user.id, patch: { status: "active" } });
								}}
							>
								{user.status === "active" ? <Trans>Disable</Trans> : <Trans>Enable</Trans>}
							</Button>
							<Button type="button" size="sm" variant="outline" onClick={() => setResetting(true)}>
								<Trans>Reset password</Trans>
							</Button>
						</>
					) : undefined
				}
			/>

			<KeyValueList
				items={[
					{ label: t`Username`, value: user.username, mono: true },
					{ label: t`Display name`, value: user.displayName },
					{
						label: t`Role`,
						value: admin ? (
							<KindSelect user={user} self={self} />
						) : (
							<span>{user.kind === "admin" ? <Trans>Administrator</Trans> : <Trans>Member</Trans>}</span>
						),
						control: true,
					},
					{
						label: t`Status`,
						value: (
							<StatusText tone={user.status === "active" ? "ok" : "muted"}>
								{user.status === "active" ? t`Active` : t`Disabled`}
							</StatusText>
						),
					},
					{ label: t`Created`, value: <DateTime value={user.createdAt} /> },
				]}
			/>

			<section
				className="grid gap-2"
				aria-labelledby="user-groups-memberships-heading"
				data-testid="user-detail-groups"
			>
				<h2 id="user-groups-memberships-heading" className="text-sm font-medium">
					<Trans>User groups</Trans>
				</h2>
				{groups.length === 0 ? (
					<EmptyHint>
						<Trans>No user groups</Trans>
					</EmptyHint>
				) : (
					<ul className="flex flex-wrap gap-2" aria-label={t`User groups of ${user.username}`}>
						{groups.map((group) => (
							<li key={group.id} className="inline-flex min-h-8 items-center rounded-md border px-2 text-sm">
								<Link to="/user-groups/$userGroupId" params={{ userGroupId: group.id }} className={linkClass}>
									{group.name}
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>

			<GranteeNodeAccessSection granteeType="user" granteeId={user.id} />

			{admin || self ? <UserActivity user={user} /> : null}

			{resetting && <ResetPasswordDialog user={user} onClose={() => setResetting(false)} />}
			<ConfirmDialog
				open={confirmDisable}
				onOpenChange={setConfirmDisable}
				title={t`Disable ${user.username}?`}
				description={t`They are signed out and cannot sign in again until you enable them.`}
				confirmLabel={<Trans>Disable user</Trans>}
				busy={update.isPending}
				onConfirm={() =>
					update.mutate(
						{ id: user.id, patch: { status: "disabled" } },
						{
							onSuccess: () => {
								setConfirmDisable(false);
							},
						},
					)
				}
			/>
		</Page>
	);
}
