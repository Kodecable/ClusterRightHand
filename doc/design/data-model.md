# Data model

crhs keeps its state in one relational database, SQLite or PostgreSQL, with one schema for both. crhs's
own tables are accessed through Kysely; the agent runtime's durable tables live in the same database
under the `pi_` prefix ([Storage](agent-runtime.md#storage)). The table definitions are in
`server/src/storage/schema.ts` and the migrations in `server/src/storage/migrations/`. This document
describes the conventions and the decisions behind them.

## Storage backends

SQLite serves a single machine, small installations and debugging. PostgreSQL is the deployment for a
team, with many users and long conversation histories. Writing each table once and running every
migration on both dialects keeps the two from diverging.

The conventions that let one schema work on both:

- Primary keys are UUIDv7 strings, ordered by creation time, so primary-key indexes follow insert
  order. There is no dialect-specific UUID type.
- JSON is stored as text and parsed by crhs, because the shapes belong to the application. JSONB is not
  used: it reorders keys and rejects some escapes.
- Timestamps are ISO 8601 UTC strings; booleans are 0 and 1.
- 64-bit counters are `bigint` on PostgreSQL, which the driver returns as strings; crhs converts them
  where it reads them.

On SQLite, crhs and pi-durable use two connections to the same file. `node:sqlite` is synchronous, so
the connections must never wait on each other's write lock: all statements from both pass through one
queue, and a transaction holds the queue from `BEGIN IMMEDIATE` to its end. SQLite runs in WAL mode
with `synchronous = NORMAL`: a crash of crhs loses nothing committed, but a power loss can drop the last
few transactions without corrupting the database. Installations that need more use PostgreSQL.

On PostgreSQL (14 or newer recommended), crhs sets lz4 compression on the conversation records at every
start. This is not a migration, so that a database upgraded to a version with lz4 later still gets it.

## Naming and identifiers

Every reference stores the referenced UUID. Exceptions: an authorization's id is the SHA-256 of its
payload, so it can be verified; audit events are ordered by a database-assigned sequence number; and
durable rows have pi-durable's own ids.

Nodes and node groups share one case-insensitive namespace ([Node groups and names](access-control.md#node-groups-and-names)).
Each stores the name as given and its lowercase key; uniqueness within a table is a database constraint,
and across the two tables crhs checks it in the same transaction.

Foreign keys exist where the target is fixed and the row should go with its parent. They are absent
where the reference is polymorphic (shares, access grants), where history must outlive its subject (a
task's node and group), and for references into durable tables, which pi-durable owns through its own
connection. Those deletions are handled explicitly.

`org_id` is on every organization-scoped table. There is only one organization, but carrying the column
from the start means a second one needs no schema change ([User model](access-control.md#user-model)).

## Schema migrations

Migrations are numbered TypeScript files, listed explicitly rather than discovered, so a source checkout
and a bundled build run the same set. crhs runs pending migrations at startup, before serving. The chain
starts at one initial migration that creates the whole schema; from the first release, migrations are
append-only.

- Each migration runs on both dialects and is self-contained: helpers it needs are copied into it, so a
  later change in the application cannot change what an old migration does.
- All pending migrations run in one transaction, also on SQLite, where crhs enables transactional DDL
  that Kysely does not assume. A failed upgrade leaves the schema exactly as it was.
- SQLite cannot alter constraints or drop columns used in foreign keys, so such migrations rebuild the
  table. Foreign key checks stay on throughout.
- pi-durable's PostgreSQL tables have their own version chain in the adapter. A database newer than the
  binary refuses to open.

## Conversation content search

Only PostgreSQL searches message content; SQLite searches titles only. On PostgreSQL the durable adapter
adds a generated column holding the searchable text of each entry: user messages and assistant text,
not thinking, tool calls, tool output or compactions. The function that extracts it tolerates any record
shape, returning nothing instead of failing, and caps the text length. The record itself is unchanged.

Every keyword must match the title or some entry in the session tree. Matching is a substring scan
without an index. A `pg_trgm` GIN index on the column is the next step when needed; full-text search
would change tokenization and substring matching.

Adding the column rewrites the entries table once and roughly doubles the text stored per message,
compressed.

## Users and ownership

Users, user groups and their members, signing credentials (SSH keys and Passkeys), API tokens, WebUI
sessions and session shares. Passwords may be null so that future OIDC users need none; disabling is the
only account lifecycle operation. API tokens and WebUI session tokens are stored only as hashes. Shares
are polymorphic (the resource is a session, the grantee a user or user group), so they have no foreign
keys. See [Ownership, access grants and sharing](access-control.md#ownership-access-grants-and-sharing).

## System settings

The `settings` table holds one validated JSON value per org-scoped key (the low-frequency runtime
settings); a missing row means the default. crhs loads it at startup and replaces the in-memory object
on each write, so changes apply without a restart.

## User settings

`user_settings` holds one row per user: the UI and chat-bot language (`en` or `zh-CN`; null follows the
browser), the default model for new sessions (a JSON ModelRef with its thinking level), the default rule
preset, whether chat progress is shown, and the default notification account. A missing row is the
defaults, so a user has no row until they change something. A default model that a provider no longer
offers is not resolved by the server; the WebUI falls back to the session model preset and then to the
first offered model.

The default notification account is a foreign key to `channel_accounts` with `ON DELETE SET NULL`, so
unlinking an account or deleting a channel clears a default that pointed at it; disabling a user removes
the row with their accounts ([Channels](channels.md)).

## Nodes

A node row holds the node's registration state (pending or active), its Noise public key for crha nodes,
its last reported facts and privilege mode, its cached trust report, and for SSH nodes the route with
each hop's credential and pinned host fingerprint. Whether a node is online is never stored; it comes
from the live connection.

- The cached trust report and its digest bind an authorization plan to the trust state it was made
  against ([Trust cache](privilege.md#trust-cache)).
- Facts include the notes path and clock offset; run identities are not stored.
- Private keys are never in node rows. SSH private keys, model API keys, crhs's Noise key and the
  authorization signing key are in `secrets`, each encrypted with the master key, with the row id and
  kind bound into the ciphertext so it cannot be moved to another row.
- `server_meta` holds instance metadata, such as the master key identifier that detects a wrong key file
  before any secret is read.

Node groups, their members, access grants, SSH credentials and enrollment tokens (stored as hashes)
complete the node tables.

## Tasks

A task row holds the task's spec, state, actor, the rule chain and approval record, the authorization
plan, the kept output head and tail, and the result. A task group row holds its targets, the expanded
nodes, the batch settings, its state and a single approval for the whole group.

- Specs are stored in their JSON form ([JSON storage forms](protocol.md#json-storage-forms)) without the
  input bytes. Input waiting for approval is kept on the row only until dispatch.
- The `state` column is the whole lifecycle, including the terminal `cancelled` and `expired` states;
  there is no separate cancellation flag.
- `rev` is the row version used for compare-and-set writes ([Task row concurrency](execution.md#task-row-concurrency)).
- crhs never stores complete output; the complete output stays on the node.
- A task keeps no foreign key to its node or group, so history survives their deletion.
- `source_call_id` is the transcript id of the tool call that created the task or task group (model-supplied,
  so it can repeat; the latest match is used); Auto Review reads that call's name and arguments from the
  session transcript. It is null when an API token, MCP or the WebUI
  created the work, and the review then falls back to the recorded summary
  ([Auto Review](access-control.md#auto-review)).
- The approval record's `review` is either Auto Review's pending marker
  (`{ status: "pending", startedAt }`) or its settled verdict. The marker is written into the same JSON
  column as the rest of the record, so no schema change is needed, and the derived `phase` is computed
  for the API rather than stored ([Reviewing](access-control.md#auto-review)).

## Rules and authorizations

A rule set belongs to one chain root or level: a session (a root or a subagent) or an API token. A root
stores its preset and the rules added on top. A schedule also has a rule set, but only as a template: each
run's session receives a copy as its own root, so the schedule never appears in a chain. There are no user
or organization rule sets, and quotas belong to sessions, not rule sets. Approvals are not a table: each
task carries its evaluation and decision, and "always allow" writes to the chain root's rule set.

Authorizations are stored once per payload, with all signatures on it, for display and reuse. crhs does
not track revocation or use; the node does ([Used list](privilege.md#used-list)).

## Agent

A session row links a durable conversation to its owner, tree, schedule, model, title, run state, quota,
token measures and statistics ([Sessions](agent-runtime.md#sessions),
[Quota and token accounting](agent-runtime.md#quota-and-token-accounting)).

- The run state is stored so that lists can filter and sort in SQL.
- Unread markers exist only on roots.
- A per-owner creation request id makes session creation idempotent.
- `forked_from_session_id` and `forked_from_entry_id` record where a fork came from; both are null on
  every session that is not a fork. They carry no foreign key, so deleting a source leaves its forks
  intact and their origin reads as absent ([Forking](agent-runtime.md#forking)).

Model providers store their configuration and a reference to the encrypted API key. Model presets are one
row per kind.

`extensions` holds both kinds in one table, distinguished by `kind`: an MCP server's URL, behaviour flags,
availability and a reference to one encrypted `secrets` row holding the request headers, or a built-in's
row, which has no connection settings and is seeded by the migration. `extension_grants` says who may use
an extension when its availability is `granted`. `external_calls` is the small object an external approval
belongs to: its id is derived from the durable tool call key, and it carries the approval columns a task has,
the extension, tool, arguments, operation, `source_call_id` (the model's id for the tool call, which can repeat,
so it only lets Auto Review find the call in the transcript) and the state that must survive while the call is
in progress. A
terminal row keeps only its state and `finished_at` as the "already ran" marker and clears its arguments;
the result is in the transcript and the decision in the audit log. `sessions.disabled_extensions` is the
JSON list of extensions the owner turned off ([Extensions](extensions.md)). `sessions.last_used_from`
is `web`, a `channel_threads.id`, or null, recording where the session's latest user message came from, so
chat notifications can follow it ([Channels](channels.md#notifications)).

## Channels

`channels` holds one chat platform bot: its name, kind, enabled flag, a reference to one encrypted
`secrets` row holding the credentials, `config`, the JSON of kind-specific non-secret settings (a
Satori gateway's URL, platform and bot id), `link_instructions`, the plain text shown to users before
they link, and the last platform update id handled; sessions a chat starts use the user's defaults from
`user_settings`. `channel_accounts` links one platform account to one CRH
user; the same platform account cannot belong to two users. Its `language_code` is the platform's
language tag most recently reported by that account, so pushed messages can follow it when the user has
no saved locale. `channel_link_codes` stores only a code's
SHA-256 hash, its expiry and whether it was used, because the code is a one-time credential.
`channel_threads` maps a private chat (and topic, when the platform has them) to a session; while
`/new` holds a draft, `session_id` is null and `draft` is the JSON of its model, rule preset and
disabled extensions. `current` marks the chat's current session where the platform has no topics. The
user's chat preferences and session defaults are in `user_settings` ([User settings](#user-settings)).
See [Chat channels](channels.md).

## Libraries

`libraries` holds one row per user or user group library, with its limits and usage; `library_files`
holds one row per file, keyed by library id and path. The bytes are objects in the library backend under
random keys. The rows are the source of truth, and objects without a row are swept
([Metadata and objects](library.md#metadata-and-objects)). A user group with a non-empty library cannot
be deleted ([Libraries](library.md#libraries)).

## Scheduled tasks

A schedule holds its owner, message, model, budget, timetable, next run time and an optional report target:
one of the owner's linked channel accounts and a filter (`always`, `failure` or `success`). Its rules are a
rule set used as a template, copied into each run session's own root rule set at creation. A run row is
written before its session exists and is unique per schedule and fire time, so a trigger cannot fire twice;
the session id is derived from the run id, so resubmitting is idempotent. Runs are deleted with their
schedule; the sessions remain with their own rules. See [Schedule model](scheduling.md#schedule-model) and
[Reports](scheduling.md#reports).

## Audit

Audit events are ordered by a database-assigned sequence number. The table is append-only, written in
canonical JSON, and has no hash chain ([Tamper resistance](access-control.md#tamper-resistance)). A failed
audit write is logged but never fails the action, which has already happened.

## Retention

The retention settings in **System settings** set how long finished tasks and authorizations, audit
events and finished durable tool tasks are kept
([crhs configuration](../guide/reference/crhs-config.md#system-settings)). The sweep runs shortly after
startup and then hourly, in small batches, and each table is swept independently.

- Only finished tasks and task groups are deleted; anything still in progress is kept however old.
- Authorizations are deleted after their deadline has passed by the retention period.
- Terminal `external_calls` rows are always kept for one day after `finished_at`, independent of these
  settings. The row is the replay marker a tool call that reruns after a crash finds by id; a waiting or
  running call is never deleted ([External calls](extensions.md#external-calls)).
- The newest 16384 audit sequence numbers are always kept. This prevents a large forward clock jump from
  wiping the log, and keeps SQLite from reusing sequence numbers.
- Retention cannot be shorter than one day, because a tool call that reruns after a crash finds its task
  by id; deleting the task first would run the command again.

Deleting finished durable tool tasks is the only operation outside pi-durable's storage contract,
because pi-durable has no deletion API. It relies on invariants of pi-durable that must be rechecked on
every upgrade: only live tasks are scanned on recovery, terminal records are final, and the owners and
wait targets of live work never change. The sweep keeps anything that is still referenced or that it
cannot parse. Conversation content is never deleted by retention.
