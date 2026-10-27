import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type AvailableModel, api, type ModelRef, type Preset, type SessionView } from "../api.ts";
import { ErrorText, Loading } from "../components/Feedback.tsx";
import { ModelSelect, PresetSelect } from "../components/ModelSelect.tsx";
import { ToolCard } from "../components/ToolCard.tsx";
import { useAction, useLoad } from "../hooks.ts";
import { transcript, usageTotals } from "../sessionState.ts";
import { useSessionEvents } from "../useSessionEvents.ts";
import { Shares } from "./Shares.tsx";

function Settings({
	session,
	models,
	onChange,
}: {
	session: SessionView;
	models: AvailableModel[];
	onChange: () => void;
}) {
	const [title, setTitle] = useState(session.title);
	const { busy, error, run } = useAction();
	useEffect(() => setTitle(session.title), [session.title]);
	const patch = async (body: Parameters<typeof api.patchSession>[1]) => {
		if (await run(() => api.patchSession(session.id, body))) onChange();
	};
	const saveTitle = (e: FormEvent) => {
		e.preventDefault();
		if (title.trim() && title.trim() !== session.title) void patch({ title: title.trim() });
	};
	return (
		<div className="stack">
			<div className="row wrap">
				<form onSubmit={saveTitle} className="row">
					<label>
						Title
						<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
					</label>
					<button type="submit" disabled={busy || !title.trim() || title.trim() === session.title}>
						Save title
					</button>
				</form>
				<ModelSelect
					models={models}
					value={session.model}
					disabled={busy}
					onChange={(m: ModelRef) => void patch({ model: m })}
				/>
				<PresetSelect
					value={(session.rules?.preset ?? "ask") as Preset}
					disabled={busy}
					onChange={(p) => void patch({ preset: p })}
				/>
			</div>
			<ErrorText error={error} />
		</div>
	);
}

function Composer({ id, running, canChat }: { id: string; running: boolean; canChat: boolean }) {
	const [text, setText] = useState("");
	const { busy, error, run } = useAction();
	const send = async () => {
		const t = text.trim();
		if (!t || busy) return;
		const requestId = crypto.randomUUID();
		if (await run(() => api.sendMessage(id, t, requestId))) setText("");
	};
	const stop = useAction();
	if (!canChat)
		return <p className="muted">You have view access: the owner can let you send messages by sharing it for chat.</p>;
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void send();
		}
	};
	return (
		<form
			className="composer stack"
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			<label>
				Message
				<textarea
					rows={3}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKey}
					disabled={busy}
					placeholder="Ask the agent to do something. Enter sends, Shift+Enter adds a line."
				/>
			</label>
			<ErrorText error={error ?? stop.error} />
			<div className="row end">
				{running && (
					<button
						type="button"
						className="danger"
						disabled={stop.busy}
						onClick={() => void stop.run(() => api.abortSession(id))}
					>
						Stop
					</button>
				)}
				<button type="submit" className="primary" disabled={busy || !text.trim()}>
					Send
				</button>
			</div>
		</form>
	);
}

export function SessionPage({ id }: { id: string }) {
	const session = useLoad(() => api.getSession(id), [id]);
	const models = useLoad(() => api.listModels(), []);
	const { state, connection } = useSessionEvents(id);
	const items = transcript(state);
	const logRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the transcript changes
	useEffect(() => {
		if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight });
	}, [state.entries, state.streaming, state.tools]);
	useEffect(() => {
		const on = () => {
			stick.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
		};
		window.addEventListener("scroll", on, { passive: true });
		return () => window.removeEventListener("scroll", on);
	}, []);
	const totals = usageTotals(state.usage);
	const wasRunning = useRef(false);
	// The quota and spend live on the session: refresh them when a run ends.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload only on the running -> idle edge
	useEffect(() => {
		if (wasRunning.current && !state.running) session.reload();
		wasRunning.current = state.running;
	}, [state.running]);

	if (session.error) {
		return (
			<>
				<p>
					<a href="#/sessions">Sessions</a>
				</p>
				<ErrorText error={session.error} />
			</>
		);
	}
	if (!session.data) return <Loading loading error={session.error} />;
	return (
		<>
			<p>
				<a href="#/sessions">Sessions</a>
			</p>
			<h1>{session.data.title}</h1>
			{session.data.parentSessionId && (
				<p className="muted">
					A subagent of{" "}
					<a href={`#/sessions/${encodeURIComponent(session.data.parentSessionId)}`}>its parent session</a>.
				</p>
			)}
			{session.data.access !== "owner" && (
				<p className="muted">
					Shared by {session.data.ownerUsername ?? "another user"} ({session.data.access} access).
				</p>
			)}
			{session.data.access === "owner" && (
				<Settings session={session.data} models={models.data ?? []} onChange={session.reload} />
			)}
			<div className="row wrap muted" role="status">
				{connection !== "live" && <span>{connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>}
				{state.running && <span>Working…</span>}
				{state.retry && <span>Retrying after an error: {state.retry}</span>}
				{state.queued > 0 && <span>{state.queued} message(s) queued</span>}
				{totals && (
					<span>
						{totals.tokens.toLocaleString()} tokens
						{session.data.parentSessionId !== null &&
							session.data.quota !== null &&
							` · ${session.data.quota.toLocaleString()} quota left`}
					</span>
				)}
			</div>
			<ErrorText error={state.failure} />
			<div className="chat" role="log" aria-label="Conversation" aria-live="polite" ref={logRef}>
				{state.ready && items.length === 0 && <p className="muted">No messages yet.</p>}
				{items.map((item) => {
					switch (item.kind) {
						case "user":
							return (
								<div key={item.key} className="msg user">
									<span className="who-label">You</span>
									<pre className="chat-text">{item.text}</pre>
								</div>
							);
						case "text":
							return (
								<div key={item.key} className="msg assistant">
									<span className="who-label">Agent</span>
									<pre className="chat-text">{item.text}</pre>
								</div>
							);
						case "thinking":
							return (
								<details key={item.key} className="thinking">
									<summary>Thinking</summary>
									<pre className="chat-text muted">{item.text}</pre>
								</details>
							);
						case "tool":
							return <ToolCard key={item.key} tool={item} running={state.running} />;
						case "error":
							return (
								<p key={item.key} className="error">
									{item.text}
								</p>
							);
						default:
							return null;
					}
				})}
			</div>
			<Composer
				id={id}
				running={state.running}
				canChat={session.data.access === "owner" || session.data.access === "chat"}
			/>
			{(session.data.access === "owner" || session.data.access === "admin") && (
				<Shares target="session" id={id} shares={session.data.shares ?? []} onChange={session.reload} />
			)}
		</>
	);
}
