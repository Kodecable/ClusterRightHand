import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit, type AuditEvent, canonicalJson, listAuditEvents } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

describe("canonicalJson", () => {
	it("does not depend on key order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});
	it("sorts nested objects and keeps array order", () => {
		const a = { z: [{ y: 1, x: 2 }, 3], a: { d: null, c: "s" } };
		const b = { a: { c: "s", d: null }, z: [{ x: 2, y: 1 }, 3] };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe('{"a":{"c":"s","d":null},"z":[{"x":2,"y":1},3]}');
		expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
	});
	it("drops undefined properties", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
		expect(canonicalJson({ a: { b: undefined } })).toBe('{"a":{}}');
	});
});

describeBackends("audit log", (backend) => {
	let db: Db;
	let audit: Audit;
	let alice: SessionUser;
	let bob: SessionUser;
	let admin: SessionUser;

	const su = (u: { id: string; username: string }, kind: "member" | "admin"): SessionUser => ({
		sessionId: "s",
		userId: u.id,
		username: u.username,
		kind,
	});
	const rows = () => db.selectFrom("audit_events").selectAll().orderBy("seq").execute();
	/** PostgreSQL returns bigint as a string; the tests compare numbers. */
	const seqs = async () => (await rows()).map((row) => Number(row.seq));
	const record = (log: Audit, detail: unknown) =>
		log.record({
			actor: { type: "system", id: "test" },
			action: "test.event",
			detail: detail as Record<string, unknown>,
		});
	const seed = async (log: Audit, n: number, offset = 0) => {
		for (let i = 1; i <= n; i++) await record(log, { i: offset + i });
	};

	beforeEach(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		alice = su(await createUser(db, { username: "alice", kind: "member" }), "member");
		bob = su(await createUser(db, { username: "bob", kind: "member" }), "member");
		admin = su(await createUser(db, { username: "root", kind: "admin" }), "admin");
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("appends records with increasing seq", async () => {
		await seed(audit, 5);
		await audit.flush();
		const r = await rows();
		expect(r.map((x) => Number(x.seq))).toEqual([1, 2, 3, 4, 5]);
		expect(r.map((x) => JSON.parse(x.detail))).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);
	});

	it("concurrent records get a gap-free sequence", async () => {
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				audit.record({ actor: { type: "system", id: "x" }, action: "test.concurrent", detail: { i } }),
			),
		);
		await audit.flush();
		expect(await seqs()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	});

	it("continues after max(seq) after a new Audit is created on an existing database", async () => {
		await seed(audit, 3);
		await audit.flush();
		const reopened = new Audit(db);
		await seed(reopened, 2, 3);
		await reopened.flush();
		expect(await seqs()).toEqual([1, 2, 3, 4, 5]);
	});

	it("two Audit instances on one database can both append without losing records", async () => {
		const other = new Audit(db);
		await Promise.all(Array.from({ length: 20 }, (_, i) => record(i % 2 === 0 ? audit : other, { i })));
		await Promise.all([audit.flush(), other.flush()]);
		const r = await rows();
		expect(r.map((x) => Number(x.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(r.map((x) => (JSON.parse(x.detail) as { i: number }).i).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 20 }, (_, i) => i),
		);
	});

	it("flush waits for in-flight appends", async () => {
		const pending = Array.from({ length: 5 }, (_, i) => record(audit, { i }));
		await audit.flush();
		expect(await seqs()).toEqual([1, 2, 3, 4, 5]);
		await Promise.all(pending);
	});

	describe("listAuditEvents", () => {
		beforeEach(async () => {
			const rec = (who: SessionUser | null, action: string, target?: { type: string; id: string }) =>
				audit.record({
					actor: who ? { type: "user", id: who.userId, onBehalfOfUserId: who.userId } : { type: "system", id: "s" },
					action,
					target,
				});
			await rec(alice, "task.created", { type: "task", id: "t1" }); // 1
			await rec(bob, "task.created", { type: "task", id: "t2" }); // 2
			await rec(alice, "task.finished", { type: "task", id: "t1" }); // 3
			await rec(alice, "tasks", undefined); // 4
			await rec(null, "task.created", { type: "task", id: "t3" }); // 5
			await rec(alice, "rules.changed", { type: "api_token", id: "k1" }); // 6
			await audit.flush();
		});

		it("shows administrators everything, newest first", async () => {
			const ev = await listAuditEvents(db, admin, {});
			expect(ev.map((e) => e.seq)).toEqual([6, 5, 4, 3, 2, 1]);
			expect(ev[0]?.detail).toEqual({});
		});

		it("shows members only what was done on their behalf", async () => {
			expect((await listAuditEvents(db, alice, {})).map((e) => e.seq)).toEqual([6, 4, 3, 1]);
			expect((await listAuditEvents(db, bob, {})).map((e) => e.seq)).toEqual([2]);
		});

		it("matches an action exactly, or by prefix when it ends with a dot", async () => {
			expect((await listAuditEvents(db, admin, { action: "task.created" })).map((e) => e.seq)).toEqual([5, 2, 1]);
			expect((await listAuditEvents(db, admin, { action: "task." })).map((e) => e.seq)).toEqual([5, 3, 2, 1]);
			expect((await listAuditEvents(db, admin, { action: "task" })).map((e) => e.seq)).toEqual([]);
		});

		it("filters by target and pages with a cursor and limit", async () => {
			expect((await listAuditEvents(db, admin, { targetType: "task", targetId: "t1" })).map((e) => e.seq)).toEqual([
				3, 1,
			]);
			const p1 = await listAuditEvents(db, admin, { limit: 2 });
			expect(p1.map((e) => e.seq)).toEqual([6, 5]);
			const last1 = p1[1] as AuditEvent;
			const p2 = await listAuditEvents(db, admin, { limit: 2, before: { seq: last1.seq, id: last1.id } });
			expect(p2.map((e) => e.seq)).toEqual([4, 3]);
			const last2 = p2[1] as AuditEvent;
			const p3 = await listAuditEvents(db, admin, { limit: 2, before: { seq: last2.seq, id: last2.id } });
			expect(p3.map((e) => e.seq)).toEqual([2, 1]);
		});
	});
});
