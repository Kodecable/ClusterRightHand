import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/skeletons";
import { approvalKeys } from "@/features/approvals/api";
import { sessionUiState } from "@/lib/status";
import {
	useMarkSessionRead,
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
import { isCompacting, type LiveTool } from "./session-reducer";
import { SessionWaits } from "./session-waits";
import { Transcript } from "./transcript";
import { transcript } from "./transcript-items";
import { useSessionEvents } from "./use-session-events";

/** How many older history pages a jump-to-message may load before giving up (doc/webui.md "跳到消息"). */
const MAX_JUMP_PAGES = 20;

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
	const { entry } = useSearch({ strict: false }) as { entry?: number };
	const { t } = useLingui();
	const navigate = useNavigate();
	const session = useSession(sessionId);
	const rootId = useSessionRootId(session.data);
	const tree = useSessionTreeSync(sessionId, rootId);
	const events = useSessionEvents(sessionId);
	const children = useSessionChildren(sessionId, rootId, events.childrenRevision);
	const childrenSummary = useSessionChildrenSummary(sessionId);
	const [wantsOlder, setWantsOlder] = useState(false);
	const history = useSessionHistoryPage(sessionId, events.state.historyCursor, wantsOlder);
	const items = useMemo(() => transcript(events.state), [events.state]);
	// Jump-to-message (doc/webui.md "跳到消息"): `entry` is the id a search hit pointed at.
	const [jumpEntry, setJumpEntry] = useState<number | undefined>(undefined);
	const [jumpPages, setJumpPages] = useState(0);
	const [focusEntry, setFocusEntry] = useState<string | undefined>(undefined);
	const clearJumpParam = useCallback(() => {
		void navigate({ to: "/sessions/$sessionId", params: { sessionId }, search: {}, replace: true });
	}, [navigate, sessionId]);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new session starts with no pending older-page request and no jump
	useEffect(() => {
		setWantsOlder(false);
		setJumpEntry(undefined);
		setJumpPages(0);
		setFocusEntry(undefined);
	}, [sessionId]);

	// A new `?entry=` starts a jump: reset the page budget that the effects below consume.
	useEffect(() => {
		if (entry === undefined) return;
		setJumpEntry(entry);
		setJumpPages(0);
	}, [entry]);

	useEffect(() => {
		if (jumpEntry === undefined) return;
		const target = String(jumpEntry);
		// Either the snapshot or a loaded older page carries the entry; mark the first rendered row.
		if (items.some((item) => item.entryId === target)) {
			setFocusEntry(target);
			setJumpEntry(undefined);
			clearJumpParam();
			return;
		}
		// The initial snapshot decides whether the entry is already loaded; waiting for it avoids a
		// pointless history request and gives up only on a page that really has no older entries.
		if (!events.state.ready) return;
		if (wantsOlder || history.isFetching) return;
		if (events.state.historyCursor === null || jumpPages >= MAX_JUMP_PAGES) {
			toast.error(t`Couldn't find that message in this session.`);
			setJumpEntry(undefined);
			clearJumpParam();
			return;
		}
		setJumpPages((pages) => pages + 1);
		setWantsOlder(true);
	}, [
		jumpEntry,
		items,
		events.state.ready,
		events.state.historyCursor,
		wantsOlder,
		history.isFetching,
		jumpPages,
		clearJumpParam,
		t,
	]);

	useEffect(() => {
		if (!history.data) return;
		events.applyHistory(history.data.entries, history.data.historyCursor);
		setWantsOlder(false);
	}, [history.data, events.applyHistory]);

	// Unread (doc/webui.md "侧边列表"): opening a tree marks it read for its owner, and so does new output
	// arriving while the page is open. A hidden tab defers the mark until it is visible again, because
	// "read" means the owner can see the output.
	const markRead = useMarkSessionRead(rootId);
	const isOwner = session.data?.relationship === "owner";
	const pendingRead = useRef(false);
	const openedFor = useRef<string | undefined>(undefined);
	const previousTreeState = useRef<string | undefined>(undefined);
	const markReadWhenVisible = useCallback(() => {
		if (!isOwner || rootId === undefined) return;
		if (document.visibilityState === "visible") markRead.mutate(sessionId);
		else pendingRead.current = true;
	}, [isOwner, rootId, sessionId, markRead]);

	useEffect(() => {
		if (!isOwner || rootId === undefined || openedFor.current === sessionId) return;
		openedFor.current = sessionId;
		markReadWhenVisible();
	}, [isOwner, rootId, sessionId, markReadWhenVisible]);

	useEffect(() => {
		const state = tree?.state;
		if (state === undefined) return;
		const previous = previousTreeState.current;
		previousTreeState.current = state;
		if (previous === "running" && (state === "idle" || state === "awaiting")) markReadWhenVisible();
	}, [tree, markReadWhenVisible]);

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState !== "visible" || !pendingRead.current) return;
			pendingRead.current = false;
			markReadWhenVisible();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [markReadWhenVisible]);

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
	// The event stream can end without a new session fetch, e.g. when the session was deleted after the page
	// loaded. A 401 is left to the auth store's redirect; the other terminal statuses replace the stale view.
	if (events.error !== undefined && events.error.status !== 401) {
		return (
			<div className="p-6">
				<ErrorState error={events.error} retry={() => void session.refetch()} />
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
					focusEntry={focusEntry}
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
