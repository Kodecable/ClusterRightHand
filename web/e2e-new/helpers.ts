import { expect, type Page } from "@playwright/test";
import type { AgentEvent, EntryRecord as SessionEntry } from "../src/features/sessions/sessionState";
import type {
	ApprovalList,
	AvailableModel,
	Directory,
	PublicNode,
	SessionListItem,
	SessionView,
	TaskGroupView,
	TaskView,
	User,
} from "../src/lib/api/types";

export const USER: User = {
	id: "user-1",
	username: "ops",
	displayName: "Ada Ops",
	email: "ada@cluster.local",
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const QUOTA_APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [
		{ sessionId: "s1", levelId: "root", title: "Nightly check", since: "2026-01-01T00:00:00Z", quota: 0, used: 100 },
		{ sessionId: "s2", levelId: "root", title: "Deploy check", since: "2026-01-01T00:00:00Z", quota: -5, used: 200 },
	],
};

export interface FakeState {
	loggedIn: boolean;
	user: User;
	sessions: SessionListItem[];
	/** Details by session id; a missing one is derived from the list item. */
	details: Record<string, SessionView>;
	/** The event batch sent when the test opens a session's fake stream. */
	events: Record<string, AgentEvent[]>;
	/** The older history page served for `?before=<historyCursor>`. */
	olderEntries: Record<string, { entries: SessionEntry[]; historyCursor: string | null }>;
	approvals: ApprovalList;
	tasks: TaskView[];
	nodes: PublicNode[];
	models: AvailableModel[];
	directory: Directory;
	groups: Record<string, { group: TaskGroupView; polls: number }>;
	requests: { method: string; url: string; body: unknown }[];
}

export interface ApiMock {
	state: FakeState;
	/** Emit one SSE event on every open fake stream whose URL contains `urlPart`. */
	emit: (urlPart: string, event: string, data: unknown) => Promise<number>;
	/** Wait until the app opened a stream for `urlPart`. */
	waitForStream: (urlPart: string) => Promise<void>;
}

export interface MockOptions {
	loggedIn?: boolean;
	user?: User;
	/** Replaces the defaults; the badge counts two quota waits unless overridden. */
	state?: Partial<FakeState>;
}

export function sessionView(item: SessionListItem, overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: item.id,
		title: item.title,
		ownerUserId: item.ownerUserId,
		parentSessionId: null,
		scheduleId: item.scheduleId,
		model: { provider: "faux", modelId: "faux-1" },
		status: "active",
		createdAt: item.updatedAt,
		updatedAt: item.updatedAt,
		rules: {
			scope: { type: "user", id: item.ownerUserId },
			preset: "ask",
			rules: [],
			default: "ask",
			updatedAt: item.updatedAt,
		},
		relationship: "owner",
		capabilities: { view: true, chat: true, configure: true, manageShares: true },
		ownerUsername: item.ownerName,
		state: item.state,
		waitingKind: item.waitingKind,
		waitingLevelId: item.waitingLevelId,
		quota: null,
		spentTokens: 0,
		shares: [],
		...overrides,
	};
}

export function sessionListItem(overrides: Partial<SessionListItem> = {}): SessionListItem {
	return {
		id: "s1",
		title: "Deploy the cluster",
		ownerUserId: USER.id,
		ownerName: USER.displayName,
		scheduleId: null,
		shared: false,
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function taskView(overrides: Partial<TaskView> = {}): TaskView {
	return {
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "systemctl restart nginx",
		operation: { method: "exec", target: "systemctl restart nginx" },
		actorType: "user",
		actorId: USER.id,
		onBehalfOfUserId: null,
		state: "awaiting_approval",
		exitCode: null,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutHead: "",
		stdoutTail: "",
		stderrHead: "",
		stderrTail: "",
		outputFile: null,
		outputMode: "status",
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		...overrides,
	} as TaskView;
}

export function nodeView(overrides: Partial<PublicNode> = {}): PublicNode {
	return {
		id: "node-1",
		name: "worker-01",
		transport: "client",
		status: "active",
		hostname: "worker-01.local",
		ownerUserId: USER.id,
		clientVersion: "1.0.0",
		privilegedMode: null,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: "2026-01-01T00:00:00.000Z",
		groups: [],
		access: "owner",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		...overrides,
	};
}

export function userEntry(id: string, text: string): SessionEntry {
	return { id, kind: "pi.user", model: [{ role: "user", content: text }] };
}

export function assistantEntry(id: string, text: string): SessionEntry {
	return { id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }] }] };
}

