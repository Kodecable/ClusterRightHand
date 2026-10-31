import { zodResolver } from "@hookform/resolvers/zod";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { SelectField, TextField } from "@/components/form";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/features/auth/session";
import type { User, UserGroup, UserKind } from "@/lib/api/types";
import {
	useAddGroupMember,
	useCreateGroup,
	useCreateUser,
	useDeleteGroup,
	useRemoveGroupMember,
	useSetUserPassword,
	useUpdateUser,
	useUserGroups,
	useUsers,
} from "./api";

interface NewUserValues {
	username: string;
	displayName: string;
	kind: UserKind;
	password: string;
}

function NewUserDialog({ onClose }: { onClose: () => void }) {
	const { t } = useLingui();
	const create = useCreateUser();
	const schema = useMemo(
		() =>
			z.object({
				username: z.string().trim().min(1, t`A username is required.`),
				displayName: z.string().max(100, t`The display name must be at most 100 characters.`),
				kind: z.enum(["admin", "member"]),
				password: z
					.string()
					.refine((value) => value === "" || value.length >= 8, t`Use at least 8 characters, or leave it empty.`),
			}),
		[t],
	);
	const form = useForm<NewUserValues>({
		resolver: zodResolver(schema),
		defaultValues: { username: "", displayName: "", kind: "member", password: "" },
	});
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`New user`}
			description={t`A user without a password cannot sign in until an administrator sets one.`}
			busy={create.isPending}
			submitLabel={t`Create user`}
			onSubmit={() =>
				void form.handleSubmit((values) => {
					create.mutate(
						{
							username: values.username.trim(),
							displayName: values.displayName.trim() || undefined,
							kind: values.kind,
							password: values.password === "" ? undefined : values.password,
						},
						{
							onSuccess: () => {
								toast.success(t`User created.`);
								onClose();
							},
							onError: (error) => toast.error(error.message),
						},
					);
				})()
			}
		>
			<TextField control={form.control} name="username" label={t`Username`} autoComplete="off" />
			<TextField control={form.control} name="displayName" label={t`Display name`} />
			<SelectField
				control={form.control}
				name="kind"
				label={t`Kind`}
				options={[
					{ value: "member", label: t`Member` },
					{ value: "admin", label: t`Administrator` },
				]}
			/>
			<TextField
				control={form.control}
				name="password"
				type="password"
				label={t`Password`}
				autoComplete="new-password"
				description={t`Optional; at least 8 characters.`}
			/>
		</FormDialog>
	);
}

