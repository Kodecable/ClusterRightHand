import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { APP_NAME } from "@/app/meta";
import { navItemForPath } from "@/app/shell/nav";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "@/features/auth/session";
import { SessionSearchDialog } from "@/features/sessions/session-search-dialog";
import { readStorage, writeStorage } from "@/lib/storage";
import { AppSidebar } from "./app-sidebar";
import { PageTitleProvider } from "./page-title";

const SIDEBAR_STORAGE_KEY = "crh.sidebar.open";

function readSidebarOpen(): boolean {
	const stored = readStorage(SIDEBAR_STORAGE_KEY);
	return stored === null ? true : stored === "true";
}

/**
 * The authenticated shell: the collapsible icon sidebar, a top bar with the
 * trigger and the page title, and the routed page inside.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
	const { t, i18n } = useLingui();
	const auth = useAuth();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const href = useRouterState({ select: (state) => state.location.href });
	const [open, setOpen] = useState(readSidebarOpen);
	// A detail page may title the shell with the object's own summary (a task's
	// command) instead of the navigation item; see `usePageTitle`.
	const [pageTitle, setPageTitle] = useState<string>();

	const current = navItemForPath(pathname);
	const fallbackTitle = current ? i18n._(current.label) : APP_NAME;
	const title = pageTitle ?? fallbackTitle;

	useEffect(() => {
		document.title = `${title} · ${APP_NAME}`;
	}, [title]);

	const changeOpen = (next: boolean) => {
		setOpen(next);
		writeStorage(SIDEBAR_STORAGE_KEY, String(next));
	};

	// A logout (or a 401 from any query) must clear the previous user's cache
	// and send the browser to the login page, keeping the current target.
	useEffect(() => {
		if (auth.status !== "anonymous" || pathname === "/login") return;
		queryClient.clear();
		void navigate({ to: "/login", search: { redirect: href }, replace: true });
	}, [auth.status, pathname, href, navigate, queryClient]);

	return (
		<PageTitleProvider setTitle={setPageTitle}>
			<SidebarProvider open={open} onOpenChange={changeOpen} className="h-svh overflow-hidden">
				<AppSidebar />
				<SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden">
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
						<SidebarTrigger data-testid="sidebar-trigger" aria-label={t`Toggle sidebar`} />
						<Separator orientation="vertical" />
						<h1 className="truncate text-sm font-medium" data-testid="page-title" data-path={pathname}>
							{title}
						</h1>
					</header>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="page-content">
						{children}
					</div>
				</SidebarInset>
				{/* One dialog and one Ctrl/⌘+K listener for every authenticated page. */}
				<SessionSearchDialog />
			</SidebarProvider>
		</PageTitleProvider>
	);
}
