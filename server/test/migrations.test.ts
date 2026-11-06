import { createHash } from "node:crypto";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nonIdleSessions, sessionsWithSubmissions } from "../src/agent/session-state.ts";
import type { Db } from "../src/storage/db.ts";
import { up } from "../src/storage/migrations/0019_cbor_protocol.ts";
import { up as up0020 } from "../src/storage/migrations/0020_output_mode.ts";
import { up as up0022 } from "../src/storage/migrations/0022_m4_privilege.ts";
import { up as up0024 } from "../src/storage/migrations/0024_rule_privileged_flag.ts";
import { up as up0025 } from "../src/storage/migrations/0025_root_session_quota_null.ts";
import { up as up0029 } from "../src/storage/migrations/0029_session_state_tree.ts";
import { up as up0030 } from "../src/storage/migrations/0030_session_reconcile_indexes.ts";
import { up as up0031 } from "../src/storage/migrations/0031_task_result.ts";
import { up as up0032 } from "../src/storage/migrations/0032_token_measures.ts";
import { down as down0033, up as up0033 } from "../src/storage/migrations/0033_drop_authorization_revocation.ts";
import { down as down0034, up as up0034 } from "../src/storage/migrations/0034_drop_audit_hash_chain.ts";
import { down as down0035, up as up0035 } from "../src/storage/migrations/0035_retention_indexes.ts";
import { down as down0036, up as up0036 } from "../src/storage/migrations/0036_node_names.ts";
import { down as down0037, up as up0037 } from "../src/storage/migrations/0037_user_group_member_column.ts";
import { down as down0038, up as up0038 } from "../src/storage/migrations/0038_node_access_grants.ts";
import { down as down0039, up as up0039 } from "../src/storage/migrations/0039_output_budgets.ts";
import { down as down0040, up as up0040 } from "../src/storage/migrations/0040_one_output_stream.ts";
import { down as down0041, up as up0041 } from "../src/storage/migrations/0041_rule_preset.ts";
import { down as down0042, up as up0042 } from "../src/storage/migrations/0042_custom_model_providers.ts";
import { down as down0043, up as up0043 } from "../src/storage/migrations/0043_model_presets.ts";
import { down as down0044, up as up0044 } from "../src/storage/migrations/0044_session_title_pending.ts";
import { down as down0045, up as up0045 } from "../src/storage/migrations/0045_sessions_create_request_id.ts";
import { down as down0046, up as up0046 } from "../src/storage/migrations/0046_thinking_modes_and_labels.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { type Backend, describeBackends, openTestDb, withDdlLockOn } from "./helpers/db.ts";

/** Applies a migration's schema changes under the same DDL lock as the migrator. */
function applyMigration(backend: Backend, db: Db, migration: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
	return withDdlLockOn(backend, () => migration(db as unknown as Kysely<unknown>));
}

/**
 * Columns of the named table in this connection's own schema, or undefined when it does not exist.
 *
 * On PostgreSQL every test file gets its own schema in a shared database, and Kysely's introspector
 * enumerates all of them, so it fails when a parallel file drops its schema mid-introspection. Querying
 * information_schema.columns for current_schema() reads this connection's own schema only. SQLite has a
 * single, unnamed schema and its in-memory introspection is per-file, so that path stays introspective.
 */
async function tableColumns(backend: Backend, db: Db, name: string): Promise<string[] | undefined> {
	if (backend === "postgres") {
		const result = await sql<{ column_name: string }>`
			select column_name from information_schema.columns
			where table_schema = current_schema() and table_name = ${name}
			order by ordinal_position
		`.execute(db);
		return result.rows.length === 0 ? undefined : result.rows.map((row) => row.column_name);
	}
	const table = (await db.introspection.getTables()).find((candidate) => candidate.name === name);
	return table?.columns.map((column) => column.name);
}

const SHA = Buffer.alloc(32, 0xab).toString("base64");
const SHA_HEX = Buffer.alloc(32, 0xab).toString("hex");
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/** protobuf JSON (as protobuf-es wrote it) for every TaskSpec kind. */
const SPECS: Record<string, string> = {
	"t-exec-argv": JSON.stringify({
		exec: { argv: ["ls", "-l"], env: { A: "1" }, cwd: "/tmp", stdin: { size: "3", sha256: SHA } },
	}),
	"t-exec-shell": JSON.stringify({ exec: { shell: "ls | wc -l" } }),
	"t-read": JSON.stringify({ fileRead: { path: "/etc/hosts" } }),
	"t-read-range": JSON.stringify({ fileRead: { path: "/etc/hosts", offset: "5", limit: "10" } }),
	"t-write": JSON.stringify({ fileWrite: { path: "/tmp/x" } }),
	"t-write-content": JSON.stringify({
		fileWrite: { path: "/tmp/y", content: { size: "3", sha256: SHA }, overwrite: true, mode: 420 },
	}),
	"t-edit": JSON.stringify({ fileEdit: { path: "/tmp/z", edits: [{ oldText: "a", newText: "b" }] } }),
	"t-stat": JSON.stringify({ fileStat: { path: "/tmp/z" } }),
	"t-list": JSON.stringify({ fileList: { path: "/tmp", limit: 5 } }),
	"t-bad": "{not json",
};

const FACTS = JSON.stringify({
	hostname: "h",
	osId: "ubuntu",
	packageManagers: ["apt"],
	privilegeTools: [],
	notesPath: "/etc/notes",
	groups: ["sudo"],
	clockOffsetMs: "-5",
});

describeBackends("0019 cbor protocol migration", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("tasks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("spec", "text")
				.execute();
			await db.schema
				.createTable("task_groups")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("spec", "text")
				.addColumn("kind", "text")
				.execute();
			await db.schema
				.createTable("nodes")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("facts", "text")
				.execute();
			for (const [id, spec] of Object.entries(SPECS)) {
				await sql`insert into tasks (id, spec) values (${id}, ${spec})`.execute(db);
			}
			await sql`insert into task_groups (id, spec, kind) values (${"g1"}, ${SPECS["t-read"] as string}, ${"fileRead"})`.execute(
				db,
			);
			await sql`insert into nodes (id, facts) values (${"n1"}, ${FACTS})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("adds tasks.attempt with a default of 1", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await applyMigration(backend, db, up);
		} finally {
			warn.mockRestore();
		}
		const rows = await sql<{ id: string; attempt: number }>`select id, attempt from tasks`.execute(db);
		expect(rows.rows.length).toBe(Object.keys(SPECS).length);
		expect(rows.rows.every((row) => row.attempt === 1)).toBe(true);
	});

	it("converts every TaskSpec kind, facts and the task group kind", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await applyMigration(backend, db, up);
		} finally {
			warn.mockRestore();
		}
		const tasks = await sql<{ id: string; spec: string }>`select id, spec from tasks`.execute(db);
		const byId = new Map(
			tasks.rows.filter((row) => row.id !== "t-bad").map((row) => [row.id, JSON.parse(row.spec) as unknown]),
		);

		expect(byId.get("t-exec-argv")).toEqual({
			kind: "exec",
			command: { argv: ["ls", "-l"] },
			env: { A: "1" },
			cwd: "/tmp",
			stdin: { size: 3, sha256: SHA_HEX },
		});
		expect(byId.get("t-exec-shell")).toEqual({
			kind: "exec",
			command: { shell: "ls | wc -l" },
			env: {},
			cwd: "",
			stdin: null,
		});
		expect(byId.get("t-read")).toEqual({ kind: "file.read", path: "/etc/hosts", offset: 0, limit: 0 });
		expect(byId.get("t-read-range")).toEqual({ kind: "file.read", path: "/etc/hosts", offset: 5, limit: 10 });
		expect(byId.get("t-write")).toEqual({
			kind: "file.write",
			path: "/tmp/x",
			content: { size: 0, sha256: EMPTY_SHA256 },
			overwrite: false,
			mode: 0,
			owner: "",
			group: "",
		});
		expect(byId.get("t-write-content")).toEqual({
			kind: "file.write",
			path: "/tmp/y",
			content: { size: 3, sha256: SHA_HEX },
			overwrite: true,
			mode: 420,
			owner: "",
			group: "",
		});
		expect(byId.get("t-edit")).toEqual({
			kind: "file.edit",
			path: "/tmp/z",
			edits: [{ oldText: "a", newText: "b" }],
		});
		expect(byId.get("t-stat")).toEqual({ kind: "file.stat", path: "/tmp/z" });
		expect(byId.get("t-list")).toEqual({ kind: "file.list", path: "/tmp", limit: 5 });
		// Unparseable rows are left untouched.
		const bad = tasks.rows.find((row) => row.id === "t-bad");
		expect(bad?.spec).toBe("{not json");

		const facts = await sql<{ facts: string }>`select facts from nodes where id = 'n1'`.execute(db);
		expect(JSON.parse(facts.rows[0]?.facts as string)).toEqual({
			hostname: "h",
			osId: "ubuntu",
			osVersionId: "",
			osPrettyName: "",
			kernel: "",
			arch: "",
			initSystem: "",
			packageManagers: ["apt"],
			privilegeTools: [],
			notesPath: "/etc/notes",
			groups: ["sudo"],
			clockOffsetMs: -5,
		});

		const group = await sql<{ kind: string; spec: string }>`select kind, spec from task_groups where id = 'g1'`.execute(
			db,
		);
		expect(group.rows[0]?.kind).toBe("file.read");
		expect(JSON.parse(group.rows[0]?.spec as string)).toEqual({
			kind: "file.read",
			path: "/etc/hosts",
			offset: 0,
			limit: 0,
		});
	});

	it("logs and keeps a row whose spec cannot be converted", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await applyMigration(backend, db, up);
			expect(warn.mock.calls.some((call) => String(call[0]).includes("leaving task t-bad unchanged"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});

describeBackends("0020 output mode migration", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("tasks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await db.schema
				.createTable("task_groups")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await sql`insert into tasks (id) values (${"t1"})`.execute(db);
			await sql`insert into task_groups (id) values (${"g1"})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("gives existing tasks full output and existing groups text", async () => {
		await applyMigration(backend, db, up0020);
		const tasks = await sql<{ id: string; output_mode: string }>`select id, output_mode from tasks`.execute(db);
		expect(tasks.rows).toEqual([{ id: "t1", output_mode: "full" }]);
		const groups = await sql<{ id: string; output_mode: string }>`select id, output_mode from task_groups`.execute(db);
		expect(groups.rows).toEqual([{ id: "g1", output_mode: "text" }]);
	});
});

