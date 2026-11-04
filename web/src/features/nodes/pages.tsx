import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeGroupLinks } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { PageSkeleton } from "@/components/skeletons";
import { NodeStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import type { PublicNode } from "@/lib/api/types";
import { AddNodeDialog } from "./add-node-dialog";
import { AddSshNodeDialog } from "./add-ssh-node-dialog";
import { useNode, useNodes } from "./api";
import { ClockWarning } from "./clock-warning";
import { osName } from "./commands";
import { CrhsKeyPanel } from "./crhs-key-panel";
import { canManageNode, canRunOn } from "./node-access";
import { NodeGroupsDialog } from "./node-groups-dialog";
import { NodeShares } from "./node-shares";
import { NodeTaskList } from "./node-tasks";
import { NodeTrustPanel } from "./node-trust";
import { PendingNodeDialog } from "./pending-node-dialog";
import { RenameNodeButton } from "./rename-node-button";
import { RunPanel } from "./run-panel";
import { SshNodeSection } from "./ssh-node-section";
import { TrustEditor } from "./trust-editor-panel";
import { useTrustSources } from "./trust-sources";

/**
 * Every node the user can see (doc/webui.md "Nodes"): status, connection,
 * clock warning, node groups and access, plus approve/reject for pending nodes.
 * Enrollment and the SSH wizard are the two "Add" flows.
 */
export function NodesPage() {
	const { t } = useLingui();
	const user = useAuth().user;
	const nodes = useNodes();
	const [adding, setAdding] = useState(false);
	const [addingSsh, setAddingSsh] = useState(false);
	const [pending, setPending] = useState<{ node: PublicNode; action: "approve" | "reject" }>();

	const columns = useMemo<DataTableColumn<PublicNode>[]>(() => {
		const canDecide = (node: PublicNode) =>
			node.status === "pending" && (node.access === "owner" || user?.kind === "admin");
		return [
			{
				id: "name",
				header: t`Name`,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-2">
						<Link
							to="/nodes/$nodeId"
							params={{ nodeId: row.original.id }}
							className="truncate font-medium text-primary underline underline-offset-2"
						>
							{row.original.name}
						</Link>
						{row.original.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
					</span>
				),
			},
			{
				id: "status",
				header: t`Status`,
				size: 180,
				cell: ({ row }) => (
					<span className="flex items-center gap-1.5">
						<NodeStatusBadge status={row.original.status} connected={row.original.connected} />
						<ClockWarning warning={row.original.clockWarning} />
					</span>
				),
			},
			{
				id: "hostname",
				header: t`Hostname`,
				size: 160,
				cell: ({ row }) => <span className="truncate text-xs">{row.original.hostname ?? "–"}</span>,
			},
			{
				id: "os",
				header: t`OS`,
				size: 160,
				cell: ({ row }) => <span className="truncate text-xs">{osName(row.original.facts)}</span>,
			},
			{
				id: "nodeGroups",
				header: t`Node groups`,
				size: 180,
				cell: ({ row }) => <NodeGroupLinks nodeGroups={row.original.nodeGroups} className="text-xs" />,
			},
			{
				id: "access",
				header: t`Access`,
				size: 90,
				cell: ({ row }) => <span className="text-xs">{row.original.access}</span>,
			},
			{
				id: "lastSeen",
				header: t`Last seen`,
				size: 120,
				cell: ({ row }) => <RelativeTime value={row.original.lastSeenAt} className="text-xs" />,
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 130,
				cell: ({ row }) =>
					canDecide(row.original) ? (
						<span className="flex flex-nowrap items-center gap-1">
							<Button type="button" size="xs" onClick={() => setPending({ node: row.original, action: "approve" })}>
								<Trans>Approve</Trans>
							</Button>
							<Button
								type="button"
								size="xs"
								variant="destructive"
								onClick={() => setPending({ node: row.original, action: "reject" })}
							>
								<Trans>Reject</Trans>
							</Button>
						</span>
					) : null,
			},
		];
	}, [t, user?.kind]);

	return (
		<Page data-testid="nodes-page">
			<PageHeader
				title={<Trans>Nodes</Trans>}
				actions={
					<>
						<Button type="button" variant="outline" onClick={() => void nodes.refetch()}>
							<RefreshCwIcon />
							<Trans>Refresh</Trans>
						</Button>
						<Button type="button" variant="outline" onClick={() => setAddingSsh(true)} data-testid="add-ssh-node">
							<Trans>Add SSH node</Trans>
						</Button>
						<Button type="button" onClick={() => setAdding(true)} data-testid="add-node">
							<PlusIcon />
							<Trans>Add node</Trans>
						</Button>
					</>
				}
			/>
			<DataTable
				label={t`Nodes`}
				columns={columns}
				data={nodes.data ?? []}
				getRowId={(node) => node.id}
				loading={nodes.isLoading}
				error={nodes.isError ? nodes.error : undefined}
				onRetry={() => void nodes.refetch()}
				empty={
					<EmptyState
						title={<Trans>No nodes yet</Trans>}
						description={<Trans>Use "Add node" to enrol a crha client, or "Add SSH node" for an SSH target.</Trans>}
					/>
				}
			/>
			{adding && <AddNodeDialog onClose={() => setAdding(false)} />}
			{addingSsh && <AddSshNodeDialog onClose={() => setAddingSsh(false)} />}
			{pending && (
				<PendingNodeDialog
					node={pending.node}
					action={pending.action}
					onClose={() => setPending(undefined)}
					onDone={() => {
						setPending(undefined);
						void nodes.refetch();
					}}
				/>
			)}
		</Page>
	);
}

function factValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * One node (doc/webui.md "Nodes"): identity, facts, the transport-specific
 * configuration, trust and signing keys, run panel, shares and recent tasks.
 */
export function NodeDetailPage() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { nodeId?: string };
	const id = params.nodeId ?? "";
	const node = useNode(id);
	const trustSources = useTrustSources();
	const admin = useAuth().user?.kind === "admin";
	const [editingGroups, setEditingGroups] = useState(false);
	const details = node.data?.node;

	if (node.isError) {
		return (
			<div className="p-4">
				<ErrorState error={node.error} retry={() => void node.refetch()} />
			</div>
		);
	}
	if (!details) {
		return (
			<div className="p-4">
				<PageSkeleton />
			</div>
		);
	}

	const canRun = canRunOn(details);
	const manage = canManageNode(details);
	const facts = details.facts ? Object.entries(details.facts) : [];

	return (
		<Page width="detail" data-testid="node-detail">
			<div>
				<Link
					to="/nodes"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All nodes</Trans>
				</Link>
			</div>
			<PageHeader
				title={details.name}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<NodeStatusBadge status={details.status} connected={details.connected} />
						{details.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
						<ClockWarning warning={details.clockWarning} />
					</span>
				}
				actions={
					admin || manage ? (
						<>
							{admin && (
								<Button type="button" variant="outline" size="sm" onClick={() => setEditingGroups(true)}>
									<Trans>Edit node groups</Trans>
								</Button>
							)}
							{manage && <RenameNodeButton node={details} />}
						</>
					) : undefined
				}
			/>

			<KeyValueList
				items={[
					{ label: t`Transport`, value: details.transport === "ssh" ? t`SSH` : t`crha client` },
					{ label: t`Hostname`, value: details.hostname ?? "–", mono: true },
					{ label: t`OS`, value: osName(details.facts) },
					{ label: t`Access`, value: details.access },
					{
						label: t`Privileged mode`,
						value: details.transport === "ssh" ? t`ignored (SSH)` : (details.privilegedMode ?? "–"),
					},
					{
						label: t`Node groups`,
						value: <NodeGroupLinks nodeGroups={details.nodeGroups} />,
					},
					...(details.transport === "client"
						? [
								{ label: t`Client`, value: details.clientVersion ?? "–" },
								{ label: t`Last seen`, value: <RelativeTime value={details.lastSeenAt} /> },
								{ label: t`Key fingerprint`, value: details.keyFingerprint ?? "–", mono: true },
							]
						: []),
					...(details.clockWarning !== null ? [{ label: t`Clock`, value: details.clockWarning }] : []),
					{ label: t`Node id`, value: details.id, mono: true },
				]}
			/>

			{facts.length > 0 && (
				<details className="rounded-lg border p-3">
					<summary className="cursor-pointer text-sm font-medium">
						<Trans>Facts ({facts.length})</Trans>
					</summary>
					<div className="mt-2">
						<KeyValueList items={facts.map(([key, value]) => ({ label: key, value: factValue(value), mono: true }))} />
					</div>
				</details>
			)}

			{editingGroups && <NodeGroupsDialog node={details} onClose={() => setEditingGroups(false)} />}
			{details.transport === "ssh" && <SshNodeSection node={details} details={node.data?.ssh} canRun={canRun} />}
			{details.transport === "client" && (
				<>
					<NodeTrustPanel nodeId={details.id} />
					<section className="grid gap-2" aria-labelledby="trust-editor-heading">
						<h2 id="trust-editor-heading" className="text-sm font-semibold">
							<Trans>Trust configuration</Trans>
						</h2>
						<p className="max-w-3xl text-sm text-muted-foreground">
							<Trans>
								Build the `[[trust]]` block for this node's privileged.toml. The node enforces it; this page only
								exports it.
							</Trans>
						</p>
						{trustSources.length > 0 ? (
							<TrustEditor sources={trustSources} />
						) : (
							<p className="text-sm text-muted-foreground">
								<Trans>Add a signing credential or connect crhs before configuring trust.</Trans>
							</p>
						)}
					</section>
					{manage && <CrhsKeyPanel />}
				</>
			)}

			{canRun && <RunPanel nodeId={details.id} />}
			{node.data?.shares !== undefined && <NodeShares node={details} shares={node.data.shares} canManage={manage} />}
			<NodeTaskList nodeId={details.id} />
		</Page>
	);
}
