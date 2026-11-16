import type { AuditEvent, AuditQuery } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { CodeText } from "@/components/code-text";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FieldShell } from "@/components/form";
import { InternalLink } from "@/components/internal-link";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { RequestSource } from "@/components/request-source";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UserLink } from "@/components/user-link";
import { useUserNames } from "@/features/users/api";
import { cn, MONO_CELL } from "@/lib/utils";
import { useAuditEvents } from "./api";

/** The actor's raw id, as a tooltip: the cell reads the server's displayable source. */
function actorId(event: AuditEvent): string {
	return `${event.actorType}:${event.actorId}`;
}

function TargetCell({ event }: { event: AuditEvent }) {
	const { t } = useLingui();
	if (event.targetType === null || event.targetId === null) {
		return <span className="text-muted-foreground">–</span>;
	}
	const href =
		event.targetType === "task"
			? ({ to: "/tasks/$taskId", params: { taskId: event.targetId } } as const)
			: event.targetType === "node"
				? ({ to: "/nodes/$nodeId", params: { nodeId: event.targetId } } as const)
				: event.targetType === "library"
					? ({ to: "/library/$library", params: { library: event.targetId }, search: {} } as const)
					: null;
	return (
		<span className="flex min-w-0 items-center gap-1">
			<span className="text-muted-foreground">{event.targetType}:</span>
			{href === null ? (
				<span className={cn("truncate", MONO_CELL)}>{event.targetId}</span>
			) : (
				<InternalLink
					{...href}
					aria-label={t`Open ${event.targetType} ${event.targetId}`}
					className={cn("truncate", MONO_CELL)}
				>
					{event.targetId}
				</InternalLink>
			)}
		</span>
	);
}

/**
 * The audit log (doc/design/access-control.md "Audit"): a cursor-paged table with action
 * and target filters and per-event detail.
 */
export function AuditPage() {
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const prefix = useId();
	const [action, setAction] = useState("");
	const [targetType, setTargetType] = useState("");
	const [targetId, setTargetId] = useState("");
	const [applied, setApplied] = useState<AuditQuery>({});
	const [detail, setDetail] = useState<AuditEvent>();
	const audit = useAuditEvents(applied);
	const rows = useMemo(() => audit.data?.pages.flatMap((page) => page.items) ?? [], [audit.data]);
	const names = useUserNames();
	const columns = useMemo<DataTableColumn<AuditEvent>[]>(() => {
		const userName = (id: string) => names.get(id);
		return [
			{
				id: "ts",
				header: t`Time`,
				size: timeWidth,
				cell: ({ row }) => <DateTime value={row.original.ts} />,
			},
			{
				id: "action",
				header: t`Action`,
				size: 160,
				cell: ({ row }) => <code className={MONO_CELL}>{row.original.action}</code>,
				meta: { title: (event: AuditEvent) => event.action },
			},
			{
				id: "source",
				header: t`Source`,
				size: 160,
				cell: ({ row }) => (
					<RequestSource
						source={row.original.source}
						title={actorId(row.original)}
						className="block truncate leading-5"
					/>
				),
			},
			{
				id: "onBehalf",
				header: t`On behalf of`,
				size: 130,
				cell: ({ row }) =>
					row.original.onBehalfOfUserId === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="block truncate">
							<UserLink id={row.original.onBehalfOfUserId} name={userName(row.original.onBehalfOfUserId)} />
						</span>
					),
			},
			{
				id: "target",
				header: t`Target`,
				minSize: 160,
				cell: ({ row }) => <TargetCell event={row.original} />,
				meta: {
					title: (event: AuditEvent) =>
						event.targetType !== null && event.targetId !== null ? `${event.targetType}:${event.targetId}` : undefined,
				},
			},
		];
	}, [t, names, timeWidth]);

	return (
		<Page data-testid="audit-page">
			<PageHeader title={<Trans>Audit</Trans>} />
			<form
				className="flex flex-wrap items-start gap-3"
				aria-label={t`Audit filters`}
				onSubmit={(event) => {
					event.preventDefault();
					setApplied({
						action: action.trim() || undefined,
						targetType: targetType.trim() || undefined,
						targetId: targetId.trim() || undefined,
					});
				}}
			>
				<FieldShell
					id={`${prefix}-action`}
					label={t`Action`}
					description={t`A trailing "." matches a prefix, e.g. "task.".`}
				>
					<Input
						id={`${prefix}-action`}
						value={action}
						placeholder="task.approval"
						className="font-mono"
						onChange={(event) => setAction(event.target.value)}
					/>
				</FieldShell>
				<FieldShell id={`${prefix}-target-type`} label={t`Target type`}>
					<Input
						id={`${prefix}-target-type`}
						value={targetType}
						placeholder="task"
						className="w-40 font-mono"
						onChange={(event) => setTargetType(event.target.value)}
					/>
				</FieldShell>
				<FieldShell id={`${prefix}-target-id`} label={t`Target id`}>
					<Input
						id={`${prefix}-target-id`}
						value={targetId}
						placeholder="tsk_…"
						className="w-56 font-mono"
						onChange={(event) => setTargetId(event.target.value)}
					/>
				</FieldShell>
				{/* The buttons line up with the inputs, not with the labels above them. */}
				<div className="grid gap-1.5">
					<span aria-hidden="true" className="h-3.5" />
					<div className="flex gap-2">
						<Button type="submit">
							<Trans>Filter</Trans>
						</Button>
					</div>
				</div>
			</form>
			<DataTable
				label={t`Audit events`}
				columns={columns}
				data={rows}
				getRowId={(event) => String(event.seq)}
				loading={audit.isLoading}
				error={audit.isError ? audit.error : undefined}
				onRetry={() => void audit.refetch()}
				hasMore={audit.hasNextPage}
				loadingMore={audit.isFetchingNextPage}
				onLoadMore={() => void audit.fetchNextPage()}
				onRowActivate={(event) => setDetail(event)}
				rowLabel={(event) => t`Detail of event ${event.seq}`}
				rowActivateColumn="action"
				empty={
					<EmptyState
						bare
						title={<Trans>No events</Trans>}
						description={<Trans>Nothing matches these filters.</Trans>}
					/>
				}
			/>
			{detail && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setDetail(undefined);
					}}
				>
					<DialogContent className="sm:max-w-2xl">
						<DialogHeader>
							<DialogTitle>
								<Trans>Event {detail.seq}</Trans>
							</DialogTitle>
							<DialogDescription>{detail.action}</DialogDescription>
						</DialogHeader>
						<div className="max-h-[70vh] overflow-auto">
							<CodeText
								text={JSON.stringify(detail.detail, null, 2)}
								maxLines={60}
								preClassName="max-h-none whitespace-pre"
								label={t`Event detail`}
								copy={false}
							/>
						</div>
					</DialogContent>
				</Dialog>
			)}
		</Page>
	);
}