describeBackends("0022 M4 privilege storage", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("orgs")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await db.schema
				.createTable("users")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await db.schema
				.createTable("nodes")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await db.schema
				.createTable("tasks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await sql`insert into orgs (id) values (${"o1"})`.execute(db);
			await sql`insert into users (id) values (${"u1"})`.execute(db);
			await sql`insert into nodes (id) values (${"n1"})`.execute(db);
			await sql`insert into tasks (id) values (${"t1"})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("stores authorizations, user credentials and the trust cache", async () => {
		await applyMigration(backend, db, up0022);
		const now = new Date().toISOString();
		await db
			.insertInto("authorizations")
			.values({
				id: "ab".repeat(32),
				org_id: "o1",
				payload: Buffer.from("payload").toString("base64"),
				signatures: JSON.stringify([{ kind: "sshsig", blob: "00" }]),
				issuer_user_id: "u1",
				task_ids: JSON.stringify(["t1"]),
				deadline: now,
				created_at: now,
			})
			.execute();

		await db
			.insertInto("user_credentials")
			.values([
				{
					id: "c1",
					user_id: "u1",
					kind: "ssh",
					name: "yubikey",
					public_key: "sk-ssh-ed25519@openssh.com AAAA comment",
					fingerprint: "SHA256:abc",
					credential_id: null,
					rp_id: null,
					created_at: now,
				},
				{
					id: "c2",
					user_id: "u1",
					kind: "webauthn",
					name: "passkey",
					public_key: Buffer.from("cose").toString("base64"),
					fingerprint: null,
					credential_id: "credential-id",
					rp_id: "crh.example.com",
					created_at: now,
				},
			])
			.execute();

		await db
			.updateTable("nodes")
			.set({ trust_report: JSON.stringify({ kind: "ok" }), trust_digest: "cd".repeat(32), trust_updated_at: now })
			.where("id", "=", "n1")
			.execute();
		await db
			.updateTable("tasks")
			.set({ authorization: JSON.stringify({ plan: "crhs", attempt: 1 }) })
			.where("id", "=", "t1")
			.execute();

		const node = await db.selectFrom("nodes").selectAll().where("id", "=", "n1").executeTakeFirstOrThrow();
		expect(node.trust_digest).toBe("cd".repeat(32));
		expect(node.trust_updated_at).toBe(now);
		const task = await db.selectFrom("tasks").selectAll().where("id", "=", "t1").executeTakeFirstOrThrow();
		expect(task.authorization).toBe(JSON.stringify({ plan: "crhs", attempt: 1 }));
		const credentials = await db.selectFrom("user_credentials").selectAll().orderBy("id").execute();
		expect(credentials.map((c) => c.kind)).toEqual(["ssh", "webauthn"]);
	});

	it("keeps one credential per (user, fingerprint) and per (user, credential id)", async () => {
		await applyMigration(backend, db, up0022);
		const now = new Date().toISOString();
		const base = {
			user_id: "u1",
			kind: "ssh" as const,
			name: "key",
			public_key: "ssh-ed25519 AAAA",
			credential_id: null,
			rp_id: null,
			created_at: now,
		};
		await db
			.insertInto("user_credentials")
			.values({ ...base, id: "c1", fingerprint: "SHA256:same" })
			.execute();
		await expect(
			db
				.insertInto("user_credentials")
				.values({ ...base, id: "c2", fingerprint: "SHA256:same" })
				.execute(),
		).rejects.toThrow();

		const web = {
			user_id: "u1",
			kind: "webauthn" as const,
			name: "passkey",
			public_key: "cose",
			fingerprint: null,
			rp_id: "crh.example.com",
			created_at: now,
		};
		await db
			.insertInto("user_credentials")
			.values({ ...web, id: "c3", credential_id: "same" })
			.execute();
		await expect(
			db
				.insertInto("user_credentials")
				.values({ ...web, id: "c4", credential_id: "same" })
				.execute(),
		).rejects.toThrow();
	});
});

describeBackends("0024 rule privileged flag", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("rule_sets")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("rules", "text", (c) => c.notNull())
				.execute();
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("pins every rule without a privileged value to false", async () => {
		const rows: [string, string][] = [
			[
				"root",
				JSON.stringify([
					{ action: "allow", method: "exec", exact: "ls" },
					{ action: "deny", method: "exec", prefix: "rm", privileged: true },
					{ action: "require-approval", method: "file.write", prefix: "/etc/", privileged: false },
					{ action: "allow", method: "file.read" },
				]),
			],
			["always", JSON.stringify([{ action: "allow", method: "exec", exact: "id" }])],
			["empty", "[]"],
		];
		for (const [id, rules] of rows) {
			await sql`insert into rule_sets (id, rules) values (${id}, ${rules})`.execute(db);
		}

		await applyMigration(backend, db, up0024);

		const read = async (id: string): Promise<Record<string, unknown>[]> => {
			const row = await db.selectFrom("rule_sets").select("rules").where("id", "=", id).executeTakeFirstOrThrow();
			return JSON.parse(row.rules) as Record<string, unknown>[];
		};
		const root = await read("root");
		expect(root[0]?.privileged).toBe(false);
		expect(root[1]?.privileged).toBe(true);
		expect(root[2]?.privileged).toBe(false);
		expect(root[3]?.privileged).toBe(false);
		// "Always allow" rules are appended to the same list and get the same treatment.
		expect((await read("always"))[0]?.privileged).toBe(false);
		expect(await read("empty")).toEqual([]);

		// The rest of the rule is untouched.
		expect(root[0]).toEqual({ action: "allow", method: "exec", exact: "ls", privileged: false });

		// Running the migration again is a no-op: explicit values stay explicit.
		await applyMigration(backend, db, up0024);
		expect((await read("root"))[1]?.privileged).toBe(true);
		expect((await read("always"))[0]?.privileged).toBe(false);
	});

	it("leaves a rule set whose rules cannot be parsed unchanged", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await sql`insert into rule_sets (id, rules) values (${"broken"}, ${"{not json"})`.execute(db);
			await applyMigration(backend, db, up0024);
		} finally {
			warn.mockRestore();
		}
		const row = await db.selectFrom("rule_sets").select("rules").where("id", "=", "broken").executeTakeFirstOrThrow();
		expect(row.rules).toBe("{not json");
	});
});
describeBackends("0025 root session quota null", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("sessions")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("parent_session_id", "text")
				.addColumn("quota_tokens", "bigint")
				.execute();
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("makes a root's 0 unlimited and leaves every other quota alone", async () => {
		await sql`insert into sessions (id, parent_session_id, quota_tokens) values (${"root-zero"}, ${null}, ${0})`.execute(
			db,
		);
		await sql`insert into sessions (id, parent_session_id, quota_tokens) values (${"root-set"}, ${null}, ${500})`.execute(
			db,
		);
		await sql`insert into sessions (id, parent_session_id, quota_tokens) values (${"root-null"}, ${null}, ${null})`.execute(
			db,
		);
		await sql`insert into sessions (id, parent_session_id, quota_tokens) values (${"child-zero"}, ${"root-set"}, ${0})`.execute(
			db,
		);
		await sql`insert into sessions (id, parent_session_id, quota_tokens) values (${"child-set"}, ${"root-set"}, ${40})`.execute(
			db,
		);

		await applyMigration(backend, db, up0025);

		const rows = await db.selectFrom("sessions").select(["id", "quota_tokens"]).execute();
		const quota = new Map(rows.map((row) => [row.id, row.quota_tokens]));
		expect(quota.get("root-zero")).toBeNull();
		expect(Number(quota.get("root-set"))).toBe(500);
		expect(quota.get("root-null")).toBeNull();
		// A subagent's 0 still means "used up".
		expect(Number(quota.get("child-zero"))).toBe(0);
		expect(Number(quota.get("child-set"))).toBe(40);
	});
});

describeBackends("0029 session state and tree", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("sessions")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("parent_session_id", "text")
				.addColumn("state", "text", (c) => c.notNull())
				.addColumn("waiting_level_id", "text")
				.execute();
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("maps the old states, adds waiting kinds and backfills every tree root", async () => {
		const rows: [string, string | null, string, string | null][] = [
			["root-active", null, "active", null],
			["root-awaiting", null, "awaiting", "root-awaiting"],
			["root-unplaced", null, "awaiting", null],
			["child-stopped", "root-active", "stopped", null],
			["child-active", "root-active", "active", null],
			["grandchild", "child-active", "active", null],
		];
		for (const [id, parent, state, level] of rows) {
			await sql`insert into sessions (id, parent_session_id, state, waiting_level_id)
				values (${id}, ${parent}, ${state}, ${level})`.execute(db);
		}

		await applyMigration(backend, db, up0029);

		const byId = new Map(
			(await db.selectFrom("sessions").select(["id", "state", "waiting_kind", "root_session_id"]).execute()).map(
				(row) => [row.id, row],
			),
		);
		// A root's old `active` and a subagent's old `active`/`stopped` are all `idle`; reconciliation corrects
		// the live ones at the next start (D97).
		expect(byId.get("root-active")).toMatchObject({ state: "idle", root_session_id: "root-active" });
		expect(byId.get("child-stopped")).toMatchObject({
			state: "idle",
			waiting_kind: null,
			root_session_id: "root-active",
		});
		expect(byId.get("child-active")).toMatchObject({ state: "idle", root_session_id: "root-active" });
		// Two levels down, the recursive backfill still finds the same root.
		expect(byId.get("grandchild")).toMatchObject({ state: "idle", root_session_id: "root-active" });
		// A quota wait is marked; an awaiting row without a level is left for reconciliation.
		expect(byId.get("root-awaiting")).toMatchObject({
			state: "awaiting",
			waiting_kind: "quota",
			root_session_id: "root-awaiting",
		});
		expect(byId.get("root-unplaced")).toMatchObject({ state: "awaiting", waiting_kind: null });
		expect([...byId.values()].every((row) => row.root_session_id === row.id || row.root_session_id)).toBe(true);
	});
});

describeBackends("0030 session reconciliation indexes", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("sessions")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("state", "text", (c) => c.notNull())
				.addColumn("last_submission_id", "text")
				.execute();
			await sql`insert into sessions (id, state, last_submission_id) values
				(${"idle"}, ${"idle"}, ${null}),
				(${"idle-with-input"}, ${"idle"}, ${"input-idle"}),
				(${"running"}, ${"running"}, ${null}),
				(${"awaiting"}, ${"awaiting"}, ${"input-awaiting"})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("indexes the non-idle states and last_submission_id, and the reconciliation's queries stay correct", async () => {
		await applyMigration(backend, db, up0030);

		expect((await nonIdleSessions(db).execute()).map((row) => row.id).sort()).toEqual(["awaiting", "running"]);
		expect(
			(await sessionsWithSubmissions(db, ["input-idle", "input-awaiting"]).execute()).map((row) => row.id).sort(),
		).toEqual(["awaiting", "idle-with-input"]);
		expect(await sessionsWithSubmissions(db, ["no-such-input"]).execute()).toEqual([]);

		if (backend === "sqlite") {
			const indexes = await sql<{ name: string; sql: string }>`
				select name, sql from sqlite_master
				where type = 'index' and tbl_name = 'sessions' and name not like 'sqlite_autoindex%'
				order by name
			`.execute(db);
			expect(indexes.rows.map((row) => row.name)).toEqual(["sessions_last_submission_idx", "sessions_state_live_idx"]);
			expect(indexes.rows.find((row) => row.name === "sessions_state_live_idx")?.sql).toContain(
				"where state <> 'idle'",
			);
		}
	});

	it("lets the reconciliation's candidate queries use them", async () => {
		// EXPLAIN QUERY PLAN is SQLite's; PostgreSQL's equivalent is not exercised here.
		if (backend !== "sqlite") return;
		await applyMigration(backend, db, up0030);
		const plan = async (compiled: { sql: string; parameters: readonly unknown[] }): Promise<string> => {
			const result = await db.executeQuery<{ detail: string }>(
				CompiledQuery.raw(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.parameters]),
			);
			return result.rows.map((row) => row.detail).join("\n");
		};
		expect(await plan(nonIdleSessions(db).compile())).toContain("sessions_state_live_idx");
		expect(await plan(sessionsWithSubmissions(db, ["input-1"]).compile())).toContain("sessions_last_submission_idx");
	});
});

