import { NODE_METRICS_DEFAULT_SERIES } from "@crh/api";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { apiDocument } from "../src/api/openapi.ts";
import { apiRoutes } from "../src/extensions/api-reference.ts";
import { runApiRequest } from "../src/extensions/api-request.ts";
import type { LatestMetrics } from "../src/metrics/collector.ts";
import { DEFAULT_METRICS_RETENTION_MS, METRIC_LEVEL_BUCKET_MS } from "../src/metrics/levels.ts";
import { MetricsStore } from "../src/metrics/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { MAX_OUTPUT_BYTES } from "../src/util/output-limits.ts";
import { call, login } from "./helpers/api.ts";
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

/** The fixed default overview series' values, so a node can carry a complete overview plus its filesystems. */
function defaultOverviewValues(): { name: string; kind: "gauge"; value: number }[] {
	return [
		{ name: "up", kind: "gauge", value: 1 },
		{ name: "uptime", kind: "gauge", value: 7200 },
		{ name: "cpu.total", kind: "gauge", value: 0.25 },
		{ name: "load.1", kind: "gauge", value: 1.5 },
		{ name: "mem.total_bytes", kind: "gauge", value: 8 * 1024 ** 3 },
		{ name: "mem.available_bytes", kind: "gauge", value: 2 * 1024 ** 3 },
		{ name: "net.rx_bytes_per_sec", kind: "gauge", value: 1234 },
		{ name: "net.tx_bytes_per_sec", kind: "gauge", value: 567 },
	];
}

