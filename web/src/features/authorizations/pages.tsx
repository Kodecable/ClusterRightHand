import type { AuthorizationSummary, DecodedAuthorizationPayload } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { KeyValueList } from "@/components/key-value";
import { NodeTargetList, nodeTargetsText } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UserLink } from "@/components/user-link";
import { useNodeNames } from "@/features/nodes/api";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { useAuthorizations } from "./api";

/** The command a payload authorizes, as one line. */

/** The issuer: a user links to their page (doc/design/webui.md "List navigation, links and refresh"); crhs itself signs the rest. */
function AuthorizationIssuer({ entry }: { entry: Pick<AuthorizationSummary, "issuerUserId" | "issuerUsername"> }) {
	if (entry.issuerUserId === null) return <span className="truncate">crhs</span>;
	return <UserLink id={entry.issuerUserId} name={entry.issuerUsername} className="truncate" />;
}
export function authorizationCommandText(i18n: I18n, command: DecodedAuthorizationPayload["command"]): string {
	if (command === null) return i18n._(msg`any method and target`);
	if (command.match === "exact") return i18n._(msg`${command.method} exact ${command.target}`);
	return i18n._(msg`${command.method} prefix ${command.target}`);
}

/** The task ids an authorization covers, each linking to its task page. */
function AuthorizationTasks({ ids }: { ids: readonly string[] }) {
	if (ids.length === 0) return <>–</>;
	return (
		<span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
			{ids.map((id) => (
				<Link key={id} to="/tasks/$taskId" params={{ taskId: id }} className={cn(MONO_CELL, linkClass)}>
					{id}
				</Link>
			))}
		</span>
	);
}

function PayloadDialog({
	entry,
	names,
	onClose,
}: {
	entry: AuthorizationSummary;
	names: Map<string, string>;
	onClose: () => void;
}) {
	const { t, i18n } = useLingui();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Authorization payload</Trans>
					</DialogTitle>
				</DialogHeader>
				<KeyValueList
					items={[
						{ label: t`Id`, value: entry.id, mono: true },
						{ label: t`Issuer`, value: <AuthorizationIssuer entry={entry} /> },
						{ label: t`Issued`, value: <DateTime value={entry.issuedAt} /> },
						{ label: t`Deadline`, value: <DateTime value={entry.deadline} /> },
						...(entry.attempt !== null ? [{ label: t`Attempt`, value: String(entry.attempt) }] : []),
						{ label: t`Command`, value: authorizationCommandText(i18n, entry.command), mono: true },
						{ label: t`Nodes`, value: <NodeTargetList ids={entry.nodes} nodeNames={names} /> },
						{
							label: t`Tasks`,
							value: entry.taskIds === null ? t`reusable` : <AuthorizationTasks ids={entry.taskIds} />,
						},
						...(entry.note !== "" ? [{ label: t`Note`, value: entry.note }] : []),
					]}
				/>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Authorizations (doc/design/privilege.md "Authorizations"): every authorization of the organization, for administrators.
 * An authorization is valid until its deadline or until it is used up; it is withdrawn by deleting
 * the node's trust entry or rotating its key, not from here.
 */
export function AuthorizationsPage() {
	const { t, i18n } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const authorizations = useAuthorizations();
	const names = useNodeNames();
	const [payload, setPayload] = useState<AuthorizationSummary>();
	const rows = useMemo(() => authorizations.data?.pages.flatMap((page) => page.items) ?? [], [authorizations.data]);

	const columns = useMemo<DataTableColumn<AuthorizationSummary>[]>(
		() => [
			{
				id: "created",
				header: t`Created`,
				size: timeWidth,
				cell: ({ row }) => <DateTime value={row.original.createdAt} />,
			},
			{
				id: "issuer",
				header: t`Issuer`,
				size: 120,
				cell: ({ row }) => <AuthorizationIssuer entry={row.original} />,
				meta: {
					title: (entry: AuthorizationSummary) =>
						entry.issuerUsername ?? (entry.issuerUserId !== null ? entry.issuerUserId.slice(0, 8) : "crhs"),
				},
			},
			{
				id: "nodes",
				header: t`Nodes`,
				minSize: 140,
				cell: ({ row }) => <NodeTargetList ids={row.original.nodes} nodeNames={names} compact />,
				meta: {
					title: (entry: AuthorizationSummary) =>
						nodeTargetsText(
							i18n,
							entry.nodes.map((id) => names.get(id) ?? id),
						) || undefined,
				},
			},
			{
				id: "command",
				header: t`Command`,
				cell: ({ row }) => (
					<span className={cn("truncate", MONO_CELL)}>{authorizationCommandText(i18n, row.original.command)}</span>
				),
				meta: { title: (entry: AuthorizationSummary) => authorizationCommandText(i18n, entry.command) },
			},
			{
				id: "deadline",
				header: t`Deadline`,
				size: timeWidth,
				cell: ({ row }) => <DateTime value={row.original.deadline} />,
			},
			{
				id: "tasks",
				header: t`Tasks`,
				size: 100,
				cell: ({ row }) =>
					row.original.taskIds === null ? (
						<span>
							<Trans>reusable</Trans>
						</span>
					) : (
						<span>
							<Plural value={row.original.taskIds.length} one="# task" other="# tasks" />
						</span>
					),
			},
			{
				id: "actions",
				header: actionsHeader,
				size: 90,
				cell: ({ row }) => (
					<Button type="button" size="xs" variant="outline" onClick={() => setPayload(row.original)}>
						<Trans>Payload</Trans>
					</Button>
				),
			},
		],
		[t, i18n, names, timeWidth],
	);

	return (
		<Page data-testid="authorizations-page">
			<PageHeader
				title={<Trans>Authorizations</Trans>}
				description={
					<Trans>
						Every authorization carries a deadline. It is valid on the nodes its payload names until that deadline or
						until it is used up (one-shot authorizations).
					</Trans>
				}
			/>
			<DataTable
				label={t`Authorizations`}
				columns={columns}
				data={rows}
				getRowId={(entry) => entry.id}
				loading={authorizations.isLoading}
				error={authorizations.isError ? authorizations.error : undefined}
				onRetry={() => void authorizations.refetch()}
				hasMore={authorizations.hasNextPage}
				loadingMore={authorizations.isFetchingNextPage}
				onLoadMore={() => void authorizations.fetchNextPage()}
				empty={
					<EmptyState
						bare
						title={<Trans>No authorizations yet</Trans>}
						description={<Trans>No one has signed an authorization yet.</Trans>}
					/>
				}
			/>
			{payload && <PayloadDialog entry={payload} names={names} onClose={() => setPayload(undefined)} />}
		</Page>
	);
}
