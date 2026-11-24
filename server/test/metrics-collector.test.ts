import { generateKeyPair } from "@crh/noise";
import { type MetricsSnapshot, REQUIRED_NAMES } from "@crh/protocol";
import type { ClientChannel } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { SshError, type SshSession } from "../src/cluster/ssh/connection.ts";
import {
	MetricsCollector,
	type MetricsHost,
	type MetricsRecorder,
	type MetricsSettings,
	metricsNodeOffset,
	metricsSampleDeadline,
	metricsSlotStart,
} from "../src/metrics/collector.ts";
import { METRIC_LEVEL_BUCKET_MS } from "../src/metrics/levels.ts";
import { SSH_METRICS_SCRIPT } from "../src/metrics/ssh-script.ts";
import { MetricsStore } from "../src/metrics/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

/**
 * The scheduler and availability rules of doc/design/metrics.md "Collection" and "Availability":
 * slots, fixed offsets and deadlines; what reaches MetricsStore.record for crha and SSH nodes; the
 * reconnect grace with the same boot (a gap) and a new boot (retroactive up = 0, before the reconnect
 * slot's sample); and the in-memory latest sample.
 */

const INTERVAL = 400;
const SLOT = 10_000_000; // a multiple of INTERVAL
const HALF = INTERVAL / 2;
const HELLO = { tasks: [], taskKinds: [], privilegedMode: "" };

function nowWithinSlot(slot: number): number {
	return slot + HALF;
}

interface Recorded {
	nodeId: string;
	slotStartMs: number;
	values: { name: string; kind: "gauge" | "delta"; value: number }[];
}

class RecordingStore implements MetricsRecorder {
	readonly records: Recorded[] = [];

	record(
		nodeId: string,
		slotStartMs: number,
		values: readonly { name: string; kind: "gauge" | "delta"; value: number }[],
	) {
		this.records.push({
			nodeId,
			slotStartMs,
			values: values.map((value) => ({ ...value })),
		});
	}

	upRecords(nodeId: string): number[] {
		return this.records
			.filter((record) => record.nodeId === nodeId)
			.flatMap((record) => record.values.filter((value) => value.name === "up").map((value) => value.value));
	}
}

interface Clock {
	now: number;
	mono: number;
}

interface Harness {
	db: Db;
	cluster: Cluster;
	agents: TestAgentServer;
	store: RecordingStore;
	settings: MetricsSettings & { enabled: boolean; intervalMs: number };
	clock: Clock;
	collector: MetricsCollector;
}

interface CrhaAnswer {
	answer: () => MetricsSnapshot;
	setBoot: (bootId: string) => void;
	calls: () => number;
}

function crhaAnswer(): CrhaAnswer {
	let bootId = "boot-1";
	let busy = 100n;
	let total = 200n;
	let rx = 1_000n;
	let tx = 2_000n;
	let rxPackets = 100n;
	let txPackets = 200n;
	let calls = 0;
	return {
		answer: () => {
			calls += 1;
			busy += 50n;
			total += 200n;
			rx += 1_000n;
			tx += 2_000n;
			rxPackets += 10n;
			txPackets += 20n;
			return {
				bootId,
				uptimeSec: 100 + calls,
				cpu: {
					total: { busy, total },
					cores: [{ index: 0, busy, total }],
				},
				loads: { l1: 1500, l5: 1000, l15: 500 },
				memory: { totalBytes: 8_000n, availableBytes: 4_000n, cachedBytes: 2_000n, freeBytes: 1_000n },
				swap: { totalBytes: 2_000n, freeBytes: 1_500n },
				disks: [{ kind: "ok", name: "root", path: "/", totalBytes: 100_000n, usedBytes: 40_000n }],
				interfaces: [{ name: "eth0", rxBytes: rx, txBytes: tx, rxPackets, txPackets }],
			};
		},
		setBoot: (next) => {
			bootId = next;
		},
		calls: () => calls,
	};
}

function fakeSettings(): Harness["settings"] {
	const settings = {
		enabled: true,
		intervalMs: INTERVAL,
		current() {
			return { metrics: { enabled: this.enabled, intervalMs: this.intervalMs } };
		},
	};
	return settings;
}

