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
	/** A clock warning when the node's clock is too far from crhs's; null when it is fine. */
	clockWarning: string | null;
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
/** One path of a task's authorization plan (doc/privilege.md#授权路径). */
export interface PlannedPathView {
	path: "crhs" | "user" | "local";
	entries: {
		name: string;
		role: "crhs" | "user" | "local";
		credential?: "sshsig" | "webauthn";
		cosign?: "required" | "available" | "missing";
	}[];
}
/** The authorization state of a privileged task (doc/m4.md#crhs-侧数据). */
export interface TaskAuthorizationView {
	plan: { paths: PlannedPathView[]; reason?: string };
	tried: string[];
	dispatchedPath: string | null;
	payloadId: string | null;
	attempt: number;
	trustDigest: string | null;
	lastRejection: { code: string; message: string; attempt: number; at: string } | null;
	updatedAt: string;
}
export type TrustStatus = "ok" | "unavailable" | "not_forward";
export type GuardRule = { method: RuleMethod; match: "any" | "prefix" | "regex"; pattern: string };
export interface TrustEntryKey {
	kind: "sshsig" | "webauthn" | "local";
	/** sshsig. */
	publicKey?: string;
	fingerprint?: string;
	/** webauthn (base64). */
	credentialId?: string;
	coseKey?: string;
	rpId?: string;
	origins?: string[];
	/** local. */
	uids?: number[];
}
export interface TrustEntry {
	name: string;
	source: "local";
	role: "crhs" | "user" | "local";
	key: TrustEntryKey;
	kinds: string[];
	requireExact: boolean;
	requireTask: boolean;
	requireUv: boolean;
	maxTtlMs: number | null;
	allow: GuardRule[];
	deny: GuardRule[];
	envAllow: string[];
}
export interface TrustSummary {
	nodeId: string;
	groups: string[];
	clockSkewMs: number;
	identities: {
		unprivileged: { uid: number; gid: number; user: string };
		privileged: { uid: number; gid: number; user: string };
	};
	trust: TrustEntry[];
}
/** The trust panel of a node (doc/privilege.md#信任缓存). */
export interface NodeTrust {
	status: TrustStatus | null;
	message: string | null;
	digest: string | null;
	updatedAt: string | null;
	/** The last report is kept after a disconnect but is stale until the connection reports again. */
	stale: boolean;
	summary: TrustSummary | null;
}
/** What to paste into ~/privileged.toml as the crhs trust entry. */
export interface CrhsKey {
	authorizedKey: string;
	fingerprint: string;
}
/** One of the user's signing credentials (doc/m4.md M4.4). */
export interface CredentialView {
	id: string;
	kind: "ssh" | "webauthn";
	name: string;
	createdAt: string;
	/** ssh: the authorized_keys line; webauthn: the COSE public key, base64. */
	publicKey: string;
	/** ssh only: the fingerprint a trust entry's key carries. */
	fingerprint: string | null;
	/** webauthn only. */
	credentialId: string | null;
	rpId: string | null;
	origins: string[];
}
/** The decoded form of a pending authorization payload. */
export interface DecodedAuthorizationPayload {
	nodes: string[];
	command:
		| { method: RuleMethod; match: "exact"; target: string; specSha256: string }
		| { method: RuleMethod; match: "prefix"; target: string }
		| null;
	issuedAt: string;
	deadline: string | null;
	taskIds: string[] | null;
	attempt: number | null;
	note: string;
}
/** One of the owner's Passkeys the node trusts for the payload. */
export interface PendingPasskey {
	credentialId: string;
	name: string;
	rpId: string;
	origins: string[];
	requireUv: boolean;
	entry: string;
}
/** The payload a waiting task's owner has to sign. */
export interface PendingAuthorization {
	id: string;
	payload: string;
	decoded: DecodedAuthorizationPayload;
	challenge: string;
	deadline: string | null;
	taskIds: string[];
	attempt: number;
	passkeys: PendingPasskey[];
	localRequested: boolean;
	lastRejection: TaskAuthorizationView["lastRejection"];
	tried: string[];
}
export interface GroupPendingTask {
	id: string;
	nodeId: string;
	nodeName: string;
	attempt: number;
	state: TaskState;
	localRequested: boolean;
	lastRejection: TaskAuthorizationView["lastRejection"];
	tried: string[];
}
export interface GroupPending {
	authorization: PendingAuthorization;
	tasks: GroupPendingTask[];
}
/** One stored authorization (doc/m4.md M4.4). */
export interface AuthorizationSummary {
	id: string;
	issuerUserId: string | null;
	issuerUsername: string | null;
	nodes: string[];
	command: DecodedAuthorizationPayload["command"];
	taskIds: string[] | null;
	attempt: number | null;
	note: string;
	issuedAt: string | null;
	deadline: string | null;
	createdAt: string;
	revokedAt: string | null;
}
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
	/** The authorization plan and its history for a privileged task. */
	authorization?: TaskAuthorizationView | null;
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

