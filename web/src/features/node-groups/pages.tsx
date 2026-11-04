import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PencilIcon, PlusIcon, Trash2Icon, UserPenIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeLink } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { useNodes } from "@/features/nodes/api";
import type { NodeGroup } from "@/lib/api/types";
import { useDeleteNodeGroup, useNodeGroups } from "./api";
import { NodeGroupMembersDialog, NodeGroupNameDialog } from "./dialogs";

/** The members of a node group, each linked to its node page. */
function MemberLinks({ memberIds, nodeNames }: { memberIds: string[]; nodeNames: Map<string, string> }) {
	if (memberIds.length === 0) return <span className="text-xs text-muted-foreground">–</span>;
	return (
		<span className="flex flex-wrap items-center gap-x-1 text-xs">
			{memberIds.map((id, index) => (
				<Fragment key={id}>
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<NodeLink id={id} name={nodeNames.get(id) ?? id} />
				</Fragment>
			))}
		</span>
	);
}

/** The header actions an administrator gets for one node group. */
function AdminActions({
	onRename,
	onEditMembers,
	onDelete,
}: {
	onRename: () => void;
	onEditMembers: () => void;
	onDelete: () => void;
}) {
	return (
		<>
			<Button type="button" variant="outline" size="sm" onClick={onEditMembers}>
				<UserPenIcon />
				<Trans>Edit members</Trans>
			</Button>
			<Button type="button" variant="outline" size="sm" onClick={onRename}>
				<PencilIcon />
				<Trans>Rename</Trans>
			</Button>
			<Button type="button" variant="destructive" size="sm" onClick={onDelete}>
				<Trash2Icon />
				<Trans>Delete</Trans>
			</Button>
		</>
	);
}

/**
 * Every node group (doc/access-control.md#用户模型, D109): members links, the
 * UUID to copy for a crha trust alias and, for administrators, create, rename,
 * delete and member editing. Everyone else sees the list read-only.
 */