async function addNode(
	db: Db,
	transport: "client" | "ssh",
	publicKey: Uint8Array | null,
	status: "active" | "pending" = "active",
	id = newId(),
) {
	const name = `node-${id.slice(0, 8)}`;
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport,
			status,
			public_key: publicKey === null ? null : Buffer.from(publicKey).toString("base64"),
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
	return db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow() as Promise<NodeRow>;
}

/** The cluster's metrics host with a test-shortened grace; the cluster's own grace is for tasks. */
function hostWithGrace(cluster: Cluster, graceMs: number): MetricsHost {
	return { ...cluster.metricsHost(), graceMs };
}

async function connect(
	agents: TestAgentServer,
	cluster: Cluster,
	node: NodeRow,
	key: ReturnType<typeof generateKeyPair>,
	options: { metrics: boolean; answer?: () => MetricsSnapshot | Promise<MetricsSnapshot> },
): Promise<FakeCrha> {
	const commands = options.metrics ? [...REQUIRED_NAMES, "metrics.collect"] : [...REQUIRED_NAMES];
	const crha = await agents.connect(key, handshakeInit({ commands }), commands);
	if (options.answer !== undefined) crha.peer.onRequest("metrics.collect", options.answer);
	expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
	await waitFor("link ready", () => cluster.isConnected(node.id));
	return crha;
}

function recordValue(record: Recorded | undefined, name: string): number | undefined {
	return record?.values.find((value) => value.name === name)?.value;
}

function recordsFor(store: RecordingStore, nodeId: string, slotStartMs: number): Recorded[] {
	return store.records.filter((record) => record.nodeId === nodeId && record.slotStartMs === slotStartMs);
}

describe("metrics slot math", () => {
	it("aligns slots to the interval and puts the deadline at the slot's end", () => {
		expect(metricsSlotStart(0, 60_000)).toBe(0);
		expect(metricsSlotStart(59_999, 60_000)).toBe(0);
		expect(metricsSlotStart(60_000, 60_000)).toBe(60_000);
		expect(metricsSlotStart(10_000_123, 15_000)).toBe(9_990_000);
		expect(metricsSampleDeadline(9_990_000, 15_000)).toBe(10_005_000);
	});

	it("gives each node a fixed offset in the first half of the slot", () => {
		for (const interval of [15_000, 20_000, 30_000, 60_000]) {
			for (const nodeId of ["a", "node-1", "0f8fad5b-d9cb-469f-a165-70867728950e"]) {
				const offset = metricsNodeOffset(nodeId, interval);
				expect(offset).toBeGreaterThanOrEqual(0);
				expect(offset).toBeLessThan(interval / 2);
				expect(metricsNodeOffset(nodeId, interval)).toBe(offset);
			}
		}
		expect(metricsNodeOffset("a", 60_000)).not.toBe(metricsNodeOffset("b", 60_000));
	});
});

