export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export type UserKind = "admin" | "member";
export interface User {
	id: string;
	username: string;
	displayName: string;
	email: string | null;
	kind: UserKind;
	status: "active" | "disabled";
	createdAt: string;
}
export interface UserGroup {
	id: string;
	name: string;
	source: "local";
	createdAt: string;
	memberIds: string[];
}
export type NodeAccess = "owner" | "admin" | "operate" | "view";
export interface PublicNode {
	id: string;
	name: string;
	transport: "client" | "ssh";
	status: "pending" | "active" | "disabled";
	hostname: string | null;
	ownerUserId: string;
	clientVersion: string | null;
	privilegedMode: string | null;
	lastSeenAt: string | null;
	createdAt: string;
	approvedAt: string | null;
	groups: string[];
	access: NodeAccess;
	facts: Record<string, unknown> | null;
	keyFingerprint: string | null;
	/** Whether crha is connected now; null for SSH nodes (they connect per task). */
	connected: boolean | null;
}
export type GranteeType = "user" | "user_group";
export type ShareAccess = "view" | "operate";
export interface NodeShare {
	id: string;
	nodeId: string;
	granteeType: GranteeType;
	granteeId: string;
	granteeName: string;
	access: ShareAccess;
	createdByUserId: string;
	createdAt: string;
}
export type SessionRelationship = "owner" | "admin" | "shared";
export interface SessionCapabilities {
	view: boolean;
	chat: boolean;
	manageShares: boolean;
	configure: boolean;
}
export interface SessionShare {
	id: string;
	sessionId: string;
	granteeType: GranteeType;
	granteeId: string;
	granteeName: string | null;
	access: "view" | "chat";
	createdByUserId: string;
	createdAt: string;
}
export type TaskState =
	| "awaiting_approval"
	| "awaiting_authorization"
	| "denied"
	| "exited"
	| "failed"
	| "rejected"
	| "unknown"
	| (string & {});
export type RuleAction = "allow" | "deny" | "require-approval";
export type RuleMethod = "exec" | "file.read" | "file.write";
export type Preset = "ask" | "auto_review" | "yolo";
export interface Rule {
	action: RuleAction;
	method?: RuleMethod;
	nodes?: string[];
	/** true only matches privileged tasks, false only ordinary ones; omitted matches both. */
	privileged?: boolean;
	exact?: string;
	prefix?: string;
}
export interface RuleRef {
	type: string;
	id: string;
}
export interface LevelResult {
	scope: RuleRef;
	own: RuleAction | "inherit";
	rule?: number;
	matched?: Rule;
	effective: RuleAction;
}
export interface Evaluation {
	result: RuleAction;
	levels: LevelResult[];
}
export interface ApprovalDecision {
	decision: "approved" | "rejected";
	by: { type: string; id: string; onBehalfOfUserId?: string };
	at: string;
	reason?: string;
	taskGroupId?: string;
}
export interface ApprovalRecord {
	evaluation: Evaluation;
	decision?: ApprovalDecision;
}
export interface GroupApprovalRecord {
	nodes: { nodeId: string; evaluation: Evaluation }[];
	decision?: ApprovalDecision;
}
export interface StoredRuleSet {
	scope: RuleRef;
	preset: Preset | null;
	rules: Rule[];
	default: string;
	updatedAt: string;
}
export interface ApiTokenView {
	id: string;
	name: string;
	userId: string;
	createdAt: string;
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
	rules: StoredRuleSet | null;
}
export interface AuditEvent {
	seq: number;
	id: string;
	ts: string;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	hash: string;
}
export interface AuditQuery {
	action?: string;
	targetType?: string;
	targetId?: string;
	beforeSeq?: number;
	limit?: number;
}
export type VerifyResult = { ok: true; count: number } | { ok: false; count: number; brokenAt: number; reason: string };
export interface TaskView {
	id: string;
	nodeId: string;
	kind: string;
	summary: string;
	/** What authorization rules match on: the rendered argv or the normalized path. */
	operation: Operation | null;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string | null;
	state: TaskState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	errorCode: string | null;
	errorMessage: string | null;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutHead: string;
	/** In text mode: the combined stdout/stderr tail; the other head/tail fields are empty. */
	stdoutTail: string;
	stderrHead: string;
	stderrTail: string;
	outputFile: string | null;
	/** full for a single task; text or status for a batch node (doc/execution-plane.md#输出). */
	outputMode: "full" | "text" | "status";
	/** Whether this is a privileged task (doc/privilege.md). */
	privileged: boolean;
	createdAt: string;
	finishedAt: string | null;
	taskGroupId?: string | null;
	ruleChain?: RuleRef[] | null;
	approval?: ApprovalRecord | null;
	rootSessionId?: string | null;
	handlerType?: "agent" | "user" | null;
	handlerSessionId?: string | null;
}
export interface Directory {
	users: { id: string; username: string; displayName: string }[];
	userGroups: { id: string; name: string }[];
}
export interface SshCredential {
	id: string;
	name: string;
	publicKey: string;
}
export interface SshHopInput {
	host: string;
	port?: number;
	user: string;
	hostKey?: string;
}
export interface SshTargetBody extends SshHopInput {
	credentialId: string;
	jumps?: SshHopInput[];
}
export interface TaskGroupView {
	id: string;
	state: "awaiting_approval" | "awaiting_authorization" | "running" | "finished" | "interrupted" | "rejected";
	targets: string[];
	nodeIds: string[];
	parallel: number;
	failFast: boolean;
	outputMode: "status" | "text";
	/** Whether the group's tasks are privileged tasks (doc/privilege.md). */
	privileged: boolean;
	skipped: string[];
	tasks: TaskView[];
	createdAt: string;
	finishedAt: string | null;
	summary?: string;
	kind?: string;
	ruleChain?: RuleRef[] | null;
	approval?: GroupApprovalRecord | null;
	actorType?: string;
	actorId?: string;
	onBehalfOfUserId?: string;
	operation?: Operation | null;
	rootSessionId?: string | null;
	handlerType?: "agent" | "user" | null;
	handlerSessionId?: string | null;
}

