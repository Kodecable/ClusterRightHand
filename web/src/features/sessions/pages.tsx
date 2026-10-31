import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRightIcon, PencilIcon, SettingsIcon, Share2Icon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ModelSelect } from "@/components/model-select";
import { PresetSelect } from "@/components/preset-select";
import { QuotaSummaryLine } from "@/components/quota-card";
import { PageSkeleton } from "@/components/skeletons";
import { SessionStatusBadge } from "@/components/status-badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useModels } from "@/features/settings/api";
import type { SessionView } from "@/lib/api/types";
import { parseQuotaInput, type QuotaError } from "@/lib/quota";
import { useAbortSession, usePatchSession, useSession, useSessionHistoryPage } from "./api";
import { Composer } from "./composer";
import { SessionWaits } from "./session-waits";
import { transcript, usageTotals } from "./sessionState";
import { ShareDialog } from "./share-dialog";
import { Transcript } from "./transcript";
import { useSessionEvents } from "./use-session-events";

export function SessionsPage() {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<EmptyState
				className="max-w-md border-0"
				title={<Trans>No session selected</Trans>}
				description={<Trans>Pick a session on the left, or start a new one.</Trans>}
			/>
		</div>
	);
}

function ParentChain({ id }: { id: string }) {
	const parent = useSession(id);
	const { t } = useLingui();
	if (!parent.data) return null;
	const parentTitle = parent.data.title.trim() === "" ? t`Untitled session` : parent.data.title;
	return (
		<>
			<BreadcrumbItem>
				<BreadcrumbLink render={<Link to="/sessions/$sessionId" params={{ sessionId: parent.data.id }} />}>
					{parentTitle}
				</BreadcrumbLink>
			</BreadcrumbItem>
			{parent.data.parentSessionId !== null && <ParentChain id={parent.data.parentSessionId} />}
			<BreadcrumbSeparator />
		</>
	);
}

