import type { McpServerView, McpToolView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, WrenchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actionsHeader, DataTable, type DataTableColumn } from "@/components/data-table";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDirectory } from "@/features/users/api";
import { cn, MONO_CELL } from "@/lib/utils";
import { mcpServerKeys, useDeleteMcpServer, useMcpServers, useMcpServerTools, useReconnectMcpServer } from "./api";
import { McpServerDialog } from "./mcp-server-dialog";

const STATE_LABEL = {
	unknown: <Trans>Not connected yet</Trans>,
	connecting: <Trans>Connecting</Trans>,
	ready: <Trans>Ready</Trans>,
	unavailable: <Trans>Unavailable</Trans>,
};

function StateCell({ server }: { server: McpServerView }) {
	const { status } = server;
	return (
		<span className="grid gap-0.5 text-xs" title={status.lastError ?? undefined}>
			<StatusText tone={status.state === "ready" ? "ok" : status.state === "unavailable" ? "danger" : "muted"}>
				{STATE_LABEL[status.state]}
			</StatusText>
			{status.state === "unavailable" && status.nextAttemptAt !== null && (
				<span className="text-muted-foreground">
					<Trans>Next try</Trans>: <RelativeTime value={status.nextAttemptAt} />
				</span>
			)}
			{status.lastError !== null && status.state === "unavailable" && (
				<span className="max-w-64 truncate text-muted-foreground">{status.lastError}</span>
			)}
		</span>
	);
}

