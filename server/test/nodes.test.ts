import { randomBytes } from "node:crypto";
import type { Facts } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import { createEnrollmentToken, EnrollmentError, enrollNode, parseEnrollmentToken } from "../src/cluster/enrollment.ts";
import {
	approveNode,
	deleteNode,
	findNodeByPublicKey,
	getNode,
	listNodeShares,
	listNodesForUser,
	nodeAccess,
	shareNode,
	unshareNode,
	updateNodeFacts,
} from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { addGroupMember, createUserGroup } from "../src/users/groups.ts";
import { createUser } from "../src/users/service.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const FP = "dummy-fingerprint";
const INVALID = "invalid, expired or already used enrollment token";
const FACTS: Facts = {
	hostname: "Host",
	osId: "linux",
	osVersionId: "1",
	osPrettyName: "Linux",
	kernel: "6.1",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/crh-notes.md",
	groups: [],
	clockOffsetMs: 0,
};

describeBackends("nodes", (backend) => {
	let db: Db;
	let admin: SessionUser;
	let alice: SessionUser;
	let bob: SessionUser;
	let carol: SessionUser;

	const session = (u: { id: string; username: string; kind: "admin" | "member" }): SessionUser => ({
		sessionId: "s",
		userId: u.id,
		username: u.username,
		kind: u.kind,
	});
	const key = () => new Uint8Array(randomBytes(32));
	const secretOf = (token: string) => parseEnrollmentToken(token).secret;
	const enroll = async (
		opts: { nameHint?: string; hostname?: string; user?: SessionUser; publicKey?: Uint8Array } = {},
	) => {
		const { token } = await createEnrollmentToken(db, {
			userId: (opts.user ?? alice).userId,
			nameHint: opts.nameHint,
			serverFingerprint: FP,
		});
		return enrollNode(db, {
			secret: secretOf(token),
			publicKey: opts.publicKey ?? key(),
			hostname: opts.hostname ?? "Host",
			facts: FACTS,
			clientVersion: "0.1.0",
		});
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		admin = session(await createUser(db, { username: "root", kind: "admin" }));
		alice = session(await createUser(db, { username: "alice", kind: "member" }));
		bob = session(await createUser(db, { username: "bob", kind: "member" }));
		carol = session(await createUser(db, { username: "carol", kind: "member" }));
	});
	afterAll(async () => {
		await db.destroy();
	});

	describe("enrollment", () => {
		it("formats and parses tokens, storing only the hash", async () => {
			const t = await createEnrollmentToken(db, { userId: alice.userId, serverFingerprint: FP });
			const parsed = parseEnrollmentToken(t.token);
			expect(parsed.fingerprint).toBe(FP);
			expect(t.token).toBe(`crh1.${FP}.${parsed.secret}`);
			const rows = await db.selectFrom("enrollment_tokens").selectAll().where("id", "=", t.id).execute();
			expect(rows[0]?.token_hash).not.toContain(parsed.secret);
			expect(() => parseEnrollmentToken("nope")).toThrow(EnrollmentError);
			expect(() => parseEnrollmentToken("crh2.a.b")).toThrow(EnrollmentError);
			expect(() => parseEnrollmentToken("crh1.a.")).toThrow(EnrollmentError);
		});

		it("is single-use, and owner is the token creator", async () => {
			const { token } = await createEnrollmentToken(db, { userId: bob.userId, serverFingerprint: FP });
			const node = await enrollNode(db, {
				secret: secretOf(token),
				publicKey: key(),
				hostname: "single",
				facts: { a: 1 },
				clientVersion: "1",
			});
			expect(node).toMatchObject({ owner_user_id: bob.userId, status: "pending", transport: "client", name: "single" });
			const again = enrollNode(db, {
				secret: secretOf(token),
				publicKey: key(),
				hostname: "single2",
				facts: {},
				clientVersion: "1",
			});
			await expect(again).rejects.toThrow(INVALID);
			const row = await db.selectFrom("enrollment_tokens").selectAll().where("used_by_node_id", "=", node.id).execute();
			expect(row).toHaveLength(1);
		});

		it("rejects expired and unknown tokens with the same message", async () => {
			const now = new Date("2030-01-01T00:00:00Z");
			const { token } = await createEnrollmentToken(db, {
				userId: alice.userId,
				serverFingerprint: FP,
				ttlMs: 1000,
				now,
			});
			const base = { publicKey: key(), hostname: "h", facts: {}, clientVersion: "1" };
			await expect(
				enrollNode(db, { ...base, secret: secretOf(token), now: new Date(now.getTime() + 2000) }),
			).rejects.toThrow(INVALID);
			await expect(enrollNode(db, { ...base, secret: "unknown" })).rejects.toThrow(INVALID);
			const ok = await enrollNode(db, { ...base, secret: secretOf(token), now: new Date(now.getTime() + 500) });
			expect(ok.status).toBe("pending");
		});

		it("rejects a duplicate public key without consuming the token", async () => {
			const pk = key();
			await enroll({ publicKey: pk, hostname: "dupkey" });
			const { token } = await createEnrollmentToken(db, { userId: alice.userId, serverFingerprint: FP });
			const attempt = (publicKey: Uint8Array) =>
				enrollNode(db, { secret: secretOf(token), publicKey, hostname: "dupkey2", facts: {}, clientVersion: "1" });
			await expect(attempt(pk)).rejects.toThrow(EnrollmentError);
			await expect(attempt(key())).resolves.toMatchObject({ status: "pending" });
		});

		it("sanitizes and de-duplicates names", async () => {
			const a = await enroll({ hostname: "Web Server_01.Example!" });
			expect(a.name).toBe("web-server_01.example");
			const b = await enroll({ hostname: "Web Server_01.Example!" });
			expect(b.name).toBe("web-server_01.example-2");
			const c = await enroll({ hostname: "dup" });
			const d = await enroll({ hostname: "dup" });
			const e = await enroll({ hostname: "dup" });
			expect([c.name, d.name, e.name]).toEqual(["dup", "dup-2", "dup-3"]);
			const hinted = await enroll({ nameHint: "Build Box", hostname: "ignored" });
			expect(hinted.name).toBe("build-box");
			const long = await enroll({ hostname: "x".repeat(100) });
			expect(long.name).toHaveLength(63);
			const long2 = await enroll({ hostname: "x".repeat(100) });
			expect(long2.name).toHaveLength(63);
			expect(long2.name.endsWith("-2")).toBe(true);
		});

		it("finds nodes by public key", async () => {
			const pk = key();
			const n = await enroll({ publicKey: pk, hostname: "findme" });
			expect((await findNodeByPublicKey(db, pk))?.id).toBe(n.id);
			expect(await findNodeByPublicKey(db, key())).toBeUndefined();
		});
	});

	describe("access and sharing", () => {
		let node: string;
		let team: string;
		beforeAll(async () => {
			node = (await enroll({ hostname: "shared-node" })).id;
			team = (await createUserGroup(db, "team")).id;
			await addGroupMember(db, team, bob.userId);
		});

		it("computes access levels", async () => {
			expect(await nodeAccess(db, admin, node)).toBe("admin");
			expect(await nodeAccess(db, alice, node)).toBe("owner");
			expect(await nodeAccess(db, bob, node)).toBeUndefined();
			expect(await nodeAccess(db, alice, "00000000-0000-7000-8000-000000000000")).toBeUndefined();

			await shareNode(db, {
				nodeId: node,
				granteeType: "user_group",
				granteeId: team,
				access: "view",
				createdBy: alice.userId,
			});
			expect(await nodeAccess(db, bob, node)).toBe("view");
			expect(await nodeAccess(db, carol, node)).toBeUndefined();

			await shareNode(db, {
				nodeId: node,
				granteeType: "user",
				granteeId: bob.userId,
				access: "operate",
				createdBy: alice.userId,
			});
			expect(await nodeAccess(db, bob, node)).toBe("operate");
			// the strongest share wins regardless of which route it came through
			await shareNode(db, {
				nodeId: node,
				granteeType: "user_group",
				granteeId: team,
				access: "operate",
				createdBy: alice.userId,
			});
			await shareNode(db, {
				nodeId: node,
				granteeType: "user",
				granteeId: bob.userId,
				access: "view",
				createdBy: alice.userId,
			});
			expect(await nodeAccess(db, bob, node)).toBe("operate");
		});

		it("upserts shares, validates grantees and removes shares", async () => {
			const shares = await listNodeShares(db, node);
			expect(shares).toHaveLength(2);
			const again = await shareNode(db, {
				nodeId: node,
				granteeType: "user",
				granteeId: bob.userId,
				access: "operate",
				createdBy: alice.userId,
			});
			expect(again.id).toBe(shares.find((s) => s.granteeType === "user")?.id);
			expect(await listNodeShares(db, node)).toHaveLength(2);
			await expect(
				shareNode(db, {
					nodeId: node,
					granteeType: "user",
					granteeId: "nope",
					access: "view",
					createdBy: alice.userId,
				}),
			).rejects.toThrow(/no such user/);
			await expect(
				shareNode(db, {
					nodeId: node,
					granteeType: "user_group",
					granteeId: "nope",
					access: "view",
					createdBy: alice.userId,
				}),
			).rejects.toThrow(/no such user group/);
			for (const s of shares) await unshareNode(db, node, s.id);
			expect(await nodeAccess(db, bob, node)).toBeUndefined();
			await expect(unshareNode(db, node, shares[0]?.id ?? "x")).rejects.toThrow(/no such share/);
		});
	});

	describe("listing and facts", () => {
		it("lists accessible nodes with access, groups and facts, ordered by name", async () => {
			const u = session(await createUser(db, { username: "lister", kind: "member" }));
			const o = session(await createUser(db, { username: "lowner", kind: "member" }));
			const a = await enroll({ user: u, nameHint: "zz-mine" });
			const b = await enroll({ user: o, nameHint: "aa-theirs" });
			const c = await enroll({ user: o, nameHint: "mm-hidden" });
			await shareNode(db, {
				nodeId: b.id,
				granteeType: "user",
				granteeId: u.userId,
				access: "view",
				createdBy: o.userId,
			});
			await updateNodeFacts(db, a.id, { facts: FACTS, groups: ["web", "db"], privilegedMode: "native" });

			const list = await listNodesForUser(db, u);
			expect(list.map((n) => n.name)).toEqual(["aa-theirs", "zz-mine"]);
			expect(list[0]).toMatchObject({ access: "view", groups: [], ownerUserId: o.userId, facts: FACTS });
			expect(list[1]).toMatchObject({
				access: "owner",
				groups: ["db", "web"],
				privilegedMode: "native",
				facts: FACTS,
			});
			const all = await listNodesForUser(db, admin);
			expect(all.map((n) => n.id)).toContain(c.id);
			expect(all.every((n) => n.access === "admin")).toBe(true);
			expect((await listNodesForUser(db, carol)).map((n) => n.id)).not.toContain(a.id);
		});

		it("updateNodeFacts replaces groups and sets last_seen_at", async () => {
			const n = await enroll({ hostname: "facts-node" });
			const t1 = new Date("2031-01-01T00:00:00Z");
			await updateNodeFacts(db, n.id, {
				facts: { ...FACTS, hostname: "first" },
				groups: ["a", "b", "a"],
				clientVersion: "2",
				now: t1,
			});
			let row = await getNode(db, n.id);
			expect(row).toMatchObject({ last_seen_at: t1.toISOString(), client_version: "2" });
			expect(JSON.parse(row?.facts ?? "null")).toEqual({ ...FACTS, hostname: "first" });
			await updateNodeFacts(db, n.id, { facts: { ...FACTS, hostname: "second" }, groups: ["c"] });
			const groups = await db.selectFrom("node_groups").select("group_name").where("node_id", "=", n.id).execute();
			expect(groups.map((g) => g.group_name)).toEqual(["c"]);
			row = await getNode(db, n.id);
			expect(row?.client_version).toBe("2");
		});
	});

	describe("approve and delete", () => {
		it("approves a pending node once", async () => {
			const n = await enroll({ hostname: "to-approve" });
			const approved = await approveNode(db, n.id, admin.userId);
			expect(approved).toMatchObject({ status: "active", approved_by_user_id: admin.userId });
			expect(approved.approved_at).not.toBeNull();
			await expect(approveNode(db, n.id, admin.userId)).rejects.toThrow(/not pending/);
		});

		it("delete removes shares and groups", async () => {
			const n = await enroll({ hostname: "to-delete" });
			await updateNodeFacts(db, n.id, { facts: FACTS, groups: ["g"] });
			await shareNode(db, {
				nodeId: n.id,
				granteeType: "user",
				granteeId: bob.userId,
				access: "view",
				createdBy: alice.userId,
			});
			await deleteNode(db, n.id);
			expect(await getNode(db, n.id)).toBeUndefined();
			expect(await db.selectFrom("shares").select("id").where("resource_id", "=", n.id).execute()).toHaveLength(0);
			expect(await db.selectFrom("node_groups").select("node_id").where("node_id", "=", n.id).execute()).toHaveLength(
				0,
			);
			await expect(deleteNode(db, n.id)).rejects.toThrow(/no such node/);
		});
	});
});
