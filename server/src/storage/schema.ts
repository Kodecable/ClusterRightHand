import type {
	BatchOutputMode,
	ModelPresetKind,
	OutputMode,
	ScheduleRunStatus,
	TaskGroupState,
	TaskState,
} from "@crh/api";
import type { ColumnType, Generated } from "kysely";

/**
 * The task, output and schedule unions describe the API as well as the columns. They are imported for the
 * table interfaces below and re-exported so callers that know a column's type through the schema keep their
 * existing import path.
 */
export type { BatchOutputMode, ModelPresetKind, OutputMode, ScheduleRunStatus, TaskGroupState, TaskState };

/** Timestamps are stored as ISO 8601 UTC strings on both dialects; see doc/design/data-model.md. */
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
	user_group_id: string;
	user_id: string;
	created_at: CreatedAt;
}

/** One user's or user group's library, with its limits and hot usage counters (doc/design/library.md "Libraries"). */
export interface LibrariesTable {
	id: string;
	owner_kind: "user" | "group";
	/** Points at users.id or user_groups.id depending on owner_kind; no foreign key, the owner row is created with it. */
	owner_id: string;
	max_files: number;
	max_file_bytes: number;
	max_total_bytes: number;
	used_files: number;
	used_bytes: number;
	created_at: CreatedAt;
}

/** One file of a library; the bytes are an object in the backend under a random key. */
export interface LibraryFilesTable {
	library_id: string;
	path: string;
	size: number;
	sha256: string;
	media_type: string;
	backend: string;
	object_key: string;
	created_by: string | null;
	created_at: CreatedAt;
	updated_at: string;
}

/** The image cache's index (doc/design/library.md "Image cache"); the bytes live in the backend's cache area. */
export interface ImageCacheTable {
	/** Hex SHA-256; also the object's name in the cache area. */
	sha256: string;
	bytes: number;
	mime: string;
	last_used_at: string;
	/** When the current bytes were written to the disk tier; a hit moves only `last_used_at`. */
	stored_at: string;
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
	/** Sessions only: nodes are shared through node_access_grants. */
	resource_type: "session";
	/** No foreign key: resources live in different tables. */
	resource_id: string;
	grantee_type: "user" | "user_group";
	/** No foreign key: points at users or user_groups depending on grantee_type. */
	grantee_id: string;
	/** session: "view" | "chat". */
	access: "view" | "chat";
	created_by_user_id: string;
	created_at: CreatedAt;
}

/**
 * Node access grants: an administrator grants a user or user group access to a node or node group,
 * one level (view and run tasks). Grantee and target ids are polymorphic, so there are no foreign keys;
 * deleting a grantee or target deletes its grants explicitly (node-access.ts).
 */
export interface NodeAccessGrantsTable {
	id: string;
	org_id: string;
	grantee_type: "user" | "user_group";
	grantee_id: string;
	target_type: "node" | "node_group";
	target_id: string;
	created_by_user_id: string;
	created_at: CreatedAt;
}

export interface ServerMetaTable {
	key: string;
	value: string;
}

/**
 * One low-frequency runtime setting, in its API form (doc/guide/reference/crhs-config.md "System
 * settings"). A missing row means the default applies; the WebAuthn values are stored separately.
 */
