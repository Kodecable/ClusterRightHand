import type { UserGroup } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { DateTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { useUserGroups } from "./api";
import { UserGroupNameDialog } from "./user-group-dialogs";

/**
 * The user groups and their size (doc/webui.md "Users"): the list only
 * navigates. Creating, renaming and membership editing live on the group's
 * page; "Create user group" stays here as the section's primary action.
 */
export function UserGroupsSection() {
	const { t } = useLingui();
	const groups = useUserGroups();
	const [creating, setCreating] = useState(false);

	const columns = useMemo<DataTableColumn<UserGroup>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => <span className="truncate font-medium">{row.original.name}</span>,
			},
			{
				id: "members",
				header: t`Members`,
				size: 140,
				cell: ({ row }) => <Plural value={row.original.memberIds.length} one="# member" other="# members" />,
			},
			{
				id: "created",
				header: t`Created`,
				size: 200,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
		],
		[t],
	);

	return (
		<section className="grid gap-3" aria-labelledby="user-groups-heading" data-testid="user-groups">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="user-groups-heading" className="text-sm font-semibold">
					<Trans>User groups</Trans>
				</h2>
				<Button type="button" onClick={() => setCreating(true)} data-testid="create-user-group">
					<PlusIcon />
					<Trans>Create user group</Trans>
				</Button>
			</div>
			<DataTable
				label={t`User groups`}
				columns={columns}
				data={groups.data ?? []}
				getRowId={(group) => group.id}
				loading={groups.isLoading}
				error={groups.isError ? groups.error : undefined}
				onRetry={() => void groups.refetch()}
				rowLink={(group) => ({ to: "/user-groups/$userGroupId", params: { userGroupId: group.id } })}
				rowLabel={(group) => group.name}
				empty={<EmptyState title={<Trans>No user groups yet</Trans>} />}
			/>
			{creating && <UserGroupNameDialog onClose={() => setCreating(false)} />}
		</section>
	);
}