describeBackends("0031 task result", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("tasks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await sql`insert into tasks (id) values (${"t1"})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("adds a nullable result column and keeps the result of a task that reported one", async () => {
		await applyMigration(backend, db, up0031);
		const existing = await sql<{ id: string; result: string | null }>`select id, result from tasks`.execute(db);
		expect(existing.rows).toEqual([{ id: "t1", result: null }]);
		// The column stores the JSON form of a task's structured result (doc/protocol.md TaskResult).
		const result = JSON.stringify({ kind: "file.stat", path: "/tmp/x", type: "file", size: 3, mode: "0644" });
		await sql`insert into tasks (id, result) values (${"t2"}, ${result})`.execute(db);
		await sql`update tasks set result = ${result} where id = ${"t1"}`.execute(db);
		const rows = await sql<{ id: string; result: string | null }>`select id, result from tasks order by id`.execute(db);
		expect(rows.rows).toEqual([
			{ id: "t1", result },
			{ id: "t2", result },
		]);
	});
});

describeBackends("0032 token measures", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("sessions")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("used_tokens", "bigint", (c) => c.notNull().defaultTo(0))
				.addColumn("quota_tokens", "bigint")
				.execute();
			await sql`insert into sessions (id, used_tokens, quota_tokens) values
				(${"spent"}, ${1234}, ${5000}),
				(${"fresh"}, ${0}, ${null})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("renames the budget counter, keeps its value and adds usage and context", async () => {
		await applyMigration(backend, db, up0032);
		const rows = await sql<{
			id: string;
			budget_used_tokens: number | string;
			quota_tokens: number | string | null;
			usage_tokens: number | string;
			context_tokens: number | string | null;
		}>`select id, budget_used_tokens, quota_tokens, usage_tokens, context_tokens from sessions order by id`.execute(db);
		// PostgreSQL returns bigint as a string; the values are compared numerically.
		const numberOrNull = (value: number | string | null): number | null => (value === null ? null : Number(value));
		expect(
			rows.rows.map((row) => ({
				id: row.id,
				budget_used_tokens: numberOrNull(row.budget_used_tokens),
				quota_tokens: numberOrNull(row.quota_tokens),
				usage_tokens: numberOrNull(row.usage_tokens),
				context_tokens: numberOrNull(row.context_tokens),
			})),
		).toEqual([
			{ id: "fresh", budget_used_tokens: 0, quota_tokens: null, usage_tokens: 0, context_tokens: null },
			{ id: "spent", budget_used_tokens: 1234, quota_tokens: 5000, usage_tokens: 0, context_tokens: null },
		]);
		// The budget measure is unchanged by the migration; the usage measure starts at 0 and is backfilled at
		// startup from durable's per-conversation usage (usage-backfill.ts).
		await sql`update sessions set budget_used_tokens = 2000, usage_tokens = 3000, context_tokens = 42
			where id = ${"spent"}`.execute(db);
		const stored = await db.selectFrom("sessions").selectAll().where("id", "=", "spent").executeTakeFirstOrThrow();
		expect(Number(stored.budget_used_tokens)).toBe(2000);
		expect(Number(stored.usage_tokens)).toBe(3000);
		expect(Number(stored.context_tokens)).toBe(42);
	});
});

describeBackends("0033 drop authorization revocation", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("authorizations")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("payload", "text", (c) => c.notNull())
				.addColumn("revoked_at", "text")
				.execute();
			await sql`insert into authorizations (id, payload, revoked_at) values
				(${"a1"}, ${"00"}, ${new Date().toISOString()})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("drops revoked_at and keeps every row", async () => {
		await applyMigration(backend, db, up0033);
		const columns = await tableColumns(backend, db, "authorizations");
		expect(columns).toEqual(["id", "payload"]);
		const rows = await db.selectFrom("authorizations").select(["id", "payload"]).execute();
		expect(rows).toEqual([{ id: "a1", payload: "00" }]);

		// Rolling back restores the column without a value, so the old code sees "not revoked".
		await applyMigration(backend, db, down0033);
		const restored = await tableColumns(backend, db, "authorizations");
		expect(restored).toContain("revoked_at");
	});
});

