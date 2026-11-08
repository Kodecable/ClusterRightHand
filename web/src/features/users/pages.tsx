import type { NodeAccessGrant, User } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { useNodeAccessGrants } from "@/features/nodes/access-api";
import { GranteeAccessList } from "@/features/nodes/access-grants";
import { useUpdateUser, useUsers } from "./api";
import { KindSelect } from "./kind-select";
import { NewUserDialog } from "./new-user-dialog";
import { ResetPasswordDialog } from "./reset-password-dialog";
import { UserGroupsSection } from "./user-groups-section";

/**
 * Users and user groups (administrators only, doc/webui.md "Users"): create
 * users, change their kind, disable/enable them, reset their password, and
 * manage group membership.
 */
export function UsersPage() {
	const { t } = useLingui();
	const me = useAuth().user;
	const users = useUsers();
	const update = useUpdateUser();
	const grants = useNodeAccessGrants(undefined, me?.kind === "admin");
	const [creating, setCreating] = useState(false);
	const [resetting, setResetting] = useState<User>();
	const [confirmDisable, setConfirmDisable] = useState<User>();

	// The page is administrators-only; one list feeds each row and each user group card.
	const grantsByGrantee = useMemo(() => {
		const map = new Map<string, NodeAccessGrant[]>();
		for (const grant of grants.data ?? []) {
			const key = `${grant.granteeType}:${grant.granteeId}`;
			const list = map.get(key);
			if (list) list.push(grant);
			else map.set(key, [grant]);
		}
		return map;
	}, [grants.data]);

	const columns = useMemo<DataTableColumn<User>[]>(
		() => [
			{
				id: "username",
				header: t`Username`,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.username}</span>,
			},
			{
				id: "displayName",
				header: t`Display name`,
				cell: ({ row }) => <span className="truncate text-xs">{row.original.displayName}</span>,
			},
			{
				id: "kind",
				header: t`Kind`,
				size: 170,
				cell: ({ row }) => <KindSelect user={row.original} self={row.original.id === me?.id} />,
			},
			{
				id: "nodeAccess",
				header: t`Node access`,
				size: 260,
				cell: ({ row }) => <GranteeAccessList grants={grantsByGrantee.get(`user:${row.original.id}`) ?? []} />,
			},
			{
				id: "status",
				header: t`Status`,
				size: 110,
				cell: ({ row }) => (
					<StatusBadge tone={row.original.status === "active" ? "ok" : "muted"}>
						{row.original.status === "active" ? t`Active` : t`Disabled`}
					</StatusBadge>
				),
			},
			{
				id: "created",
				header: t`Created`,
				size: 120,
				cell: ({ row }) => <RelativeTime value={row.original.createdAt} className="text-xs" />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 200,
				cell: ({ row }) => {
					const user = row.original;
					const self = user.id === me?.id;
					const disable = user.status === "active";
					return (
						<span className="flex flex-nowrap items-center gap-1">
							<Button
								type="button"
								size="xs"
								variant={disable ? "destructive" : "outline"}
								disabled={self || update.isPending}
								title={self ? t`You cannot disable your own account.` : undefined}
								onClick={() => {
									if (disable) setConfirmDisable(user);
									else
										update.mutate(
											{ id: user.id, patch: { status: "active" } },
											{ onSuccess: () => toast.success(t`User enabled.`) },
										);
								}}
							>
								{disable ? <Trans>Disable</Trans> : <Trans>Enable</Trans>}
							</Button>
							<Button type="button" size="xs" variant="outline" onClick={() => setResetting(user)}>
								<Trans>Reset password</Trans>
							</Button>
						</span>
					);
				},
			},
		],
		[grantsByGrantee, me?.id, t, update],
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
				empty={<EmptyState title={<Trans>No users yet</Trans>} />}
			/>
			<UserGroupsSection users={users.data ?? []} grantsByGrantee={grantsByGrantee} />
			{creating && <NewUserDialog onClose={() => setCreating(false)} />}
			{resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(undefined)} />}
			<ConfirmDialog
				open={confirmDisable !== undefined}
				onOpenChange={(open) => {
					if (!open) setConfirmDisable(undefined);
				}}
				title={confirmDisable ? t`Disable ${confirmDisable.username}?` : ""}
				description={t`They are signed out and cannot sign in again until you enable them.`}
				confirmLabel={t`Disable user`}
				busy={update.isPending}
				onConfirm={() => {
					if (!confirmDisable) return;
					update.mutate(
						{ id: confirmDisable.id, patch: { status: "disabled" } },
						{
							onSuccess: () => {
								toast.success(t`User disabled.`);
								setConfirmDisable(undefined);
							},
						},
					);
				}}
			/>
		</Page>
	);
}
