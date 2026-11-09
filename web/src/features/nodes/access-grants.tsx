import type { AccessTargetType, GranteeType, NodeAccessGrant } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog, FormDialog } from "@/components/dialogs";
import { ErrorState } from "@/components/error-state";
import { FieldShell } from "@/components/form";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/features/auth/session";
import { useUserGroups, useUsers } from "@/features/users/api";
import { ApiError, errorMessage } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { useCreateNodeAccessGrant, useDeleteNodeAccessGrant, useNodeAccessGrants } from "./access-api";

/** The display name of a grantee; a deleted one stays identifiable as such. */
function granteeDisplayName(i18n: I18n, grant: Pick<NodeAccessGrant, "granteeType" | "granteeName">): string {
	if (grant.granteeName !== null) return grant.granteeName;
	return i18n._(grant.granteeType === "user" ? msg`Deleted user` : msg`Deleted user group`);
}

/** The display name of a grant's target (a node or a node group). */
function targetDisplayName(i18n: I18n, grant: Pick<NodeAccessGrant, "targetType" | "targetName">): string {
	if (grant.targetName !== null) return grant.targetName;
	return i18n._(grant.targetType === "node" ? msg`Deleted node` : msg`Deleted node group`);
}

/** A "User" / "User group" badge, so a name alone never hides which kind of grantee it is. */
function GranteeTypeBadge({ type }: { type: GranteeType }) {
	return (
		<span className="rounded-md border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
			{type === "user" ? <Trans>User</Trans> : <Trans>User group</Trans>}
		</span>
	);
}

/** A link to the target of a grant; a deleted target has no page left to link to. */
export function AccessTargetLink({ grant, className }: { grant: NodeAccessGrant; className?: string }) {
	const { t } = useLingui();
	if (grant.targetName === null) {
		return (
			<span className={cn("italic text-muted-foreground", className)}>
				{grant.targetType === "node" ? <Trans>Deleted node</Trans> : <Trans>Deleted node group</Trans>}
			</span>
		);
	}
	if (grant.targetType === "node") {
		return (
			<Link
				to="/nodes/$nodeId"
				params={{ nodeId: grant.targetId }}
				className={cn("text-primary underline underline-offset-2", className)}
			>
				{grant.targetName}
			</Link>
		);
	}
	return (
		<Link
			to="/node-groups/$nodeGroupId"
			params={{ nodeGroupId: grant.targetId }}
			className={cn("text-primary underline underline-offset-2", className)}
			title={t`Node group`}
		>
			{grant.targetName}
		</Link>
	);
}

/** The confirmation of removing one grant; shared by the target page and the users page. */
function RemoveGrantDialog({
	grant,
	targetType,
	onClose,
}: {
	grant: NodeAccessGrant;
	targetType: AccessTargetType;
	onClose: () => void;
}) {
	const { t, i18n } = useLingui();
	const remove = useDeleteNodeAccessGrant();
	const name = granteeDisplayName(i18n, grant);
	return (
		<ConfirmDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t`Remove access for ${name}?`}
			description={
				targetType === "node" ? (
					<Trans>They can no longer see this node or run tasks on it.</Trans>
				) : (
					<Trans>They can no longer see the nodes in this node group or run tasks on them.</Trans>
				)
			}
			confirmLabel={t`Remove access`}
			busy={remove.isPending}
			onConfirm={() =>
				remove.mutate(grant.id, {
					onSuccess: () => {
						onClose();
					},
				})
			}
		>
			{remove.error !== null && remove.error !== undefined && <ErrorState error={remove.error} compact />}
		</ConfirmDialog>
	);
}

/**
 * The access grants a user or a user group holds, as the users page shows them: read-only target links with a
 * remove action (access is granted from a node or a node group page).
 */
