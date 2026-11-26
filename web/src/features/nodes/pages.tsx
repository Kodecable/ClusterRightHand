import { type PublicNode, tomlString } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { EmojiGlyph, EntityEmoji } from "@/components/entity-emoji";
import { ErrorState } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeGroupLinks } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeletons";
import { Spinner } from "@/components/spinner";
import { NodeStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/session";
import { NodeAccessSection } from "./access-grants";
import { AddNodeDialog } from "./add-node-dialog";
import { AddSshNodeDialog } from "./add-ssh-node-dialog";
import { useNode, useNodes, useSetNodeEmoji } from "./api";
import { ClockWarning, clockWarningText } from "./clock-warning";
import { DeleteNodeDialog } from "./delete-node-dialog";
import { EditSshRouteDialog } from "./edit-ssh-route-dialog";
import { canRunOn } from "./node-access";
import { type NodeDecision, NodeRowActions } from "./node-actions";
import { NodeCards } from "./node-card";
import { NodeFiles } from "./node-files";
import { NodeGroupsDialog } from "./node-groups-dialog";
import { NodeLastSeen } from "./node-last-seen";
import { NodeTaskList } from "./node-tasks";
import { NodeTrustPanel } from "./node-trust";
import { NodeUsage } from "./node-usage";
import { MetricsWarningList, NodeWarningsIndicator, UpdateAvailableBadge } from "./node-warnings";
import { PendingNodeDialog } from "./pending-node-dialog";
import { ReenrollNodeDialog } from "./reenroll-node-dialog";
import { RenameNodeButton } from "./rename-node-button";
import { SshNodeSection } from "./ssh-node-section";
import { TrustWarningIndicator, TrustWarningList } from "./trust-warnings";
import { selfUpgradeReasonText, UpgradeCrhaDialog } from "./upgrade-crha-dialog";

// The Metrics tab and the Overview's chart cards pull in ECharts; loading them only on first use keeps
// the node page chunk small.
const NodeMetricsTab = lazy(() => import("./node-metrics").then((module) => ({ default: module.NodeMetrics })));
const NodeOverviewMetrics = lazy(() =>
	import("./node-metrics").then((module) => ({ default: module.NodeOverviewMetrics })),
);

/** How the node list presents its nodes; cards are the default (doc/design/webui.md "Node pages"). */
type NodeListView = "cards" | "table";

export const NODE_VIEW_STORAGE_KEY = "crh.nodes.view";

/** The saved view, cards by default; storage can be unavailable, which must not break the page. */
export function readNodeView(): NodeListView {
	try {
		return window.localStorage.getItem(NODE_VIEW_STORAGE_KEY) === "table" ? "table" : "cards";
	} catch {
		return "cards";
	}
}

function writeNodeView(view: NodeListView): void {
	try {
		window.localStorage.setItem(NODE_VIEW_STORAGE_KEY, view);
	} catch {
		// Storage is blocked: the choice still applies for this page's lifetime.
	}
}

/** The Cards/Table switch in the page header, with the same button shape as the dashboard toolbars. */
function NodeViewToggle({ view, onChange }: { view: NodeListView; onChange: (view: NodeListView) => void }) {
	const { t } = useLingui();
	return (
		<fieldset aria-label={t`Node view`} className="flex min-w-0 items-center gap-1 rounded-md border p-0.5">
			<Button
				type="button"
				size="xs"
				variant={view === "cards" ? "secondary" : "ghost"}
				aria-pressed={view === "cards"}
				data-testid="nodes-view-cards"
				onClick={() => onChange("cards")}
			>
				<Trans>Cards</Trans>
			</Button>
			<Button
				type="button"
				size="xs"
				variant={view === "table" ? "secondary" : "ghost"}
				aria-pressed={view === "table"}
				data-testid="nodes-view-table"
				onClick={() => onChange("table")}
			>
				<Trans>Table</Trans>
			</Button>
		</fieldset>
	);
}

/**
 * Every node the user can see (doc/design/webui.md "Node pages"): status, connection,
 * clock warning, node groups and access, plus approve/reject for pending nodes.
 * Enrollment and the SSH wizard are the two "Add" flows.
 */
export function NodesPage() {
	const { t } = useLingui();
	const user = useAuth().user;
	const admin = user?.kind === "admin";
	const nodes = useNodes();
	const [adding, setAdding] = useState(false);
	const [addingSsh, setAddingSsh] = useState(false);
	const [upgradingAll, setUpgradingAll] = useState(false);
	const [pending, setPending] = useState<{ node: PublicNode; action: NodeDecision }>();
	const [view, setView] = useState<NodeListView>(readNodeView);

	const decide = useCallback((node: PublicNode, action: NodeDecision) => setPending({ node, action }), []);
	const changeView = (next: NodeListView) => {
		setView(next);
		writeNodeView(next);
	};

	const columns = useMemo<DataTableColumn<PublicNode>[]>(() => {
		const base: DataTableColumn<PublicNode>[] = [
			{
				id: "name",
				header: t`Name`,
				minSize: 140,
				cell: ({ row }) => (
					<span className="flex min-w-0 items-center gap-2">
						<span className="flex min-w-0 items-center gap-1.5">
							<EmojiGlyph emoji={row.original.emoji} testId="node-emoji" />
							<span className="truncate font-medium">{row.original.name}</span>
						</span>
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
				// Room for the status and its clock and trust warning badges side by side.
				size: 190,
				cell: ({ row }) => (
					<span className="flex items-center gap-1.5">
						<NodeStatusBadge status={row.original.status} connected={row.original.connected} />
						<ClockWarning warning={row.original.clockWarning} />
						<TrustWarningIndicator warnings={row.original.trustWarnings} />
						<NodeWarningsIndicator node={row.original} />
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
				id: "nodeGroups",
				header: t`Node groups`,
				size: 130,
				cell: ({ row }) => <NodeGroupLinks nodeGroups={row.original.nodeGroups} />,
			},
			{
				id: "lastSeen",
				header: t`Last seen`,
				size: 100,
				cell: ({ row }) => <NodeLastSeen lastSeenAt={row.original.lastSeenAt} connected={row.original.connected} />,
			},
			{
				id: "metrics",
				header: t`Metrics`,
				size: 110,
				cell: ({ row }) => <NodeUsage metrics={row.original.metrics} />,
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
				cell: ({ row }) => <NodeRowActions node={row.original} admin={admin} onDecide={decide} />,
			},
		];
	}, [t, admin, decide]);

	const empty = (
		<EmptyState
			bare
			title={<Trans>No nodes yet</Trans>}
			description={
				admin ? (
					<Trans>Use "New node" to enrol a crha client, or "New SSH node" for an SSH target.</Trans>
				) : (
					<Trans>An administrator grants access to nodes.</Trans>
				)
			}
		/>
	);

	return (
		<Page data-testid="nodes-page">
			<PageHeader
				title={<Trans>Nodes</Trans>}
				actions={
					<>
						<NodeViewToggle view={view} onChange={changeView} />
						{admin && (
							<>
								<Button
									type="button"
									variant="outline"
									onClick={() => setUpgradingAll(true)}
									data-testid="upgrade-all-nodes"
								>
									<Trans>Upgrade crha</Trans>
								</Button>
								<Button type="button" variant="outline" onClick={() => setAddingSsh(true)} data-testid="add-ssh-node">
									<PlusIcon />
									<Trans>New SSH node</Trans>
								</Button>
								<Button type="button" onClick={() => setAdding(true)} data-testid="add-node">
									<PlusIcon />
									<Trans>New node</Trans>
								</Button>
							</>
						)}
					</>
				}
			/>
			{view === "cards" ? (
				<NodeCards
					nodes={nodes.data ?? []}
					loading={nodes.isLoading}
					error={nodes.isError ? nodes.error : undefined}
					onRetry={() => void nodes.refetch()}
					empty={empty}
					admin={admin}
					onDecide={decide}
				/>
			) : (
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
					empty={empty}
				/>
			)}
			{adding && <AddNodeDialog onClose={() => setAdding(false)} />}
			{addingSsh && <AddSshNodeDialog onClose={() => setAddingSsh(false)} />}
			{upgradingAll && <UpgradeCrhaDialog targets={["_all"]} onClose={() => setUpgradingAll(false)} />}
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

/** One fact as shown: text as is (hints keep their lines), anything else as JSON. */
function factValue(value: unknown): ReactNode {
	if (typeof value !== "string") return JSON.stringify(value);
	return <span className="whitespace-pre-line">{value}</span>;
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
	const admin = useAuth().user?.kind === "admin";
	const [editingGroups, setEditingGroups] = useState(false);
	const [editingRoute, setEditingRoute] = useState(false);
	const [reenrolling, setReenrolling] = useState(false);
	const [upgrading, setUpgrading] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [tab, setTab] = useState<"overview" | "metrics" | "technical" | "files">("overview");
	const details = node.data?.node;
	const setEmoji = useSetNodeEmoji();

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
				title={
					<span className="flex min-w-0 items-center gap-2">
						<EntityEmoji
							emoji={details.emoji}
							editable={admin}
							onSelect={(emoji) => setEmoji.mutate({ id: details.id, emoji })}
							busy={setEmoji.isPending}
							testId="node-emoji"
						/>
						<span className="min-w-0">{details.name}</span>
						{details.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
					</span>
				}
				titleText={details.name}
				titleLabel={details.name}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<NodeStatusBadge status={details.status} connected={details.connected} />
						<ClockWarning warning={details.clockWarning} />
						{details.updateAvailable && <UpdateAvailableBadge />}
					</span>
				}
				actions={
					admin ? (
						<>
							<Button type="button" variant="outline" size="sm" onClick={() => setEditingGroups(true)}>
								<Trans>Edit node groups</Trans>
							</Button>
							<RenameNodeButton node={details} />
							{details.transport === "ssh" && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setEditingRoute(true)}
									data-testid="edit-ssh-route"
								>
									<Trans>Edit route</Trans>
								</Button>
							)}
							{details.transport === "client" && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setReenrolling(true)}
									data-testid="reenroll-node"
								>
									<Trans>Re-enroll</Trans>
								</Button>
							)}
							{details.transport === "client" && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setUpgrading(true)}
									data-testid="upgrade-crha"
								>
									<Trans>Upgrade crha</Trans>
								</Button>
							)}
							<Button type="button" variant="destructive" size="sm" onClick={() => setDeleting(true)}>
								<Trash2Icon />
								<Trans>Delete node</Trans>
							</Button>
						</>
					) : undefined
				}
			/>

			<Tabs value={tab} onValueChange={(next) => setTab(next as "overview" | "metrics" | "technical" | "files")}>
				<TabsList variant="line" aria-label={t`Node views`}>
					<TabsTrigger value="overview">
						<Trans>Overview</Trans>
					</TabsTrigger>
					<TabsTrigger value="metrics">
						<Trans>Metrics</Trans>
					</TabsTrigger>
					<TabsTrigger value="technical">
						<Trans>Technical details</Trans>
					</TabsTrigger>
					<TabsTrigger value="files">
						<Trans>Files</Trans>
					</TabsTrigger>
				</TabsList>
				<TabsContent value="overview" className="grid gap-3">
					<MetricsWarningList warning={details.metricsWarning} />
					<TrustWarningList warnings={details.trustWarnings} />

					<KeyValueList
						columns={2}
						columnsAt="lg"
						items={[
							{ label: t`Platform`, value: details.facts?.platform ?? "–" },
							{
								label: t`Node groups`,
								value: <NodeGroupLinks nodeGroups={details.nodeGroups} />,
							},
							...(details.userRemark !== null ? [{ label: t`User remark`, value: details.userRemark }] : []),
							...(details.transport === "client"
								? [
										{ label: t`Client`, value: details.clientVersion ?? "–" },
										{
											label: t`Self-upgrade`,
											value: selfUpgradeText(i18n, details.facts?.selfUpgrade),
										},
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

					{tab === "overview" && (
						<Suspense fallback={null}>
							<NodeOverviewMetrics nodeId={details.id} />
						</Suspense>
					)}

					{editingGroups && <NodeGroupsDialog node={details} onClose={() => setEditingGroups(false)} />}
					{editingRoute && node.data?.ssh && (
						<EditSshRouteDialog node={details} details={node.data.ssh} onClose={() => setEditingRoute(false)} />
					)}
					{reenrolling && <ReenrollNodeDialog node={details} onClose={() => setReenrolling(false)} />}
					{upgrading && <UpgradeCrhaDialog targets={[details.id]} onClose={() => setUpgrading(false)} />}
					{deleting && <DeleteNodeDialog node={details} onClose={() => setDeleting(false)} />}
					{/* The SSH route and its per-hop credentials are administrator data; the server omits `ssh` otherwise. */}
					{details.transport === "ssh" && node.data?.ssh && (
						<SshNodeSection node={details} details={node.data.ssh} canRun={canRun} />
					)}
					<NodeAccessSection targetType="node" targetId={details.id} targetName={details.name} />
					<NodeTaskList nodeId={details.id} />
				</TabsContent>
				<TabsContent value="metrics">
					{/* Mounted only while open: the metrics read and the ECharts chunk load on first use. */}
					{tab === "metrics" && (
						<Suspense
							fallback={
								<div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
									<Spinner decorative />
									<Trans>Loading metrics…</Trans>
								</div>
							}
						>
							<NodeMetricsTab nodeId={details.id} />
						</Suspense>
					)}
				</TabsContent>
				<TabsContent value="technical" className="grid gap-3">
					{/* Record fields that are for diagnosis rather than daily use; the raw reported facts follow. */}
					<KeyValueList
						items={[
							{ label: t`Hostname`, value: details.hostname ?? "–", mono: true },
							{
								label: t`Privileged mode`,
								value: details.transport === "ssh" ? t`ignored (SSH)` : (details.privilegedMode ?? "–"),
							},
							...(details.transport === "client" && details.facts?.upgradeLogPath
								? [{ label: t`Upgrade log`, value: details.facts.upgradeLogPath, mono: true }]
								: []),
						]}
					/>
					{/* What the node reported and how it trusts signers: for diagnosis, not daily use. */}
					<section className="grid gap-2" aria-labelledby="node-facts-heading" data-testid="node-facts">
						<h2 id="node-facts-heading" className="text-sm font-medium">
							<Trans>Facts</Trans>
						</h2>
						{facts.length > 0 ? (
							<KeyValueList
								items={facts.map(([key, value]) => ({ label: key, value: factValue(value), mono: true }))}
							/>
						) : (
							<p className="text-sm text-muted-foreground">
								<Trans>The node has not reported any facts yet.</Trans>
							</p>
						)}
					</section>
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
										<Trans>
											This is a top-level key of privileged.toml. Paste it before the first `[[trust]]` table.
										</Trans>
									</p>
								</section>
							)}
						</>
					)}
				</TabsContent>
				<TabsContent value="files">
					<NodeFiles nodeId={details.id} nodeName={details.name} />
				</TabsContent>
			</Tabs>
		</Page>
	);
}

/** Whether crhs can upgrade the node's crha, and why not (doc/design/distribution.md "Who can self-upgrade"). */
function selfUpgradeText(i18n: I18n, selfUpgrade: NonNullable<PublicNode["facts"]>["selfUpgrade"]): string {
	if (selfUpgrade === undefined) return i18n._(msg`not reported (crha predates self-upgrade)`);
	if (selfUpgrade.available) {
		return selfUpgrade.arch ? i18n._(msg`available (${selfUpgrade.arch})`) : i18n._(msg`available`);
	}
	return i18n._(
		msg`unavailable (${selfUpgrade.reasons.map((reason) => selfUpgradeReasonText(i18n, reason)).join("; ")})`,
	);
}