/** The tool list of one server, with its annotations as rules see them. */
function ToolsDialog({ server, onClose }: { server: McpServerView; onClose: () => void }) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const tools = useMcpServerTools(server.name);
	// Listing the tools connects to the server, so its state and tool count in the list are stale now.
	useEffect(() => {
		if (tools.data === undefined) return;
		void queryClient.invalidateQueries({ queryKey: mcpServerKeys.all, exact: true });
	}, [tools.data, queryClient]);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-2xl" data-testid="mcp-tools-dialog">
				<DialogHeader>
					<DialogTitle>{t`Tools of ${server.name}`}</DialogTitle>
				</DialogHeader>
				{tools.isPending ? (
					<p className="text-sm text-muted-foreground">
						<Trans>Loading the tool list…</Trans>
					</p>
				) : tools.isError ? (
					<ErrorState error={tools.error} retry={() => void tools.refetch()} />
				) : (tools.data?.tools ?? []).length === 0 ? (
					<p className="text-sm text-muted-foreground">
						<Trans>The server listed no tools.</Trans>
					</p>
				) : (
					<ul className="grid max-h-[60vh] gap-2 overflow-y-auto" data-testid="mcp-tool-list">
						{(tools.data?.tools ?? []).map((tool: McpToolView) => (
							<li key={tool.name} className="grid gap-0.5 rounded-md border p-2">
								<div className="flex flex-wrap items-baseline gap-2">
									<code className={cn("text-xs font-medium", MONO_CELL)}>{tool.name}</code>
									{tool.title !== null && <span className="text-xs text-muted-foreground">{tool.title}</span>}
									{tool.annotations?.readOnlyHint === true && (
										<span className="rounded-full bg-ok-bg px-1.5 text-[11px] text-ok">
											<Trans>Read-only</Trans>
										</span>
									)}
									{tool.annotations !== null && (
										<code className="text-[11px] break-all text-muted-foreground">
											{JSON.stringify(tool.annotations)}
										</code>
									)}
								</div>
								{tool.description !== null && <p className="text-xs text-muted-foreground">{tool.description}</p>}
								<code className="max-h-48 overflow-auto rounded bg-[var(--code)] p-1 font-mono text-[11px] whitespace-pre-wrap">
									{JSON.stringify(tool.inputSchema, null, 2)}
								</code>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * System settings → MCP servers (doc/design/extensions.md "MCP servers"): the administrator's external tool
 * servers with their connection state, last error and next attempt, their direct-tool flag and grants.
 */
export function McpServersPage() {
	const { t } = useLingui();
	const servers = useMcpServers();
	const directory = useDirectory();
	const remove = useDeleteMcpServer();
	const reconnect = useReconnectMcpServer();
	const [editing, setEditing] = useState<McpServerView | "new">();
	const [deleting, setDeleting] = useState<McpServerView>();
	const [viewing, setViewing] = useState<McpServerView>();

	// Grantee names come from the directory, like the editor's grant chips; an id stands in when it is gone.
	const grantNames = useMemo(
		() =>
			new Map<string, string>([
				...(directory.data?.users ?? []).map((user) => [`user:${user.id}`, user.displayName || user.username] as const),
				...(directory.data?.userGroups ?? []).map((group) => [`user_group:${group.id}`, group.name] as const),
			]),
		[directory.data],
	);

	const columns = useMemo<DataTableColumn<McpServerView>[]>(
		() => [
			{
				id: "name",
				header: t`Name`,
				size: 120,
				cell: ({ row }) => <code className={MONO_CELL}>{row.original.name}</code>,
			},
			{
				id: "url",
				header: t`URL`,
				minSize: 150,
				cell: ({ row }) => <span className={cn("truncate", MONO_CELL)}>{row.original.url}</span>,
				meta: { title: (server: McpServerView) => server.url },
			},
			{
				id: "state",
				header: t`Connection`,
				minSize: 140,
				cell: ({ row }) => <StateCell server={row.original} />,
			},
			{
				id: "tools",
				header: t`Tools`,
				size: 64,
				cell: ({ row }) => row.original.status.toolCount,
			},
			{
				id: "access",
				header: t`Access`,
				minSize: 160,
				cell: ({ row }) => {
					const names = row.original.grants.map(
						(grant) => grantNames.get(`${grant.granteeType}:${grant.granteeId}`) ?? grant.granteeId,
					);
					const flags = [
						...(row.original.listDirectly ? [t`Listed directly`] : []),
						...(!row.original.trustAnnotations ? [t`Annotations untrusted`] : []),
					];
					return (
						<span className="grid gap-0.5 text-xs">
							<span className="truncate" title={names.join(", ") || undefined}>
								{names.length === 0 ? <span className="text-muted-foreground">–</span> : names.join(", ")}
							</span>
							{flags.length > 0 && <span className="text-muted-foreground">{flags.join(" · ")}</span>}
						</span>
					);
				},
			},
			{
				id: "enabled",
				header: t`Enabled`,
				size: 80,
				cell: ({ row }) => (
					<StatusText tone={row.original.enabled ? "ok" : "muted"}>
						{row.original.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
					</StatusText>
				),
			},
			{
				id: "actions",
				header: actionsHeader,
				// Four icon buttons: at 1280px the labels overflowed the table and clipped Delete.
				size: 140,
				cell: ({ row }) => (
					<span className="flex flex-nowrap items-center gap-1">
						<Button
							type="button"
							size="icon-xs"
							variant="outline"
							title={t`Edit`}
							aria-label={t`Edit ${row.original.name}`}
							onClick={() => setEditing(row.original)}
						>
							<PencilIcon />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="outline"
							title={t`Tools`}
							aria-label={t`View tools of ${row.original.name}`}
							onClick={() => setViewing(row.original)}
						>
							<WrenchIcon />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="outline"
							title={t`Reconnect`}
							disabled={reconnect.isPending}
							aria-label={t`Reconnect ${row.original.name}`}
							onClick={() => reconnect.mutate(row.original.name)}
						>
							<RefreshCwIcon />
						</Button>
						<Button
							type="button"
							size="icon-xs"
							variant="destructive"
							title={t`Delete`}
							aria-label={t`Delete ${row.original.name}`}
							onClick={() => setDeleting(row.original)}
						>
							<Trash2Icon />
						</Button>
					</span>
				),
			},
		],
		[t, reconnect, grantNames],
	);

	return (
		<Page data-testid="mcp-servers-page">
			<PageHeader title={<Trans>MCP servers</Trans>} />
			<section className="grid gap-3" aria-labelledby="mcp-servers-heading">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div>
						<h2 id="mcp-servers-heading" className="text-sm font-medium">
							<Trans>External tool servers</Trans>
						</h2>
						<p className="text-sm text-muted-foreground">
							<Trans>
								Agent sessions reach these servers' tools through search_tools and call_tool, under the session's rules
								and approvals.
							</Trans>
						</p>
					</div>
					<Button type="button" onClick={() => setEditing("new")} data-testid="add-mcp-server">
						<PlusIcon />
						<Trans>New server</Trans>
					</Button>
				</div>
				<DataTable
					label={t`MCP servers`}
					columns={columns}
					data={servers.data?.servers ?? []}
					getRowId={(server) => server.id}
					loading={servers.isLoading}
					error={servers.isError ? servers.error : undefined}
					onRetry={() => void servers.refetch()}
					empty={
						<EmptyState
							bare
							title={<Trans>No MCP servers yet</Trans>}
							description={<Trans>Connect a Streamable HTTP MCP server to give sessions external tools.</Trans>}
						/>
					}
				/>
				{reconnect.error !== null && reconnect.error !== undefined && <ErrorState error={reconnect.error} />}
			</section>
			{editing !== undefined && (
				<McpServerDialog
					existing={editing === "new" ? undefined : editing}
					onClose={() => setEditing(undefined)}
					onSaved={() => void servers.refetch()}
				/>
			)}
			{viewing !== undefined && <ToolsDialog server={viewing} onClose={() => setViewing(undefined)} />}
			<ConfirmDialog
				open={deleting !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleting(undefined);
				}}
				title={deleting ? t`Delete MCP server ${deleting.name}?` : ""}
				description={
					<Trans>
						Its tools disappear from sessions and its stored headers are deleted. Waiting calls of this server are not
						retried.
					</Trans>
				}
				confirmLabel={<Trans>Delete server</Trans>}
				busy={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.name, {
						onSuccess: () => setDeleting(undefined),
					});
				}}
			/>
		</Page>
	);
}
