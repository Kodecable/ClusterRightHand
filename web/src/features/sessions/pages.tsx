import { Plural, Trans } from "@lingui/react/macro";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/skeletons";
import { flattenCursorPages } from "@/lib/api/query";
import { useSession, useSessionChildren, useSessionHistoryPage, useSessionRootId, useSessionTreeSync } from "./api";
import { ChildSessions, SessionChildrenProvider } from "./child-sessions";
import { Composer } from "./composer";
import { SessionHeader } from "./session-header";
import { SessionWaits } from "./session-waits";
import { transcript, usageTotals } from "./sessionState";
import { Transcript } from "./transcript";
import { useSessionEvents } from "./use-session-events";

export function SessionPage() {
	const params = useParams({ strict: false }) as { sessionId?: string };
	const sessionId = params.sessionId ?? "";
	const session = useSession(sessionId);
	const rootId = useSessionRootId(session.data);
	const tree = useSessionTreeSync(sessionId, rootId);
	const events = useSessionEvents(sessionId);
	const children = useSessionChildren(sessionId, rootId, events.childrenRevision);
	const childItems = useMemo(() => flattenCursorPages(children.data), [children.data]);
	const [wantsOlder, setWantsOlder] = useState(false);
	const history = useSessionHistoryPage(sessionId, events.state.historyCursor, wantsOlder);
	const items = useMemo(() => transcript(events.state), [events.state]);
	const totals = usageTotals(events.state.usage);
	const tokenText = totals === undefined ? undefined : totals.tokens.toLocaleString();

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new session starts with no pending older-page request
	useEffect(() => {
		setWantsOlder(false);
	}, [sessionId]);

	useEffect(() => {
		if (!history.data) return;
		events.applyHistory(history.data.entries, history.data.historyCursor);
		setWantsOlder(false);
	}, [history.data, events.applyHistory]);

	if (session.isPending) {
		return (
			<div className="p-6">
				<PageSkeleton />
			</div>
		);
	}
	if (session.error !== null && session.error !== undefined) {
		return (
			<div className="p-6">
				<ErrorState error={session.error} retry={() => void session.refetch()} />
			</div>
		);
	}
	if (!session.data) return null;
	const view = session.data;
	const isRoot = view.parentSessionId === null;
	// Abort stops the session and every subagent under its root; the list stream
	// aggregates roots only, so a child page follows its own state.
	const treeBusy = isRoot && tree !== undefined && tree.state !== "idle";
	const busy = view.state !== "idle" || treeBusy;

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="session-page" data-session-id={view.id}>
			<SessionHeader session={view} stoppable={busy} />
			{(view.state === "awaiting" || view.waitingKind !== null || (isRoot && tree?.state === "awaiting")) && (
				<SessionWaits session={view} />
			)}

			{events.connection !== "live" && (
				<p className="shrink-0 bg-muted px-3 py-1 text-xs text-muted-foreground" role="status">
					{events.connection === "connecting" ? <Trans>Connecting…</Trans> : <Trans>Reconnecting…</Trans>}
				</p>
			)}
			{(events.state.running ||
				events.state.queued > 0 ||
				events.state.retry !== undefined ||
				tokenText !== undefined) && (
				<p
					className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-1 text-xs text-muted-foreground"
					role="status"
				>
					{events.state.running && <Trans>Working…</Trans>}
					{events.state.retry !== undefined && <Trans>Retrying after an error: {events.state.retry}</Trans>}
					{events.state.queued > 0 && (
						<Plural value={events.state.queued} one="# message queued" other="# messages queued" />
					)}
					{tokenText !== undefined && <Trans>{tokenText} tokens</Trans>}
				</p>
			)}
			{events.state.failure !== undefined && (
				<p role="alert" className="shrink-0 bg-danger-bg px-3 py-1 text-xs text-danger">
					{events.state.failure}
				</p>
			)}

			<ChildSessions query={children} />

			{events.state.ready ? (
				<SessionChildrenProvider items={childItems}>
					<Transcript
						key={view.id}
						items={items}
						streams={events.streams}
						ready={events.state.ready}
						hasOlder={events.state.historyCursor !== null}
						loadingOlder={history.isFetching}
						onLoadOlder={() => setWantsOlder(true)}
						empty={<Trans>No messages yet. Start the conversation below.</Trans>}
					/>
				</SessionChildrenProvider>
			) : (
				<div className="min-h-0 flex-1 overflow-hidden p-4">
					<PageSkeleton rows={4} />
				</div>
			)}

			<Composer
				sessionId={view.id}
				canChat={view.capabilities.chat}
				stoppable={events.state.running || busy}
				waitingKind={view.waitingKind}
			/>
		</div>
	);
}
