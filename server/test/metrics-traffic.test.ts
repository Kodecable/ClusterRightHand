import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MetricsStore } from "../src/metrics/store.ts";
import {
	isValidTrafficNextReset,
	newTrafficPeriod,
	rollTrafficPeriod,
	TRAFFIC_PERIOD_MS,
} from "../src/metrics/traffic.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { newId } from "../src/util/id.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MINUTE = 60 * 1000;
const SLOT = Date.UTC(2026, 5, 1, 10, 0);

async function addNode(db: Db, name = "traffic-node", id = newId()): Promise<string> {
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

function trafficValues(rx: number, tx: number) {
	return [
		{ name: "net.rx_bytes", kind: "delta" as const, value: rx },
		{ name: "net.tx_bytes", kind: "delta" as const, value: tx },
		{ name: "cpu.total", kind: "gauge" as const, value: 0.5 },
	];
}

describe("traffic period math", () => {
	it("starts a period at the value's slot and ends it 30 days later", () => {
		expect(newTrafficPeriod(SLOT)).toEqual({
			periodStartMs: SLOT,
			nextResetAtMs: SLOT + TRAFFIC_PERIOD_MS,
			rxBytes: 0,
			txBytes: 0,
		});
	});

	it("leaves a period alone before its end and rolls it at the end", () => {
		const period = { periodStartMs: SLOT, nextResetAtMs: SLOT + TRAFFIC_PERIOD_MS, rxBytes: 10, txBytes: 20 };
		expect(rollTrafficPeriod(period, SLOT + TRAFFIC_PERIOD_MS - 1)).toBe(period);
		expect(rollTrafficPeriod(period, SLOT + TRAFFIC_PERIOD_MS)).toEqual({
			periodStartMs: SLOT + TRAFFIC_PERIOD_MS,
			nextResetAtMs: SLOT + 2 * TRAFFIC_PERIOD_MS,
			rxBytes: 0,
			txBytes: 0,
		});
	});

	it("rolls over every period that passed, not just one", () => {
		const period = { periodStartMs: SLOT, nextResetAtMs: SLOT + TRAFFIC_PERIOD_MS, rxBytes: 10, txBytes: 20 };
		// Two and a half periods later: the period that contains the instant starts two periods on.
		const rolled = rollTrafficPeriod(period, SLOT + 2 * TRAFFIC_PERIOD_MS + 5 * MINUTE);
		expect(rolled).toEqual({
			periodStartMs: SLOT + 2 * TRAFFIC_PERIOD_MS,
			nextResetAtMs: SLOT + 3 * TRAFFIC_PERIOD_MS,
			rxBytes: 0,
			txBytes: 0,
		});
	});

	it("replaces unusable stored bounds instead of trusting them", () => {
		expect(rollTrafficPeriod({ periodStartMs: SLOT, nextResetAtMs: SLOT, rxBytes: 1, txBytes: 2 }, SLOT + 1)).toEqual(
			newTrafficPeriod(SLOT + 1),
		);
		expect(
			rollTrafficPeriod({ periodStartMs: Number.NaN, nextResetAtMs: SLOT, rxBytes: 1, txBytes: 2 }, SLOT + 1),
		).toEqual(newTrafficPeriod(SLOT + 1));
	});

	it("accepts a next reset in the future and within one period only", () => {
		expect(isValidTrafficNextReset(SLOT + 1, SLOT)).toBe(true);
		expect(isValidTrafficNextReset(SLOT + TRAFFIC_PERIOD_MS, SLOT)).toBe(true);
		expect(isValidTrafficNextReset(SLOT, SLOT)).toBe(false);
		expect(isValidTrafficNextReset(SLOT - 1, SLOT)).toBe(false);
		expect(isValidTrafficNextReset(SLOT + TRAFFIC_PERIOD_MS + 1, SLOT)).toBe(false);
		expect(isValidTrafficNextReset(Number.NaN, SLOT)).toBe(false);
	});
});

describeBackends("traffic totals", (backend) => {
	let db: Db;
	let store: MetricsStore;

	beforeAll(async () => {
		db = await openTestDb(backend);
		store = new MetricsStore(db, { timer: false, now: () => SLOT });
	});

	afterAll(async () => {
		await store.close();
		await db.destroy();
	});

	it("creates the row with its first value from the deltas of one sample", async () => {
		const nodeId = await addNode(db, "traffic-first");
		store.record(nodeId, SLOT, trafficValues(1000, 250));
		await store.flush();

		const traffic = await store.traffic(nodeId);
		expect(traffic).toEqual({
			nodeId,
			periodStartMs: SLOT,
			nextResetAtMs: SLOT + TRAFFIC_PERIOD_MS,
			rxBytes: 1000,
			txBytes: 250,
		});
	});

	it("accumulates every later sample and ignores non-network values", async () => {
		const nodeId = await addNode(db, "traffic-more");
		store.record(nodeId, SLOT, trafficValues(1000, 250));
		await store.flush();
		store.record(nodeId, SLOT + MINUTE, trafficValues(2000, 500));
		store.record(nodeId, SLOT + 2 * MINUTE, [
			{ name: "cpu.total", kind: "gauge", value: 0.25 },
			{ name: "net.rx_bytes", kind: "delta", value: 3000 },
		]);
		await store.flush();

		expect(await store.traffic(nodeId)).toMatchObject({ rxBytes: 6000, txBytes: 750 });
	});

	it("rolls the period before adding a value that falls at or past its end", async () => {
		const nodeId = await addNode(db, "traffic-roll");
		store.record(nodeId, SLOT, trafficValues(1000, 250));
		await store.flush();
		// The next sample is one period and a minute later: the old totals belong to the old period.
		store.record(nodeId, SLOT + TRAFFIC_PERIOD_MS + MINUTE, trafficValues(7, 9));
		await store.flush();

		expect(await store.traffic(nodeId)).toEqual({
			nodeId,
			periodStartMs: SLOT + TRAFFIC_PERIOD_MS,
			nextResetAtMs: SLOT + 2 * TRAFFIC_PERIOD_MS,
			rxBytes: 7,
			txBytes: 9,
		});
	});

	it("rolls a read past several missed periods and writes the roll back", async () => {
		const nodeId = await addNode(db, "traffic-missed");
		store.record(nodeId, SLOT, trafficValues(5000, 6000));
		await store.flush();

		const at = SLOT + 3 * TRAFFIC_PERIOD_MS + 10 * MINUTE;
		const traffic = await store.traffic(nodeId, at);
		expect(traffic).toEqual({
			nodeId,
			periodStartMs: SLOT + 3 * TRAFFIC_PERIOD_MS,
			nextResetAtMs: SLOT + 4 * TRAFFIC_PERIOD_MS,
			rxBytes: 0,
			txBytes: 0,
		});
		const row = await db.selectFrom("node_traffic").selectAll().where("node_id", "=", nodeId).executeTakeFirst();
		expect(row).toEqual({
			node_id: nodeId,
			period_start: new Date(SLOT + 3 * TRAFFIC_PERIOD_MS).toISOString(),
			next_reset_at: new Date(SLOT + 4 * TRAFFIC_PERIOD_MS).toISOString(),
			rx_bytes: 0,
			tx_bytes: 0,
		});
		// A read before the end does not write.
		const before = await store.traffic(nodeId, at + MINUTE);
		expect(before).toMatchObject({ periodStartMs: SLOT + 3 * TRAFFIC_PERIOD_MS, rxBytes: 0 });
	});

	it("skips a node deleted before its buffered sample is flushed", async () => {
		const nodeId = await addNode(db, "traffic-deleted");
		store.record(nodeId, SLOT, trafficValues(100, 200));
		await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
		await store.flush();

		expect(await store.traffic(nodeId)).toBeUndefined();
		expect(await db.selectFrom("node_traffic").selectAll().where("node_id", "=", nodeId).execute()).toEqual([]);
	});

	it("deletes the row with its node", async () => {
		const nodeId = await addNode(db, "traffic-cascade");
		await store.resetTraffic(nodeId, SLOT);
		await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
		expect(await db.selectFrom("node_traffic").selectAll().where("node_id", "=", nodeId).execute()).toEqual([]);
	});

	it("resets the totals now, creating the row when there is none", async () => {
		const nodeId = await addNode(db, "traffic-reset");
		store.record(nodeId, SLOT, trafficValues(1000, 250));
		await store.flush();

		const now = SLOT + 10 * MINUTE;
		expect(await store.resetTraffic(nodeId, now)).toEqual({
			nodeId,
			periodStartMs: now,
			nextResetAtMs: now + TRAFFIC_PERIOD_MS,
			rxBytes: 0,
			txBytes: 0,
		});
		expect(await store.traffic(nodeId, now)).toMatchObject({ periodStartMs: now, rxBytes: 0, txBytes: 0 });

		const fresh = await addNode(db, "traffic-reset-fresh");
		expect(await store.resetTraffic(fresh, now)).toMatchObject({ periodStartMs: now, rxBytes: 0, txBytes: 0 });
	});

	it("sets a new end while keeping the start and the totals", async () => {
		const nodeId = await addNode(db, "traffic-next-reset");
		store.record(nodeId, SLOT, trafficValues(1000, 250));
		await store.flush();

		const next = SLOT + 15 * MINUTE;
		expect(await store.setTrafficNextReset(nodeId, next, SLOT + MINUTE)).toEqual({
			nodeId,
			periodStartMs: SLOT,
			nextResetAtMs: next,
			rxBytes: 1000,
			txBytes: 250,
		});
		// The cycle continues from the new end: the next value past it starts a period there.
		store.record(nodeId, next + MINUTE, trafficValues(1, 2));
		await store.flush();
		expect(await store.traffic(nodeId, next + 2 * MINUTE)).toMatchObject({
			periodStartMs: next,
			nextResetAtMs: next + TRAFFIC_PERIOD_MS,
			rxBytes: 1,
			txBytes: 2,
		});
	});

	it("creates a row starting now when a node has no traffic yet", async () => {
		const nodeId = await addNode(db, "traffic-next-reset-fresh");
		const now = SLOT + 3 * MINUTE;
		expect(await store.setTrafficNextReset(nodeId, now + 60_000, now)).toEqual({
			nodeId,
			periodStartMs: now,
			nextResetAtMs: now + 60_000,
			rxBytes: 0,
			txBytes: 0,
		});
	});
});
