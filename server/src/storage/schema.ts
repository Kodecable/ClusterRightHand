import type { ColumnType } from "kysely";

/** Timestamps are stored as ISO 8601 UTC strings on both dialects; see doc/data-model.md. */
type CreatedAt = ColumnType<string, string, never>;

export interface OrgsTable {
	id: string;
	name: string;
	created_at: CreatedAt;
}

export interface UsersTable {
	id: string;
	org_id: string;
	username: string;
	display_name: string;
	email: string | null;
	kind: "admin" | "member";
	password_hash: string | null;
	status: "active" | "disabled";
	created_at: CreatedAt;
}

export interface UserGroupsTable {
	id: string;
	org_id: string;
	name: string;
	source: "local";
	created_at: CreatedAt;
}

export interface UserGroupMembersTable {
	group_id: string;
	user_id: string;
	created_at: CreatedAt;
}

export interface WebSessionsTable {
	id: string;
	/** Hex SHA-256 of the cookie token. */
	token_hash: string;
	user_id: string;
	created_at: CreatedAt;
	expires_at: string;
	last_seen_at: string;
	ip: string | null;
	user_agent: string | null;
}

export interface SharesTable {
	id: string;
	org_id: string;
	resource_type: "node" | "session";
	/** No foreign key: resources live in different tables. */
	resource_id: string;
	grantee_type: "user" | "user_group";
	/** No foreign key: points at users or user_groups depending on grantee_type. */
	grantee_id: string;
	/** node: "view" | "operate"; session: "view" | "chat". */
	access: "view" | "operate" | "chat";
	created_by_user_id: string;
	created_at: CreatedAt;
}

export interface ServerMetaTable {
	key: string;
	value: string;
}

export interface SecretsTable {
	id: string;
	org_id: string;
	/** What the secret is; also bound into the ciphertext as associated data. */
	kind: string;
	ciphertext: string;
	created_at: CreatedAt;
}

