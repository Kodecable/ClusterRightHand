import { Trans, useLingui } from "@lingui/react/macro";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { Textarea } from "@/components/ui/textarea";
import type { SessionView, SessionWaitingKind } from "@/lib/api/types";
import { useAbortSession, useSendMessage } from "./api";
import { ComposerFooter } from "./composer-footer";
import { ComposerMeta } from "./composer-meta";

export interface ComposerProps {
	session: SessionView;
	/** There is something this session (or its tree) runs that Stop can end. */
	stoppable: boolean;
	waitingKind: SessionWaitingKind | null;
}

/**
 * The message composer (doc/webui.md "会话界面"): multiline, Enter sends and
 * Shift+Enter adds a line, the send is disabled while there is nothing to send
 * or no chat capability, and a running session can be aborted here.
 *
 * One composer per session: the form is keyed by the session id, so the draft,
 * the pending send and its error never carry over to the next session, and a
 * send that answers after the reader moved on cannot clear the new draft.
 */
export function Composer(props: ComposerProps) {
	return <ComposerForm key={props.session.id} {...props} />;
}

function ComposerForm({ session, stoppable, waitingKind }: ComposerProps) {
	const { t } = useLingui();
	const [text, setText] = useState("");
	// The server dedupes sends by request id, so a retry after a lost response
	// keeps the id of the unanswered attempt; only a success or a new text resets it.
	const [requestId, setRequestId] = useState<string>();
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const [maxHeight, setMaxHeight] = useState<number>();
	const send = useSendMessage(session.id);
	const abort = useAbortSession(session.id);

	// The textarea grows with its content, but never past half of the transcript's height.
	useEffect(() => {
		let observed: HTMLElement | null = null;
		const resize = new ResizeObserver(() => measure());
		const measure = () => {
			const transcript = document.querySelector<HTMLElement>('[data-slot="transcript"]');
			const page = document.querySelector<HTMLElement>('[data-testid="session-page"]');
			if (transcript !== null && transcript !== observed) {
				if (observed !== null) resize.unobserve(observed);
				observed = transcript;
				resize.observe(transcript);
			}
			const available = transcript?.clientHeight ?? page?.clientHeight ?? window.innerHeight;
			const next = Math.max(36, Math.floor(available / 2));
			setMaxHeight((current) => (current === next ? current : next));
		};
		measure();
		const mutation = new MutationObserver(measure);
		mutation.observe(document.body, { childList: true, subtree: true });
		window.addEventListener("resize", measure);
		return () => {
			resize.disconnect();
			mutation.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the textarea's scrollHeight changes with the draft
	useLayoutEffect(() => {
		const element = textareaRef.current;
		if (element === null) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, maxHeight ?? Number.POSITIVE_INFINITY)}px`;
	}, [maxHeight, text]);

	const submit = () => {
		const value = text.trim();
		if (value === "" || send.isPending) return;
		const id = requestId ?? crypto.randomUUID();
		setRequestId(id);
		send.mutate(
			{ text: value, requestId: id },
			{
				onSuccess: () => {
					setText("");
					setRequestId(undefined);
				},
			},
		);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		submit();
	};

	const stop = () => {
		abort.mutate(undefined, {
			onSuccess: () => toast.success(t`Stopped the run.`),
		});
	};

	if (!session.capabilities.chat) {
		return (
			<p className="shrink-0 border-t px-3 py-2 text-sm text-muted-foreground" data-slot="composer-readonly">
				<Trans>You have view access: the owner can let you send messages by sharing it for chat.</Trans>
			</p>
		);
	}

	const reason =
		waitingKind === "approval"
			? t`The session is waiting for an approval.`
			: waitingKind === "authorization"
				? t`The session is waiting for a signature.`
				: waitingKind === "quota"
					? t`The session is paused: its token quota is used up.`
					: undefined;

	return (
		<div className="shrink-0 bg-background/80 px-3 pt-1 pb-2" data-slot="composer">
			{reason !== undefined && (
				<p className="border-b bg-warn-bg/60 px-3 py-1.5 text-xs text-warn" role="status" data-testid="waiting-reason">
					{reason}
				</p>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<div className="rounded-xl border border-input bg-background shadow-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30">
					<label className="sr-only" htmlFor="composer-input">
						<Trans>Message</Trans>
					</label>
					<Textarea
						ref={textareaRef}
						id="composer-input"
						data-testid="composer-input"
						rows={1}
						value={text}
						style={{ maxHeight, fieldSizing: "fixed" }}
						placeholder={t`Ask the agent to do something. Enter sends, Shift+Enter adds a line.`}
						disabled={send.isPending}
						onKeyDown={onKeyDown}
						onChange={(event) => {
							setText(event.target.value);
							// A new draft is a new message: a retry must not be deduped against the old one.
							setRequestId(undefined);
						}}
						className="min-h-9 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 pr-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
					/>
					{send.error !== null && send.error !== undefined && (
						<div className="px-3 pb-1">
							<ErrorText error={send.error} />
						</div>
					)}
					<div className="px-2 pb-1.5">
						<ComposerFooter
							session={session}
							stoppable={stoppable}
							sending={send.isPending}
							sendDisabled={text.trim() === ""}
							stopPending={abort.isPending}
							onStop={stop}
						/>
					</div>
				</div>
				<ComposerMeta session={session} />
			</form>
		</div>
	);
}
