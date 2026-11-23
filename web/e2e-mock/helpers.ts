import type {
	ApiTokenView,
	ApprovalList,
	ApprovalRequest,
	AuditEvent,
	AuthorizationSummary,
	AvailableModel,
	ChannelAccountListResponse,
	ChannelView,
	CustomModel,
	Directory,
	JobView,
	LibraryFile,
	LibraryView,
	ModelPreset,
	ModelPresetInput,
	ModelPresetKind,
	ModelProviderInput,
	ModelProviderView,
	ModelRef,
	NodeAccessGrant,
	NodeGroup,
	NodeTrust,
	PtyView,
	PublicNode,
	RefMap,
	ScheduleRunView,
	ScheduleView,
	SessionExtension,
	SessionListItem,
	SessionView,
	SigningCredentialView,
	SshCredential,
	SshNodeDetails,
	SshTargetInput,
	TaskGroupView,
	TaskOutcome,
	TaskView,
	User,
	UserGroup,
	UserSettings,
} from "@crh/api";
import { expect, type Page } from "@playwright/test";
import type { EntryRecord as SessionEntry, SessionEvent } from "../src/features/sessions/session-events";

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
	externalCalls: [],
	ptys: [],
	authorizations: { tasks: [], taskGroups: [] },
	requests: [],
	quotas: [
		{
			// A root no session test opens: the default badge counts these without dock panels.
			sessionId: "quota-session-1",
			levelId: "root",
			title: "Nightly check",
			since: "2026-01-01T00:00:00Z",
			budgetRemaining: 0,
			budgetUsedTokens: 100,
		},
		{
			sessionId: "quota-session-2",
			levelId: "root",
			title: "Deploy check",
			since: "2026-01-01T00:00:00Z",
			budgetRemaining: -5,
			budgetUsedTokens: 200,
		},
	],
};

export interface FakeState {
	loggedIn: boolean;
	user: User;
	sessions: SessionListItem[];
	/** Details by session id; a missing one is derived from the list item. */
	details: Record<string, SessionView>;
	/** The event batch sent when the test opens a session's fake stream. */
	events: Record<string, SessionEvent[]>;
	/** The older history page served for `?before=<historyCursor>`. */
	olderEntries: Record<string, { entries: SessionEntry[]; historyCursor: string | null }>;
	/** A session's jobs (`GET /api/jobs?session=…`), newest first. */
	jobs: Record<string, JobView[]>;
	approvals: ApprovalList;
	tasks: TaskView[];
	nodes: PublicNode[];
	/** The terminals the fake server holds; `GET /api/ptys` filters nothing for an admin. */
	ptys: PtyView[];
	/** Whether the terminal subsystem is on: the nav entry disappears while it is false. */
	ptyEnabled: boolean;
	models: AvailableModel[];
	/** The session model preset's model, when the fake server has one. */
	sessionModel: ModelRef | null;
	/** The extensions a new session reaches (`GET /api/sessions/extensions`), all on. */
	availableExtensions: SessionExtension[];
	directory: Directory;
	taskGroups: Record<string, { taskGroup: TaskGroupView; polls: number }>;
	nodeGroups: NodeGroup[];
	nodeAccessGrants: NodeAccessGrant[];
	schedules: ScheduleView[];
	runs: Record<string, ScheduleRunView[]>;
	tokens: ApiTokenView[];
	channels: ChannelView[];
	channelAccounts: ChannelAccountListResponse;
	userSettings: UserSettings;
	providers: ModelProviderView[];
	builtinProviders: string[];
	/** The ids a custom provider's upstream `/models` lists, by provider id (the discover mock). */
	discoveredModels: Record<string, string[]>;
	presets: ModelPreset[];
	signingCredentials: SigningCredentialView[];
	audit: AuditEvent[];
	users: User[];
	userGroups: UserGroup[];
	sshCredentials: SshCredential[];
	/** Confirmed routes by SSH node id, as `GET /api/nodes/:id` returns them. */
	sshRoutes: Record<string, SshNodeDetails["hops"]>;
	authorizations: AuthorizationSummary[];
	nodeTrust: Record<string, NodeTrust>;
	/** Libraries the fake API exposes, and each library's files by its `user:…`/`user_group:…` reference. */
	libraries: LibraryView[];
	libraryFiles: Record<string, LibraryFile[]>;
	/** Uploads the fake server refuses, keyed by file path, with the reason it returns. */
	libraryUploadErrors: Record<string, string>;
	/** Node file listings by `<node id>:<absolute path>`, as the browse endpoints return their entries. */
	nodeFiles: Record<string, { path: string; name: string; type: string; size: number; mtime?: string }[]>;
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
	/** Artificial latency for every mocked API response, for the performance runs. */
	latencyMs?: number;
}

export function sessionView(item: SessionListItem, overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: item.id,
		title: item.title,
		ownerUserId: item.ownerUserId,
		parentSessionId: null,
		scheduleId: item.scheduleId,
		model: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
		status: "active",
		createdAt: item.updatedAt,
		updatedAt: item.updatedAt,
		rules: {
			scope: { type: "user", id: item.ownerUserId },
			rulePreset: "ask",
			rules: [],
			default: "require-approval",
			updatedAt: item.updatedAt,
		},
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, configure: true, manageShares: true, createShares: true },
		ownerUsername: item.ownerName,
		state: item.state,
		waitingKind: item.waitingKind,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
		stats: {
			turns: 0,
			steps: 0,
			ttftMs: 0,
			ttftSteps: 0,
			decodeMs: 0,
			decodeTokens: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
		},
		forkedFrom: null,
		todos: null,
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
		unread: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/** The compact request the fake server returns beside a waiting task, matching the real builder's shape. */
export function approvalRequestForTask(
	task: TaskView,
	options: { nodeName?: string; username?: string } = {},
): ApprovalRequest {
	const fileOperation =
		task.kind === "file.read" ||
		task.kind === "file.write" ||
		task.kind === "file.push" ||
		task.kind === "file.pull" ||
		task.kind === "file.edit" ||
		task.kind === "file.stat" ||
		task.kind === "file.list"
			? (task.kind.slice("file.".length) as "read" | "write" | "push" | "pull" | "edit" | "stat" | "list")
			: undefined;
	const action: ApprovalRequest["action"] =
		fileOperation === undefined
			? { type: "exec", command: task.summary }
			: { type: "file", operation: fileOperation, path: task.summary };
	const method = (
		fileOperation === undefined ? "exec" : `file.${fileOperation}`
	) as ApprovalRequest["alwaysAllow"][number]["rule"]["method"];
	const node = options.nodeName ?? "worker-01";
	return {
		kind: "task",
		id: task.id,
		phase: task.phase ?? (task.state === "awaiting_authorization" ? "awaiting_signature" : "awaiting_user"),
		source: task.source,
		action,
		nodes: [node],
		privileged: task.privileged,
		...(task.approval?.review !== undefined && !("status" in task.approval.review)
			? { review: { risk: task.approval.review.risk, reason: task.approval.review.reason } }
			: {}),
		alwaysAllow: [
			{
				option: "exact",
				rule: { action: "allow", method, nodes: [node], privileged: task.privileged, exact: task.summary },
			},
			{
				option: "prefix",
				rule: { action: "allow", method, nodes: [node], privileged: task.privileged, prefix: task.summary },
			},
		],
	};
}

/** The compact request the fake server returns beside a waiting task group. */
export function approvalRequestForTaskGroup(group: TaskGroupView): ApprovalRequest {
	const nodes = group.targets.map((target) => group.refs?.[target]?.name ?? target);
	return {
		kind: "task_group",
		id: group.id,
		phase: group.phase ?? (group.state === "awaiting_authorization" ? "awaiting_signature" : "awaiting_user"),
		source: group.source,
		action: group.action,
		nodes: nodes.slice(0, 10),
		...(nodes.length > 10 ? { moreNodes: nodes.length - 10 } : {}),
		privileged: group.privileged,
		alwaysAllow: [
			{
				option: "exact",
				rule: {
					action: "allow",
					method: "exec",
					nodes,
					privileged: group.privileged,
					exact: group.summary ?? group.id,
				},
			},
			{
				option: "prefix",
				rule: {
					action: "allow",
					method: "exec",
					nodes,
					privileged: group.privileged,
					prefix: group.summary ?? group.id,
				},
			},
		],
	};
}

