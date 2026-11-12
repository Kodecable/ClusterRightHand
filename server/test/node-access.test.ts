import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import { createEnrollmentToken, enrollNode, parseEnrollmentToken } from "../src/cluster/enrollment.ts";
import { createNodeGroup } from "../src/cluster/node-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { addUserGroupMember, createUserGroup } from "../src/users/user-groups.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describe("node access grants api (sqlite)", () => {
	let db: Db;
	let app: App;
	let cluster: Cluster;
	let adminCookie: string;
	let memberCookie: string;
	let adminId: string;
	let memberId: string;
	let nodeId: string;
	let nodeGroupId: string;
	let userGroupId: string;

	const req = (cookie: string, path: string, body?: unknown, method?: string) =>
		call(app, path, { cookie, body, method });

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { nodeOfflineGraceMs: 10 });
		app = makeApp(db, undefined, { cluster });
		const admin = await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		const member = await createUser(db, { username: "alice", kind: "member", password: "password-123" });
		adminId = admin.id;
		memberId = member.id;
		adminCookie = await login(app, "root", "password-123");
		memberCookie = await login(app, "alice", "password-123");
		const token = await createEnrollmentToken(db, { userId: adminId, serverFingerprint: "fp" });
		nodeId = (
			await enrollNode(db, {
				secret: parseEnrollmentToken(token.token).secret,
				publicKey: new Uint8Array(randomBytes(32)),
				hostname: "web-1",
				facts: {},
				clientVersion: "1",
			})
		).id;
		nodeGroupId = (await createNodeGroup(db, await defaultOrgId(db), "prod")).id;
		userGroupId = (await createUserGroup(db, "ops")).id;
		await addUserGroupMember(db, userGroupId, memberId);
	});
	afterAll(async () => {
		await cluster.close();
		await db.destroy();
	});

	it("is for administrators only", async () => {
		expect((await req(memberCookie, "/api/node-access-grants")).status).toBe(403);
		expect(
			(
				await req(
					memberCookie,
					"/api/node-access-grants",
					{
						granteeType: "user",
						granteeId: memberId,
						targetType: "node",
						targetId: nodeId,
					},
					"POST",
				)
			).status,
		).toBe(403);
	});

	it("creates direct, user-group and node-group grants, and lists them with names", async () => {
		const created = await Promise.all([
			req(
				adminCookie,
				"/api/node-access-grants",
				{ granteeType: "user", granteeId: memberId, targetType: "node", targetId: nodeId },
				"POST",
			),
			req(
				adminCookie,
				"/api/node-access-grants",
				{ granteeType: "user_group", granteeId: userGroupId, targetType: "node", targetId: nodeId },
				"POST",
			),
			req(
				adminCookie,
				"/api/node-access-grants",
				{ granteeType: "user", granteeId: memberId, targetType: "node_group", targetId: nodeGroupId },
				"POST",
			),
		]);
		for (const res of created) expect(res.status).toBe(201);
		const first = (await created[0]?.json()) as {
			grant: { id: string; granteeName: string; targetName: string; createdByUserId: string };
		};
		expect(first.grant).toMatchObject({
			granteeName: "alice",
			targetName: "web-1",
			createdByUserId: adminId,
		});

		const all = (await (await req(adminCookie, "/api/node-access-grants")).json()) as {
			grants: { granteeType: string; targetType: string }[];
		};
		expect(all.grants).toHaveLength(3);
		const filtered = (await (
			await req(adminCookie, `/api/node-access-grants?targetType=node&targetId=${nodeId}`)
		).json()) as { grants: { granteeType: string }[] };
		expect(filtered.grants.map((g) => g.granteeType).sort()).toEqual(["user", "user_group"]);
		const byGrantee = (await (
			await req(adminCookie, `/api/node-access-grants?granteeType=user&granteeId=${memberId}`)
		).json()) as { grants: { targetType: string }[] };
		expect(byGrantee.grants.map((g) => g.targetType).sort()).toEqual(["node", "node_group"]);
	});

	it("rejects a duplicate grant, unknown objects and bad input", async () => {
		const duplicate = await req(
			adminCookie,
			"/api/node-access-grants",
			{ granteeType: "user", granteeId: memberId, targetType: "node", targetId: nodeId },
			"POST",
		);
		expect(duplicate.status).toBe(409);
		for (const body of [
			{ granteeType: "user", granteeId: "missing", targetType: "node", targetId: nodeId },
			{ granteeType: "user", granteeId: memberId, targetType: "node", targetId: "missing" },
		]) {
			expect((await req(adminCookie, "/api/node-access-grants", body, "POST")).status).toBe(404);
		}
		for (const body of [
			{ granteeType: "team", granteeId: memberId, targetType: "node", targetId: nodeId },
			{ granteeType: "user", granteeId: memberId, targetType: "cluster", targetId: nodeId },
			{ granteeType: "user", targetType: "node", targetId: nodeId },
		]) {
			expect((await req(adminCookie, "/api/node-access-grants", body, "POST")).status).toBe(400);
		}
		expect((await req(adminCookie, "/api/node-access-grants?targetType=bogus")).status).toBe(400);
	});

	it("deletes a user group's grants with the user group", async () => {
		expect((await req(adminCookie, `/api/user-groups/${userGroupId}`, {}, "DELETE")).status).toBe(200);
		expect(
			await db.selectFrom("node_access_grants").select("id").where("grantee_id", "=", userGroupId).execute(),
		).toHaveLength(0);
	});

	it("deletes a grant and audits both ends", async () => {
		const list = (await (
			await req(adminCookie, `/api/node-access-grants?targetType=node&targetId=${nodeId}`)
		).json()) as {
			grants: { id: string }[];
		};
		const id = list.grants.find(Boolean)?.id as string;
		expect((await req(adminCookie, `/api/node-access-grants/${id}`, {}, "DELETE")).status).toBe(200);
		expect((await req(adminCookie, `/api/node-access-grants/${id}`, {}, "DELETE")).status).toBe(404);
		const events = (await (await req(adminCookie, "/api/audit?action=node_access_grant.")).json()) as {
			items: { action: string; detail: Record<string, unknown> }[];
		};
		const actions = events.items.map((e) => e.action);
		expect(actions).toContain("node_access_grant.created");
		expect(actions).toContain("node_access_grant.deleted");
		const deleted = events.items.find((e) => e.action === "node_access_grant.deleted");
		expect(deleted?.detail).toMatchObject({ grantee_type: "user", target_type: "node", target_id: nodeId });
	});
});