export interface Operation {
	method: RuleMethod;
	target: string;
}
export interface ApprovalBody {
	decision: "approve" | "reject";
	reason?: string;
	always?: Rule;
}
/** Body of POST /nodes/:id/tasks: `kind` plus the kind's fields. */
export type TaskRequest = {
	kind: string;
	timeoutMs?: number;
	waitMs?: number;
	/** Run as a privileged task (doc/privilege.md). */
	privileged?: boolean;
} & Record<string, unknown>;

/** How crhs reaches an SSH node (owner and administrators only). */
export interface SshNodeDetails {
	/** Jump hosts in order, then the node itself. */
	hops: { host: string; port: number; user: string; hostKey: string }[];
	credential: { id: string; name: string | null };
}

export interface ModelRef {
	provider: string;
	modelId: string;
}
export interface AvailableModel extends ModelRef {
	name: string;
	contextWindow: number;
}
export interface CompatibleModel {
	id: string;
	name?: string;
	contextWindow: number;
	maxTokens: number;
	reasoning?: boolean;
}
export interface ModelProviderView {
	id: string;
	providerId: string;
	kind: "builtin" | "openai-compatible";
	builtin: string | null;
	name: string;
	baseUrl: string | null;
	hasApiKey: boolean;
	models: CompatibleModel[] | null;
	headers: Record<string, string> | null;
	enabled: boolean;
}
export interface ModelProviderInput {
	kind: "builtin" | "openai-compatible";
	name?: string;
	baseUrl?: string | null;
	/** Omitted: keep the current key; null: remove it. */
	apiKey?: string | null;
	models?: CompatibleModel[];
	/** Extra request headers (openai-compatible); null removes them. */
	headers?: Record<string, string> | null;
	enabled?: boolean;
}
export interface SessionView {
	id: string;
	title: string;
	ownerUserId: string;
	parentSessionId: string | null;
	model: ModelRef & { thinkingLevel?: string };
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	rules: StoredRuleSet | null;
	/** How the caller relates to the session; display only, authorization uses `capabilities`. */
	relationship: SessionRelationship;
	/** Effective capabilities of the caller on this session. */
	capabilities: SessionCapabilities;
	ownerUsername: string | null;
	/** Subagent state: active, awaiting, stopped (roots stay active). */
	state: "active" | "awaiting" | "stopped";
	/** Remaining token quota (null: unlimited; negative after an overspending response). */
	quota: number | null;
	/** Tokens spent by the session and its subagents. */
	spentTokens: number;
}
export interface SessionPatch {
	title?: string;
	model?: ModelRef;
	preset?: Preset;
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
	onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const init: RequestInit = { method, credentials: "same-origin", signal };
	// The CSRF guard needs a JSON content type on every non-GET request.
	if (method !== "GET") init.headers = { "content-type": "application/json" };
	if (method !== "GET") init.body = JSON.stringify(body ?? {});
	const res = await fetch(`/api${path}`, init);
	let data: unknown;
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) {
		const message = (data as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
		if (res.status === 401 && path !== "/auth/login") onUnauthorized();
		throw new ApiError(res.status, message);
	}
	return data as T;
}

const enc = encodeURIComponent;