describeBackends("0034 drop audit hash chain", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("audit_events")
				.addColumn("seq", "integer", (c) => c.primaryKey())
				.addColumn("id", "text", (c) => c.notNull())
				.addColumn("prev_hash", "text", (c) => c.notNull())
				.addColumn("hash", "text", (c) => c.notNull())
				.execute();
			await sql`insert into audit_events (seq, id, prev_hash, hash) values
				(${1}, ${"e1"}, ${"0".repeat(64)}, ${"a".repeat(64)}),
				(${4}, ${"e4"}, ${"b".repeat(64)}, ${"c".repeat(64)})`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("drops prev_hash and hash, keeps every audit row and generates seq", async () => {
		await applyMigration(backend, db, up0034);
		const columns = await tableColumns(backend, db, "audit_events");
		expect(columns).toEqual(["seq", "id"]);
		const rows = await db.selectFrom("audit_events").select(["seq", "id"]).orderBy("seq").execute();
		// PostgreSQL returns bigint as a string.
		expect(rows.map((row) => ({ seq: Number(row.seq), id: row.id }))).toEqual([
			{ seq: 1, id: "e1" },
			{ seq: 4, id: "e4" },
		]);

		// The database now assigns seq: an insert that omits it gets max(seq)+1.
		await sql`insert into audit_events (id) values (${"e5"})`.execute(db);
		const appended = await db.selectFrom("audit_events").select(["seq", "id"]).orderBy("seq").execute();
		expect(appended.map((row) => ({ seq: Number(row.seq), id: row.id }))).toEqual([
			{ seq: 1, id: "e1" },
			{ seq: 4, id: "e4" },
			{ seq: 5, id: "e5" },
		]);

		// Rolling back re-adds the columns, but the old hashes cannot be recomputed: they stay null.
		await applyMigration(backend, db, down0034);
		const restored = await tableColumns(backend, db, "audit_events");
		expect(restored).toEqual(["seq", "id", "prev_hash", "hash"]);
		const hashes = await sql<{ prev_hash: string | null; hash: string | null }>`
			select prev_hash, hash from audit_events where seq = 1
		`.execute(db);
		expect(hashes.rows).toEqual([{ prev_hash: null, hash: null }]);
	});
});

describeBackends("0035 retention indexes", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			for (const [table, column] of [
				["tasks", "finished_at"],
				["task_groups", "finished_at"],
				["audit_events", "ts"],
			] as const) {
				await db.schema
					.createTable(table)
					.addColumn("id", "text", (c) => c.primaryKey())
					.addColumn(column, "text")
					.execute();
			}
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	const indexNames = async (): Promise<string[]> => {
		if (backend === "sqlite") {
			const result = await sql<{ name: string }>`
				select name from sqlite_master
				where type = 'index' and name in ('audit_events_ts_idx', 'task_groups_finished_at_idx', 'tasks_finished_at_idx')
				order by name
			`.execute(db);
			return result.rows.map((row) => row.name);
		}
		const result = await sql<{ name: string }>`
			select indexname as name from pg_indexes
			where schemaname = current_schema()
				and indexname in ('audit_events_ts_idx', 'task_groups_finished_at_idx', 'tasks_finished_at_idx')
			order by indexname
		`.execute(db);
		return result.rows.map((row) => row.name);
	};

	it("indexes the retention sweep's timestamp columns and drops them on rollback", async () => {
		await applyMigration(backend, db, up0035);
		expect(await indexNames()).toEqual(["audit_events_ts_idx", "task_groups_finished_at_idx", "tasks_finished_at_idx"]);

		await applyMigration(backend, db, down0035);
		expect(await indexNames()).toEqual([]);
	});
});

describeBackends("0036 node names and node groups", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("orgs")
				.addColumn("id", "text", (c) => c.primaryKey())
				.execute();
			await db.schema
				.createTable("nodes")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull())
				.addColumn("name", "text", (c) => c.notNull())
				.addColumn("created_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("node_groups")
				.addColumn("node_id", "text", (c) => c.notNull())
				.addColumn("group_name", "text", (c) => c.notNull())
				.addColumn("refreshed_at", "text", (c) => c.notNull())
				.addPrimaryKeyConstraint("node_groups_pk", ["node_id", "group_name"])
				.execute();
			await db.schema
				.createTable("rule_sets")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull())
				.addColumn("rules", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("task_groups")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("targets", "text", (c) => c.notNull())
				.execute();
			await sql`insert into orgs (id) values ('o1')`.execute(db);
			for (const [id, name, at] of [
				["n1", "web", "2026-01-01T00:00:01Z"],
				["n2", "Web Server!", "2026-01-01T00:00:02Z"],
				["n3", "Foo", "2026-01-01T00:00:03Z"],
				["n4", "foo", "2026-01-01T00:00:04Z"],
				["n5", "a", "2026-01-01T00:00:05Z"],
			] as const) {
				await sql`insert into nodes (id, org_id, name, created_at) values (${id}, 'o1', ${name}, ${at})`.execute(db);
			}
			for (const [nodeId, groupName] of [
				["n1", "web"],
				["n1", "Prod Group"],
				["n2", "Prod Group"],
				["n3", "foo"],
			] as const) {
				await sql`insert into node_groups (node_id, group_name, refreshed_at) values
					(${nodeId}, ${groupName}, '2026-01-01T00:00:00Z')`.execute(db);
			}
			const rules: [string, unknown[]][] = [
				[
					"rs1",
					[
						{ action: "deny", nodes: ["group:web", "web", "n3", "nope"], method: "exec" },
						{ action: "allow", method: "exec" },
					],
				],
				["rs2", [{ action: "allow", nodes: ["_all", "group:missing"] }]],
				["rs3", [{ action: "deny", nodes: ["Web Server!"] }]],
				["rs4", [{ action: "allow", method: "file.read" }]],
			];
			for (const [id, value] of rules) {
				await sql`insert into rule_sets (id, org_id, rules) values (${id}, 'o1', ${JSON.stringify(value)})`.execute(db);
			}
			await sql`insert into task_groups (id, targets) values ('g1', ${JSON.stringify(["group:web", "n1"])})`.execute(
				db,
			);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	const names = async (): Promise<Record<string, string>> =>
		Object.fromEntries(
			(await db.selectFrom("nodes").select(["id", "name", "name_key"]).execute()).map((row) => [
				row.id,
				`${row.name}|${row.name_key}`,
			]),
		);

	const groups = async (): Promise<{ id: string; name: string; memberIds: string[] }[]> => {
		// Sorted here, not in SQL: PostgreSQL's collation and SQLite's byte order disagree on case.
		const rows = (await db.selectFrom("node_groups").select(["id", "name", "name_key"]).execute()).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		const members = await db.selectFrom("node_group_members").select(["node_group_id", "node_id"]).execute();
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			memberIds: members
				.filter((m) => m.node_group_id === row.id)
				.map((m) => m.node_id)
				.sort(),
		}));
	};

	const rulesOf = async (id: string): Promise<unknown[]> =>
		JSON.parse(
			(await db.selectFrom("rule_sets").select("rules").where("id", "=", id).executeTakeFirstOrThrow()).rules,
		) as unknown[];

	it("normalizes names, builds node groups and resolves rule references", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		let logged = "";
		try {
			await applyMigration(backend, db, up0036);
			logged = log.mock.calls.map((call) => String(call[0])).join("\n");
		} finally {
			log.mockRestore();
		}

		expect(await names()).toEqual({
			n1: "web|web",
			n2: "Web-Server|web-server",
			// The first of two names that collide only by case keeps its spelling; the later one gets a suffix.
			n3: "Foo|foo",
			n4: "foo-2|foo-2",
			n5: "a0|a0",
		});
		const nodeGroups = await groups();
		expect(nodeGroups.map((group) => group.name)).toEqual(["Prod-Group", "foo-3", "web-2"]);
		// New node-group ids follow the application's UUIDv7 convention.
		for (const group of nodeGroups) expect(group.id[14]).toBe("7");
		expect(nodeGroups.find((group) => group.name === "Prod-Group")?.memberIds).toEqual(["n1", "n2"]);
		expect(nodeGroups.find((group) => group.name === "web-2")?.memberIds).toEqual(["n1"]);
		expect(nodeGroups.find((group) => group.name === "foo-3")?.memberIds).toEqual(["n3"]);

		// The rule's entries resolve through the pre-migration names and the group mapping; unknown entries become
		// fresh UUIDs that refer to nothing.
		const web2 = nodeGroups.find((group) => group.name === "web-2")?.id as string;
		const rs1 = (await rulesOf("rs1")) as { nodes?: string[]; method?: string }[];
		expect(rs1[0]?.nodes?.slice(0, 3)).toEqual([web2, "n1", "n3"]);
		expect(rs1[0]?.nodes?.[3]).toMatch(/^[0-9a-f-]{36}$/);
		expect([web2, "n1", "n3"]).not.toContain(rs1[0]?.nodes?.[3]);
		expect(rs1[1]).toEqual({ action: "allow", method: "exec" });

		const rs2 = (await rulesOf("rs2")) as { nodes: string[] }[];
		expect(rs2[0]?.nodes[0]).toBe("_all");
		expect(rs2[0]?.nodes[1]).toMatch(/^[0-9a-f-]{36}$/);
		expect((await rulesOf("rs3")) as { nodes: string[] }[]).toEqual([{ action: "deny", nodes: ["n2"] }]);
		expect(await rulesOf("rs4")).toEqual([{ action: "allow", method: "file.read" }]);

		// Historical task-group targets are not rewritten.
		const taskGroup = await db
			.selectFrom("task_groups")
			.select("targets")
			.where("id", "=", "g1")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(taskGroup.targets)).toEqual(["group:web", "n1"]);

		// The migration says which references had to become dangling ids.
		expect(logged).toContain('"nope"');
		expect(logged).toContain('"group:missing"');
	});

	it("keeps old group names that differ only by case as two groups", async () => {
		await sql`delete from node_groups`.execute(db);
		await sql`insert into node_groups (node_id, group_name, refreshed_at) values
			('n1', 'zebra', '2026-01-01T00:00:00Z'),
			('n1', 'Zebra', '2026-01-01T00:00:00Z')`.execute(db);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await applyMigration(backend, db, up0036);
		} finally {
			log.mockRestore();
		}
		const nodeGroups = await groups();
		expect(nodeGroups.map((group) => group.name).sort()).toEqual(["Zebra-2", "zebra"]);
		expect(new Set(nodeGroups.map((group) => group.id)).size).toBe(2);
		expect(nodeGroups.every((group) => group.memberIds.join(",") === "n1")).toBe(true);
	});

	it("logs a note for unresolved references", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await applyMigration(backend, db, up0036);
			const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
			expect(logged).toContain("rule set rs1");
			expect(logged).toContain('rule set rs1: "nope"');
		} finally {
			log.mockRestore();
		}
	});

	it("rolls back to the cache shape and the old columns", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await applyMigration(backend, db, up0036);
		} finally {
			log.mockRestore();
		}
		await applyMigration(backend, db, down0036);
		expect(await tableColumns(backend, db, "node_groups")).toEqual(["node_id", "group_name", "refreshed_at"]);
		expect(await tableColumns(backend, db, "nodes")).not.toContain("name_key");
		const cache = await sql<{ node_id: string; group_name: string }>`
			select node_id, group_name from node_groups order by node_id, group_name
		`.execute(db);
		expect(cache.rows).toEqual([
			{ node_id: "n1", group_name: "Prod-Group" },
			{ node_id: "n1", group_name: "web-2" },
			{ node_id: "n2", group_name: "Prod-Group" },
			{ node_id: "n3", group_name: "foo-3" },
		]);
	});
});

