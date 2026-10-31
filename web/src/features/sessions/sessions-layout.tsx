import { useLingui } from "@lingui/react/macro";
import { Outlet } from "@tanstack/react-router";

/**
 * The sessions section's layout: the session list column on the left and the
 * routed page on the right (doc/webui.md "会话界面"). The list itself
 * (virtualised, cursor-paged, SSE-patched) arrives in the pages run; the column
 * and its scroll container are reserved here so that page does not re-layout
 * the shell.
 */
export function SessionsLayout() {
	const { t } = useLingui();
	return (
		<div className="flex min-h-0 flex-1" data-slot="sessions-layout">
			<aside
				data-slot="session-list-slot"
				data-testid="session-list-slot"
				aria-label={t`Session list`}
				className="hidden w-72 shrink-0 flex-col overflow-hidden border-r bg-sidebar/40 md:flex"
			/>
			<div className="min-w-0 flex-1 overflow-hidden">
				<Outlet />
			</div>
		</div>
	);
}
