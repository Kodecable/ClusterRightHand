import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyHint } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { PageSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserLink } from "@/components/user-link";
import { GranteeNodeAccessSection } from "@/features/nodes/access-grants";
import { useAddUserGroupMember, useDeleteUserGroup, useRemoveUserGroupMember, useUserGroup, useUsers } from "./api";
import { UserGroupNameDialog } from "./user-group-dialogs";

/** One user group (doc/webui.md "Users"): its members, node access and, for administrators, its actions. */
export function UserGroupDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { userGroupId?: string };
	const id = params.userGroupId ?? "";
	const group = useUserGroup(id);
	const users = useUsers();
	const add = useAddUserGroupMember();
	const remove = useRemoveUserGroupMember();
	const removeGroup = useDeleteUserGroup();
	const navigate = useNavigate();
	const pickId = useId();
	const [pick, setPick] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);

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
	const names = new Map((users.data ?? []).map((user) => [user.id, user.displayName || user.username]));
	const candidates = (users.data ?? []).filter((user) => !details.members.some((member) => member.id === user.id));
	const current = pick === "" ? null : pick;

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

			<section className="grid gap-2" aria-labelledby="user-group-members-heading" data-testid="user-group-members">
				<h2 id="user-group-members-heading" className="text-sm font-medium">
					<Trans>Members</Trans>
				</h2>
				{details.members.length === 0 ? (
					<EmptyHint>
						<Trans>No members</Trans>
					</EmptyHint>
				) : (
					<ul className="flex flex-wrap gap-2" aria-label={t`Members of ${details.name}`}>
						{details.members.map((member) => (
							<li key={member.id} className="inline-flex min-h-8 items-center gap-1 rounded-md border px-2 text-sm">
								<UserLink id={member.id} name={names.get(member.id) ?? member.displayName} />
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t`Remove ${member.username} from ${details.name}`}
									disabled={remove.isPending}
									onClick={() => remove.mutate({ groupId: details.id, userId: member.id })}
								>
									<XIcon />
								</Button>
							</li>
						))}
					</ul>
				)}
				<div className="flex flex-wrap items-end gap-2">
					<div className="grid min-w-48 gap-1.5">
						<Label htmlFor={pickId}>{t`Add member`}</Label>
						<Select value={current} onValueChange={(next) => setPick(String(next ?? ""))}>
							<SelectTrigger id={pickId} className="w-48">
								<SelectValue>
									{(selected: string | null) => candidates.find((user) => user.id === selected)?.username ?? t`Select…`}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{candidates.map((user) => (
									<SelectItem key={user.id} value={user.id}>
										{user.username}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<Button
						type="button"
						size="sm"
						disabled={add.isPending || pick === ""}
						onClick={() =>
							add.mutate(
								{ groupId: details.id, userId: pick },
								{
									onSuccess: () => {
										setPick("");
									},
								},
							)
						}
					>
						<UserPlusIcon />
						<Trans>Add</Trans>
					</Button>
				</div>
				{add.error !== null && add.error !== undefined && <ErrorState error={add.error} compact />}
				{remove.error !== null && remove.error !== undefined && <ErrorState error={remove.error} compact />}
			</section>

			<GranteeNodeAccessSection granteeType="user_group" granteeId={details.id} />

			{renaming && (
				<UserGroupNameDialog group={{ id: details.id, name: details.name }} onClose={() => setRenaming(false)} />
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
			/>
			{removeGroup.error !== null && removeGroup.error !== undefined && (
				<ErrorState error={removeGroup.error} compact retry={() => void removeGroup.reset()} />
			)}
		</Page>
	);
}
