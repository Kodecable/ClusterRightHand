import { Trans } from "@lingui/react/macro";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	lazyRouteComponent,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import type { AuthStore } from "@/features/auth/session";
import { authStore } from "@/features/auth/session";
import { sessionPageChunk, sessionsIndexPageChunk, sessionsLayoutChunk } from "./lazy-chunks";
import { AppShell } from "./shell/app-shell";

export interface RouterContext {
	auth: AuthStore;
}

function NotFoundPage() {
	return (
		<div className="grid min-h-svh place-items-center p-6 text-center">
			<div className="grid gap-2">
				<h1 className="text-lg font-semibold">
					<Trans>Page not found</Trans>
				</h1>
				<p className="text-sm text-muted-foreground">
					<Trans>The page you asked for does not exist.</Trans>
				</p>
				<Link to="/sessions" className="text-sm text-primary underline underline-offset-2">
					<Trans>Go to sessions</Trans>
				</Link>
			</div>
		</div>
	);
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
	notFoundComponent: NotFoundPage,
});

function RootLayout() {
	return <Outlet />;
}

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
		redirect: typeof search.redirect === "string" ? search.redirect : undefined,
	}),
	beforeLoad: ({ context }) => {
		if (context.auth.state.status === "authenticated") {
			throw redirect({ to: "/sessions", replace: true });
		}
	},
	component: lazyRouteComponent(() => import("@/features/auth/login-page"), "LoginPage"),
});

const authenticatedRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "_authenticated",
	beforeLoad: ({ context, location }) => {
		if (context.auth.state.status === "authenticated") return;
		throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
	},
	component: () => (
		<AppShell>
			<Outlet />
		</AppShell>
	),
});

function requireAdmin(context: RouterContext): void {
	if (context.auth.state.user?.kind === "admin") return;
	throw redirect({ to: "/sessions", replace: true });
}

const indexRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/",
	beforeLoad: () => {
		throw redirect({ to: "/sessions", replace: true });
	},
});

// --- sessions -------------------------------------------------------------

const sessionsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/sessions",
	component: lazyRouteComponent(sessionsLayoutChunk, "SessionsLayout"),
});

const sessionsIndexRoute = createRoute({
	getParentRoute: () => sessionsRoute,
	path: "/",
	component: lazyRouteComponent(sessionsIndexPageChunk, "SessionsPage"),
});

const sessionRoute = createRoute({
	getParentRoute: () => sessionsRoute,
	path: "$sessionId",
	component: lazyRouteComponent(sessionPageChunk, "SessionPage"),
});

// --- schedules ------------------------------------------------------------

const schedulesRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/schedules",
	component: lazyRouteComponent(() => import("@/features/schedules/pages"), "SchedulesPage"),
});

const scheduleDetailRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/schedules/$scheduleId",
	component: lazyRouteComponent(() => import("@/features/schedules/pages"), "ScheduleDetailPage"),
});

// --- tasks ----------------------------------------------------------------

const tasksRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/tasks",
	component: lazyRouteComponent(() => import("@/features/tasks/pages"), "TasksPage"),
});

const taskRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/tasks/$taskId",
	component: lazyRouteComponent(() => import("@/features/tasks/task-page"), "TaskPage"),
});

const taskGroupRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/task-groups/$taskGroupId",
	component: lazyRouteComponent(() => import("@/features/tasks/task-group-page"), "TaskGroupPage"),
});

// --- batch ----------------------------------------------------------------

const batchRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/batch",
	component: lazyRouteComponent(() => import("@/features/batch/pages"), "BatchPage"),
});

// --- approvals ------------------------------------------------------------

const approvalsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/approvals",
	component: lazyRouteComponent(() => import("@/features/approvals/pages"), "ApprovalsPage"),
});

const approvalTaskRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/approvals/tasks/$taskId",
	component: lazyRouteComponent(() => import("@/features/approvals/pages"), "ApprovalTaskPage"),
});

const approvalTaskGroupRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/approvals/task-groups/$taskGroupId",
	component: lazyRouteComponent(() => import("@/features/approvals/pages"), "ApprovalTaskGroupPage"),
});

// --- cluster --------------------------------------------------------------

const nodesRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/nodes",
	component: lazyRouteComponent(() => import("@/features/nodes/pages"), "NodesPage"),
});

const nodeDetailRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/nodes/$nodeId",
	component: lazyRouteComponent(() => import("@/features/nodes/pages"), "NodeDetailPage"),
});

const credentialsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/credentials",
	component: lazyRouteComponent(() => import("@/features/credentials/pages"), "CredentialsPage"),
});

const authorizationsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/authorizations",
	component: lazyRouteComponent(() => import("@/features/authorizations/pages"), "AuthorizationsPage"),
});

// --- admin ----------------------------------------------------------------

const tokensRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/tokens",
	component: lazyRouteComponent(() => import("@/features/tokens/pages"), "TokensPage"),
});

const auditRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/audit",
	component: lazyRouteComponent(() => import("@/features/audit/pages"), "AuditPage"),
});

const modelSettingsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/settings/models",
	beforeLoad: ({ context }) => requireAdmin(context),
	component: lazyRouteComponent(() => import("@/features/settings/pages"), "ModelSettingsPage"),
});

const usersRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/users",
	beforeLoad: ({ context }) => requireAdmin(context),
	component: lazyRouteComponent(() => import("@/features/users/pages"), "UsersPage"),
});

const routeTree = rootRoute.addChildren([
	loginRoute,
	authenticatedRoute.addChildren([
		indexRoute,
		sessionsRoute.addChildren([sessionsIndexRoute, sessionRoute]),
		schedulesRoute,
		scheduleDetailRoute,
		tasksRoute,
		taskRoute,
		taskGroupRoute,
		batchRoute,
		approvalsRoute,
		approvalTaskRoute,
		approvalTaskGroupRoute,
		nodesRoute,
		nodeDetailRoute,
		credentialsRoute,
		authorizationsRoute,
		tokensRoute,
		auditRoute,
		modelSettingsRoute,
		usersRoute,
	]),
]);

export const router = createRouter({
	routeTree,
	context: { auth: authStore },
	defaultPreload: false,
	scrollRestoration: false,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