describe("metrics collector", () => {
	let harness: Harness;

	beforeEach(async () => {
		const db = await openTestDb("sqlite");
		const cluster = new Cluster(db, { reconnectGraceMs: 1_000 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		const agents = await TestAgentServer.start(db, identity, cluster);
		const store = new RecordingStore();
		const settings = fakeSettings();
		const clock: Clock = { now: nowWithinSlot(SLOT), mono: 1_000 };
		const collector = new MetricsCollector({
			db,
			store,
			settings,
			host: cluster.metricsHost(),
			now: () => clock.now,
			monotonic: () => (clock.mono += 1_000),
			timer: false,
		});
		harness = { db, cluster, agents, store, settings, clock, collector };
	});

	afterEach(async () => {
		await harness.collector.stop();
		await harness.cluster.close();
		await harness.agents.close();
		await harness.db.destroy();
	});

	it("writes up = 1 and the computed values at the slot start after a baseline", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);
		await harness.collector.tick();
		await harness.collector.settle();

		const [record] = recordsFor(harness.store, node.id, SLOT);
		expect(record).toBeDefined();
		expect(recordValue(record, "up")).toBe(1);
		expect(recordValue(record, "uptime")).toBe(102);
		// The second answer's counters are 50/200 higher for the CPU line, and 1000 bytes of rx over 2 s.
		expect(recordValue(record, "cpu.total")).toBeCloseTo(0.25);
		expect(recordValue(record, "net.rx_bytes")).toBe(1_000);
		expect(recordValue(record, "net.rx_bytes_per_sec")).toBe(1_000);
		const latest = harness.collector.latest(node.id);
		expect(latest?.slotStartMs).toBe(SLOT);
		expect(latest?.values.find((value) => value.name === "up")?.value).toBe(1);
	});

	it("keeps a slow answer within its own slot", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, {
			metrics: true,
			answer: async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
				return answer.answer();
			},
		});
		await waitFor("baseline", () => answer.calls() >= 1);
		expect(harness.collector.latest(node.id)).toBeUndefined();

		await harness.collector.tick();
		await harness.collector.settle();

		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(1);
		expect(recordValue(recordsFor(harness.store, node.id, SLOT)[0], "up")).toBe(1);
	});

	it("skips a slot that passed without a tick and never starts two samples in one slot", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);

		// Three slots pass with no tick (crhs was stalled): only the current one is sampled.
		harness.clock.now = nowWithinSlot(SLOT + 3 * INTERVAL);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(0);
		expect(recordsFor(harness.store, node.id, SLOT + INTERVAL)).toHaveLength(0);
		expect(recordsFor(harness.store, node.id, SLOT + 2 * INTERVAL)).toHaveLength(0);
		expect(recordsFor(harness.store, node.id, SLOT + 3 * INTERVAL)).toHaveLength(1);

		// A second tick in the same slot starts nothing.
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT + 3 * INTERVAL)).toHaveLength(1);
	});

	it("sends no second metrics.collect while the slot's sample has already settled", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);

		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(1);
		// One baseline and one sample; the sample of this slot has settled.
		expect(answer.calls()).toBe(2);
		const requests = answer.calls();

		// Several ticks later in the same slot start nothing: a slot gets at most one sample.
		for (let i = 0; i < 3; i++) {
			harness.clock.now += 1;
			await harness.collector.tick();
			await harness.collector.settle();
		}
		expect(answer.calls()).toBe(requests);
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(1);
	});

	it("treats a node never connected since startup as disconnected from the start", async () => {
		const node = await addNode(harness.db, "client", generateKeyPair().publicKey);
		await harness.collector.stop();
		harness.collector = new MetricsCollector({
			db: harness.db,
			store: harness.store,
			settings: harness.settings,
			host: hostWithGrace(harness.cluster, 200),
			now: () => harness.clock.now,
			monotonic: () => (harness.clock.mono += 1_000),
			timer: false,
		});
		await harness.collector.start();
		const laterSlot = SLOT + INTERVAL;
		harness.clock.now = nowWithinSlot(laterSlot);
		await waitFor("startup grace expiry", () => recordsFor(harness.store, node.id, SLOT).length > 0);
		expect(recordValue(recordsFor(harness.store, node.id, SLOT)[0], "up")).toBe(0);
		expect(recordValue(recordsFor(harness.store, node.id, laterSlot)[0], "up")).toBe(0);
	});

	it("writes up = 0 when a connected node does not answer by the deadline", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, {
			metrics: true,
			answer: () => new Promise<MetricsSnapshot>(() => {}),
		});

		await harness.collector.tick();
		await harness.collector.settle();

		const [record] = recordsFor(harness.store, node.id, SLOT);
		expect(recordValue(record, "up")).toBe(0);
		expect(record?.values).toHaveLength(1);
	});

	it("does not start a second sample while the node's previous one is still in flight", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		let requests = 0;
		let release: (() => void) | undefined;
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, {
			metrics: true,
			answer: () => {
				requests += 1;
				// The baseline answers at once; the first sample is held across the slot boundary.
				if (requests !== 2) return answer.answer();
				return new Promise<MetricsSnapshot>((resolve) => {
					release = () => resolve(answer.answer());
				});
			},
		});
		await waitFor("baseline", () => requests >= 1);

		await harness.collector.tick();
		await waitFor("held sample", () => requests === 2);

		// The next slot begins while the first sample still waits for its answer: that slot is skipped
		// rather than getting a second concurrent request for the same node.
		harness.clock.now = nowWithinSlot(SLOT + INTERVAL);
		await harness.collector.tick();
		expect(requests).toBe(2);
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(0);

		release?.();
		await harness.collector.settle();
		// The late answer is past the sample's deadline: the slot it belonged to is up = 0, as always.
		expect(recordValue(recordsFor(harness.store, node.id, SLOT)[0], "up")).toBe(0);
		expect(recordsFor(harness.store, node.id, SLOT + INTERVAL)).toHaveLength(0);

		// With the previous sample settled, the guard lifts and the next slot samples again.
		harness.clock.now = nowWithinSlot(SLOT + 2 * INTERVAL);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(requests).toBe(3);
		expect(recordValue(recordsFor(harness.store, node.id, SLOT + 2 * INTERVAL)[0], "up")).toBe(1);
	});

	it("ignores a baseline that lands after the slot's stored sample", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const snapshot = (busy: bigint, total: bigint, rxBytes: bigint): MetricsSnapshot => ({
			bootId: "boot-1",
			uptimeSec: 100,
			cpu: { total: { busy, total }, cores: [{ index: 0, busy, total }] },
			loads: { l1: 0, l5: 0, l15: 0 },
			memory: { totalBytes: 8_000n, availableBytes: 4_000n, cachedBytes: 2_000n, freeBytes: 1_000n },
			swap: { totalBytes: 2_000n, freeBytes: 1_500n },
			disks: [],
			interfaces: [{ name: "eth0", rxBytes, txBytes: 2_000n, rxPackets: 100n, txPackets: 200n }],
		});
		let releaseBaseline: (() => void) | undefined;
		const heldBaseline = new Promise<MetricsSnapshot>((resolve) => {
			releaseBaseline = () => resolve(snapshot(100n, 200n, 1_000n));
		});
		let requests = 0;
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, {
			metrics: true,
			answer: () => {
				requests += 1;
				if (requests === 1) return heldBaseline;
				if (requests === 2) return snapshot(150n, 400n, 2_000n);
				return snapshot(175n, 600n, 3_000n);
			},
		});
		await waitFor("held baseline", () => requests >= 1);

		// The first sample waits for the baseline only until its deadline; it then lands and seeds the
		// counters itself, while the baseline's answer is still held.
		harness.clock.now = SLOT + 300;
		await harness.collector.tick();
		await harness.collector.settle();
		expect(requests).toBe(2);
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(1);

		// The late baseline carries older counters than the sample that was stored.
		releaseBaseline?.();
		await new Promise((resolve) => setImmediate(resolve));

		harness.clock.now = nowWithinSlot(SLOT + INTERVAL);
		await harness.collector.tick();
		await harness.collector.settle();
		const record = recordsFor(harness.store, node.id, SLOT + INTERVAL)[0];
		expect(recordValue(record, "up")).toBe(1);
		// From the stored sample's counters: 25 of 200 more jiffies, and 1000 bytes over 1 s.
		expect(recordValue(record, "cpu.total")).toBeCloseTo(0.125);
		expect(recordValue(record, "net.rx_bytes")).toBe(1_000);
		expect(recordValue(record, "net.rx_bytes_per_sec")).toBe(1_000);
	});

	it("leaves a gap when the node returns within the grace with the same bootId", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		let crha = await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);

		await harness.collector.tick();
		await harness.collector.settle();
		const firstSlot = SLOT;

		const disconnectedSlot = SLOT + INTERVAL;
		harness.clock.now = nowWithinSlot(disconnectedSlot);
		crha.ws.close();
		await waitFor("link lost", () => !harness.cluster.isConnected(node.id));

		// The sample of the disconnected slot waits out the grace and records nothing.
		await harness.collector.tick();
		harness.clock.now = metricsSampleDeadline(disconnectedSlot, INTERVAL);
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, disconnectedSlot)).toHaveLength(0);

		const backSlot = disconnectedSlot + INTERVAL;
		harness.clock.now = nowWithinSlot(backSlot);
		crha = await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("same-boot baseline", () => answer.calls() >= 3);
		await harness.collector.tick();
		await harness.collector.settle();

		expect(harness.store.upRecords(node.id)).toEqual([1, 1]);
		expect(recordsFor(harness.store, node.id, firstSlot)).toHaveLength(1);
		expect(recordsFor(harness.store, node.id, backSlot)).toHaveLength(1);
		expect(harness.store.records.some((record) => recordValue(record, "up") === 0)).toBe(false);
	});

	it("writes retroactive up = 0 for a reboot before the reconnect slot's sample", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		let crha = await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);
		await harness.collector.tick();
		await harness.collector.settle();

		const disconnectedSlot = SLOT + INTERVAL;
		harness.clock.now = nowWithinSlot(disconnectedSlot);
		crha.ws.close();
		await waitFor("link lost", () => !harness.cluster.isConnected(node.id));
		await harness.collector.tick();
		harness.clock.now = metricsSampleDeadline(disconnectedSlot, INTERVAL);
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, disconnectedSlot)).toHaveLength(0);

		const backSlot = disconnectedSlot + INTERVAL;
		harness.clock.now = nowWithinSlot(backSlot);
		answer.setBoot("boot-2");
		crha = await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("reboot baseline", () => answer.calls() >= 3);
		await harness.collector.tick();
		await harness.collector.settle();

		const rebootRecord = recordsFor(harness.store, node.id, disconnectedSlot)[0];
		const backRecord = recordsFor(harness.store, node.id, backSlot)[0];
		expect(recordValue(rebootRecord, "up")).toBe(0);
		expect(recordValue(backRecord, "up")).toBe(1);
		const rebootIndex = harness.store.records.indexOf(rebootRecord as Recorded);
		const backIndex = harness.store.records.indexOf(backRecord as Recorded);
		expect(rebootIndex).toBeGreaterThanOrEqual(0);
		expect(rebootIndex).toBeLessThan(backIndex);
	});

	it("writes retroactive up = 0 at grace expiry and up = 0 for later slots", async () => {
		// A short grace keeps the test quick; the other cases need a grace longer than their wait.
		await harness.collector.stop();
		harness.collector = new MetricsCollector({
			db: harness.db,
			store: harness.store,
			settings: harness.settings,
			host: hostWithGrace(harness.cluster, 200),
			now: () => harness.clock.now,
			monotonic: () => (harness.clock.mono += 1_000),
			timer: false,
		});
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		const crha = await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);
		await harness.collector.tick();
		await harness.collector.settle();

		const disconnectedSlot = SLOT + INTERVAL;
		harness.clock.now = nowWithinSlot(disconnectedSlot);
		crha.ws.close();
		await waitFor("link lost", () => !harness.cluster.isConnected(node.id));

		// The grace runs out while the wall clock is in the next slot; the expiry writes both slots.
		const laterSlot = disconnectedSlot + INTERVAL;
		harness.clock.now = nowWithinSlot(laterSlot);
		await waitFor("grace expiry", () => recordsFor(harness.store, node.id, disconnectedSlot).length > 0);
		expect(recordValue(recordsFor(harness.store, node.id, disconnectedSlot)[0], "up")).toBe(0);
		expect(recordValue(recordsFor(harness.store, node.id, laterSlot)[0], "up")).toBe(0);

		const nextSlot = laterSlot + INTERVAL;
		harness.clock.now = nowWithinSlot(nextSlot);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordValue(recordsFor(harness.store, node.id, nextSlot)[0], "up")).toBe(0);
	});

	it("samples a node without the negotiated command as up only", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: false });

		await harness.collector.tick();
		await harness.collector.settle();

		const [record] = recordsFor(harness.store, node.id, SLOT);
		expect(record?.values).toEqual([{ name: "up", kind: "gauge", value: 1 }]);
	});

	it("stops sampling while metrics.enabled is off and resumes when it is on", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(1);

		harness.settings.enabled = false;
		harness.clock.now = nowWithinSlot(SLOT + INTERVAL);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT + INTERVAL)).toHaveLength(0);

		harness.settings.enabled = true;
		harness.clock.now = nowWithinSlot(SLOT + 2 * INTERVAL);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT + 2 * INTERVAL)).toHaveLength(1);
	});

	it("applies an interval change at the next tick", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT)).toHaveLength(1);

		harness.settings.intervalMs = 500;
		// Under 400 ms slots this instant is in the slot at SLOT + 400; under 500 ms it is in the slot
		// at SLOT + 500, which is what the next tick must use.
		harness.clock.now = SLOT + 750;
		await harness.collector.tick();
		await harness.collector.settle();
		expect(recordsFor(harness.store, node.id, SLOT + 500)).toHaveLength(1);
		expect(recordsFor(harness.store, node.id, SLOT + 400)).toHaveLength(0);
	});

	it("records into the real MetricsStore against SQLite and flushes at the slot's bucket", async () => {
		const key = generateKeyPair();
		const node = await addNode(harness.db, "client", key.publicKey);
		const answer = crhaAnswer();
		await harness.collector.start();
		await connect(harness.agents, harness.cluster, node, key, { metrics: true, answer: answer.answer });
		await waitFor("baseline", () => answer.calls() >= 1);

		const store = new MetricsStore(harness.db, { timer: false });
		const collector = new MetricsCollector({
			db: harness.db,
			store,
			settings: harness.settings,
			host: harness.cluster.metricsHost(),
			now: () => harness.clock.now,
			monotonic: () => (harness.clock.mono += 1_000),
			timer: false,
		});
		try {
			await harness.collector.stop();
			await collector.start();
			await waitFor("second baseline", () => answer.calls() >= 2);
			await collector.tick();
			await collector.settle();
			await store.flush();

			const series = await harness.db
				.selectFrom("metric_series")
				.select(["id", "name", "kind"])
				.where("node_id", "=", node.id)
				.where("name", "=", "up")
				.executeTakeFirstOrThrow();
			expect(series.kind).toBe("gauge");
			const bucket = await harness.db
				.selectFrom("metric_buckets")
				.selectAll()
				.where("series_id", "=", series.id)
				.where("level", "=", 1)
				.executeTakeFirstOrThrow();
			expect(bucket.bucket_start).toBe(Math.floor(SLOT / METRIC_LEVEL_BUCKET_MS[1]) * METRIC_LEVEL_BUCKET_MS[1]);
			expect(bucket.count).toBe(1);
			expect(bucket.sum).toBe(1);
			expect(bucket.last).toBe(1);
		} finally {
			await collector.stop();
			await store.close();
		}
	});
});

