/**
 * Types of the crhs HTTP API the WebUI uses (doc/webui.md "API 约定").
 *
 * List endpoints return `{ items, nextCursor }`; the cursor is opaque to the
 * client. Types shared by several features live here so that a feature's
 * `api.ts` only contains its hooks.
 */

/** One page of a keyset-cursor list (doc/webui.md "游标列表"). */
export interface CursorPage<T> {
	items: T[];
	nextCursor: string | null;
}

/** Query parameters every cursor list accepts. */
export interface CursorQuery {
	cursor?: string;
	limit?: number;
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

/** The three states of a session tree (doc/agent-runtime.md "会话状态"). */
export type SessionRunState = "idle" | "running" | "awaiting";

/** Why an `awaiting` session is blocked; the tree reports its highest-priority wait. */
export type SessionWaitingKind = "quota" | "approval" | "authorization";

/** The lightweight row of `GET /api/sessions` (doc/webui.md "SessionListItem"). */
export interface SessionListItem {
	id: string;
	title: string;
	ownerUserId: string;
	ownerName: string;
	scheduleId: string | null;
	/** Not owned by the current user but shared with them. */
	shared: boolean;
	/** The whole tree's state: any child awaiting wins, then any running, else idle. */
	state: SessionRunState;
	/** The highest-priority wait of the tree while `state` is `awaiting`. */
	waitingKind: SessionWaitingKind | null;
	/** The session's parent, on the children list (`GET /api/sessions/:id/children`); absent from the root list. */
	parentSessionId?: string | null;
	updatedAt: string;
}

/** The counts of a session's direct child sessions by their own state (`GET /sessions/:id/children/summary`). */
export interface SessionChildrenSummary {
	total: number;
	states: Record<SessionRunState, number>;
}

export type SessionListScope = "mine" | "shared" | "all";

export interface SessionListQuery extends CursorQuery {
	scope?: SessionListScope;
	q?: string;
}

export interface SessionView {
	id: string;
	title: string;
	ownerUserId: string;
	parentSessionId: string | null;
	/** The schedule whose run created this session; null for every other session. */
	scheduleId: string | null;
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
	/** The persisted session state (doc/agent-runtime.md "会话状态"). */
	state: SessionRunState;
	/** Why the session waits while `state` is `awaiting`. */
	waitingKind: SessionWaitingKind | null;
	/** While awaiting a quota: the exhausted level to top up. */
	waitingLevelId: string | null;
	/** Remaining budget tokens (null: unlimited; negative after an overspending response). */
	budgetRemaining: number | null;
	/** The budget measure: output tokens spent by the session and its subagents (D101). */
	budgetUsedTokens: number;
	/** The statistics measure: input + output tokens of the session and its subagents (D101). */
	usageTokens: number;
	/** The input size of the session's own last main-agent call; null before the first (D101). */
	contextTokens: number | null;
	shares?: SessionShare[];
}

export interface SessionPatch {
	title?: string;
	model?: ModelRef;
	preset?: Preset;
	/** Replaces the remaining budget at any level (null: unlimited). */
	budgetRemaining?: number | null;
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

export interface AuditQuery extends CursorQuery {
	action?: string;
	targetType?: string;
	targetId?: string;
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

/** One entry of a `file.list` result (doc/protocol.md TaskResult). */
export interface FileListEntryView {
	name: string;
	type: string;
	size: number;
	mode: string;
	mtime: string;
}

/**
 * A task's structured result, in the JSON form the API serves. Its `kind` is the task kind; the
 * fields are the wire fields in camelCase (doc/protocol.md TaskResult).
 */
export type TaskResultView =
	| { kind: "file.read"; from: number; to: number; eof: boolean; total: number | null; tooLong: boolean }
	| {
			kind: "file.stat";
			path: string;
			type: string;
			size: number;
			mode: string;
			uid: number;
			gid: number;
			owner: string;
			group: string;
			mtime: string;
			linkTarget: string | null;
	  }
	| { kind: "file.list"; entries: FileListEntryView[]; truncated: boolean }
	| { kind: "file.write"; bytes: number; created: boolean }
	| { kind: "file.edit"; replacements: number };

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
	/** full for a single task; text, status or head for a batch node (doc/execution-plane.md#输出). */
	outputMode: "full" | "text" | "status" | "head";
	/** Whether this is a privileged task (doc/privilege.md). */
	privileged: boolean;
	/** The authorization plan and its history for a privileged task. */
	authorization?: TaskAuthorizationView | null;
	/** The task's structured result; null for a kind that reports none and for a task that failed. */
	result?: TaskResultView | null;
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
	/** status or text for an exec group; head for a file operation (doc/execution-plane.md#输出). */
	outputMode: "status" | "text" | "head";
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
	/** Remaining budget tokens at the level; zero or negative (D101). */
	budgetRemaining: number;
	/** The budget measure spent by the tree (D101). */
	budgetUsedTokens: number;
}

export type ScheduleRunStatus = "pending" | "running" | "succeeded" | "failed" | "preempted";

/** One firing of a schedule (doc/scheduling.md#调度). */
export interface ScheduleRunView {
	id: string;
	scheduleId: string;
	fireTime: string;
	manual: boolean;
	status: ScheduleRunStatus;
	/** The session the run created, derived from its id. */
	sessionId: string | null;
	reason: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

/** A schedule and what the list shows about it (doc/scheduling.md#形态). */
export interface ScheduleView {
	id: string;
	ownerUserId: string;
	name: string;
	prompt: string;
	model: ModelRef;
	preset: Preset | null;
	rules: Rule[];
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
	lastRun: ScheduleRunView | null;
	/** Whether a run is in progress right now (a "Run now" would stop it). */
	inProgress: boolean;
	/** The next few fire times, computed by the server for the form. */
	preview: string[];
	/** Why the preview is empty, when the stored cron or timezone no longer validates. */
	previewError: string | null;
}

export interface ScheduleInput {
	name: string;
	prompt: string;
	model: ModelRef;
	preset: Preset;
	tokenBudget: number | null;
	cron: string;
	timezone: string;
	catchUp: boolean;
	enabled: boolean;
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
