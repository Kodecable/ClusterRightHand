import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { up } from "../src/storage/migrations/0019_cbor_protocol.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

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

	afterEach(async () => {
		await db.destroy();
	});

	it("adds tasks.attempt with a default of 1", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await up(db as unknown as Kysely<unknown>);
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
			await up(db as unknown as Kysely<unknown>);
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
			await up(db as unknown as Kysely<unknown>);
			expect(warn.mock.calls.some((call) => String(call[0]).includes("leaving task t-bad unchanged"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});
