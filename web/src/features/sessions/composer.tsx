import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorText } from "@/components/error-state";
import { Textarea } from "@/components/ui/textarea";
import type { SessionView } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { useAbortSession, useCompactSession, useSendMessage } from "./api";
import { SessionComposerFooter } from "./composer-footer";
import { ComposerShell, handleComposerKey, UnknownCommandHint, useTextareaAutosize } from "./composer-input";
import { ComposerMeta } from "./composer-meta";
import { isUnknownSlashCommand, parseSlashCommand, type SlashCommand, slashSuggestions } from "./slash-commands";

const COMMAND_NOT_SENT_HINT = msg`/{name}: {description} (not sent as a message)`;

export interface ComposerProps {
	session: SessionView;
	/** There is something this session (or its tree) runs that Stop can end. */
	stoppable: boolean;
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

function ComposerForm({ session, stoppable }: ComposerProps) {
	const { t, i18n } = useLingui();
	const [text, setText] = useState("");
	// The server dedupes sends by request id, so a retry after a lost response
	// keeps the id of the unanswered attempt; only a success or a new text resets it.
	const [requestId, setRequestId] = useState<string>();
	// The highlighted completion and whether Escape dismissed the popup for the
	// current draft; either resets as soon as the text changes.
	const [highlighted, setHighlighted] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const listboxId = useId();
	const optionId = (index: number) => `${listboxId}-option-${index}`;
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const [maxHeight, setMaxHeight] = useState<number>();
	const send = useSendMessage(session.id);
	const compact = useCompactSession(session.id);
	const abort = useAbortSession(session.id);
	const pending = send.isPending || compact.isPending;

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

	useTextareaAutosize(textareaRef, text, maxHeight ?? Number.POSITIVE_INFINITY);

	const suggestions = slashSuggestions(text);
	const highlightedIndex = suggestions.length === 0 ? -1 : Math.min(highlighted, suggestions.length - 1);
	const highlightedCommand = highlightedIndex < 0 ? undefined : suggestions[highlightedIndex];
	const completionOpen = suggestions.length > 0 && !dismissed;
	const parsedCommand = parseSlashCommand(text);
	// A lone `/token` with no match is still a normal message; say so while the
	// user can still fix it, unless a completion is available instead.
	const unknownCommand = suggestions.length === 0 && isUnknownSlashCommand(text);

	/** Put `/name ` in the draft and leave the caret after the space. */
	const complete = (command: SlashCommand) => {
		const next = `/${command.name} `;
		setText(next);
		// Completing is editing the draft: the next send is a new message.
		setRequestId(undefined);
		setDismissed(false);
		setHighlighted(0);
		requestAnimationFrame(() => {
			const element = textareaRef.current;
			if (element === null) return;
			element.focus();
			element.setSelectionRange(next.length, next.length);
		});
	};

	const submit = () => {
		const value = text.trim();
		if (value === "" || pending) return;
		// A command asks the server to act instead of sending a message; only an
		// exact registered name counts, so `/compactor` stays a normal message.
		const command = parseSlashCommand(text);
		if (command !== undefined) {
			// The failed send's error must not mask this command's own.
			send.reset();
			const instructions = command.args;
			compact.mutate(
				{ instructions: instructions === "" ? undefined : instructions },
				{
					onSuccess: ({ outcome }) => {
						setText("");
						if (outcome === "nothing") {
							toast.info(
								t`Nothing to compact yet: the most recent ~20k tokens of the conversation are always kept as they are.`,
							);
						} else if (outcome === "failed") {
							toast.error(t`Compaction failed.`);
						}
					},
				},
			);
			return;
		}
		compact.reset();
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

	/** The completion popup's keys, ahead of Enter-to-send; true when the key was handled. */
	const completionKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!completionOpen) return false;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setHighlighted((index) => (index + 1) % suggestions.length);
			return true;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length);
			return true;
		}
		if (event.key === "Tab" && highlightedCommand !== undefined) {
			event.preventDefault();
			complete(highlightedCommand);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			// Stay closed until the draft changes (onChange clears the flag).
			setDismissed(true);
			return true;
		}
		if (event.key === "Enter" && !event.shiftKey && highlightedCommand !== undefined) {
			event.preventDefault();
			if (text === `/${highlightedCommand.name}`) {
				// Already the whole command: Enter runs it, as with a normal message.
				submit();
			} else {
				complete(highlightedCommand);
			}
			return true;
		}
		return false;
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

	const error = send.error ?? compact.error;

	return (
		<ComposerShell inputId="composer-input" onSubmit={submit} after={<ComposerMeta session={session} />}>
			<Textarea
				ref={textareaRef}
				id="composer-input"
				data-testid="composer-input"
				rows={1}
				value={text}
				style={{ maxHeight, fieldSizing: "fixed" }}
				placeholder={t`Ask the agent to do something. Enter sends, Shift+Enter adds a line, /compact summarizes older context.`}
				disabled={pending}
				role="combobox"
				aria-autocomplete="list"
				aria-controls={completionOpen ? listboxId : undefined}
				aria-expanded={completionOpen}
				aria-activedescendant={
					completionOpen && highlightedCommand !== undefined ? optionId(highlightedIndex) : undefined
				}
				onKeyDown={(event) => handleComposerKey(event, submit, completionKey)}
				onChange={(event) => {
					setText(event.target.value);
					setHighlighted(0);
					setDismissed(false);
					// A new draft is a new message: a retry must not be deduped against the old one.
					setRequestId(undefined);
				}}
				className="min-h-9 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3 py-2 pr-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
			/>
			{completionOpen && (
				<div
					id={listboxId}
					role="listbox"
					aria-label={t`Slash commands`}
					data-testid="slash-command-list"
					className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-md rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{suggestions.map((command, index) => (
						<div
							key={command.name}
							id={optionId(index)}
							role="option"
							aria-selected={index === highlightedIndex}
							tabIndex={-1}
							data-testid={`slash-option-${command.name}`}
							className={cn(
								"cursor-pointer rounded-md px-2 py-1.5 text-sm",
								index === highlightedIndex && "bg-accent text-accent-foreground",
							)}
							onMouseEnter={() => setHighlighted(index)}
							onMouseDown={(event) => {
								// Keep the textarea focused; the click only fills the draft.
								event.preventDefault();
								complete(command);
							}}
						>
							<div className="flex flex-wrap items-baseline gap-x-1.5">
								<span className="font-mono">/{command.name}</span>
								{command.args !== undefined && (
									<span className="text-xs text-muted-foreground">
										{typeof command.args === "string" ? command.args : i18n._(command.args)}
									</span>
								)}
							</div>
							<p className="text-xs text-muted-foreground">{i18n._(command.description)}</p>
						</div>
					))}
				</div>
			)}
			{parsedCommand !== undefined && (
				<p className="px-3 pb-1 text-xs text-muted-foreground" data-testid="slash-hint">
					{i18n._({
						...COMMAND_NOT_SENT_HINT,
						values: {
							name: parsedCommand.command.name,
							description: i18n._(parsedCommand.command.description),
						},
					})}
				</p>
			)}
			{unknownCommand && <UnknownCommandHint />}
			{error !== null && error !== undefined && (
				<div className="px-3 pb-1">
					<ErrorText error={error} />
				</div>
			)}
			<div className="px-2 pb-1.5">
				<SessionComposerFooter
					session={session}
					stoppable={stoppable}
					sending={pending}
					sendDisabled={text.trim() === ""}
					stopPending={abort.isPending}
					onStop={stop}
				/>
			</div>
		</ComposerShell>
	);
}
