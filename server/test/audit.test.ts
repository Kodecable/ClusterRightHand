import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Audit,
	type AuditEvent,
	canonicalJson,
	GENESIS_HASH,
	listAuditEvents,
	verifyChain,
} from "../src/audit/audit.ts";
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

describeBackends("audit chain", (backend) => {
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
	const seed = async (n: number) => {
		for (let i = 1; i <= n; i++) {
			await audit.record({
				actor: { type: "user", id: "u", onBehalfOfUserId: null },
				action: "test.event",
				detail: { i },
			});
		}
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

	it("builds a chain from the genesis hash", async () => {
		await seed(5);
		await audit.flush();
		const r = await rows();
		expect(r.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(r[0]?.prev_hash).toBe(GENESIS_HASH);
		for (let i = 1; i < r.length; i++) expect(r[i]?.prev_hash).toBe(r[i - 1]?.hash);
		expect(await verifyChain(db)).toEqual({ ok: true, count: 5 });
	});

	it("an empty log verifies", async () => {
		expect(await verifyChain(db)).toEqual({ ok: true, count: 0 });
	});

	it("concurrent records give a gap-free chain", async () => {
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				audit.record({ actor: { type: "system", id: "x" }, action: "test.concurrent", detail: { i } }),
			),
		);
		await audit.flush();
		const r = await rows();
		expect(r.map((x) => x.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(await verifyChain(db, 3)).toEqual({ ok: true, count: 20 });
	});

	describe("verifyChain", () => {
		beforeEach(async () => {
			await seed(7);
			await audit.flush();
		});

		it("is ok across several pages", async () => {
			expect(await verifyChain(db, 2)).toEqual({ ok: true, count: 7 });
			expect(await verifyChain(db, 7)).toEqual({ ok: true, count: 7 });
		});

		it("detects an edited detail", async () => {
			await db.updateTable("audit_events").set({ detail: '{"i":99}' }).where("seq", "=", 4).execute();
			expect(await verifyChain(db, 2)).toEqual({ ok: false, count: 3, brokenAt: 4, reason: "hash mismatch" });
		});

		it("detects a deleted middle row", async () => {
			await db.deleteFrom("audit_events").where("seq", "=", 4).execute();
			expect(await verifyChain(db, 2)).toEqual({ ok: false, count: 3, brokenAt: 4, reason: "missing record" });
		});

		it("detects an edited prev_hash", async () => {
			await db
				.updateTable("audit_events")
				.set({ prev_hash: "f".repeat(64) })
				.where("seq", "=", 5)
				.execute();
			expect(await verifyChain(db, 2)).toEqual({ ok: false, count: 4, brokenAt: 5, reason: "broken link" });
		});
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
