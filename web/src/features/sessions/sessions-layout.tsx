import { useLingui } from "@lingui/react/macro";
import { Outlet, useParams } from "@tanstack/react-router";
import { SessionList } from "./session-list";

/**
 * The sessions section's layout: the virtualised, cursor-paged, SSE-patched
 * session list column on the left and the routed page on the right
 * (doc/webui.md "会话界面").
 */
export function SessionsLayout() {
	const { t } = useLingui();
	const params = useParams({ strict: false }) as { sessionId?: string };
	return (
		<div className="flex min-h-0 flex-1" data-slot="sessions-layout">
			<aside
				data-slot="session-list-slot"
				data-testid="session-list-slot"
				aria-label={t`Session list`}
				className="hidden w-72 shrink-0 flex-col overflow-hidden border-r bg-sidebar/40 md:flex"
			>
				<SessionList selectedId={params.sessionId} />
			</aside>
			<div className="min-w-0 flex-1 overflow-hidden">
				<Outlet />
			</div>
		</div>
	);
}
