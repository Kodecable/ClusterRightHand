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
import { parseTasksSearch } from "@/features/tasks/search";
import { linkClass } from "@/lib/utils";
import { sessionPageChunk, sessionsLayoutChunk } from "./lazy-chunks";
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
				<Link to="/sessions" className={`text-sm ${linkClass}`}>
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
	// `/sessions` renders the draft itself. The layout hides this outlet below `lg`, where the list is the main view.
	component: lazyRouteComponent(sessionPageChunk, "NewSessionPage"),
});

const newSessionRoute = createRoute({
	getParentRoute: () => sessionsRoute,
	path: "new",
	component: lazyRouteComponent(sessionPageChunk, "NewSessionPage"),
});

/** The session page's search: `entry` is the transcript entry a search hit opened (doc/design/webui.md "Jumping to a message"). */
export interface SessionSearch {
	entry?: number;
}

/** Parses `?entry=` from a search hit; anything that is not an entry id is dropped. */
function parseSessionSearch(search: Record<string, unknown>): SessionSearch {
	const raw = search.entry;
	const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
	if (value === undefined || !Number.isSafeInteger(value) || value < 0) return {};
	return { entry: value };
}

const sessionRoute = createRoute({
	getParentRoute: () => sessionsRoute,
	path: "$sessionId",
	validateSearch: parseSessionSearch,
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
	validateSearch: parseTasksSearch,
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

/** The old Batch page is gone: its run form lives in the tasks page's "Run task" dialog. */
const batchRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/batch",
	beforeLoad: () => {
		throw redirect({ to: "/tasks", replace: true });
	},
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

const nodeGroupsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/node-groups",
	component: lazyRouteComponent(() => import("@/features/node-groups/pages"), "NodeGroupsPage"),
});

const nodeGroupDetailRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/node-groups/$nodeGroupId",
	component: lazyRouteComponent(() => import("@/features/node-groups/pages"), "NodeGroupDetailPage"),
});

const sshCredentialsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/ssh-credentials",
	component: lazyRouteComponent(() => import("@/features/ssh-credentials/pages"), "SshCredentialsPage"),
});

const credentialsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/credentials",
	component: lazyRouteComponent(() => import("@/features/credentials/pages"), "CredentialsPage"),
});

// --- admin ----------------------------------------------------------------

const authorizationsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/authorizations",
	beforeLoad: ({ context }) => requireAdmin(context),
	component: lazyRouteComponent(() => import("@/features/authorizations/pages"), "AuthorizationsPage"),
});

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

const systemSettingsRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/settings/system",
	beforeLoad: ({ context }) => requireAdmin(context),
	component: lazyRouteComponent(() => import("@/features/system-settings/pages"), "SystemSettingsPage"),
});

const usersRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/users",
	beforeLoad: ({ context }) => requireAdmin(context),
	component: lazyRouteComponent(() => import("@/features/users/pages"), "UsersPage"),
});

/**
 * One user. Administrators reach anyone; a member reaches their own page even
 * though the `/users` list stays administrators-only. The route itself does not
 * guard by kind: the server answers the no-access case with the same 404 a
 * missing user gets, and the page shows one message for both.
 */
const userDetailRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/users/$userId",
	component: lazyRouteComponent(() => import("@/features/users/pages"), "UserDetailPage"),
});

const userGroupDetailRoute = createRoute({
	getParentRoute: () => authenticatedRoute,
	path: "/user-groups/$userGroupId",
	component: lazyRouteComponent(() => import("@/features/users/user-group-page"), "UserGroupDetailPage"),
});

const routeTree = rootRoute.addChildren([
	loginRoute,
	authenticatedRoute.addChildren([
		indexRoute,
		sessionsRoute.addChildren([sessionsIndexRoute, newSessionRoute, sessionRoute]),
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
		nodeGroupsRoute,
		nodeGroupDetailRoute,
		sshCredentialsRoute,
		credentialsRoute,
		authorizationsRoute,
		tokensRoute,
		auditRoute,
		modelSettingsRoute,
		systemSettingsRoute,
		usersRoute,
		userDetailRoute,
		userGroupDetailRoute,
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
