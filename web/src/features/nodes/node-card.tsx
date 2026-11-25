import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { EmojiGlyph } from "@/components/entity-emoji";
import { ErrorState } from "@/components/error-state";
import { NodeGroupLinks } from "@/components/node-targets";
import { Spinner } from "@/components/spinner";
import { NodeStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatBytes, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ClockWarning } from "./clock-warning";
import { hasNodeRowActions, type NodeDecision, NodeRowActions } from "./node-actions";
import { NodeLastSeen } from "./node-last-seen";
import { TotalTraffic } from "./node-traffic";
import { UsageBar } from "./node-usage";
import { NodeUserRemark } from "./node-user-remark";
import { NodeWarningsIndicator } from "./node-warnings";
import { TrustWarningIndicator } from "./trust-warnings";

/** Elements that own a click or key: the card must not navigate when the interaction starts inside one. */
const CARD_INTERACTIVE_SELECTOR =
	"a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [contenteditable]";

/** A click that ends a text selection must not navigate, so copying a figure wins. */
function hasTextSelection(): boolean {
	return (window.getSelection()?.toString() ?? "") !== "";
}

/**
 * One labelled usage row of a card (doc/design/webui.md "Node pages"): the label and the shared usage
 * bar with its percentage. Memory and disk keep their used and total bytes (and the disk's filesystem
 * name) in the row's tooltip, never as visible text. A missing figure shows "–". The card's bar fills
 * the width the label leaves; the table and the Metrics summary keep their compact sizes.
 */
function UsageFigure({ label, ratio, title }: { label: string; ratio: number | undefined; title?: string }) {
	return (
		<div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2 text-xs" title={title}>
			<span className="truncate text-muted-foreground">{label}</span>
			{ratio === undefined ? (
				<span className="text-muted-foreground">–</span>
			) : (
				<UsageBar ratio={Math.max(0, Math.min(1, ratio))} size="fill" />
			)}
		</div>
	);
}

/**
 * One node as a card: the table's status, warnings, groups and actions, then its metrics, traffic and
 * the user remark row (doc/design/webui.md "Node pages").
 */
