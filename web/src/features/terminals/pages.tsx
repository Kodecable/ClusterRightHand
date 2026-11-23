import type { ApprovalBody, ApprovalRequest, PtyState, PtyView, PtyViewer } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, MaximizeIcon, PlusIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ApprovalPanel } from "@/components/decision/approval-panel";
import { SignaturePanel, type SubmitSignature } from "@/components/decision/signature-panel";
import { ConfirmDialog } from "@/components/dialogs";
import { EmptyHint, EmptyState } from "@/components/empty-state";
import { ErrorState, ErrorText } from "@/components/error-state";
import { InternalLink } from "@/components/internal-link";
import { KeyValueList } from "@/components/key-value";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { PrivilegedMark } from "@/components/privileged-mark";
import { RelativeTime } from "@/components/relative-time";
import { RowRemoveButton } from "@/components/row-remove-button";
import { Panel, SectionHeader } from "@/components/section";
import { PageSkeleton } from "@/components/skeletons";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserLink } from "@/components/user-link";
import { useSubmitAuthorization } from "@/features/authorizations/api";
import { useNodeNames } from "@/features/nodes/api";
import { useSessions } from "@/features/sessions/api";
import { isNotFound } from "@/lib/api/client";
import { flattenCursorPages } from "@/lib/api/query";
import { usePageTitle } from "@/lib/page-title";
import { useAuth } from "@/lib/session";
import { displaySessionTitle } from "@/lib/session-title";
import {
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

/** One terminal list row: node, user, privileged flag, state, creating session, associations, viewers, age. */
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

/** The user/or/opened facts of one terminal. */
function TerminalFacts({ terminal }: { terminal: PtyView }) {
	const { t } = useLingui();
	const nodeNames = useNodeNames();
	return (
		<KeyValueList
			items={[
				{
					label: <Trans>Node</Trans>,
					value: (
						<InternalLink to="/nodes/$nodeId" params={{ nodeId: terminal.nodeId }}>
							{nodeNames.get(terminal.nodeId) ?? terminal.nodeName ?? terminal.nodeId}
						</InternalLink>
					),
				},
				{
					label: <Trans>User</Trans>,
					value: <UserLink id={terminal.userId} name={terminal.username} />,
				},
				{
					label: <Trans>Creating session</Trans>,
					value:
						terminal.creatingSessionId === null ? (
							t`Person`
						) : (
							<InternalLink
								to="/sessions/$sessionId"
								params={{ sessionId: terminal.creatingSessionId }}
								className="font-mono text-xs"
							>
								{terminal.creatingSessionId}
							</InternalLink>
						),
				},
				{
					label: <Trans>Opened</Trans>,
					value: <RelativeTime value={terminal.openedAt} />,
				},
				...(terminal.idleTimeoutMs === null
					? []
					: [
							{
								label: <Trans>Idle timeout</Trans>,
								value: t`${Math.round(terminal.idleTimeoutMs / 60_000)} min`,
							},
						]),
			]}
		/>
	);
}

/** The other viewers of one terminal, live from the attach state frames. */
function ViewerList({ viewers }: { viewers: readonly PtyViewer[] }) {
	return viewers.length === 0 ? (
		<EmptyHint>
			<Trans>No one is watching.</Trans>
		</EmptyHint>
	) : (
		<ul className="grid min-w-0 gap-1.5 text-sm" data-testid="terminal-viewers">
			{viewers.map((viewer) => (
				<li key={viewer.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<UserLink id={viewer.userId} name={viewer.username} />
					{viewer.clientAddress !== null && (
						<span className="font-mono text-xs text-muted-foreground">{viewer.clientAddress}</span>
					)}
					<span className="text-xs text-muted-foreground">
						<RelativeTime value={viewer.attachedAt} />
					</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The associations of one terminal (doc/design/pty.md "The terminal object"): add one of the terminal
 * user's sessions the caller can reach, or remove an existing one.
 */
function TerminalAssociations({ terminal }: { terminal: PtyView }) {
	const { t, i18n } = useLingui();
	const user = useAuth().user;
	// Only an administrator may list another user's sessions; the server associates only the terminal user's.
	const scope = user?.kind === "admin" && user.id !== terminal.userId ? "all" : "mine";
	const sessions = useSessions({ scope, ownerId: terminal.userId, limit: 100 });
	const associate = useAssociateSession();
	const unassociate = useUnassociateSession();
	const [selected, setSelected] = useState("");

	const candidates = useMemo(() => {
		const associated = new Set(terminal.sessionIds);
		return flattenCursorPages(sessions.data).filter(
			(session) => session.id !== terminal.creatingSessionId && !associated.has(session.id),
		);
	}, [sessions.data, terminal.sessionIds, terminal.creatingSessionId]);

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
			{candidates.length > 0 && (
				<form
					className="flex min-w-0 flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						add();
					}}
				>
					<div className="grid min-w-0 flex-1 gap-1.5">
						<Label htmlFor="terminal-associate-session">
							<Trans>Associate a session</Trans>
						</Label>
						<Select
							value={selected === "" ? null : selected}
							onValueChange={(next) => setSelected(next ?? "")}
							disabled={associate.isPending}
						>
							<SelectTrigger id="terminal-associate-session" className="w-full">
								<SelectValue placeholder={t`Choose a session`}>
									{(current: string | null) => {
										const session = candidates.find((candidate) => candidate.id === current);
										return session === undefined ? t`Choose a session` : displaySessionTitle(session.title, i18n);
									}}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{candidates.map((session) => (
									<SelectItem key={session.id} value={session.id}>
										{displaySessionTitle(session.title, i18n)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<Button type="submit" variant="outline" disabled={selected === "" || associate.isPending}>
						<Trans>Associate</Trans>
					</Button>
				</form>
			)}
			<ErrorText error={associate.error} />
		</Panel>
	);
}

/**
 * One terminal (doc/design/webui.md "Terminals page"): the xterm screen, the explicit Fit to window, the
 * live size and viewers, the associations and close. A privileged opening terminal shows its signature
 * wait; an agent's rule approval shows the shared approval panel. An exited terminal keeps its last
 * screen and shows its exit code; once the retention window passed, the API's 404 becomes a clear gone
 * state.
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
	const view = terminal.data;
	const signing = view?.authorizationPhase === "preparing" || view?.authorizationPhase === "waiting";
	const authorization = useTerminalAuthorization(id, signing);
	const submit = useSubmitAuthorization();
	const reject = useRejectTerminalAuthorization(id);
	const decide = useDecideTerminalApproval();
	const resize = useResizeTerminal();
	const close = useCloseTerminal();
	const viewer = useRef<TerminalViewHandle>(null);
	const [confirmingClose, setConfirmingClose] = useState(false);
	const [live, setLive] = useState<Partial<TerminalLiveState> | undefined>();
	const [exit, setExit] = useState<{ code: number; reason: "exited" | "helper_lost" } | undefined>();
	const [closedReason, setClosedReason] = useState<string | undefined>();
	const [attachError, setAttachError] = useState<string | undefined>();

	usePageTitle(view === undefined ? undefined : (view.nodeName ?? view.nodeId));

	const refresh = useCallback(() => {
		void terminal.refetch();
		void authorization.refetch();
	}, [terminal.refetch, authorization.refetch]);

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
				actions={
					<>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={view.state !== "running" || resize.isPending}
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
			{exited && (
				<p
					role="status"
					data-testid="terminal-exited"
					className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn"
				>
					<TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
					<span>
						<Trans>The process exited with code {exitCode}.</Trans>
					</span>
					{exit?.reason === "helper_lost" && (
						<span>
							<Trans>The terminal lost its privileged helper.</Trans>
						</span>
					)}
				</p>
			)}
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
					onState={(next) => setLive(next)}
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
			<Panel className="grid min-w-0 gap-3" data-testid="terminal-facts">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<StatusText tone={terminalStateTone(liveState ?? view.state)}>
						{terminalStateLabel(i18n, liveState ?? view.state)}
					</StatusText>
					<span className="text-sm text-muted-foreground" data-testid="terminal-size">
						<Trans>
							Size: {size?.cols ?? view.size.cols} × {size?.rows ?? view.size.rows}
						</Trans>
					</span>
				</div>
				<TerminalFacts terminal={view} />
			</Panel>
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
