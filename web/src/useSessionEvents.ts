import { useEffect, useReducer, useState } from "react";
import { type AgentEvent, initialState, reduceAll, type SessionState } from "./sessionState.ts";

export type Connection = "connecting" | "live" | "reconnecting";

type Action = { type: "events"; events: AgentEvent[] } | { type: "reset" };

function reducer(state: SessionState, action: Action): SessionState {
	return action.type === "reset" ? initialState : reduceAll(state, action.events);
}

const RETRY_MS = 2000;

/**
 * Follows a session's event stream. Every (re)connection starts with a fresh snapshot, which replaces the state,
 * so a reconnect needs no bookkeeping here.
 */
export function useSessionEvents(id: string): { state: SessionState; connection: Connection } {
	const [state, dispatch] = useReducer(reducer, initialState);
	const [connection, setConnection] = useState<Connection>("connecting");
	useEffect(() => {
		let es: EventSource | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		dispatch({ type: "reset" });
		setConnection("connecting");
		const open = () => {
			es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
			es.addEventListener("events", (e) => {
				try {
					dispatch({ type: "events", events: JSON.parse((e as MessageEvent<string>).data) as AgentEvent[] });
					setConnection("live");
				} catch {}
			});
			es.onerror = () => {
				if (closed) return;
				setConnection("reconnecting");
				// The browser retries network errors itself; after an HTTP error the stream is closed for good.
				if (es && es.readyState === EventSource.CLOSED) {
					timer = setTimeout(open, RETRY_MS);
				}
			};
		};
		open();
		return () => {
			closed = true;
			clearTimeout(timer);
			es?.close();
		};
	}, [id]);
	return { state, connection };
}
