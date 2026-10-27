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
	| "denied"
	| "dispatched"
	| "running"
	| "exited"
	| "failed"
	| "rejected"
	| "unknown";

/** Columns shared by tasks and task groups for the rule chain and approval (doc/access-control.md#审批). */
interface ApprovalColumns {
	/** JSON [{ type, id }], root first; null for a user acting in person. */
	rule_chain: string | null;
	/** JSON ApprovalRecord: the evaluation, then the decision. */
	approval: string | null;
	/** Base64 input, kept only while waiting for approval. */
	pending_input: string | null;
}

export interface TasksTable extends ApprovalColumns {
	id: string;
	org_id: string;
	node_id: string;
	task_group_id: string | null;
	kind: string;
	/** TaskSpec in protobuf JSON form, without the input bytes. */
	spec: string;
	input_size: number | null;
	input_sha256: string | null;
	privileged: number;
	timeout_ms: number | null;
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
	skipped: string;
	state: TaskGroupState;
	actor_type: string;
	actor_id: string;
	on_behalf_of_user_id: string;
	created_at: CreatedAt;
	finished_at: string | null;
	/** TaskSpec JSON, kept while waiting for approval. */
	spec: string | null;
	timeout_ms: number | null;
}

export type TaskGroupState = "awaiting_approval" | "running" | "finished" | "interrupted" | "rejected";

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
	budget: string | null;
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
	/** Spent by this session and its subagents: tokens, and cost in millionths of a US dollar. */
	used_tokens: ColumnType<string | number, string | number | undefined, string | number>;
	used_cost_microusd: ColumnType<string | number, string | number | undefined, string | number>;
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
	api_tokens: ApiTokensTable;
	rule_sets: RuleSetsTable;
	audit_events: AuditEventsTable;
	sessions: SessionsTable;
	model_providers: ModelProvidersTable;
}