export interface SettingsTable {
	org_id: string;
	/** The setting's key, e.g. `public_url`, `retention.tasks` or `auth.captcha`. */
	key: string;
	/** JSON-encoded value; `"null"` is an explicit unset (public_url, real_ip_header, webauthn.rp_id). */
	value: string;
	updated_at: string;
	updated_by_user_id: string | null;
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
	name: string;
	/** Lowercase form of `name`; the shared node/node-group namespace compares this. Required on insert. */
	name_key: string;
	transport: "client" | "ssh";
	status: "pending" | "active";
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
	/** Pinned host fingerprint, "SHA256:…". */
	ssh_host_fingerprint: string | null;
	/** The target hop's credential. */
	ssh_credential_id: string | null;
	/** JSON [{ host, port, user, hostFingerprint, credentialId }], the jump hosts in order. */
	ssh_jumps: string | null;
	/** JSON TrustReport of the last trust.summary event; null before the first one. */
	trust_report: ColumnType<string | null, string | null | undefined, string | null>;
	/** Hex SHA-256(CBOR(TrustSummary)); null before the first trust summary. */
	trust_digest: ColumnType<string | null, string | null | undefined, string | null>;
	trust_updated_at: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface NodeGroupsTable {
	id: string;
	org_id: string;
	name: string;
	/** Lowercase form of `name`; unique per organization and shared with node names. */
	name_key: string;
	created_at: CreatedAt;
	updated_at: string;
}

export interface NodeGroupMembersTable {
	node_group_id: string;
	node_id: string;
}

export interface EnrollmentTokensTable {
	id: string;
	org_id: string;
	created_by_user_id: string;
	/** Hex SHA-256 of the token secret. */
	token_hash: string;
	/** Set for a re-enrollment token: enrolling replaces this node's key instead of creating a node. */
	bound_node_id: string | null;
	name_hint: string | null;
	expires_at: string;
	used_at: string | null;
	used_by_node_id: string | null;
	created_at: CreatedAt;
}

/** Who must handle a waiting approval: an agent session, or the user (the task's on_behalf user). */
export type ApprovalHandlerType = "agent" | "user";

/** Columns shared by tasks and task groups for the rule chain and approval (doc/design/access-control.md "Approvals"). */
interface ApprovalColumns {
	/** JSON [{ type, id }], root first; null for a user acting in person. */
	rule_chain: string | null;
	/** JSON ApprovalRecord: the evaluation, then the decision. */
	approval: string | null;
	/** Base64 input, kept only while waiting for approval. */
	pending_input: string | null;
	/** The root session of the session tree (for a scheduled task, the session below its schedule); groups approvals. */
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
	/** TaskSpec in the JSON form of doc/design/protocol.md "JSON storage forms", without the input bytes. */
	spec: string;
	input_size: number | null;
	input_sha256: string | null;
	/** Dispatch attempt, from 1; only an authorization retry increments it (doc/design/protocol.md "task.start"). */
	attempt: number;
	/**
	 * Row version: every write to the row bumps it, and a write derived from an earlier read
	 * names the `rev` it read so a row changed in between is not overwritten with a stale decision.
	 */
	rev: ColumnType<number, number | undefined, number>;
	privileged: number;
	/** JSON authorization plan/state (doc/design/privilege.md "Server-side authorization"): plan, payload id, attempt, trust digest, tried paths, last rejection. */
	authorization: ColumnType<string | null, string | null | undefined, string | null>;
	timeout_ms: number | null;
	/** `full` for a single task; the task group's mode for its tasks. */
	output_mode: OutputMode;
	/** The capped output this task keeps; null takes the default for its mode. */
	max_lines: number | null;
	max_bytes: number | null;
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
	/** The single output stream's byte total. */
	output_bytes: ColumnType<string | number, string | number, string | number>;
	/** The kept head and tail of the single output stream, base64. */
	output_head: string | null;
	output_tail: string | null;
	/** crhs's own line about the task (the SSH privileged notice); it is not part of the output. */
	notice: string | null;
	/** Total lines of the merged output, reported by crha in task.exit. */
	output_lines: number | null;
	output_file: string | null;
	/** The task's structured result in the JSON form of doc/design/protocol.md "Task results"; null when it has none. */
	result: string | null;
	late_result: string | null;
	/** The file plane transfer: JSON { transferId, location } for file.push/file.pull (doc/design/library.md). */
	transfer: string | null;
	/**
	 * Why a dedicated feature created this task, such as `browse` for the node file manager
	 * (doc/design/execution.md "Task purpose"). Null for ordinary tasks; the task API never sets it.
	 */
	purpose: string | null;
}

export interface TaskGroupsTable extends ApprovalColumns {
	id: string;
	org_id: string;
	targets: string;
	node_ids: string;
	kind: string;
	parallel: number;
	fail_fast: number;
	/** The batch output mode, fixed when the task group is created. */
	output_mode: BatchOutputMode;
	/** Per-node caps for the kept output; null takes the defaults, 8KB / 128 lines. */
	node_max_lines: number | null;
	node_max_bytes: number | null;
	/** 1 when the task group's tasks are privileged tasks (doc/design/privilege.md). */
	privileged: number;
	skipped: string;
	state: TaskGroupState;
	actor_type: string;
	actor_id: string;
	on_behalf_of_user_id: string;
	created_at: CreatedAt;
	finished_at: string | null;
	/** TaskSpec JSON (doc/design/protocol.md "JSON storage forms"), kept while waiting for approval. */
	spec: string | null;
	timeout_ms: number | null;
	/** Why a dedicated feature created this group; null for ordinary work (doc/design/execution.md "Task purpose"). */
	purpose: string | null;
	/**
	 * A transfer group's crhs-side source location (JSON), shared by every member; null for other groups
	 * (doc/design/library.md "Copies").
	 */
	transfer: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface AuthorizationsTable {
	/** Hex SHA-256 of the payload bytes. */
	id: string;
	org_id: string;
	/** Base64 of the CBOR payload bytes, kept verbatim so the id stays verifiable. */
	payload: string;
	/** JSON Signature[] (doc/design/protocol.md "Authorization object"). */
	signatures: string;
	/** The user who signed it; null for a crhs-only authorization. */
	issuer_user_id: string | null;
	/** JSON string[] of one-shot task ids; null for a reusable authorization. */
	task_ids: string | null;
	/** ISO 8601 UTC. */
	deadline: string;
	created_at: CreatedAt;
}

export interface SigningCredentialsTable {
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
	rule_preset: string | null;
	default_action: string;
	/** JSON Rule[], the rules added on top of the rule preset's. */
	rules: string;
	updated_at: string;
}

export interface AuditEventsTable {
	/**
	 * Database-generated: SQLite's rowid (integer primary key) or PostgreSQL's identity bigint.
	 * PostgreSQL returns bigint as a string; listAuditEvents converts it to a number.
	 */
	seq: Generated<number>;
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
}

export interface ModelPresetsTable {
	org_id: string;
	kind: ModelPresetKind;
	/** JSON ModelRef; null: unset. */
	model: string | null;
	/** Custom system prompt; null: use the default prompt. */
	system_prompt: string | null;
	updated_at: string;
}

/** A session's run state (doc/design/agent-runtime.md "Session state"): roots and subagents share it. */
export type SessionState = "idle" | "running" | "awaiting";
/** What an awaiting session waits for; quota outranks approval, approval outranks authorization. */
export type WaitingKind = "quota" | "approval" | "authorization";

export interface SessionsTable {
	id: string;
	org_id: string;
	owner_user_id: string;
	conversation_id: string;
	parent_session_id: string | null;
	/** The root of this session's tree; the session itself for a root (doc/design/webui.md "Session list API"). */
	root_session_id: string;
	/** The schedule whose run created this root session; nulled when the schedule is deleted. */
	schedule_id: string | null;
	/** Generated or user-given title; null shows the WebUI's localized default (doc/design/agent-runtime.md "Title generation"). */
	title: string | null;
	/** Whether a title still wants generating; cleared by a success or a manual rename (SQLite/PostgreSQL 0/1). */
	title_pending: ColumnType<number, number | undefined, number | undefined>;
	/** The client request id that created the session and its first message; unique per owner. */
	create_request_id: ColumnType<string | null, string | null | undefined, string | null>;
	/** JSON ModelRef. */
	model: string;
	status: "active" | "archived";
	created_at: CreatedAt;
	updated_at: string;
	archived_at: string | null;
	/** Durable submission of the last input, for a parent waiting on this session's answer. */
	last_submission_id: string | null;
	/** The session's own run state (doc/design/agent-runtime.md "Session state"); the session list aggregates it over the tree. */
	state: SessionState;
	/** Why the session waits; null unless `state` is `awaiting`. */
	waiting_kind: WaitingKind | null;
	/** While awaiting a quota: the exhausted level to top up. */
	waiting_level_id: string | null;
	/** While awaiting a quota: the level's parent agent handles it; null when the level is the root (its owner does). */
	waiting_handler_id: string | null;
	state_changed_at: string | null;
	/** When the tree last left `running` for `idle`/`awaiting`, so its owner has new output; roots only. */
	reply_at: string | null;
	/** When the owner last opened the tree; `reply_at > owner_read_at` means unread; roots only. */
	owner_read_at: string | null;
	/** Remaining token quota at any level (doc/design/agent-runtime.md "Quota and token accounting"); null: unlimited. Signed: one call may overspend it. */
	quota_tokens: ColumnType<string | number | null, string | number | null | undefined, string | number | null>;
	/** The budget measure: output tokens spent by this session and its subagents. */
	budget_used_tokens: ColumnType<string | number, string | number | undefined, string | number>;
	/** The statistics measure: input + output tokens of this session and its subagents. */
	usage_tokens: ColumnType<string | number, string | number | undefined, string | number>;
	/** The input size of this session's own last main-agent call; null before the first. */
	context_tokens: ColumnType<string | number | null, string | number | null | undefined, string | number | null>;
	/** Own main-agent steps that ended in this session (doc/design/agent-runtime.md "Session statistics"). */
	stat_steps: ColumnType<string | number, string | number | undefined, string | number>;
	/** Own user inputs that led to at least one step. */
	stat_turns: ColumnType<string | number, string | number | undefined, string | number>;
	/** The newest submission already counted in `stat_turns`; null before the first step. */
	counted_submission_id: string | null;
	/** Total time to first streamed delta over the steps it was observed for. */
	stat_ttft_ms: ColumnType<string | number, string | number | undefined, string | number>;
	/** Steps whose first delta was observed (the divisor of the average TTFT). */
	stat_ttft_steps: ColumnType<string | number, string | number | undefined, string | number>;
	/** Total decode time (message end minus first delta) over the steps that had one. */
	stat_decode_ms: ColumnType<string | number, string | number | undefined, string | number>;
	/** Output tokens decoded in `stat_decode_ms`. */
	stat_decode_tokens: ColumnType<string | number, string | number | undefined, string | number>;
	/** Input (input + cache read + cache write) tokens of every call, accumulated up the tree. */
	prompt_tokens: ColumnType<string | number, string | number | undefined, string | number>;
	/** Cache-read tokens of every call, accumulated up the tree. */
	cache_read_tokens: ColumnType<string | number, string | number | undefined, string | number>;
}

export interface ModelProvidersTable {
	id: string;
	org_id: string;
	provider_id: string;
	kind: "builtin" | "custom";
	builtin: string | null;
	name: string;
	base_url: string | null;
	secret_id: string | null;
	models: string | null;
	/** custom: JSON Record<string, string>, extra request headers. */
	headers: string | null;
	/** custom: JSON { headers?: string[], body?: string[] }, fields that carry the crh session id. */
	session_id: string | null;
	enabled: number;
	created_at: CreatedAt;
	updated_at: string;
}

export interface SshCredentialsTable {
	id: string;
	org_id: string;
	name: string;
	public_key: string;
	secret_id: string;
	created_at: CreatedAt;
}

export interface SchedulesTable {
	id: string;
	org_id: string;
	owner_user_id: string;
	name: string;
	/** The user message every run submits to its new session. */
	prompt: string;
	/** JSON ModelRef. */
	model: string;
	/** The new session's root quota; null means unlimited. */
	token_budget: ColumnType<string | number | null, string | number | null | undefined, string | number | null>;
	cron: string;
	timezone: string;
	/** SQLite/PostgreSQL store booleans as 0/1. */
	catch_up: number;
	enabled: number;
	/** ISO 8601 UTC; null while disabled. */
	next_run_at: string | null;
	created_at: CreatedAt;
	updated_at: string;
}

export interface ScheduleRunsTable {
	id: string;
	schedule_id: string;
	/** ISO 8601 UTC, the configured instant this run stands for (manual runs: the click time). */
	fire_time: string;
	manual: number;
	status: ScheduleRunStatus;
	/** Derived from the run id, so a retried submit finds the same session. */
	session_id: string | null;
	reason: string | null;
	created_at: CreatedAt;
	started_at: string | null;
	finished_at: string | null;
}

export interface Database {
	orgs: OrgsTable;
	users: UsersTable;
	user_groups: UserGroupsTable;
	user_group_members: UserGroupMembersTable;
	libraries: LibrariesTable;
	library_files: LibraryFilesTable;
	image_cache: ImageCacheTable;
	web_sessions: WebSessionsTable;
	shares: SharesTable;
	server_meta: ServerMetaTable;
	settings: SettingsTable;
	secrets: SecretsTable;
	nodes: NodesTable;
	node_groups: NodeGroupsTable;
	node_group_members: NodeGroupMembersTable;
	node_access_grants: NodeAccessGrantsTable;
	enrollment_tokens: EnrollmentTokensTable;
	tasks: TasksTable;
	task_groups: TaskGroupsTable;
	ssh_credentials: SshCredentialsTable;
	signing_credentials: SigningCredentialsTable;
	authorizations: AuthorizationsTable;
	api_tokens: ApiTokensTable;
	rule_sets: RuleSetsTable;
	audit_events: AuditEventsTable;
	sessions: SessionsTable;
	model_providers: ModelProvidersTable;
	model_presets: ModelPresetsTable;
	schedules: SchedulesTable;
	schedule_runs: ScheduleRunsTable;
}