export const api = {
	login: (username: string, password: string) =>
		request<{ user: User }>("POST", "/auth/login", { username, password }).then((r) => r.user),
	logout: () => request<{ ok: true }>("POST", "/auth/logout"),
	me: () => request<{ user: User }>("GET", "/me").then((r) => r.user),

	listNodes: () => request<{ nodes: PublicNode[] }>("GET", "/nodes").then((r) => r.nodes),
	getNode: (id: string) =>
		request<{ node: PublicNode; shares?: NodeShare[]; ssh?: SshNodeDetails | null }>("GET", `/nodes/${enc(id)}`),
	approveNode: (id: string) => request<{ node: PublicNode }>("POST", `/nodes/${enc(id)}/approve`),
	deleteNode: (id: string) => request<{ ok: true }>("DELETE", `/nodes/${enc(id)}`),
	renameNode: (id: string, name: string) => request<{ node: PublicNode }>("PATCH", `/nodes/${enc(id)}`, { name }),
	shareNode: (id: string, granteeType: GranteeType, granteeId: string, access: ShareAccess) =>
		request<{ share: NodeShare }>("PUT", `/nodes/${enc(id)}/shares`, { granteeType, granteeId, access }),
	unshareNode: (id: string, shareId: string) =>
		request<{ ok: true }>("DELETE", `/nodes/${enc(id)}/shares/${enc(shareId)}`),
	createEnrollmentToken: (nameHint?: string) =>
		request<{ token: string; expiresAt: string }>("POST", "/enrollment-tokens", nameHint ? { nameHint } : {}),

	listNodeTasks: (id: string) => request<{ tasks: TaskView[] }>("GET", `/nodes/${enc(id)}/tasks`).then((r) => r.tasks),
	createTask: (nodeId: string, body: TaskRequest) =>
		request<{ task: TaskView }>("POST", `/nodes/${enc(nodeId)}/tasks`, body).then((r) => r.task),
	getTask: (id: string) => request<{ task: TaskView }>("GET", `/tasks/${enc(id)}`).then((r) => r.task),
	waitTask: (id: string, timeoutMs: number, signal?: AbortSignal) =>
		request<{ task: TaskView }>("GET", `/tasks/${enc(id)}/wait?timeoutMs=${timeoutMs}`, undefined, signal).then(
			(r) => r.task,
		),
	cancelTask: (id: string) => request<{ cancelled: boolean }>("POST", `/tasks/${enc(id)}/cancel`),

	changePassword: (currentPassword: string, newPassword: string) =>
		request<{ ok: true }>("POST", "/auth/password", { currentPassword, newPassword }),
	directory: () => request<Directory>("GET", "/directory"),

	createTaskGroup: (
		body: TaskRequest & { targets: string[]; parallel?: number; failFast?: boolean; outputMode?: "status" | "text" },
	) => request<{ group: TaskGroupView }>("POST", "/task-groups", body).then((r) => r.group),
	waitTaskGroup: (id: string, timeoutMs: number, signal?: AbortSignal) =>
		request<{ group: TaskGroupView }>(
			"GET",
			`/task-groups/${enc(id)}/wait?timeoutMs=${timeoutMs}`,
			undefined,
			signal,
		).then((r) => r.group),

	listSshCredentials: () =>
		request<{ credentials: SshCredential[] }>("GET", "/ssh-credentials").then((r) => r.credentials),
	createSshCredential: (name: string) =>
		request<{ credential: SshCredential }>("POST", "/ssh-credentials", { name }).then((r) => r.credential),
	probeSshHost: (body: SshTargetBody) =>
		request<{ hop: number; fingerprint: string }>("POST", "/ssh-nodes/probe", body),
	createSshNode: (body: SshTargetBody & { name: string; groups: string[] }) =>
		request<{ node: PublicNode }>("POST", "/ssh-nodes", body).then((r) => r.node),
	testSshRoute: (body: SshTargetBody) => request<{ ok: true }>("POST", "/ssh-nodes/test", body),
	testSshNode: (id: string) => request<{ ok: true }>("POST", `/nodes/${enc(id)}/ssh-test`),
	setNodeGroups: (id: string, groups: string[]) =>
		request<{ groups: string[] }>("PUT", `/nodes/${enc(id)}/groups`, { groups }).then((r) => r.groups),

	listApiTokens: () => request<{ tokens: ApiTokenView[] }>("GET", "/api-tokens").then((r) => r.tokens),
	createApiToken: (body: { name: string; preset: Preset; days: number | null }) =>
		request<{ token: string; apiToken: ApiTokenView }>("POST", "/api-tokens", body),
	revokeApiToken: (id: string) => request<{ apiToken: ApiTokenView }>("POST", `/api-tokens/${enc(id)}/revoke`),
	deleteApiToken: (id: string) => request<{ ok: true }>("DELETE", `/api-tokens/${enc(id)}`),
	setTokenRules: (id: string, body: { preset?: Preset; rules?: Rule[] }) =>
		request<{ apiToken: ApiTokenView }>("PUT", `/api-tokens/${enc(id)}/rules`, body).then((r) => r.apiToken),
	listApprovals: () => request<{ tasks: TaskView[]; taskGroups: TaskGroupView[] }>("GET", "/approvals"),
	getTaskGroup: (id: string) =>
		request<{ group: TaskGroupView }>("GET", `/task-groups/${enc(id)}`).then((r) => r.group),
	decideTask: (id: string, body: ApprovalBody) => request<{ ok: true }>("POST", `/tasks/${enc(id)}/approval`, body),
	decideTaskGroup: (id: string, body: ApprovalBody) =>
		request<{ ok: true }>("POST", `/task-groups/${enc(id)}/approval`, body),
	listAudit: (q: AuditQuery) => {
		const p = new URLSearchParams();
		for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
		return request<{ events: AuditEvent[] }>("GET", `/audit?${p}`).then((r) => r.events);
	},
	verifyAudit: () => request<VerifyResult>("GET", "/audit/verify"),

	listUsers: () => request<{ users: User[] }>("GET", "/users").then((r) => r.users),
	createUser: (u: { username: string; displayName?: string; kind: UserKind; password?: string }) =>
		request<{ user: User }>("POST", "/users", u).then((r) => r.user),
	updateUser: (id: string, patch: { kind?: UserKind; status?: "active" | "disabled"; displayName?: string }) =>
		request<{ user: User }>("PATCH", `/users/${enc(id)}`, patch).then((r) => r.user),
	setPassword: (id: string, password: string) =>
		request<{ ok: true }>("POST", `/users/${enc(id)}/password`, { password }),
	listGroups: () => request<{ groups: UserGroup[] }>("GET", "/user-groups").then((r) => r.groups),
	createGroup: (name: string) => request<{ group: UserGroup }>("POST", "/user-groups", { name }).then((r) => r.group),
	deleteGroup: (id: string) => request<{ ok: true }>("DELETE", `/user-groups/${enc(id)}`),
	addMember: (groupId: string, userId: string) =>
		request<{ ok: true }>("PUT", `/user-groups/${enc(groupId)}/members/${enc(userId)}`),
	removeMember: (groupId: string, userId: string) =>
		request<{ ok: true }>("DELETE", `/user-groups/${enc(groupId)}/members/${enc(userId)}`),
	listModels: () => request<{ models: AvailableModel[] }>("GET", "/models").then((r) => r.models),
	listModelProviders: () => request<{ providers: ModelProviderView[]; builtin: string[] }>("GET", "/model-providers"),
	saveModelProvider: (providerId: string, body: ModelProviderInput) =>
		request<{ provider: ModelProviderView }>("PUT", `/model-providers/${enc(providerId)}`, body).then(
			(r) => r.provider,
		),
	deleteModelProvider: (providerId: string) => request<{ ok: true }>("DELETE", `/model-providers/${enc(providerId)}`),
	listSessions: () => request<{ sessions: SessionView[] }>("GET", "/sessions").then((r) => r.sessions),
	createSession: (body: { title?: string; model: ModelRef; preset: Preset }) =>
		request<{ session: SessionView }>("POST", "/sessions", body).then((r) => r.session),
	getSession: (id: string) =>
		request<{ session: SessionView; shares?: SessionShare[] }>("GET", `/sessions/${enc(id)}`).then(
			(r) => ({ ...r.session, shares: r.shares }) as SessionView & { shares?: SessionShare[] },
		),
	listSessionShares: (id: string) =>
		request<{ shares: SessionShare[] }>("GET", `/sessions/${enc(id)}/shares`).then((r) => r.shares),
	shareSession: (id: string, granteeType: GranteeType, granteeId: string, access: "view" | "chat") =>
		request<{ share: SessionShare }>("PUT", `/sessions/${enc(id)}/shares`, { granteeType, granteeId, access }),
	unshareSession: (id: string, shareId: string) =>
		request<{ ok: true }>("DELETE", `/sessions/${enc(id)}/shares/${enc(shareId)}`),
	patchSession: (id: string, body: SessionPatch) =>
		request<{ session: SessionView }>("PATCH", `/sessions/${enc(id)}`, body).then((r) => r.session),
	sendMessage: (id: string, text: string, requestId: string) =>
		request<{ submissionId: string }>("POST", `/sessions/${enc(id)}/messages`, { text, requestId }),
	abortSession: (id: string) => request<{ ok: true }>("POST", `/sessions/${enc(id)}/abort`),
};
