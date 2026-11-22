import type { JobView } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, CircleStopIcon, ListTreeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyHint } from "@/components/empty-state";
import { ErrorText } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { jobItems, jobKeys, useCancelJob, useSessionJobs } from "@/features/jobs/api";
import { JobKindIcon, jobResourceLink, jobStateText } from "@/features/jobs/job";
import { useIsMobile } from "@/hooks/use-mobile";
import { actionText } from "@/lib/action-text";
import { formatDuration } from "@/lib/format";
import { cn, linkClass } from "@/lib/utils";

/**
 * The background bar above the composer (doc/design/jobs.md "WebUI"): the session's active jobs only (waiting or
 * running), hidden when there are none. Its line counts running and waiting jobs; expanding shows one row per
 * job with its kind, action, state and elapsed time. A subagent job's own active jobs nest under it, one level
 * at a time. A row whose job has a page (a task, task group or subagent session) links to it and stopping
 * happens there; an extension call, which has no page, gets a Stop button for the session's owner.
 */
export function BackgroundBar({
	sessionId,
	isOwner,
	revision,
}: {
	sessionId: string;
	/** Only the session's owner sees Stop, like the extensions button in the session header. */
	isOwner: boolean;
	/** `job.changed` events on the session stream; every bump refreshes the live levels. */
	revision: number;
}) {
	const { t } = useLingui();
	const [open, setOpen] = useState(false);
	const isMobile = useIsMobile();
	const query = useSessionJobs(sessionId);
	useRevisionRefresh(sessionId, revision);
	// The query asks for active jobs; a row that settled between the read and a rerender is not shown either.
	const items = jobItems(query.data).filter((job) => job.state !== "settled");
	const close = () => setOpen(false);
	// A hidden bar keeps no control and no row; the query above still follows the session so it appears at once.
	if (items.length === 0) return null;
	const running = items.filter((job) => job.state === "running").length;
	const waiting = items.filter((job) => job.state === "waiting").length;

	const trigger = (onClick?: () => void) => (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			className="w-full justify-start gap-1.5 rounded-xl px-3 py-1.5 text-xs font-normal text-muted-foreground hover:bg-accent/50"
			data-testid="background-bar"
			aria-label={t`Background jobs`}
			aria-expanded={open}
			onClick={onClick}
		>
			<ListTreeIcon className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="inline-flex min-w-0 items-center gap-1.5">
				<Plural value={items.length} one="# background job" other="# background jobs" />
				{running > 0 && <Trans>{running} running</Trans>}
				{waiting > 0 && <Trans>{waiting} waiting</Trans>}
			</span>
		</Button>
	);

	const tree = (
		<div className="min-h-0 overflow-y-auto" data-testid="background-tree">
			<ul className="grid gap-0.5">
				{items.map((job) => (
					<JobNode key={job.id} job={job} depth={0} isOwner={isOwner} revision={revision} onNavigate={close} />
				))}
			</ul>
			{query.hasNextPage && (
				<LoadMore pending={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="ml-5" />
			)}
		</div>
	);

	if (isMobile) {
		return (
			<>
				<div className="mx-3 mb-0 rounded-xl bg-popover/80 backdrop-blur">{trigger(() => setOpen(true))}</div>
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent side="bottom" className="max-h-[70vh]" data-testid="background-sheet">
						<SheetHeader>
							<SheetTitle>
								<Trans>Background jobs</Trans>
							</SheetTitle>
						</SheetHeader>
						<div className="min-h-0 overflow-y-auto px-3 pb-3">{tree}</div>
					</SheetContent>
				</Sheet>
			</>
		);
	}
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<div className="mx-3 mb-0 rounded-xl bg-popover/80 backdrop-blur" data-testid="background-bar-shell">
				<PopoverTrigger render={trigger()} />
			</div>
			<PopoverContent
				side="top"
				align="start"
				className="max-h-80 w-96 overflow-y-auto p-2"
				data-testid="background-popover"
			>
				<p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
					<Trans>Background jobs</Trans>
				</p>
				{tree}
			</PopoverContent>
		</Popover>
	);
}

/** Refreshes one level when a `job.changed` event arrives; the 5 s interval on the query is the fallback. */
function useRevisionRefresh(sessionId: string, revision: number): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (revision === 0) return;
		void queryClient.invalidateQueries({ queryKey: jobKeys.session(sessionId) });
	}, [revision, queryClient, sessionId]);
}

