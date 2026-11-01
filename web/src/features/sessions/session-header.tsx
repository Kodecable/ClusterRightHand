import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, PencilIcon, SettingsIcon, Share2Icon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ModelSelect } from "@/components/model-select";
import { PresetSelect } from "@/components/preset-select";
import { QuotaSummaryLine } from "@/components/quota-card";
import { SessionStatusBadge } from "@/components/status-badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useModels } from "@/features/settings/api";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SessionView } from "@/lib/api/types";
import { presetLabel } from "@/lib/preset";
import { useAbortSession, usePatchSession, useSession } from "./api";
import { QuotaDialog } from "./quota-dialog";
import { ShareDialog } from "./share-dialog";

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
			{parent.data.parentSessionId !== null && (
				<>
					<BreadcrumbSeparator />
					<ParentChain id={parent.data.parentSessionId} />
				</>
			)}
		</>
	);
}

/**
 * The chain back to a subagent's ancestors. A root session's title is the
 * page's title, so the breadcrumb would only repeat it.
 */
function SessionBreadcrumb({ session }: { session: SessionView }) {
	if (session.parentSessionId === null) return null;
	return (
		<Breadcrumb data-testid="session-breadcrumb">
			<BreadcrumbList>
				<BreadcrumbItem>
					<BreadcrumbLink render={<Link to="/sessions" />}>
						<Trans>Sessions</Trans>
					</BreadcrumbLink>
				</BreadcrumbItem>
				<BreadcrumbSeparator />
				<ParentChain id={session.parentSessionId} />
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
		return <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{session.title || t`Untitled session`}</h1>;
	}

	const save = () => {
		if (patch.isPending) return;
		const title = value.trim();
		if (title === "" || title === session.title) {
			setValue(session.title);
			return;
		}
		patch.mutate({ title }, { onSuccess: () => toast.success(t`Title saved.`) });
	};

	return (
		<form
			className="min-w-0 flex-1"
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
				className="h-8 border-transparent bg-transparent px-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
				onChange={(event) => setValue(event.target.value)}
				onBlur={save}
				onKeyDown={(event) => {
					if (event.key === "Escape") setValue(session.title);
				}}
			/>
		</form>
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
						onChange={(model) => patch.mutate({ model })}
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
						onChange={(next) => patch.mutate({ preset: next })}
					/>
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** The session page's header: title, breadcrumb, status, settings, share, stop and the meta line. */
export function SessionHeader({ session, stoppable }: { session: SessionView; stoppable: boolean }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const abort = useAbortSession(session.id);
	const [shareOpen, setShareOpen] = useState(false);
	const [quotaOpen, setQuotaOpen] = useState(false);
	const preset = session.rules?.preset ?? "ask";
	const ruleCount = session.rules?.rules.length ?? 0;
	const ownerName = session.ownerUsername ?? t`another user`;
	const isMobile = useIsMobile();

	const stop = () => {
		abort.mutate(undefined, { onSuccess: () => toast.success(t`Stopped the run.`) });
	};

	const meta = (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
			<span className="font-mono">
				{session.model.provider}/{session.model.modelId}
			</span>
			<span>
				<Trans>Preset</Trans>: {presetLabel(preset)}
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
	);

	return (
		<header className="grid shrink-0 gap-1.5 border-b bg-background/80 px-3 py-2" data-testid="session-header">
			<div className="flex min-w-0 items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t`Back to the session list`}
					title={t`Back to the session list`}
					className="shrink-0 md:hidden"
					data-testid="session-back"
					onClick={() => void navigate({ to: "/sessions" })}
				>
					<ChevronLeftIcon />
				</Button>
				<div className="min-w-0 flex-1">
					<SessionBreadcrumb session={session} />
					<div className="flex min-w-0 items-center gap-2">
						<TitleEditor session={session} />
						<SessionStatusBadge state={session.state} className="shrink-0" />
					</div>
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
					{session.capabilities.chat && (
						<Button
							type="button"
							variant="destructive"
							size="sm"
							data-testid="abort-session"
							disabled={abort.isPending || !stoppable}
							onClick={stop}
						>
							<SquareIcon />
							<Trans>Stop</Trans>
						</Button>
					)}
				</div>
			</div>

			{isMobile ? (
				<details className="text-xs text-muted-foreground" data-testid="session-meta">
					<summary className="cursor-pointer select-none">
						<Trans>Details</Trans>
					</summary>
					<div className="pt-1">{meta}</div>
				</details>
			) : (
				meta
			)}

			<ShareDialog sessionId={session.id} open={shareOpen} onOpenChange={setShareOpen} />
			<QuotaDialog session={session} open={quotaOpen} onOpenChange={setQuotaOpen} />
		</header>
	);
}
