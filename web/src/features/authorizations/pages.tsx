import type { AuthorizationSummary, DecodedAuthorizationPayload } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { KeyValueList } from "@/components/key-value";
import { NodeLink } from "@/components/node-targets";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DateTime } from "@/components/relative-time";
import { useTimeColumnWidth } from "@/components/time-column";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UserLink } from "@/components/user-link";
import { useNodes } from "@/features/nodes/api";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";
import { useAuthorizations } from "./api";

/** The command a payload authorizes, as one line. */

/** The issuer: a user links to their page (doc/webui.md "用户链接"); crhs itself signs the rest. */
function AuthorizationIssuer({ entry }: { entry: Pick<AuthorizationSummary, "issuerUserId" | "issuerUsername"> }) {
	if (entry.issuerUserId === null) return <span className="truncate">crhs</span>;
	return <UserLink id={entry.issuerUserId} name={entry.issuerUsername} className="truncate" />;
}
export function authorizationCommandText(command: DecodedAuthorizationPayload["command"]): string {
	if (command === null) return "any method and target";
	if (command.match === "exact") return `${command.method} exact ${command.target}`;
	return `${command.method} prefix ${command.target}`;
}

/** A node of an authorization: its current name and a link, or the raw id when it is unknown. */
function AuthorizationNode({ id, names }: { id: string; names: Map<string, string> }) {
	const name = names.get(id);
	if (name === undefined) {
		return <span className={cn(MONO_CELL, "text-muted-foreground")}>{id}</span>;
	}
	return <NodeLink id={id} name={name} />;
}

/** The nodes an authorization covers; the table keeps them on one clipped line. */
function AuthorizationNodes({
	ids,
	names,
	className,
}: {
	ids: readonly string[];
	names: Map<string, string>;
	className?: string;
}) {
	if (ids.length === 0) return <span className="text-muted-foreground">–</span>;
	return (
		<span
			data-slot="authorization-nodes"
			className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1", className)}
		>
			{ids.map((id, index) => (
				<Fragment key={id}>
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<AuthorizationNode id={id} names={names} />
				</Fragment>
			))}
		</span>
	);
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

/** The readable full text of a node list for a cell's tooltip. */
function nodeNamesText(ids: readonly string[], names: Map<string, string>): string | undefined {
	const text = ids.map((id) => names.get(id) ?? id).join(", ");
	return text === "" ? undefined : text;
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
	const { t } = useLingui();
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
						{ label: t`Command`, value: authorizationCommandText(entry.command), mono: true },
						{ label: t`Nodes`, value: <AuthorizationNodes ids={entry.nodes} names={names} /> },
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
 * Authorizations (doc/m4.md M4.4): every authorization of the organization, for administrators.
 * An authorization is valid until its deadline or until it is used up; it is withdrawn by deleting
 * the node's trust entry or rotating its key, not from here.
 */
export function AuthorizationsPage() {
	const { t } = useLingui();
	const timeWidth = useTimeColumnWidth();
	const authorizations = useAuthorizations();
	const nodes = useNodes();
	const names = useMemo(() => new Map((nodes.data ?? []).map((node) => [node.id, node.name])), [nodes.data]);
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
				cell: ({ row }) => <AuthorizationNodes ids={row.original.nodes} names={names} className="flex-nowrap" />,
				meta: { title: (entry: AuthorizationSummary) => nodeNamesText(entry.nodes, names) },
			},
			{
				id: "command",
				header: t`Command`,
				cell: ({ row }) => (
					<span className={cn("truncate", MONO_CELL)}>{authorizationCommandText(row.original.command)}</span>
				),
				meta: { title: (entry: AuthorizationSummary) => authorizationCommandText(entry.command) },
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
		[t, names, timeWidth],
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