export function toolEntries(id: string, command: string, output: string): SessionEntry[] {
	return [
		{
			id,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: `call-${id}`, name: "exec", arguments: { shell: command } }],
				},
			],
		},
		{
			id: `${id}-result`,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: `call-${id}`,
					toolName: "exec",
					content: [{ type: "text", text: output }],
					isError: false,
				},
			],
		},
	];
}

/** A long transcript: one tall message per entry, enough to scroll and to prepend pages. */
export function makeTranscript(count: number, prefix = "e"): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let index = 0; index < count; index++) {
		const id = `${prefix}${index + 1}`;
		entries.push(
			index % 2 === 0
				? userEntry(id, `Message ${index + 1}. ${"This is a user message with some text in it.\n\n".repeat(3)}`)
				: assistantEntry(
						id,
						`### Answer ${index + 1}\n\n${"The assistant explains what happened on the node in a paragraph.\n\n".repeat(5)}`,
					),
		);
	}
	return entries;
}

export function snapshotEvent(entries: SessionEntry[], historyCursor: string | null): AgentEvent[] {
	return [{ type: "snapshot", snapshot: { entries, tools: [], inbox: [], historyCursor } }];
}

declare global {
	interface Window {
		__crhSseSources?: { url: string; closed: boolean }[];
		__crhEmitSse?: (urlPart: string, event: string, data: unknown) => number;
	}
}

/**
 * A fake crhs behind `page.route` plus a controllable fake `EventSource`.
 *
 * Playwright cannot stream a response through `route.fulfill`, so the SSE half
 * of the API is a small EventSource replacement installed before the app loads:
 * it records its URL and the test emits events through `window.__crhEmitSse`.
 * Everything the app asks for over HTTP is answered here; REST state is mutable
 * so a mutation is visible on the next refetch, exactly like the real server.
 */