describeBackends("0037 user group member column", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("user_group_members")
				.addColumn("group_id", "text", (c) => c.notNull())
				.addColumn("user_id", "text", (c) => c.notNull())
				.addColumn("created_at", "text", (c) => c.notNull())
				.addPrimaryKeyConstraint("user_group_members_pk", ["group_id", "user_id"])
				.execute();
			await db.schema
				.createIndex("user_group_members_user_id_idx")
				.on("user_group_members")
				.column("user_id")
				.execute();
		});
		await sql`insert into user_group_members (group_id, user_id, created_at) values
			('g1', 'u1', '2026-01-01T00:00:00Z'), ('g1', 'u2', '2026-01-01T00:00:01Z')`.execute(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	/** The user-id index the old table created; a column rename must leave it in place. */
	const indexNames = async (): Promise<string[]> => {
		if (backend === "sqlite") {
			const result = await sql<{ name: string }>`
				select name from sqlite_master where type = 'index' and name = 'user_group_members_user_id_idx'
			`.execute(db);
			return result.rows.map((row) => row.name);
		}
		const result = await sql<{ name: string }>`
			select indexname as name from pg_indexes
			where schemaname = current_schema() and indexname = 'user_group_members_user_id_idx'
		`.execute(db);
		return result.rows.map((row) => row.name);
	};

	it("renames group_id to user_group_id and keeps the data, primary key and index", async () => {
		await applyMigration(backend, db, up0037);
		expect(await tableColumns(backend, db, "user_group_members")).toEqual(["user_group_id", "user_id", "created_at"]);
		const rows = await sql<{ user_group_id: string; user_id: string }>`
			select user_group_id, user_id from user_group_members order by user_id
		`.execute(db);
		expect(rows.rows).toEqual([
			{ user_group_id: "g1", user_id: "u1" },
			{ user_group_id: "g1", user_id: "u2" },
		]);
		// The primary key still covers (user_group_id, user_id): a duplicate is rejected.
		await expect(
			sql`insert into user_group_members (user_group_id, user_id, created_at)
				values ('g1', 'u1', '2026-01-01T00:00:02Z')`.execute(db),
		).rejects.toThrow();
		expect(await indexNames()).toEqual(["user_group_members_user_id_idx"]);

		await applyMigration(backend, db, down0037);
		expect(await tableColumns(backend, db, "user_group_members")).toEqual(["group_id", "user_id", "created_at"]);
		const restored = await sql<{ group_id: string; user_id: string }>`
			select group_id, user_id from user_group_members order by user_id
		`.execute(db);
		expect(restored.rows).toEqual([
			{ group_id: "g1", user_id: "u1" },
			{ group_id: "g1", user_id: "u2" },
		]);
		expect(await indexNames()).toEqual(["user_group_members_user_id_idx"]);
	});
});