function SessionBreadcrumb({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const title = session.title.trim() === "" ? t`Untitled session` : session.title;
	return (
		<Breadcrumb data-testid="session-breadcrumb">
			<BreadcrumbList>
				<BreadcrumbItem>
					<BreadcrumbLink render={<Link to="/sessions" />}>
						<Trans>Sessions</Trans>
					</BreadcrumbLink>
				</BreadcrumbItem>
				<BreadcrumbSeparator />
				{session.parentSessionId !== null && <ParentChain id={session.parentSessionId} />}
				<BreadcrumbItem>
					<BreadcrumbPage className="max-w-64 truncate">{title}</BreadcrumbPage>
				</BreadcrumbItem>
			</BreadcrumbList>
		</Breadcrumb>
	);
}

function TitleEditor({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const patch = usePatchSession(session.id);
	const [value, setValue] = useState(session.title);
	useEffect(() => setValue(session.title), [session.title]);

	if (!session.capabilities.configure) {
		return <h1 className="truncate text-lg font-semibold">{session.title || t`Untitled session`}</h1>;
	}

	const save = () => {
		if (patch.isPending) return;
		const title = value.trim();
		if (title === "" || title === session.title) {
			setValue(session.title);
			return;
		}
		patch.mutate(
			{ title },
			{
				onSuccess: () => toast.success(t`Title saved.`),
				onError: (error) => toast.error(error.message),
			},
		);
	};

	return (
		<form
			className="min-w-0"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<label className="sr-only" htmlFor="session-title">
				<Trans>Session title</Trans>
			</label>
			<Input
				id="session-title"
				data-testid="session-title"
				value={value}
				maxLength={200}
				disabled={patch.isPending}
				className="h-8 border-transparent bg-transparent px-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input"
				onChange={(event) => setValue(event.target.value)}
				onBlur={save}
				onKeyDown={(event) => {
					if (event.key === "Escape") setValue(session.title);
				}}
			/>
		</form>
	);
}

function QuotaDialog({
	session,
	open,
	onOpenChange,
}: {
	session: SessionView;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLingui();
	const patch = usePatchSession(session.id);
	const [text, setText] = useState(session.quota === null ? "" : String(session.quota));
	const [error, setError] = useState<QuotaError>();

	useEffect(() => {
		if (open) setText(session.quota === null ? "" : String(session.quota));
	}, [open, session.quota]);

	const errorText = (code: QuotaError): string => {
		switch (code) {
			case "whole-number":
				return t`Enter a whole number of tokens, or leave it empty for unlimited.`;
			case "too-large":
				return t`That number is too large.`;
			case "positive-required":
				return t`Enter a positive number of tokens to add.`;
		}
	};

	const save = () => {
		const parsed = parseQuotaInput(text);
		if ("error" in parsed) {
			setError(parsed.error);
			return;
		}
		setError(undefined);
		patch.mutate(
			{ quota: parsed.quota },
			{
				onSuccess: () => {
					toast.success(t`Quota saved.`);
					onOpenChange(false);
				},
				onError: (mutationError) => toast.error(mutationError.message),
			},
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>
						<Trans>Token quota</Trans>
					</DialogTitle>
				</DialogHeader>
				<form
					className="grid gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<Label htmlFor="session-quota">
						<Trans>Remaining tokens (empty = unlimited)</Trans>
					</Label>
					<Input
						id="session-quota"
						inputMode="numeric"
						value={text}
						placeholder={t`Unlimited`}
						onChange={(event) => setText(event.target.value)}
					/>
					{error !== undefined && (
						<p role="alert" className="text-xs text-danger">
							{errorText(error)}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={patch.isPending}>
							<Trans>Save</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function SessionSettings({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const models = useModels();
	const patch = usePatchSession(session.id);
	const preset = session.rules?.preset ?? "ask";
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t`Session settings`}
						title={t`Session settings`}
					/>
				}
			>
				<SettingsIcon />
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<div className="grid gap-1.5">
					<Label htmlFor="session-model">
						<Trans>Model</Trans>
					</Label>
					<ModelSelect
						id="session-model"
						models={models.data ?? []}
						value={session.model}
						disabled={patch.isPending}
						onChange={(model) => patch.mutate({ model }, { onError: (error) => toast.error(error.message) })}
					/>
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor="session-preset">
						<Trans>Preset</Trans>
					</Label>
					<PresetSelect
						id="session-preset"
						value={preset}
						disabled={patch.isPending}
						onChange={(next) => patch.mutate({ preset: next }, { onError: (error) => toast.error(error.message) })}
					/>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function SessionHeader({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const abort = useAbortSession(session.id);
	const [shareOpen, setShareOpen] = useState(false);
	const [quotaOpen, setQuotaOpen] = useState(false);
	const preset = session.rules?.preset ?? "ask";
	const ruleCount = session.rules?.rules.length ?? 0;
	const ownerName = session.ownerUsername ?? t`another user`;

	const stop = () => {
		abort.mutate(undefined, {
			onSuccess: () => toast.success(t`Stopped the run.`),
			onError: (error) => toast.error(error.message),
		});
	};

	return (
		<header className="grid shrink-0 gap-2 border-b bg-background/80 px-3 py-2" data-testid="session-header">
			<div className="flex min-w-0 items-center gap-2">
				<div className="min-w-0 flex-1">
					<SessionBreadcrumb session={session} />
					<TitleEditor session={session} />
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{session.capabilities.configure && <SessionSettings session={session} />}
					{session.capabilities.manageShares && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t`Share`}
							title={t`Share`}
							data-testid="share-session"
							onClick={() => setShareOpen(true)}
						>
							<Share2Icon />
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t`Back to the session list`}
						title={t`Back to the session list`}
						className="md:hidden"
						onClick={() => void navigate({ to: "/sessions" })}
					>
						<ChevronRightIcon className="rotate-180" />
					</Button>
					{session.capabilities.chat && (
						<Button
							type="button"
							variant="destructive"
							size="sm"
							data-testid="abort-session"
							disabled={abort.isPending || session.state !== "running"}
							onClick={stop}
						>
							<SquareIcon />
							<Trans>Stop</Trans>
						</Button>
					)}
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<SessionStatusBadge state={session.state} />
				<span className="font-mono">
					{session.model.provider}/{session.model.modelId}
				</span>
				<span>
					<Trans>Preset</Trans>: {preset}
					{ruleCount > 0 && (
						<>
							{" · "}
							<Plural value={ruleCount} one="# rule" other="# rules" />
						</>
					)}
				</span>
				{session.relationship !== "owner" && (
					<span>
						<Trans>Shared by {ownerName}</Trans>
					</span>
				)}
				{session.capabilities.configure ? (
					<Button type="button" variant="ghost" size="xs" data-testid="edit-quota" onClick={() => setQuotaOpen(true)}>
						<QuotaSummaryLine quota={session.quota} used={session.spentTokens} />
						<PencilIcon className="size-3" />
					</Button>
				) : (
					<span data-testid="quota-summary">
						<QuotaSummaryLine quota={session.quota} used={session.spentTokens} />
					</span>
				)}
			</div>

			<ShareDialog sessionId={session.id} open={shareOpen} onOpenChange={setShareOpen} />
			<QuotaDialog session={session} open={quotaOpen} onOpenChange={setQuotaOpen} />
			{(session.state === "awaiting" || session.waitingKind !== null) && <SessionWaits session={session} />}
		</header>
	);
}

export function SessionPage() {
	const params = useParams({ strict: false }) as { sessionId?: string };
	const sessionId = params.sessionId ?? "";
	const session = useSession(sessionId);
	const events = useSessionEvents(sessionId);
	const [wantsOlder, setWantsOlder] = useState(false);
	const history = useSessionHistoryPage(sessionId, events.state.historyCursor, wantsOlder);
	const items = useMemo(() => transcript(events.state), [events.state]);
	const totals = usageTotals(events.state.usage);
	const tokenText = totals === undefined ? undefined : totals.tokens.toLocaleString();

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

	const subagentIds = [
		...new Set(
			items.flatMap((item) =>
				item.kind === "tool" &&
				item.details !== null &&
				typeof item.details === "object" &&
				!Array.isArray(item.details) &&
				typeof item.details.sessionId === "string" &&
				item.details.sessionId !== ""
					? [item.details.sessionId]
					: [],
			),
		),
	];

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="session-page" data-session-id={view.id}>
			<SessionHeader session={view} />

			{events.connection !== "live" && (
				<p className="shrink-0 bg-muted px-3 py-1 text-xs text-muted-foreground" role="status">
					{events.connection === "connecting" ? <Trans>Connecting…</Trans> : <Trans>Reconnecting…</Trans>}
				</p>
			)}
			{(events.state.running ||
				events.state.queued > 0 ||
				events.state.retry !== undefined ||
				tokenText !== undefined) && (
				<p
					className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-1 text-xs text-muted-foreground"
					role="status"
				>
					{events.state.running && <Trans>Working…</Trans>}
					{events.state.retry !== undefined && <Trans>Retrying after an error: {events.state.retry}</Trans>}
					{events.state.queued > 0 && (
						<Plural value={events.state.queued} one="# message queued" other="# messages queued" />
					)}
					{tokenText !== undefined && <Trans>{tokenText} tokens</Trans>}
				</p>
			)}
			{events.state.failure !== undefined && (
				<p role="alert" className="shrink-0 bg-danger-bg px-3 py-1 text-xs text-danger">
					{events.state.failure}
				</p>
			)}

			{subagentIds.length > 0 && (
				<div
					className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1 text-xs"
					data-testid="subagent-links"
				>
					<span className="text-muted-foreground">
						<Plural value={subagentIds.length} one="Subagent session" other="Subagent sessions" />:
					</span>
					{subagentIds.map((id) => (
						<Link
							key={id}
							to="/sessions/$sessionId"
							params={{ sessionId: id }}
							className="font-mono text-primary underline underline-offset-2"
						>
							{id.slice(0, 8)}…
						</Link>
					))}
				</div>
			)}

			{events.state.ready ? (
				<Transcript
					key={view.id}
					items={items}
					streams={events.streams}
					ready={events.state.ready}
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

			<Composer
				sessionId={view.id}
				canChat={view.capabilities.chat}
				running={events.state.running}
				waitingKind={view.waitingKind}
			/>
		</div>
	);
}