export function NodeCard({
	node,
	admin,
	onDecide,
}: {
	node: PublicNode;
	admin: boolean;
	onDecide: (node: PublicNode, action: NodeDecision) => void;
}) {
	const { t, i18n } = useLingui();
	const router = useRouter();
	const metrics = node.metrics;
	const open = () => {
		void router.navigate({ to: "/nodes/$nodeId", params: { nodeId: node.id } });
	};
	const interactive = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
		const target = event.target;
		return target instanceof Element && target !== event.currentTarget
			? target.closest(CARD_INTERACTIVE_SELECTOR) !== null
			: false;
	};
	const onClick = (event: MouseEvent<HTMLElement>) => {
		if (event.defaultPrevented || interactive(event) || hasTextSelection()) return;
		open();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
		event.preventDefault();
		open();
	};

	const memoryText =
		metrics?.memUsedBytes === undefined || metrics.memTotalBytes === undefined
			? undefined
			: `${formatBytes(metrics.memUsedBytes, i18n.locale)} / ${formatBytes(metrics.memTotalBytes, i18n.locale)}`;
	const diskText =
		metrics?.disk === undefined
			? undefined
			: `${formatBytes(metrics.disk.usedBytes, i18n.locale)} / ${formatBytes(metrics.disk.totalBytes, i18n.locale)}`;
	const diskTitle =
		metrics?.disk?.name === undefined
			? diskText
			: diskText === undefined
				? metrics.disk.name
				: `${metrics.disk.name}: ${diskText}`;
	const online = node.status === "active" && (node.transport === "ssh" || node.connected === true);
	const uptime =
		online && metrics?.uptimeSec !== undefined ? formatDuration(metrics.uptimeSec * 1000, i18n.locale) : undefined;

	return (
		<Card
			role="link"
			tabIndex={0}
			data-testid="node-card"
			data-node-id={node.id}
			data-stale={metrics?.stale || undefined}
			onClick={onClick}
			onKeyDown={onKeyDown}
			className="group/card min-w-0 cursor-pointer gap-3 py-3 ring-foreground/10 transition-colors outline-none hover:bg-muted/30 hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="flex min-w-0 items-start justify-between gap-2 px-(--card-spacing)">
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<Link
							to="/nodes/$nodeId"
							params={{ nodeId: node.id }}
							title={node.name}
							className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm font-medium text-inherit no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<EmojiGlyph emoji={node.emoji} testId="node-emoji" />
							<span className="truncate">{node.name}</span>
						</Link>
						{node.transport === "ssh" && (
							<Badge variant="secondary">
								<Trans>SSH</Trans>
							</Badge>
						)}
						{/* The warnings read before the status they explain; the group ends the name row. */}
						<span
							className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5"
							data-testid="node-card-status"
						>
							<ClockWarning warning={node.clockWarning} />
							<TrustWarningIndicator warnings={node.trustWarnings} />
							<NodeWarningsIndicator node={node} />
							<NodeStatusBadge status={node.status} connected={node.connected} />
						</span>
					</div>
					{node.nodeGroups.length > 0 && (
						<span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
							<NodeGroupLinks nodeGroups={node.nodeGroups} />
						</span>
					)}
				</div>
				{hasNodeRowActions(node, admin) && (
					<div className="shrink-0" data-testid="node-card-actions">
						<NodeRowActions node={node} admin={admin} onDecide={onDecide} />
					</div>
				)}
			</div>

			<div className="grid gap-3 px-(--card-spacing)">
				<div
					className={cn("grid gap-2", metrics?.stale && "opacity-50")}
					data-testid="node-card-figures"
					data-stale={metrics?.stale || undefined}
				>
					<UsageFigure label={t`CPU usage`} ratio={metrics?.cpu} />
					<UsageFigure label={t`Memory usage`} ratio={metrics?.memUsed} title={memoryText} />
					<UsageFigure label={t`Disk usage`} ratio={metrics?.disk?.usedRatio} title={diskTitle} />
				</div>

				{/* Uptime takes the row live traffic had; an offline node or a sample without it shows last seen. */}
				<div className="flex min-w-0 items-center justify-between gap-2 text-xs" data-testid="node-card-uptime">
					{uptime === undefined ? (
						<>
							<span className="shrink-0 text-muted-foreground">
								<Trans>Last seen</Trans>
							</span>
							<span className="min-w-0 truncate text-right">
								<NodeLastSeen lastSeenAt={node.lastSeenAt} connected={node.connected} />
							</span>
						</>
					) : (
						<>
							<span className="shrink-0 text-muted-foreground">
								<Trans>Uptime</Trans>
							</span>
							<span className={cn("truncate text-right tabular-nums", metrics?.stale && "opacity-50")}>{uptime}</span>
						</>
					)}
				</div>

				<div className="flex min-w-0 items-center justify-between gap-2 text-xs">
					<span className="shrink-0 text-muted-foreground">
						<Trans>Total traffic</Trans>
					</span>
					<TotalTraffic traffic={node.traffic} />
				</div>

				<NodeUserRemark node={node} admin={admin} />
			</div>
		</Card>
	);
}

/**
 * The node list's card view (doc/design/webui.md "Node pages"): the same filtered and sorted nodes as
 * the table, one card per node, with the table's loading, error and empty states.
 */
export function NodeCards({
	nodes,
	loading,
	error,
	onRetry,
	empty,
	admin,
	onDecide,
}: {
	nodes: PublicNode[];
	loading: boolean;
	error: unknown;
	onRetry: () => void;
	empty: ReactNode;
	admin: boolean;
	onDecide: (node: PublicNode, action: NodeDecision) => void;
}) {
	if (error !== undefined) return <ErrorState error={error} retry={onRetry} />;
	if (loading && nodes.length === 0) {
		return (
			<div className="flex items-center justify-center rounded-lg border py-12">
				<Spinner />
			</div>
		);
	}
	if (nodes.length === 0) return <div className="rounded-lg border">{empty}</div>;
	return (
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="nodes-cards">
			{nodes.map((node) => (
				<NodeCard key={node.id} node={node} admin={admin} onDecide={onDecide} />
			))}
		</div>
	);
}