export function GranteeAccessList({
	grants,
	empty,
	className,
}: {
	grants: NodeAccessGrant[];
	empty?: React.ReactNode;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const [removing, setRemoving] = useState<NodeAccessGrant>();
	if (grants.length === 0) {
		return (
			<span className={cn("text-xs whitespace-normal text-muted-foreground", className)}>
				{empty ?? <Trans>No access.</Trans>}
			</span>
		);
	}
	return (
		<div className={cn("flex flex-wrap items-center gap-1 whitespace-normal", className)}>
			{grants.map((grant) => {
				const target = targetDisplayName(i18n, grant);
				const grantee = granteeDisplayName(i18n, grant);
				return (
					<span
						key={grant.id}
						className="inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs"
						data-testid="grantee-access-grant"
					>
						<AccessTargetLink grant={grant} />
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label={t`Remove access to ${target} for ${grantee}`}
							onClick={() => setRemoving(grant)}
						>
							<XIcon />
						</Button>
					</span>
				);
			})}
			{removing && (
				<RemoveGrantDialog grant={removing} targetType={removing.targetType} onClose={() => setRemoving(undefined)} />
			)}
		</div>
	);
}

/** The "Add access" dialog: pick a user or a user group and grant it access to the page's target. */
function AddAccessDialog({
	targetType,
	targetId,
	onClose,
}: {
	targetType: AccessTargetType;
	targetId: string;
	onClose: () => void;
}) {
	const { t } = useLingui();
	const users = useUsers();
	const userGroups = useUserGroups();
	const create = useCreateNodeAccessGrant();
	const [granteeType, setGranteeType] = useState<GranteeType>("user");
	const [granteeId, setGranteeId] = useState("");

	const options = useMemo(
		() =>
			granteeType === "user"
				? (users.data ?? [])
						.filter((user) => user.status === "active")
						// The grant list shows the server's granteeName, which is the username for a user.
						.map((user) => ({ id: user.id, label: user.username }))
				: (userGroups.data ?? []).map((group) => ({ id: group.id, label: group.name })),
		[granteeType, userGroups.data, users.data],
	);

	const error =
		create.error instanceof ApiError && create.error.status === 409
			? t`This user or user group already has access.`
			: create.error
				? errorMessage(create.error)
				: undefined;

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>Add access</Trans>}
			description={
				targetType === "node" ? (
					<Trans>A granted user or user group can see this node and run tasks on it.</Trans>
				) : (
					<Trans>A granted user or user group can see the nodes in this node group and run tasks on them.</Trans>
				)
			}
			submitLabel={<Trans>Add access</Trans>}
			busy={create.isPending}
			submitDisabled={granteeId === ""}
			error={error}
			onSubmit={() =>
				create.mutate(
					{ granteeType, granteeId, targetType, targetId },
					{
						onSuccess: () => {
							onClose();
						},
					},
				)
			}
			testId="add-access-dialog"
		>
			<div className="grid gap-1.5">
				<Label htmlFor="add-access-type">{t`Type`}</Label>
				<Select
					value={granteeType}
					onValueChange={(next) => {
						if (next !== "user" && next !== "user_group") return;
						setGranteeType(next);
						setGranteeId("");
					}}
				>
					<SelectTrigger id="add-access-type">
						<SelectValue>
							{(current: string | null) => (current === "user_group" ? t`User group` : t`User`)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="user">
							<Trans>User</Trans>
						</SelectItem>
						<SelectItem value="user_group">
							<Trans>User group</Trans>
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<FieldShell
				id="add-access-grantee"
				label={granteeType === "user" ? t`User` : t`User group`}
				description={granteeType === "user" ? undefined : t`Every current member of the user group gets access.`}
			>
				<Select value={granteeId === "" ? null : granteeId} onValueChange={(next) => setGranteeId(String(next ?? ""))}>
					<SelectTrigger id="add-access-grantee">
						<SelectValue placeholder={t`Select…`}>
							{(current: string | null) => options.find((option) => option.id === current)?.label ?? t`Select…`}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{options.map((option) => (
							<SelectItem key={option.id} value={option.id}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</FieldShell>
			{options.length === 0 && !users.isLoading && !userGroups.isLoading && (
				<p className="text-sm text-muted-foreground">
					{granteeType === "user" ? <Trans>No users.</Trans> : <Trans>No user groups.</Trans>}
				</p>
			)}
		</FormDialog>
	);
}

/**
 * The admin-only "Access" section of a node or node group page (D108,
 * doc/access-control.md#归属访问授权与分享): who may see and run tasks on the
 * target, the Add access dialog and a confirmed remove. Everyone else does not
 * see the section at all.
 */
export function NodeAccessSection({
	targetType,
	targetId,
	targetName,
}: {
	targetType: AccessTargetType;
	targetId: string;
	targetName: string;
}) {
	const { t, i18n } = useLingui();
	const admin = useAuth().user?.kind === "admin";
	const grants = useNodeAccessGrants({ targetType, targetId }, admin);
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<NodeAccessGrant>();

	if (!admin) return null;
	const rows = grants.data ?? [];

	return (
		<section className="grid gap-2" aria-labelledby="node-access-heading" data-testid="node-access">
			<h2 id="node-access-heading" className="text-sm font-semibold">
				<Trans>Access</Trans>
			</h2>
			<p className="max-w-3xl text-sm text-muted-foreground">
				{targetType === "node" ? (
					<Trans>A granted user or user group can see this node and run tasks on it.</Trans>
				) : (
					<Trans>A granted user or user group can see the nodes in this node group and run tasks on them.</Trans>
				)}
			</p>
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					<Trans>No access grants yet.</Trans>
				</p>
			) : (
				<div className="overflow-auto rounded-lg border">
					<Table aria-label={t`Access grants for ${targetName}`}>
						<TableHeader>
							<TableRow>
								<TableHead>{t`Grantee`}</TableHead>
								<TableHead>{t`Added`}</TableHead>
								<TableHead className="w-24" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((grant) => {
								const name = granteeDisplayName(i18n, grant);
								return (
									<TableRow key={grant.id}>
										<TableCell>
											<span className="flex flex-wrap items-center gap-1.5">
												<GranteeTypeBadge type={grant.granteeType} />
												{grant.granteeName !== null ? (
													<span>{name}</span>
												) : (
													<span className="italic text-muted-foreground">{name}</span>
												)}
											</span>
										</TableCell>
										<TableCell>
											<RelativeTime value={grant.createdAt} className="text-xs" />
										</TableCell>
										<TableCell>
											<Button
												type="button"
												variant="destructive"
												size="xs"
												aria-label={t`Remove access for ${name}`}
												onClick={() => setRemoving(grant)}
											>
												<Trans>Remove</Trans>
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}
			{grants.error !== null && grants.error !== undefined && (
				<ErrorState error={grants.error} compact retry={() => void grants.refetch()} />
			)}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="justify-self-start"
				data-testid="add-access"
				onClick={() => setAdding(true)}
			>
				<PlusIcon />
				<Trans>Add access</Trans>
			</Button>
			{adding && <AddAccessDialog targetType={targetType} targetId={targetId} onClose={() => setAdding(false)} />}
			{removing && (
				<RemoveGrantDialog grant={removing} targetType={targetType} onClose={() => setRemoving(undefined)} />
			)}
		</section>
	);
}
