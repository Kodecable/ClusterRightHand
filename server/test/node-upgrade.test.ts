/**
 * Planning a crha upgrade (doc/design/distribution.md "The upgrade task"): version order, which nodes are
 * upgraded by architecture and why the others are skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, crhaUpdateAvailable, planUpgrade, upgradeSpec } from "../src/cluster/node-upgrade.ts";
import { getNode, type NodeRow } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

describe("compareVersions", () => {
	it("orders release versions by SemVer precedence", () => {
		const ordered = [
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-alpha.beta",
			"1.0.0-beta.2",
			"1.0.0-beta.11",
			"1.0.0-rc.1",
			"1.0.0",
			"1.2.0",
			"1.10.0",
			"2.0.0",
		];
		for (let i = 0; i < ordered.length - 1; i++) {
			expect(compareVersions(ordered[i] as string, ordered[i + 1] as string)).toBeLessThan(0);
			expect(compareVersions(ordered[i + 1] as string, ordered[i] as string)).toBeGreaterThan(0);
		}
		expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
		expect(() => compareVersions("dev", "1.0.0")).toThrow();
	});
});

describe("crhaUpdateAvailable", () => {
	it("marks only a crha node whose release is older than crhs's release", () => {
		expect(crhaUpdateAvailable("client", "1.4.0", "1.5.0")).toBe(true);
		expect(crhaUpdateAvailable("client", "1.4.0-rc.1", "1.4.0")).toBe(true);
		expect(crhaUpdateAvailable("client", "1.5.0", "1.5.0")).toBe(false);
		expect(crhaUpdateAvailable("client", "1.6.0", "1.5.0")).toBe(false);
	});

	it("shows nothing when either side is not a release, or the node has no crha", () => {
		expect(crhaUpdateAvailable("client", "1.4.0+20260101", "1.5.0")).toBe(false);
		expect(crhaUpdateAvailable("client", "dev", "1.5.0")).toBe(false);
		expect(crhaUpdateAvailable("client", "1.4.0", "dev")).toBe(false);
		expect(crhaUpdateAvailable("client", null, "1.5.0")).toBe(false);
		expect(crhaUpdateAvailable("ssh", "1.4.0", "1.5.0")).toBe(false);
	});
});

describe("planUpgrade", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
	});

	afterEach(async () => {
		await db.destroy();
	});

	const addNode = async (
		name: string,
		options: { transport?: "client" | "ssh"; version?: string | null; facts?: object | null },
	): Promise<NodeRow> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name,
				transport: options.transport ?? "client",
				status: "active",
				public_key: options.transport === "ssh" ? null : Buffer.from(id).toString("base64"),
				hostname: name,
				facts: options.facts === null || options.facts === undefined ? null : JSON.stringify(options.facts),
				client_version: options.version === undefined ? "1.2.0" : options.version,
				privileged_mode: "forward",
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
		return (await getNode(db, id)) as NodeRow;
	};
	const able = (arch: string) => ({ hostname: "h", selfUpgrade: { available: true, reasons: [], arch } });

	it("groups the upgradable nodes by architecture and says why each other node is skipped", async () => {
		const nodes = [
			await addNode("web-1", { facts: able("amd64") }),
			await addNode("web-2", { facts: able("amd64"), version: "1.3.0-rc.1" }),
			await addNode("pi-1", { facts: able("arm64") }),
			await addNode("ssh-1", { transport: "ssh" }),
			await addNode("offline", { facts: able("amd64") }),
			await addNode("pkg", {
				facts: { hostname: "h", selfUpgrade: { available: false, reasons: ["package_managed"], arch: "amd64" } },
			}),
			await addNode("old-crha", { facts: { hostname: "h" } }),
			await addNode("no-arch", { facts: { hostname: "h", selfUpgrade: { available: true, reasons: [] } } }),
			await addNode("current", { facts: able("amd64"), version: "1.3.0" }),
			await addNode("newer", { facts: able("amd64"), version: "1.4.0" }),
			await addNode("dev", { facts: able("amd64"), version: "dev" }),
		];
		const offline = nodes.find((node) => node.name === "offline")?.id;
		const plan = await planUpgrade(db, nodes, "1.3.0", (id) => id !== offline);
		expect([...plan.byArch.keys()].sort()).toEqual(["amd64", "arm64"]);
		expect(plan.byArch.get("amd64")?.map((candidate) => candidate.name)).toEqual(["web-1", "web-2"]);
		expect(plan.byArch.get("arm64")?.map((candidate) => [candidate.name, candidate.version])).toEqual([
			["pi-1", "1.2.0"],
		]);
		expect(Object.fromEntries(plan.skipped.map((skip) => [skip.name, skip.reason]))).toEqual({
			"ssh-1": "not_crha",
			offline: "not_connected",
			pkg: "self_upgrade_unavailable",
			"old-crha": "self_upgrade_unavailable",
			"no-arch": "no_arch",
			current: "up_to_date",
			newer: "newer_than_crhs",
			dev: "not_a_release_version",
		});
		expect(plan.skipped.find((skip) => skip.name === "pkg")?.nodeReasons).toEqual(["package_managed"]);
	});

	it("skips a node whose upgrade has not ended", async () => {
		const node = await addNode("busy-upgrading", { facts: able("amd64") });
		for (const [kind, state] of [
			["node.upgrade", "awaiting_authorization"],
			["exec", "running"],
		] as const) {
			await db
				.insertInto("tasks")
				.values({
					id: newId(),
					org_id: node.org_id,
					node_id: node.id,
					kind,
					spec: "{}",
					attempt: 1,
					privileged: 1,
					output_mode: "full",
					state,
					timed_out: 0,
					actor_type: "user",
					actor_id: "u",
					on_behalf_of_user_id: "u",
					created_at: new Date().toISOString(),
					output_bytes: 0,
				} as never)
				.execute();
		}
		const plan = await planUpgrade(db, [node], "1.3.0", () => true);
		expect(plan.skipped).toMatchObject([{ name: "busy-upgrading", reason: "upgrade_in_progress" }]);
	});

	it("counts the tasks a restart would end", async () => {
		const node = await addNode("busy", { facts: able("amd64") });
		for (const state of ["running", "dispatched", "exited"] as const) {
			await db
				.insertInto("tasks")
				.values({
					id: newId(),
					org_id: node.org_id,
					node_id: node.id,
					kind: "exec",
					spec: "{}",
					attempt: 1,
					privileged: 0,
					output_mode: "full",
					state,
					timed_out: 0,
					actor_type: "user",
					actor_id: "u",
					on_behalf_of_user_id: "u",
					created_at: new Date().toISOString(),
					output_bytes: 0,
				} as never)
				.execute();
		}
		const plan = await planUpgrade(db, [node], "1.3.0", () => true);
		expect(plan.byArch.get("amd64")?.[0]?.runningTasks).toBe(2);
	});

	it("builds one spec per architecture from the binary", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const sha256 = new Uint8Array(32).fill(9);
		expect(upgradeSpec({ version: "1.3.0", arch: "arm64", bytes, sha256 })).toEqual({
			kind: "node.upgrade",
			version: "1.3.0",
			arch: "arm64",
			size: 3,
			sha256,
			endpoint: { kind: "crhs", transferId: "" },
		});
	});
});