describeBackends("node metrics API", (backend) => {
	let db: Db;
	let app: ReturnType<typeof createApp>;
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
	let manySeriesNodeId: string;
	let defaultsNodeId: string;
	let partialDiskNodeId: string;
	let incompleteDiskNodeId: string;
	let pointsNodeId: string;
	let summaryNodeId: string;
	let agentNodeId: string;
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
		manySeriesNodeId = await addNode(db, "metrics-many-series");
		defaultsNodeId = await addNode(db, "metrics-defaults");
		partialDiskNodeId = await addNode(db, "metrics-partial-disk");
		incompleteDiskNodeId = await addNode(db, "metrics-incomplete-disk");
		pointsNodeId = await addNode(db, "metrics-points");
		summaryNodeId = await addNode(db, "metrics-summary");
		agentNodeId = await addNode(db, "metrics-agent");
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
		// 512 stored series (256 filesystems × 2 values) at 30 days: level 3 would need 368,640 points.
		store.record(
			manySeriesNodeId,
			SLOT,
			Array.from({ length: 256 }, (_, index) => [
				{ name: `disk.d${index}.total_bytes`, kind: "gauge" as const, value: 1000 + index },
				{ name: `disk.d${index}.used_bytes`, kind: "gauge" as const, value: index },
			]).flat(),
		);
		// Every fixed default series, without any filesystem: the default read must ask for no disk series.
		store.record(defaultsNodeId, SLOT, defaultOverviewValues());
		// `aaa` reports only its total, so it is an incomplete filesystem: the default read must skip it and
		// choose `beta`, which comes later alphabetically but has both values.
		store.record(partialDiskNodeId, SLOT, [
			...defaultOverviewValues(),
			{ name: "disk.aaa.total_bytes", kind: "gauge", value: 1000 },
			{ name: "disk.beta.total_bytes", kind: "gauge", value: 2000 },
			{ name: "disk.beta.used_bytes", kind: "gauge", value: 500 },
		]);
		// No filesystem is complete: the default read must ask for no disk series at all.
		store.record(incompleteDiskNodeId, SLOT, [
			...defaultOverviewValues(),
			{ name: "disk.aaa.total_bytes", kind: "gauge", value: 1000 },
		]);
		// Ten one-minute CPU buckets: the points merge and the summary can be read from one series.
		for (let index = 0; index < 10; index++) {
			store.record(pointsNodeId, SLOT - (9 - index) * MINUTE, [
				{ name: "cpu.total", kind: "gauge", value: (index + 1) / 10 },
			]);
		}
		// Two buckets with different sample counts: the summary's average must be sample-weighted.
		store.record(summaryNodeId, SLOT - 2 * MINUTE, [
			{ name: "cpu.total", kind: "gauge", value: 0.2 },
			{ name: "cpu.total", kind: "gauge", value: 0.4 },
		]);
		store.record(summaryNodeId, SLOT - MINUTE, [{ name: "cpu.total", kind: "gauge", value: 1 }]);
		// A day of one-minute default-series data, for the agent's api_request call.
		const agentNow = Math.floor(Date.now() / MINUTE) * MINUTE;
		for (let index = 0; index < 24 * 60; index++) {
			store.record(agentNodeId, agentNow - (24 * 60 - 1 - index) * MINUTE, [
				{ name: "up", kind: "gauge", value: 1 },
				{ name: "uptime", kind: "gauge", value: 86_400 + index },
				{ name: "cpu.total", kind: "gauge", value: 0.1 + (index % 60) / 100 },
				{ name: "load.1", kind: "gauge", value: 1 + (index % 10) / 10 },
				{ name: "mem.total_bytes", kind: "gauge", value: 8 * 1024 ** 3 },
				{ name: "mem.available_bytes", kind: "gauge", value: 4 * 1024 ** 3 - index },
				{ name: "disk.root.total_bytes", kind: "gauge", value: 100 * 1024 ** 3 },
				{ name: "disk.root.used_bytes", kind: "gauge", value: 20 * 1024 ** 3 + index },
				{ name: "net.rx_bytes_per_sec", kind: "gauge", value: 1000 + index },
				{ name: "net.tx_bytes_per_sec", kind: "gauge", value: 500 + index },
			]);
		}
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
			"bad range": { series: "cpu.total", range: "2h" },
			"fractional points": { series: "cpu.total", from: String(NOW - HOUR), to: String(NOW), points: "1.5" },
			"negative points": { series: "cpu.total", from: String(NOW - HOUR), to: String(NOW), points: "-1" },
			"too many points": { series: "cpu.total", from: String(NOW - HOUR), to: String(NOW), points: "1001" },
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

	it("reads a range ending now and rejects a second way to name the window", async () => {
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
		try {
			const cases: [string, number][] = [
				["1h", 1],
				["24h", 2],
				["7d", 2],
				["30d", 3],
				["365d", 4],
			];
			for (const [range, level] of cases) {
				const res = await series(opCookie, nodeId, { series: "cpu.total", range });
				expect(res.status, range).toBe(200);
				const body = (await res.json()) as { level: number; series: { buckets: unknown[] }[] };
				expect(body.level, range).toBe(level);
				expect(body.series[0]?.buckets.length, range).toBeGreaterThan(0);
			}
			// `to` defaults to now, so `from` alone covers [from, now).
			const fromOnly = await series(opCookie, nodeId, { series: "cpu.total", from: String(NOW - HOUR) });
			expect(fromOnly.status).toBe(200);
			expect(((await fromOnly.json()) as { series: { buckets: unknown[] }[] }).series[0]?.buckets).toHaveLength(1);
			const invalid: [string, Record<string, string>][] = [
				["range and from", { range: "1h", from: String(NOW - HOUR) }],
				["range and to", { range: "1h", to: String(NOW) }],
				["to alone", { to: String(NOW) }],
				["neither", {}],
			];
			for (const [label, query] of invalid) {
				expect((await series(opCookie, nodeId, query)).status, label).toBe(400);
			}
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("returns the default overview series, with and without a known filesystem", async () => {
		const query = { from: iso(SLOT), to: iso(SLOT + MINUTE) };
		const withDisk = await series(opCookie, nodeId, query);
		expect(withDisk.status).toBe(200);
		expect(((await withDisk.json()) as { series: { name: string }[] }).series.map((entry) => entry.name)).toEqual([
			"up",
			"cpu.total",
			"mem.total_bytes",
			"mem.available_bytes",
			"disk.data.total_bytes",
			"disk.data.used_bytes",
		]);

		const withoutDisk = await series(rootCookie, defaultsNodeId, query);
		expect(withoutDisk.status).toBe(200);
		expect(((await withoutDisk.json()) as { series: { name: string }[] }).series.map((entry) => entry.name)).toEqual([
			...NODE_METRICS_DEFAULT_SERIES,
		]);
	});

	it("skips an incomplete filesystem when choosing the default disk series", async () => {
		const query = { from: iso(SLOT), to: iso(SLOT + MINUTE) };
		// `aaa` has only its total stored; `beta` is later alphabetically but has both values.
		const partial = await series(rootCookie, partialDiskNodeId, query);
		expect(partial.status).toBe(200);
		expect(((await partial.json()) as { series: { name: string }[] }).series.map((entry) => entry.name)).toEqual([
			"up",
			"uptime",
			"cpu.total",
			"load.1",
			"mem.total_bytes",
			"mem.available_bytes",
			"disk.beta.total_bytes",
			"disk.beta.used_bytes",
			"net.rx_bytes_per_sec",
			"net.tx_bytes_per_sec",
		]);

		// Only an incomplete filesystem is stored: no disk series appear at all.
		const incomplete = await series(rootCookie, incompleteDiskNodeId, query);
		expect(incomplete.status).toBe(200);
		expect(((await incomplete.json()) as { series: { name: string }[] }).series.map((entry) => entry.name)).toEqual([
			...NODE_METRICS_DEFAULT_SERIES,
		]);
	});

	it("merges each series down to `points` while the summary covers the whole range", async () => {
		const body = (await (
			await series(rootCookie, pointsNodeId, {
				series: "cpu.total",
				from: iso(SLOT - 9 * MINUTE),
				to: iso(SLOT + MINUTE),
				points: "3",
				fields: "avg,max",
			})
		).json()) as {
			series: {
				summary: { min: number; avg: number; max: number; last: number } | null;
				buckets: Record<string, number>[];
			}[];
		};
		const entry = body.series[0];
		expect(entry?.buckets).toHaveLength(3);
		for (const bucket of entry?.buckets ?? []) expect(Object.keys(bucket).sort()).toEqual(["avg", "max", "t"]);
		// Ten one-minute buckets of 0.1 … 1.0, summarized before the merge into three buckets.
		expect(entry?.summary?.min).toBeCloseTo(0.1);
		expect(entry?.summary?.avg).toBeCloseTo(0.55);
		expect(entry?.summary?.max).toBeCloseTo(1);
		expect(entry?.summary?.last).toBeCloseTo(1);
	});

	it("returns no buckets for points=0 but still the summary", async () => {
		const body = (await (
			await series(rootCookie, pointsNodeId, {
				series: "cpu.total",
				from: iso(SLOT - 9 * MINUTE),
				to: iso(SLOT + MINUTE),
				points: "0",
			})
		).json()) as {
			series: { summary: { min: number; avg: number; max: number; last: number } | null; buckets: unknown[] }[];
		};
		expect(body.series[0]?.buckets).toEqual([]);
		expect(body.series[0]?.summary?.last).toBeCloseTo(1);
	});

	it("refuses an empty or non-decimal points and accepts 0 through 1000", async () => {
		const query = { series: "cpu.total", from: iso(SLOT - 9 * MINUTE), to: iso(SLOT + MINUTE) };
		for (const points of ["", " ", "1e2", "0x10", "-1", "1.5", "1001"]) {
			const res = await series(rootCookie, pointsNodeId, { ...query, points });
			expect(res.status, JSON.stringify(points)).toBe(400);
			expect(((await res.json()) as { error: string }).error, JSON.stringify(points)).toMatch(/^points: /);
		}
		for (const points of ["0", "1", "1000"]) {
			const res = await series(rootCookie, pointsNodeId, { ...query, points });
			expect(res.status, points).toBe(200);
		}
	});

	it("refuses points together with level", async () => {
		const res = await series(rootCookie, pointsNodeId, {
			series: "cpu.total",
			from: iso(SLOT - 9 * MINUTE),
			to: iso(SLOT + MINUTE),
			points: "2",
			level: "1",
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("points: cannot be combined with level");
	});

	it("summarizes min, sample-weighted average, max and last over the range", async () => {
		const body = (await (
			await series(rootCookie, summaryNodeId, {
				series: "cpu.total",
				from: iso(SLOT - 2 * MINUTE),
				to: iso(SLOT),
			})
		).json()) as {
			series: { summary: { min: number; avg: number; max: number; last: number } | null; buckets: unknown[] }[];
		};
		expect(body.series[0]?.buckets).toHaveLength(2);
		// Bucket averages are 0.3 (two samples) and 1 (one sample): 1.6 / 3, not (0.3 + 1) / 2.
		expect(body.series[0]?.summary).toMatchObject({ min: 0.2, max: 1, last: 1 });
		expect(body.series[0]?.summary?.avg).toBeCloseTo(1.6 / 3);
	});

	it("keeps only the requested fields and refuses an unknown or empty one", async () => {
		const subset = await series(opCookie, nodeId, {
			series: "cpu.total",
			from: iso(SLOT),
			to: iso(SLOT + MINUTE),
			fields: "avg,max",
		});
		expect(subset.status).toBe(200);
		const body = (await subset.json()) as { series: { buckets: Record<string, number>[] }[] };
		expect(body.series[0]?.buckets).toHaveLength(1);
		expect(Object.keys(body.series[0]?.buckets[0] ?? {}).sort()).toEqual(["avg", "max", "t"]);

		for (const fields of ["avg,nope", "avg,", ""]) {
			const res = await series(opCookie, nodeId, {
				series: "cpu.total",
				from: iso(SLOT),
				to: iso(SLOT + MINUTE),
				fields,
			});
			expect(res.status, JSON.stringify(fields)).toBe(400);
		}
	});

	it("reports each series' unit while keeping the values raw", async () => {
		const res = await series(rootCookie, defaultsNodeId, {
			series: "cpu.total,mem.total_bytes,uptime,load.1,net.rx_bytes_per_sec",
			from: iso(SLOT),
			to: iso(SLOT + MINUTE),
			level: "1",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { series: { name: string; unit: string; buckets: { avg?: number }[] }[] };
		expect(Object.fromEntries(body.series.map((entry) => [entry.name, entry.unit]))).toEqual({
			"cpu.total": "ratio",
			"mem.total_bytes": "bytes",
			uptime: "seconds",
			"load.1": "load",
			"net.rx_bytes_per_sec": "bytes_per_sec",
		});
		// A ratio is not turned into a percentage string: the API returns numbers.
		expect(body.series.find((entry) => entry.name === "cpu.total")?.buckets[0]?.avg).toBe(0.25);
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

	it("caps the total points and moves an automatic read to a coarser level", async () => {
		// 512 expanded series over 30 days do not fit level 3 (368,640 points), so the automatic choice
		// uses level 4 (15,360).
		const auto = await series(rootCookie, manySeriesNodeId, {
			series: "disk.*",
			from: String(NOW - 30 * DAY),
			to: String(NOW),
		});
		expect(auto.status).toBe(200);
		expect(((await auto.json()) as { level: number }).level).toBe(4);

		// An explicit level that would exceed the cap is refused with a clear 400.
		const explicit = await series(rootCookie, nodeId, {
			series: "up",
			from: String(NOW - 400 * DAY),
			to: String(NOW),
			level: "1",
		});
		expect(explicit.status).toBe(400);
		const body = (await explicit.json()) as { error: string };
		expect(body.error).toMatch(/at most 200000/);
		expect(body.error).toMatch(/coarser level/);
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
		expect((cpu as { unit?: string } | undefined)?.unit).toBe("ratio");
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
		expect((net as { unit?: string } | undefined)?.unit).toBe("bytes");
		expect(net?.buckets[0]).toMatchObject({ count: 2, avg: 200, sum: 400, min: 100, max: 300, last: 300 });
	});

	it("serves a series with no bucket in the range as a stopped series", async () => {
		const res = await series(opCookie, nodeId, {
			series: "cpu.total",
			from: iso(NOW - 24 * HOUR),
			to: iso(NOW - 23 * HOUR),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			series: { name: string; buckets: unknown[]; lastSeenAt: string; unit: string; summary: unknown }[];
		};
		expect(body.series[0]?.buckets).toEqual([]);
		expect(body.series[0]?.lastSeenAt).toBe(iso(SLOT + 30_000));
		expect(body.series[0]?.unit).toBe("ratio");
		expect(body.series[0]?.summary).toBeNull();
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

	it("keeps the agent's api_request metrics call under the output limit", async () => {
		const result = await runApiRequest(
			async (request, identity) => app.request(request, undefined, { crhInternal: identity }),
			apiRoutes(apiDocument(app)),
			{
				method: "GET",
				path: `/api/nodes/${agentNodeId}/metrics`,
				query: { range: "24h", points: 24, fields: "avg,max" },
			},
			{ type: "session", id: "session-metrics", onBehalfOfUserId: rootId },
		);
		expect(result.isError).toBeFalsy();
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("HTTP 200");
		expect(text).not.toContain("[response truncated");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MAX_OUTPUT_BYTES);
		const body = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { series: { buckets: unknown[] }[] };
		// The default overview on a node with a filesystem: ten series, each merged to 24 buckets.
		expect(body.series).toHaveLength(10);
		for (const entry of body.series) expect(entry.buckets.length).toBeLessThanOrEqual(24);
	});
});
