import { expect, type Page } from "@playwright/test";
import type { AgentEvent, EntryRecord as SessionEntry } from "../src/features/sessions/sessionState";
import type {
	ApiTokenView,
	ApprovalList,
	AuditEvent,
	AuthorizationSummary,
	AvailableModel,
	CredentialView,
	Directory,
	ModelPreset,
	ModelPresetInput,
	ModelPresetKind,
	ModelProviderInput,
	ModelProviderView,
	NodeAccessGrant,
	NodeGroup,
	NodeTrust,
	PublicNode,
	RefMap,
	ScheduleRunView,
	ScheduleView,
	SessionListItem,
	SessionView,
	SshCredential,
	TaskGroupView,
	TaskView,
	User,
	UserGroup,
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
		{
			sessionId: "s1",
			levelId: "root",
			title: "Nightly check",
			since: "2026-01-01T00:00:00Z",
			budgetRemaining: 0,
			budgetUsedTokens: 100,
		},
		{
			sessionId: "s2",
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
	events: Record<string, AgentEvent[]>;
	/** The older history page served for `?before=<historyCursor>`. */
	olderEntries: Record<string, { entries: SessionEntry[]; historyCursor: string | null }>;
	/** Child sessions by parent id (`GET /api/sessions/:id/children`). */
	children: Record<string, SessionListItem[]>;
	approvals: ApprovalList;
	tasks: TaskView[];
	nodes: PublicNode[];
	models: AvailableModel[];
	directory: Directory;
	taskGroups: Record<string, { taskGroup: TaskGroupView; polls: number }>;
	nodeGroups: NodeGroup[];
	nodeAccessGrants: NodeAccessGrant[];
	schedules: ScheduleView[];
	runs: Record<string, ScheduleRunView[]>;
	tokens: ApiTokenView[];
	providers: ModelProviderView[];
	builtinProviders: string[];
	presets: ModelPreset[];
	credentials: CredentialView[];
	audit: AuditEvent[];
	users: User[];
	userGroups: UserGroup[];
	sshCredentials: SshCredential[];
	authorizations: AuthorizationSummary[];
	nodeTrust: Record<string, NodeTrust>;
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
			default: "ask",
			updatedAt: item.updatedAt,
		},
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, configure: true, manageShares: true },
		ownerUsername: item.ownerName,
		state: item.state,
		waitingKind: item.waitingKind,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
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
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		notice: null,
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
		children: {},
		approvals: QUOTA_APPROVALS,
		tasks: [],
		nodes: [],
		models: [],
		directory: { users: [], userGroups: [] },
		taskGroups: {},
		nodeGroups: [],
		nodeAccessGrants: [],
		schedules: [],
		runs: {},
		tokens: [],
		providers: [],
		builtinProviders: ["faux"],
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
		credentials: [],
		audit: [],
		users: [],
		userGroups: [],
		sshCredentials: [],
		authorizations: [],
		nodeTrust: {},
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
		if (path === "/api/models") return json({ models: state.models });
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
							hops: [{ host: node.hostname ?? "target.example", port: 22, user: "deploy", hostKey: "SHA256:probe" }],
							credential: { id: "cred-1", name: "laptop" },
						}
					: null;
			// The SSH route and credential are administrator data (D108); a non-admin gets only the node.
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
			return json({ hop: 0, fingerprint: "SHA256:probe" });
		}
		if (path === "/api/ssh-nodes/test" && method === "POST") return json({ ok: true });
		if (path === "/api/ssh-nodes" && method === "POST") {
			const input = body as { host: string; port: number; user: string; name: string; hostKey: string };
			const node = nodeView({
				id: `ssh-node-${state.nodes.length + 1}`,
				name: input.name || input.host,
				transport: "ssh",
				hostname: input.host,
				connected: null,
				access: "admin",
			});
			state.nodes.push(node);
			return json({ node });
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
					default: "ask",
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
			return json({ user });
		}
		const userPassword = /^\/api\/users\/([^/]+)\/password$/.exec(path);
		if (userPassword && method === "POST") return json({ ok: true });
		const userMatch = /^\/api\/users\/([^/]+)$/.exec(path);
		if (userMatch && method === "PATCH") {
			const id = decodeURIComponent(userMatch[1] as string);
			const user = state.users.find((candidate) => candidate.id === id);
			if (user) Object.assign(user, body as Partial<User>);
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
					...(provider.models ?? []).map((model) => ({
						provider: providerId,
						modelId: model.id,
						name: model.name ?? model.id,
						contextWindow: model.contextWindow,
						thinkingLevels: model.thinking ? ["off", "low", "medium", "high"] : ["off"],
						input: model.input,
					})),
				];
				return json({ provider });
			}
			if (method === "DELETE") {
				state.providers = state.providers.filter((candidate) => candidate.providerId !== providerId);
				state.models = state.models.filter((model) => model.provider !== providerId);
				return json({ ok: true });
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

		// --- credentials and authorizations --------------------------------
		if (path === "/api/me/credentials" && method === "GET") return json({ credentials: state.credentials });
		if (path === "/api/me/credentials/ssh" && method === "POST") {
			const input = body as { publicKey: string; name?: string };
			const credential: CredentialView = {
				id: `credential-${state.credentials.length + 1}`,
				kind: "ssh",
				name: input.name ?? "ssh key",
				createdAt: "2026-01-01T00:00:00.000Z",
				publicKey: input.publicKey,
				fingerprint: "SHA256:user",
				credentialId: null,
				rpId: null,
				origins: [],
			};
			state.credentials.push(credential);
			return json({ credential });
		}
		const credentialDelete = /^\/api\/me\/credentials\/([^/]+)$/.exec(path);
		if (credentialDelete && method === "DELETE") {
			const id = decodeURIComponent(credentialDelete[1] as string);
			state.credentials = state.credentials.filter((candidate) => candidate.id !== id);
			return json({ ok: true });
		}
		if (path === "/api/authorizations" && method === "GET") {
			return json({ items: state.authorizations, nextCursor: null });
		}
		const authorizationRevoke = /^\/api\/authorizations\/([^/]+)\/revoke$/.exec(path);
		if (authorizationRevoke && method === "POST") {
			const id = decodeURIComponent(authorizationRevoke[1] as string);
			const entry = state.authorizations.find((candidate) => candidate.id === id);
			if (entry) entry.revokedAt = "2026-01-02T00:00:00.000Z";
			return json({ authorization: { id, revokedAt: "2026-01-02T00:00:00.000Z" } });
		}

		if (path === "/api/sessions" && method === "GET") {
			const scope = url.searchParams.get("scope") ?? "mine";
			const q = (url.searchParams.get("q") ?? "").toLowerCase();
			const start = Number(url.searchParams.get("cursor") ?? "0") || 0;
			const limit = 20;
			const visible = state.sessions.filter((item) => {
				if (scope === "mine" && item.ownerUserId !== state.user.id) return false;
				if (scope === "shared" && !item.shared) return false;
				if (scope === "visible" && item.ownerUserId !== state.user.id && !item.shared) return false;
				if (q !== "" && !item.title.toLowerCase().includes(q)) return false;
				return true;
			});
			const items = visible.slice(start, start + limit);
			return json({ items, nextCursor: start + limit < visible.length ? String(start + limit) : null });
		}

		const childrenMatch = /^\/api\/sessions\/([^/]+)\/children$/.exec(path);
		if (childrenMatch && method === "GET") {
			const id = decodeURIComponent(childrenMatch[1] as string);
			return json({ items: state.children[id] ?? [], nextCursor: null });
		}

		const childrenSummaryMatch = /^\/api\/sessions\/([^/]+)\/children\/summary$/.exec(path);
		if (childrenSummaryMatch && method === "GET") {
			const id = decodeURIComponent(childrenSummaryMatch[1] as string);
			const items = state.children[id] ?? [];
			const states = { idle: 0, running: 0, awaiting: 0 };
			for (const item of items) states[item.state] += 1;
			return json({ total: items.length, states });
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
		const taskWaitMatch = /^\/api\/tasks\/([^/]+)\/wait$/.exec(path);
		if (taskWaitMatch && method === "GET") {
			const id = decodeURIComponent(taskWaitMatch[1] as string);
			const task = state.tasks.find((candidate) => candidate.id === id);
			if (!task) return json({ error: "no such task" }, 404);
			return json({ task });
		}
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
			return authorizationMatch[1] === "tasks" ? json({ authorization: null }) : json({ taskGroup: null });
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
				privileged: false,
				skipped: [],
				tasks,
				createdAt: "2026-01-01T00:00:00.000Z",
				finishedAt: null,
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
				};
				stored.taskGroup = finished;
				return json({ taskGroup: finished });
			}
			return json({ taskGroup: stored.taskGroup });
		}
		const groupAuthMatch = /^\/api\/task-groups\/([^/]+)\/authorization$/.exec(path);
		if (groupAuthMatch) return json({ taskGroup: null });

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
			groups: [],
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
					key: { kind: "sshsig", fingerprint: "SHA256:crhs" },
					kinds: ["execute", "cosign"],
					requireExact: true,
					requireTask: false,
					requireUv: false,
					maxTtlMs: 300_000,
					allow: [{ method: "exec", match: "prefix", pattern: "systemctl restart " }],
					deny: [{ method: "file.write", match: "prefix", pattern: "/etc/crha/" }],
					envAllow: [],
				},
			],
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

export type { AgentEvent, SessionEntry };