/** The fake server's copy of the terminal classification, enough for list and page fixtures. */
function fixtureOutcome(task: Partial<TaskView>): TaskOutcome | null {
	if (
		task.state !== "exited" &&
		task.state !== "errored" &&
		task.state !== "rejected" &&
		task.state !== "unknown" &&
		task.state !== "denied" &&
		task.state !== "cancelled" &&
		task.state !== "expired"
	) {
		return null;
	}
	if (task.state === "cancelled") return { kind: "cancelled", failed: false };
	if (task.state === "expired") {
		return {
			kind: "expired",
			failed: false,
			...(task.errorCode == null ? {} : { errorCode: task.errorCode }),
			...(task.errorMessage == null ? {} : { errorMessage: task.errorMessage }),
		};
	}
	if (task.timedOut === true) return { kind: "timed_out", failed: true };
	if (task.signal !== null && task.signal !== undefined && task.signal !== "")
		return { kind: "signal", failed: true, signal: task.signal };
	if (task.state === "rejected") return { kind: "rejected", failed: true };
	if (task.state === "denied") return { kind: "denied", failed: true };
	if (task.errorCode !== null && task.errorCode !== undefined)
		return { kind: "error", failed: true, errorCode: task.errorCode, errorMessage: task.errorMessage ?? null };
	if (task.state === "unknown") return { kind: "unknown", failed: true };
	if (task.exitCode !== null && task.exitCode !== undefined) {
		if (task.exitCode === 0) {
			return task.kind === "exec"
				? { kind: "succeeded", failed: false, exitCode: 0 }
				: { kind: "succeeded", failed: false };
		}
		return { kind: "exit", failed: true, exitCode: task.exitCode };
	}
	return { kind: "unknown", failed: true };
}

export function taskView(overrides: Partial<TaskView> = {}): TaskView {
	const view = {
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "systemctl restart nginx",
		action: { type: "exec", command: "systemctl restart nginx" },
		source: { type: "user", userId: USER.id, username: USER.username },
		outcome: null,
		operation: { method: "exec", target: "systemctl restart nginx" },
		actorType: "user",
		actorId: USER.id,
		onBehalfOfUserId: null,
		state: "awaiting_approval",
		exitCode: null,
		signal: null,
		timedOut: false,
		errorCode: null,
		errorMessage: null,
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		notice: null,
		outputFile: null,
		outputLost: false,
		outputMode: "status",
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		phase: "awaiting_user",
		...overrides,
	} as TaskView;
	view.outcome = overrides.outcome ?? fixtureOutcome(view);
	return view;
}

export function ptyView(overrides: Partial<PtyView> = {}): PtyView {
	return {
		id: "pty-1",
		nodeId: "node-1",
		nodeName: "worker-01",
		userId: USER.id,
		username: USER.username,
		privileged: false,
		argv: [],
		size: { rows: 24, cols: 80 },
		title: "",
		state: "running",
		exitCode: null,
		creatingSessionId: null,
		sessionIds: [],
		idleTimeoutMs: null,
		openedAt: "2026-01-01T00:00:00.000Z",
		endedAt: null,
		lastActivityAt: "2026-01-01T00:00:00.000Z",
		viewers: [],
		authorization: null,
		authorizationPhase: null,
		rejection: null,
		approval: null,
		approvalRequest: null,
		...overrides,
	};
}