/** A now value that ticks once a second, so a row's elapsed time stays current while the bar is open. */
function useNow(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/**
 * One active job. A job with a page is a link to it (the stretched link covers the row); a subagent job also
 * expands to its own active jobs, fetched only when it is expanded. An extension call gets the owner's Stop.
 */
function JobNode({
	job,
	depth,
	isOwner,
	revision,
	onNavigate,
}: {
	job: JobView;
	depth: number;
	isOwner: boolean;
	revision: number;
	onNavigate: () => void;
}) {
	const { t, i18n } = useLingui();
	const [expanded, setExpanded] = useState(false);
	const now = useNow();
	const link = jobResourceLink(job.resource);
	const cancel = useCancelJob();
	const action = actionText(i18n, job.action) || job.kind;
	return (
		<li>
			<div className="relative flex min-w-0 items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
				{job.kind === "subagent" ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="relative z-10 shrink-0"
						aria-label={expanded ? t`Collapse the subagent's jobs` : t`Expand the subagent's jobs`}
						aria-expanded={expanded}
						data-testid="background-job-expand"
						onClick={() => setExpanded((value) => !value)}
					>
						{expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
					</Button>
				) : (
					<span className="w-6 shrink-0" aria-hidden="true" />
				)}
				<JobKindIcon job={job} />
				{link === undefined ? (
					<span className="min-w-0 flex-1 truncate text-sm" title={action} data-testid="background-job-action">
						{action}
					</span>
				) : (
					<Link
						to={link.to as never}
						params={link.params as never}
						aria-label={action}
						title={action}
						data-testid="background-job-link"
						data-job-id={job.id}
						data-job-state={job.state}
						className={cn(
							"min-w-0 flex-1 truncate text-sm after:absolute after:inset-0 after:rounded-sm",
							linkClass,
							"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
						)}
						onClick={onNavigate}
					>
						{action}
					</Link>
				)}
				<span
					data-testid="background-job-state"
					className="shrink-0 text-xs text-muted-foreground"
					title={`${jobStateText(i18n, job)} · ${formatDuration(now - Date.parse(job.createdAt), i18n.locale)}`}
				>
					{jobStateText(i18n, job)}
					<span className="ml-1.5 tabular-nums">{formatDuration(now - Date.parse(job.createdAt), i18n.locale)}</span>
				</span>
				{link === undefined && isOwner && (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="relative z-10 shrink-0 text-muted-foreground hover:text-danger"
						aria-label={t`Stop background job`}
						title={t`Stop`}
						data-testid="background-job-stop"
						disabled={cancel.isPending}
						onClick={() => cancel.mutate(job.id)}
					>
						<CircleStopIcon className="size-3.5" />
					</Button>
				)}
			</div>
			{job.kind === "subagent" && expanded && (
				<NestedJobs
					sessionId={job.resource.id}
					depth={depth + 1}
					isOwner={isOwner}
					revision={revision}
					onNavigate={onNavigate}
				/>
			)}
		</li>
	);
}

/** A subagent job's own active jobs, fetched only when its row is expanded; another level stays one page. */
function NestedJobs({
	sessionId,
	depth,
	isOwner,
	revision,
	onNavigate,
}: {
	sessionId: string;
	depth: number;
	isOwner: boolean;
	revision: number;
	onNavigate: () => void;
}) {
	const query = useSessionJobs(sessionId);
	useRevisionRefresh(sessionId, revision);
	const items = jobItems(query.data).filter((job) => job.state !== "settled");
	if (query.isPending) {
		return (
			<div className="py-1 pl-6">
				<Spinner className="size-4" />
			</div>
		);
	}
	if (query.isError) {
		return <ErrorText error={query.error} className="py-1 pl-6 text-xs" />;
	}
	if (items.length === 0) {
		return (
			<EmptyHint className="py-1 pl-6 text-xs">
				<Trans>No background jobs</Trans>
			</EmptyHint>
		);
	}
	return (
		<ul className="grid gap-0.5">
			{items.map((job) => (
				<JobNode key={job.id} job={job} depth={depth} isOwner={isOwner} revision={revision} onNavigate={onNavigate} />
			))}
			{query.hasNextPage && (
				<LoadMore pending={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} className="ml-6" />
			)}
		</ul>
	);
}

/** One level's next page; the cursor is opaque, so this is the only way to see more of a level. */
function LoadMore({ pending, onClick, className }: { pending: boolean; onClick: () => void; className?: string }) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="xs"
			className={cn("justify-start text-xs text-muted-foreground", className)}
			disabled={pending}
			data-testid="background-load-more"
			onClick={onClick}
		>
			{pending && <Spinner className="size-3.5" decorative />}
			<Trans>Load more</Trans>
		</Button>
	);
}
