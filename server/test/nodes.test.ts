import { randomBytes } from "node:crypto";
import type { Facts, TrustSummary } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import {
	createEnrollmentToken,
	EnrollmentError,
	enrollNode,
	enrollNodeWithResult,
	parseEnrollmentToken,
} from "../src/cluster/enrollment.ts";
import { keyFingerprint } from "../src/cluster/identity.ts";
import { createNodeAccessGrant, deleteNodeAccessGrant, listNodeAccessGrants } from "../src/cluster/node-access.ts";
import { createNodeGroup, setNodeGroupsForNode } from "../src/cluster/node-groups.ts";
import {
	approveNode,
	deleteNode,
	findNodeByPublicKey,
	getNode,
	listNodesForUser,
	nodeAccess,
	updateNodeFacts,
} from "../src/cluster/nodes.ts";
import { recordTrustReport } from "../src/cluster/trust.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { addUserGroupMember, createUserGroup } from "../src/users/user-groups.ts";
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
	clockOffsetMs: 0,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
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

		it("is single-use, and the node belongs to the organization", async () => {
			const { token } = await createEnrollmentToken(db, { userId: bob.userId, serverFingerprint: FP });
			const node = await enrollNode(db, {
				secret: secretOf(token),
				publicKey: key(),
				hostname: "single",
				facts: { a: 1 },
				clientVersion: "1",
			});
			expect(node).toMatchObject({ status: "pending", transport: "client", name: "single" });
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
			const ok = await enrollNode(db, {
				...base,
				secret: secretOf(token),
				now: new Date(now.getTime() + 500),
			});
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
			expect(a.name).toBe("Web-Server_01.Example");
			const b = await enroll({ hostname: "Web Server_01.Example!" });
			expect(b.name).toBe("Web-Server_01.Example-2");
			const c = await enroll({ hostname: "dup" });
			const d = await enroll({ hostname: "dup" });
			const e = await enroll({ hostname: "dup" });
			expect([c.name, d.name, e.name]).toEqual(["dup", "dup-2", "dup-3"]);
			// Generated names share the namespace with node groups too.
			await createNodeGroup(db, await defaultOrgId(db), "Taken");
			const groupCollision = await enroll({ hostname: "Taken" });
			expect(groupCollision.name).toBe("Taken-2");
			const hinted = await enroll({ nameHint: "Build Box", hostname: "ignored" });
			expect(hinted.name).toBe("Build-Box");
			const long = await enroll({ hostname: "x".repeat(100) });
			expect(long.name).toHaveLength(64);
			const long2 = await enroll({ hostname: "x".repeat(100) });
			expect(long2.name).toHaveLength(64);
			expect(long2.name.endsWith("-2")).toBe(true);
		});

		it("finds nodes by public key", async () => {
			const pk = key();
			const n = await enroll({ publicKey: pk, hostname: "findme" });
			expect((await findNodeByPublicKey(db, pk))?.id).toBe(n.id);
			expect(await findNodeByPublicKey(db, key())).toBeUndefined();
		});
	});

	describe("access grants", () => {
		let node: string;
		let team: string;
		const org = () => defaultOrgId(db);
		const grant = (input: {
			granteeType: "user" | "user_group";
			granteeId: string;
			targetType: "node" | "node_group";
			targetId: string;
			orgId: string;
		}) => createNodeAccessGrant(db, { ...input, createdByUserId: admin.userId });
		beforeAll(async () => {
			node = (await enroll({ hostname: "shared-node" })).id;
			team = (await createUserGroup(db, "team")).id;
			await addUserGroupMember(db, team, bob.userId);
		});

		it("reaches nodes through direct and user-group grants (admin sees all)", async () => {
			const orgId = await org();
			expect(await nodeAccess(db, admin, node)).toBe("admin");
			expect(await nodeAccess(db, alice, node)).toBeUndefined();
			expect(await nodeAccess(db, bob, node)).toBeUndefined();
			expect(await nodeAccess(db, alice, "00000000-0000-7000-8000-000000000000")).toBeUndefined();

			await grant({ granteeType: "user_group", granteeId: team, targetType: "node", targetId: node, orgId });
			expect(await nodeAccess(db, bob, node)).toBe("granted");
			expect(await nodeAccess(db, carol, node)).toBeUndefined();

			await grant({ granteeType: "user", granteeId: bob.userId, targetType: "node", targetId: node, orgId });
			expect(await nodeAccess(db, bob, node)).toBe("granted");
			expect((await listNodeAccessGrants(db)).map((g) => g.granteeType).sort()).toEqual(["user", "user_group"]);
			await expect(
				grant({ granteeType: "user", granteeId: bob.userId, targetType: "node", targetId: node, orgId }),
			).rejects.toThrow(/already exists/);
		});

		it("expands a node-group grant to its current members", async () => {
			const orgId = await org();
			const group = await createNodeGroup(db, orgId, "granted-group");
			const n = await enroll({ hostname: "grouped" });
			await grant({
				granteeType: "user",
				granteeId: carol.userId,
				targetType: "node_group",
				targetId: group.id,
				orgId,
			});
			expect(await nodeAccess(db, carol, n.id)).toBeUndefined();
			await setNodeGroupsForNode(db, n.id, [group.id]);
			expect(await nodeAccess(db, carol, n.id)).toBe("granted");
			await setNodeGroupsForNode(db, n.id, []);
			expect(await nodeAccess(db, carol, n.id)).toBeUndefined();
		});

		it("deletes grants individually", async () => {
			const orgId = await org();
			const grants = await listNodeAccessGrants(db, { granteeType: "user_group", granteeId: team });
			expect(grants).toHaveLength(1);
			await deleteNodeAccessGrant(db, grants[0]?.id as string);
			expect(await nodeAccess(db, bob, node)).toBe("granted"); // the direct grant is still there
			const direct = await listNodeAccessGrants(db, { granteeType: "user", granteeId: bob.userId });
			await deleteNodeAccessGrant(db, direct[0]?.id as string);
			expect(await nodeAccess(db, bob, node)).toBeUndefined();
			await expect(deleteNodeAccessGrant(db, grants[0]?.id as string)).rejects.toThrow(/no such grant/);
			void orgId;
		});
	});

	describe("listing and facts", () => {
		it("lists accessible nodes with access, groups and facts, ordered by name", async () => {
			const u = session(await createUser(db, { username: "lister", kind: "member" }));
			const o = session(await createUser(db, { username: "lowner", kind: "member" }));
			const a = await enroll({ user: u, nameHint: "zz-mine" });
			const b = await enroll({ user: o, nameHint: "aa-theirs" });
			const c = await enroll({ user: o, nameHint: "mm-hidden" });
			const orgId = await defaultOrgId(db);
			await createNodeAccessGrant(db, {
				orgId,
				granteeType: "user",
				granteeId: u.userId,
				targetType: "node",
				targetId: a.id,
				createdByUserId: admin.userId,
			});
			await createNodeAccessGrant(db, {
				orgId,
				granteeType: "user",
				granteeId: u.userId,
				targetType: "node",
				targetId: b.id,
				createdByUserId: admin.userId,
			});
			await updateNodeFacts(db, a.id, { facts: FACTS, privilegedMode: "native" });
			const dbGroup = await createNodeGroup(db, orgId, "db");
			const webGroup = await createNodeGroup(db, orgId, "web");
			await setNodeGroupsForNode(db, a.id, [webGroup.id, dbGroup.id]);

			const list = await listNodesForUser(db, u);
			expect(list.map((n) => n.name)).toEqual(["aa-theirs", "zz-mine"]);
			expect(list[0]).toMatchObject({ access: "granted", nodeGroups: [], facts: FACTS });
			expect(list[1]).toMatchObject({
				access: "granted",
				nodeGroups: [
					{ id: dbGroup.id, name: "db" },
					{ id: webGroup.id, name: "web" },
				],
				privilegedMode: "native",
				facts: FACTS,
			});
			const all = await listNodesForUser(db, admin);
			expect(all.map((n) => n.id)).toContain(c.id);
			expect(all.every((n) => n.access === "admin")).toBe(true);
			expect((await listNodesForUser(db, carol)).map((n) => n.id)).not.toContain(a.id);
		});

		it("computes trust alias warnings for the listed nodes", async () => {
			const u = session(await createUser(db, { username: "warned", kind: "member" }));
			const n = await enroll({ user: u, hostname: "warned-node" });
			const orgId = await defaultOrgId(db);
			await createNodeAccessGrant(db, {
				orgId,
				granteeType: "user",
				granteeId: u.userId,
				targetType: "node",
				targetId: n.id,
				createdByUserId: admin.userId,
			});
			const web = await createNodeGroup(db, orgId, "warn-web");
			const prod = await createNodeGroup(db, orgId, "warn-prod");
			await setNodeGroupsForNode(db, n.id, [web.id, prod.id]);
			await updateNodeFacts(db, n.id, { facts: FACTS, privilegedMode: "forward" });
			const unknown = "0192f000-0000-7000-8000-0000000000ff";
			const summary: TrustSummary = {
				nodeId: n.id,
				aliases: [web.id, unknown],
				clockSkewMs: 60_000,
				identities: {
					unprivileged: { uid: 998, gid: 998, user: "crha" },
					privileged: { uid: 0, gid: 0, user: "root" },
				},
				trust: [],
			};
			await recordTrustReport(db, n.id, { kind: "ok", summary });
			const [node] = await listNodesForUser(db, u, { crhsFingerprints: ["SHA256:crhs"] });
			expect(node?.trustWarnings.map((warning) => warning.kind)).toEqual(["alias_unknown", "alias_missing"]);
			expect(node?.trustWarnings.find((warning) => warning.kind === "alias_missing")).toMatchObject({
				uuid: prod.id,
				nodeGroupName: "warn-prod",
			});
		});

		it("reads a facts row stored before shells existed", async () => {
			const u = session(await createUser(db, { username: "legacy", kind: "member" }));
			const n = await enroll({ user: u });
			await createNodeAccessGrant(db, {
				orgId: await defaultOrgId(db),
				granteeType: "user",
				granteeId: u.userId,
				targetType: "node",
				targetId: n.id,
				createdByUserId: admin.userId,
			});
			const { shells: _shells, ...legacy } = FACTS;
			await updateNodeFacts(db, n.id, { facts: legacy });
			const [node] = await listNodesForUser(db, u);
			// The absent key stays absent: an optional fact the row does not have is unknown.
			expect(node?.facts).toEqual(legacy);
		});

		it("shows an SSH node's probed shells as its only facts", async () => {
			const u = session(await createUser(db, { username: "sshowner", kind: "member" }));
			const n = await enroll({ user: u });
			await createNodeAccessGrant(db, {
				orgId: await defaultOrgId(db),
				granteeType: "user",
				granteeId: u.userId,
				targetType: "node",
				targetId: n.id,
				createdByUserId: admin.userId,
			});
			const shells = { sh: "/usr/bin/sh", bash: "/usr/bin/bash" };
			await db
				.updateTable("nodes")
				.set({ transport: "ssh", facts: JSON.stringify({ shells }) })
				.where("id", "=", n.id)
				.execute();
			const [node] = await listNodesForUser(db, u);
			expect(node?.facts).toEqual({ shells });
		});

		it("updateNodeFacts updates the facts and leaves crhs-managed groups alone", async () => {
			const n = await enroll({ hostname: "facts-node" });
			const group = await createNodeGroup(db, await defaultOrgId(db), "facts-group");
			await setNodeGroupsForNode(db, n.id, [group.id]);
			const t1 = new Date("2031-01-01T00:00:00Z");
			await updateNodeFacts(db, n.id, {
				facts: { ...FACTS, hostname: "first" },
				clientVersion: "2",
				now: t1,
			});
			let row = await getNode(db, n.id);
			expect(row).toMatchObject({ last_seen_at: t1.toISOString(), client_version: "2" });
			expect(JSON.parse(row?.facts ?? "null")).toEqual({ ...FACTS, hostname: "first" });
			const memberships = await db
				.selectFrom("node_group_members")
				.select("node_group_id")
				.where("node_id", "=", n.id)
				.execute();
			expect(memberships.map((m) => m.node_group_id)).toEqual([group.id]);
			await updateNodeFacts(db, n.id, { facts: { ...FACTS, hostname: "second" } });
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

		it("delete removes grants and group memberships", async () => {
			const n = await enroll({ hostname: "to-delete" });
			const group = await createNodeGroup(db, await defaultOrgId(db), "gg");
			await setNodeGroupsForNode(db, n.id, [group.id]);
			await createNodeAccessGrant(db, {
				orgId: await defaultOrgId(db),
				granteeType: "user",
				granteeId: bob.userId,
				targetType: "node",
				targetId: n.id,
				createdByUserId: alice.userId,
			});
			await deleteNode(db, n.id);
			expect(await getNode(db, n.id)).toBeUndefined();
			expect(
				await db.selectFrom("node_access_grants").select("id").where("target_id", "=", n.id).execute(),
			).toHaveLength(0);
			expect(
				await db.selectFrom("node_group_members").select("node_id").where("node_id", "=", n.id).execute(),
			).toHaveLength(0);
			await expect(deleteNode(db, n.id)).rejects.toThrow(/no such node/);
		});
	});

	describe("re-enrollment", () => {
		it("replaces a node's key but keeps its id, name, node groups and access grants", async () => {
			const oldKey = key();
			const org = await defaultOrgId(db);
			const { token: enrollToken } = await createEnrollmentToken(db, {
				userId: alice.userId,
				serverFingerprint: FP,
			});
			const n = await enrollNode(db, {
				secret: secretOf(enrollToken),
				publicKey: oldKey,
				hostname: "old-host",
				facts: FACTS,
				clientVersion: "1",
			});
			await approveNode(db, n.id, admin.userId);
			const group = await createNodeGroup(db, org, "reenroll-group");
			await setNodeGroupsForNode(db, n.id, [group.id]);
			await createNodeAccessGrant(db, {
				orgId: org,
				granteeType: "user",
				granteeId: bob.userId,
				targetType: "node",
				targetId: n.id,
				createdByUserId: alice.userId,
			});
			const before = await getNode(db, n.id);
			expect(before?.public_key).toBe(Buffer.from(oldKey).toString("base64"));
			const oldFingerprint = keyFingerprint(oldKey);
			const trustAt = new Date("2032-01-01T00:00:00Z").toISOString();
			await db
				.updateTable("nodes")
				.set({
					privileged_mode: "forward",
					last_seen_at: trustAt,
					trust_report: JSON.stringify({ kind: "not_forward" }),
					trust_digest: "old-digest",
					trust_updated_at: trustAt,
				})
				.where("id", "=", n.id)
				.execute();

			const audit = new Audit(db);
			const { token, id: tokenId } = await createEnrollmentToken(db, {
				userId: admin.userId,
				serverFingerprint: FP,
				boundNodeId: n.id,
			});
			const newKey = key();
			const newFacts = { ...FACTS, hostname: "new-host" };
			const result = await enrollNodeWithResult(db, {
				secret: secretOf(token),
				publicKey: newKey,
				hostname: "new-host",
				facts: newFacts,
				clientVersion: "2",
				audit,
			});

			expect(result.node.id).toBe(n.id);
			expect(result.reenrolled).toEqual({
				oldFingerprint,
				newFingerprint: keyFingerprint(newKey),
			});
			const row = await getNode(db, n.id);
			expect(row).toMatchObject({
				id: n.id,
				name: n.name,
				status: "pending",
				hostname: "new-host",
				client_version: "2",
				privileged_mode: null,
				last_seen_at: null,
				approved_at: null,
				approved_by_user_id: null,
				trust_report: null,
				trust_digest: null,
				trust_updated_at: null,
			});
			expect(row?.public_key).toBe(Buffer.from(newKey).toString("base64"));
			expect(JSON.parse(row?.facts ?? "null")).toEqual(newFacts);
			expect(await findNodeByPublicKey(db, oldKey)).toBeUndefined();
			expect((await findNodeByPublicKey(db, newKey))?.id).toBe(n.id);
			expect(
				(await db.selectFrom("node_group_members").select("node_group_id").where("node_id", "=", n.id).execute()).map(
					(member) => member.node_group_id,
				),
			).toEqual([group.id]);
			expect(await listNodeAccessGrants(db, { targetType: "node", targetId: n.id })).toMatchObject([
				{ granteeId: bob.userId },
			]);
			// The token is single use, and it belongs to the node it replaced.
			const tokenRow = await db
				.selectFrom("enrollment_tokens")
				.selectAll()
				.where("id", "=", tokenId)
				.executeTakeFirst();
			expect(tokenRow).toMatchObject({ bound_node_id: n.id, used_by_node_id: n.id });
			await expect(
				enrollNode(db, {
					secret: secretOf(token),
					publicKey: key(),
					hostname: "again",
					facts: {},
					clientVersion: "3",
				}),
			).rejects.toThrow(INVALID);
			// Approval works as for any pending node.
			expect((await approveNode(db, n.id, admin.userId)).status).toBe("active");

			await audit.flush();
			const events = await db
				.selectFrom("audit_events")
				.selectAll()
				.where("action", "=", "node.reenrolled")
				.where("target_id", "=", n.id)
				.execute();
			expect(events).toHaveLength(1);
			expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({
				old_fingerprint: oldFingerprint,
				new_fingerprint: keyFingerprint(newKey),
			});
		});

		it("refuses an expired re-enrollment token and leaves the node unchanged", async () => {
			const n = await enroll({ hostname: "expired-reenroll" });
			const before = await getNode(db, n.id);
			const now = new Date("2032-01-01T00:00:00Z");
			const { token } = await createEnrollmentToken(db, {
				userId: alice.userId,
				serverFingerprint: FP,
				boundNodeId: n.id,
				ttlMs: 1000,
				now,
			});
			await expect(
				enrollNode(db, {
					secret: secretOf(token),
					publicKey: key(),
					hostname: "late",
					facts: {},
					clientVersion: "1",
					now: new Date(now.getTime() + 2000),
				}),
			).rejects.toThrow(INVALID);
			expect(await getNode(db, n.id)).toMatchObject({
				status: before?.status,
				public_key: before?.public_key,
				hostname: before?.hostname,
			});
		});

		it("invalidates the token when the bound node was deleted meanwhile", async () => {
			const n = await enroll({ hostname: "deleted-reenroll" });
			const { token } = await createEnrollmentToken(db, {
				userId: alice.userId,
				serverFingerprint: FP,
				boundNodeId: n.id,
			});
			const tokenRow = await db
				.selectFrom("enrollment_tokens")
				.select("id")
				.where("bound_node_id", "=", n.id)
				.execute();
			expect(tokenRow).toHaveLength(1);
			await deleteNode(db, n.id);
			expect(
				await db
					.selectFrom("enrollment_tokens")
					.select("id")
					.where("id", "=", tokenRow[0]?.id ?? "")
					.execute(),
			).toHaveLength(0);
			await expect(
				enrollNode(db, {
					secret: secretOf(token),
					publicKey: key(),
					hostname: "too-late",
					facts: {},
					clientVersion: "1",
				}),
			).rejects.toThrow(INVALID);
		});

		it("refuses to bind a token to an SSH node", async () => {
			const n = await enroll({ hostname: "ssh-reenroll" });
			await db.updateTable("nodes").set({ transport: "ssh" }).where("id", "=", n.id).execute();
			await expect(
				createEnrollmentToken(db, {
					userId: admin.userId,
					serverFingerprint: FP,
					boundNodeId: n.id,
				}),
			).rejects.toThrow(/SSH nodes cannot be re-enrolled/);
		});
	});
});
