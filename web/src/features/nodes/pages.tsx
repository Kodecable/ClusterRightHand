import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeGroupLinks } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { NodeStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/session";
import { NodeAccessSection } from "./access-grants";
import { AddNodeDialog } from "./add-node-dialog";
import { AddSshNodeDialog } from "./add-ssh-node-dialog";
import { useNode, useNodes } from "./api";
import { ClockWarning, clockWarningText } from "./clock-warning";
import { osName } from "./commands";
import { CrhsKeyPanel } from "./crhs-key-panel";
import { canRunOn } from "./node-access";
import { NodeGroupsDialog } from "./node-groups-dialog";
import { NodeLastSeen } from "./node-last-seen";
import { NodeTaskList } from "./node-tasks";
import { NodeTrustPanel } from "./node-trust";
import { PendingNodeDialog } from "./pending-node-dialog";
import { RenameNodeButton } from "./rename-node-button";
import { SshNodeSection } from "./ssh-node-section";
import { tomlString } from "./trust-editor";
import { TrustEditor } from "./trust-editor-panel";
import { useTrustSources } from "./trust-sources";
import { TrustWarningIndicator, TrustWarningList } from "./trust-warnings";

/**
 * Every node the user can see (doc/design/webui.md "Node pages"): status, connection,
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
		const admin = user?.kind === "admin";
		const canDecide = (node: PublicNode) => node.status === "pending" && admin;
		const base: DataTableColumn<PublicNode>[] = [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate font-medium">{row.original.name}</span>
						{row.original.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
					</span>
				),
				meta: { title: (node: PublicNode) => node.name },
			},
			{
				id: "status",
				header: t`Status`,
				size: 100,
				cell: ({ row }) => (
					<span className="flex items-center gap-1.5">
						<NodeStatusBadge status={row.original.status} connected={row.original.connected} />
						<ClockWarning warning={row.original.clockWarning} />
						<TrustWarningIndicator warnings={row.original.trustWarnings} />
					</span>
				),
			},
			{
				id: "hostname",
				header: t`Hostname`,
				minSize: 140,
				cell: ({ row }) =>
					row.original.hostname === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="truncate">{row.original.hostname}</span>
					),
				meta: { title: (node: PublicNode) => node.hostname ?? undefined },
			},
			{
				id: "os",
				header: t`OS`,
				size: 140,
				cell: ({ row }) => <span className="truncate">{osName(row.original.facts)}</span>,
			},
			{
				id: "nodeGroups",
				header: t`Node groups`,
				size: 150,
				cell: ({ row }) => <NodeGroupLinks nodeGroups={row.original.nodeGroups} />,
			},
			{
				id: "lastSeen",
				header: t`Last seen`,
				size: 110,
				cell: ({ row }) => <NodeLastSeen lastSeenAt={row.original.lastSeenAt} connected={row.original.connected} />,
			},
		];
		// Approve/reject are administrator actions; a non-admin gets no actions column at all.
		if (!admin) return base;
		return [
			...base,
			{
				id: "actions",
				header: actionsHeader,
				size: 140,
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
					user?.kind === "admin" ? (
						<>
							<Button type="button" variant="outline" onClick={() => setAddingSsh(true)} data-testid="add-ssh-node">
								<PlusIcon />
								<Trans>New SSH node</Trans>
							</Button>
							<Button type="button" onClick={() => setAdding(true)} data-testid="add-node">
								<PlusIcon />
								<Trans>New node</Trans>
							</Button>
						</>
					) : undefined
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
				rowLink={(node) => ({ to: "/nodes/$nodeId", params: { nodeId: node.id } })}
				rowLabel={(node) => node.name}
				empty={
					<EmptyState
						bare
						title={<Trans>No nodes yet</Trans>}
						description={
							user?.kind === "admin" ? (
								<Trans>Use "New node" to enrol a crha client, or "New SSH node" for an SSH target.</Trans>
							) : (
								<Trans>An administrator grants access to nodes.</Trans>
							)
						}
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
 * One node (doc/design/webui.md "Node pages"): identity, facts, the transport-specific
 * configuration, trust and signing keys, access grants (administrators) and
 * recent tasks. Tasks run from the tasks page's "Run task" dialog.
 */
export function NodeDetailPage() {
	const { t, i18n } = useLingui();
	const params = useParams({ strict: false }) as { nodeId?: string };
	const id = params.nodeId ?? "";
	const node = useNode(id);
	const trustSources = useTrustSources();
	const admin = useAuth().user?.kind === "admin";
	const [editingGroups, setEditingGroups] = useState(false);
	const details = node.data?.node;

	if (node.isError) {
		return (
			<Page width="detail">
				<ErrorState error={node.error} retry={() => void node.refetch()} />
			</Page>
		);
	}
	if (!details) {
		return (
			<Page width="detail">
				<PageSkeleton />
			</Page>
		);
	}

	const canRun = canRunOn(details);
	const facts = details.facts ? Object.entries(details.facts) : [];
	const aliasesLine = `aliases = [${details.nodeGroups.map((group) => tomlString(group.id)).join(", ")}]`;

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
					admin ? (
						<>
							<Button type="button" variant="outline" size="sm" onClick={() => setEditingGroups(true)}>
								<Trans>Edit node groups</Trans>
							</Button>
							<RenameNodeButton node={details} />
						</>
					) : undefined
				}
			/>

			<TrustWarningList warnings={details.trustWarnings} />

			<KeyValueList
				items={[
					{ label: t`Transport`, value: details.transport === "ssh" ? t`SSH` : t`crha client` },
					{ label: t`Hostname`, value: details.hostname ?? "–", mono: true },
					{ label: t`OS`, value: osName(details.facts) },
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
								{
									label: t`Last seen`,
									value: <NodeLastSeen lastSeenAt={details.lastSeenAt} connected={details.connected} />,
								},
								{ label: t`Key fingerprint`, value: details.keyFingerprint ?? "–", mono: true },
							]
						: []),
					...(details.clockWarning !== null
						? [{ label: t`Clock`, value: clockWarningText(i18n, details.clockWarning) }]
						: []),
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
			{/* The SSH route and its credential are administrator data; the server omits `ssh` otherwise. */}
			{details.transport === "ssh" && node.data?.ssh && (
				<SshNodeSection node={details} details={node.data.ssh} canRun={canRun} />
			)}
			{details.transport === "client" && (
				<>
					<NodeTrustPanel nodeId={details.id} />
					{admin && details.privilegedMode === "forward" && details.nodeGroups.length > 0 && (
						<section className="grid gap-2" aria-labelledby="trust-aliases-heading" data-testid="trust-aliases">
							<h2 id="trust-aliases-heading" className="text-sm font-medium">
								<Trans>Aliases for privileged.toml</Trans>
							</h2>
							<div className="flex flex-wrap items-center gap-2">
								<code className="break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
									{aliasesLine}
								</code>
								<CopyButton text={aliasesLine} label={t`Copy aliases`} showLabel variant="outline" />
							</div>
							<p className="max-w-3xl text-sm text-muted-foreground">
								<Trans>This is a top-level key of privileged.toml. Paste it before the first `[[trust]]` table.</Trans>
							</p>
						</section>
					)}
					<section className="grid gap-2" aria-labelledby="trust-editor-heading">
						<h2 id="trust-editor-heading" className="text-sm font-medium">
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
					{admin && <CrhsKeyPanel />}
				</>
			)}

			<NodeAccessSection targetType="node" targetId={details.id} targetName={details.name} />
			<NodeTaskList nodeId={details.id} />
		</Page>
	);
}
