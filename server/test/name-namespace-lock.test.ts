/**
 * The shared node/node-group name namespace (util/names.ts `lockNameNamespace`): the uniqueness check
 * reads two tables, so PostgreSQL needs the organization row locked to keep two transactions from both
 * passing it (doc/design/access-control.md "Node groups and names").
 */
import { Kysely, PostgresDialect } from "kysely";
import type pg from "pg";
import { expect, it } from "vitest";
import { lockNameNamespace } from "../src/cluster/name-lock.ts";
import { createNodeGroup } from "../src/cluster/node-groups.ts";
import { renameNode } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { Database } from "../src/storage/schema.ts";
import { newId } from "../src/util/id.ts";
import { nameKey } from "../src/util/names.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

/** A Kysely on the PostgreSQL dialect whose one client records the SQL instead of connecting. */
function fakePostgres(): { db: Db; queries: string[] } {
	const queries: string[] = [];
	const client = {
		query: async (sql: string) => {
			queries.push(sql);
			return { command: "SELECT", rowCount: 1, rows: [{ id: "org-1" }], fields: [] };
		},
		release: () => {},
	};
	const pool = {
		connect: async () => client,
		end: async () => {},
		options: {},
	};
	return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool: pool as unknown as pg.Pool }) }), queries };
}

describeBackends("the node name namespace", (backend) => {
	it("locks the organization row on PostgreSQL", async () => {
		const { db, queries } = fakePostgres();
		try {
			await lockNameNamespace(db, "org-1");
		} finally {
			await db.destroy();
		}
		expect(queries).toHaveLength(1);
		expect(queries[0]).toMatch(/^select "id" from "orgs" where "id" = \$1 for update$/i);
	});

	// Opening a schema queues on the shared PostgreSQL DDL lock with every parallel test file, so this case
	// can outlast the 5s default; give it a generous limit rather than a flaky timeout.
	it("lets only one of a concurrent rename and group creation take the name", async () => {
		const db = await openTestDb(backend);
		try {
			const orgId = await defaultOrgId(db);
			const nodeId = newId();
			await db
				.insertInto("nodes")
				.values({
					id: nodeId,
					org_id: orgId,
					name: "old-name",
					name_key: "old-name",
					transport: "client",
					status: "active",
					public_key: "unused",
					hostname: "host",
					facts: null,
					client_version: null,
					privileged_mode: null,
					last_seen_at: null,
					created_at: "2026-01-01T00:00:00.000Z",
					approved_at: "2026-01-01T00:00:00.000Z",
					approved_by_user_id: null,
					ssh_host: null,
					ssh_port: null,
					ssh_user: null,
					ssh_host_fingerprint: null,
					ssh_credential_id: null,
					ssh_jumps: null,
					trust_report: null,
					trust_digest: null,
					trust_updated_at: null,
				})
				.execute();

			const outcomes = await Promise.allSettled([
				renameNode(db, nodeId, "shared-name"),
				createNodeGroup(db, orgId, "shared-name"),
			]);
			const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
			expect(fulfilled).toHaveLength(1);
			const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
			expect(rejected.reason).toMatchObject({ message: /already exists/ });

			const key = nameKey("shared-name");
			const nodes = await db
				.selectFrom("nodes")
				.select("id")
				.where("org_id", "=", orgId)
				.where("name_key", "=", key)
				.execute();
			const groups = await db
				.selectFrom("node_groups")
				.select("id")
				.where("org_id", "=", orgId)
				.where("name_key", "=", key)
				.execute();
			expect(nodes.length + groups.length).toBe(1);
		} finally {
			await db.destroy();
		}
	}, 30_000);
});
