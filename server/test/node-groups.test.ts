import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createNodeGroup,
	deleteNodeGroup,
	getNodeGroup,
	listNodeGroups,
	nodeGroupIdsForNodes,
	nodeGroupsForNodes,
	renameNodeGroup,
	resolveNodeGroupIds,
	setNodeGroupMembers,
	setNodeGroupsForNode,
} from "../src/cluster/node-groups.ts";
import { renameNode } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

describe("node groups", () => {
	let db: Db;
	let orgId: string;
	let ownerUserId: string;

	async function addNode(name: string): Promise<string> {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: orgId,
				owner_user_id: ownerUserId,
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status: "active",
				public_key: null,
				hostname: name,
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		return id;
	}

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		orgId = await defaultOrgId(db);
		ownerUserId = (await createUser(db, { username: "owner", kind: "member" })).id;
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("creates, renames and deletes groups, and resolves names case-insensitively", async () => {
		const created = await createNodeGroup(db, orgId, "Web.Prod");
		expect(created).toMatchObject({ name: "Web.Prod", memberIds: [] });
		expect(await resolveNodeGroupIds(db, orgId, ["web.prod", created.id])).toEqual([created.id]);

		const renamed = await renameNodeGroup(db, created.id, "Front-End");
		expect(renamed).toMatchObject({ id: created.id, name: "Front-End" });
		expect(await resolveNodeGroupIds(db, orgId, ["front-end"])).toEqual([created.id]);

		await deleteNodeGroup(db, created.id);
		expect(await getNodeGroup(db, created.id)).toBeUndefined();
		await expect(renameNodeGroup(db, created.id, "Nope")).rejects.toThrow(/no such node group/);
		await expect(deleteNodeGroup(db, created.id)).rejects.toThrow(/no such node group/);
	});

	it("keeps one shared namespace with nodes per organization, case-insensitively", async () => {
		const nodeId = await addNode("Web-1");
		await expect(createNodeGroup(db, orgId, "web-1")).rejects.toThrow(/node named "web-1" already exists/);

		const group = await createNodeGroup(db, orgId, "Editors");
		await expect(createNodeGroup(db, orgId, "EDITORS")).rejects.toThrow(/node group named "EDITORS"/);
		await expect(renameNodeGroup(db, group.id, "Web-1")).rejects.toThrow(/node named "Web-1" already exists/);

		// The node side applies the same rule: renaming a node onto a group's name is rejected.
		await expect(renameNode(db, nodeId, "Editors")).rejects.toThrow(/node group named "Editors"/);
		// A case-only rename of the node itself is allowed and keeps the display case.
		const renamed = await renameNode(db, nodeId, "WEB-1");
		expect(renamed).toMatchObject({ name: "WEB-1", name_key: "web-1" });
	});

	it("manages memberships from both sides and filters them to the organization", async () => {
		const a = await addNode("node-a");
		const b = await addNode("node-b");
		const group = await createNodeGroup(db, orgId, "Batch");

		const withMembers = await setNodeGroupMembers(db, group.id, [a, b, a]);
		expect(withMembers.memberIds.sort()).toEqual([a, b].sort());
		expect((await nodeGroupsForNodes(db, [a]))?.get(a)).toEqual([{ id: group.id, name: "Batch" }]);
		expect((await nodeGroupIdsForNodes(db, [b])).get(b)).toEqual([group.id]);

		// The node side replaces the memberships it has.
		await setNodeGroupsForNode(db, a, []);
		await setNodeGroupsForNode(db, b, [group.id]);
		expect((await getNodeGroup(db, group.id))?.memberIds).toEqual([b]);
		expect((await nodeGroupsForNodes(db, [a])).has(a)).toBe(false);

		await expect(setNodeGroupMembers(db, group.id, ["missing"])).rejects.toThrow(/no such node/);
		await expect(setNodeGroupsForNode(db, a, ["missing"])).rejects.toThrow(/no such node group/);

		await deleteNodeGroup(db, group.id);
		expect((await nodeGroupIdsForNodes(db, [b])).has(b)).toBe(false);
		expect(await listNodeGroups(db)).toEqual([]);
	});
});