export function nodeView(overrides: Partial<PublicNode> = {}): PublicNode {
	return {
		id: "node-1",
		name: "worker-01",
		transport: "client",
		status: "active",
		hostname: "worker-01.local",
		clientVersion: "1.0.0",
		privilegedMode: null,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		approvedAt: "2026-01-01T00:00:00.000Z",
		nodeGroups: [],
		access: "admin",
		facts: null,
		keyFingerprint: null,
		connected: true,
		clockWarning: null,
		trustWarnings: [],
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

export function snapshotEvent(entries: SessionEntry[], historyCursor: string | null): SessionEvent[] {
	return [{ type: "snapshot", snapshot: { entries, tools: [], inbox: [], historyCursor } }];
}

declare global {
	interface Window {
		__crhSseSources?: { url: string; closed: boolean }[];
		__crhEmitSse?: (urlPart: string, event: string, data: unknown) => number;
		/** Counted by the app's entry point so a reload can be told apart from an in-app update. */
		__crhAppMounts?: number;
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
		jobs: {},
		approvals: QUOTA_APPROVALS,
		tasks: [],
		nodes: [],
		ptys: [],
		ptyEnabled: false,
		models: [],
		sessionModel: null,
		availableExtensions: [],
		directory: { users: [], userGroups: [] },
		taskGroups: {},
		nodeGroups: [],
		nodeAccessGrants: [],
		schedules: [],
		runs: {},
		tokens: [],
		channels: [],
		channelAccounts: { accounts: [], channels: [] },
		userSettings: {
			locale: null,
			defaultModel: null,
			defaultRulePreset: null,
			showProgress: true,
			defaultChannelAccountId: null,
		},
		providers: [],
		builtinProviders: ["faux"],
		discoveredModels: {},
		presets: [
			{
				kind: "session",
				model: null,
				systemPrompt: null,
				defaultPrompt:
					"You are ClusterRightHand, an assistant that operates the user's servers through the cluster tools.",
				protocol: "- Start with list_nodes when you do not know the nodes yet.",
			},
			{
				kind: "review",
				model: null,
				systemPrompt: null,
				defaultPrompt: "You review operations an automated agent wants to run on a user's servers.",
				protocol: "Answer by calling submit_review.",
			},
			{
				kind: "title",
				model: null,
				systemPrompt: null,
				defaultPrompt: "Write a short title for this conversation.",
				protocol: "Reply with the title only, on one line, at most 60 characters, without quotes.",
			},
		],
		signingCredentials: [],
		audit: [],
		users: [],
		userGroups: [],
		sshCredentials: [],
		sshRoutes: {},
		authorizations: [],
		nodeTrust: {},
		libraries: [],
		libraryFiles: {},
		nodeFiles: {},
		libraryUploadErrors: {},
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
		if (options.latencyMs !== undefined && options.latencyMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
		}
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		const rawBody = request.postData();
		// A library upload is a raw body, not JSON.
		let body: unknown;
		try {
			body = rawBody === null || rawBody === "" ? undefined : JSON.parse(rawBody);
		} catch {
			body = undefined;
		}
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
		if (path === "/api/nodes") {
			const transport = url.searchParams.get("transport");
			const ids = url.searchParams.get("ids")?.split(",");
			const q = url.searchParams.get("q")?.toLowerCase() ?? "";
			const nodes = state.nodes.filter((node) => {
				if (transport !== null && node.transport !== transport) return false;
				if (ids !== undefined && !ids.includes(node.id)) return false;
				if (q !== "" && !`${node.name} ${node.hostname ?? ""}`.toLowerCase().includes(q)) return false;
				return true;
			});
			return json({ nodes });
		}
		if (path === "/api/node-groups" && method === "GET") return json({ groups: state.nodeGroups });
		if (path === "/api/node-groups" && method === "POST") {
			const group: NodeGroup = {
				id: `node-group-${state.nodeGroups.length + 1}`,
				name: (body as { name: string }).name,
				memberIds: [],
			};
			state.nodeGroups.push(group);
			return json({ group }, 201);
		}
		const nodeGroupMembers = /^\/api\/node-groups\/([^/]+)\/members$/.exec(path);
		const nodeGroupMatch = /^\/api\/node-groups\/([^/]+)$/.exec(path);
		if (nodeGroupMembers && method === "PUT") {
			const id = decodeURIComponent(nodeGroupMembers[1] as string);
			const group = state.nodeGroups.find((candidate) => candidate.id === id);
			if (!group) return json({ error: "no such node group" }, 404);
			group.memberIds = (body as { nodeIds: string[] }).nodeIds;
			for (const node of state.nodes) {
				node.nodeGroups = state.nodeGroups
					.filter((candidate) => candidate.memberIds.includes(node.id))
					.map((candidate) => ({ id: candidate.id, name: candidate.name }));
			}
			return json({ group });
		}
		if (nodeGroupMatch && method === "PATCH") {
			const id = decodeURIComponent(nodeGroupMatch[1] as string);
			const group = state.nodeGroups.find((candidate) => candidate.id === id);
			if (!group) return json({ error: "no such node group" }, 404);
			group.name = (body as { name: string }).name;
			return json({ group });
		}
		if (nodeGroupMatch && method === "DELETE") {
			const id = decodeURIComponent(nodeGroupMatch[1] as string);
			state.nodeGroups = state.nodeGroups.filter((candidate) => candidate.id !== id);
			for (const node of state.nodes) node.nodeGroups = node.nodeGroups.filter((group) => group.id !== id);
			return json({ ok: true });
		}
		if (path === "/api/node-access-grants" && method === "GET") {
			const targetType = url.searchParams.get("targetType");
			const targetId = url.searchParams.get("targetId");
			const granteeType = url.searchParams.get("granteeType");
			const granteeId = url.searchParams.get("granteeId");
			return json({
				grants: state.nodeAccessGrants.filter((grant) => {
					if (targetType !== null && grant.targetType !== targetType) return false;
					if (targetId !== null && grant.targetId !== targetId) return false;
					if (granteeType !== null && grant.granteeType !== granteeType) return false;
					if (granteeId !== null && grant.granteeId !== granteeId) return false;
					return true;
				}),
			});
		}
		if (path === "/api/node-access-grants" && method === "POST") {
			const input = body as {
				granteeType: NodeAccessGrant["granteeType"];
				granteeId: string;
				targetType: NodeAccessGrant["targetType"];
				targetId: string;
			};
			if (
				state.nodeAccessGrants.some(
					(grant) =>
						grant.granteeType === input.granteeType &&
						grant.granteeId === input.granteeId &&
						grant.targetType === input.targetType &&
						grant.targetId === input.targetId,
				)
			) {
				return json({ error: "this grant already exists" }, 409);
			}
			const granteeName =
				input.granteeType === "user"
					? (state.users.find((user) => user.id === input.granteeId)?.username ?? null)
					: (state.userGroups.find((group) => group.id === input.granteeId)?.name ?? null);
			const targetName =
				input.targetType === "node"
					? (state.nodes.find((node) => node.id === input.targetId)?.name ?? null)
					: (state.nodeGroups.find((group) => group.id === input.targetId)?.name ?? null);
			const grant: NodeAccessGrant = {
				id: `grant-${state.nodeAccessGrants.length + 1}`,
				...input,
				granteeName,
				targetName,
				createdAt: "2026-01-01T00:00:00.000Z",
				createdByUserId: state.user.id,
			};
			state.nodeAccessGrants.push(grant);
			return json({ grant }, 201);
		}
		const accessGrantMatch = /^\/api\/node-access-grants\/([^/]+)$/.exec(path);
		if (accessGrantMatch && method === "DELETE") {
			const id = decodeURIComponent(accessGrantMatch[1] as string);
			state.nodeAccessGrants = state.nodeAccessGrants.filter((grant) => grant.id !== id);
			return json({ ok: true });
		}
		if (path === "/api/models") return json({ models: state.models, sessionModel: state.sessionModel });
		if (path === "/api/directory") return json(state.directory);
		if (path === "/api/privilege/crhs-key") {
			return json({ key: { authorizedKey: "ssh-ed25519 AAAAcrhs crhs", fingerprint: "SHA256:crhs" } });
		}

		// --- schedules -----------------------------------------------------
		if (path === "/api/schedules/preview" && method === "POST") {
			return json({ times: ["2026-02-01T09:00:00.000Z", "2026-02-02T09:00:00.000Z"] });
		}
		if (path === "/api/schedules" && method === "GET") return json({ schedules: state.schedules });
		if (path === "/api/schedules" && method === "POST") {
			const input = body as ScheduleView;
			const schedule: ScheduleView = {
				...input,
				id: `schedule-${state.schedules.length + 1}`,
				ownerUserId: state.user.id,
				rules: [],
				refs: {},
				nextRunAt: "2026-02-01T09:00:00.000Z",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				lastRun: null,
				inProgress: false,
				preview: [],
				previewError: null,
			};
			state.schedules.push(schedule);
			state.runs[schedule.id] = [];
			return json({ schedule });
		}
		const scheduleRunNow = /^\/api\/schedules\/([^/]+)\/run$/.exec(path);
		if (scheduleRunNow && method === "POST") {
			const id = decodeURIComponent(scheduleRunNow[1] as string);
			const schedule = state.schedules.find((candidate) => candidate.id === id);
			const run: ScheduleRunView = {
				id: `run-${Date.now()}`,
				scheduleId: id,
				fireTime: "2026-01-01T00:00:00.000Z",
				manual: true,
				status: "running",
				sessionId: "session-run",
				reason: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:00.000Z",
				finishedAt: null,
			};
			state.runs[id] = [run, ...(state.runs[id] ?? [])];
			if (schedule) {
				schedule.inProgress = true;
				schedule.lastRun = run;
			}
			return json({ run });
		}
		const scheduleRuns = /^\/api\/schedules\/([^/]+)\/runs$/.exec(path);
		if (scheduleRuns && method === "GET") {
			const id = decodeURIComponent(scheduleRuns[1] as string);
			return json({ items: state.runs[id] ?? [], nextCursor: null });
		}
		const scheduleMatch = /^\/api\/schedules\/([^/]+)$/.exec(path);
		if (scheduleMatch) {
			const id = decodeURIComponent(scheduleMatch[1] as string);
			const schedule = state.schedules.find((candidate) => candidate.id === id);
			if (!schedule) return json({ error: "no such schedule" }, 404);
			if (method === "GET") return json({ schedule });
			if (method === "PATCH") {
				Object.assign(schedule, body as Partial<ScheduleView>, { updatedAt: "2026-01-02T00:00:00.000Z" });
				return json({ schedule });
			}
			if (method === "DELETE") {
				state.schedules = state.schedules.filter((candidate) => candidate.id !== id);
				return json({ ok: true });
			}
		}

		// --- nodes ---------------------------------------------------------
		const nodeTasksMatch = /^\/api\/nodes\/([^/]+)\/tasks$/.exec(path);
		if (nodeTasksMatch && method === "GET") {
			const id = decodeURIComponent(nodeTasksMatch[1] as string);
			return json({ tasks: state.tasks.filter((task) => task.nodeId === id) });
		}
		const nodeTrustMatch = /^\/api\/nodes\/([^/]+)\/trust$/.exec(path);
		if (nodeTrustMatch && method === "GET") {
			const id = decodeURIComponent(nodeTrustMatch[1] as string);
			return json({ trust: state.nodeTrust[id] ?? trustedNode(id) });
		}
		const nodeGroupsMatch = /^\/api\/nodes\/([^/]+)\/node-groups$/.exec(path);
		if (nodeGroupsMatch && method === "PUT") {
			const id = decodeURIComponent(nodeGroupsMatch[1] as string);
			const node = state.nodes.find((candidate) => candidate.id === id);
			if (!node) return json({ error: "no such node" }, 404);
			const refs = (body as { nodeGroups: string[] }).nodeGroups;
			const chosen = state.nodeGroups.filter((group) =>
				refs.some((ref) => ref === group.id || ref.toLowerCase() === group.name.toLowerCase()),
			);
			for (const group of state.nodeGroups) {
				group.memberIds = group.memberIds.filter((nodeId) => nodeId !== id);
			}
			for (const group of chosen) group.memberIds.push(id);
			node.nodeGroups = chosen.map((group) => ({ id: group.id, name: group.name }));
			return json({ nodeGroups: node.nodeGroups });
		}
		const sshNodeTest = /^\/api\/nodes\/([^/]+)\/ssh-test$/.exec(path);
		if (sshNodeTest && method === "POST") return json({ ok: true });
		const nodeMatch = /^\/api\/nodes\/([^/]+)$/.exec(path);
		if (nodeMatch && method === "GET") {
			const id = decodeURIComponent(nodeMatch[1] as string);
			const node = state.nodes.find((candidate) => candidate.id === id);
			if (!node) return json({ error: "no such node" }, 404);
			const ssh =
				node.transport === "ssh"
					? {
							hops: state.sshRoutes[id] ?? [
								{
									host: node.hostname ?? "target.example",
									port: 22,
									user: "deploy",
									hostFingerprint: "SHA256:probe",
									credentialId: "cred-1",
									credential: { id: "cred-1", name: "laptop" },
								},
							],
						}
					: null;
			// The SSH route and credential are administrator data; a non-admin gets only the node.
			return state.user.kind === "admin" ? json({ node, ssh }) : json({ node });
		}
		if (path === "/api/ssh-credentials" && method === "GET") return json({ credentials: state.sshCredentials });
		if (path === "/api/ssh-credentials" && method === "POST") {
			const credential = {
				id: `cred-${state.sshCredentials.length + 1}`,
				name: (body as { name: string }).name,
				publicKey: "ssh-ed25519 AAAAlaptop laptop",
				createdAt: "2026-01-01T00:00:00.000Z",
				usedBy: [],
			};
			state.sshCredentials.push(credential);
			return json({ credential });
		}
		const sshCredentialMatch = /^\/api\/ssh-credentials\/([^/]+)$/.exec(path);
		if (sshCredentialMatch && method === "DELETE") {
			const id = decodeURIComponent(sshCredentialMatch[1] as string);
			const credential = state.sshCredentials.find((candidate) => candidate.id === id);
			if (!credential) return json({ error: "no such SSH credential" }, 404);
			if (credential.usedBy.length > 0) return json({ error: "the credential is in use by a node" }, 409);
			state.sshCredentials = state.sshCredentials.filter((candidate) => candidate.id !== id);
			return json({ ok: true });
		}
		if (path === "/api/ssh-nodes/probe" && method === "POST") {
			// The wizard probes the first hop without a pinned fingerprint (the target when all jumps are pinned).
			const target = body as SshTargetInput;
			const jumps = target.jumps ?? [];
			const unpinned = jumps.findIndex((hop) => !hop.hostFingerprint);
			const hop = unpinned >= 0 ? unpinned : jumps.length;
			return json({ hop, fingerprint: `SHA256:hop-${hop}` });
		}
		if (path === "/api/ssh-nodes/test" && method === "POST") return json({ ok: true });
		if (path === "/api/ssh-nodes" && method === "POST") {
			const input = body as SshTargetInput & { name: string };
			const node = nodeView({
				id: `ssh-node-${state.nodes.length + 1}`,
				name: input.name || input.host,
				transport: "ssh",
				hostname: input.host,
				connected: null,
				access: "admin",
			});
			state.nodes.push(node);
			state.sshRoutes[node.id] = [...(input.jumps ?? []), input].map((hop) => ({
				host: hop.host,
				port: hop.port ?? 22,
				user: hop.user,
				hostFingerprint: hop.hostFingerprint ?? "",
				credentialId: hop.credentialId,
				credential: {
					id: hop.credentialId,
					name: state.sshCredentials.find((candidate) => candidate.id === hop.credentialId)?.name ?? null,
				},
			}));
			return json({ node });
		}

		// --- terminals (doc/design/pty.md "WebUI") ----------------------------
		if (path === "/api/ptys/enabled" && method === "GET") return json({ enabled: state.ptyEnabled });
		if (path === "/api/ptys" && method === "GET") return json({ enabled: state.ptyEnabled, terminals: state.ptys });
		if (path === "/api/ptys" && method === "POST") {
			const input = body as {
				node: string;
				argv?: string[];
				privileged?: boolean;
				size?: { rows: number; cols: number };
			};
			const node = state.nodes.find(
				(candidate) => candidate.id === input.node || candidate.name.toLowerCase() === input.node.toLowerCase(),
			);
			const now = new Date().toISOString();
			const terminal = ptyView({
				id: `pty-${state.ptys.length + 1}`,
				nodeId: node?.id ?? input.node,
				nodeName: node?.name ?? null,
				userId: state.user.id,
				username: state.user.username,
				privileged: input.privileged === true,
				argv: input.argv ?? [],
				size: input.size ?? { rows: 24, cols: 80 },
				state: input.privileged === true ? "opening" : "running",
				openedAt: now,
				lastActivityAt: now,
				authorization: input.privileged === true ? { options: [], lastRejection: null } : null,
				authorizationPhase: input.privileged === true ? "preparing" : null,
			});
			state.ptys.push(terminal);
			return json({ terminal }, 201);
		}
		const ptyResizeMatch = /^\/api\/ptys\/([^/]+)\/resize$/.exec(path);
		if (ptyResizeMatch && method === "POST") {
			const id = decodeURIComponent(ptyResizeMatch[1] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			if (!terminal) return json({ error: "no such terminal" }, 404);
			terminal.size = body as { rows: number; cols: number };
			return json({ terminal });
		}
		const ptySessionMatch = /^\/api\/ptys\/([^/]+)\/sessions\/([^/]+)$/.exec(path);
		if (ptySessionMatch && method === "PUT") {
			const id = decodeURIComponent(ptySessionMatch[1] as string);
			const sessionId = decodeURIComponent(ptySessionMatch[2] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			if (!terminal) return json({ error: "no such terminal" }, 404);
			if (!terminal.sessionIds.includes(sessionId)) terminal.sessionIds.push(sessionId);
			return json({ ok: true });
		}
		if (ptySessionMatch && method === "DELETE") {
			const id = decodeURIComponent(ptySessionMatch[1] as string);
			const sessionId = decodeURIComponent(ptySessionMatch[2] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			if (!terminal) return json({ error: "no such terminal" }, 404);
			terminal.sessionIds = terminal.sessionIds.filter((candidate) => candidate !== sessionId);
			return json({ ok: true });
		}
		const ptyAuthorizationMatch = /^\/api\/ptys\/([^/]+)\/authorization$/.exec(path);
		if (ptyAuthorizationMatch && method === "GET") {
			const id = decodeURIComponent(ptyAuthorizationMatch[1] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			if (!terminal) return json({ error: "no such terminal" }, 404);
			if (terminal.authorizationPhase === "preparing" || terminal.authorizationPhase === "waiting") {
				return json({ phase: terminal.authorizationPhase, authorization: terminal.authorization });
			}
			return json({ phase: "ended", authorization: null });
		}
		const ptyRejectMatch = /^\/api\/ptys\/([^/]+)\/authorization\/reject$/.exec(path);
		if (ptyRejectMatch && method === "POST") {
			const id = decodeURIComponent(ptyRejectMatch[1] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			if (!terminal) return json({ error: "no such terminal" }, 404);
			terminal.authorizationPhase = "ended";
			terminal.authorization = null;
			terminal.state = "exited";
			terminal.exitCode = -1;
			terminal.endedAt = new Date().toISOString();
			return json({ ok: true });
		}
		const ptyApprovalMatch = /^\/api\/ptys\/([^/]+)\/approval\/([^/]+)$/.exec(path);
		if (ptyApprovalMatch && method === "POST") {
			const id = decodeURIComponent(ptyApprovalMatch[1] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			if (!terminal) return json({ error: "no such terminal" }, 404);
			terminal.approval = null;
			return json({ ok: true });
		}
		const ptyMatch = /^\/api\/ptys\/([^/]+)$/.exec(path);
		if (ptyMatch && method === "GET") {
			const id = decodeURIComponent(ptyMatch[1] as string);
			const terminal = state.ptys.find((candidate) => candidate.id === id);
			return terminal ? json({ terminal }) : json({ error: "no such terminal" }, 404);
		}
		if (ptyMatch && method === "DELETE") {
			const id = decodeURIComponent(ptyMatch[1] as string);
			state.ptys = state.ptys.filter((candidate) => candidate.id !== id);
			return json({ ok: true });
		}

		// --- API tokens ----------------------------------------------------
		if (path === "/api/api-tokens" && method === "GET") return json({ tokens: state.tokens });
		if (path === "/api/api-tokens" && method === "POST") {
			const input = body as { name: string; rulePreset: string; days: number | null };
			const apiToken: ApiTokenView = {
				id: `token-${state.tokens.length + 1}`,
				name: input.name,
				userId: state.user.id,
				createdAt: new Date().toISOString(),
				expiresAt: input.days === null ? null : new Date(Date.now() + input.days * 86_400_000).toISOString(),
				revokedAt: null,
				lastUsedAt: null,
				rules: {
					scope: { type: "api_token", id: `token-${state.tokens.length + 1}` },
					rulePreset: input.rulePreset as "ask" | "auto_review" | "yolo",
					rules: [],
					default: "require-approval",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				refs: {},
			};
			state.tokens.push(apiToken);
			return json({ token: "crh_created_once", apiToken });
		}
		const tokenRevoke = /^\/api\/api-tokens\/([^/]+)\/revoke$/.exec(path);
		if (tokenRevoke && method === "POST") {
			const id = decodeURIComponent(tokenRevoke[1] as string);
			const token = state.tokens.find((candidate) => candidate.id === id);
			if (token) token.revokedAt = "2026-01-02T00:00:00.000Z";
			return json({ apiToken: token });
		}
		const tokenRules = /^\/api\/api-tokens\/([^/]+)\/rules$/.exec(path);
		if (tokenRules && method === "PUT") {
			const id = decodeURIComponent(tokenRules[1] as string);
			const token = state.tokens.find((candidate) => candidate.id === id);
			if (token) {
				const patch = body as { rulePreset?: string; rules?: unknown[] };
				if (patch.rulePreset !== undefined && token.rules) token.rules.rulePreset = patch.rulePreset as never;
				if (patch.rules !== undefined && token.rules) token.rules.rules = patch.rules as never;
			}
			return json({ apiToken: token });
		}
		const tokenDelete = /^\/api\/api-tokens\/([^/]+)$/.exec(path);
		if (tokenDelete && method === "DELETE") {
			const id = decodeURIComponent(tokenDelete[1] as string);
			state.tokens = state.tokens.filter((candidate) => candidate.id !== id);
			return json({ ok: true });
		}

		// --- node files (doc/design/webui.md "Node pages") ------------------
		const nodeFilesMatch = /^\/api\/nodes\/([^/]+)\/files$/.exec(path);
		if (nodeFilesMatch && method === "GET") {
			const nodeId = decodeURIComponent(nodeFilesMatch[1] as string);
			const listed = url.searchParams.get("path") ?? "/";
			return json({
				path: listed,
				entries: state.nodeFiles[`${nodeId}:${listed}`] ?? [],
				truncated: false,
			});
		}

		// --- libraries -----------------------------------------------------
		if (path === "/api/libraries" && method === "GET") return json({ libraries: state.libraries });
		const libraryMatch = /^\/api\/libraries\/([^/]+)(?:\/(files|stat|file|move|limits))?$/.exec(path);
		if (libraryMatch) {
			const ref = decodeURIComponent(libraryMatch[1] as string);
			const library = state.libraries.find((candidate) => candidate.ref === ref);
			const part = libraryMatch[2];
			if (!library) return json({ error: "no such library" }, 404);
			const files = state.libraryFiles[ref] ?? [];
			if (part === undefined && method === "GET") return json({ library });
			if (part === "files" && method === "GET") {
				const prefix = url.searchParams.get("prefix") ?? "";
				const under = files.filter((file) => prefix === "" || file.path.startsWith(`${prefix}/`));
				const direct: LibraryFile[] = [];
				const directories = new Set<string>();
				for (const file of under) {
					const rest = prefix === "" ? file.path : file.path.slice(prefix.length + 1);
					const slash = rest.indexOf("/");
					if (slash === -1) direct.push(file);
					else directories.add(rest.slice(0, slash));
				}
				return json({ prefix, files: direct, directories: [...directories].sort() });
			}
			if (part === "stat" && method === "GET") {
				const file = files.find((candidate) => candidate.path === url.searchParams.get("path"));
				return file ? json({ file }) : json({ error: "no such library file" }, 404);
			}
			if (part === "file" && method === "GET") {
				const file = files.find((candidate) => candidate.path === url.searchParams.get("path"));
				if (!file) return json({ error: "no such library file" }, 404);
				const bytes =
					file.mediaType === "image/png"
						? Buffer.from(
								"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY1Z3wAAAABJRU5ErkJggg==",
								"base64",
							)
						: Buffer.from(file.path);
				return route.fulfill({
					status: 200,
					headers: {
						"content-type": file.mediaType,
						"content-length": String(bytes.length),
						"content-disposition":
							url.searchParams.get("preview") === "1" && file.mediaType.startsWith("image/") ? "inline" : "attachment",
						"x-content-type-options": "nosniff",
					},
					body: bytes,
				});
			}
			if (part === "file" && method === "PUT") {
				const requestedPath = url.searchParams.get("path") ?? "";
				const refused = state.libraryUploadErrors[requestedPath];
				if (refused !== undefined) return json({ error: refused }, 400);
				let filePath = requestedPath;
				if (url.searchParams.get("rename") === "1") {
					for (let index = 1; files.some((candidate) => candidate.path === filePath); index++) {
						const slash = requestedPath.lastIndexOf("/");
						const directory = slash === -1 ? "" : requestedPath.slice(0, slash + 1);
						const name = requestedPath.slice(slash + 1);
						const dot = name.indexOf(".", 1);
						const base = dot === -1 ? name : name.slice(0, dot);
						const extension = dot === -1 ? "" : name.slice(dot);
						filePath = `${directory}${base} (${index})${extension}`;
					}
				}
				const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
				const file: LibraryFile = {
					path: filePath,
					size: bytes.length,
					sha256: "0".repeat(64),
					mediaType: filePath.endsWith(".png") ? "image/png" : "text/plain",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				};
				const previous = files.find((candidate) => candidate.path === filePath);
				state.libraryFiles[ref] = [...files.filter((candidate) => candidate.path !== filePath), file];
				library.usage.files += previous === undefined ? 1 : 0;
				library.usage.bytes += bytes.length - (previous?.size ?? 0);
				return json({ file }, 201);
			}
			if (part === "file" && method === "DELETE") {
				const filePath = url.searchParams.get("path");
				const file = files.find((candidate) => candidate.path === filePath);
				if (!file) return json({ error: "no such library file" }, 404);
				state.libraryFiles[ref] = files.filter((candidate) => candidate.path !== filePath);
				library.usage.files -= 1;
				library.usage.bytes -= file.size;
				return json({ ok: true });
			}
			if (part === "move" && method === "POST") {
				const input = body as { from: string; to: string };
				const file = files.find((candidate) => candidate.path === input.from);
				if (!file) return json({ error: "no such library file" }, 404);
				const moved = { ...file, path: input.to, updatedAt: "2026-01-02T00:00:00.000Z" };
				state.libraryFiles[ref] = [...files.filter((candidate) => candidate.path !== input.from), moved];
				return json({ file: moved });
			}
			if (part === "limits" && method === "PATCH") {
				Object.assign(library.limits, body as object);
				return json({ library });
			}
			return json({ error: "not found" }, 404);
		}

		// --- audit ---------------------------------------------------------
		if (path === "/api/audit" && method === "GET") {
			const action = url.searchParams.get("action");
			const targetType = url.searchParams.get("targetType");
			const targetId = url.searchParams.get("targetId");
			const matches = state.audit.filter((event) => {
				if (action !== null) {
					if (action.endsWith(".") ? !event.action.startsWith(action) : event.action !== action) return false;
				}
				if (targetType !== null && event.targetType !== targetType) return false;
				if (targetId !== null && event.targetId !== targetId) return false;
				return true;
			});
			const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
			const limit = 50;
			return json({
				items: matches.slice(start, start + limit),
				nextCursor: start + limit < matches.length ? String(start + limit) : null,
			});
		}

		// --- users and groups ----------------------------------------------
		if (path === "/api/users" && method === "GET") return json({ users: state.users });
		if (path === "/api/users" && method === "POST") {
			const input = body as { username: string; displayName?: string; kind: User["kind"] };
			const user: User = {
				id: `user-${state.users.length + 2}`,
				username: input.username,
				displayName: input.displayName ?? input.username,
				email: null,
				kind: input.kind,
				status: "active",
				createdAt: "2026-01-01T00:00:00.000Z",
			};
			state.users.push(user);
			state.directory.users.push({ id: user.id, username: user.username, displayName: user.displayName });
			return json({ user });
		}
		const userPassword = /^\/api\/users\/([^/]+)\/password$/.exec(path);
		if (userPassword && method === "POST") return json({ ok: true });
		const userMatch = /^\/api\/users\/([^/]+)$/.exec(path);
		if (userMatch && method === "GET") {
			const id = decodeURIComponent(userMatch[1] as string);
			const user = state.users.find((candidate) => candidate.id === id);
			if (!user) return json({ error: "no such user" }, 404);
			const userGroups = state.userGroups
				.filter((group) => group.memberIds.includes(id))
				.map((group) => ({ id: group.id, name: group.name }));
			return json({ user, userGroups });
		}
		if (userMatch && method === "PATCH") {
			const id = decodeURIComponent(userMatch[1] as string);
			const user = state.users.find((candidate) => candidate.id === id);
			if (user) {
				Object.assign(user, body as Partial<User>);
				const named = state.directory.users.find((candidate) => candidate.id === id);
				if (named) Object.assign(named, { username: user.username, displayName: user.displayName });
			}
			return json({ user });
		}
		if (path === "/api/user-groups" && method === "GET") return json({ groups: state.userGroups });
		if (path === "/api/user-groups" && method === "POST") {
			const group: UserGroup = {
				id: `group-${state.userGroups.length + 1}`,
				name: (body as { name: string }).name,
				source: "local",
				createdAt: "2026-01-01T00:00:00.000Z",
				memberIds: [],
			};
			state.userGroups.push(group);
			return json({ group });
		}
		const groupMember = /^\/api\/user-groups\/([^/]+)\/members\/([^/]+)$/.exec(path);
		if (groupMember && (method === "PUT" || method === "DELETE")) {
			const groupId = decodeURIComponent(groupMember[1] as string);
			const userId = decodeURIComponent(groupMember[2] as string);
			const group = state.userGroups.find((candidate) => candidate.id === groupId);
			if (group) {
				group.memberIds =
					method === "PUT" ? [...new Set([...group.memberIds, userId])] : group.memberIds.filter((id) => id !== userId);
			}
			return json({ ok: true });
		}
		const userGroupMatch = /^\/api\/user-groups\/([^/]+)$/.exec(path);
		if (userGroupMatch && method === "GET") {
			const id = decodeURIComponent(userGroupMatch[1] as string);
			const group = state.userGroups.find((candidate) => candidate.id === id);
			if (!group) return json({ error: "no such user group" }, 404);
			return json({
				group: {
					id: group.id,
					name: group.name,
					createdAt: group.createdAt,
					members: state.users
						.filter((user) => group.memberIds.includes(user.id))
						.map((user) => ({ id: user.id, username: user.username, displayName: user.displayName })),
				},
			});
		}
		if (userGroupMatch && method === "PATCH") {
			const id = decodeURIComponent(userGroupMatch[1] as string);
			const group = state.userGroups.find((candidate) => candidate.id === id);
			if (group) group.name = (body as { name: string }).name;
			return json({ group });
		}
		if (userGroupMatch && method === "DELETE") {
			const id = decodeURIComponent(userGroupMatch[1] as string);
			state.userGroups = state.userGroups.filter((candidate) => candidate.id !== id);
			return json({ ok: true });
		}

		// --- model providers and settings ----------------------------------
		if (path === "/api/model-providers" && method === "GET") {
			return json({ providers: state.providers, builtin: state.builtinProviders });
		}
		const providerMatch = /^\/api\/model-providers\/([^/]+)$/.exec(path);
		if (providerMatch) {
			const providerId = decodeURIComponent(providerMatch[1] as string);
			if (method === "PUT") {
				const input = body as ModelProviderInput & { apiKey?: string | null };
				const existing = state.providers.find((candidate) => candidate.providerId === providerId);
				const apiKey = input.apiKey;
				const provider: ModelProviderView = {
					id: existing?.id ?? `provider-${state.providers.length + 1}`,
					providerId,
					kind: input.kind,
					builtin: input.kind === "builtin" ? providerId : null,
					name: input.name?.trim() || existing?.name || providerId,
					baseUrl: input.baseUrl ?? null,
					hasApiKey:
						apiKey === null
							? false
							: typeof apiKey === "string" && apiKey !== ""
								? true
								: (existing?.hasApiKey ?? false),
					models: input.kind === "custom" ? (input.models ?? existing?.models ?? []) : null,
					headers:
						input.kind === "custom"
							? input.headers !== undefined
								? input.headers
								: (existing?.headers ?? null)
							: null,
					sessionId:
						input.kind === "custom"
							? input.sessionId !== undefined
								? input.sessionId
								: (existing?.sessionId ?? null)
							: null,
					enabled: input.enabled ?? existing?.enabled ?? true,
				};
				state.providers = [...state.providers.filter((candidate) => candidate.providerId !== providerId), provider];
				// Saving a provider refreshes the available models, as the real server does (`models.reload()`).
				state.models = [
					...state.models.filter((model) => model.provider !== providerId),
					...(provider.models ?? []).map(
						(model): AvailableModel => ({
							provider: providerId,
							providerName: provider.name,
							modelId: model.id,
							name: model.name ?? model.id,
							contextWindow: model.contextWindow,
							thinkingLevels: model.thinking ? ["off", "low", "medium", "high"] : ["off"],
							input: model.input,
						}),
					),
				];
				return json({ provider });
			}
			if (method === "DELETE") {
				state.providers = state.providers.filter((candidate) => candidate.providerId !== providerId);
				state.models = state.models.filter((model) => model.provider !== providerId);
				return json({ ok: true });
			}
		}
		const discoverMatch = /^\/api\/model-providers\/([^/]+)\/discover$/.exec(path);
		if (discoverMatch) {
			const providerId = decodeURIComponent(discoverMatch[1] as string);
			const existing = state.providers.find((candidate) => candidate.providerId === providerId);
			if (!existing) return json({ error: "no such model provider" }, 404);
			if (method === "GET") {
				const configured = new Set((existing.models ?? []).map((model) => model.id));
				return json({ models: (state.discoveredModels[providerId] ?? []).filter((id) => !configured.has(id)) });
			}
			if (method === "POST") {
				const ids = (body as { ids: string[] }).ids;
				const added: CustomModel[] = ids.map((id) => ({
					id,
					api: "openai-completions",
					contextWindow: 32_768,
					maxTokens: 4_096,
					input: ["text"],
				}));
				const provider: ModelProviderView = { ...existing, models: [...(existing.models ?? []), ...added] };
				state.providers = state.providers.map((candidate) =>
					candidate.providerId === providerId ? provider : candidate,
				);
				state.models = [
					...state.models.filter((model) => model.provider !== providerId),
					...(provider.models ?? []).map(
						(model): AvailableModel => ({
							provider: providerId,
							providerName: provider.name,
							modelId: model.id,
							name: model.name ?? model.id,
							contextWindow: model.contextWindow,
							thinkingLevels: model.thinking ? ["off", "low", "medium", "high"] : ["off"],
							input: model.input,
						}),
					),
				];
				return json({ provider });
			}
		}
		if (path === "/api/model-presets" && method === "GET") return json({ presets: state.presets });
		if (path.startsWith("/api/model-presets/") && method === "PUT") {
			const kind = path.slice("/api/model-presets/".length) as ModelPresetKind;
			const input = body as ModelPresetInput;
			const existing = state.presets.find((preset) => preset.kind === kind);
			if (!existing) return json({ error: "not found" }, 404);
			const prompt =
				input.systemPrompt === undefined
					? existing.systemPrompt
					: input.systemPrompt?.trim()
						? input.systemPrompt
						: null;
			const preset: ModelPreset = {
				...existing,
				...(input.model !== undefined ? { model: input.model } : {}),
				systemPrompt: prompt,
			};
			state.presets = state.presets.map((candidate) => (candidate.kind === kind ? preset : candidate));
			return json({ preset });
		}

		// --- signing credentials and authorizations --------------------------------
		if (path === "/api/me/signing-credentials" && method === "GET")
			return json({ signingCredentials: state.signingCredentials });
		if (path === "/api/me/signing-credentials/ssh/challenge" && method === "POST") {
			// The signature proves possession; the mock accepts any base64 and reads the key from it.
			const challenge = Buffer.from("crh-register-v1\nuser:user-1\nserver:mock\nnonce:AAECAwQ\n").toString("base64url");
			return json({ challenge, expiresAt: "2026-01-01T00:10:00.000Z" });
		}
		if (path === "/api/me/signing-credentials/ssh" && method === "POST") {
			const input = body as { signature: string; name?: string };
			const credential: SigningCredentialView = {
				id: `signing-credential-${state.signingCredentials.length + 1}`,
				kind: "ssh",
				name: input.name ?? "ssh key",
				createdAt: "2026-01-01T00:00:00.000Z",
				publicKey: "ssh-ed25519 AAAAlaptop laptop",
				fingerprint: "SHA256:user",
				credentialId: null,
				rpId: null,
				origins: [],
			};
			state.signingCredentials.push(credential);
			return json({ signingCredential: credential }, 201);
		}
		const credentialDelete = /^\/api\/me\/signing-credentials\/([^/]+)$/.exec(path);
		if (credentialDelete && method === "DELETE") {
			const id = decodeURIComponent(credentialDelete[1] as string);
			state.signingCredentials = state.signingCredentials.filter((candidate) => candidate.id !== id);
			return json({ ok: true });
		}
		if (path === "/api/authorizations" && method === "GET") {
			return json({ items: state.authorizations, nextCursor: null });
		}

		if (path === "/api/sessions/search" && method === "GET") {
			const scope = url.searchParams.get("scope") ?? "mine";
			const keywords = (url.searchParams.get("q") ?? "")
				.toLowerCase()
				.split(/\s+/)
				.filter((keyword) => keyword !== "");
			const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
			const limit = 20;
			const visible = state.sessions.filter((item) => {
				if (scope === "mine" && item.ownerUserId !== state.user.id) return false;
				if (scope === "shared" && !item.shared) return false;
				if (scope === "visible" && item.ownerUserId !== state.user.id && !item.shared) return false;
				const title = (item.title ?? "").toLowerCase();
				return keywords.every((keyword) => title.includes(keyword));
			});
			const items = visible.slice(start, start + limit).map((item) => ({
				...item,
				titleMatch: true,
				hitCount: 0,
				hits: [],
			}));
			return json({
				items,
				nextCursor: start + limit < visible.length ? String(start + limit) : null,
				// The fake server follows SQLite: titles only.
				contentSearch: false,
			});
		}

		if (path === "/api/sessions" && method === "GET") {
			const scope = url.searchParams.get("scope") ?? "mine";
			const q = (url.searchParams.get("q") ?? "").toLowerCase();
			const ownerId = url.searchParams.get("ownerId");
			const ids = url.searchParams.get("ids")?.split(",");
			const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
			const limit = 20;
			const visible = state.sessions.filter((item) => {
				if (scope === "mine" && item.ownerUserId !== state.user.id) return false;
				if (scope === "shared" && !item.shared) return false;
				if (scope === "visible" && item.ownerUserId !== state.user.id && !item.shared) return false;
				if (ownerId !== null && item.ownerUserId !== ownerId) return false;
				if (ids !== undefined && !ids.includes(item.id)) return false;
				if (q !== "" && !(item.title ?? "").toLowerCase().includes(q)) return false;
				return true;
			});
			const items = visible.slice(start, start + limit);
			return json({
				items,
				nextCursor: ids === undefined && start + limit < visible.length ? String(start + limit) : null,
			});
		}

		// The draft's list before a session exists (doc/design/extensions.md "Extensions"): every entry on.
		if (path === "/api/sessions/extensions" && method === "GET") {
			return json({ extensions: state.availableExtensions.map((extension) => ({ ...extension, enabled: true })) });
		}

		if (path === "/api/sessions" && method === "POST") {
			const input = body as {
				message?: string;
				title?: string;
				model?: ModelRef;
				disabledExtensions?: string[];
			};
			let number = 1;
			while (state.details[`new-session-${number}`] !== undefined) number += 1;
			const id = `new-session-${number}`;
			const item = sessionListItem({
				id,
				title: input.title ?? null,
				ownerUserId: state.user.id,
				ownerName: state.user.displayName,
				updatedAt: new Date().toISOString(),
			});
			const disabled = input.disabledExtensions ?? [];
			const detail = sessionView(item, {
				...(input.model === undefined ? {} : { model: input.model }),
				extensions: state.availableExtensions.map((extension) => ({
					...extension,
					enabled: !disabled.includes(extension.name),
				})),
			});
			state.sessions.unshift(item);
			state.details[id] = detail;
			state.events[id] = snapshotEvent([userEntry(`${id}-u1`, input.message ?? "")], null);
			return json({ session: detail }, 201);
		}

		if (path === "/api/jobs" && method === "GET") {
			const session = url.searchParams.get("session") ?? "";
			const active = url.searchParams.get("active") === "true" || url.searchParams.get("active") === "1";
			const items = (state.jobs[session] ?? []).filter((job) => !active || job.state !== "settled");
			return json({ items, nextCursor: null });
		}

		const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
		if (jobMatch && method === "GET") {
			const id = decodeURIComponent(jobMatch[1] as string);
			const job = Object.values(state.jobs)
				.flat()
				.find((candidate) => candidate.id === id);
			return job === undefined ? json({ error: "no such job" }, 404) : json({ job });
		}

		const jobCancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
		if (jobCancelMatch && method === "POST") {
			const id = decodeURIComponent(jobCancelMatch[1] as string);
			for (const jobs of Object.values(state.jobs)) {
				const index = jobs.findIndex((job) => job.id === id);
				if (index < 0) continue;
				const job = jobs[index] as JobView;
				const settled: JobView = {
					...job,
					state: "settled",
					wait: null,
					outcome: { kind: "cancelled", failed: false },
					settledAt: new Date().toISOString(),
				};
				jobs[index] = settled;
				return json({ cancelled: true, job: settled });
			}
			return json({ error: "no such job" }, 404);
		}

		const forkMatch = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path);
		if (forkMatch && method === "POST") {
			const sourceId = decodeURIComponent(forkMatch[1] as string);
			const sourceItem = state.sessions.find((candidate) => candidate.id === sourceId);
			const source = state.details[sourceId] ?? (sourceItem ? sessionView(sourceItem) : undefined);
			if (!source) return json({ error: "no such session" }, 404);
			const input = body as { entryId?: number; requestId?: string };
			let forkNumber = 1;
			while (state.details[`fork-${forkNumber}`] !== undefined) forkNumber += 1;
			const id = `fork-${forkNumber}`;
			const sourceTitle = source.title ?? "New session";
			const item = sessionListItem({
				id,
				title: `${sourceTitle} (fork)`,
				ownerUserId: state.user.id,
				ownerName: state.user.displayName,
				updatedAt: new Date().toISOString(),
			});
			const detail = sessionView(item, {
				forkedFrom: { sessionId: sourceId, title: sourceTitle, entryId: input.entryId ?? 0 },
			});
			state.sessions.unshift(item);
			state.details[id] = detail;
			state.events[id] = snapshotEvent([], null);
			return json({ session: detail }, 201);
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
			const { disabledExtensions, ...patch } = body as Partial<SessionView> & {
				quota?: number | null;
				disabledExtensions?: string[];
			};
			const next: SessionView = {
				...detail,
				...patch,
				...(disabledExtensions !== undefined && detail.extensions !== undefined
					? {
							extensions: detail.extensions.map((extension) => ({
								...extension,
								enabled: !disabledExtensions.includes(extension.name),
							})),
						}
					: {}),
				updatedAt: new Date().toISOString(),
			};
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

		if (path === "/api/tasks" && method === "GET") {
			const userId = url.searchParams.get("userId");
			const items = userId === null ? state.tasks : state.tasks.filter((task) => task.onBehalfOfUserId === userId);
			return json({ items, nextCursor: null });
		}
		const taskWaitMatch = /^\/api\/tasks\/([^/]+)\/wait$/.exec(path);
		if (taskWaitMatch && method === "GET") {
			const id = decodeURIComponent(taskWaitMatch[1] as string);
			const task = state.tasks.find((candidate) => candidate.id === id);
			if (!task) return json({ error: "no such task" }, 404);
			const request =
				task.state === "awaiting_approval"
					? approvalRequestForTask(task, {
							nodeName: state.nodes.find((node) => node.id === task.nodeId)?.name,
							username: state.user.username,
						})
					: null;
			return json({ task, request });
		}
		const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
		if (taskMatch && method === "GET") {
			const id = decodeURIComponent(taskMatch[1] as string);
			const task = state.tasks.find((candidate) => candidate.id === id);
			if (!task) return json({ error: "no such task" }, 404);
			const request =
				task.state === "awaiting_approval"
					? approvalRequestForTask(task, {
							nodeName: state.nodes.find((node) => node.id === task.nodeId)?.name,
							username: state.user.username,
						})
					: null;
			return json({ task, request });
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
			// The fake server never plans options: a request that still waits is `preparing`, anything else `ended`.
			const id = decodeURIComponent(authorizationMatch[2] as string);
			const group = state.taskGroups[id]?.taskGroup;
			const waiting =
				authorizationMatch[1] === "tasks"
					? state.tasks.some((task) => task.id === id && task.state === "awaiting_authorization")
					: group?.state === "awaiting_authorization" ||
						group?.tasks.some((task) => task.state === "awaiting_authorization") === true;
			return authorizationMatch[1] === "tasks"
				? json({ phase: waiting ? "preparing" : "ended", authorization: null })
				: json({ phase: waiting ? "preparing" : "ended", taskGroup: null });
		}
		const rejectionMatch = /^\/api\/(tasks|task-groups)\/([^/]+)\/authorization\/reject$/.exec(path);
		if (rejectionMatch && method === "POST") {
			const id = decodeURIComponent(rejectionMatch[2] as string);
			state.approvals = {
				...state.approvals,
				authorizations: {
					tasks: state.approvals.authorizations.tasks.filter((task) => task.id !== id),
					taskGroups: state.approvals.authorizations.taskGroups.filter((group) => group.id !== id),
				},
			};
			return json({ ok: true });
		}
		if (path === "/api/authorizations" && method === "POST") {
			return json({ authorization: { id: "auth-1", dispatched: [] } });
		}

		if (path === "/api/task-groups" && method === "POST") {
			const input = body as { targets: string[]; parallel?: number };
			const refs: string[] = [];
			const ids = new Set<string>();
			const refMap: RefMap = {};
			const addNodes = (nodes: PublicNode[]) => {
				for (const node of nodes) ids.add(node.id);
			};
			for (const target of input.targets) {
				if (target === "_all") {
					refs.push("_all");
					addNodes(state.nodes.filter((node) => node.status === "active"));
					continue;
				}
				const node = state.nodes.find(
					(candidate) => candidate.id === target || candidate.name.toLowerCase() === target.toLowerCase(),
				);
				if (node) {
					refs.push(node.id);
					refMap[node.id] = { kind: "node", name: node.name };
					ids.add(node.id);
					continue;
				}
				const nodeGroup = state.nodeGroups.find(
					(candidate) => candidate.id === target || candidate.name.toLowerCase() === target.toLowerCase(),
				);
				if (nodeGroup) {
					refs.push(nodeGroup.id);
					refMap[nodeGroup.id] = { kind: "node_group", name: nodeGroup.name };
					addNodes(state.nodes.filter((candidate) => nodeGroup.memberIds.includes(candidate.id)));
					continue;
				}
				refs.push(target);
			}
			const groupId = "group-1";
			const tasks = [...ids].map((nodeId, index) =>
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
				targets: refs,
				refs: refMap,
				nodeIds: [...ids],
				parallel: input.parallel ?? 10,
				failFast: false,
				outputMode: "status",
				nodeMaxLines: null,
				nodeMaxBytes: null,
				privileged: false,
				skipped: [],
				tasks,
				createdAt: "2026-01-01T00:00:00.000Z",
				finishedAt: null,
				summary: "batch run",
				action: { type: "exec", command: "batch run" },
				source: { type: "user", userId: state.user.id, username: state.user.username },
				outcome: null,
				kind: "exec",
				ruleChain: null,
				approval: null,
				actorType: "user",
				actorId: state.user.id,
				onBehalfOfUserId: state.user.id,
				operation: null,
				rootSessionId: null,
				handlerType: null,
				handlerSessionId: null,
				purpose: null,
				phase: "awaiting_user",
			};
			state.taskGroups[groupId] = { taskGroup: group, polls: 0 };
			return json({ taskGroup: group });
		}
		const groupWaitMatch = /^\/api\/task-groups\/([^/]+)\/wait$/.exec(path);
		const groupMatch = groupWaitMatch ?? /^\/api\/task-groups\/([^/]+)$/.exec(path);
		if (groupMatch && method === "GET") {
			const id = decodeURIComponent(groupMatch[1] as string);
			const stored = state.taskGroups[id];
			if (!stored) return json({ error: "no such task group" }, 404);
			stored.polls += 1;
			const request =
				stored.taskGroup.state === "awaiting_approval" ? approvalRequestForTaskGroup(stored.taskGroup) : null;
			if (stored.polls >= 2) {
				const finished: TaskGroupView = {
					...stored.taskGroup,
					state: "finished",
					finishedAt: "2026-01-01T00:01:00.000Z",
					tasks: stored.taskGroup.tasks.map((task, index) =>
						taskView({
							...task,
							state: "exited",
							exitCode: index === 0 ? 0 : 1,
							finishedAt: "2026-01-01T00:01:00.000Z",
						}),
					),
					outcome: { kind: "error", failed: true, errorCode: null, errorMessage: null },
				};
				stored.taskGroup = finished;
				return json({ taskGroup: finished, request: null });
			}
			return json({ taskGroup: stored.taskGroup, request });
		}
		const groupAuthMatch = /^\/api\/task-groups\/([^/]+)\/authorization$/.exec(path);
		if (groupAuthMatch) {
			const group = state.taskGroups[decodeURIComponent(groupAuthMatch[1] as string)]?.taskGroup;
			const waiting =
				group?.state === "awaiting_authorization" ||
				group?.tasks.some((task) => task.state === "awaiting_authorization") === true;
			return json({ phase: waiting ? "preparing" : "ended", taskGroup: null });
		}

		if (path === "/api/channels" && method === "GET") return json({ channels: state.channels });
		const channelMatch = /^\/api\/channels\/([^/]+)$/.exec(path);
		if (channelMatch && method === "PUT") {
			const name = decodeURIComponent(channelMatch[1] ?? "");
			const input = body as Record<string, unknown>;
			const existing = state.channels.find((channel) => channel.name === name);
			const kind = input.kind === "satori" ? "satori" : "telegram";
			const config = input.config as { url: string; platform: string; botId: string } | undefined;
			const channel: ChannelView = {
				id: existing?.id ?? `channel-${name}`,
				name,
				kind,
				enabled: input.enabled !== false,
				hasCredentials: existing?.hasCredentials === true || typeof input.token === "string",
				config: config ?? null,
				linkInstructions: typeof input.linkInstructions === "string" ? input.linkInstructions : null,
				status:
					existing?.status ??
					({
						state: "connected",
						lastError: null,
						nextAttemptAt: null,
						account: kind === "satori" ? null : "ops_bot",
						...(kind === "satori"
							? {
									logins: [
										{
											platform: config?.platform ?? "telegram",
											id: config?.botId ?? "",
											name: "ops_bot",
											online: true,
										},
									],
								}
							: {}),
					} satisfies ChannelView["status"]),
				createdAt: existing?.createdAt ?? "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			state.channels = existing
				? state.channels.map((row) => (row.name === name ? channel : row))
				: [...state.channels, channel];
			return json({ channel });
		}
		if (channelMatch && method === "DELETE") {
			const name = decodeURIComponent(channelMatch[1] ?? "");
			state.channels = state.channels.filter((channel) => channel.name !== name);
			return json({ ok: true });
		}
		if (path === "/api/channel-accounts" && method === "GET") return json(state.channelAccounts);
		if (path === "/api/channel-link-codes" && method === "POST") {
			return json({
				code: "ABCD2345",
				expiresAt: "2026-01-01T00:10:00.000Z",
				...(state.channelAccounts.channels[0] ? { channel: state.channelAccounts.channels[0] } : {}),
			});
		}
		if (path.startsWith("/api/channel-accounts/") && method === "DELETE") {
			const id = decodeURIComponent(path.slice("/api/channel-accounts/".length));
			state.channelAccounts = {
				...state.channelAccounts,
				accounts: state.channelAccounts.accounts.filter((account) => account.id !== id),
			};
			return json({ ok: true });
		}
		if (path === "/api/me/settings" && method === "GET") return json({ settings: state.userSettings });
		if (path === "/api/me/settings" && method === "PATCH") {
			const input = body as Partial<UserSettings>;
			state.userSettings = { ...state.userSettings, ...input };
			return json({ settings: state.userSettings });
		}

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
export async function openSession(page: Page, api: ApiMock, sessionId: string, events?: SessionEvent[]): Promise<void> {
	await page.locator(`[data-session-id="${sessionId}"]`).click();
	await api.waitForStream(`/api/sessions/${sessionId}/events`);
	await api.emit(`/api/sessions/${sessionId}/events`, "events", events ?? api.state.events[sessionId] ?? []);
}

export function emptyApprovals(): ApprovalList {
	return {
		tasks: [],
		taskGroups: [],
		externalCalls: [],
		ptys: [],
		authorizations: { tasks: [], taskGroups: [] },
		quotas: [],
		requests: [],
	};
}

/** The trust report a client node has pushed in the fake server. */
export function trustedNode(nodeId: string): NodeTrust {
	return {
		status: "ok",
		message: null,
		digest: "sha256:trust",
		updatedAt: "2026-01-01T00:00:00.000Z",
		stale: false,
		summary: {
			nodeId,
			aliases: [],
			clockSkewMs: 12,
			identities: {
				unprivileged: { uid: 1000, gid: 1000, user: "crha" },
				privileged: { uid: 0, gid: 0, user: "root" },
			},
			trust: [
				{
					name: "crhs",
					source: "local",
					role: "crhs",
					key: { kind: "sshsig", publicKey: "ssh-ed25519 AAAAcrhs crhs", fingerprint: "SHA256:crhs" },
					kinds: ["execute", "cosign"],
					requireSpec: true,
					requireTask: false,
					requireUv: false,
					maxTtlMs: 300_000,
					allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
					deny: [{ method: "file.write", match: "prefix", pattern: "/etc/crha/" }],
					envAllow: [],
				},
			],
			localWindow: { kind: "closed" },
		},
	};
}

export function scheduleView(overrides: Partial<ScheduleView> = {}): ScheduleView {
	return {
		id: "schedule-1",
		ownerUserId: USER.id,
		name: "Nightly check",
		prompt: "Check the nodes",
		model: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
		rulePreset: "ask",
		rules: [],
		refs: {},
		tokenBudget: null,
		cron: "0 9 * * *",
		timezone: "Europe/Berlin",
		catchUp: false,
		enabled: true,
		report: null,
		nextRunAt: "2026-02-01T09:00:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lastRun: null,
		inProgress: false,
		preview: [],
		previewError: null,
		...overrides,
	};
}

export function apiTokenView(overrides: Partial<ApiTokenView> = {}): ApiTokenView {
	return {
		id: "token-1",
		name: "laptop",
		userId: USER.id,
		createdAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2026-04-01T00:00:00.000Z",
		revokedAt: null,
		lastUsedAt: null,
		rules: null,
		refs: {},
		...overrides,
	};
}

export function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
	return {
		seq: 1,
		id: "evt-1",
		ts: "2026-01-01T00:00:00.000Z",
		actorType: "user",
		actorId: USER.id,
		source: { type: "user", userId: USER.id, username: USER.username },
		onBehalfOfUserId: null,
		action: "task.approval",
		targetType: "task",
		targetId: "task-1",
		detail: { decision: "approved" },
		...overrides,
	};
}

export function userGroup(overrides: Partial<UserGroup> = {}): UserGroup {
	return {
		id: "group-1",
		name: "Ops",
		source: "local",
		createdAt: "2026-01-01T00:00:00.000Z",
		memberIds: [],
		...overrides,
	};
}

export function providerView(overrides: Partial<ModelProviderView> = {}): ModelProviderView {
	return {
		id: "provider-1",
		providerId: "faux",
		kind: "builtin",
		builtin: "faux",
		name: "Faux",
		baseUrl: null,
		hasApiKey: false,
		models: null,
		headers: null,
		sessionId: null,
		enabled: true,
		...overrides,
	};
}

export function sshCredentialView(overrides: Partial<SshCredential> = {}): SshCredential {
	return {
		id: "cred-1",
		name: "laptop",
		publicKey: "ssh-ed25519 AAAAlaptop laptop",
		createdAt: "2026-01-01T00:00:00.000Z",
		usedBy: [],
		...overrides,
	};
}

export type { SessionEntry, SessionEvent };