function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
	const { t } = useLingui();
	const setPasswordMutation = useSetUserPassword();
	const schema = useMemo(() => z.object({ password: z.string().min(8, t`Use at least 8 characters.`) }), [t]);
	const form = useForm<{ password: string }>({
		resolver: zodResolver(schema),
		defaultValues: { password: "" },
	});
	const submit = form.handleSubmit((values) => {
		setPasswordMutation.mutate(
			{ id: user.id, password: values.password },
			{
				onSuccess: () => {
					toast.success(t`Password set.`);
					onClose();
				},
				onError: (error) => toast.error(error.message),
			},
		);
	});
	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Reset the password of ${user.username}`}
			description={t`The user can sign in with this password immediately.`}
			busy={setPasswordMutation.isPending}
			submitLabel={t`Set password`}
			onSubmit={() => void submit()}
		>
			<TextField
				control={form.control}
				name="password"
				type="password"
				label={t`New password`}
				autoComplete="new-password"
				description={t`At least 8 characters.`}
			/>
		</FormDialog>
	);
}

function KindSelect({ user }: { user: User }) {
	const { t } = useLingui();
	const update = useUpdateUser();
	return (
		<Select
			value={user.kind}
			disabled={update.isPending}
			onValueChange={(next) =>
				update.mutate(
					{ id: user.id, patch: { kind: next as UserKind } },
					{
						onSuccess: () => toast.success(t`User updated.`),
						onError: (error) => toast.error(error.message),
					},
				)
			}
		>
			<SelectTrigger aria-label={t`Kind of ${user.username}`} className="h-7 w-40">
				<SelectValue>{(current: string | null) => (current === "admin" ? t`Administrator` : t`Member`)}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="member">{t`Member`}</SelectItem>
				<SelectItem value="admin">{t`Administrator`}</SelectItem>
			</SelectContent>
		</Select>
	);
}

function GroupCard({ group, users }: { group: UserGroup; users: User[] }) {
	const { t } = useLingui();
	const add = useAddGroupMember();
	const remove = useRemoveGroupMember();
	const removeGroup = useDeleteGroup();
	const [pick, setPick] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const names = new Map(users.map((user) => [user.id, user.username]));
	const candidates = users.filter((user) => !group.memberIds.includes(user.id));
	return (
		<Card data-testid="group-card" data-group={group.name}>
			<CardHeader className="flex flex-row items-center justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<CardTitle className="text-sm">{group.name}</CardTitle>
					<code className="truncate font-mono text-xs text-muted-foreground">{group.id}</code>
				</div>
				<Button
					type="button"
					size="xs"
					variant="destructive"
					aria-label={t`Delete group ${group.name}`}
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
										{
											onSuccess: () => toast.success(t`Member removed.`),
											onError: (error) => toast.error(error.message),
										},
									)
								}
							>
								<XIcon />
							</Button>
						</li>
					))}
				</ul>
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
									onError: (error) => toast.error(error.message),
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
				title={t`Delete group ${group.name}?`}
				description={t`Shares to this group are removed.`}
				confirmLabel={t`Delete group`}
				busy={removeGroup.isPending}
				onConfirm={() =>
					removeGroup.mutate(group.id, {
						onSuccess: () => {
							toast.success(t`Group deleted.`);
							setConfirmDelete(false);
						},
						onError: (error) => toast.error(error.message),
					})
				}
			/>
		</Card>
	);
}

function GroupsSection({ users }: { users: User[] }) {
	const { t } = useLingui();
	const groups = useUserGroups();
	const createGroup = useCreateGroup();
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
					createGroup.mutate(name.trim(), {
						onSuccess: () => {
							toast.success(t`Group created.`);
							setName("");
						},
						onError: (error) => toast.error(error.message),
					});
				}}
			>
				<div className="grid min-w-56 gap-1.5">
					<Label htmlFor={`${prefix}-group-name`}>{t`Group name`}</Label>
					<Input
						id={`${prefix}-group-name`}
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<Button type="submit" variant="outline" disabled={createGroup.isPending || name.trim() === ""}>
					<PlusIcon />
					<Trans>Create group</Trans>
				</Button>
			</form>
			{groups.isError && (
				<p role="alert" className="text-sm text-danger">
					{groups.error.message}
				</p>
			)}
			{groups.data && groups.data.length === 0 && (
				<p className="text-sm text-muted-foreground">
					<Trans>No groups yet.</Trans>
				</p>
			)}
			<div className="grid gap-3 lg:grid-cols-2">
				{(groups.data ?? []).map((group) => (
					<GroupCard key={group.id} group={group} users={users} />
				))}
			</div>
		</section>
	);
}

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
	const [creating, setCreating] = useState(false);
	const [resetting, setResetting] = useState<User>();
	const [confirmDisable, setConfirmDisable] = useState<User>();

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
				cell: ({ row }) => <KindSelect user={row.original} />,
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
								title={self ? t`You cannot disable yourself` : undefined}
								onClick={() => {
									if (disable) setConfirmDisable(user);
									else
										update.mutate(
											{ id: user.id, patch: { status: "active" } },
											{
												onSuccess: () => toast.success(t`User enabled.`),
												onError: (error) => toast.error(error.message),
											},
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
		[me?.id, t, update],
	);

	return (
		<Page data-testid="users-page">
			<PageHeader
				title={<Trans>Users</Trans>}
				description={<Trans>Accounts that can sign in to the console; groups carry node access.</Trans>}
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
			<GroupsSection users={users.data ?? []} />
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
							onError: (error) => toast.error(error.message),
						},
					);
				}}
			/>
		</Page>
	);
}
