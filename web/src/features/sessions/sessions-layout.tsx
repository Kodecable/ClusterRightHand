import { useLingui } from "@lingui/react/macro";
import { Outlet, useLocation, useParams } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { SessionList } from "./session-list";

/**
 * The sessions section's layout: the virtualised, cursor-paged, SSE-patched
 * session list column on the left and the routed page on the right
 * (doc/webui.md "会话界面"). Below `lg` the navigation sidebar, the list and a
 * session do not fit side by side, so a session-shaped page (`/sessions/new` or
 * `/sessions/:id`) takes the main view. The `/sessions` index renders the draft
 * too, but is not session-shaped: on narrow screens the list is the main view and
 * the draft is hidden, while `lg` and up show both side by side. The page's back
 * button returns to `/sessions`, which shows the list on narrow screens.
 */
export function SessionsLayout() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const location = useLocation();
	// The draft page is a session-shaped page too (D117): it takes the second column instead of the list.
	const draft = location.pathname === "/sessions/new";
	const openSession = draft || (params.sessionId !== undefined && params.sessionId !== "");
	return (
		<div className="flex min-h-0 flex-1" data-slot="sessions-layout" data-open-session={openSession ? "true" : "false"}>
			<aside
				data-slot="session-list-slot"
				data-testid="session-list-slot"
				aria-label={t`Session list`}
				className={cn(
					"min-h-0 shrink-0 flex-col overflow-hidden border-r bg-background",
					openSession ? "hidden w-72 lg:flex" : "flex w-full lg:w-72",
				)}
			>
				<SessionList selectedId={params.sessionId} />
			</aside>
			<div className={cn("min-w-0 flex-1 overflow-hidden", openSession ? "block" : "hidden lg:block")}>
				<Outlet />
			</div>
		</div>
	);
}
