import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import type { LatestMetrics } from "../src/metrics/collector.ts";
import { DEFAULT_METRICS_RETENTION_MS, METRIC_LEVEL_BUCKET_MS } from "../src/metrics/levels.ts";
import { MetricsStore } from "../src/metrics/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The store's fixed clock: level choice must not depend on the wall clock of the test run. */
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const SLOT = NOW - 10 * MINUTE;

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

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

describeBackends("node metrics API", (backend) => {
	let db: Db;
	let app: App;
	let store: MetricsStore;
	let rootCookie: string;
	let opCookie: string;
	let strangerCookie: string;
	let rootId: string;
	let opId: string;
	let nodeId: string;
	let otherNodeId: string;
	let staleNodeId: string;
	let rootDiskNodeId: string;
	let rootFallbackNodeId: string;
	let alphaDiskNodeId: string;
	let bareNodeId: string;
	let staleSlot: number;

	const series = async (who: string, id: string, query: Record<string, string>) => {
		const params = new URLSearchParams(query);
		return call(app, `/api/nodes/${id}/metrics?${params.toString()}`, { cookie: who });
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		store = new MetricsStore(db, {
			timer: false,
			flushIntervalMs: 0,
			now: () => NOW,
			retention: () => DEFAULT_METRICS_RETENTION_MS,
		});
		const root = await createUser(db, { username: "metrics-root", kind: "admin", password: "password-123" });
		const op = await createUser(db, { username: "metrics-op", kind: "member", password: "password-123" });
		await createUser(db, { username: "metrics-stranger", kind: "member", password: "password-123" });
		rootId = root.id;
		opId = op.id;
		nodeId = await addNode(db, "metrics-node");
		otherNodeId = await addNode(db, "metrics-other");
		staleNodeId = await addNode(db, "metrics-stale");
		rootDiskNodeId = await addNode(db, "metrics-root-disk");
		rootFallbackNodeId = await addNode(db, "metrics-root-fallback");
		alphaDiskNodeId = await addNode(db, "metrics-alpha-disk");
		bareNodeId = await addNode(db, "metrics-bare");
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: opId,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: rootId,
				created_at: new Date().toISOString(),
			})
			.execute();
		const latest: LatestMetrics = {
			slotStartMs: Date.now(),
			values: [
				{ name: "up", kind: "gauge", value: 1 },
				{ name: "uptime", kind: "gauge", value: 7200 },
				{ name: "cpu.total", kind: "gauge", value: 0.25 },
				{ name: "mem.total_bytes", kind: "gauge", value: 1000 },
				{ name: "mem.available_bytes", kind: "gauge", value: 250 },
				// Report order is data first, but only the collector knows it; root has complete values too.
				{ name: "disk.data.used_bytes", kind: "gauge", value: 1500 },
				{ name: "disk.data.total_bytes", kind: "gauge", value: 2000 },
				{ name: "disk.root.used_bytes", kind: "gauge", value: 500 },
				{ name: "disk.root.total_bytes", kind: "gauge", value: 1000 },
				{ name: "net.rx_bytes_per_sec", kind: "gauge", value: 1234 },
				{ name: "net.tx_bytes_per_sec", kind: "gauge", value: 567 },
			],
		};
		// Four minutes back: past three default 60-second intervals, so the list marks it stale.
		staleSlot = Date.now() - 4 * MINUTE;
		const latestByNode = new Map<string, LatestMetrics>([
			[nodeId, latest],
			[
				staleNodeId,
				{
					slotStartMs: staleSlot,
					values: [
						{ name: "up", kind: "gauge", value: 1 },
						{ name: "cpu.total", kind: "gauge", value: 0.5 },
						{ name: "mem.total_bytes", kind: "gauge", value: 1000 },
						{ name: "mem.available_bytes", kind: "gauge", value: 500 },
					],
				},
			],
			[
				rootDiskNodeId,
				{
					slotStartMs: Date.now(),
					values: [
						{ name: "up", kind: "gauge", value: 1 },
						// The remembered name has no values any more, so root is the fallback.
						{ name: "disk.root.used_bytes", kind: "gauge", value: 250 },
						{ name: "disk.root.total_bytes", kind: "gauge", value: 1000 },
					],
				},
			],
			[
				rootFallbackNodeId,
				{
					slotStartMs: Date.now(),
					values: [
						{ name: "up", kind: "gauge", value: 1 },
						// Both filesystems are complete, so only the root fallback keeps `data` from winning.
						{ name: "disk.data.used_bytes", kind: "gauge", value: 1500 },
						{ name: "disk.data.total_bytes", kind: "gauge", value: 2000 },
						{ name: "disk.root.used_bytes", kind: "gauge", value: 500 },
						{ name: "disk.root.total_bytes", kind: "gauge", value: 1000 },
					],
				},
			],
			[
				alphaDiskNodeId,
				{
					slotStartMs: Date.now(),
					values: [
						{ name: "up", kind: "gauge", value: 1 },
						// `aaa` has only one of its two values, so the alphabetically first complete
						// filesystem is `alpha`.
						{ name: "disk.aaa.used_bytes", kind: "gauge", value: 10 },
						{ name: "disk.alpha.used_bytes", kind: "gauge", value: 500 },
						{ name: "disk.alpha.total_bytes", kind: "gauge", value: 1000 },
						// The total alone is known: it is reported, while the used figure stays absent.
						{ name: "mem.total_bytes", kind: "gauge", value: 4096 },
					],
				},
			],
			[bareNodeId, { slotStartMs: Date.now(), values: [{ name: "up", kind: "gauge", value: 1 }] }],
		]);
		app = createApp(db, {
			clientAddress: () => "198.51.100.7",
			captcha: "none",
			metricsStore: store,
			metricsCollector: {
				latest: (id) => latestByNode.get(id),
				diskOrder: (id) =>
					id === nodeId ? ["data", "root"] : id === rootDiskNodeId || id === rootFallbackNodeId ? ["gone"] : undefined,
			},
		});
		rootCookie = await login(app, "metrics-root", "password-123");
		opCookie = await login(app, "metrics-op", "password-123");
		strangerCookie = await login(app, "metrics-stranger", "password-123");

		store.record(nodeId, SLOT, [
			{ name: "cpu.total", kind: "gauge", value: 0.2 },
			{ name: "mem.total_bytes", kind: "gauge", value: 1000 },
			{ name: "mem.available_bytes", kind: "gauge", value: 400 },
			{ name: "up", kind: "gauge", value: 1 },
			{ name: "disk.root.total_bytes", kind: "gauge", value: 1000 },
			{ name: "disk.root.used_bytes", kind: "gauge", value: 500 },
			{ name: "disk.data.total_bytes", kind: "gauge", value: 2000 },
			{ name: "disk.data.used_bytes", kind: "gauge", value: 1500 },
			{ name: "net.rx_bytes", kind: "delta", value: 100 },
		]);
		store.record(nodeId, SLOT + 30_000, [
			{ name: "cpu.total", kind: "gauge", value: 0.4 },
			{ name: "mem.total_bytes", kind: "gauge", value: 1000 },
			{ name: "mem.available_bytes", kind: "gauge", value: 200 },
			{ name: "up", kind: "gauge", value: 1 },
			{ name: "disk.root.total_bytes", kind: "gauge", value: 1000 },
			{ name: "disk.root.used_bytes", kind: "gauge", value: 600 },
			{ name: "disk.data.total_bytes", kind: "gauge", value: 2000 },
			{ name: "disk.data.used_bytes", kind: "gauge", value: 1600 },
			{ name: "net.rx_bytes", kind: "delta", value: 300 },
		]);
		await store.flush();
	});

	afterAll(async () => {
		await store.close();
		await db.destroy();
	});

	it("shows a node's metrics to its grantees and administrators, and hides it from everyone else", async () => {
		const query = { series: "cpu.total", from: String(NOW - HOUR), to: String(NOW) };
		for (const cookie of [rootCookie, opCookie]) {
			const res = await series(cookie, nodeId, query);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { series: { name: string }[] };
			expect(body.series.map((entry) => entry.name)).toEqual(["cpu.total"]);
		}
		expect((await series(strangerCookie, nodeId, query)).status).toBe(404);
		expect((await series(opCookie, "no-such-node", query)).status).toBe(404);
	});

	it("rejects malformed series, instants and ranges", async () => {
		const invalid: Record<string, Record<string, string>> = {
			"empty series": { series: "", from: String(NOW - HOUR), to: String(NOW) },
			"bad pattern": { series: "cpu*", from: String(NOW - HOUR), to: String(NOW) },
			"bad from": { series: "cpu.total", from: "yesterday-ish", to: String(NOW) },
			"bad to": { series: "cpu.total", from: String(NOW - HOUR), to: "soon" },
			"from after to": { series: "cpu.total", from: String(NOW), to: String(NOW - HOUR) },
			"range too long": { series: "cpu.total", from: String(NOW - 401 * DAY), to: String(NOW) },
			"bad level": { series: "cpu.total", from: String(NOW - HOUR), to: String(NOW), level: "5" },
		};
		for (const [label, query] of Object.entries(invalid)) {
			const res = await series(opCookie, nodeId, query);
			expect(res.status, label).toBe(400);
		}
		const tooMany = Array.from({ length: 65 }, (_, index) => `series.${index}`);
		expect(
			(
				await series(opCookie, nodeId, {
					series: tooMany.join(","),
					from: String(NOW - HOUR),
					to: String(NOW),
				})
			).status,
		).toBe(400);
	});

	it("chooses the coarsest level that covers the range and gives 200 points", async () => {
		const cases: [string, number][] = [
			["1h", 1],
			["24h", 2],
			["7d", 2],
			["30d", 3],
			["365d", 4],
		];
		for (const [label, expected] of cases) {
			const duration = label === "1h" ? HOUR : label === "24h" ? DAY : label === "7d" ? 7 * DAY : 0;
			const from = label === "30d" ? NOW - 30 * DAY : label === "365d" ? NOW - 365 * DAY : NOW - duration;
			const res = await series(opCookie, nodeId, { series: "up", from: String(from), to: String(NOW) });
			expect(res.status, label).toBe(200);
			const body = (await res.json()) as { level: number; bucketMs: number };
			expect(body.level, label).toBe(expected);
			expect(body.bucketMs, label).toBe(METRIC_LEVEL_BUCKET_MS[expected as 1 | 2 | 3 | 4]);
		}
		// A caller-named level wins over the choice.
		const explicit = await series(opCookie, nodeId, {
			series: "up",
			from: String(NOW - 24 * HOUR),
			to: String(NOW),
			level: "1",
		});
		expect(((await explicit.json()) as { level: number }).level).toBe(1);
	});

	it("expands prefix.* patterns against the node's stored series", async () => {
		const res = await series(opCookie, nodeId, {
			series: "cpu.total,disk.*",
			from: String(NOW - HOUR),
			to: String(NOW),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { series: { name: string }[] };
		expect(body.series.map((entry) => entry.name)).toEqual([
			"cpu.total",
			"disk.data.total_bytes",
			"disk.data.used_bytes",
			"disk.root.total_bytes",
			"disk.root.used_bytes",
		]);
	});

	it("returns a gauge's average and a delta's total", async () => {
		const res = await series(opCookie, nodeId, {
			series: "cpu.total,net.rx_bytes",
			from: String(NOW - HOUR),
			to: String(NOW),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			level: number;
			series: {
				name: string;
				kind: string;
				buckets: { t: number; count: number; avg: number; sum: number; min: number; max: number; last: number }[];
			}[];
		};
		const cpu = body.series.find((entry) => entry.name === "cpu.total");
		expect(cpu?.kind).toBe("gauge");
		expect(cpu?.buckets).toEqual([
			{
				t: SLOT,
				count: 2,
				avg: 0.30000000000000004,
				sum: 0.6000000000000001,
				min: 0.2,
				max: 0.4,
				last: 0.4,
			},
		]);
		const net = body.series.find((entry) => entry.name === "net.rx_bytes");
		expect(net?.kind).toBe("delta");
		expect(net?.buckets[0]).toMatchObject({ count: 2, avg: 200, sum: 400, min: 100, max: 300, last: 300 });
	});

	it("serves a series with no bucket in the range as a stopped series", async () => {
		const res = await series(opCookie, nodeId, {
			series: "cpu.total",
			from: iso(NOW - 24 * HOUR),
			to: iso(NOW - 23 * HOUR),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { series: { name: string; buckets: unknown[]; lastSeenAt: string }[] };
		expect(body.series[0]?.buckets).toEqual([]);
		expect(body.series[0]?.lastSeenAt).toBe(iso(SLOT + 30_000));
	});

	it("puts the collector's latest sample on the node list and the node detail", async () => {
		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: { id: string; metrics?: Record<string, unknown> }[];
		};
		const shown = list.nodes.find((node) => node.id === nodeId);
		expect(shown?.metrics).toMatchObject({
			up: 1,
			cpu: 0.25,
			memUsed: 0.75,
			memUsedBytes: 750,
			memTotalBytes: 1000,
			uptimeSec: 7200,
			disk: { name: "data", usedRatio: 0.75, usedBytes: 1500, totalBytes: 2000 },
			rxBytesPerSec: 1234,
			txBytesPerSec: 567,
			stale: false,
		});
		expect(typeof shown?.metrics?.at).toBe("string");
		expect(list.nodes.find((node) => node.id === otherNodeId)?.metrics).toBeUndefined();
		expect(list.nodes.find((node) => node.id === otherNodeId)).not.toHaveProperty("metrics");

		const detail = (await (await call(app, `/api/nodes/${nodeId}`, { cookie: rootCookie })).json()) as {
			node: { metrics?: Record<string, unknown> };
		};
		expect(detail.node.metrics).toMatchObject({
			up: 1,
			cpu: 0.25,
			memUsed: 0.75,
			uptimeSec: 7200,
			disk: { name: "data", usedRatio: 0.75 },
		});
	});

	it("picks the first complete filesystem and leaves unknown figures absent", async () => {
		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: { id: string; metrics?: Record<string, unknown> }[];
		};
		const metricsOf = (id: string) => list.nodes.find((node) => node.id === id)?.metrics;
		expect(metricsOf(nodeId)?.disk).toMatchObject({ name: "data", usedBytes: 1500, totalBytes: 2000 });
		// The remembered order names a filesystem the sample no longer has: root is the fallback.
		expect(metricsOf(rootDiskNodeId)?.disk).toMatchObject({
			name: "root",
			usedRatio: 0.25,
			usedBytes: 250,
			totalBytes: 1000,
		});
		// No report order and no root: the alphabetically first filesystem with both values.
		expect(metricsOf(alphaDiskNodeId)?.disk).toMatchObject({ name: "alpha", usedBytes: 500, totalBytes: 1000 });
		// A memory total without the available figure is still a fact, while the ratio is absent.
		expect(metricsOf(alphaDiskNodeId)).toMatchObject({ memTotalBytes: 4096 });
		expect(metricsOf(alphaDiskNodeId)).not.toHaveProperty("memUsed");
		expect(metricsOf(alphaDiskNodeId)).not.toHaveProperty("memUsedBytes");
		// A sample that lacks the values has no fields for them, since a missing value is not zero.
		const bare = metricsOf(bareNodeId);
		expect(bare).toMatchObject({ up: 1, stale: false });
		for (const field of [
			"uptimeSec",
			"disk",
			"rxBytesPerSec",
			"txBytesPerSec",
			"memUsedBytes",
			"memTotalBytes",
			"memUsed",
		]) {
			expect(bare, field).not.toHaveProperty(field);
		}
	});

	it("falls back to root before the alphabetical first filesystem when the remembered names are gone", async () => {
		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: { id: string; metrics?: Record<string, unknown> }[];
		};
		const metrics = list.nodes.find((node) => node.id === rootFallbackNodeId)?.metrics;
		// The remembered order names a filesystem the sample no longer has. Both `data` and `root` are
		// complete, and root comes before the alphabetical fallback although `data` sorts first.
		expect(metrics?.disk).toMatchObject({ name: "root", usedRatio: 0.5, usedBytes: 500, totalBytes: 1000 });
	});

	it("marks a latest sample older than three intervals as stale", async () => {
		const list = (await (await call(app, "/api/nodes", { cookie: rootCookie })).json()) as {
			nodes: { id: string; metrics?: Record<string, unknown> }[];
		};
		const shown = list.nodes.find((node) => node.id === staleNodeId);
		expect(shown?.metrics).toMatchObject({
			up: 1,
			cpu: 0.5,
			memUsed: 0.5,
			stale: true,
			at: new Date(staleSlot).toISOString(),
		});

		const detail = (await (await call(app, `/api/nodes/${staleNodeId}`, { cookie: rootCookie })).json()) as {
			node: { metrics?: Record<string, unknown> };
		};
		expect(detail.node.metrics).toMatchObject({ stale: true, at: new Date(staleSlot).toISOString() });
	});
});