/**
 * SSH sampling needs no cluster connection: the collector only needs a pooled session. The fake
 * session delivers one script output over a channel and can refuse channel opens like a server whose
 * session limit is taken by tasks.
 */
const SSH_OUTPUT = `crh-metrics:boot_id
ssh-boot
crh-metrics:uptime
99.50 1000.00
crh-metrics:stat
cpu 100 0 0 100 0 0 0 0
cpu0 50 0 0 50 0 0 0 0
crh-metrics:loadavg
0.50 0.25 0.10 1/1 2
crh-metrics:meminfo
MemTotal: 1000 kB
MemAvailable: 500 kB
Cached: 200 kB
MemFree: 100 kB
SwapTotal: 0 kB
SwapFree: 0 kB
crh-metrics:df
Filesystem 1B-blocks Used Available Use% Mounted on
/dev/root 1000 400 600 40% /
crh-metrics:route
Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
eth0 00000000 0100A8C0 0003 0 0 0 00000000 0 0 0
crh-metrics:netdev
  eth0: 5000 50 0 0 0 0 0 0 6000 60 0 0 0 0 0 0
crh-metrics:end
`;

class FakeSshSession {
	closed = false;
	execCalls = 0;
	refusals = 0;
	failWith: Error | undefined;
	readonly commands: string[] = [];
	readonly #output: string;
	readonly #closeHandlers = new Set<() => void>();