export async function mockApi(page: Page, options: MockOptions = {}): Promise<ApiMock> {
	const state: FakeState = {
		loggedIn: options.loggedIn ?? false,
		user: options.user ?? USER,
		sessions: [],
		details: {},
		events: {},
		olderEntries: {},
		approvals: QUOTA_APPROVALS,
		tasks: [],
		nodes: [],
		models: [],
		directory: { users: [], userGroups: [] },
		groups: {},
		requests: [],
		...options.state,
	};

	await page.addInitScript(() => {
		type Listener = (event: { data?: string }) => void;
		class FakeEventSource {
			url: string;
			closed = false;
			listeners: Map<string, Set<Listener>> = new Map();

			constructor(url: string) {
				this.url = url;
				window.__crhSseSources ??= [];
				window.__crhSseSources.push(this as never);
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(name: string, listener: Listener) {
				const set = this.listeners.get(name) ?? new Set<Listener>();
				set.add(listener);
				this.listeners.set(name, set);
			}

			removeEventListener(name: string, listener: Listener) {
				this.listeners.get(name)?.delete(listener);
			}

			close() {
				this.closed = true;
			}

			dispatch(name: string, event: { data?: string }) {
				if (this.closed) return;
				for (const listener of this.listeners.get(name) ?? []) listener(event);
			}
		}

		(window as unknown as { EventSource: typeof EventSource }).EventSource =
			FakeEventSource as unknown as typeof EventSource;
		window.__crhEmitSse = (urlPart, event, data) => {
			let count = 0;
			for (const source of (window.__crhSseSources ?? []) as unknown as {
				url: string;
				closed: boolean;
				dispatch(name: string, event: { data?: string }): void;
			}[]) {
				if (source.closed || !source.url.includes(urlPart)) continue;
				source.dispatch(event, event === "open" ? {} : { data: JSON.stringify(data) });
				count++;
			}
			return count;
		};
	});

	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		const rawBody = request.postData();
		const body = rawBody === null || rawBody === "" ? undefined : JSON.parse(rawBody);
		state.requests.push({ method, url: `${path}${url.search}`, body });

		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

		if (path === "/api/sessions/stream") return;
		if (path === "/api/me")
			return state.loggedIn ? json({ user: state.user }) : json({ error: "unauthenticated" }, 401);
		if (path === "/api/auth/login" && method === "POST") {
			const login = body as { username?: string; password?: string };
			if (login.username === "ops" && login.password === "secret") {
				state.loggedIn = true;
				return json({ user: state.user });
			}
			return json({ error: "invalid username or password" }, 401);
		}
		if (path === "/api/auth/logout") {
			state.loggedIn = false;
			return json({ ok: true });
		}
		if (path === "/api/auth/password") return json({ ok: true });
		if (path === "/api/approvals") return json(state.approvals);
		if (path === "/api/nodes") return json({ nodes: state.nodes });
		if (path === "/api/api-tokens") return json({ tokens: [] });
		if (path === "/api/models") return json({ models: state.models });
		if (path === "/api/directory") return json(state.directory);

		if (path === "/api/sessions" && method === "GET") {
			const scope = url.searchParams.get("scope") ?? "mine";
			const q = (url.searchParams.get("q") ?? "").toLowerCase();
			const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
			const limit = 20;
			const visible = state.sessions.filter((item) => {
				if (scope === "mine" && item.ownerUserId !== state.user.id) return false;
				if (scope === "shared" && !item.shared) return false;
				if (q !== "" && !item.title.toLowerCase().includes(q)) return false;
				return true;
			});
			const items = visible.slice(start, start + limit);
			return json({ items, nextCursor: start + limit < visible.length ? String(start + limit) : null });
		}

		const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
		if (sessionMatch && method === "GET") {
			const id = decodeURIComponent(sessionMatch[1] as string);
			const item = state.sessions.find((candidate) => candidate.id === id);
			const detail = state.details[id] ?? (item ? sessionView(item) : undefined);
			if (!detail) return json({ error: "no such session" }, 404);
			return json({ session: detail, shares: [] });
		}
		if (sessionMatch && method === "PATCH") {
			const id = decodeURIComponent(sessionMatch[1] as string);
			const item = state.sessions.find((candidate) => candidate.id === id);
			const detail = (state.details[id] ?? (item ? sessionView(item) : undefined)) as SessionView;
			const patch = body as Partial<SessionView> & { quota?: number | null };
			const next = { ...detail, ...patch, updatedAt: new Date().toISOString() };
			state.details[id] = next;
			if (item && typeof patch.title === "string") item.title = patch.title;
			return json({ session: next });
		}

		const entriesMatch = /^\/api\/sessions\/([^/]+)\/entries$/.exec(path);
		if (entriesMatch) {
			const id = decodeURIComponent(entriesMatch[1] as string);
			return json(state.olderEntries[id] ?? { entries: [], historyCursor: null });
		}

		const eventMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
		if (eventMatch) return json({ error: "the fake EventSource handles events" }, 500);

		if (path === "/api/tasks" && method === "GET") return json({ items: state.tasks, nextCursor: null });
		const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
		if (taskMatch && method === "GET") {
			const id = decodeURIComponent(taskMatch[1] as string);
			const task = state.tasks.find((candidate) => candidate.id === id);
			if (!task) return json({ error: "no such task" }, 404);
			return json({ task });
		}
		const approvalMatch = /^\/api\/(tasks|task-groups)\/([^/]+)\/approval$/.exec(path);
		if (approvalMatch && method === "POST") {
			const kind = approvalMatch[1] as "tasks" | "task-groups";
			const id = decodeURIComponent(approvalMatch[2] as string);
			state.approvals =
				kind === "tasks"
					? { ...state.approvals, tasks: state.approvals.tasks.filter((task) => task.id !== id) }
					: {
							...state.approvals,
							taskGroups: state.approvals.taskGroups.filter((group) => group.id !== id),
						};
			return json({ ok: true });
		}
		const authorizationMatch = /^\/api\/(tasks|task-groups)\/([^/]+)\/authorization$/.exec(path);
		if (authorizationMatch) {
			return authorizationMatch[1] === "tasks" ? json({ authorization: null }) : json({ group: null });
		}
		if (path === "/api/authorizations" && method === "POST") {
			return json({ authorization: { id: "auth-1", dispatched: [] } });
		}

		if (path === "/api/task-groups" && method === "POST") {
			const input = body as { targets: string[]; parallel?: number };
			const ids = state.nodes
				.filter((node) => input.targets.includes(node.id) || input.targets.includes(node.name))
				.map((node) => node.id);
			const groupId = "group-1";
			const tasks = ids.map((nodeId, index) =>
				taskView({
					id: `batch-task-${index + 1}`,
					nodeId,
					state: "running",
					summary: "batch run",
					finishedAt: null,
				}),
			);
			const group: TaskGroupView = {
				id: groupId,
				state: "running",
				targets: input.targets,
				nodeIds: ids,
				parallel: input.parallel ?? 10,
				failFast: false,
				outputMode: "status",
				privileged: false,
				skipped: [],
				tasks,
				createdAt: "2026-01-01T00:00:00.000Z",
				finishedAt: null,
			};
			state.groups[groupId] = { group, polls: 0 };
			return json({ group });
		}
		const groupMatch = /^\/api\/task-groups\/([^/]+)$/.exec(path);
		if (groupMatch && method === "GET") {
			const id = decodeURIComponent(groupMatch[1] as string);
			const stored = state.groups[id];
			if (!stored) return json({ error: "no such task group" }, 404);
			stored.polls += 1;
			if (stored.polls >= 2) {
				const finished: TaskGroupView = {
					...stored.group,
					state: "finished",
					finishedAt: "2026-01-01T00:01:00.000Z",
					tasks: stored.group.tasks.map((task, index) =>
						taskView({
							...task,
							state: "exited",
							exitCode: index === 0 ? 0 : 1,
							finishedAt: "2026-01-01T00:01:00.000Z",
						}),
					),
				};
				stored.group = finished;
				return json({ group: finished });
			}
			return json({ group: stored.group });
		}
		const groupAuthMatch = /^\/api\/task-groups\/([^/]+)\/authorization$/.exec(path);
		if (groupAuthMatch) return json({ group: null });

		return json({});
	});

	return {
		state,
		emit: async (urlPart, event, data) =>
			page.evaluate(({ part, name, payload }) => window.__crhEmitSse?.(part, name, payload) ?? 0, {
				part: urlPart,
				name: event,
				payload: data,
			}),
		waitForStream: async (urlPart) => {
			await page.waitForFunction(
				(part) => window.__crhSseSources?.some((source) => source.url.includes(part) && !source.closed) === true,
				urlPart,
			);
		},
	};
}

export async function login(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
	await page.getByLabel("Username").fill("ops");
	await page.getByLabel("Password").fill("secret");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
}

/** Open the user menu from the keyboard (focus the trigger, press Enter). */
export async function openUserMenuWithKeyboard(page: Page): Promise<void> {
	const trigger = page.getByTestId("user-menu-trigger");
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("user-menu")).toBeVisible();
}

export async function openMenuSection(page: Page, testId: string): Promise<void> {
	await page.getByTestId(testId).click();
}

/** Open one session from the list and deliver its snapshot event. */
export async function openSession(page: Page, api: ApiMock, sessionId: string, events?: AgentEvent[]): Promise<void> {
	await page.locator(`[data-session-id="${sessionId}"]`).click();
	await api.waitForStream(`/api/sessions/${sessionId}/events`);
	await api.emit(`/api/sessions/${sessionId}/events`, "events", events ?? api.state.events[sessionId] ?? []);
}

export function emptyApprovals(): ApprovalList {
	return { tasks: [], taskGroups: [], authorizations: { tasks: [], taskGroups: [] }, quotas: [] };
}

export type { AgentEvent, SessionEntry };
