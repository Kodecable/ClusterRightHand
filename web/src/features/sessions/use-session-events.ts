import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, enc } from "@/lib/api/client";
import { subscribeSse } from "@/lib/api/sse";
import type { AgentEvent, EntryRecord } from "./session-events";
import { initialState, prependHistory, reduceAll, type SessionState } from "./session-reducer";
import { TranscriptStreams } from "./transcript-streams";

export type Connection = "connecting" | "live" | "reconnecting";

export interface SessionEvents {
	/** The structural transcript state; the streaming text itself lives in `streams`. */
	state: SessionState;
	connection: Connection;
	/**
	 * A terminal stream failure (401, 403 or 404): the subscription closed and
	 * no reconnect is scheduled, so the page must not keep showing its state.
	 */
	error: ApiError | undefined;
	streams: TranscriptStreams;
	/** Prepends a page loaded from `GET /sessions/:id/entries`, without disturbing the live stream. */
	applyHistory: (entries: readonly EntryRecord[], historyCursor: string | null) => void;
	/**
	 * Bumped when the child-session list may have changed: a `snapshot` (the
	 * stream reconnected or opened) or a `subagent` tool update/end
	 * (doc/webui.md#api-约定). The children query refetches on every bump.
	 */
	childrenRevision: number;
}

/** Whether an event makes the session's child list stale. */
function touchesChildren(event: AgentEvent): boolean {
	if (event.type === "snapshot") return true;
	if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return false;
	return (event as { toolName?: unknown }).toolName === "subagent";
}

/** The shape the stream promises; anything else is dropped rather than fed to the reducer. */
function isAgentEvent(value: unknown): value is AgentEvent {
	return value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

/**
 * A cheap identity of everything the transcript list has to re-render for.
 * Deliberately excludes the growing text of the streaming message and of a
 * running tool: those live in `TranscriptStreams`, subscribed by their row.
 */
function structureKey(state: SessionState): string {
	const first = state.entries[0]?.id ?? "";
	const last = state.entries[state.entries.length - 1]?.id ?? "";
	const blocks = state.streaming?.content.map((block) => block.type).join(",") ?? "";
	// The details are what a tool card shows besides its status (an approval link, a
	// task's exit code), and they arrive in `tool_execution_update` events of their
	// own; without them a details-only batch would never reach React.
	const tools = Object.values(state.tools)
		.map((tool) => `${tool.callId}:${tool.status}:${tool.details === undefined ? "" : JSON.stringify(tool.details)}`)
		.sort()
		.join(",");
	return [
		state.ready,
		state.entries.length,
		first,
		last,
		state.liveKey ?? "",
		blocks,
		tools,
		state.running,
		state.compactions.map((compaction) => compaction.taskId).join(","),
		state.queued,
		state.retry ?? "",
		state.failure ?? "",
		state.historyCursor ?? "",
	].join("|");
}

/**
 * Follows `GET /api/sessions/:id/events` (doc/webui.md "会话事件流").
 *
 * A reconnect starts with a fresh snapshot, which replaces the state. Event
 * batches are reduced into a ref; only a change of the transcript's structure
 * is committed to React, while the growing text goes to the per-row stores, so
 * a fast stream does not re-render the message list. History pages arrive
 * through `prependHistory` on the same reducer state, so they can never
 * overwrite the live message.
 */
export function useSessionEvents(id: string | undefined): SessionEvents {
	const [state, setState] = useState<SessionState>(initialState);
	const [connection, setConnection] = useState<Connection>("connecting");
	const [error, setError] = useState<ApiError | undefined>(undefined);
	const [childrenRevision, setChildrenRevision] = useState(0);
	const stateRef = useRef<SessionState>(initialState);
	const publishedKey = useRef<string | null>(null);
	const streamsRef = useRef<TranscriptStreams>(new TranscriptStreams());
	const streams = streamsRef.current;

	useEffect(() => {
		stateRef.current = initialState;
		publishedKey.current = null;
		streams.disposeAll();
		setState(initialState);
		setError(undefined);
		if (id === undefined || id === "") {
			setConnection("connecting");
			return;
		}
		setConnection("connecting");
		const unsubscribe = subscribeSse({
			url: `/api/sessions/${enc(id)}/events`,
			events: ["events"],
			onEvent: (name, data) => {
				if (name !== "events" || !Array.isArray(data)) return;
				const events = data.filter(isAgentEvent);
				if (events.length === 0) return;
				if (events.some(touchesChildren)) setChildrenRevision((value) => value + 1);
				const next = reduceAll(stateRef.current, events);
				stateRef.current = next;
				streams.sync(next);
				const key = structureKey(next);
				// A snapshot can change hidden state (the streamed-row keys it drops)
				// without changing the list's structure; it must still reach React.
				if (events.some((event) => event.type === "snapshot") || key !== publishedKey.current) {
					publishedKey.current = key;
					setState(next);
				}
				setConnection("live");
			},
			onOpen: () => setConnection("live"),
			onError: () => setConnection("reconnecting"),
			onTerminal: (terminal) => setError(terminal),
		});
		return () => {
			unsubscribe();
			streams.disposeAll();
		};
	}, [id, streams]);

	const applyHistory = useCallback(
		(entries: readonly EntryRecord[], historyCursor: string | null) => {
			const next = prependHistory(stateRef.current, entries, historyCursor);
			if (next === stateRef.current) return;
			stateRef.current = next;
			streams.sync(next);
			const key = structureKey(next);
			if (key !== publishedKey.current) {
				publishedKey.current = key;
				setState(next);
			}
		},
		[streams],
	);

	return { state, connection, error, streams, applyHistory, childrenRevision };
}
