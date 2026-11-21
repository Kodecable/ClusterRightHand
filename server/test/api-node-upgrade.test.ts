/**
 * POST /api/nodes/upgrade (doc/design/distribution.md "The upgrade task"): a crhs that is no release
 * refuses, and every architecture's release is fetched and verified before any task group starts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import type { Cluster } from "../src/cluster/cluster.ts";
import { type CrhaBinary, type CrhaReleases, ReleaseError } from "../src/cluster/crha-release.ts";
import type { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

describe("POST /api/nodes/upgrade", () => {
	let db: Db;
	let cookie: string;
	const nodes: string[] = [];

	const addNode = async (name: string, arch: string) => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name,
				transport: "client",
				status: "active",
				public_key: Buffer.from(id).toString("base64"),
				hostname: name,
				facts: JSON.stringify({ hostname: name, selfUpgrade: { available: true, reasons: [], arch } }),
				client_version: "1.2.0",
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
		nodes.push(id);
	};

	const appWith = (version: string, binary: (arch: string) => Promise<CrhaBinary>) => {
		const created: string[] = [];
		const cluster = {
			isConnected: () => true,
			stageBytesForPush: async () => ({ kind: "test" }),
			transferContext: () => ({}),
		} as unknown as Cluster;
		const taskGroups = {
			create: async () => {
				const id = newId();
				created.push(id);
				return id;
			},
		} as unknown as TaskGroups;
		const crhaReleases = { version, binary } as unknown as CrhaReleases;
		const app: App = createApp(db, {
			serverFingerprint: "fp-test",
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			masterKey: MasterKey.generate(),
			cluster,
			taskGroups,
			crhaReleases,
		});
		return { app, created };
	};
	const upgrade = (app: App, dryRun: boolean) =>
		call(app, "/api/nodes/upgrade", { cookie, body: { targets: nodes, dryRun } });
	const audits = async (action: string) =>
		db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		await addNode("x86", "amd64");
		await addNode("pi", "arm64");
		cookie = await login(appWith("1.3.0", async () => Promise.reject(new Error("unused"))).app, "root", "password-123");
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("refuses on a crhs that is no release, also for a dry run", async () => {
		const { app } = appWith("dev", async () => Promise.reject(new Error("unused")));
		for (const dryRun of [true, false]) {
			const res = await upgrade(app, dryRun);
			expect(res.status).toBe(400);
			expect(await res.text()).toMatch(/not a release/);
		}
	});

	it("starts no group when one architecture's release fails, and audits the failure", async () => {
		const { app, created } = appWith("1.3.0", async (arch) => {
			if (arch === "arm64") throw new ReleaseError("release_invalid", "the Sigstore signature does not verify");
			return { arch, version: "1.3.0", bytes: Buffer.from("crha"), sha256: Buffer.alloc(32) } as unknown as CrhaBinary;
		});
		const res = await upgrade(app, false);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(created).toEqual([]);
		// The audit record is written without holding up the answer.
		const failed = await vi.waitFor(async () => {
			const rows = await audits("node.upgrade_failed");
			expect(rows).toHaveLength(1);
			return rows;
		});
		expect(JSON.parse(String(failed[0]?.detail))).toMatchObject({ arch: "arm64", code: "release_invalid" });
		expect(await audits("node.upgrade_requested")).toHaveLength(0);
	});

	it("skips only the nodes of an architecture the release has no crha for", async () => {
		const { app, created } = appWith("1.3.0", async (arch) => {
			if (arch === "arm64")
				throw new ReleaseError("release_no_arch", "the release has no crha-1.3.0-linux-arm64.tar.gz");
			return { arch, version: "1.3.0", bytes: Buffer.from("crha"), sha256: Buffer.alloc(32) } as unknown as CrhaBinary;
		});
		const res = await upgrade(app, false);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			upgrades: { name: string }[];
			skipped: { name: string; reason: string }[];
			taskGroups: { arch: string }[];
		};
		expect(body.upgrades.map((node) => node.name)).toEqual(["x86"]);
		expect(body.skipped).toMatchObject([{ name: "pi", reason: "release_unavailable" }]);
		expect(body.taskGroups.map((group) => group.arch)).toEqual(["amd64"]);
		expect(created).toHaveLength(1);
	});

	it("skips a node whose architecture cannot name a release asset", async () => {
		await addNode("odd", "x86-64");
		try {
			const { app } = appWith("1.3.0", async () => Promise.reject(new Error("unused")));
			const res = await upgrade(app, true);
			const body = (await res.json()) as { skipped: { name: string; reason: string }[] };
			expect(body.skipped).toContainEqual(expect.objectContaining({ name: "odd", reason: "unsupported_arch" }));
		} finally {
			nodes.pop();
		}
	});
});