describeBackends("0038 node access grants", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("orgs")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("name", "text", (c) => c.notNull())
				.addColumn("created_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("users")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
				.addColumn("username", "text", (c) => c.notNull())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("created_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("nodes")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
				.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
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
			await db.schema.createIndex("nodes_owner_user_id_idx").on("nodes").column("owner_user_id").execute();
			await db.schema
				.createTable("node_groups")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
				.addColumn("name", "text", (c) => c.notNull())
				.addColumn("name_key", "text", (c) => c.notNull())
				.addColumn("created_at", "text", (c) => c.notNull())
				.addColumn("updated_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("node_group_members")
				.addColumn("node_group_id", "text", (c) => c.notNull().references("node_groups.id").onDelete("cascade"))
				.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
				.addPrimaryKeyConstraint("node_group_members_pk", ["node_group_id", "node_id"])
				.execute();
			await db.schema
				.createTable("shares")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
				.addColumn("resource_type", "text", (c) => c.notNull())
				.addColumn("resource_id", "text", (c) => c.notNull())
				.addColumn("grantee_type", "text", (c) => c.notNull())
				.addColumn("grantee_id", "text", (c) => c.notNull())
				.addColumn("access", "text", (c) => c.notNull())
				.addColumn("created_by_user_id", "text", (c) => c.notNull().references("users.id"))
				.addColumn("created_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("ssh_credentials")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
				.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
				.addColumn("name", "text", (c) => c.notNull())
				.addColumn("public_key", "text", (c) => c.notNull())
				.addColumn("secret_id", "text", (c) => c.notNull())
				.addColumn("created_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("audit_events")
				.addColumn("seq", "integer", (c) => c.primaryKey())
				.addColumn("id", "text", (c) => c.notNull().unique())
				.addColumn("org_id", "text", (c) => c.notNull())
				.addColumn("ts", "text", (c) => c.notNull())
				.addColumn("actor_type", "text", (c) => c.notNull())
				.addColumn("actor_id", "text", (c) => c.notNull())
				.addColumn("on_behalf_of_user_id", "text")
				.addColumn("action", "text", (c) => c.notNull())
				.addColumn("target_type", "text")
				.addColumn("target_id", "text")
				.addColumn("detail", "text", (c) => c.notNull())
				.execute();
			if (backend === "postgres") {
				await sql`alter table audit_events alter column seq add generated by default as identity`.execute(db);
			}

			const now = "2026-01-01T00:00:00.000Z";
			await sql`insert into orgs (id, name, created_at) values ('o1', 'org', ${now})`.execute(db);
			await sql`
				insert into users (id, org_id, username, kind, created_at) values
				('root', 'o1', 'root', 'admin', ${now}),
				('alice', 'o1', 'alice', 'member', ${now}),
				('bob', 'o1', 'bob', 'member', ${now}),
				('carol', 'o1', 'carol', 'member', ${now})
			`.execute(db);
			await sql`
				insert into nodes (id, org_id, owner_user_id, name, name_key, transport, status, created_at)
				values
				('n-admin', 'o1', 'root', 'admin-node', 'admin-node', 'client', 'active', ${now}),
				('n-alice', 'o1', 'alice', 'alice-node', 'alice-node', 'client', 'active', ${now}),
				('n-bob', 'o1', 'bob', 'bob-node', 'bob-node', 'client', 'active', ${now})
			`.execute(db);
			await sql`
				insert into node_groups (id, org_id, name, name_key, created_at, updated_at)
				values ('g1', 'o1', 'ops', 'ops', ${now}, ${now})
			`.execute(db);
			await sql`insert into node_group_members (node_group_id, node_id) values ('g1', 'n-alice')`.execute(db);
			await sql`
				insert into shares (id, org_id, resource_type, resource_id, grantee_type, grantee_id, access, created_by_user_id, created_at)
				values
				('sh1', 'o1', 'node', 'n-bob', 'user', 'carol', 'operate', 'bob', ${now}),
				('sh2', 'o1', 'node', 'n-bob', 'user_group', 'g1', 'operate', 'bob', ${now}),
				('sh3', 'o1', 'node', 'n-bob', 'user', 'carol', 'view', 'bob', ${now}),
				('sh4', 'o1', 'node', 'n-alice', 'user', 'alice', 'operate', 'alice', ${now}),
				('sh5', 'o1', 'session', 's1', 'user', 'carol', 'view', 'bob', ${now})
			`.execute(db);
			await sql`
				insert into ssh_credentials (id, org_id, owner_user_id, name, public_key, secret_id, created_at)
				values ('cred1', 'o1', 'alice', 'key', 'ssh-ed25519 AAAA', 'sec1', ${now})
			`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("converts ownership and operate shares, drops view shares, and records one audit event", async () => {
		await applyMigration(backend, db, up0038);

		expect(await tableColumns(backend, db, "nodes")).not.toContain("owner_user_id");
		expect(await tableColumns(backend, db, "ssh_credentials")).not.toContain("owner_user_id");
		expect(await tableColumns(backend, db, "node_access_grants")).toEqual([
			"id",
			"org_id",
			"grantee_type",
			"grantee_id",
			"target_type",
			"target_id",
			"created_by_user_id",
			"created_at",
		]);

		const grants = await sql<{
			grantee_type: string;
			grantee_id: string;
			target_type: string;
			target_id: string;
		}>`select grantee_type, grantee_id, target_type, target_id from node_access_grants order by grantee_type, grantee_id, target_type, target_id`.execute(
			db,
		);
		expect(grants.rows).toEqual([
			{ grantee_type: "user", grantee_id: "alice", target_type: "node", target_id: "n-alice" },
			{ grantee_type: "user", grantee_id: "bob", target_type: "node", target_id: "n-bob" },
			{ grantee_type: "user", grantee_id: "carol", target_type: "node", target_id: "n-bob" },
			{ grantee_type: "user_group", grantee_id: "g1", target_type: "node", target_id: "n-bob" },
		]);

		const shares = await sql<{ resource_type: string; id: string }>`
			select resource_type, id from shares order by id
		`.execute(db);
		expect(shares.rows).toEqual([{ resource_type: "session", id: "sh5" }]);

		const members = await sql<{ node_group_id: string; node_id: string }>`
			select node_group_id, node_id from node_group_members
		`.execute(db);
		expect(members.rows).toEqual([{ node_group_id: "g1", node_id: "n-alice" }]);
		expect(Number((await sql<{ n: number }>`select count(*) as n from nodes`.execute(db)).rows[0]?.n)).toBe(3);
		expect((await sql<{ name: string }>`select name from ssh_credentials`.execute(db)).rows).toEqual([{ name: "key" }]);

		const events = await sql<{ actor_type: string; action: string; detail: string }>`
			select actor_type, action, detail from audit_events where action = 'migration.node_access'
		`.execute(db);
		expect(events.rows).toHaveLength(1);
		expect(events.rows[0]?.actor_type).toBe("system");
		expect(JSON.parse(events.rows[0]?.detail as string)).toEqual({
			owner_grants: 2,
			converted_operate_shares: 2,
			deleted_view_shares: 1,
		});
	});

	it("down restores the nullable owner columns and drops the grants", async () => {
		await applyMigration(backend, db, up0038);
		await applyMigration(backend, db, down0038);
		expect(await tableColumns(backend, db, "node_access_grants")).toBeUndefined();
		expect(await tableColumns(backend, db, "nodes")).toContain("owner_user_id");
		expect(await tableColumns(backend, db, "ssh_credentials")).toContain("owner_user_id");
		// The old owners and deleted node shares cannot be reconstructed; the rows are still there.
		expect(Number((await sql<{ n: number }>`select count(*) as n from nodes`.execute(db)).rows[0]?.n)).toBe(3);
		expect(Number((await sql<{ n: number }>`select count(*) as n from shares`.execute(db)).rows[0]?.n)).toBe(1);
	});
});

describeBackends("0039 output budgets", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("task_groups")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("output_mode", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("tasks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("output_mode", "text", (c) => c.notNull())
				.addColumn("stdout_tail", "text")
				.execute();
			await sql`insert into task_groups (id, output_mode) values ('g1', 'text')`.execute(db);
			await sql`insert into tasks (id, output_mode, stdout_tail) values ('t1', 'full', 'aGVsbG8=')`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("adds the budget and merged-tail columns as nullable", async () => {
		await applyMigration(backend, db, up0039);
		expect(await tableColumns(backend, db, "task_groups")).toContain("node_max_lines");
		expect(await tableColumns(backend, db, "task_groups")).toContain("node_max_bytes");
		expect(await tableColumns(backend, db, "tasks")).toContain("max_lines");
		expect(await tableColumns(backend, db, "tasks")).toContain("max_bytes");
		expect(await tableColumns(backend, db, "tasks")).toContain("output_tail");
		expect(await tableColumns(backend, db, "tasks")).toContain("output_lines");

		// Existing rows get the defaults at read time: the migration fills nothing in.
		const group = await sql<{ node_max_lines: number | null; node_max_bytes: number | null }>`
			select node_max_lines, node_max_bytes from task_groups where id = 'g1'
		`.execute(db);
		expect(group.rows[0]).toEqual({ node_max_lines: null, node_max_bytes: null });
		const task = await sql<{
			max_lines: number | null;
			max_bytes: number | null;
			output_tail: string | null;
			output_lines: number | null;
			stdout_tail: string;
		}>`select max_lines, max_bytes, output_tail, output_lines, stdout_tail from tasks where id = 't1'`.execute(db);
		expect(task.rows[0]).toEqual({
			max_lines: null,
			max_bytes: null,
			output_tail: null,
			output_lines: null,
			stdout_tail: "aGVsbG8=",
		});
	});

	it("down drops the columns and keeps the rows", async () => {
		await applyMigration(backend, db, up0039);
		await applyMigration(backend, db, down0039);
		expect(await tableColumns(backend, db, "task_groups")).not.toContain("node_max_lines");
		expect(await tableColumns(backend, db, "task_groups")).not.toContain("node_max_bytes");
		expect(await tableColumns(backend, db, "tasks")).not.toContain("max_lines");
		expect(await tableColumns(backend, db, "tasks")).not.toContain("max_bytes");
		expect(await tableColumns(backend, db, "tasks")).not.toContain("output_tail");
		expect(await tableColumns(backend, db, "tasks")).not.toContain("output_lines");
		expect(Number((await sql<{ n: number }>`select count(*) as n from tasks`.execute(db)).rows[0]?.n)).toBe(1);
		expect(Number((await sql<{ n: number }>`select count(*) as n from task_groups`.execute(db)).rows[0]?.n)).toBe(1);
	});
});

describeBackends("0040 one output stream", (backend) => {
	let db: Db;
	const notice = "crh: privileged was ignored: SSH nodes run tasks as the SSH user\n";
	const b64 = (text: string) => Buffer.from(text).toString("base64");
	const bytes = (text: string) => Buffer.from(text).length;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("tasks")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("spec", "text")
				.addColumn("stdout_bytes", "bigint", (c) => c.notNull())
				.addColumn("stderr_bytes", "bigint", (c) => c.notNull())
				.addColumn("stdout_head", "text")
				.addColumn("stdout_tail", "text")
				.addColumn("stderr_head", "text")
				.addColumn("stderr_tail", "text")
				.addColumn("output_tail", "text")
				.execute();
			await db.schema
				.createTable("task_groups")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("spec", "text")
				.execute();

			// A single task whose 0039-era exit wrote the merged tail already.
			await sql`insert into tasks (id, spec, stdout_bytes, stderr_bytes, stdout_head, stdout_tail, stderr_head, stderr_tail, output_tail)
				values (
					't-full',
					'{"kind":"exec","command":{"argv":["true"]},"env":{},"cwd":"","stdin":null}',
					${bytes("stdout-head\n") + bytes("stdout-tail\n")},
					${bytes("stderr-head\n") + bytes("stderr-tail\n")},
					${b64("stdout-head\n")},
					${b64("stdout-tail\n")},
					${b64("stderr-head\n")},
					${b64("stderr-tail\n")},
					${b64("merged-tail\n")}
				)`.execute(db);
			// An older task without output_tail: the tail is stdout followed by stderr.
			await sql`insert into tasks (id, spec, stdout_bytes, stderr_bytes, stdout_head, stdout_tail, stderr_head, stderr_tail, output_tail)
				values (
					't-text',
					'{"kind":"file.write","path":"/tmp/x","content":{"size":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},"overwrite":false,"mode":0,"owner":"","group":""}',
					${bytes("a\n")},
					${bytes("b\n")},
					null,
					${b64("a\n")},
					null,
					${b64("b\n")},
					null
				)`.execute(db);
			// The old SSH notice was the first line of stderr; it moves to notice.
			await sql`insert into tasks (id, spec, stdout_bytes, stderr_bytes, stdout_head, stdout_tail, stderr_head, stderr_tail, output_tail)
				values (
					't-notice',
					'{"kind":"file.write","path":"/tmp/y","content":{"size":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},"overwrite":false,"mode":0,"owner":"","group":"","createParentDirs":true}',
					${bytes("out\n")},
					${bytes(notice) + bytes("oops\n")},
					${b64("out\n")},
					${b64("out\n")},
					${b64(`${notice}oops\n`)},
					${b64(`${notice}oops\n`)},
					null
				)`.execute(db);
			// A status task kept only the notice.
			await sql`insert into tasks (id, spec, stdout_bytes, stderr_bytes, stdout_head, stdout_tail, stderr_head, stderr_tail, output_tail)
				values (
					't-status',
					'{"kind":"exec","command":{"argv":["true"]},"env":{},"cwd":"","stdin":null}',
					0,
					${bytes(notice)},
					null,
					null,
					${b64(notice)},
					null,
					null
				)`.execute(db);
			await sql`insert into task_groups (id, spec) values (
				'g-write',
				'{"kind":"file.write","path":"/tmp/z","content":{"size":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},"overwrite":false,"mode":0,"owner":"","group":""}'
			)`.execute(db);
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("merges the streams, moves the SSH notice and backfills file.write specs", async () => {
		await applyMigration(backend, db, up0040);
		const columns = await tableColumns(backend, db, "tasks");
		expect(columns).toContain("output_head");
		expect(columns).toContain("output_bytes");
		expect(columns).toContain("notice");
		expect(columns).not.toContain("stdout_bytes");
		expect(columns).not.toContain("stdout_head");
		expect(columns).not.toContain("stderr_tail");

		const rows = await sql<{
			id: string;
			output_bytes: string | number;
			output_head: string | null;
			output_tail: string | null;
			notice: string | null;
			spec: string;
		}>`select id, output_bytes, output_head, output_tail, notice, spec from tasks order by id`.execute(db);
		const byId = new Map(rows.rows.map((row) => [row.id, row]));

		// The 0039-era merged tail is kept; the old per-stream heads are merged stdout first.
		expect(byId.get("t-full")).toMatchObject({
			output_bytes: bytes("stdout-head\n") + bytes("stdout-tail\n") + bytes("stderr-head\n") + bytes("stderr-tail\n"),
			output_head: b64("stdout-head\nstderr-head\n"),
			output_tail: b64("merged-tail\n"),
			notice: null,
		});
		// No merged tail: stdout tail followed by stderr tail.
		expect(byId.get("t-text")).toMatchObject({
			output_bytes: bytes("a\n") + bytes("b\n"),
			output_head: null,
			output_tail: b64("a\nb\n"),
			notice: null,
		});
		// The notice is moved out of the output, from the head and the merged tail.
		expect(byId.get("t-notice")).toMatchObject({
			output_bytes: bytes("out\n") + bytes(notice) + bytes("oops\n"),
			output_head: b64("out\noops\n"),
			output_tail: b64("out\noops\n"),
			notice,
		});
		expect(byId.get("t-status")).toMatchObject({
			output_bytes: bytes(notice),
			output_head: "",
			output_tail: null,
			notice,
		});

		// Every stored file.write spec gets the field the JSON form now requires; a set one stays.
		const fullSpec = JSON.parse(byId.get("t-full")?.spec ?? "{}") as Record<string, unknown>;
		expect(fullSpec.kind).toBe("exec");
		expect(fullSpec).not.toHaveProperty("createParentDirs");
		const textSpec = JSON.parse(byId.get("t-text")?.spec ?? "{}") as Record<string, unknown>;
		expect(textSpec.createParentDirs).toBe(false);
		const noticeSpec = JSON.parse(byId.get("t-notice")?.spec ?? "{}") as Record<string, unknown>;
		expect(noticeSpec.createParentDirs).toBe(true);
		const group = await sql<{ spec: string }>`select spec from task_groups where id = 'g-write'`.execute(db);
		expect((JSON.parse(group.rows[0]?.spec ?? "{}") as Record<string, unknown>).createParentDirs).toBe(false);
	});

	it("down restores the stdout columns and keeps the rows", async () => {
		await applyMigration(backend, db, up0040);
		await applyMigration(backend, db, down0040);
		const columns = await tableColumns(backend, db, "tasks");
		expect(columns).toContain("stdout_bytes");
		expect(columns).toContain("stdout_head");
		expect(columns).toContain("stdout_tail");
		expect(columns).not.toContain("output_bytes");
		expect(columns).not.toContain("output_head");
		expect(columns).not.toContain("notice");
		const row = await sql<{ stdout_bytes: string | number; stdout_head: string | null; stdout_tail: string | null }>`
			select stdout_bytes, stdout_head, stdout_tail from tasks where id = 't-notice'
		`.execute(db);
		expect(Number(row.rows[0]?.stdout_bytes)).toBe(bytes("out\n") + bytes(notice) + bytes("oops\n"));
		expect(row.rows[0]?.stdout_head).toBe(b64("out\noops\n"));
		expect(row.rows[0]?.stdout_tail).toBe(b64("out\noops\n"));
		expect(Number((await sql<{ n: number }>`select count(*) as n from tasks`.execute(db)).rows[0]?.n)).toBe(4);
	});
});

describeBackends("0041 rule preset", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("rule_sets")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("preset", "text")
				.addColumn("default_action", "text", (c) => c.notNull())
				.addColumn("rules", "text", (c) => c.notNull())
				.execute();
		});
		await sql`insert into rule_sets (id, preset, default_action, rules) values
			('root', 'yolo', 'allow', '[]'), ('sub', null, 'inherit', '[]')`.execute(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("renames rule preset to rule_preset and keeps the rows", async () => {
		await applyMigration(backend, db, up0041);
		expect(await tableColumns(backend, db, "rule_sets")).toEqual(["id", "rule_preset", "default_action", "rules"]);
		const rows = await sql<{ id: string; rule_preset: string | null; default_action: string }>`
			select id, rule_preset, default_action from rule_sets order by id
		`.execute(db);
		expect(rows.rows).toEqual([
			{ id: "root", rule_preset: "yolo", default_action: "allow" },
			{ id: "sub", rule_preset: null, default_action: "inherit" },
		]);

		await applyMigration(backend, db, down0041);
		expect(await tableColumns(backend, db, "rule_sets")).toEqual(["id", "preset", "default_action", "rules"]);
		const restored = await sql<{
			id: string;
			preset: string | null;
		}>`select id, preset from rule_sets order by id`.execute(db);
		expect(restored.rows).toEqual([
			{ id: "root", preset: "yolo" },
			{ id: "sub", preset: null },
		]);
	});
});

describeBackends("0042 custom model providers", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("model_providers")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("models", "text")
				.execute();
		});
		const models = JSON.stringify([
			{ id: "a", name: "A", contextWindow: 4096, maxTokens: 512, reasoning: true },
			{ id: "b", contextWindow: 8192, maxTokens: 1024, reasoning: false },
			{ id: "c", contextWindow: 16384, maxTokens: 2048 },
		]);
		await sql`insert into model_providers (id, kind, models) values
			('compat', 'openai-compatible', ${models}),
			('builtin', 'builtin', null)`.execute(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("renames the kind, upgrades every model and adds session_id", async () => {
		await applyMigration(backend, db, up0042);
		expect(await tableColumns(backend, db, "model_providers")).toEqual(["id", "kind", "models", "session_id"]);
		const rows = await sql<{ id: string; kind: string; models: string | null; session_id: string | null }>`
			select id, kind, models, session_id from model_providers order by id
		`.execute(db);
		const compat = rows.rows.find((row) => row.id === "compat");
		expect(compat?.kind).toBe("custom");
		expect(compat?.session_id).toBeNull();
		const models = JSON.parse(compat?.models ?? "[]") as Record<string, unknown>[];
		expect(models).toEqual([
			{
				id: "a",
				name: "A",
				contextWindow: 4096,
				maxTokens: 512,
				api: "openai-completions",
				input: ["text"],
				thinking: { mode: "format", levels: {} },
			},
			{ id: "b", contextWindow: 8192, maxTokens: 1024, api: "openai-completions", input: ["text"] },
			{ id: "c", contextWindow: 16384, maxTokens: 2048, api: "openai-completions", input: ["text"] },
		]);
		// Built-in rows never carried models and are otherwise untouched.
		expect(rows.rows.find((row) => row.id === "builtin")).toMatchObject({
			kind: "builtin",
			models: null,
			session_id: null,
		});
	});

	it("down restores the old kind and model shape", async () => {
		await applyMigration(backend, db, up0042);
		await applyMigration(backend, db, down0042);
		expect(await tableColumns(backend, db, "model_providers")).toEqual(["id", "kind", "models"]);
		const rows = await sql<{ id: string; kind: string; models: string | null }>`
			select id, kind, models from model_providers order by id
		`.execute(db);
		const compat = rows.rows.find((row) => row.id === "compat");
		expect(compat?.kind).toBe("openai-compatible");
		const models = JSON.parse(compat?.models ?? "[]") as Record<string, unknown>[];
		expect(models).toEqual([
			{ id: "a", name: "A", contextWindow: 4096, maxTokens: 512, reasoning: true },
			{ id: "b", contextWindow: 8192, maxTokens: 1024 },
			{ id: "c", contextWindow: 16384, maxTokens: 2048 },
		]);
	});
});

describeBackends("0043 model presets", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("orgs")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("created_at", "text", (c) => c.notNull())
				.execute();
			await db.schema
				.createTable("server_meta")
				.addColumn("key", "text", (c) => c.primaryKey())
				.addColumn("value", "text", (c) => c.notNull())
				.execute();
		});
		await sql`insert into orgs (id, created_at) values ('org-1', '2026-01-01T00:00:00.000Z')`.execute(db);
		const review = JSON.stringify({ provider: "faux", modelId: "faux-1", thinkingLevel: "high" });
		await sql`insert into server_meta (key, value) values ('review_model', ${review})`.execute(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("creates the table and moves review_model into the default org's review row", async () => {
		await applyMigration(backend, db, up0043);
		expect(await tableColumns(backend, db, "model_presets")).toEqual([
			"org_id",
			"kind",
			"model",
			"system_prompt",
			"updated_at",
		]);
		const rows = await sql<{ org_id: string; kind: string; model: string | null; system_prompt: string | null }>`
			select org_id, kind, model, system_prompt from model_presets
		`.execute(db);
		expect(rows.rows).toEqual([
			{
				org_id: "org-1",
				kind: "review",
				model: JSON.stringify({ provider: "faux", modelId: "faux-1", thinkingLevel: "high" }),
				system_prompt: null,
			},
		]);
		const meta = await sql<{ key: string }>`select key from server_meta`.execute(db);
		expect(meta.rows).toEqual([]);

		await applyMigration(backend, db, down0043);
		expect(await tableColumns(backend, db, "model_presets")).toBeUndefined();
		const restored = await sql<{ key: string; value: string }>`select key, value from server_meta`.execute(db);
		expect(restored.rows).toEqual([
			{ key: "review_model", value: JSON.stringify({ provider: "faux", modelId: "faux-1", thinkingLevel: "high" }) },
		]);
	});
});