/** A root whose token quota is used up and waits for the owner's decision (doc/agent-runtime.md#配额). */
export interface QuotaApproval {
	/** The root session to act on (and to link to). */
	sessionId: string;
	/** The exhausted level to top up; the root. */
	levelId: string;
	title: string;
	since: string;
	/** Remaining tokens at the level; zero or negative. */
	quota: number;
	/** Tokens the root and its subagents have used. */
	used: number;
}

/** GET /approvals: waiting approvals, plus tasks/groups waiting for this user's signature and exhausted quotas. */
export interface ApprovalList {
	tasks: TaskView[];
	taskGroups: TaskGroupView[];
	authorizations: { tasks: TaskView[]; taskGroups: TaskGroupView[] };
	quotas: QuotaApproval[];
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
	/** Subagent state: active, awaiting, stopped (a root is active except while it waits for its quota). */
	state: "active" | "awaiting" | "stopped";
	/** While awaiting a quota: the exhausted level to top up. */
	waitingLevelId: string | null;
	/** Remaining token quota (null: unlimited; negative after an overspending response). */
	quota: number | null;
	/** Tokens spent by the session and its subagents. */
	spentTokens: number;
}
export interface SessionPatch {
	title?: string;
	model?: ModelRef;
	preset?: Preset;
	/** Replaces the remaining quota at any level (null: unlimited). */
	quota?: number | null;
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
	getNodeTrust: (id: string) => request<{ trust: NodeTrust }>("GET", `/nodes/${enc(id)}/trust`).then((r) => r.trust),
	/** The crhs authorization signing key and its fingerprint (doc/privilege.md#crhs-侧). */
	getCrhsKey: () => request<{ key: CrhsKey }>("GET", "/privilege/crhs-key").then((r) => r.key),
	/** Revokes an authorization; the nodes get the revocation with revocations.add (doc/privilege.md#吊销). */
	revokeAuthorization: (id: string) =>
		request<{ authorization: { id: string; revokedAt: string } }>("POST", `/authorizations/${enc(id)}/revoke`),
	/** The caller's own authorizations; administrators see their organization's. */
	listAuthorizations: () =>
		request<{ authorizations: AuthorizationSummary[] }>("GET", "/authorizations").then((r) => r.authorizations),

	/** The user's signing credentials and their trust snippets (doc/m4.md M4.4). */
	listCredentials: () =>
		request<{ credentials: CredentialView[] }>("GET", "/me/credentials").then((r) => r.credentials),
	addSshCredential: (publicKey: string, name?: string) =>
		request<{ credential: CredentialView }>("POST", "/me/credentials/ssh", { publicKey, name }).then(
			(r) => r.credential,
		),
	deleteCredential: (id: string) => request<{ ok: true }>("DELETE", `/me/credentials/${enc(id)}`),
	/** WebAuthn registration options; the challenge is remembered server-side and used once. */
	passkeyOptions: () => request<{ options: Record<string, unknown> }>("POST", "/me/credentials/webauthn/options", {}),
	registerPasskey: (response: unknown, name?: string) =>
		request<{ credential: CredentialView }>("POST", "/me/credentials/webauthn", { response, name }).then(
			(r) => r.credential,
		),

	/** The pending payload of a waiting task, for its owner only. */
	getTaskAuthorization: (id: string) =>
		request<{ authorization: PendingAuthorization | null }>("GET", `/tasks/${enc(id)}/authorization`).then(
			(r) => r.authorization,
		),
	getTaskGroupAuthorization: (id: string) =>
		request<{ group: GroupPending | null }>("GET", `/task-groups/${enc(id)}/authorization`).then((r) => r.group),
	/** Submits a signed authorization: pasted `crha grant` output, or a Passkey assertion. */
	submitAuthorization: (body: { authorization: string } | { payloadId: string; webauthn: unknown }) =>
		request<{ authorization: { id: string; dispatched: string[] } }>("POST", "/authorizations", body).then(
			(r) => r.authorization,
		),
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
	/** Every task on a node the user can see; tasks waiting for them come first (server order). */
	listTasks: (q: { state?: string; nodeId?: string; actorType?: string; limit?: number; offset?: number } = {}) => {
		const p = new URLSearchParams();
		for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
		return request<{ tasks: TaskView[]; offset: number; limit: number; nextOffset: number | null }>(
			"GET",
			`/tasks?${p}`,
		);
	},
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
	/** Approvals this user handles, plus the tasks and groups that wait for their signature. */
	listApprovals: () => request<ApprovalList>("GET", "/approvals"),
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
	createSession: (body: { title?: string; model: ModelRef; preset: Preset; quota?: number | null }) =>
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
	/** The owner's answer to a used-up token quota on a root: add tokens, or stop the paused run. */
	decideQuota: (id: string, body: { decision: "approve" | "deny"; tokens?: number; reason?: string }) =>
		request<{ ok: true; sessions: string[] }>("POST", `/sessions/${enc(id)}/quota`, body),
};
