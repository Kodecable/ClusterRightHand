# Data model

The server keeps its state in one relational database. The same schema runs on SQLite and PostgreSQL;
crhs's own tables are accessed through Kysely, and the agent runtime's durable tables live in the
same database under the `pi_` prefix. This document describes the crhs tables, the durable search
column, the migration mechanics and retention. How the agent runtime uses the durable tables is
described under [Storage](agent-runtime.md#storage).

## Storage backends

Both backends are supported from one schema. SQLite serves a single machine and debugging;
PostgreSQL is the deployment for a team, with many users and long-lived conversation records.
Writing the tables once in Kysely and running each migration on both dialects keeps the two backends
from diverging in behaviour.

The conventions that make one schema work on both:

- Primary keys are UUIDv7 strings (RFC 9562, monotonic counter), stored as `TEXT` in both dialects;
  there is no dialect-specific `uuid` type. The server's generator keeps ids ordered within one
  millisecond, so a table's primary-key index follows insert order.
- JSON is stored as `TEXT` and parsed by the application. `jsonb` is not used: it rejects lone
  surrogates and reorders object keys, while the shape is owned by the application. The one parse in
  the database is the conversation search function below, which reads `pi_entries.record`.
- Timestamps are ISO 8601 UTC strings in both dialects, never `timestamptz`.
- Booleans are `0` / `1` integers.
- 64-bit integers (token counters, `token_budget` and `audit_events.seq`) are `bigint` on PostgreSQL
  and `integer` on SQLite. PostgreSQL returns a bigint as a string; the server converts it where it
  reads one.

SQLite keeps everything in one file. The business tables and the durable tables are opened through
two separate connections to that file, and `node:sqlite` is synchronous, so the two connections must
not contend for the write lock: while one holds it the other's busy handler blocks the thread that
has to commit, and a deferred transaction that reads and then writes fails at once with
`SQLITE_BUSY_SNAPSHOT`. Every statement of both connections therefore passes through one queue per
file; a Kysely transaction takes the queue at `BEGIN IMMEDIATE` and keeps it until commit or
rollback. Both connections use WAL with `synchronous = NORMAL`: a process crash does not lose a
committed transaction, while a power loss or system crash can drop the last few committed
transactions but cannot corrupt the database. An installation that needs a stronger guarantee uses
the PostgreSQL backend.

PostgreSQL 14 or newer is recommended. On every start the server checks the compression of
`pi_entries.record` and sets it to lz4 when it is not already; this check is not a versioned
migration because a migration skipped before a PostgreSQL upgrade would never run again. Only values
written afterwards are compressed, and only rows above the roughly 2 KB TOAST threshold are
compressed in practice; existing rows keep their compression. A server older than 14, or a build
without lz4, logs a warning and is left uncompressed. SQLite has no transparent compression and is
suited to debugging and small installations, not to a production deployment.

The durable tables are pi-durable's own: `pi_conversations`, `pi_entries`, `pi_tasks`,
`pi_submissions`, `pi_documents` and `pi_document_revisions`, with the metadata tables
`pi_durable_metadata`, `pi_durable_schema` and `pi_record_ids`. SQLite uses pi-durable's official
storage; PostgreSQL uses the ported `PgStorage`. They are not described here except for the
generated search column, and retention touches `pi_tasks` and its documents; see
[Retention](#retention).

## Naming and identifiers

A primary key is a UUIDv7 in text form, and every reference stores the same text. The exceptions are
`authorizations.id`, which is the hex SHA-256 of the payload bytes so the id can be verified,
`audit_events.seq`, which is a database-generated integer, and the durable tables, whose ids are
bigints assigned by pi-durable.

Node and node-group names share one case-insensitive namespace per organization. A name is 2 to 64
characters, starts with a letter, ends with a letter or digit, and contains only letters, digits,
`.`, `_`, `/` and `-`. A name starting with `_` is reserved for the system, and `_all` is the only
such name: it is a target that matches every node the acting user can operate. The stored `name`
keeps the caller's case, and `name_key` is its lowercase form, used for uniqueness and lookup.
Uniqueness is enforced per table by `(org_id, name_key)`, and across the two tables by the
application in the transaction that writes the row, so a node cannot take a group's name or the
other way round. Because SQLite cannot add a `NOT NULL` column without a default, `name_key` is
nullable in the database; every write sets it.

Internal references store UUIDs, never names: rule targets, access grants, task-group targets and
session links survive a rename without being rewritten. `_all` is stored as written. A foreign key
exists where the target table is fixed and the row must go with its parent. There is none where the
reference is polymorphic (`shares.resource_id` and `grantee_id`, `node_access_grants.grantee_id` and
`target_id`) or where history must outlive its subject (`tasks.node_id`, `tasks.task_group_id`);
those deletions are handled explicitly. References to durable rows, such as a session's
`conversation_id` and `last_submission_id`, are text ids without a foreign key because the durable
storage owns those tables through its own connection.

`org_id` is present on organization-scoped tables. There is one organization today, so it is
redundant in practice, but it is carried from the start so that a second one needs no schema change.
Join tables and `web_sessions` do not carry it; see [User model](access-control.md#user-model).

## Schema migrations

Migrations are numbered TypeScript files in `server/src/storage/migrations/`, named `NNNN_name`.
`server/src/storage/migrate.ts` lists them explicitly rather than scanning the directory, so a
source checkout and a bundled build run the same set. `main.ts` runs every pending migration at
startup, before the server serves requests.

Kysely's `Migrator` applies them. Each migration must run on both SQLite and PostgreSQL; a few
branch on the dialect (`isPostgres`) where a column exists only there or a table has to be rebuilt.
A migration is self-contained: helpers such as the UUID generator or the name normalizer are copied
into it, so a later change to the application cannot silently change what an old migration does.

The whole batch of pending migrations, together with the migrator's bookkeeping rows, runs in one
transaction. SQLite's DDL is transactional, but Kysely's `SqliteAdapter` reports
`supportsTransactionalDdl` as false, so `migrate.ts` turns that flag on for this instance; the batch
then runs inside one `BEGIN IMMEDIATE` and a failure halfway through leaves both the schema and the
`kysely_migration` table exactly as they were. PostgreSQL already reports the capability and is
unaffected. The migrator's lock row serializes two server processes that start at the same time.

SQLite cannot drop a column that belongs to a foreign key, and it cannot alter a constraint in
place, so those migrations rebuild the table: create the replacement, copy the rows, drop the old
table and rename the new one. Foreign keys stay on (`PRAGMA foreign_keys = ON`) throughout. When a
parent table has to be dropped, the dependent rows are first copied into a table without a foreign
key, the child table is dropped, the parent is rebuilt and the child is recreated and reloaded; no
migration turns foreign keys off. PostgreSQL can drop such a column directly, which is one of the
places where a migration branches.

The durable side has its own migration chain. `pg-durable` keeps a version in `pi_durable_schema`,
requires contiguous versions starting at 1, takes an advisory lock and applies the pending versions
in one transaction; a database whose version is newer than the binary fails to open. In that chain,
version 2 added the conversation search function and column described next.

## Conversation content search

Only PostgreSQL supports searching message content. SQLite searches titles only and reports
`contentSearch: false`. On PostgreSQL the adapter's schema version 2 adds a function and a stored
generated column:

```sql
CREATE FUNCTION pi_entry_search_text(record text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ ... $$;
ALTER TABLE pi_entries ADD COLUMN search_text TEXT
  GENERATED ALWAYS AS (pi_entry_search_text(record)) STORED;
```

With the default `pi_` prefix the function is `pi_entry_search_text` and the column is
`pi_entries.search_text`. The function parses `record::jsonb` and joins, in message order and
separated by newlines, the `pi.user` messages whose role is `user` and the `pi.assistant` messages'
`text` blocks. A user message contributes its whole `content` when that is a string, or the `text`
items when it is an array. Thinking, tool calls, tool results, system prompts and compactions never
contribute, and a record with no such text yields `NULL`. Every step checks `jsonb_typeof` first, so
an unexpected shape, such as a `model` that is not an array or a `text` that is not a string, yields
`NULL` instead of an error. The result is cut to 32768 characters, and the search runs only over
that text.

The record itself stays in `record` as written; the generated column only parses it. It is computed
on every insert, and the adapter's insert lists its columns explicitly, so the write path is
unchanged; the read path does not depend on the column. An existing database gets the function and
the column at the next `PgStorage.open()`, through the version 2 durable migration in the same batch
as a new database. `ADD COLUMN ... STORED` rewrites `pi_entries` and computes every historical
record, so a large table needs extra time and disk while the table is locked. Each user and
assistant record also stores up to 32768 characters of text, at most about 128 KiB in UTF-8,
compressed through TOAST: the space that search costs.

A search query is split into at most eight whitespace-separated keywords, and every keyword must
match either the session title or some entry of the session tree; the matching entries are returned
as hits. The content match is `lower(search_text) LIKE '%keyword%'` over a scan, with no index on
`search_text`. As the content grows, the first option is a `pg_trgm` GIN index
(`gin (search_text gin_trgm_ops)`); a `tsvector` full-text index is the next step and would change
tokenization and substring matching.

## Users and ownership

There is one organization. Every user belongs to it, and the organization is the owner of nodes,
credentials and other shared resources.

```text
orgs               (id, name, created_at)
users              (id, org_id, username, display_name, email nullable,
                    kind[admin|member], password_hash nullable,
                    status[active|disabled], created_at)
                   -- unique (org_id, username)
user_groups        (id, org_id, name, source[local], created_at)
                   -- unique (org_id, name)
user_group_members (user_group_id, user_id, created_at)          -- PK (user_group_id, user_id)
user_credentials   (id, user_id, kind[ssh|webauthn], name, public_key,
                    fingerprint nullable, credential_id nullable,
                    rp_id nullable, origins json nullable, created_at)
                   -- unique (user_id, fingerprint), unique (user_id, credential_id)
api_tokens         (id, org_id, user_id, name, token_hash unique,
                    created_at, expires_at nullable, revoked_at nullable,
                    last_used_at nullable)
web_sessions       (id, token_hash unique, user_id, created_at, expires_at,
                    last_seen_at, ip nullable, user_agent nullable)
shares             (id, org_id, resource_type[session], resource_id,
                    grantee_type[user|user_group], grantee_id, access[view|chat],
                    created_by_user_id, created_at)
                   -- unique (resource_type, resource_id, grantee_type, grantee_id)
```

A username is trimmed and lowercased before it is stored; it is 1 to 64 characters of `a-z`, `0-9`,
`.`, `_` and `-`, starting with a letter or digit, and unique per organization. `display_name`
defaults to the username and `email` is optional. `password_hash` is nullable because a future OIDC
user has no password (`user_identities` is the reserved table), and `status` is `active` or
`disabled`; disabling is the only account lifecycle operation.

A credential is an SSH public key or a WebAuthn Passkey. The SSH form keeps an `authorized_keys`
line and its `SHA256:` fingerprint; the WebAuthn form keeps the COSE public key, the credential id,
the relying-party id and the origins the credential was registered for. `name` is the user's label.
There is no last-used timestamp.

An API token secret is `crh_` followed by 32 random bytes in base64url; only the hex SHA-256 is
stored. A token has an optional expiry and a revocation timestamp, and records when it was last
used. It is a rule-chain root: its rules live in `rule_sets` with `scope_type = api_token`.

A web session stores the hex SHA-256 of a random 32-byte cookie token, never the token itself. Rows
are deleted with their user (`ON DELETE CASCADE`), and they carry no `org_id`.

A share grants another user or a user group access to a session, `view` or `chat`; sessions are the
only shareable resource. Nodes are handled by `node_access_grants` instead. The resource and grantee
ids are polymorphic, so there is no foreign key; uniqueness keeps one row per resource and grantee.
See [Ownership, access grants and sharing](access-control.md#ownership-access-grants-and-sharing).

## Nodes

```text
nodes              (id, org_id, name, name_key,
                    transport[client|ssh], status[pending|active|disabled],
                    public_key unique nullable,      -- client node: base64 X25519 static key
                    hostname nullable,               -- enrollment hostname or SSH host
                    facts json nullable,             -- last Facts event
                    client_version nullable,
                    privileged_mode nullable,        -- last hello: forward|native|ignore|reject
                    last_seen_at nullable,
                    approved_at nullable, approved_by_user_id nullable,
                    ssh_host nullable, ssh_port nullable, ssh_user nullable,
                    ssh_host_key nullable,           -- pinned "SHA256:…"
                    ssh_credential_id nullable, ssh_jumps json nullable,
                    trust_report json nullable,      -- last trust.summary
                    trust_digest nullable,           -- hex SHA-256 of the CBOR summary
                    trust_updated_at nullable,
                    created_at)
node_groups        (id, org_id, name, name_key, created_at, updated_at)
                   -- unique (org_id, name_key)
node_group_members (node_group_id, node_id)                       -- PK; both cascade
node_access_grants (id, org_id, grantee_type[user|user_group], grantee_id,
                    target_type[node|node_group], target_id,
                    created_by_user_id, created_at)
                   -- unique (grantee_type, grantee_id, target_type, target_id)
ssh_credentials    (id, org_id, name, public_key, secret_id, created_at)
enrollment_tokens  (id, org_id, created_by_user_id, token_hash unique,
                    name_hint nullable, expires_at, used_at nullable,
                    used_by_node_id nullable, created_at)
server_meta        (key, value)
secrets            (id, org_id, kind, ciphertext, created_at)
```

A node is `pending` until an administrator approves it, which sets `approved_at` and
`approved_by_user_id` and makes it `active`; an administrator can also disable it. An SSH node is
created directly by an administrator and starts `active`. Whether a node is online is derived from
its live connection and is never stored: `status` is the lifecycle state, and `last_seen_at` records
the last time crhs saw the node. A client node's `public_key` is its Noise static key and is unique.

`facts` holds the last `Facts` event as JSON: hostname, operating system, kernel, architecture, init
system, package managers, privilege tools, shells, clock offset and the notes path. The notes path
therefore lives in `facts`, not in a column; an SSH node has no crha Facts and no notes, as
described under [Node notes](agent-runtime.md#node-notes). Run identities are not stored either:
they arrive inside the node's trust summary and are used at runtime.

`trust_report`, `trust_digest` and `trust_updated_at` are the cached result of the last
`trust.summary` event: the trust report as JSON, the hex SHA-256 of the CBOR summary and the time it
was received. All three are null before the first summary, and the digest is null unless the report
is a usable summary. crha pushes this summary on connection and on change; crhs never queries it. The
digest is what binds an authorization to the trust state it was planned against, as described under
[Trust cache](privilege.md#trust-cache). `privileged_mode` is the last value the node reported in
`hello`; it is null for an SSH node.

An SSH node additionally carries its host, port, user and pinned host key, plus an ordered
`ssh_jumps` list whose entries each have their own host key, and a reference to the organization's
SSH credential. The private key is in `secrets`, never in the node row. An SSH node ignores the
privileged mode.

A node group is an administrator-managed collection of nodes; membership cascades with either side.
A node access grant gives one user or user group access to one node or node group, at one level
(view and run tasks). The grantee and target ids are polymorphic, so there are no foreign keys; when
a grantee or target is deleted its grants are deleted explicitly. See
[Node groups and names](access-control.md#node-groups-and-names) and
[Ownership, access grants and sharing](access-control.md#ownership-access-grants-and-sharing).

An SSH credential is organization-owned and administrator-managed: its `public_key` is kept in the
row and its private key is a `secret`. An enrollment token stores the hex SHA-256 of its secret, an
optional name hint, an expiry and the node that used it; a node registered with a token starts
`pending` and belongs to the organization.

`server_meta` is a small key/value store for instance metadata. `master_key_id` detects a wrong
master-key file before any secret is read, and one-time backfill markers record that a data fix has
run.

`secrets` stores encrypted values. Each row is encrypted with the instance master key, and its id and
`kind` are bound into the ciphertext as associated data, so a ciphertext moved to another row or kind
does not decrypt. The kinds are `server_identity_key` (crhs's Noise key), `ssh_private_key`,
`model_api_key` and `authorization_signing_key`.

## Tasks

```text
task_groups    (id, org_id, targets json, node_ids json, kind, parallel, fail_fast,
                output_mode[status|text|head], node_max_lines nullable, node_max_bytes nullable,
                privileged 0|1, skipped json,
                spec json nullable, timeout_ms nullable, pending_input nullable,
                state[awaiting_approval|awaiting_authorization|running|finished|interrupted|rejected|cancelled],
                rule_chain json nullable, approval json nullable, root_session_id nullable,
                handler_type[agent|user] nullable, handler_session_id nullable,
                actor_type, actor_id, on_behalf_of_user_id, created_at, finished_at nullable)

tasks          (id, org_id, node_id, task_group_id nullable, kind,
                spec json, input_size nullable, input_sha256 nullable,
                privileged 0|1, attempt, rev,
                timeout_ms nullable, output_mode[full|text|status|head],
                max_lines nullable, max_bytes nullable,
                state[awaiting_approval|awaiting_authorization|denied|dispatched|running|exited|failed|rejected|unknown],
                exit_code nullable, signal nullable, timed_out 0|1, cancelled 0|1,
                error_code nullable, error_message nullable,
                actor_type, actor_id, on_behalf_of_user_id,
                rule_chain json nullable, approval json nullable, pending_input nullable,
                root_session_id nullable, handler_type[agent|user] nullable,
                handler_session_id nullable, authorization json nullable,
                created_at, dispatched_at nullable, accepted_at nullable, finished_at nullable,
                output_bytes, output_head nullable, output_tail nullable,
                notice nullable, output_lines nullable, output_file nullable,
                result json nullable, late_result nullable)
```

A task group stores the input targets as resolved node or node-group UUIDs, or `_all`, and the
expanded node ids in `node_ids`; `parallel` and `fail_fast` drive the batch. Its output mode is
`status`, `text` or `head`: a new `exec` group defaults to `status`, and a file-operation group is
fixed to `head`. `node_max_lines` and `node_max_bytes` cap each node's kept output; null takes 128
lines and 8 KiB, and the group draws on a shared total of 2000 lines and 50 KiB. `skipped` lists the
node ids that never started because of `fail_fast`, an interruption or a cancellation. The group
carries `privileged` when its tasks are privileged, and one approval covers the whole group.

`tasks.spec` and `task_groups.spec` hold the `TaskSpec` JSON of
[JSON storage forms](protocol.md#json-storage-forms), without the input bytes; `input_size` and
`input_sha256` summarize the bytes that were sent. A task's spec is interpreted by the protocol
decoder when it is approved or dispatched; a stored spec the decoder cannot read fails with
`stored spec cannot be read`.

`attempt` starts at 1 and increases only for the authorization retry described under
[No duplicate execution and authorization retry](execution.md#no-duplicate-execution-and-authorization-retry).
`rev` is the row version: it starts at 0, every write through the task store replaces it with
`rev + 1`, and a write derived from an earlier read names the `rev` it read, so a row changed in the
meantime is not overwritten with a stale decision. See
[Task row concurrency](execution.md#task-row-concurrency). The state values and their transitions
are the ones in [State machine](execution.md#state-machine); `error_code` carries an executor error,
a client rejection or the reason a task is `unknown`, such as `policy_denied`,
`approval_rejected`, `approval_required`, `node_offline` or `node_deleted`.

The approval columns are shared by the two tables: `rule_chain` is the JSON chain from the root,
`approval` is the evaluation and decision record, `pending_input` is base64 input kept only while
waiting, `root_session_id` locates the session tree, and `handler_type` with `handler_session_id`
names the agent session that handles the wait, or the user when it is `user`. `authorization` on a
task is its authorization plan and state: plan, payload id, attempt, trust digest, tried paths and
the last rejection.

Output is one stream. `output_bytes` is its byte total; `output_head` and `output_tail` are the kept
truncated head and tail, base64; `output_lines` is the total line count of the merged output,
reported by crha or counted by crhs for an SSH node; `output_file` is the path of the full output
that crha keeps on the node, when it does. crhs never stores the full output, SSH nodes keep none,
and `notice` is crhs's own line about the task (the SSH privilege notice), not part of the stream.
A batch's kept output follows the per-node and shared budgets. See
[Output](execution.md#output) and [Batch output](execution.md#batch-output). `result` is
the structured result of a file task, and `late_result` is the result that arrived after the task had
already been reported `unknown`.

`node_id` and `task_group_id` have no foreign key, so task history survives the deletion of its node
or group. Deleting a node ends the tasks on it that are still waiting for approval or a signature
with `failed` and `error_code = node_deleted`; a task whose node is gone can never be dispatched.
The indexes cover the lookups the state machine makes: `tasks (node_id, state)`, `tasks (state)`,
`tasks (task_group_id)`, the handler and root-session columns on both tables, and `finished_at` on
both for retention.

## Rules and authorizations

```text
authorizations  (id,                              -- hex SHA-256 of the payload bytes
                 org_id, payload,                 -- base64 of the CBOR payload, kept verbatim
                 signatures,                      -- JSON Signature[]
                 issuer_user_id nullable,         -- null for a crhs-only authorization
                 task_ids nullable,               -- JSON string[]; null means reusable
                 deadline nullable,               -- a null row is never accepted as reusable
                 created_at)
rule_sets       (id, org_id, scope_type[session|schedule|api_token], scope_id,
                 rule_preset[ask|auto_review|yolo] nullable,
                 default_action[allow|inherit|require-approval|deny],
                 rules json, updated_at)
                 -- unique (scope_type, scope_id)
```

An authorization is stored once per payload. `id` is the hex SHA-256 of the payload bytes and
`payload` keeps those bytes base64, so the id stays verifiable. `signatures` is the JSON array of
signatures on that one payload: a user signature and a crhs cosignature share the row, and there is
no separate cosignature object. `issuer_user_id` is the user who signed, or null when crhs issued
and signed the authorization alone. `task_ids` binds a one-shot authorization to those task ids;
null makes the authorization reusable. The deadline is what bounds the authorization; a row with a
null deadline is refused by a node and is never reused. The addressed nodes, the command limit and
the attempt live inside the CBOR payload; the row stores the issuer, the bound task ids and the
deadline, with indexes on `(org_id, created_at)` and `deadline`.

An authorization is display and reuse material: crhs does not track revocation, and a task's
execution is authorized by the node, which re-verifies the payload against its trust configuration.
To stop an authorization from being accepted, change the node's trust configuration; see
[Revoking trust](privilege.md#revoking-trust). The used list that prevents a one-shot authorization
from running twice is node-side state and is not stored in this database; see
[Used list](privilege.md#used-list). Retention deletes authorization rows past their deadline, see
[Retention](#retention).

A rule set belongs to one scope: a session, a schedule or an API token. `rule_preset` is set only on
a root, where it determines `default_action` and the preset rules; `rules` holds the rules added on
top of the preset. Rule targets store node or node-group UUIDs, or `_all`. There are no user or
organization rule sets, and quota is not part of a rule set: it lives on the session. See
[Rules](access-control.md#rules) and [Rule chain](access-control.md#rule-chain).

Approval results are not a table. A task or task group carries its evaluation and decision as
described above; "always allow" is a write to the matching `rule_sets` row. Waiting approvals are
found through `root_session_id` and the handler columns, which the API and the restart
reconciliation both use. See [Approvals](access-control.md#approvals).

## Agent

```text
sessions           (id, org_id, owner_user_id, conversation_id unique,
                    parent_session_id nullable, root_session_id nullable,
                    schedule_id nullable,              -- FK schedules, set null on delete
                    title nullable, title_pending 0|1,
                    create_request_id nullable,        -- unique per owner
                    model json, status[active|archived],
                    created_at, updated_at, archived_at nullable,
                    last_submission_id nullable,
                    state[idle|running|awaiting],
                    waiting_kind[quota|approval|authorization] nullable,
                    waiting_level_id nullable, waiting_handler_id nullable,
                    state_changed_at nullable,
                    reply_at nullable, owner_read_at nullable,      -- roots only
                    quota_tokens nullable,             -- signed; null means unlimited
                    budget_used_tokens, usage_tokens, context_tokens nullable,
                    stat_turns, stat_steps, stat_ttft_ms, stat_ttft_steps,
                    stat_decode_ms, stat_decode_tokens,
                    counted_submission_id nullable,
                    prompt_tokens, cache_read_tokens)

model_providers    (id, org_id, provider_id unique, kind[builtin|custom],
                    builtin nullable, name, base_url nullable, secret_id nullable,
                    models json nullable, headers json nullable,
                    session_id json nullable, enabled 0|1,
                    created_at, updated_at)

model_presets      (org_id, kind[session|review|title], model json nullable,
                    system_prompt nullable, updated_at)
                    -- PK (org_id, kind)
```

A session is one conversation in a tree. `root_session_id` points at the tree's root (the session
itself for a root); the column is nullable only because SQLite cannot add a `NOT NULL` column
without a default, and every write sets it. `parent_session_id` is null for a root.
`conversation_id`, `last_submission_id` and `counted_submission_id` are durable ids stored as text
without a foreign key. `schedule_id` is the schedule whose run created the root session and is set
to null when the schedule is deleted.
`title_pending` marks a title that still wants generating, and a null `title` shows the WebUI's
localized default. `create_request_id` is unique per owner, which makes creating a session from a
retried request idempotent.

`state` is `idle`, `running` or `awaiting`; while awaiting, `waiting_kind` says whether the session
waits for quota, an approval or a signature, `waiting_level_id` names the exhausted quota level, and
`waiting_handler_id` names the parent agent that handles it (null for the root, which its owner
handles). `reply_at` and `owner_read_at` exist only on roots and drive the unread marker. See
[Session state](agent-runtime.md#session-state) and [Sessions](agent-runtime.md#sessions).

`quota_tokens` is the remaining quota at that level and may be negative after one overspent call;
null means unlimited. `budget_used_tokens` counts the output tokens of the session and its subagents
and decides when a quota pauses work, while `usage_tokens` counts input plus output and is for
display; both accumulate up the tree. `context_tokens` is the input size of this session's own last
main-agent call, written by no other caller. The `stat_*` columns and `counted_submission_id`
describe only this session's own main-agent calls: turns, steps, time to first token, decode time and
decoded tokens. `prompt_tokens` and `cache_read_tokens` accumulate up the tree like `usage_tokens`.
The definitions and the backfill are in
[Quota and token accounting](agent-runtime.md#quota-and-token-accounting) and
[Session statistics](agent-runtime.md#session-statistics).

A model provider is a Pi built-in (`kind = builtin`) or a custom provider. A custom provider has a
base URL and a `models` list of `{ id, name, api, contextWindow, maxTokens, input, thinking, compat }`
entries; `provider_id` is unique. The API key itself is a `secrets` row; the provider keeps only
`secret_id`. `headers` holds only gateway routing headers, not credentials, and `session_id` names
the header or body fields that carry the crh session id. See
[Custom providers](agent-runtime.md#custom-providers).

A model preset is one row per organization and kind. A null `model` means the preset does not choose
one; the session preset never chooses one because each session names its own model. A null
`system_prompt` uses the built-in prompt, and the protocol text is fixed in code and always
appended. See [Model presets](agent-runtime.md#model-presets).

## Scheduled tasks

```text
schedules      (id, org_id, owner_user_id, name, prompt, model json,
                token_budget nullable,        -- each run's root quota; bigint; null unlimited
                cron, timezone, catch_up 0|1, enabled 0|1,
                next_run_at nullable,         -- ISO 8601; null while disabled
                created_at, updated_at)

schedule_runs  (id, schedule_id, fire_time, manual 0|1,
                status[pending|running|succeeded|failed|preempted],
                session_id nullable,          -- derived from the run id
                reason nullable, created_at, started_at nullable, finished_at nullable)
                -- unique (schedule_id, fire_time)
```

A schedule's rule preset and extra rules are a `rule_sets` row with `scope_type = schedule`; the
schedule is the root of its sessions' chain. `token_budget` is copied onto each run's new root
session as its remaining quota. `next_run_at` drives the scheduler's wake-up and is null while the
schedule is disabled.

A run row is written before its session exists, unique on the schedule and fire time. `session_id`
is derived from the run id, which makes a repeated submit idempotent; `reason` explains a `failed` or
`preempted` outcome. Runs are deleted with their schedule by `ON DELETE CASCADE`; the sessions stay
and their `schedule_id` becomes null. `schedule_runs` is not covered by retention and is kept until
the schedule is deleted. See [Schedule model](scheduling.md#schedule-model),
[Triggering and submission](scheduling.md#triggering-and-submission) and
[One instance at a time](scheduling.md#one-instance-at-a-time).

## Audit

```text
audit_events   (seq,                            -- database-generated; ordering key
                id, org_id, ts,
                actor_type, actor_id, on_behalf_of_user_id nullable,
                action, target_type nullable, target_id nullable,
                detail json)                    -- canonical JSON
```

`seq` is assigned by the database: SQLite's `rowid` (an `integer primary key` without
`AUTOINCREMENT`, so an insert that omits it gets `max(rowid) + 1`) or PostgreSQL's identity bigint.
It is monotonic in practice and is the ordering key; it is not gap-free, and SQLite can reuse a
number after the highest row is deleted, which retention avoids by keeping the highest sequence
numbers. `id` is a UUID and is unique. `org_id` has no foreign key.

`ts` is the write time in ISO 8601 UTC. `actor_type` and `actor_id` name the actor, for example
`user`, `system`, `api_token`, `subagent` or `schedule`; `on_behalf_of_user_id` is the user an actor
stands for. `action` is a dotted verb such as `task.created`; the target type and id are optional.
`detail` is canonical JSON with sorted keys and no whitespace.

Indexes cover the target pair, the timestamp and the user an event was done on behalf of, which the
audit API filters on. The table is append-only. There is no hash chain: the hash was unkeyed and
could be recomputed by anyone who could edit the rows, so tamper evidence comes from exporting
events outside crhs instead. An audit write that fails is logged and never thrown, because the action
it describes has already happened. See [Recorded events](access-control.md#recorded-events) and
[Tamper resistance](access-control.md#tamper-resistance).

## Retention

The `[retention]` table of `crhs.toml` decides when old rows are deleted:

```toml
[retention]
tasks = "90d"    # tasks, task groups and authorizations; "off" keeps them forever
audit = "180d"   # audit events; "off" keeps them forever
pi_tasks = "7d"  # finished durable agent tasks; "off" keeps them forever
```

A duration combines `ms`, `s`, `m`, `h` and `d`, as in `1d12h`; `off` disables that cleanup, an
absent key takes the default, and a value shorter than one day fails startup. The one-day
floor exists because a durable tool call that reruns after a crash reattaches to its cluster task by
id; deleting that task row first would dispatch the command a second time.

The sweep runs 5 seconds after startup, so it does not delay serving, and then runs hourly. Each
table is swept on its own: a failure is logged and leaves that table's count at zero for the run.
Rows are read and deleted in batches of 1000, by primary key, and the sweep yields between batches.
Shutdown aborts the sweep between batches and waits for the current one. The rules per table:

- `tasks` deletes only terminal rows (`exited`, `failed`, `rejected`, `unknown`, `denied`) whose
  `finished_at` is before the cutoff. A non-terminal row, or one without `finished_at`, is kept
  however old it is.
- `task_groups` deletes only terminal groups (`finished`, `interrupted`, `rejected`, `cancelled`)
  whose `finished_at` is before the cutoff.
- `authorizations` deletes rows whose `deadline` is before the cutoff; a row without a deadline is
  kept. Submitted authorizations are thus available for display and audit until this window removes
  them.
- `audit_events` deletes rows whose `ts` is before the cutoff and whose `seq` is at most
  `max(seq) - 16384`. The newest 16384 sequence numbers are kept by sequence distance, not by row
  count, and gaps are allowed. This keeps the row holding `max(seq)`, so SQLite's rowid-based
  numbering does not restart when every older row is deleted, and a large forward clock jump cannot
  wipe the whole log.
- `pi_tasks` deletes rows whose status is `terminal` and whose record has a numeric `endedAt` before
  the cutoff. In the same transaction it deletes the task-scoped documents of those tasks
  (`pi_documents` with `scope_kind = 'task'` and the task as `owner_id`) and their
  `pi_document_revisions`, then the task rows.

The `pi_tasks` step is the only operation outside pi-durable's storage contract, because pi-durable
has no deletion API. A finished task row is bookkeeping of about 1 KB per tool call, while the
conversation content it belongs to is in `pi_entries`. The step depends on invariants of the durable
storage, which must be rechecked when pi-durable is upgraded:

- Restart recovery and the task graph scan only live tasks (pending, running, waiting, sleeping and
  completing), so deleting a terminal row cannot remove work; `completing` is live and is never
  deleted.
- The owner of live work is never terminal, and the record's `owner`, a waiting task's `state.on`,
  and `pi_conversations.owner_task_id` do not change once written. Protecting every non-terminal
  task's owner and waiting targets, and every conversation's owner task, is therefore enough.
- `waitForTask` rejects an id that no longer exists, and crhs waits only on ids it has just obtained.
  The one-day floor is far beyond the life of such a wait.
- A terminal record is final, and its `endedAt` is written once.
- A task-scoped document is retired when its task becomes terminal, and its only remaining reader is
  that task's own settlement.

Rows are therefore kept regardless of age when they are non-terminal, when their record has no
numeric `endedAt`, or when they are still referenced as an owner, a waiting target or a
conversation's owner task; a record that does not parse is kept rather than guessed about.
Conversation content in `pi_entries` is not part of this cleanup. `pi_tasks` is scanned by an id
cursor, and a batch with nothing to delete is normal: that scan continues from the next id. Deleting
a schedule deletes its runs, as described under [Lifecycle](scheduling.md#lifecycle); retention
never deletes schedule rows, and it does not delete `schedule_runs` either.
