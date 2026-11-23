import type { ApprovalBody, ApprovalRequest, PtyState, PtyView, PtyViewer } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, MaximizeIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ApprovalPanel } from "@/components/decision/approval-panel";
import { SignaturePanel, type SubmitSignature } from "@/components/decision/signature-panel";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyHint, EmptyState } from "@/components/empty-state";
import { EntityPicker } from "@/components/entity-picker";
import { ErrorState, ErrorText } from "@/components/error-state";
import { InternalLink } from "@/components/internal-link";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PrivilegedMark } from "@/components/privileged-mark";
import { RelativeTime } from "@/components/relative-time";
import { RowRemoveButton } from "@/components/row-remove-button";
import { Panel, SectionHeader } from "@/components/section";
import { PageSkeleton } from "@/components/skeletons";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { UserLink } from "@/components/user-link";
import { useSubmitAuthorization } from "@/features/authorizations/api";
import { isNotFound } from "@/lib/api/client";
import { usePageTitle } from "@/lib/page-title";
import { useAuth } from "@/lib/session";
import {
	terminalKeys,
	useAssociateSession,
	useCloseTerminal,
	useDecideTerminalApproval,
	useRejectTerminalAuthorization,
	useResizeTerminal,
	useTerminal,
	useTerminalAuthorization,
	useTerminals,
	useUnassociateSession,
} from "./api";
import { NewTerminalDialog } from "./new-terminal-dialog";
import { terminalCommand, terminalStateLabel, terminalStateTone } from "./terminal-format";
import { type TerminalLiveState, TerminalView, type TerminalViewHandle } from "./terminal-view";

/** One terminal list row: node, program title, user, privileged flag, state, creating session, associations, viewers, age. */
export function TerminalsPage() {
	const { t, i18n } = useLingui();
	const terminals = useTerminals();
	const [creating, setCreating] = useState(false);

	const columns = useMemo<DataTableColumn<PtyView>[]>(
		() => [
			{
				id: "node",
				header: t`Node`,
				minSize: 140,
				cell: ({ row }) => <span className="block truncate">{row.original.nodeName ?? row.original.nodeId}</span>,
				meta: { title: (terminal: PtyView) => terminal.nodeName ?? terminal.nodeId },
			},
			{
				id: "title",
				header: t`Title`,
				minSize: 140,
				cell: ({ row }) =>
					row.original.title === "" ? (
						<span className="text-muted-foreground">–</span>
					) : (
						<span className="block truncate" data-testid="terminal-title-cell">
							{row.original.title}
						</span>
					),
				meta: { title: (terminal: PtyView) => (terminal.title === "" ? undefined : terminal.title) },
			},
			{
				id: "user",
				header: t`User`,
				minSize: 120,
				cell: ({ row }) => (
					<UserLink id={row.original.userId} name={row.original.username} className="block truncate" />
				),
			},
			{
				id: "privileged",
				header: t`Privileged`,
				size: 100,
				cell: ({ row }) =>
					row.original.privileged ? <PrivilegedMark /> : <span className="text-muted-foreground">–</span>,
			},
			{
				id: "state",
				header: t`State`,
				size: 90,
				cell: ({ row }) => (
					<StatusText tone={terminalStateTone(row.original.state)}>
						{terminalStateLabel(i18n, row.original.state)}
					</StatusText>
				),
			},
			{
				id: "creatingSession",
				header: t`Creating session`,
				minSize: 120,
				cell: ({ row }) =>
					row.original.creatingSessionId === null ? (
						<span className="text-muted-foreground">
							<Trans>Person</Trans>
						</span>
					) : (
						<InternalLink
							to="/sessions/$sessionId"
							params={{ sessionId: row.original.creatingSessionId }}
							className="block truncate font-mono text-xs"
						>
							{row.original.creatingSessionId}
						</InternalLink>
					),
			},
			{
				id: "sessions",
				header: t`Associated sessions`,
				minSize: 150,
				cell: ({ row }) => <SessionIdList ids={row.original.sessionIds} />,
			},
			{
				id: "viewers",
				header: t`Viewers`,
				size: 90,
				cell: ({ row }) => {
					const names = row.original.viewers.map((viewer) => viewer.username ?? viewer.userId);
					if (names.length === 0) return <span className="text-muted-foreground">–</span>;
					return (
						<span className="truncate" title={names.join(", ")}>
							{names.length}
						</span>
					);
				},
			},
			{
				id: "age",
				header: t`Age`,
				size: 110,
				cell: ({ row }) => <RelativeTime value={row.original.openedAt} />,
			},
		],
		[t, i18n],
	);

	if (terminals.isPending) {
		return (
			<Page data-testid="terminals-page">
				<PageSkeleton />
			</Page>
		);
	}

	// The subsystem's switch hides the page and the agent tools; the route can still be reached by URL.
	if (terminals.data !== undefined && !terminals.data.enabled) {
		return (
			<Page data-testid="terminals-page">
				<PageHeader title={<Trans>Terminals</Trans>} />
				<EmptyState
					icon={<TerminalIcon className="size-6" />}
					title={<Trans>The terminal subsystem is turned off</Trans>}
					description={<Trans>An administrator can turn it on in System settings.</Trans>}
				/>
			</Page>
		);
	}

	return (
		<Page data-testid="terminals-page">
			<PageHeader
				title={<Trans>Terminals</Trans>}
				actions={
					<Button type="button" onClick={() => setCreating(true)} data-testid="new-terminal">
						<PlusIcon />
						<Trans>New terminal</Trans>
					</Button>
				}
			/>
			<DataTable
				label={t`Terminals`}
				columns={columns}
				data={terminals.data?.terminals ?? []}
				getRowId={(terminal) => terminal.id}
				loading={terminals.isLoading}
				error={terminals.isError ? terminals.error : undefined}
				onRetry={() => void terminals.refetch()}
				rowLink={(terminal) => ({ to: "/terminals/$id", params: { id: terminal.id } })}
				rowLabel={(terminal) => terminal.nodeName ?? terminal.nodeId}
				empty={
					<EmptyState
						bare
						icon={<TerminalIcon className="size-6" />}
						title={<Trans>No terminals yet</Trans>}
						description={<Trans>Open a terminal on a crha node to run an interactive shell.</Trans>}
					/>
				}
			/>
			{creating && <NewTerminalDialog onClose={() => setCreating(false)} />}
		</Page>
	);
}

