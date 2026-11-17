import { SESSION_TITLE_MAX_CHARS, type SessionView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, Share2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { InternalLink } from "@/components/internal-link";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displaySessionTitle } from "@/lib/session-title";
import { usePatchSession, useSession } from "./api";
import { SessionMarkers } from "./session-markers";
import { ShareDialog } from "./share-dialog";

function ParentChain({ id }: { id: string }) {
	const parent = useSession(id);
	const { i18n } = useLingui();
	if (!parent.data) return null;
	const parentTitle = displaySessionTitle(parent.data.title, i18n);
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

/**
 * Where a fork came from (doc/design/agent-runtime.md "Forking"): the source title links to its session. The
 * server resolves the title and hides the origin when the caller may no longer see the source.
 */
function ForkedFrom({ session }: { session: SessionView }) {
	if (session.forkedFrom === null) return null;
	return (
		<p className="truncate text-xs text-muted-foreground" data-testid="forked-from">
			<Trans>
				Forked from{" "}
				<InternalLink to="/sessions/$sessionId" params={{ sessionId: session.forkedFrom.sessionId }}>
					{session.forkedFrom.title}
				</InternalLink>
			</Trans>
		</p>
	);
}

function TitleEditor({ session }: { session: SessionView }) {
	const { t, i18n } = useLingui();
	const patch = usePatchSession(session.id);
	const [value, setValue] = useState(session.title ?? "");
	const tooLong = Array.from(value).length > SESSION_TITLE_MAX_CHARS;
	useEffect(() => setValue(session.title ?? ""), [session.title]);

	if (!session.capabilities.configure) {
		return (
			<h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{displaySessionTitle(session.title, i18n)}</h1>
		);
	}

	const save = () => {
		if (patch.isPending || tooLong) return;
		const title = value.trim();
		if (title === (session.title ?? "")) {
			setValue(session.title ?? "");
			return;
		}
		// A blank edit is a real change: it clears the title and stops generation; the default name shows.
		patch.mutate({ title });
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
				placeholder={t`New Session`}
				disabled={patch.isPending}
				aria-invalid={tooLong || undefined}
				aria-describedby={tooLong ? "session-title-error" : undefined}
				className="h-8 border-transparent bg-transparent px-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input dark:bg-transparent"
				onChange={(event) => setValue(event.target.value)}
				onBlur={save}
				onKeyDown={(event) => {
					if (event.key === "Escape") setValue(session.title ?? "");
				}}
			/>
			{tooLong && (
				<p id="session-title-error" role="alert" className="text-xs text-destructive" data-testid="session-title-error">
					{t`A session title is at most ${SESSION_TITLE_MAX_CHARS} characters.`}
				</p>
			)}
		</form>
	);
}

/**
 * The session page's header (doc/design/webui.md "Session header"): only the title (editable for the owner) with the subagent
 * breadcrumb and the grey "Scheduled" / "Shared" badges, and the share button. Model, rules, budget, context, usage and Stop live in the composer footer;
 * a session has no other action, so there is no overflow menu.
 */
export function SessionHeader({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const [shareOpen, setShareOpen] = useState(false);

	return (
		<header className="flex shrink-0 items-center gap-2 bg-background/80 px-3 pt-2 pb-1" data-testid="session-header">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={t`Back to the session list`}
				title={t`Back to the session list`}
				className="shrink-0 lg:hidden"
				data-testid="session-back"
				onClick={() => void navigate({ to: "/sessions" })}
			>
				<ChevronLeftIcon />
			</Button>
			<div className="min-w-0 flex-1">
				<SessionBreadcrumb session={session} />
				<div className="flex min-w-0 items-center gap-2">
					<TitleEditor session={session} />
					<SessionMarkers
						scheduled={session.scheduleId !== null}
						shared={session.relationship === "shared"}
						sharedBy={session.ownerUsername}
					/>
				</div>
				<ForkedFrom session={session} />
			</div>
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
			<ShareDialog
				sessionId={session.id}
				canCreateShares={session.capabilities.createShares}
				open={shareOpen}
				onOpenChange={setShareOpen}
			/>
		</header>
	);
}
