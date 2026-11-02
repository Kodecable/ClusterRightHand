import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, Share2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SessionView } from "@/lib/api/types";
import { usePatchSession, useSession } from "./api";
import { SessionMarkers } from "./session-markers";
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

/**
 * The session page's header (doc/webui.md#页头): only the title (editable for the owner) with the subagent
 * breadcrumb and the grey "Scheduled" / "Shared" badges, and the share button. Model, rules, budget, context, usage and Stop live in the composer footer;
 * a session has no other action, so there is no overflow menu.
 */
export function SessionHeader({ session }: { session: SessionView }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const [shareOpen, setShareOpen] = useState(false);

	return (
		<header className="flex shrink-0 items-center gap-2 bg-background/80 px-3 py-2" data-testid="session-header">
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
			<ShareDialog sessionId={session.id} open={shareOpen} onOpenChange={setShareOpen} />
		</header>
	);
}
