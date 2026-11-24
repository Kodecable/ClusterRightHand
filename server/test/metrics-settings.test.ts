import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_METRICS_RETENTION_MS } from "../src/metrics/levels.ts";
import { DEFAULT_SYSTEM_SETTINGS_METRICS, SettingsStore, SettingsValidationError } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describeBackends("metrics settings", (backend) => {
	let db: Db;
	let store: SettingsStore;

	beforeEach(async () => {
		db = await openTestDb(backend);
		store = await SettingsStore.load(db);
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("starts from the documented defaults", () => {
		expect(store.wire().metrics).toEqual({
			enabled: true,
			interval: 60,
			retention: { l1: "24h", l2: "7d", l3: "30d", l4: "365d" },
		});
		expect(store.current().metrics).toEqual({
			enabled: true,
			intervalMs: 60 * 1000,
			retention: {
				l1Ms: 24 * HOUR,
				l2Ms: 7 * DAY,
				l3Ms: 30 * DAY,
				l4Ms: 365 * DAY,
			},
		});
		// The textual defaults and the numbers the metrics store falls back to are the same windows.
		expect(DEFAULT_SYSTEM_SETTINGS_METRICS).toEqual({
			enabled: true,
			interval: 60,
			retention: { l1: "24h", l2: "7d", l3: "30d", l4: "365d" },
		});
		expect(DEFAULT_METRICS_RETENTION_MS).toEqual(store.current().metrics.retention);
	});

	it("stores a metrics patch and resolves it again after a reload", async () => {
		await store.patch(
			db,
			{
				metrics: {
					enabled: false,
					interval: 15,
					retention: { l1: "2d", l2: "8d", l3: "31d", l4: "400d" },
				},
			},
			null,
		);
		const expected = {
			enabled: false,
			interval: 15,
			retention: { l1: "2d", l2: "8d", l3: "31d", l4: "400d" },
		};
		expect(store.wire().metrics).toEqual(expected);
		expect(store.current().metrics).toEqual({
			enabled: false,
			intervalMs: 15 * 1000,
			retention: { l1Ms: 2 * DAY, l2Ms: 8 * DAY, l3Ms: 31 * DAY, l4Ms: 400 * DAY },
		});

		// Every key is its own `settings` row, so the next process reads the same values.
		const reloaded = await SettingsStore.load(db);
		expect(reloaded.wire().metrics).toEqual(expected);
	});

	it("accepts the shortest allowed retention at each level and equal neighboring levels", async () => {
		await store.patch(db, { metrics: { retention: { l1: "10m", l2: "50m", l3: "10h", l4: "10d" } } }, null);
		expect(store.current().metrics.retention).toEqual({
			l1Ms: 10 * MINUTE,
			l2Ms: 50 * MINUTE,
			l3Ms: 10 * HOUR,
			l4Ms: 10 * DAY,
		});

		await store.patch(db, { metrics: { retention: { l1: "10d", l2: "10d", l3: "10d", l4: "10d" } } }, null);
		expect(store.current().metrics.retention).toEqual({
			l1Ms: 10 * DAY,
			l2Ms: 10 * DAY,
			l3Ms: 10 * DAY,
			l4Ms: 10 * DAY,
		});
	});

	it("rejects a bad interval, a too-short retention and a decreasing retention without writing", async () => {
		const before = store.wire();
		const cases: [unknown, string][] = [
			[{ metrics: { interval: 45 } }, "metrics.interval"],
			[{ metrics: { interval: "60" } }, "metrics.interval"],
			[{ metrics: { enabled: "yes" } }, "metrics.enabled"],
			[{ metrics: { retention: { l1: "9m" } } }, "metrics.retention.l1"],
			[{ metrics: { retention: { l2: "49m" } } }, "metrics.retention.l2"],
			[{ metrics: { retention: { l3: "9h" } } }, "metrics.retention.l3"],
			[{ metrics: { retention: { l4: "9d" } } }, "metrics.retention.l4"],
			// Each level must be at least as long as the one before it; a patch may set only one side.
			[{ metrics: { retention: { l2: "1h" } } }, "metrics.retention.l2"],
			[{ metrics: { retention: { l4: "20d" } } }, "metrics.retention.l4"],
			[{ metrics: { nope: 1 } }, "metrics.nope"],
			[{ metrics: { retention: { nope: "1d" } } }, "metrics.retention.nope"],
			[{ metrics: "on" }, "metrics"],
		];
		for (const [patch, field] of cases) {
			let error: SettingsValidationError | undefined;
			try {
				await store.patch(db, patch, null);
			} catch (err) {
				error = err as SettingsValidationError;
			}
			expect(error, JSON.stringify(patch)).toBeInstanceOf(SettingsValidationError);
			expect(error?.fields[field], JSON.stringify(patch)).toBeTypeOf("string");
		}
		expect(store.wire()).toEqual(before);
		expect((await SettingsStore.load(db)).wire()).toEqual(before);
	});

	it("names the level whose retention contradicts the one before it", async () => {
		let error: SettingsValidationError | undefined;
		try {
			// Both values pass their own minimum; together, level 2 would be shorter than level 1.
			await store.patch(db, { metrics: { retention: { l1: "2d", l2: "1d" } } }, null);
		} catch (err) {
			error = err as SettingsValidationError;
		}
		expect(error?.fields["metrics.retention.l2"]).toContain("at least metrics.retention.l1");
		expect(store.current().metrics.retention.l1Ms).toBe(24 * HOUR);
	});
});
