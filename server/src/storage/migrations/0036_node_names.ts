import { randomBytes, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

/**
 * Nodes and node groups share one case-insensitive namespace per organization, references are stored
 * as UUIDs, and the old `node_groups` cache (node_id, group_name, refreshed_at) becomes crhs-managed node
 * groups with members. Existing names that do not satisfy the name rule are normalized; node groups that
 * collide with a node (or with each other) get a `-2`, `-3`, … suffix. Rule `nodes` entries are rewritten to
 * node/group UUIDs: `group:<name>` and old node names/ids resolve through the pre-migration data, and an entry
 * that resolves to nothing becomes a fresh UUID that refers to nothing (it never matches and displays as
 * deleted). Task-group targets are historical and are left unchanged.
 *
 * The name rule and normalizeName are copied here rather than imported: a migration must stay self-contained
 * (doc/design/data-model.md), and future edits to the application's normalizer must not silently change this one.
 */

const NAME_MIN = 2;
const NAME_MAX = 64;

// A copy of util/id.ts's UUIDv7 (the application's node-group ids use it too); migrations are self-contained.
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

function normalizeName(raw: string, taken: (key: string) => boolean): string {
	let name = raw.replace(/[^A-Za-z0-9._/-]/g, "-");
	if (!/^[A-Za-z]/.test(name)) name = `n-${name}`;
	name = name.replace(/[^A-Za-z0-9]+$/, "");
	if (name.length < NAME_MIN) name = name.padEnd(NAME_MIN, "0");
	if (name.length > NAME_MAX) {
		name = name.slice(0, NAME_MAX).replace(/[^A-Za-z0-9]+$/, "");
		// Truncating can cut a long run down to a single leading letter; the result still has to be a name.
		if (name.length < NAME_MIN) name = name.padEnd(NAME_MIN, "0");
	}
	const base = name;
	if (!taken(base.toLowerCase())) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
		if (!taken(candidate.toLowerCase())) return candidate;
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on several tables
	const d = db as Kysely<any>;
	// The column stays nullable in the database (SQLite cannot add a NOT NULL column without a default);
	// every row is filled below and the application always writes it.
	await db.schema.alterTable("nodes").addColumn("name_key", "text").execute();

	const taken = new Map<string, Set<string>>();
	const takenFor = (orgId: string): Set<string> => {
		let keys = taken.get(orgId);
		if (!keys) {
			keys = new Set();
			taken.set(orgId, keys);
		}
		return keys;
	};

	const nodeRows: { id: string; org_id: string; name: string; created_at: string }[] = await d
		.selectFrom("nodes")
		.select(["id", "org_id", "name", "created_at"])
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	const nodeById = new Map<string, { orgId: string }>();
	const nodeByOldName = new Map<string, string>();
	// Old names were case-sensitive; the new lookup is not. The exact spelling wins, the lowercase form is the
	// fallback so a rule written in a different case still finds the node.
	const nodeByLowerOldName = new Map<string, string>();
	for (const row of nodeRows) {
		const keys = takenFor(row.org_id);
		const name = normalizeName(String(row.name ?? ""), (key) => keys.has(key));
		const key = name.toLowerCase();
		keys.add(key);
		nodeById.set(row.id, { orgId: row.org_id });
		const oldName = String(row.name ?? "");
		const oldKey = `${row.org_id}\u0000${oldName}`;
		if (!nodeByOldName.has(oldKey)) nodeByOldName.set(oldKey, row.id);
		const lowerKey = `${row.org_id}\u0000${oldName.toLowerCase()}`;
		if (!nodeByLowerOldName.has(lowerKey)) nodeByLowerOldName.set(lowerKey, row.id);
		if (name === row.name) {
			await d.updateTable("nodes").set({ name_key: key }).where("id", "=", row.id).execute();
		} else {
			await d.updateTable("nodes").set({ name, name_key: key }).where("id", "=", row.id).execute();
		}
	}

	// The old cache rows are read before the table is replaced; a cache row whose node is gone is dropped.
	const cache: { node_id: string; group_name: string }[] = await d
		.selectFrom("node_groups")
		.select(["node_id", "group_name"])
		.execute();
	const byOldName = new Map<string, { orgId: string; oldName: string; id: string; name: string }>();
	for (const row of cache) {
		const node = nodeById.get(row.node_id);
		if (!node) {
			console.log(`0036_node_names: dropping cached group ${row.group_name} of missing node ${row.node_id}`);
			continue;
		}
		const oldName = String(row.group_name ?? "");
		// Distinct (org, group_name) exactly: two old names that differ only by case are two groups until the
		// shared namespace gives the later one a suffix.
		const key = `${node.orgId}\u0000${oldName}`;
		if (!byOldName.has(key)) byOldName.set(key, { orgId: node.orgId, oldName, id: "", name: "" });
	}
	const groupRows = [...byOldName.values()].sort(
		(a, b) => a.orgId.localeCompare(b.orgId) || a.oldName.localeCompare(b.oldName),
	);
	for (const group of groupRows) {
		const keys = takenFor(group.orgId);
		group.name = normalizeName(group.oldName, (key) => keys.has(key));
		keys.add(group.name.toLowerCase());
		group.id = newId();
	}

	await db.schema.dropTable("node_groups").execute();
	await db.schema
		.createTable("node_groups")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("node_groups_org_name_key_unique", ["org_id", "name_key"])
		.execute();
	await db.schema
		.createTable("node_group_members")
		.addColumn("node_group_id", "text", (c) => c.notNull().references("node_groups.id").onDelete("cascade"))
		.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
		.addPrimaryKeyConstraint("node_group_members_pk", ["node_group_id", "node_id"])
		.execute();
	await db.schema.createIndex("node_group_members_node_id_idx").on("node_group_members").column("node_id").execute();
	await db.schema
		.createIndex("nodes_org_name_key_unique")
		.on("nodes")
		.columns(["org_id", "name_key"])
		.unique()
		.execute();

	if (groupRows.length > 0) {
		const now = new Date().toISOString();
		await d
			.insertInto("node_groups")
			.values(
				groupRows.map((group) => ({
					id: group.id,
					org_id: group.orgId,
					name: group.name,
					name_key: group.name.toLowerCase(),
					created_at: now,
					updated_at: now,
				})),
			)
			.execute();
	}
	const members = new Set<string>();
	const memberRows: { node_group_id: string; node_id: string }[] = [];
	const groupByOldName = new Map<string, string>();
	const groupByLowerOldName = new Map<string, string>();
	for (const group of groupRows) {
		groupByOldName.set(`${group.orgId}\u0000${group.oldName}`, group.id);
		const lowerKey = `${group.orgId}\u0000${group.oldName.toLowerCase()}`;
		if (!groupByLowerOldName.has(lowerKey)) groupByLowerOldName.set(lowerKey, group.id);
	}
	for (const row of cache) {
		const node = nodeById.get(row.node_id);
		if (!node) continue;
		const groupId = groupByOldName.get(`${node.orgId}\u0000${String(row.group_name ?? "")}`);
		if (!groupId) continue;
		const key = `${groupId}\u0000${row.node_id}`;
		if (members.has(key)) continue;
		members.add(key);
		memberRows.push({ node_group_id: groupId, node_id: row.node_id });
	}
	for (let i = 0; i < memberRows.length; i += 500) {
		await d
			.insertInto("node_group_members")
			.values(memberRows.slice(i, i + 500))
			.execute();
	}

	// Rules: rewrite only `nodes` arrays. Rules without `nodes` are left exactly as they were.
	const ruleRows: { id: string; org_id: string; rules: string }[] = await d
		.selectFrom("rule_sets")
		.select(["id", "org_id", "rules"])
		.execute();
	const unresolved: string[] = [];
	for (const row of ruleRows) {
		let rules: unknown;
		try {
			rules = JSON.parse(row.rules);
		} catch (err) {
			console.warn(`0036_node_names: leaving rule set ${row.id} unchanged: ${message(err)}`);
			continue;
		}
		if (!Array.isArray(rules)) {
			console.warn(`0036_node_names: leaving rule set ${row.id} unchanged: rules is not a list`);
			continue;
		}
		let changed = false;
		for (const rule of rules) {
			if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
			const record = rule as Record<string, unknown>;
			if (!Array.isArray(record.nodes)) continue;
			const resolved: string[] = [];
			for (const entry of record.nodes) {
				let id: string | undefined;
				if (typeof entry === "string") {
					if (entry === "_all") {
						id = "_all";
					} else if (entry.startsWith("group:")) {
						const name = entry.slice("group:".length);
						id =
							groupByOldName.get(`${row.org_id}\u0000${name}`) ??
							groupByLowerOldName.get(`${row.org_id}\u0000${name.toLowerCase()}`);
					} else if (nodeById.has(entry)) {
						id = entry;
					} else {
						id =
							nodeByOldName.get(`${row.org_id}\u0000${entry}`) ??
							nodeByLowerOldName.get(`${row.org_id}\u0000${entry.toLowerCase()}`);
					}
				}
				if (id === undefined) {
					id = randomUUID();
					unresolved.push(`rule set ${row.id}: ${JSON.stringify(entry)}`);
				}
				if (!resolved.includes(id)) resolved.push(id);
			}
			record.nodes = resolved;
			changed = true;
		}
		if (!changed) continue;
		await d
			.updateTable("rule_sets")
			.set({ rules: JSON.stringify(rules) })
			.where("id", "=", row.id)
			.execute();
	}
	if (unresolved.length > 0) {
		console.log(
			"0036_node_names: node references that resolved to nothing now point at a missing object:\n" +
				unresolved.join("\n"),
		);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on several tables
	const d = db as Kysely<any>;
	// The old cache shape can be recreated from the current members; normalized names cannot be un-normalized,
	// so this only restores the old column layout, not the old spelling. Rules keep their UUID references:
	// the previous code's `group:<name>` handling cannot resolve them, which is inherent in rolling back.
	await db.schema
		.createTable("node_groups_cache")
		.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
		.addColumn("group_name", "text", (c) => c.notNull())
		.addColumn("refreshed_at", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("node_groups_cache_pk", ["node_id", "group_name"])
		.execute();
	await sql`
		insert into node_groups_cache (node_id, group_name, refreshed_at)
		select m.node_id, g.name, g.updated_at
		from node_group_members m join node_groups g on g.id = m.node_group_id
	`.execute(d);
	await db.schema.dropTable("node_group_members").execute();
	await db.schema.dropTable("node_groups").execute();
	await db.schema.alterTable("node_groups_cache").renameTo("node_groups").execute();
	await db.schema.createIndex("node_groups_group_name_idx").on("node_groups").column("group_name").execute();
	await db.schema.dropIndex("nodes_org_name_key_unique").execute();
	await db.schema.alterTable("nodes").dropColumn("name_key").execute();
}
