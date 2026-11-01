import { Trans, useLingui } from "@lingui/react/macro";
import { SendIcon, SquareIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SessionWaitingKind } from "@/lib/api/types";
import { useAbortSession, useSendMessage } from "./api";

export interface ComposerProps {
	sessionId: string;
	canChat: boolean;
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
	return <ComposerForm key={props.sessionId} {...props} />;
}

function ComposerForm({ sessionId, canChat, stoppable, waitingKind }: ComposerProps) {
	const { t } = useLingui();
	const [text, setText] = useState("");
	// The server dedupes sends by request id, so a retry after a lost response
	// keeps the id of the unanswered attempt; only a success or a new text resets it.
	const [requestId, setRequestId] = useState<string>();
	const send = useSendMessage(sessionId);
	const abort = useAbortSession(sessionId);

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

	if (!canChat) {
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
		<div className="shrink-0 border-t bg-background/80" data-slot="composer">
			{reason !== undefined && (
				<p className="border-b bg-warn-bg/60 px-3 py-1.5 text-xs text-warn" role="status" data-testid="waiting-reason">
					{reason}
				</p>
			)}
			<form
				className="grid gap-2 px-3 py-2"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<label className="sr-only" htmlFor="composer-input">
					<Trans>Message</Trans>
				</label>
				<Textarea
					id="composer-input"
					data-testid="composer-input"
					rows={3}
					value={text}
					placeholder={t`Ask the agent to do something. Enter sends, Shift+Enter adds a line.`}
					disabled={send.isPending}
					onKeyDown={onKeyDown}
					onChange={(event) => {
						setText(event.target.value);
						// A new draft is a new message: a retry must not be deduped against the old one.
						setRequestId(undefined);
					}}
					className="max-h-48 min-h-16 resize-y"
				/>
				{send.error !== null && send.error !== undefined && <ErrorText error={send.error} />}
				<div className="flex items-center justify-end gap-2">
					{stoppable && (
						<Button type="button" variant="destructive" size="sm" disabled={abort.isPending} onClick={stop}>
							<SquareIcon />
							<Trans>Stop</Trans>
						</Button>
					)}
					<Button type="submit" size="sm" data-testid="composer-send" disabled={send.isPending || text.trim() === ""}>
						<SendIcon />
						<Trans>Send</Trans>
					</Button>
				</div>
			</form>
		</div>
	);
}
