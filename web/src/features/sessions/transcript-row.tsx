import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { InternalLink } from "@/components/internal-link";
import { taskOutcomeText } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { jobResourceLink } from "@/features/jobs/job";
import { actionText } from "@/lib/action-text";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SafeMarkdown, StreamingMarkdown } from "@/markdown/SafeMarkdown";
import { useStreamingText } from "@/markdown/stream-store";
import { AttachmentChip } from "./attachment-chip";
import { MessageActions, MessageTime, replyFinishedAt } from "./message-actions";
import { ToolCard } from "./tool-card";
import type { NoticeItem, TranscriptItem } from "./transcript-items";
import { TranscriptLine } from "./transcript-line";
import type { TranscriptStreams } from "./transcript-streams";

/** The completed turn's fold line, above its final answer (doc/design/webui.md "Message view"). */
export function TurnSummaryRow({
	durationMs,
	open,
	onToggle,
}: {
	durationMs: number | undefined;
	open: boolean;
	onToggle: () => void;
}) {
	const { t, i18n } = useLingui();
	const duration = durationMs === undefined ? undefined : formatDuration(Math.max(1000, durationMs), i18n.locale);
	return (
		<article className="px-3 pb-1" data-testid="turn-summary">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="flex w-full max-w-[92%] items-center gap-2 border-b border-border/70 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				<span className="min-w-0 truncate">{duration === undefined ? t`Ended` : t`Ended in ${duration}`}</span>
				{open ? (
					<ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
				)}
			</button>
		</article>
	);
}

/** The collapsed preview of a note row: the latest line while streaming, the first line once settled. */
function notePreview(text: string, running: boolean): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return (running ? lines.at(-1) : lines[0])?.replaceAll("**", "") ?? "";
}

/**
 * The borderless, collapsible note row shared by thinking and compaction (doc/design/webui.md "Message rendering"):
 * a leading chevron, the label, and a one-line preview while collapsed.
 */
function CollapsibleNoteRow({
	testId,
	label,
	preview,
	children,
}: {
	testId: string;
	label: React.ReactNode;
	preview: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="max-w-[92%] text-sm text-muted-foreground">
			<button
				type="button"
				data-testid={`${testId}-toggle`}
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				{open ? (
					<ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
				)}
				<span className="shrink-0">{label}</span>
				{!open && preview !== "" && (
					<>
						<span className="shrink-0 text-muted-foreground/60" aria-hidden="true">
							·
						</span>
						<span className="min-w-0 flex-1 truncate font-normal" data-testid={`${testId}-preview`}>
							{preview}
						</span>
					</>
				)}
			</button>
			{open && <div className="pr-2.5 pb-2 pl-8">{children}</div>}
		</div>
	);
}

/** A thinking row, with the same chevron as a tool call (doc/design/webui.md "Message rendering"). */
function ThinkingRow({
	item,
	streams,
}: {
	item: Extract<TranscriptItem, { kind: "thinking" }>;
	streams: TranscriptStreams;
}) {
	const live = useStreamingText(streams.text(item.key));
	const text = item.live ? live.text : item.text;
	return (
		<CollapsibleNoteRow testId="thinking" label={<Trans>Thinking</Trans>} preview={notePreview(text, item.streaming)}>
			{item.live ? (
				<StreamingMarkdown
					store={streams.text(item.key)}
					text={item.streaming ? undefined : item.text}
					className="text-muted-foreground"
				/>
			) : (
				<SafeMarkdown text={item.text} className="text-muted-foreground" />
			)}
		</CollapsibleNoteRow>
	);
}

/** A finished compaction: the same note row, with the summary as its body. */
function CompactionRow({ text }: { text: string }) {
	return (
		<CollapsibleNoteRow testId="compaction" label={<Trans>Context compacted</Trans>} preview={notePreview(text, false)}>
			<SafeMarkdown text={text} className="text-muted-foreground" />
		</CollapsibleNoteRow>
	);
}

/**
 * A `crh.notice` entry as one centered, muted line outside any bubble (doc/design/jobs.md "Display"): a
 * finished job per line, with its action, outcome, wake note and a link to its page, or the request wake that
 * started the run. It carries no message actions, because it is not a message the user sent.
 */
