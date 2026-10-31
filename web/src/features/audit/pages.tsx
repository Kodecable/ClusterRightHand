import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { CodeText } from "@/components/code-text";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FieldShell } from "@/components/form";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/session";
import { useDirectory } from "@/features/users/api";
import type { AuditEvent, AuditQuery } from "@/lib/api/types";
import { useAuditEvents, useVerifyAudit } from "./api";

/** The actor's id, as a tooltip: the cell itself shows the display name when the directory has one. */
function actorId(event: AuditEvent): string {
	return `${event.actorType}:${event.actorId}`;
}

function actorText(event: AuditEvent, userName: (id: string) => string | undefined): string {
	if (event.actorType === "user") return userName(event.actorId) ?? actorId(event);
	return actorId(event);
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
				: null;
	return (
		<span className="flex min-w-0 items-center gap-1 text-xs">
			<span className="text-muted-foreground">{event.targetType}:</span>
			{href === null ? (
				<span className="truncate font-mono">{event.targetId}</span>
			) : (
				<Link
					{...href}
					aria-label={t`Open ${event.targetType} ${event.targetId}`}
					className="truncate font-mono text-primary underline underline-offset-2"
				>
					{event.targetId}
				</Link>
			)}
		</span>
	);
}

function VerifyPanel() {
	const { t } = useLingui();
	const verify = useVerifyAudit();
	const result = verify.data;
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={verify.isFetching}
				onClick={() => void verify.refetch()}
			>
				<ShieldCheckIcon />
				<Trans>Verify chain</Trans>
			</Button>
			{result?.ok === true && (
				<StatusBadge tone="ok">
					<Trans>Chain intact, {result.count} events.</Trans>
				</StatusBadge>
			)}
			{result?.ok === false && (
				<StatusBadge tone="danger">
					<Trans>
						Chain broken at seq {result.brokenAt} ({result.reason}) after {result.count} verified.
					</Trans>
				</StatusBadge>
			)}
			{verify.isError && (
				<span role="alert" className="text-sm text-danger">
					{verify.error.message}
				</span>
			)}
			<span className="sr-only">{t`Audit verify`}</span>
		</div>
	);
}

/**
 * The audit log (doc/access-control.md#审计): a cursor-paged table with action
 * and target filters, per-event detail, and the hash-chain verification for
 * administrators.
 */
export function AuditPage() {
	const { t } = useLingui();
	const prefix = useId();
	const user = useAuth().user;
	const directory = useDirectory();
	const [action, setAction] = useState("");
	const [targetType, setTargetType] = useState("");
	const [targetId, setTargetId] = useState("");
	const [applied, setApplied] = useState<AuditQuery>({});
	const [detail, setDetail] = useState<AuditEvent>();
	const audit = useAuditEvents(applied);
	const rows = useMemo(() => audit.data?.pages.flatMap((page) => page.items) ?? [], [audit.data]);
	const names = useMemo(
		() => new Map((directory.data?.users ?? []).map((entry) => [entry.id, entry.displayName || entry.username])),
		[directory.data],
	);
	const columns = useMemo<DataTableColumn<AuditEvent>[]>(() => {
		const userName = (id: string) => names.get(id);
		return [
			{
				id: "ts",
				header: t`Time`,
				size: 220,
				cell: ({ row }) => <DateTime value={row.original.ts} seconds />,
			},
			{
				id: "action",
				header: t`Action`,
				size: 180,
				cell: ({ row }) => <code className="font-mono text-xs">{row.original.action}</code>,
			},
			{
				id: "actor",
				header: t`Actor`,
				size: 160,
				cell: ({ row }) => (
					<span className="block truncate text-xs leading-5" title={actorId(row.original)}>
						{actorText(row.original, userName)}
					</span>
				),
			},
			{
				id: "onBehalf",
				header: t`On behalf of`,
				size: 150,
				cell: ({ row }) =>
					row.original.onBehalfOfUserId === null ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="truncate text-xs">
							{userName(row.original.onBehalfOfUserId) ?? row.original.onBehalfOfUserId}
						</span>
					),
			},
			{
				id: "target",
				header: t`Target`,
				cell: ({ row }) => <TargetCell event={row.original} />,
			},
			{
				id: "detail",
				header: actionsHeader,
				size: 100,
				cell: ({ row }) => (
					<Button
						type="button"
						size="xs"
						variant="outline"
						aria-label={t`Detail of event ${row.original.seq}`}
						onClick={() => setDetail(row.original)}
					>
						<Trans>Detail</Trans>
					</Button>
				),
			},
		];
	}, [t, names]);

	return (
		<Page data-testid="audit-page">
			<PageHeader
				title={<Trans>Audit</Trans>}
				description={
					<Trans>
						Every action that changes the cluster, newest first. The hash chain makes a removed or reordered event
						detectable.
					</Trans>
				}
				actions={user?.kind === "admin" ? <VerifyPanel /> : undefined}
			/>
			<form
				className="flex flex-wrap items-start gap-2"
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
						<Button type="button" variant="outline" onClick={() => void audit.refetch()}>
							<RefreshCwIcon />
							<Trans>Refresh</Trans>
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
				empty={
					<EmptyState title={<Trans>No events</Trans>} description={<Trans>Nothing matches these filters.</Trans>} />
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