	constructor(output = SSH_OUTPUT) {
		this.#output = output;
	}

	exec(command: string, onChannel: (channel: ClientChannel) => void): Promise<ClientChannel> {
		this.execCalls += 1;
		this.commands.push(command);
		if (this.failWith !== undefined) return Promise.reject(this.failWith);
		if (this.closed) return Promise.reject(new Error("connection closed"));
		if (this.refusals > 0) {
			this.refusals -= 1;
			return Promise.reject(new Error("channel open failure: administratively prohibited"));
		}
		const handlers = new Map<string, (arg?: unknown) => void>();
		const channel = {
			on(event: string, handler: (arg?: unknown) => void) {
				handlers.set(event, handler);
			},
			stderr: { resume: () => {} },
			close: () => {},
		} as unknown as ClientChannel;
		onChannel(channel);
		const output = this.#output;
		setImmediate(() => {
			handlers.get("data")?.(Buffer.from(output));
			handlers.get("exit")?.(0);
			handlers.get("close")?.(0);
		});
		return Promise.resolve(channel);
	}

	onClose(fn: () => void): () => void {
		if (this.closed) {
			fn();
			return () => {};
		}
		this.#closeHandlers.add(fn);
		return () => this.#closeHandlers.delete(fn);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const fn of this.#closeHandlers) fn();
		this.#closeHandlers.clear();
	}
}

