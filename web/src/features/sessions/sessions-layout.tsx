import { useLingui } from "@lingui/react/macro";
import { Outlet, useParams } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { SessionList } from "./session-list";

/**
 * The sessions section's layout: the virtualised, cursor-paged, SSE-patched
 * session list column on the left and the routed page on the right
 * (doc/webui.md "会话界面"). Below `md` there is no room for two columns, so
 * `/sessions` shows the list as the main view and `/sessions/:id` shows the
 * session; the session header's back button returns to the list.
 */
export function SessionsLayout() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { sessionId?: string };
	const openSession = params.sessionId !== undefined && params.sessionId !== "";
	return (
		<div className="flex min-h-0 flex-1" data-slot="sessions-layout" data-open-session={openSession ? "true" : "false"}>
			<aside
				data-slot="session-list-slot"
				data-testid="session-list-slot"
				aria-label={t`Session list`}
				className={cn(
					"min-h-0 shrink-0 flex-col overflow-hidden border-r bg-sidebar/40",
					openSession ? "hidden w-72 md:flex" : "flex w-full md:w-72",
				)}
			>
				<SessionList selectedId={params.sessionId} />
			</aside>
			<div className={cn("min-w-0 flex-1 overflow-hidden", openSession ? "block" : "hidden md:block")}>
				<Outlet />
			</div>
		</div>
	);
}