function NoticeRow({ notice }: { notice: NoticeItem }) {
	const { t, i18n } = useLingui();
	if (notice.type === "jobs" && notice.jobs.length > 0) {
		return (
			<div className="flex flex-col items-center gap-0.5 px-3 pb-2.5" data-testid="notice-lines">
				{notice.jobs.map((job) => {
					const action = actionText(i18n, job.action) || job.kind;
					const link = job.resource === undefined ? undefined : jobResourceLink(job.resource);
					return (
						<p
							key={job.jobId}
							data-testid="notice-line"
							data-job-id={job.jobId}
							className="max-w-[92%] text-center text-xs text-muted-foreground"
						>
							<Trans>Background job finished:</Trans>{" "}
							{link === undefined ? (
								<span>{action}</span>
							) : (
								<InternalLink to={link.to} params={link.params} className="text-xs">
									{action}
								</InternalLink>
							)}
							{" · "}
							{taskOutcomeText(i18n, job.outcome)}
							{job.woke && (
								<>
									{" · "}
									<Trans>the agent was woken</Trans>
								</>
							)}
						</p>
					);
				})}
			</div>
		);
	}
	return (
		<div className="flex justify-center px-3 pb-2.5">
			<p data-testid="notice-line" className="max-w-[92%] text-center text-xs text-muted-foreground">
				{notice.type === "quota_request"
					? t`A subagent's quota ran out`
					: notice.type === "agent_request"
						? t`A subagent request woke the agent`
						: t`The agent was woken`}
			</p>
		</div>
	);
}

/**
 * The retry line after a running turn whose last rows are errors (doc/design/webui.md "Message rendering"):
 * warn-coloured, outside the fold, so the retry stays visible while the session keeps running.
 */
export function RetryingRow({ attempt }: { attempt: number }) {
	return (
		<article className="px-3 pb-2.5" data-testid="retrying">
			<p
				role="status"
				className="flex max-w-[92%] items-center gap-2 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn"
			>
				<LoaderCircleIcon className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				<span>
					<Trans>Retrying (attempt {attempt})…</Trans>
				</span>
			</p>
		</article>
	);
}

/** A running compaction: the note row's style with the running spinner, at the transcript's end. */
function CompactingRow() {
	return (
		<div className="max-w-[92%] text-sm text-muted-foreground" data-testid="compacting-row">
			<div className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium">
				<LoaderCircleIcon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				<span className="shrink-0">
					<Trans>Compacting context</Trans>
				</span>
			</div>
		</div>
	);
}

/**
 * The line at the end of the transcript while this session's own turn runs (doc/design/webui.md "Message view"):
 * a tool-call row with the spinner in the status icon's place, so the live turn ends in the same rhythm as the
 * calls above it. It is rendered after the last row and scrolls with the transcript.
 */
export function RunningRow() {
	return (
		<article className="px-3 pb-1" data-testid="transcript-running">
			<div className="max-w-[92%]">
				<TranscriptLine>
					<LoaderCircleIcon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate font-mono text-xs">
						<Trans>Running…</Trans>
					</span>
				</TranscriptLine>
			</div>
		</article>
	);
}

