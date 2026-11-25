import type { KyselyPlugin } from "kysely";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit, type AuditEvent } from "../src/audit/audit.ts";
import type { Cluster } from "../src/cluster/cluster.ts";
import { MetricsStore } from "../src/metrics/store.ts";
import { TRAFFIC_PERIOD_MS } from "../src/metrics/traffic.ts";
import { SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Aligned to the current minute, so the store's clock and the route's own clock share a period.
const SLOT = Math.floor(Date.now() / 60_000) * 60_000;

async function addNode(db: Db, name: string): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
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
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	return id;
}

/**
 * Wraps a database and counts the statements that select `node_traffic`, so the list's "one read per
 * request" promise is checked instead of assumed.
 */
function countNodeTrafficSelects(db: Db): { db: Db; selects: () => number } {
	let selects = 0;
	const plugin: KyselyPlugin = {
		transformQuery(args) {
			const node = args.node as unknown as {
				kind?: string;
				from?: { froms?: { table?: { identifier?: { name?: string } } }[] };
			};
			if (node.kind === "SelectQueryNode" && node.from?.froms?.[0]?.table?.identifier?.name === "node_traffic") {
				selects += 1;
			}
			return args.node;
		},
		async transformResult(args) {
			return args.result;
		},
	};
	return { db: db.withPlugin(plugin), selects: () => selects };
}

