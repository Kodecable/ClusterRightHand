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
import { type Backend, describeBackends, openTestDb, withDdlLockOn } from "./helpers/db.ts";

/** Applies a migration's schema changes under the same DDL lock as the migrator. */
function applyMigration(backend: Backend, db: Db, migration: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
	return withDdlLockOn(backend, () => migration(db as unknown as Kysely<unknown>));
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
				revoked_at: null,
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