/** The entry a final reply can fork at, when its entry id is a safe integer. */
function forkEntryIdOf(item: Extract<TranscriptItem, { kind: "text" }>): number | undefined {
	if (item.entryId === undefined) return undefined;
	const id = Number(item.entryId);
	return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * The copy and fork row of a turn's final answer (doc/design/webui.md "Message rendering"): the
 * transcript renders it as its own row after the delivered files, so the files sit between the answer
 * and its actions. The row ends with the time the answer finished.
 */
export function ReplyActionsRow({
	item,
	canFork = false,
	forkPending = false,
	onFork,
}: {
	item: Extract<TranscriptItem, { kind: "text" }>;
	/** Whether the caller may fork this reply: the owner, and only when the turn has ended. */
	canFork?: boolean;
	/** A fork request is in flight; the action is disabled until it settles. */
	forkPending?: boolean;
	onFork?: (entryId: number) => void;
}) {
	const { t } = useLingui();
	const forkEntryId = forkEntryIdOf(item);
	const showsFork = canFork && forkEntryId !== undefined && onFork !== undefined;
	return (
		<div className="px-3 pb-2.5" data-testid="reply-actions-row">
			<MessageActions>
				<CopyButton text={item.text} label={t`Copy reply`} size="icon-xs" />
				{showsFork && (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={t`Fork from here`}
						title={t`Fork from here`}
						data-testid="fork-message"
						disabled={forkPending}
						onClick={() => {
							if (forkEntryId !== undefined) onFork?.(forkEntryId);
						}}
					>
						{forkPending ? <LoaderCircleIcon className="animate-spin" /> : <GitBranchIcon />}
					</Button>
				)}
				<MessageTime at={replyFinishedAt(item)} />
			</MessageActions>
		</div>
	);
}

/**
 * One transcript row (doc/design/webui.md "Message rendering"): a plain user message, assistant
 * text and thinking through SafeMarkdown, tool rows whose details open in a
 * dialog, errors, a finished compaction and the live compacting row. A message
 * that arrived through the live stream keeps its row and store after
 * `message_end` (only the committed text replaces the live text), so the
 * incremental Markdown tree is not discarded; messages loaded from a snapshot
 * render their text in one shot.
 */
export function TranscriptRow({
	item,
	streams,
	sessionActive,
	highlighted = false,
	finalReply,
	showReplyActions = true,
	canFork = false,
	forkPending = false,
	onFork,
}: {
	item: TranscriptItem;
	streams: TranscriptStreams;
	/** Whether the session is running or awaiting: an unreturned call stops waiting once it is idle. */
	sessionActive: boolean;
	/** Briefly marked after a search hit jumped to this entry (doc/design/webui.md "Jumping to a message"). */
	highlighted?: boolean;
	/**
	 * Whether this text is its turn's final answer; the turn decides, so an earlier message that
	 * ended without tool calls is not mistaken for one. Defaults to the item's own `final` flag for
	 * rows rendered outside a turn.
	 */
	finalReply?: boolean;
	/** Whether the copy/fork row renders under the reply; the transcript renders it as its own row. */
	showReplyActions?: boolean;
	/** Whether the caller may fork this reply: the owner, and only when the turn has ended. */
	canFork?: boolean;
	/** A fork request is in flight; the action is disabled until it settles. */
	forkPending?: boolean;
	onFork?: (entryId: number) => void;
}) {
	const { t } = useLingui();
	const showsReplyActions = item.kind === "text" && (finalReply ?? item.final) && showReplyActions;
	const forkEntryId = item.kind === "text" ? forkEntryIdOf(item) : undefined;
	const showsFork = showsReplyActions && canFork && forkEntryId !== undefined && onFork !== undefined;
	return (
		<article
			data-testid="message"
			data-message-id={item.key}
			data-entry-id={item.entryId}
			data-highlighted={highlighted ? "true" : undefined}
			data-kind={item.kind}
			className={cn(
				"group/message px-3 pb-2.5 transition-colors duration-700",
				(item.kind === "tool" ||
					item.kind === "thinking" ||
					item.kind === "compaction" ||
					item.kind === "compacting") &&
					"pb-1",
				highlighted && "rounded-md bg-yellow-200/40 ring-2 ring-yellow-400/70 dark:bg-yellow-500/20",
			)}
		>
			{item.kind === "user" && (
				<div className="flex flex-col items-end gap-1">
					{item.attachments?.map((attachment) => (
						<AttachmentChip key={`${attachment.library}:${attachment.path}`} attachment={attachment} />
					))}
					{(item.text !== "" || item.attachments === undefined) && (
						<div
							className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground selection:bg-primary-foreground selection:text-primary"
							data-testid="user-message"
						>
							{item.text}
						</div>
					)}
					<MessageActions>
						<MessageTime at={item.at} />
						<CopyButton text={item.text} label={t`Copy message`} size="icon-xs" />
					</MessageActions>
				</div>
			)}
			{item.kind === "text" && (
				<div className="flex max-w-[92%] flex-col items-start gap-0.5">
					<div className="w-full text-sm" data-testid={item.streaming ? "streaming-text" : undefined}>
						{item.live ? (
							// A streamed message keeps the same renderer after it is committed:
							// the final text replaces the store's live text in place.
							<StreamingMarkdown store={streams.text(item.key)} text={item.streaming ? undefined : item.text} />
						) : (
							<SafeMarkdown text={item.text} />
						)}
					</div>
					{showsReplyActions && (
						<MessageActions>
							<CopyButton text={item.text} label={t`Copy reply`} size="icon-xs" />
							{showsFork && (
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={t`Fork from here`}
									title={t`Fork from here`}
									data-testid="fork-message"
									disabled={forkPending}
									onClick={() => {
										if (forkEntryId !== undefined) onFork?.(forkEntryId);
									}}
								>
									{forkPending ? <LoaderCircleIcon className="animate-spin" /> : <GitBranchIcon />}
								</Button>
							)}
							<MessageTime at={replyFinishedAt(item)} />
						</MessageActions>
					)}
				</div>
			)}
			{item.kind === "notice" && <NoticeRow notice={item.notice} />}
			{item.kind === "thinking" && <ThinkingRow item={item} streams={streams} />}
			{item.kind === "tool" && (
				<div className="max-w-[92%]">
					<ToolCard item={item} sessionActive={sessionActive} />
				</div>
			)}
			{item.kind === "compaction" && <CompactionRow text={item.text} />}
			{item.kind === "compacting" && <CompactingRow />}
			{item.kind === "error" && (
				<p role="alert" className="text-sm text-danger">
					{item.reason === "aborted" ? <Trans>The run was stopped</Trans> : <Trans>The run failed</Trans>}
					{item.message !== null && <span className="ml-1 text-muted-foreground">{item.message}</span>}
				</p>
			)}
			{item.kind === "text" && item.text === "" && item.streaming && <span className="sr-only">{t`Generating…`}</span>}
		</article>
	);
}
