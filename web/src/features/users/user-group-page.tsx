import type { User, UserGroupMember } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { TableEmpty } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { RowRemoveButton } from "@/components/row-remove-button";
import { SectionHeader } from "@/components/section";
import { PageSkeleton } from "@/components/skeletons";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { LibrarySection } from "@/features/library/library-section";
import { GranteeNodeAccessSection } from "@/features/nodes/access-grants";
import { linkClass } from "@/lib/utils";
import { useDeleteUserGroup, useRemoveUserGroupMember, useUserGroup, useUsers } from "./api";
import { UserGroupAddMemberDialog, UserGroupNameDialog } from "./user-group-dialogs";

/** A member's role and status come from the users list; a deleted account has neither. */
function memberUser(users: Map<string, User>, member: UserGroupMember): User | undefined {
	return users.get(member.id);
}

/**
 * One user group (doc/design/webui.md "User and user group pages"): its creation time, a members table
 * whose section action adds a member, its node access and, for administrators,
 * rename and delete in the page header.
 */
export function UserGroupDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { userGroupId?: string };
	const id = params.userGroupId ?? "";
	const group = useUserGroup(id);
	const users = useUsers();
	const remove = useRemoveUserGroupMember();
	const removeGroup = useDeleteUserGroup();
	const navigate = useNavigate();
	const [adding, setAdding] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [removingMember, setRemovingMember] = useState<UserGroupMember>();
	const usersById = useMemo(() => new Map((users.data ?? []).map((user) => [user.id, user])), [users.data]);
	const groupName = group.data?.name ?? "";
	const columns = useMemo<DataTableColumn<UserGroupMember>[]>(
		() => [
			{
				id: "member",
				header: t`User`,
				minSize: 160,
				cell: ({ row }) => {
					const user = memberUser(usersById, row.original);
					const name = user?.displayName || user?.username || row.original.displayName || row.original.username;
					return <span className="truncate font-medium">{name}</span>;
				},
				meta: {
					title: (member: UserGroupMember) => {
						const user = memberUser(usersById, member);
						return user?.displayName || user?.username || member.displayName || member.username;
					},
				},
			},
			{
				id: "role",
				header: t`Role`,
				size: 120,
				cell: ({ row }) => {
					const user = memberUser(usersById, row.original);
					if (user === undefined) return <span className="text-muted-foreground">–</span>;
					return <span className="truncate">{user.kind === "admin" ? t`Administrator` : t`Member`}</span>;
				},
			},
			{
				id: "status",
				header: t`Status`,
				size: 90,
				cell: ({ row }) => {
					const user = memberUser(usersById, row.original);
					if (user === undefined) return <span className="text-muted-foreground">–</span>;
					return (
						<StatusText tone={user.status === "active" ? "ok" : "muted"}>
							{user.status === "active" ? t`Active` : t`Disabled`}
						</StatusText>
					);
				},
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 90,
				cell: ({ row }) => (
					<RowRemoveButton
						label={t`Remove ${row.original.username} from ${groupName}`}
						onClick={() => setRemovingMember(row.original)}
					/>
				),
			},
		],
		[groupName, t, usersById],
	);

	if (group.isError) {
		return (
			<Page width="detail">
				<ErrorState error={group.error} retry={() => void group.refetch()} />
			</Page>
		);
	}
	if (!group.data) {
		return (
			<Page width="detail">
				<PageSkeleton />
			</Page>
		);
	}
	const details = group.data;

	return (
		<Page width="detail" data-testid="user-group-detail">
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
				title={details.name}
				description={
					<span className="text-sm text-muted-foreground">
						<Trans>User group</Trans>
					</span>
				}
				actions={
					<>
						<Button type="button" variant="outline" size="sm" onClick={() => setRenaming(true)}>
							<PencilIcon />
							<Trans>Rename</Trans>
						</Button>
						<Button type="button" variant="destructive" size="sm" onClick={() => setDeleting(true)}>
							<Trash2Icon />
							<Trans>Delete</Trans>
						</Button>
					</>
				}
			/>

			<KeyValueList items={[{ label: t`Created`, value: <DateTime value={details.createdAt} /> }]} />

			<LibrarySection reference={`group:${details.name}`} />

			<section className="grid gap-2" aria-labelledby="user-group-members-heading" data-testid="user-group-members">
				<SectionHeader
					id="user-group-members-heading"
					title={<Trans>Members</Trans>}
					actions={
						<Button type="button" size="sm" variant="outline" data-testid="add-member" onClick={() => setAdding(true)}>
							<PlusIcon />
							<Trans>Add member</Trans>
						</Button>
					}
				/>
				<DataTable
					label={t`Members of ${details.name}`}
					columns={columns}
					data={details.members}
					getRowId={(member) => member.id}
					rowLink={(member) => ({ to: "/users/$userId", params: { userId: member.id } })}
					rowLabel={(member) => {
						const user = memberUser(usersById, member);
						return user?.displayName || user?.username || member.displayName || member.username;
					}}
					empty={
						<TableEmpty>
							<Trans>No members</Trans>
						</TableEmpty>
					}
				/>
			</section>

			<GranteeNodeAccessSection granteeType="user_group" granteeId={details.id} />

			{adding && (
				<UserGroupAddMemberDialog
					group={{ id: details.id, name: details.name, memberIds: details.members.map((member) => member.id) }}
					onClose={() => setAdding(false)}
				/>
			)}
			{renaming && (
				<UserGroupNameDialog group={{ id: details.id, name: details.name }} onClose={() => setRenaming(false)} />
			)}
			{removingMember && (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setRemovingMember(undefined);
					}}
					title={t`Remove ${removingMember.username} from ${details.name}?`}
					description={t`They lose the node access this user group grants.`}
					confirmLabel={<Trans>Remove</Trans>}
					busy={remove.isPending}
					onConfirm={() =>
						remove.mutate(
							{ groupId: details.id, userId: removingMember.id },
							{
								onSuccess: () => {
									setRemovingMember(undefined);
								},
							},
						)
					}
				>
					{remove.error !== null && remove.error !== undefined && <ErrorState error={remove.error} compact />}
				</ConfirmDialog>
			)}
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={t`Delete user group ${details.name}?`}
				description={t`Shares to this user group are removed, and its members lose the node access it grants.`}
				confirmLabel={<Trans>Delete user group</Trans>}
				busy={removeGroup.isPending}
				onConfirm={() =>
					removeGroup.mutate(details.id, {
						onSuccess: () => {
							void navigate({ to: "/users" });
						},
					})
				}
			>
				{removeGroup.error !== null && removeGroup.error !== undefined && (
					<div className="grid gap-2">
						<ErrorState error={removeGroup.error} compact retry={() => void removeGroup.reset()} />
						<Link
							to="/library/$library"
							params={{ library: `group:${details.name}` }}
							search={{}}
							className={linkClass}
						>
							<Trans>Open the library to delete its files</Trans>
						</Link>
					</div>
				)}
			</ConfirmDialog>
		</Page>
	);
}