interface SshHostState {
	dials: number;
	drops: number;
	queue: FakeSshSession[];
	/** A dial that never settles, like a host whose TCP connect or handshake never finishes. */
	pending?: boolean;
}

function fakeSshHost(state: SshHostState): MetricsHost {
	return {
		graceMs: 1_000,
		link: () => undefined,
		connected: () => false,
		waitLink: async () => {},
		sshSession: async () => {
			state.dials += 1;
			if (state.pending === true) return new Promise<SshSession>(() => {});
			const session = state.queue.shift();
			if (session === undefined) throw new Error("no SSH session");
			return session as unknown as SshSession;
		},
		dropSshSession: () => {
			state.drops += 1;
		},
		setSink: () => {},
	};
}

describe("metrics collector: SSH sampling", () => {
	let db: Db;
	let store: RecordingStore;
	let settings: Harness["settings"];
	let clock: Clock;
	let hostState: SshHostState;
	let collector: MetricsCollector;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		store = new RecordingStore();
		settings = fakeSettings();
		clock = { now: nowWithinSlot(SLOT), mono: 1_000 };
		hostState = { dials: 0, drops: 0, queue: [] };
		collector = new MetricsCollector({
			db,
			store,
			settings,
			host: fakeSshHost(hostState),
			now: () => clock.now,
			monotonic: () => (clock.mono += 1_000),
			timer: false,
		});
	});

	afterEach(async () => {
		await collector.stop();
		await db.destroy();
	});

	it("runs the fixed script and records its parsed values", async () => {
		const node = await addNode(db, "ssh", null);
		const baseline = new FakeSshSession();
		const sample = new FakeSshSession();
		hostState.queue.push(baseline, sample);
		await collector.start();
		await waitFor("SSH baseline", () => baseline.execCalls >= 1);
		await collector.tick();
		await collector.settle();

		const [record] = recordsFor(store, node.id, SLOT);
		expect(recordValue(record, "up")).toBe(1);
		expect(recordValue(record, "uptime")).toBe(99);
		expect(recordValue(record, "load.1")).toBe(0.5);
		expect(recordValue(record, "disk.root.total_bytes")).toBe(1000);
		expect(recordValue(record, "disk.root.used_bytes")).toBe(400);
		expect(recordValue(record, "mem.total_bytes")).toBe(1_024_000);
		// The baseline saw the same counters, so this sample has a valid zero delta.
		expect(recordValue(record, "net.rx_bytes")).toBe(0);
		expect(sample.commands[0]).toBe(SSH_METRICS_SCRIPT);
	});

	it("replaces a dead pooled connection once", async () => {
		const node = await addNode(db, "ssh", null);
		const baseline = new FakeSshSession();
		hostState.queue.push(baseline);
		await collector.start();
		await waitFor("SSH baseline", () => baseline.execCalls >= 1);

		const dead = new FakeSshSession();
		// A connection the pool has not noticed is gone: exec reports it, and the collector replaces it.
		dead.failWith = new SshError("connect_failed", "Not connected");
		const good = new FakeSshSession();
		hostState.queue.push(dead, good);
		await collector.tick();
		await collector.settle();

		expect(hostState.dials).toBe(3);
		expect(hostState.drops).toBe(1);
		expect(recordValue(recordsFor(store, node.id, SLOT)[0], "up")).toBe(1);
	});

	it("retries a refused channel until the deadline", async () => {
		const node = await addNode(db, "ssh", null);
		const baseline = new FakeSshSession();
		hostState.queue.push(baseline);
		await collector.start();
		await waitFor("SSH baseline", () => baseline.execCalls >= 1);

		// 800 ms slots: the sample starts exactly at the half and has 400 ms to get a channel.
		settings.intervalMs = 800;
		clock.now = SLOT + 400;
		const refused = new FakeSshSession();
		refused.refusals = 2;
		hostState.queue.push(refused);
		await collector.tick();
		await collector.settle();

		expect(refused.execCalls).toBe(3);
		expect(recordValue(recordsFor(store, node.id, SLOT)[0], "up")).toBe(1);
	});

	it("bounds a dial that never opens by the deadline and samples again in the next slot", async () => {
		const node = await addNode(db, "ssh", null);
		// No startup baseline: every dial of this test belongs to a sample.
		settings.enabled = false;
		vi.useFakeTimers();
		try {
			await collector.start();
			settings.enabled = true;
			hostState.pending = true;

			// The sample starts inside its slot and stops waiting for the dial at the slot's end.
			await collector.tick();
			await vi.advanceTimersByTimeAsync(0);
			expect(hostState.dials).toBe(1);
			expect(recordsFor(store, node.id, SLOT)).toHaveLength(0);

			clock.now = metricsSampleDeadline(SLOT, INTERVAL);
			await vi.advanceTimersByTimeAsync(INTERVAL - HALF);
			await collector.settle();
			const [record] = recordsFor(store, node.id, SLOT);
			expect(record?.slotStartMs).toBe(SLOT);
			expect(recordValue(record, "up")).toBe(0);
			expect(hostState.dials).toBe(1);

			// The next slot starts one new sample; the abandoned dial is not retried or dropped.
			clock.now = nowWithinSlot(SLOT + INTERVAL);
			await collector.tick();
			await vi.advanceTimersByTimeAsync(0);
			expect(hostState.dials).toBe(2);

			clock.now = metricsSampleDeadline(SLOT + INTERVAL, INTERVAL);
			await vi.advanceTimersByTimeAsync(INTERVAL - HALF);
			await collector.settle();
			expect(recordValue(recordsFor(store, node.id, SLOT + INTERVAL)[0], "up")).toBe(0);
			expect(hostState.dials).toBe(2);
			expect(hostState.drops).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs the metrics script only once per slot when ticked again after the sample settled", async () => {
		const node = await addNode(db, "ssh", null);
		const baseline = new FakeSshSession();
		const sample = new FakeSshSession();
		const unused = [new FakeSshSession(), new FakeSshSession(), new FakeSshSession()];
		hostState.queue.push(baseline, sample, ...unused);
		await collector.start();
		await waitFor("SSH baseline", () => baseline.execCalls >= 1);

		await collector.tick();
		await collector.settle();
		expect(recordsFor(store, node.id, SLOT)).toHaveLength(1);
		expect(sample.execCalls).toBe(1);
		const dials = hostState.dials;

		// The slot's sample has landed; ticks later in the same slot must run no second script.
		for (let i = 0; i < 3; i++) {
			clock.now += 1;
			await collector.tick();
			await collector.settle();
		}
		expect(hostState.dials).toBe(dials);
		expect(sample.execCalls).toBe(1);
		for (const session of unused) expect(session.execCalls).toBe(0);
	});

	it("holds a node's sample until its hash offset within the slot", async () => {
		// A fixed id with a non-zero offset, so "one millisecond before due" exists in the slot.
		const nodeId = "11111111-1111-4111-8111-111111111111";
		const offset = metricsNodeOffset(nodeId, INTERVAL);
		expect(offset).toBeGreaterThan(0);
		const node = await addNode(db, "ssh", null, "active", nodeId);
		const baseline = new FakeSshSession();
		const sample = new FakeSshSession();
		hostState.queue.push(baseline, sample);
		await collector.start();
		await waitFor("SSH baseline", () => baseline.execCalls >= 1);

		clock.now = SLOT + offset - 1;
		await collector.tick();
		await collector.settle();
		expect(sample.execCalls).toBe(0);
		expect(hostState.dials).toBe(1);
		expect(recordsFor(store, node.id, SLOT)).toHaveLength(0);

		clock.now = SLOT + offset;
		await collector.tick();
		await collector.settle();
		expect(sample.execCalls).toBe(1);
		expect(recordValue(recordsFor(store, node.id, SLOT)[0], "up")).toBe(1);
	});

	it("replaces a dead pooled connection once when the replacement is dead too", async () => {
		const node = await addNode(db, "ssh", null);
		const baseline = new FakeSshSession();
		hostState.queue.push(baseline);
		await collector.start();
		await waitFor("SSH baseline", () => baseline.execCalls >= 1);

		// Every new session reports the connection gone: only one replacement may be tried.
		const dead = Array.from({ length: 6 }, () => {
			const session = new FakeSshSession();
			session.failWith = new SshError("connect_failed", "Not connected");
			return session;
		});
		hostState.queue.push(...dead);
		await collector.tick();
		await collector.settle();

		expect(hostState.dials).toBe(3); // the baseline, the dead session, its one replacement
		expect(hostState.drops).toBe(1);
		expect(dead[0]?.execCalls).toBe(1);
		expect(dead[1]?.execCalls).toBe(1);
		expect(dead[2]?.execCalls).toBe(0);
		const [record] = recordsFor(store, node.id, SLOT);
		expect(recordValue(record, "up")).toBe(0);
		expect(record?.values).toHaveLength(1);
	});
});