describeBackends("0044 session title pending", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend);
		await applyMigration(backend, db, down0044);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("makes the title nullable, adds the flag and clears the old default title", async () => {
		const user = await createUser(db, { username: "title-owner", kind: "member" });
		const orgId = await defaultOrgId(db);
		const now = "2026-01-01T00:00:00.000Z";
		const insert = (id: string, title: string) =>
			sql`
				insert into sessions (
					id, org_id, owner_user_id, conversation_id, parent_session_id, title, model, status,
					created_at, updated_at, archived_at, last_submission_id, state, waiting_kind, waiting_level_id,
					waiting_handler_id, state_changed_at
				) values (
					${id}, ${orgId}, ${user.id}, ${`conv-${id}`}, null, ${title}, ${"{}"}, ${"active"},
					${now}, ${now}, null, null, ${"idle"}, null, null, null, null
				)
			`.execute(db);
		await insert("old-default", "New session");
		await insert("named", "Plan the migration");

		await applyMigration(backend, db, up0044);

		const columns = await tableColumns(backend, db, "sessions");
		expect(columns).toContain("title_pending");
		const rows = await sql<{ id: string; title: string | null; title_pending: number }>`
			select id, title, title_pending from sessions order by id
		`.execute(db);
		expect(rows.rows).toEqual([
			{ id: "named", title: "Plan the migration", title_pending: 0 },
			{ id: "old-default", title: null, title_pending: 0 },
		]);
		// The relaxed column really accepts null, and the flag defaults to false on a new row.
		await sql`
			insert into sessions (
				id, org_id, owner_user_id, conversation_id, parent_session_id, title, model, status,
				created_at, updated_at, archived_at, last_submission_id, state, waiting_kind, waiting_level_id,
				waiting_handler_id, state_changed_at
			) values (
				${"null-title"}, ${orgId}, ${user.id}, ${"conv-null-title"}, null, null, ${"{}"}, ${"active"},
				${now}, ${now}, null, null, ${"idle"}, null, null, null, null
			)
		`.execute(db);
		const inserted = await sql<{ title: string | null; title_pending: number }>`
			select title, title_pending from sessions where id = 'null-title'
		`.execute(db);
		expect(inserted.rows).toEqual([{ title: null, title_pending: 0 }]);
	});
});