describeBackends("node traffic API", (backend) => {
	let db: Db;
	let app: App;
	let store: MetricsStore;
	let audit: Audit;
	let settings: SettingsStore;
	let rootCookie: string;
	let opCookie: string;
	let strangerCookie: string;
	let nodeId: string;
	let offlineNodeId: string;
	let freshNodeId: string;
	let rolledNodeId: string;

	const events = async (action: string): Promise<AuditEvent[]> => {
		await audit.flush();
		const res = await call(app, `/api/audit?action=${action}`, { cookie: rootCookie });
		return ((await res.json()) as { items: AuditEvent[] }).items;
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		store = new MetricsStore(db, { timer: false, now: () => SLOT });
		audit = new Audit(db);
		settings = await SettingsStore.load(db);
		const root = await createUser(db, { username: "traffic-root", kind: "admin", password: "password-123" });
		const op = await createUser(db, { username: "traffic-op", kind: "member", password: "password-123" });
		await createUser(db, { username: "traffic-stranger", kind: "member", password: "password-123" });
		nodeId = await addNode(db, "traffic-node");
		offlineNodeId = await addNode(db, "traffic-offline");
		freshNodeId = await addNode(db, "traffic-fresh");
		rolledNodeId = await addNode(db, "traffic-rolled");
		// A period that ended one period ago, with totals the read must roll in memory only.
		await db
			.insertInto("node_traffic")
			.values({
				node_id: rolledNodeId,
				period_start: new Date(SLOT - 2 * TRAFFIC_PERIOD_MS).toISOString(),
				next_reset_at: new Date(SLOT - TRAFFIC_PERIOD_MS).toISOString(),
				rx_bytes: 123,
				tx_bytes: 456,
			})
			.execute();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: op.id,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: root.id,
				created_at: new Date().toISOString(),
			})
			.execute();
		store.record(nodeId, SLOT, [
			{ name: "net.rx_bytes", kind: "delta", value: 5000 },
			{ name: "net.tx_bytes", kind: "delta", value: 7000 },
		]);
		await store.flush();
		// Only nodeId is connected: the list must still hide the warning of an offline node.
		const cluster = { isConnected: (id: string) => id === nodeId } as unknown as Cluster;
		app = createApp(db, {
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			audit,
			metricsStore: store,
			// No cluster: a client node's connection state is then false, so only nodeId is "online".
			metricsCollector: {
				latest: () => undefined,
				metricsFailure: (id) =>
					id === nodeId ? { reason: "no sample by the deadline", since: new Date(SLOT).toISOString() } : undefined,
				diskOrder: (id) => (id === nodeId ? ["data", "root"] : undefined),
			},
			cluster,
		});
		rootCookie = await login(app, "traffic-root", "password-123");
		opCookie = await login(app, "traffic-op", "password-123");
		strangerCookie = await login(app, "traffic-stranger", "password-123");
	});

	afterAll(async () => {
		await store.close();
		await db.destroy();
	});

	it("serves the current traffic period and the disk report order with the metrics", async () => {
		const res = await call(app, `/api/nodes/${nodeId}/metrics?series=up&from=${SLOT - 3_600_000}&to=${SLOT}`, {
			cookie: opCookie,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			diskOrder?: string[];
			traffic: { periodStart: string; nextResetAt: string; rxBytes: number; txBytes: number };
		};
		expect(body.diskOrder).toEqual(["data", "root"]);
		expect(body.traffic).toEqual({
			periodStart: new Date(SLOT).toISOString(),
			nextResetAt: new Date(SLOT + TRAFFIC_PERIOD_MS).toISOString(),
			rxBytes: 5000,
			txBytes: 7000,
		});

		const missing = (await (
			await call(app, `/api/nodes/${freshNodeId}/metrics?series=up&from=${SLOT - 3_600_000}&to=${SLOT}`, {
				cookie: rootCookie,
			})
		).json()) as { traffic: unknown; diskOrder?: unknown };
		expect(missing.traffic).toBeNull();
		expect(missing).not.toHaveProperty("diskOrder");

		const detail = (await (await call(app, `/api/nodes/${nodeId}`, { cookie: opCookie })).json()) as {
			node: { traffic: { rxBytes: number; txBytes: number } | null };
		};
		expect(detail.node.traffic).toMatchObject({ rxBytes: 5000, txBytes: 7000 });
		const freshDetail = (await (await call(app, `/api/nodes/${freshNodeId}`, { cookie: rootCookie })).json()) as {
			node: { traffic: unknown };
		};
		expect(freshDetail.node.traffic).toBeNull();
	});

	it("serves the list's traffic in one read per request, rolling a period without writing", async () => {
		const counted = countNodeTrafficSelects(db);
		// The store owns the read, so it must be the one bound to the instrumented database.
		const countedStore = new MetricsStore(counted.db, { timer: false, now: () => SLOT });
		const countedApp = createApp(counted.db, {
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			audit,
			metricsStore: countedStore,
			cluster: { isConnected: () => false } as unknown as Cluster,
		});
		const res = await call(countedApp, "/api/nodes", { cookie: rootCookie });
		await countedStore.close();
		expect(res.status).toBe(200);
		const list = (await res.json()) as {
			nodes: {
				id: string;
				traffic: { periodStart: string; nextResetAt: string; rxBytes: number; txBytes: number } | null;
			}[];
		};
		const trafficOf = (id: string) => list.nodes.find((node) => node.id === id)?.traffic;
		expect(trafficOf(nodeId)).toEqual({
			periodStart: new Date(SLOT).toISOString(),
			nextResetAt: new Date(SLOT + TRAFFIC_PERIOD_MS).toISOString(),
			rxBytes: 5000,
			txBytes: 7000,
		});
		expect(trafficOf(freshNodeId)).toBeNull();
		// The expired period is rolled for the answer, but the stored row keeps its old bounds and totals.
		expect(trafficOf(rolledNodeId)).toEqual({
			periodStart: new Date(SLOT).toISOString(),
			nextResetAt: new Date(SLOT + TRAFFIC_PERIOD_MS).toISOString(),
			rxBytes: 0,
			txBytes: 0,
		});
		expect(counted.selects()).toBe(1);
		const stored = await db
			.selectFrom("node_traffic")
			.select(["period_start", "next_reset_at", "rx_bytes", "tx_bytes"])
			.where("node_id", "=", rolledNodeId)
			.executeTakeFirstOrThrow();
		expect(stored).toEqual({
			period_start: new Date(SLOT - 2 * TRAFFIC_PERIOD_MS).toISOString(),
			next_reset_at: new Date(SLOT - TRAFFIC_PERIOD_MS).toISOString(),
			rx_bytes: 123,
			tx_bytes: 456,
		});

		// The same totals follow node access: the grantee sees its granted node, a stranger sees none.
		const memberList = (await (await call(app, "/api/nodes", { cookie: opCookie })).json()) as {
			nodes: { id: string; traffic: unknown }[];
		};
		expect(memberList.nodes.map((node) => node.id)).toEqual([nodeId]);
		expect(memberList.nodes[0]?.traffic).toMatchObject({ rxBytes: 5000, txBytes: 7000 });
		const strangerList = (await (await call(app, "/api/nodes", { cookie: strangerCookie })).json()) as {
			nodes: unknown[];
		};
		expect(strangerList.nodes).toEqual([]);
	});

	it("shows the metrics warning on an online node only", async () => {
		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: {
				id: string;
				metricsWarning: { reason: string; since: string } | null;
				updateAvailable: boolean;
			}[];
		};
		const online = list.nodes.find((node) => node.id === nodeId);
		expect(online?.metricsWarning).toEqual({
			reason: "no sample by the deadline",
			since: new Date(SLOT).toISOString(),
		});
		// The offline node keeps its status and gets no metrics warning.
		expect(list.nodes.find((node) => node.id === offlineNodeId)?.metricsWarning).toBeNull();
		for (const node of list.nodes) expect(node.updateAvailable).toBe(false);
	});

	it("shows no metrics warning while collection is off", async () => {
		// The settings are read per request, so a second app with the same database and session shows
		// the same node with collection turned off and on again.
		const withSettings = createApp(db, {
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			audit,
			settings,
			metricsStore: store,
			metricsCollector: {
				latest: () => undefined,
				metricsFailure: () => ({ reason: "no sample by the deadline", since: new Date(SLOT).toISOString() }),
			},
			cluster: { isConnected: () => true } as unknown as Cluster,
		});
		const warning = async () => {
			const list = (await (await call(withSettings, "/api/nodes", { cookie: rootCookie })).json()) as {
				nodes: { id: string; metricsWarning: unknown }[];
			};
			return list.nodes.find((node) => node.id === nodeId)?.metricsWarning;
		};
		await settings.patch(db, { metrics: { enabled: false } }, null);
		try {
			expect(await warning()).toBeNull();
		} finally {
			await settings.patch(db, { metrics: { enabled: true } }, null);
		}
		expect(await warning()).not.toBeNull();
	});

	it("refuses the mutations to members and hides them from other users", async () => {
		const asMember = await call(app, `/api/nodes/${nodeId}/traffic/reset`, {
			method: "POST",
			cookie: opCookie,
			body: {},
		});
		expect(asMember.status).toBe(403);
		const hidden = await call(app, `/api/nodes/${nodeId}/traffic/reset`, {
			method: "POST",
			cookie: strangerCookie,
			body: {},
		});
		expect(hidden.status).toBe(404);
		const noNode = await call(app, "/api/nodes/no-such-node/traffic/reset", {
			method: "POST",
			cookie: rootCookie,
			body: {},
		});
		expect(noNode.status).toBe(404);
	});

	it("resets the totals now and audits it", async () => {
		const res = await call(app, `/api/nodes/${nodeId}/traffic/reset`, {
			method: "POST",
			cookie: rootCookie,
			body: {},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { traffic: { periodStart: string; nextResetAt: string; rxBytes: number } };
		expect(body.traffic).toEqual({
			periodStart: new Date(SLOT).toISOString(),
			nextResetAt: new Date(SLOT + TRAFFIC_PERIOD_MS).toISOString(),
			rxBytes: 0,
			txBytes: 0,
		});
		const [event] = await events("node.traffic_reset");
		expect(event).toMatchObject({
			targetType: "node",
			targetId: nodeId,
			detail: { previous_rx_bytes: 5000, previous_tx_bytes: 7000 },
		});
	});

	it("rejects a next reset that is not in the future or more than 30 days away", async () => {
		const now = Date.now();
		const invalid = [
			new Date(now - 60_000).toISOString(),
			new Date(now + TRAFFIC_PERIOD_MS + 60_000).toISOString(),
			"not-a-time",
			// A zoneless local time would make the server's timezone decide the period.
			"2026-12-01T10:00:00",
		];
		for (const nextResetAt of invalid) {
			const res = await call(app, `/api/nodes/${nodeId}/traffic/next-reset`, {
				method: "PUT",
				cookie: rootCookie,
				body: { nextResetAt },
			});
			expect(res.status, nextResetAt).toBe(400);
		}
	});

	it("sets a new period end, keeps the totals and audits it", async () => {
		// Give the node traffic again: a reset above zeroed it.
		store.record(nodeId, SLOT + 60_000, [
			{ name: "net.rx_bytes", kind: "delta", value: 11 },
			{ name: "net.tx_bytes", kind: "delta", value: 22 },
		]);
		await store.flush();
		const nextResetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const res = await call(app, `/api/nodes/${nodeId}/traffic/next-reset`, {
			method: "PUT",
			cookie: rootCookie,
			body: { nextResetAt },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			traffic: { periodStart: string; nextResetAt: string; rxBytes: number; txBytes: number };
		};
		expect(body.traffic).toEqual({
			periodStart: new Date(SLOT).toISOString(),
			nextResetAt,
			rxBytes: 11,
			txBytes: 22,
		});
		const [event] = await events("node.traffic_next_reset_set");
		expect(event).toMatchObject({ targetId: nodeId, detail: { next_reset_at: nextResetAt } });
	});

	it("creates a row for a node that has no traffic yet", async () => {
		const nextResetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const before = Date.now();
		const res = await call(app, `/api/nodes/${freshNodeId}/traffic/next-reset`, {
			method: "PUT",
			cookie: rootCookie,
			body: { nextResetAt },
		});
		const after = Date.now();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			traffic: { periodStart: string; nextResetAt: string; rxBytes: number; txBytes: number };
		};
		// A row that did not exist starts now, on the route's clock.
		expect(Date.parse(body.traffic.periodStart)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(body.traffic.periodStart)).toBeLessThanOrEqual(after);
		expect(body.traffic).toMatchObject({ nextResetAt, rxBytes: 0, txBytes: 0 });
		expect(offlineNodeId).not.toBe(freshNodeId);
	});
});
