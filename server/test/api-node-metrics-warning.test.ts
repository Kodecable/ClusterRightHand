import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import type { Cluster } from "../src/cluster/cluster.ts";
import { DEFAULT_SYSTEM_SETTINGS, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

// A node's metrics warning is filled in by the live server: the collector knows the failure and the
// route decides whether the node is online and collection is enabled (doc/design/metrics.md
// "Collection"). Both the list and the detail route go through the same live() mapping.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type MetricsWarning = { reason: string; since: string } | null;

async function addNode(db: Db, name: string, transport: "client" | "ssh"): Promise<string> {
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
			client_version: null,
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

describe("metrics warning on the node API", () => {
	let db: Db;
	let enabledApp: App;
	let disabledApp: App;
	let cookie: string;
	let disabledCookie: string;
	let crhaId: string;
	let sshId: string;
	const connected = new Set<string>();
	const failures = new Map<string, { reason: string; since: string }>();
	const warning = { reason: "no sample by the deadline", since: "2026-01-01T00:00:00.000Z" };

	const cluster = { isConnected: (id: string) => connected.has(id) } as unknown as Cluster;
	const metricsCollector = {
		latest: () => undefined,
		metricsFailure: (id: string) => failures.get(id),
	};
	// The session tests log in directly, so the runtime settings must allow the plain login; the
	// metrics switch is the one option these apps differ in.
	const makeSettings = (metricsEnabled: boolean) =>
		SettingsStore.fromSystemSettings({
			...DEFAULT_SYSTEM_SETTINGS,
			auth: { ...DEFAULT_SYSTEM_SETTINGS.auth, captcha: "none" },
			metrics: { ...DEFAULT_SYSTEM_SETTINGS.metrics, enabled: metricsEnabled },
		});
	const makeApp = (metricsEnabled: boolean) =>
		createApp(db, {
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			cluster,
			metricsCollector,
			settings: makeSettings(metricsEnabled),
		});

	/** The node's warning from both routes that map it through live(). */
	async function fromBothRoutes(app: App, sessionCookie: string, id: string) {
		const list = (await (await call(app, "/api/nodes", { cookie: sessionCookie })).json()) as {
			nodes: { id: string; metricsWarning: MetricsWarning }[];
		};
		const detail = (await (await call(app, `/api/nodes/${id}`, { cookie: sessionCookie })).json()) as {
			node: { metricsWarning: MetricsWarning };
		};
		return {
			list: list.nodes.find((node) => node.id === id)?.metricsWarning,
			detail: detail.node.metricsWarning,
		};
	}

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		await createUser(db, { username: "metrics-root", kind: "admin", password: "password-123" });
		crhaId = await addNode(db, "metrics-crha", "client");
		sshId = await addNode(db, "metrics-ssh", "ssh");
		enabledApp = makeApp(true);
		disabledApp = makeApp(false);
		cookie = await login(enabledApp, "metrics-root", "password-123");
		disabledCookie = await login(disabledApp, "metrics-root", "password-123");
	});

	beforeEach(() => {
		connected.clear();
		failures.clear();
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("shows the collector's failure for a connected, active crha node", async () => {
		connected.add(crhaId);
		failures.set(crhaId, warning);
		expect(await fromBothRoutes(enabledApp, cookie, crhaId)).toEqual({
			list: warning,
			detail: warning,
		});
	});

	it("shows no warning when the same crha node is not connected", async () => {
		// The collector still reports the failure, so only the route's online rule can hide it.
		failures.set(crhaId, warning);
		expect(connected.has(crhaId)).toBe(false);
		expect(await fromBothRoutes(enabledApp, cookie, crhaId)).toEqual({
			list: null,
			detail: null,
		});
	});

	it("shows no warning while metrics collection is disabled", async () => {
		connected.add(crhaId);
		failures.set(crhaId, warning);
		// The same connected node with collection on does show it, so the setting is what hides it.
		expect((await fromBothRoutes(enabledApp, cookie, crhaId)).list).toEqual(warning);
		expect(await fromBothRoutes(disabledApp, disabledCookie, crhaId)).toEqual({
			list: null,
			detail: null,
		});
	});

	it("shows the warning for an active SSH node, which has no connection state", async () => {
		failures.set(sshId, warning);
		// No cluster says this node is connected: an active SSH node is online by its transport.
		expect(connected.has(sshId)).toBe(false);
		const list = (await (await call(enabledApp, "/api/nodes", { cookie })).json()) as {
			nodes: { id: string; connected: boolean | null }[];
		};
		expect(list.nodes.find((node) => node.id === sshId)?.connected).toBeNull();
		expect(await fromBothRoutes(enabledApp, cookie, sshId)).toEqual({
			list: warning,
			detail: warning,
		});
	});
});
