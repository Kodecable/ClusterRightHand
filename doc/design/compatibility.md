# Compatibility

What a release of CRH keeps working for the deployments of earlier releases, and what it does not.
`v0.4.0-rc.1` is the first release under these rules; every later release keeps them.

A promise here is a promise to the operator: an upgrade needs no manual step beyond installing the new
release, unless the release notes name one. Behavior may still change, a default may move, a feature
may go; the release notes say so.

## What is kept

| Area | Promise | How |
|---|---|---|
| crhs database | Every release opens the database of any earlier release under these rules, SQLite or PostgreSQL. | [Database](#database) |
| crhs & crha configuration and data files | Migrated automatically on upgrade, with no manual edit: `crhs.toml` of an earlier release starts the new one unchanged, and every file crha and its privileged mode keep on a node is read by later releases. | [Configuration](#configuration) |
| CRH protocol | crhs reaches the nodes of the protocol majors it serves; a release names them. | [Protocol](#protocol) |
| `crh-priv` | crha and its privileged mode of the same release talk; they always upgrade together. | [Protocol](#protocol) |

## What is not kept

- **The HTTP API.** It serves the WebUI of the same release. Routes, fields and error codes may change
  in any release. The OpenAPI document describes the release it ships with.
- **The model-facing tools.** Tool names, parameters, result text and the system prompt are tuned
  release by release. A session's conversation keeps its old tool calls and results as history.
- **The MCP tool surface.** It follows the model-facing tools.
- **Chat channel commands and message text.**
- **Log formats.** The journal and terminal lines are for people. The privileged audit file and the
  upgrade log are kept.

## Database

- Schema changes are migrations, and migrations are append-only. A released migration is never
  edited, renamed, reordered or removed; a fix is a new migration.
- A migration runs on both SQLite and PostgreSQL and is tested on both
  ([Testing](testing/README.md)). It runs in one transaction with the migrator's bookkeeping, so a
  failure leaves the database as it was.
- Data a migration cannot convert is not dropped silently: the migration fails with the reason.
- Most crhs settings live in the database (System settings in the WebUI) and change through migrations
  like any other table.
- pi-durable's own storage is part of the database. Upgrading pi-durable is a release decision: its
  SQLite store migrates itself, and the PostgreSQL store's version chain in `server/src/storage/
  pg-durable/schema.ts` is append-only like the migrations.

## Configuration

Configuration files have no version field. Compatibility comes from the migrations that already
exist:

- **`crhs.toml`** may lose, rename or change keys, but never by hand: crhs migrates the file. A
  configuration migration is an idempotent edit recognized by the file's content (an old key is
  present), applied at startup before the strict parser reads the file, keeping comments and order,
  and written back atomically with a backup beside the file. When the file cannot be written (a
  read-only mount, a file managed by other tooling), crhs runs on the migrated content and warns. A
  new key is optional.
- **`crha.toml` and `privileged.toml`** change only through the configuration migrations of the crha
  self-upgrade ([On the node](distribution.md#on-the-node)): a migration is a list of edits keyed by
  the first release that needs them, applied before the new release's strict parser reads the file,
  keeping comments and order. Every node is upgraded by the self-upgrade or a reinstall with the
  installer; crha is not published as deb or rpm packages for now, so no node is upgraded around these
  migrations.

## Protocol

- The CRH protocol is major 1 from `v0.4.0-rc.1`, and `crh-priv` is major 1. The rules of a major are
  those of [Version negotiation](protocol.md#version-negotiation): within a major only new names are
  added, and the minor is negotiated.
- A new major is a last resort. When one comes, crhs keeps serving the previous majors as upgrade-only
  connections for the window the release names
  ([Compatibility across majors](protocol.md#compatibility-across-majors)), so the nodes can be
  upgraded from crhs.
- crhs is upgraded before its nodes. A crha newer than its crhs is not supported.
- crha and its privileged mode always come from the same release.
