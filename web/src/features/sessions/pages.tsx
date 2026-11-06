import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/skeletons";
import { approvalKeys } from "@/features/approvals/api";
import { sessionUiState } from "@/lib/status";
import {
	useSession,
	useSessionChildren,
	useSessionChildrenSummary,
	useSessionHistoryPage,
	useSessionRootId,
	useSessionTreeSync,
} from "./api";
import { ChildrenBar } from "./children-bar";
import { Composer } from "./composer";
import { SessionBanner } from "./session-banner";
import { SessionHeader } from "./session-header";
import { SessionWaits } from "./session-waits";
import { isCompacting, type LiveTool, transcript } from "./sessionState";
import { Transcript } from "./transcript";
import { useSessionEvents } from "./use-session-events";

/** The live tool calls whose details say they wait for an approval or a signature. */
function waitingTools(tools: Record<string, LiveTool>): string {
	const waiting: string[] = [];
	for (const tool of Object.values(tools)) {
		if (tool.status === "done") continue;
		const details = tool.details;
		if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details)) continue;
		if (details.state === "awaiting_approval" || details.state === "awaiting_authorization")
			waiting.push(`${tool.callId}:${details.state}`);
	}
	return waiting.sort().join(",");
}

export function SessionPage() {
	const params = useParams({ strict: false }) as { sessionId?: string };
	const sessionId = params.sessionId ?? "";
	const session = useSession(sessionId);
	const rootId = useSessionRootId(session.data);
	const tree = useSessionTreeSync(sessionId, rootId);
	const events = useSessionEvents(sessionId);
	const children = useSessionChildren(sessionId, rootId, events.childrenRevision);
	const childrenSummary = useSessionChildrenSummary(sessionId);
	const [wantsOlder, setWantsOlder] = useState(false);
	const history = useSessionHistoryPage(sessionId, events.state.historyCursor, wantsOlder);
	const items = useMemo(() => transcript(events.state), [events.state]);
	// A live compaction keeps the session "doing something" even while no run is active (a manual /compact
	// outlives the run), so Stop must stay available.
	const compacting = isCompacting(events.state);
	const queryClient = useQueryClient();
	// The waiting state arrives ahead of the approvals poll (SSE / the session view), so the cards must ask
	// for their decisions as soon as it changes, not up to 10 s later.
	const current = session.data;
	const treeWaiting = current?.parentSessionId === null && tree?.state === "awaiting";
	const waitingToolsKey = waitingTools(events.state.tools);
	const waiting = current?.state === "awaiting" || (current?.waitingKind ?? null) !== null || treeWaiting;
	// A value that changes with every transition into or within a wait, including a live tool that starts
	// reporting one; an empty value is not waiting and needs no refresh.
	const waitSignal =
		waiting || waitingToolsKey !== ""
			? `${current?.state ?? ""}|${current?.waitingKind ?? ""}|${treeWaiting ? "tree" : ""}|${waitingToolsKey}`
			: "";

	useEffect(() => {
		if (waitSignal === "") return;
		void queryClient.invalidateQueries({ queryKey: approvalKeys.list() });
	}, [waitSignal, queryClient]);

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
			<SessionHeader session={view} />
			<SessionBanner
				connection={events.connection}
				failure={events.state.failure}
				retry={events.state.retry}
				waitingKind={view.waitingKind}
				queued={events.state.queued}
			/>
			{waiting && <SessionWaits session={view} />}

			{events.state.ready ? (
				<Transcript
					key={view.id}
					items={items}
					streams={events.streams}
					ready={events.state.ready}
					// The page's live state decides whether a call without a result can still return.
					sessionActive={sessionUiState(view.state) !== "idle"}
					hasOlder={events.state.historyCursor !== null}
					loadingOlder={history.isFetching}
					onLoadOlder={() => setWantsOlder(true)}
					empty={<Trans>No messages yet. Start the conversation below.</Trans>}
				/>
			) : (
				<div className="min-h-0 flex-1 overflow-hidden p-4">
					<PageSkeleton rows={4} />
				</div>
			)}

			<ChildrenBar query={children} summary={childrenSummary.data} />
			<Composer session={view} stoppable={events.state.running || busy || compacting} />
		</div>
	);
}

export { NewSessionPage } from "./new-session-page";
