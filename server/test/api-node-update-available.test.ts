import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

// crhs's own version is the one a bundled release carries; the notice compares only two releases.
vi.mock("../src/version.ts", () => ({ CRH_VERSION: "1.5.0" }));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function addNode(
	db: Db,
	name: string,
	transport: "client" | "ssh",
	clientVersion: string | null,
): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport,
			status: "active",
			public_key: null,
			hostname: name,
			facts: null,
			client_version: clientVersion,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: transport === "ssh" ? "192.0.2.10" : null,
			ssh_port: transport === "ssh" ? 22 : null,
			ssh_user: transport === "ssh" ? "crh" : null,
			ssh_host_fingerprint: transport === "ssh" ? `SHA256:${"A".repeat(43)}` : null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	return id;
}

describe("update available on the node API", () => {
	let db: Db;
	let app: App;
	let cookie: string;
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		await createUser(db, { username: "update-root", kind: "admin", password: "password-123" });
		ids.older = await addNode(db, "update-older", "client", "1.4.0");
		ids.same = await addNode(db, "update-same", "client", "1.5.0");
		ids.newer = await addNode(db, "update-newer", "client", "1.6.0");
		ids.build = await addNode(db, "update-build", "client", "1.5.0+20260101");
		ids.ssh = await addNode(db, "update-ssh", "ssh", null);
		app = createApp(db, { clientAddress: () => "198.51.100.7", captcha: "none" });
		cookie = await login(app, "update-root", "password-123");
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("marks a crha node on an older release than crhs's own release", async () => {
		const list = (await (await call(app, "/api/nodes", { cookie })).json()) as {
			nodes: { id: string; updateAvailable: boolean }[];
		};
		const flag = (id: string) => list.nodes.find((node) => node.id === id)?.updateAvailable;
		expect(flag(ids.older as string)).toBe(true);
		expect(flag(ids.same as string)).toBe(false);
		expect(flag(ids.newer as string)).toBe(false);
		expect(flag(ids.build as string)).toBe(false);
		expect(flag(ids.ssh as string)).toBe(false);

		const detail = (await (await call(app, `/api/nodes/${ids.older}`, { cookie })).json()) as {
			node: { updateAvailable: boolean };
		};
		expect(detail.node.updateAvailable).toBe(true);
	});
});