describeBackends("0045 session create request id", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend);
		await applyMigration(backend, db, down0045);
	});

	afterEach(async () => {
		await db.destroy();
	});

	const indexNames = async (): Promise<string[]> => {
		if (backend === "postgres") {
			const rows = await sql<{ name: string }>`
				select indexname as name from pg_indexes
				where schemaname = current_schema() and indexname = 'sessions_owner_create_request_unique'
			`.execute(db);
			return rows.rows.map((row) => row.name);
		}
		const rows = await sql<{ name: string }>`
			select name from sqlite_master
			where type = 'index' and name = 'sessions_owner_create_request_unique'
		`.execute(db);
		return rows.rows.map((row) => row.name);
	};

	it("adds a nullable request id, unique per owner, and drops both on rollback", async () => {
		const alice = await createUser(db, { username: "create-request-alice", kind: "member" });
		const bob = await createUser(db, { username: "create-request-bob", kind: "member" });
		const orgId = await defaultOrgId(db);
		const now = "2026-01-01T00:00:00.000Z";
		const insertBefore = (id: string, owner: string) =>
			sql`
				insert into sessions (
					id, org_id, owner_user_id, conversation_id, parent_session_id, title, model, status,
					created_at, updated_at, archived_at, last_submission_id, state, waiting_kind, waiting_level_id,
					waiting_handler_id, state_changed_at
				) values (
					${id}, ${orgId}, ${owner}, ${`conv-${id}`}, null, null, ${"{}"}, ${"active"},
					${now}, ${now}, null, null, ${"idle"}, null, null, null, null
				)
			`.execute(db);
		const insert = (id: string, owner: string, requestId: string | null) =>
			sql`
				insert into sessions (
					id, org_id, owner_user_id, conversation_id, parent_session_id, title, model, status,
					created_at, updated_at, archived_at, last_submission_id, state, waiting_kind, waiting_level_id,
					waiting_handler_id, state_changed_at, create_request_id
				) values (
					${id}, ${orgId}, ${owner}, ${`conv-${id}`}, null, null, ${"{}"}, ${"active"},
					${now}, ${now}, null, null, ${"idle"}, null, null, null, null, ${requestId}
				)
			`.execute(db);

		// Sessions that predate the column get null and keep working.
		await insertBefore("existing-1", alice.id);
		await insertBefore("existing-2", alice.id);
		await applyMigration(backend, db, up0045);
		expect(await tableColumns(backend, db, "sessions")).toContain("create_request_id");
		expect(await indexNames()).toEqual(["sessions_owner_create_request_unique"]);

		// A null request id is not deduplicated: any number of sessions may have none.
		const nulls = await sql<{ n: number }>`
			select count(*) as n from sessions where create_request_id is null and owner_user_id = ${alice.id}
		`.execute(db);
		expect(Number(nulls.rows[0]?.n)).toBe(2);

		await insert("alice-request", alice.id, "same-request");
		// The same request id for another owner is a different creation.
		await insert("bob-request", bob.id, "same-request");
		await expect(insert("alice-duplicate", alice.id, "same-request")).rejects.toThrow();
		// Reusing it for the same owner is also rejected on update.
		await expect(
			sql`update sessions set create_request_id = 'same-request' where id = 'existing-1'`.execute(db),
		).rejects.toThrow();

		await applyMigration(backend, db, down0045);
		expect(await tableColumns(backend, db, "sessions")).not.toContain("create_request_id");
		expect(await indexNames()).toEqual([]);
	});
});

describeBackends("0046 thinking modes and labels", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend, { migrate: false });
		await withDdlLockOn(backend, async () => {
			await db.schema
				.createTable("model_providers")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("models", "text")
				.execute();
			await db.schema
				.createTable("model_presets")
				.addColumn("org_id", "text", (c) => c.notNull())
				.addColumn("kind", "text", (c) => c.notNull())
				.addColumn("model", "text")
				.addColumn("system_prompt", "text")
				.addColumn("updated_at", "text", (c) => c.notNull())
				.addPrimaryKeyConstraint("model_presets_pk", ["org_id", "kind"])
				.execute();
		});
		const models = JSON.stringify([
			{
				id: "standard",
				thinking: { mode: "format", format: "deepseek", levels: { low: "low", xhigh: null } },
			},
			{
				id: "custom",
				thinking: { mode: "body", levels: { high: { thinking: { type: "enabled" } } } },
			},
		]);
		await sql`insert into model_providers (id, kind, models) values
			('proxy', 'custom', ${models}),
			('builtin', 'builtin', null)`.execute(db);
		await sql`insert into model_presets (org_id, kind, model, system_prompt, updated_at) values
			('org-1', 'review', ${JSON.stringify({ provider: "proxy", modelId: "standard" })}, null, '2026-01-01T00:00:00.000Z')`.execute(
			db,
		);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("renames the modes and reverses it", async () => {
		await applyMigration(backend, db, up0046);

		const rows = await sql<{ id: string; models: string | null }>`
			select id, models from model_providers order by id
		`.execute(db);
		expect(JSON.parse(rows.rows.find((row) => row.id === "proxy")?.models ?? "[]")).toEqual([
			{
				id: "standard",
				thinking: { mode: "standard", format: "deepseek", levels: { low: "low", xhigh: null } },
			},
			{
				id: "custom",
				thinking: { mode: "custom", levels: { high: { thinking: { type: "enabled" } } } },
			},
		]);
		// Built-in rows carry no models and stay untouched.
		expect(rows.rows.find((row) => row.id === "builtin")?.models).toBeNull();

		await applyMigration(backend, db, down0046);
		const restored = await sql<{ id: string; models: string | null }>`
			select id, models from model_providers order by id
		`.execute(db);
		expect(JSON.parse(restored.rows.find((row) => row.id === "proxy")?.models ?? "[]")).toEqual([
			{
				id: "standard",
				thinking: { mode: "format", format: "deepseek", levels: { low: "low", xhigh: null } },
			},
			{
				id: "custom",
				thinking: { mode: "body", levels: { high: { thinking: { type: "enabled" } } } },
			},
		]);
	});

	it("leaves an unreadable model list and rows without thinking untouched", async () => {
		await sql`insert into model_providers (id, kind, models) values ('broken', 'custom', '{not json')`.execute(db);
		const before = JSON.stringify([{ id: "plain", thinking: undefined }]);
		await sql`insert into model_providers (id, kind, models) values ('plain', 'custom', ${before})`.execute(db);
		await applyMigration(backend, db, up0046);
		const rows = await sql<{ id: string; models: string | null }>`
			select id, models from model_providers where id in ('broken', 'plain') order by id
		`.execute(db);
		expect(rows.rows).toEqual([
			{ id: "broken", models: "{not json" },
			{ id: "plain", models: before },
		]);
	});
});