export function NodeGroupsPage() {
	const { t } = useLingui();
	const nodes = useNodes();
	const groups = useNodeGroups();
	const admin = useAuth().user?.kind === "admin";
	const remove = useDeleteNodeGroup();
	const [creating, setCreating] = useState(false);
	const [renaming, setRenaming] = useState<NodeGroup>();
	const [deleting, setDeleting] = useState<NodeGroup>();
	const [editingMembers, setEditingMembers] = useState<NodeGroup>();
	const nodeNames = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	const columns = useMemo<DataTableColumn<NodeGroup>[]>(() => {
		const base: DataTableColumn<NodeGroup>[] = [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => (
					<Link
						to="/node-groups/$nodeGroupId"
						params={{ nodeGroupId: row.original.id }}
						className="truncate font-medium text-primary underline underline-offset-2"
					>
						{row.original.name}
					</Link>
				),
			},
			{
				id: "members",
				header: t`Members`,
				size: 320,
				cell: ({ row }) => (
					<span className="grid gap-0.5">
						<span className="text-xs text-muted-foreground">
							<Plural value={row.original.memberIds.length} one="# member" other="# members" />
						</span>
						<MemberLinks memberIds={row.original.memberIds} nodeNames={nodeNames} />
					</span>
				),
			},
			{
				id: "id",
				header: t`Node group id`,
				size: 380,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-1">
						<code className="truncate font-mono text-xs text-muted-foreground">{row.original.id}</code>
						<CopyButton
							text={row.original.id}
							label={t`Copy node group id of ${row.original.name}`}
							variant="ghost"
							size="icon-xs"
						/>
					</span>
				),
			},
		];
		if (!admin) return base;
		return [
			...base,
			{
				id: "actions",
				header: actionsHeader,
				size: 300,
				cell: ({ row }) => {
					const group = row.original;
					return (
						<span className="flex flex-nowrap items-center gap-1">
							<Button type="button" size="xs" variant="outline" onClick={() => setEditingMembers(group)}>
								<Trans>Edit members</Trans>
							</Button>
							<Button type="button" size="xs" variant="outline" onClick={() => setRenaming(group)}>
								<Trans>Rename</Trans>
							</Button>
							<Button type="button" size="xs" variant="destructive" onClick={() => setDeleting(group)}>
								<Trans>Delete</Trans>
							</Button>
						</span>
					);
				},
			},
		];
	}, [admin, nodeNames, t]);

	return (
		<Page data-testid="node-groups-page">
			<PageHeader
				title={<Trans>Node groups</Trans>}
				description={
					<Trans>
						Node groups select several nodes at once, for rules, batch runs and schedules. A node can be in any number
						of node groups.
					</Trans>
				}
				actions={
					admin ? (
						<Button type="button" onClick={() => setCreating(true)} data-testid="create-node-group">
							<PlusIcon />
							<Trans>Create node group</Trans>
						</Button>
					) : undefined
				}
			/>
			<DataTable
				label={t`Node groups`}
				columns={columns}
				data={groups.data ?? []}
				getRowId={(group) => group.id}
				loading={groups.isLoading}
				error={groups.isError ? groups.error : undefined}
				onRetry={() => void groups.refetch()}
				empty={
					<EmptyState
						title={<Trans>No node groups yet</Trans>}
						description={
							admin ? (
								<Trans>Create a node group to run the same task on several nodes.</Trans>
							) : (
								<Trans>An administrator creates node groups.</Trans>
							)
						}
					/>
				}
			/>
			{creating && <NodeGroupNameDialog onClose={() => setCreating(false)} />}
			{renaming && <NodeGroupNameDialog group={renaming} onClose={() => setRenaming(undefined)} />}
			{editingMembers && (
				<NodeGroupMembersDialog
					group={editingMembers}
					nodes={nodes.data ?? []}
					onClose={() => setEditingMembers(undefined)}
				/>
			)}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete node group ${deleting.name}?` : ""}
				description={
					<Trans>
						Its members lose this node group. Rules and task groups that reference it keep the reference and display it
						as deleted.
					</Trans>
				}
				confirmLabel={<Trans>Delete node group</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.id, {
						onSuccess: () => {
							toast.success(t`Node group deleted.`);
							setDeleting(undefined);
						},
					});
				}}
			/>
			{remove.error !== null && remove.error !== undefined && (
				<ErrorState error={remove.error} compact retry={() => void remove.reset()} />
			)}
		</Page>
	);
}

/** One node group: its UUID, member nodes and (for administrators) its actions. */
export function NodeGroupDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { nodeGroupId?: string };
	const id = params.nodeGroupId ?? "";
	const groups = useNodeGroups();
	const nodes = useNodes();
	const admin = useAuth().user?.kind === "admin";
	const remove = useDeleteNodeGroup();
	const navigate = useNavigate();
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [editingMembers, setEditingMembers] = useState(false);
	const group = groups.data?.find((candidate) => candidate.id === id);
	const nodeNames = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);

	if (groups.isError) {
		return (
			<div className="p-4">
				<ErrorState error={groups.error} retry={() => void groups.refetch()} />
			</div>
		);
	}
	if (!groups.data) {
		return (
			<div className="p-4">
				<PageSkeleton />
			</div>
		);
	}
	if (!group) {
		return (
			<Page width="detail" data-testid="node-group-detail">
				<EmptyState
					title={<Trans>No such node group</Trans>}
					description={<Trans>It may have been deleted.</Trans>}
					action={
						<Button variant="outline" render={<Link to="/node-groups" />} nativeButton={false}>
							<Trans>All node groups</Trans>
						</Button>
					}
				/>
			</Page>
		);
	}

	return (
		<Page width="detail" data-testid="node-group-detail">
			<div>
				<Link
					to="/node-groups"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All node groups</Trans>
				</Link>
			</div>
			<PageHeader
				title={group.name}
				description={
					<span className="text-sm text-muted-foreground">
						<Plural value={group.memberIds.length} one="# member" other="# members" />
					</span>
				}
				actions={
					admin ? (
						<AdminActions
							onRename={() => setRenaming(true)}
							onEditMembers={() => setEditingMembers(true)}
							onDelete={() => setDeleting(true)}
						/>
					) : undefined
				}
			/>

			<KeyValueList
				items={[
					{
						label: t`Node group id`,
						value: (
							<span className="flex min-w-0 items-center gap-1">
								<code className="font-mono text-xs">{group.id}</code>
								<CopyButton text={group.id} label={t`Copy node group id`} variant="ghost" size="icon-xs" />
							</span>
						),
					},
				]}
			/>

			<section className="grid gap-2" aria-labelledby="node-group-members-heading">
				<h2 id="node-group-members-heading" className="text-sm font-semibold">
					<Trans>Members</Trans>
				</h2>
				{group.memberIds.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						<Trans>No members.</Trans>
					</p>
				) : (
					<ul className="flex flex-wrap gap-2" aria-label={t`Members of ${group.name}`}>
						{group.memberIds.map((nodeId) => (
							<li key={nodeId} className="rounded-md border px-2 py-1 text-sm">
								<NodeLink id={nodeId} name={nodeNames.get(nodeId) ?? nodeId} />
							</li>
						))}
					</ul>
				)}
				{admin && (
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="justify-self-start"
						onClick={() => setEditingMembers(true)}
					>
						<UserPenIcon />
						<Trans>Edit members</Trans>
					</Button>
				)}
			</section>

			{renaming && <NodeGroupNameDialog group={group} onClose={() => setRenaming(false)} />}
			{editingMembers && (
				<NodeGroupMembersDialog group={group} nodes={nodes.data ?? []} onClose={() => setEditingMembers(false)} />
			)}
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={t`Delete node group ${group.name}?`}
				description={
					<Trans>
						Its members lose this node group. Rules and task groups that reference it keep the reference and display it
						as deleted.
					</Trans>
				}
				confirmLabel={<Trans>Delete node group</Trans>}
				busy={remove.isPending}
				onConfirm={() =>
					remove.mutate(group.id, {
						onSuccess: () => {
							toast.success(t`Node group deleted.`);
							void navigate({ to: "/node-groups" });
						},
					})
				}
			/>
			{remove.error !== null && remove.error !== undefined && (
				<ErrorState error={remove.error} compact retry={() => void remove.reset()} />
			)}
		</Page>
	);
}
