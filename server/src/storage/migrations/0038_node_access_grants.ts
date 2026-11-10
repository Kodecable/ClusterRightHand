import { randomBytes } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { isPostgres } from "../dialect.ts";

/**
 * Nodes belong to the organization. This creates `node_access_grants`, turns ownership into access for
 * non-administrator owners, converts `operate` node shares into grants and drops `view` ones, then drops
 * `nodes.owner_user_id` and `ssh_credentials.owner_user_id`.
 *
 * SQLite cannot drop a column that is part of a foreign key, so both tables are rebuilt there (the node
 * rebuild keeps `node_group_members`, whose FK would otherwise be cascaded away with the old table). The
 * migration is self-contained (doc/design/data-model.md): the UUID helper is copied, not imported.
 */

const MAX_COUNTER = 0xfff;
let lastMs = 0;
let counter = 0;
function newId(): string {
	const rand = randomBytes(10);
	const now = Date.now();
	if (now > lastMs) {
		lastMs = now;
		counter = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x7ff;
	} else {
		counter++;
		if (counter > MAX_COUNTER) {
			lastMs++;
			counter = (((rand[0] ?? 0) << 8) | (rand[1] ?? 0)) & 0x7ff;
		}
	}
	const bytes = Buffer.alloc(16);
	bytes.writeUInt16BE(Math.floor(lastMs / 2 ** 32), 0);
	bytes.writeUInt32BE(lastMs % 2 ** 32, 2);
	bytes[6] = 0x70 | (counter >> 8);
	bytes[7] = counter & 0xff;
	bytes[8] = 0x80 | ((rand[2] ?? 0) & 0x3f);
	rand.copy(bytes, 9, 3);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface GrantRow {
	id: string;
	org_id: string;
	grantee_type: string;
	grantee_id: string;
	target_type: string;
	target_id: string;
	created_by_user_id: string;
	created_at: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on several tables
	const d = db as Kysely<any>;
	await db.schema
		.createTable("node_access_grants")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("grantee_type", "text", (c) => c.notNull())
		.addColumn("grantee_id", "text", (c) => c.notNull())
		.addColumn("target_type", "text", (c) => c.notNull())
		.addColumn("target_id", "text", (c) => c.notNull())
		.addColumn("created_by_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("node_access_grants_unique", ["grantee_type", "grantee_id", "target_type", "target_id"])
		.execute();
	await db.schema
		.createIndex("node_access_grants_grantee_idx")
		.on("node_access_grants")
		.columns(["grantee_type", "grantee_id"])
		.execute();
	await db.schema
		.createIndex("node_access_grants_target_idx")
		.on("node_access_grants")
		.columns(["target_type", "target_id"])
		.execute();

	const admins = new Set(
		(await d.selectFrom("users").select("id").where("kind", "=", "admin").execute()).map(
			(row: { id: string }) => row.id,
		),
	);
	const nodeRows: { id: string; org_id: string; owner_user_id: string; created_at: string }[] = await d
		.selectFrom("nodes")
		.select(["id", "org_id", "owner_user_id", "created_at"])
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	const grants: GrantRow[] = [];
	const grantKeys = new Set<string>();
	const addGrant = (grant: Omit<GrantRow, "id">): boolean => {
		const key = `${grant.grantee_type}\u0000${grant.grantee_id}\u0000${grant.target_type}\u0000${grant.target_id}`;
		if (grantKeys.has(key)) return false;
		grantKeys.add(key);
		grants.push({ id: newId(), ...grant });
		return true;
	};
	const counts = { owner_grants: 0, converted_operate_shares: 0, deleted_view_shares: 0 };
	for (const node of nodeRows) {
		if (admins.has(node.owner_user_id)) continue;
		if (
			addGrant({
				org_id: node.org_id,
				grantee_type: "user",
				grantee_id: node.owner_user_id,
				target_type: "node",
				target_id: node.id,
				created_by_user_id: node.owner_user_id,
				created_at: node.created_at,
			})
		) {
			counts.owner_grants++;
		}
	}

	const nodeIds = new Set(nodeRows.map((node) => node.id));
	const shares: {
		id: string;
		org_id: string;
		resource_type: string;
		resource_id: string;
		grantee_type: string;
		grantee_id: string;
		access: string;
		created_by_user_id: string;
		created_at: string;
	}[] = (await d
		.selectFrom("shares")
		.selectAll()
		.where("resource_type", "=", "node")
		.orderBy("created_at")
		.orderBy("id")
		.execute()) as {
		id: string;
		org_id: string;
		resource_type: string;
		resource_id: string;
		grantee_type: string;
		grantee_id: string;
		access: string;
		created_by_user_id: string;
		created_at: string;
	}[];
	for (const share of shares) {
		if (share.access === "view") {
			counts.deleted_view_shares++;
			continue;
		}
		if (share.access !== "operate" || !nodeIds.has(share.resource_id)) continue;
		if (
			addGrant({
				org_id: share.org_id,
				grantee_type: share.grantee_type === "user_group" ? "user_group" : "user",
				grantee_id: share.grantee_id,
				target_type: "node",
				target_id: share.resource_id,
				created_by_user_id: share.created_by_user_id,
				created_at: share.created_at,
			})
		) {
			counts.converted_operate_shares++;
		}
	}
	for (let i = 0; i < grants.length; i += 500) {
		await d
			.insertInto("node_access_grants")
			.values(grants.slice(i, i + 500))
			.execute();
	}
	// Nodes are no longer shared; sessions keep their shares.
	await d.deleteFrom("shares").where("resource_type", "=", "node").execute();

	// One audit event for the conversion, with the counts the design asks for (doc/design/access-control.md "Ownership, access grants and sharing").
	const org = await d.selectFrom("orgs").select("id").orderBy("created_at").executeTakeFirst();
	if (org) {
		await d
			.insertInto("audit_events")
			.values({
				id: newId(),
				org_id: org.id,
				ts: new Date().toISOString(),
				actor_type: "system",
				actor_id: "migration",
				on_behalf_of_user_id: null,
				action: "migration.node_access",
				target_type: "org",
				target_id: org.id,
				detail: JSON.stringify(counts),
			})
			.execute();
	}

	// SQLite refuses to drop a foreign-key column, so rebuild both tables there. PostgreSQL can drop them
	// after the index that uses nodes.owner_user_id goes away.
	await sql`drop index if exists nodes_owner_user_id_idx`.execute(db);
	if (isPostgres(db)) {
		await db.schema.alterTable("nodes").dropColumn("owner_user_id").execute();
		await db.schema.alterTable("ssh_credentials").dropColumn("owner_user_id").execute();
		return;
	}
	await rebuildSqlite(db);
}

async function rebuildSqlite(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("nodes_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("transport", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("public_key", "text", (c) => c.unique())
		.addColumn("hostname", "text")
		.addColumn("facts", "text")
		.addColumn("client_version", "text")
		.addColumn("privileged_mode", "text")
		.addColumn("last_seen_at", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("approved_at", "text")
		.addColumn("approved_by_user_id", "text", (c) => c.references("users.id"))
		.addColumn("ssh_host", "text")
		.addColumn("ssh_port", "integer")
		.addColumn("ssh_user", "text")
		.addColumn("ssh_host_key", "text")
		.addColumn("ssh_credential_id", "text")
		.addColumn("ssh_jumps", "text")
		.addColumn("trust_report", "text")
		.addColumn("trust_digest", "text")
		.addColumn("trust_updated_at", "text")
		.addColumn("name_key", "text")
		.addUniqueConstraint("nodes_org_name_unique", ["org_id", "name"])
		.execute();
	await sql`
		insert into nodes_new (
			id, org_id, name, transport, status, public_key, hostname, facts, client_version, privileged_mode,
			last_seen_at, created_at, approved_at, approved_by_user_id, ssh_host, ssh_port, ssh_user,
			ssh_host_key, ssh_credential_id, ssh_jumps, trust_report, trust_digest, trust_updated_at, name_key
		)
		select
			id, org_id, name, transport, status, public_key, hostname, facts, client_version, privileged_mode,
			last_seen_at, created_at, approved_at, approved_by_user_id, ssh_host, ssh_port, ssh_user,
			ssh_host_key, ssh_credential_id, ssh_jumps, trust_report, trust_digest, trust_updated_at, name_key
		from nodes
	`.execute(db);
	// The child table must not exist while its parent is dropped: its FK would cascade every membership away.
	await sql`create table node_group_members_saved as select node_group_id, node_id from node_group_members`.execute(db);
	await db.schema.dropTable("node_group_members").execute();
	await db.schema.dropTable("nodes").execute();
	await db.schema.alterTable("nodes_new").renameTo("nodes").execute();
	await sql`create unique index nodes_org_name_key_unique on nodes (org_id, name_key)`.execute(db);
	await db.schema
		.createTable("node_group_members")
		.addColumn("node_group_id", "text", (c) => c.notNull().references("node_groups.id").onDelete("cascade"))
		.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
		.addPrimaryKeyConstraint("node_group_members_pk", ["node_group_id", "node_id"])
		.execute();
	await sql`insert into node_group_members (node_group_id, node_id) select node_group_id, node_id from node_group_members_saved`.execute(
		db,
	);
	await db.schema.dropTable("node_group_members_saved").execute();
	await db.schema.createIndex("node_group_members_node_id_idx").on("node_group_members").column("node_id").execute();

	// ssh_credentials has no dependent rows (nodes.ssh_credential_id is a plain column), so a normal rebuild.
	await db.schema
		.createTable("ssh_credentials_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("public_key", "text", (c) => c.notNull())
		.addColumn("secret_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();
	await sql`
		insert into ssh_credentials_new (id, org_id, name, public_key, secret_id, created_at)
		select id, org_id, name, public_key, secret_id, created_at from ssh_credentials
	`.execute(db);
	await db.schema.dropTable("ssh_credentials").execute();
	await db.schema.alterTable("ssh_credentials_new").renameTo("ssh_credentials").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// The owners cannot be reconstructed: an owner chosen by the new grant model (often the old owner, but not
	// necessarily) cannot be distinguished from any other grantee. Both columns come back nullable and empty;
	// node shares deleted by `up` are not recreated.
	await db.schema.alterTable("nodes").addColumn("owner_user_id", "text").execute();
	await db.schema.alterTable("ssh_credentials").addColumn("owner_user_id", "text").execute();
	await db.schema.dropTable("node_access_grants").execute();
}
