import type { NodeAccessGrant, User, UserGroup } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/dialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GranteeAccessList } from "@/features/nodes/access-grants";
import {
	useAddUserGroupMember,
	useCreateUserGroup,
	useDeleteUserGroup,
	useRemoveUserGroupMember,
	useUserGroups,
} from "./api";

function UserGroupCard({
	group,
	users,
	grants,
}: {
	group: UserGroup;
	users: User[];
	/** The node access grants this user group holds. */
	grants: NodeAccessGrant[];
}) {
	const { t } = useLingui();
	const add = useAddUserGroupMember();
	const remove = useRemoveUserGroupMember();
	const removeUserGroup = useDeleteUserGroup();
	const [pick, setPick] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const names = new Map(users.map((user) => [user.id, user.username]));
	const candidates = users.filter((user) => !group.memberIds.includes(user.id));
	return (
		<Card data-testid="user-group-card" data-user-group={group.name}>
			<CardHeader className="flex flex-row items-center justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<CardTitle className="text-sm">{group.name}</CardTitle>
					<code className="truncate font-mono text-xs text-muted-foreground">{group.id}</code>
				</div>
				<Button
					type="button"
					size="xs"
					variant="destructive"
					aria-label={t`Delete user group ${group.name}`}
					onClick={() => setConfirmDelete(true)}
				>
					<Trash2Icon />
					<Trans>Delete</Trans>
				</Button>
			</CardHeader>
			<CardContent className="grid gap-3">
				<ul className="flex flex-wrap gap-1.5" aria-label={t`Members of ${group.name}`}>
					{group.memberIds.length === 0 && (
						<li className="text-sm text-muted-foreground">
							<Trans>No members.</Trans>
						</li>
					)}
					{group.memberIds.map((id) => (
						<li key={id} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
							{names.get(id) ?? id}
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								aria-label={t`Remove ${names.get(id) ?? id} from ${group.name}`}
								disabled={remove.isPending}
								onClick={() =>
									remove.mutate(
										{ groupId: group.id, userId: id },
										{ onSuccess: () => toast.success(t`Member removed.`) },
									)
								}
							>
								<XIcon />
							</Button>
						</li>
					))}
				</ul>
				<div className="grid gap-1.5">
					<span className="text-xs font-medium text-muted-foreground">
						<Trans>Node access</Trans>
					</span>
					<GranteeAccessList grants={grants} />
				</div>
				<div className="flex flex-wrap items-end gap-2">
					<div className="grid min-w-48 gap-1.5">
						<Label htmlFor={`add-member-${group.id}`}>{t`Add member`}</Label>
						<Select value={pick === "" ? null : pick} onValueChange={(next) => setPick(String(next ?? ""))}>
							<SelectTrigger id={`add-member-${group.id}`} className="w-48">
								<SelectValue>
									{(current: string | null) => candidates.find((user) => user.id === current)?.username ?? t`Select…`}
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
								{ groupId: group.id, userId: pick },
								{
									onSuccess: () => {
										toast.success(t`Member added.`);
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
			</CardContent>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={t`Delete user group ${group.name}?`}
				description={t`Shares to this user group are removed.`}
				confirmLabel={t`Delete user group`}
				busy={removeUserGroup.isPending}
				onConfirm={() =>
					removeUserGroup.mutate(group.id, {
						onSuccess: () => {
							toast.success(t`User group deleted.`);
							setConfirmDelete(false);
						},
					})
				}
			/>
		</Card>
	);
}

/** The user groups and their membership (an administrator assigns node access through them). */
export function UserGroupsSection({
	users,
	grantsByGrantee,
}: {
	users: User[];
	/** Node access grants by `${granteeType}:${granteeId}`, for the cards below. */
	grantsByGrantee: Map<string, NodeAccessGrant[]>;
}) {
	const { t } = useLingui();
	const groups = useUserGroups();
	const createUserGroup = useCreateUserGroup();
	const [name, setName] = useState("");
	const prefix = useId();
	return (
		<section className="grid gap-3" aria-labelledby="user-groups-heading" data-testid="user-groups">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="user-groups-heading" className="text-sm font-semibold">
					<Trans>User groups</Trans>
				</h2>
			</div>
			<form
				className="flex flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (name.trim() === "") return;
					createUserGroup.mutate(name.trim(), {
						onSuccess: () => {
							toast.success(t`User group created.`);
							setName("");
						},
					});
				}}
			>
				<div className="grid min-w-56 gap-1.5">
					<Label htmlFor={`${prefix}-group-name`}>{t`User group name`}</Label>
					<Input
						id={`${prefix}-group-name`}
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<Button type="submit" variant="outline" disabled={createUserGroup.isPending || name.trim() === ""}>
					<PlusIcon />
					<Trans>Create user group</Trans>
				</Button>
			</form>
			{groups.isError && (
				<p role="alert" className="text-sm text-danger">
					{groups.error.message}
				</p>
			)}
			{groups.data && groups.data.length === 0 && (
				<p className="text-sm text-muted-foreground">
					<Trans>No user groups yet.</Trans>
				</p>
			)}
			<div className="grid gap-3 lg:grid-cols-2">
				{(groups.data ?? []).map((group) => (
					<UserGroupCard
						key={group.id}
						group={group}
						users={users}
						grants={grantsByGrantee.get(`user_group:${group.id}`) ?? []}
					/>
				))}
			</div>
		</section>
	);
}
