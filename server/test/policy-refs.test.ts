import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeGroup } from "../src/cluster/node-groups.ts";
import { nameRefs, parseRuleSetForWrite, parseRulesForWrite, ruleRefs, targetRefs } from "../src/policy/refs.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

describe("rule and target references", () => {
	let db: Db;
	let orgId: string;
	let nodeId: string;
	let groupId: string;
	let deletedId: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		orgId = await defaultOrgId(db);
		nodeId = newId();
		groupId = (await createNodeGroup(db, orgId, "Prod")).id;
		deletedId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: orgId,
				name: "Web-1",
				name_key: "web-1",
				transport: "client",
				status: "active",
				public_key: null,
				hostname: "web-1",
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
				ssh_host_fingerprint: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("parses names and ids into stored UUIDs, case-insensitively", async () => {
		const set = await parseRuleSetForWrite(
			db,
			orgId,
			{
				default: "deny",
				rules: [
					{ action: "allow", nodes: ["web-1", "PROD", "_all", nodeId, groupId] },
					{ action: "deny", method: "exec" },
				],
			},
			true,
		);
		expect(set.rules[0]?.nodes).toEqual([nodeId, groupId, "_all"]);
		// A rule without `nodes` is unchanged, and parsing does not invent one.
		expect(set.rules[1]).toEqual({ action: "deny", method: "exec" });
	});

	it("rejects unknown names and ids when a rule is written", async () => {
		const rule = (nodes: string[]) => ({ default: "deny", rules: [{ action: "allow", nodes }] });
		await expect(parseRuleSetForWrite(db, orgId, rule(["missing"]), true)).rejects.toThrow(
			/no node or node group missing/,
		);
		await expect(parseRuleSetForWrite(db, orgId, rule([newId()]), true)).rejects.toThrow(/no node or node group/);
		await expect(parseRuleSetForWrite(db, orgId, rule(["group:prod"]), true)).rejects.toThrow(/is not a node/);
	});

	it("maps stored UUIDs back to current names, and reports deleted objects as null", async () => {
		const refs = await ruleRefs(db, orgId, [{ action: "allow", nodes: [nodeId, groupId, "_all", deletedId] }]);
		expect(refs).toEqual({
			[nodeId]: { kind: "node", name: "Web-1" },
			[groupId]: { kind: "node_group", name: "Prod" },
			[deletedId]: null,
		});
		expect(await targetRefs(db, orgId, [nodeId, groupId, "_all"])).toEqual({
			[nodeId]: { kind: "node", name: "Web-1" },
			[groupId]: { kind: "node_group", name: "Prod" },
		});
		expect(await nameRefs(db, orgId, [])).toEqual({});
	});

	it("resolves rules through the same path as rule sets", async () => {
		const rules = await parseRulesForWrite(db, orgId, [
			{ action: "deny", nodes: ["prod"] },
			{ action: "allow", nodes: [nodeId] },
		]);
		expect(rules.map((rule) => rule.nodes)).toEqual([[groupId], [nodeId]]);
	});
});