/** The associated sessions of one terminal as a single clipped line of links. */
function SessionIdList({ ids }: { ids: readonly string[] }) {
	if (ids.length === 0) return <span className="text-muted-foreground">–</span>;
	return (
		<span className="flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden">
			{ids.map((id) => (
				<InternalLink
					key={id}
					to="/sessions/$sessionId"
					params={{ sessionId: id }}
					className="truncate font-mono text-xs"
					title={id}
				>
					{id}
				</InternalLink>
			))}
		</span>
	);
}

/** A neutral notice for a terminal the API answers 404 for (the retention window passed). */
function TerminalGone() {
	return (
		<EmptyState
			icon={<TerminalIcon className="size-6" />}
			title={<Trans>The terminal is gone</Trans>}
			description={<Trans>It was closed, or its five-minute retention window passed after the process exited.</Trans>}
			action={
				<InternalLink to="/terminals" className="text-sm">
					<Trans>All terminals</Trans>
				</InternalLink>
			}
		/>
	);
}

/** The other viewers of one terminal, merged per user: who watches, not where or since when. */
function ViewerList({ viewers }: { viewers: readonly PtyViewer[] }) {
	const merged = useMemo(() => {
		const byUser = new Map<string, { userId: string; username: string | null; count: number }>();
		for (const viewer of viewers) {
			const existing = byUser.get(viewer.userId);
			if (existing === undefined) {
				byUser.set(viewer.userId, { userId: viewer.userId, username: viewer.username, count: 1 });
			} else {
				existing.count += 1;
			}
		}
		return [...byUser.values()];
	}, [viewers]);
	return merged.length === 0 ? (
		<EmptyHint>
			<Trans>No one is watching.</Trans>
		</EmptyHint>
	) : (
		<ul className="grid min-w-0 gap-1.5 text-sm" data-testid="terminal-viewers">
			{merged.map((viewer) => (
				<li key={viewer.userId} className="flex min-w-0 flex-wrap items-center gap-x-1">
					<UserLink id={viewer.userId} name={viewer.username} />
					{viewer.count > 1 && (
						<span className="text-xs text-muted-foreground" data-testid="terminal-viewer-count">
							×{viewer.count}
						</span>
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * The associations of one terminal (doc/design/pty.md "The terminal object"): add one of the terminal
 * user's sessions with the one entity picker, or remove an existing one.
 */
function TerminalAssociations({ terminal }: { terminal: PtyView }) {
	const { t } = useLingui();
	const user = useAuth().user;
	// Only an administrator may list another user's sessions; the server associates only the terminal user's.
	const scope = user?.kind === "admin" && user.id !== terminal.userId ? "all" : "mine";
	const associate = useAssociateSession();
	const unassociate = useUnassociateSession();
	const [selected, setSelected] = useState("");
	const excluded = useMemo(
		() => [...terminal.sessionIds, ...(terminal.creatingSessionId === null ? [] : [terminal.creatingSessionId])],
		[terminal.sessionIds, terminal.creatingSessionId],
	);

	const add = () => {
		if (selected === "") return;
		associate.mutate({ id: terminal.id, sessionId: selected }, { onSuccess: () => setSelected("") });
	};

	return (
		<Panel className="grid min-w-0 gap-3" data-testid="terminal-associations">
			<SectionHeader title={<Trans>Associated sessions</Trans>} />
			{terminal.sessionIds.length === 0 ? (
				<EmptyHint>
					<Trans>No sessions are associated.</Trans>
				</EmptyHint>
			) : (
				<ul className="grid min-w-0 gap-1.5">
					{terminal.sessionIds.map((sessionId) => (
						<li key={sessionId} className="flex min-w-0 items-center gap-2">
							<InternalLink
								to="/sessions/$sessionId"
								params={{ sessionId }}
								className="min-w-0 flex-1 truncate font-mono text-xs"
								title={sessionId}
							>
								{sessionId}
							</InternalLink>
							<RowRemoveButton
								label={t`Remove session ${sessionId}`}
								disabled={unassociate.isPending}
								onClick={() => unassociate.mutate({ id: terminal.id, sessionId })}
							/>
						</li>
					))}
				</ul>
			)}
			<ErrorText error={unassociate.error} />
			<form
				className="flex min-w-0 flex-wrap items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					add();
				}}
			>
				<div className="grid min-w-0 flex-1 gap-1.5">
					<span className="text-sm font-medium">
						<Trans>Associate a session</Trans>
					</span>
					<EntityPicker
						kind="session"
						label={t`Associate a session`}
						sessionOwnerId={terminal.userId}
						sessionScope={scope}
						exclude={excluded}
						value={selected === "" ? null : selected}
						onChange={(id) => setSelected(id ?? "")}
						disabled={associate.isPending}
						testId="terminal-session-picker"
					/>
				</div>
				<Button type="submit" variant="outline" disabled={selected === "" || associate.isPending}>
					<Trans>Associate</Trans>
				</Button>
			</form>
			<ErrorText error={associate.error} />
		</Panel>
	);
}

/**
 * One terminal (doc/design/webui.md "Terminals page"): the xterm screen that fits its own grid, the
 * explicit Fit to window resize, the live size and viewers, the associations and close. A privileged
 * opening terminal shows its signature wait; an agent's rule approval shows the shared approval panel.
 * An exited terminal keeps its last screen and shows its exit code; once the retention window passed,
 * the API's 404 becomes a clear gone state.
 */
export function TerminalPage() {
	const { t, i18n } = useLingui();
	const params = useParams({ strict: false }) as { id?: string };
	const id = params.id ?? "";
	const terminal = useTerminal(id);
	// Only the terminal's user decides its approval; an administrator may view the terminal (the null
	// case is an unauthenticated render, which the router guard never leaves on this page).
	const currentUser = useAuth().user;
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const view = terminal.data;
	const signing = view?.authorizationPhase === "preparing" || view?.authorizationPhase === "waiting";
	const authorization = useTerminalAuthorization(id, signing);
	const submit = useSubmitAuthorization();
	const reject = useRejectTerminalAuthorization(id);
	const decide = useDecideTerminalApproval();
	const close = useCloseTerminal();
	const resize = useResizeTerminal();
	const [confirmingClose, setConfirmingClose] = useState(false);
	const [live, setLive] = useState<Partial<TerminalLiveState> | undefined>();
	const [exit, setExit] = useState<{ code: number; reason: "exited" | "helper_lost" } | undefined>();
	const [closedReason, setClosedReason] = useState<string | undefined>();
	const [attachError, setAttachError] = useState<string | undefined>();
	const viewer = useRef<TerminalViewHandle>(null);
	const announcedTitle = useRef<string | undefined>(undefined);

	const nodeLabel = view === undefined ? "" : (view.nodeName ?? view.nodeId);
	const title = live?.title ?? view?.title ?? "";
	// The program's title is untrusted, so the trusted node stays in the tab title and the heading.
	usePageTitle(view === undefined ? undefined : title === "" ? nodeLabel : `${title} · ${nodeLabel}`);

	const refresh = useCallback(() => {
		void terminal.refetch();
		void authorization.refetch();
	}, [terminal.refetch, authorization.refetch]);

	const fitToWindow = () => {
		if (view === undefined) return;
		const dimensions = viewer.current?.fitToWindow();
		if (dimensions === undefined) return;
		resize.mutate(
			{ id: view.id, size: dimensions },
			{
				onSuccess: (updated) => {
					setLive((previous) => ({
						...previous,
						rows: updated.size.rows,
						cols: updated.size.cols,
						state: updated.state,
					}));
					refresh();
				},
			},
		);
	};

	const loginShell = t`login shell`;
	const signatureRequest: ApprovalRequest | undefined =
		view !== undefined && signing
			? {
					kind: "task",
					id: view.id,
					phase: "awaiting_signature",
					source: { type: "user", userId: view.userId, username: view.username ?? "" },
					action: { type: "exec", command: terminalCommand(view.argv, loginShell) },
					...(view.nodeName === null ? {} : { nodes: [view.nodeName] }),
					privileged: view.privileged,
					alwaysAllow: [],
				}
			: undefined;
	const approval = view?.approval ?? null;
	// The server builds the same compact request every approval surface renders (doc/design/access-control.md "Approvals").
	const approvalRequest = view?.approvalRequest ?? undefined;

	const size = live?.rows !== undefined && live.cols !== undefined ? { rows: live.rows, cols: live.cols } : view?.size;
	const viewers = live?.viewers ?? view?.viewers ?? [];
	const liveState: PtyState | undefined = live?.state ?? view?.state;
	const exited = view?.state === "exited" || exit !== undefined;
	const exitCode = exit?.code ?? view?.exitCode ?? -1;

	if (terminal.isPending) {
		return (
			<Page width="detail" data-testid="terminal-page">
				<PageSkeleton />
			</Page>
		);
	}
	if (terminal.error !== null && terminal.error !== undefined) {
		if (isNotFound(terminal.error)) {
			return (
				<Page width="detail" data-testid="terminal-page">
					<PageHeader title={<Trans>Terminal</Trans>} />
					<TerminalGone />
				</Page>
			);
		}
		return (
			<Page width="detail" data-testid="terminal-page">
				<PageHeader title={<Trans>Terminal</Trans>} />
				<ErrorState error={terminal.error} retry={() => void terminal.refetch()} />
			</Page>
		);
	}
	if (view === undefined) return null;

	return (
		<Page width="detail" data-testid="terminal-page">
			<div>
				<Link
					to="/terminals"
					className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					<Trans>All terminals</Trans>
				</Link>
			</div>
			<PageHeader
				title={
					<span className="flex min-w-0 flex-wrap items-center gap-2">
						<span className="min-w-0 break-words">{view.nodeName ?? view.nodeId}</span>
						{view.privileged && <PrivilegedMark />}
					</span>
				}
				titleText={view.nodeName ?? view.nodeId}
				description={
					title === "" ? undefined : (
						<span
							data-testid="terminal-title"
							className="block max-w-full truncate text-xs text-muted-foreground"
							title={title}
						>
							{title}
						</span>
					)
				}
				actions={
					<>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={(liveState ?? view.state) !== "running" || resize.isPending}
							onClick={fitToWindow}
							data-testid="terminal-fit"
						>
							<MaximizeIcon />
							<Trans>Fit to window</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							variant="destructive"
							disabled={close.isPending}
							onClick={() => setConfirmingClose(true)}
							data-testid="terminal-close"
						>
							<Trans>Close terminal</Trans>
						</Button>
					</>
				}
			/>
			<ErrorText error={resize.error} />
			<p
				data-testid="terminal-meta"
				className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
			>
				<StatusText tone={terminalStateTone(liveState ?? view.state)}>
					{terminalStateLabel(i18n, liveState ?? view.state)}
				</StatusText>
				<span aria-hidden="true">·</span>
				<span className="inline-flex min-w-0 items-center gap-1">
					<Trans>Node</Trans>
					<InternalLink to="/nodes/$nodeId" params={{ nodeId: view.nodeId }} className="truncate">
						{view.nodeName ?? view.nodeId}
					</InternalLink>
				</span>
				<span aria-hidden="true">·</span>
				<span data-testid="terminal-size">
					<Trans>
						Size: {size?.cols ?? view.size.cols} × {size?.rows ?? view.size.rows}
					</Trans>
				</span>
				<span aria-hidden="true">·</span>
				<span className="inline-flex min-w-0 items-center gap-1">
					<Trans>User</Trans>
					<UserLink id={view.userId} name={view.username} />
				</span>
				{exited && (
					<>
						<span aria-hidden="true">·</span>
						<span data-testid="terminal-exit-code">
							<Trans>Exit code {exitCode}</Trans>
						</span>
					</>
				)}
				{exit?.reason === "helper_lost" && (
					<>
						<span aria-hidden="true">·</span>
						<span>
							<Trans>Privileged helper lost</Trans>
						</span>
					</>
				)}
			</p>
			{closedReason !== undefined && (
				<p
					role="status"
					data-testid="terminal-closed"
					className="rounded-lg border bg-muted px-3 py-2 text-sm text-muted-foreground"
				>
					<Trans>The terminal was closed ({closedReason}).</Trans>
				</p>
			)}
			<ErrorText error={attachError} />
			{signatureRequest !== undefined && (
				<SignaturePanel
					request={signatureRequest}
					phase={authorization.data?.phase}
					pending={authorization.data?.authorization ?? undefined}
					pendingError={authorization.isError ? authorization.error : undefined}
					onSubmit={(input: SubmitSignature) => submit.mutateAsync(input)}
					onChanged={refresh}
					onReject={(reason) =>
						reject.mutate(reason, {
							onSuccess: () => refresh(),
						})
					}
					busy={submit.isPending}
					rejectBusy={reject.isPending}
					error={submit.error}
					rejectError={reject.error}
				/>
			)}
			{approvalRequest !== undefined && (currentUser === null || currentUser.id === view.userId) && (
				<ApprovalPanel
					request={approvalRequest}
					busy={decide.isPending}
					error={decide.error}
					onDecide={(body: ApprovalBody) => {
						decide.mutate({ id: view.id, body }, { onSuccess: () => refresh() });
					}}
					details={
						approval?.method === "pty.io" ? (
							<pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-words">
								{approval.screen}
							</pre>
						) : undefined
					}
				/>
			)}
			{view.state !== "opening" && (
				<TerminalView
					ref={viewer}
					terminal={view}
					onState={(next) => {
						setLive((previous) => ({ ...previous, ...next }));
						if (next.title !== undefined && next.title !== announcedTitle.current) {
							announcedTitle.current = next.title;
							// The list's title column follows the program without waiting for its poll.
							void queryClient.invalidateQueries({ queryKey: terminalKeys.list() });
						}
					}}
					onExited={(code, reason) => setExit({ code, reason })}
					onClosed={(reason) => setClosedReason(reason)}
					onError={(message) => setAttachError(message)}
				/>
			)}
			{view.state === "opening" && signatureRequest === undefined && (
				<Panel className="flex items-center gap-2 text-sm text-muted-foreground">
					<Trans>Waiting for the terminal to open…</Trans>
				</Panel>
			)}
			<div className="grid min-w-0 gap-3 md:grid-cols-2">
				<TerminalAssociations terminal={view} />
				<Panel className="grid min-w-0 content-start gap-3" data-testid="terminal-viewers-panel">
					<SectionHeader title={<Trans>Viewers</Trans>} />
					<ViewerList viewers={viewers} />
				</Panel>
			</div>
			<ConfirmCloseDialog
				open={confirmingClose}
				terminal={view}
				busy={close.isPending}
				onOpenChange={setConfirmingClose}
				onConfirm={() => {
					close.mutate(view.id, {
						onSuccess: () => {
							setConfirmingClose(false);
							void navigate({ to: "/terminals" });
						},
					});
				}}
			/>
		</Page>
	);
}

/** The close confirmation, so a terminal is not dropped by a stray click. */
function ConfirmCloseDialog({
	open,
	terminal,
	busy,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	terminal: PtyView;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	const { t } = useLingui();
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t`Close the terminal on ${terminal.nodeName ?? terminal.nodeId}?`}
			description={<Trans>The process ends now, with every program running inside it, and the terminal is gone.</Trans>}
			confirmLabel={<Trans>Close terminal</Trans>}
			busy={busy}
			onConfirm={onConfirm}
		/>
	);
}