export interface NodesTable {
	id: string;
	org_id: string;
	owner_user_id: string;
	name: string;
	transport: "client" | "ssh";
	status: "pending" | "active" | "disabled";
	/** Base64 of the node's 32-byte X25519 static key. */
	public_key: string | null;
	hostname: string | null;
	/** JSON text. */
	facts: string | null;
	client_version: string | null;
	privileged_mode: string | null;
	last_seen_at: string | null;
	created_at: CreatedAt;
	approved_at: string | null;
	approved_by_user_id: string | null;
	ssh_host: string | null;
	ssh_port: number | null;
	ssh_user: string | null;
	/** Pinned host key fingerprint, "SHA256:…". */
	ssh_host_key: string | null;
	ssh_credential_id: string | null;
	/** JSON [{ host, port, user, hostKey }], the jump hosts in order. */
	ssh_jumps: string | null;
	/** JSON TrustReport of the last trust.summary event; null before the first one. */
	trust_report: ColumnType<string | null, string | null | undefined, string | null>;
	/** Hex SHA-256(CBOR(TrustSummary)); null before the first trust summary. */
	trust_digest: ColumnType<string | null, string | null | undefined, string | null>;
	trust_updated_at: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface NodeGroupsTable {
	node_id: string;
	group_name: string;
	refreshed_at: string;
}

export interface EnrollmentTokensTable {
	id: string;
	org_id: string;
	created_by_user_id: string;
	/** Hex SHA-256 of the token secret. */
	token_hash: string;
	name_hint: string | null;
	expires_at: string;
	used_at: string | null;
	used_by_node_id: string | null;
	created_at: CreatedAt;
}

export type TaskState =
	| "awaiting_approval"
	/** Policy passed, but a privileged task still needs a signature (doc/privilege.md). */
	| "awaiting_authorization"
	| "denied"
	| "dispatched"
	| "running"
	| "exited"
	| "failed"
	| "rejected"
	| "unknown";

/** Who must handle a waiting approval: an agent session, or the user (the task's on_behalf user). */
export type ApprovalHandlerType = "agent" | "user";

/** How much output crhs keeps for a task (doc/execution-plane.md#输出). */
export type OutputMode = "full" | "text" | "status";
/** A task group is a batch, so it chooses between the two batch modes only. */
export type BatchOutputMode = "status" | "text";

/** Columns shared by tasks and task groups for the rule chain and approval (doc/access-control.md#审批). */
interface ApprovalColumns {
	/** JSON [{ type, id }], root first; null for a user acting in person. */
	rule_chain: string | null;
	/** JSON ApprovalRecord: the evaluation, then the decision. */
	approval: string | null;
	/** Base64 input, kept only while waiting for approval. */
	pending_input: string | null;
	/** The root session of the rule chain, when it starts with one; for grouping by session tree. */
	root_session_id: string | null;
	/** Who handles the waiting approval; null unless the task is waiting. A user is on_behalf_of_user_id. */
	handler_type: ApprovalHandlerType | null;
	/** The agent session that handles it; null when the user does. */
	handler_session_id: string | null;
}

export interface TasksTable extends ApprovalColumns {
	id: string;
	org_id: string;
	node_id: string;
	task_group_id: string | null;
	kind: string;
	/** TaskSpec in the JSON form of doc/protocol.md#json-形式服务端存储, without the input bytes. */
	spec: string;
	input_size: number | null;
	input_sha256: string | null;
	/** Dispatch attempt, from 1; only an authorization retry increments it (doc/protocol.md#task.start). */
	attempt: number;
	privileged: number;
	/** JSON authorization plan/state (doc/m4.md#crhs-侧数据): plan, payload id, attempt, trust digest, tried paths, last rejection. */
	authorization: ColumnType<string | null, string | null | undefined, string | null>;
	timeout_ms: number | null;
	/** `full` for a single task; the group's mode for its tasks. */
	output_mode: OutputMode;
	state: TaskState;
	exit_code: number | null;
	signal: string | null;
	timed_out: number;
	cancelled: number;
	/** Executor error code, client rejection, or the unknown reason. */
	error_code: string | null;
	error_message: string | null;
	actor_type: string;
	actor_id: string;
	on_behalf_of_user_id: string;
	created_at: CreatedAt;
	dispatched_at: string | null;
	accepted_at: string | null;
	finished_at: string | null;
	stdout_bytes: ColumnType<string | number, string | number, string | number>;
	stderr_bytes: ColumnType<string | number, string | number, string | number>;
	stdout_head: string | null;
	stdout_tail: string | null;
	stderr_head: string | null;
	stderr_tail: string | null;
	output_file: string | null;
	late_result: string | null;
}

export interface TaskGroupsTable extends ApprovalColumns {
	id: string;
	org_id: string;
	targets: string;
	node_ids: string;
	kind: string;
	parallel: number;
	fail_fast: number;
	/** The batch output mode, fixed when the group is created. */
	output_mode: BatchOutputMode;
	/** 1 when the group's tasks are privileged tasks (doc/privilege.md). */
	privileged: number;
	skipped: string;
	state: TaskGroupState;
	actor_type: string;
	actor_id: string;
	on_behalf_of_user_id: string;
	created_at: CreatedAt;
	finished_at: string | null;
	/** TaskSpec JSON (doc/protocol.md#json-形式服务端存储), kept while waiting for approval. */
	spec: string | null;
	timeout_ms: number | null;
}

export type TaskGroupState =
	| "awaiting_approval"
	| "awaiting_authorization"
	| "running"
	| "finished"
	| "interrupted"
	| "rejected";

export interface AuthorizationsTable {
	/** Hex SHA-256 of the payload bytes. */
	id: string;
	org_id: string;
	/** Base64 of the CBOR payload bytes, kept verbatim so the id stays verifiable. */
	payload: string;
	/** JSON Signature[] (doc/protocol.md#授权对象). */
	signatures: string;
	/** The user who signed it; null for a crhs-only authorization. */
	issuer_user_id: string | null;
	/** JSON string[] of one-shot task ids; null for a reusable authorization. */
	task_ids: string | null;
	/** ISO 8601 UTC, null when the payload has no deadline. */
	deadline: string | null;
	created_at: CreatedAt;
	revoked_at: string | null;
}

export interface UserCredentialsTable {
	id: string;
	user_id: string;
	kind: "ssh" | "webauthn";
	name: string;
	/** ssh: an authorized_keys line; webauthn: base64 COSE public key. */
	public_key: string;
	/** ssh: "SHA256:…" fingerprint; null for webauthn. */
	fingerprint: string | null;
	/** webauthn: base64url credential id; null for ssh. */
	credential_id: string | null;
	/** webauthn only. */
	rp_id: string | null;
	/** webauthn only: JSON string[] of the origins the credential was registered for. */
	origins: ColumnType<string | null, string | null | undefined, string | null>;
	created_at: CreatedAt;
}

export interface ApiTokensTable {
	id: string;
	org_id: string;
	user_id: string;
	name: string;
	token_hash: string;
	created_at: CreatedAt;
	expires_at: string | null;
	revoked_at: string | null;
	last_used_at: string | null;
}

export type RuleScopeType = "session" | "schedule" | "api_token";

export interface RuleSetsTable {
	id: string;
	org_id: string;
	scope_type: RuleScopeType;
	scope_id: string;
	preset: string | null;
	default_action: string;
	/** JSON Rule[], the rules added on top of the preset's. */
	rules: string;
	updated_at: string;
}

export interface AuditEventsTable {
	seq: number;
	id: string;
	org_id: string;
	ts: string;
	actor_type: string;
	actor_id: string;
	on_behalf_of_user_id: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	/** Canonical JSON. */
	detail: string;
	prev_hash: string;
	hash: string;
}

export interface SessionsTable {
	id: string;
	org_id: string;
	owner_user_id: string;
	conversation_id: string;
	parent_session_id: string | null;
	title: string;
	/** JSON ModelRef. */
	model: string;
	status: "active" | "archived";
	created_at: CreatedAt;
	updated_at: string;
	archived_at: string | null;
	/** Durable submission of the last input, for a parent waiting on this session's answer. */
	last_submission_id: string | null;
	/** Subagent state (doc/agent-runtime.md#subagent): active, awaiting, stopped. Roots stay active. */
	state: "active" | "awaiting" | "stopped";
	/** While awaiting: the exhausted level to top up. */
	waiting_level_id: string | null;
	/** While awaiting a quota: the session whose agent handles the wait (the exhausted level's parent). */
	waiting_handler_id: string | null;
	state_changed_at: string | null;
	/** Remaining token quota (doc/agent-runtime.md#配额); null: unlimited. Signed: one response may overspend it. */
	quota_tokens: ColumnType<string | number | null, string | number | null | undefined, string | number | null>;
	/** Spent by this session and its subagents. */
	used_tokens: ColumnType<string | number, string | number | undefined, string | number>;
}

export interface ModelProvidersTable {
	id: string;
	org_id: string;
	provider_id: string;
	kind: "builtin" | "openai-compatible";
	builtin: string | null;
	name: string;
	base_url: string | null;
	secret_id: string | null;
	models: string | null;
	/** openai-compatible: JSON Record<string, string>, extra request headers. */
	headers: string | null;
	enabled: number;
	created_at: CreatedAt;
	updated_at: string;
}

export interface SshCredentialsTable {
	id: string;
	org_id: string;
	owner_user_id: string;
	name: string;
	public_key: string;
	secret_id: string;
	created_at: CreatedAt;
}

export interface Database {
	orgs: OrgsTable;
	users: UsersTable;
	user_groups: UserGroupsTable;
	user_group_members: UserGroupMembersTable;
	web_sessions: WebSessionsTable;
	shares: SharesTable;
	server_meta: ServerMetaTable;
	secrets: SecretsTable;
	nodes: NodesTable;
	node_groups: NodeGroupsTable;
	enrollment_tokens: EnrollmentTokensTable;
	tasks: TasksTable;
	task_groups: TaskGroupsTable;
	ssh_credentials: SshCredentialsTable;
	user_credentials: UserCredentialsTable;
	authorizations: AuthorizationsTable;
	api_tokens: ApiTokensTable;
	rule_sets: RuleSetsTable;
	audit_events: AuditEventsTable;
	sessions: SessionsTable;
	model_providers: ModelProvidersTable;
}
