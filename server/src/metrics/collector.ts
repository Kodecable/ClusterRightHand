/**
 * The crhs-side collector of host metrics (doc/design/metrics.md "Collection" and "Availability"): one
 * timer ticks every second and starts the samples that are due; each sample belongs to the slot it was
 * started for, is recorded at the slot's start, and gets until the slot's end to answer.
 *
 * A crha node is asked over its link with `metrics.collect`; one that does not offer the command, a
 * pending node and an upgrade-only link give `up` from the connection state alone. An SSH node runs the
 * fixed read-only script (ssh-script.ts) on its pooled connection. The raw answer is turned into stored
 * values by compute.ts; the collector owns the slots, the reconnect grace and the latest-sample memory.
 *
 * The cluster side is a small host interface (MetricsHost): the Cluster implements it, and tests fake it.
 */
import { ConnectionError, type MetricsSnapshot, type Peer, RemoteError, RequestTimeoutError } from "@crh/protocol";
import type { ClientChannel } from "ssh2";
import type { NodeRow } from "../cluster/nodes.ts";
import { SshError, type SshSession } from "../cluster/ssh/connection.ts";
import type { Db } from "../storage/db.ts";
import { type ComputedSample, MetricsComputer } from "./compute.ts";
import { parseSshMetricsScript, SSH_METRICS_SCRIPT, sshMetricsScriptComplete } from "./ssh-script.ts";
import type { MetricValue } from "./store.ts";

/** The one-second tick that starts due samples (doc/design/metrics.md "Collection"). */
export const METRICS_TICK_MS = 1000;

/** How long a baseline request may take; it only seeds the counters, so it must never delay a sample for long. */
export const METRICS_BASELINE_TIMEOUT_MS = 10_000;

/** How long to wait before asking for a refused SSH channel again, until the slot's deadline. */
export const METRICS_SSH_RETRY_MS = 100;

/** A metrics script output larger than this is not a sample: it can only be a broken stream. */
export const METRICS_SSH_OUTPUT_LIMIT = 1024 * 1024;

/** What the collector needs from the database; the real store buffers and writes (store.ts). */
export interface MetricsRecorder {
	record(nodeId: string, slotStartMs: number, values: readonly MetricValue[]): void;
}

/** The System settings the collector reads at each tick (settings.ts). */
export interface MetricsSettings {
	current(): { metrics: { enabled: boolean; intervalMs: number } };
}

/** A node as the collector schedules it. Node rows are re-read each tick so status changes apply. */
export type MetricsNode = Pick<NodeRow, "id" | "transport" | "status">;

/** A ready crha link: it can take a `metrics.collect`. Pending and upgrade-only links are not ready. */
export interface MetricsLink {
	readonly peer: Peer;
	readonly upgradeOnly: boolean;
}

/** The connection events the collector hears from the cluster, like the terminal subsystem's sink. */
export interface MetricsSink {
	/** A crha node's link is ready again: take a baseline sample immediately. */
	onLinkUp(nodeId: string): void;
	/** A node's link ended; the disconnect starts the reconnect grace. */
	onLinkLost(nodeId: string): void;
	/** The node was deleted: forget its counters, its latest sample and its timers. */
	onNodeRemoved(nodeId: string): void;
}

/**
 * What the collector needs from the cluster. The Cluster builds one in `metricsHost()`; tests provide a
 * fake with the same methods.
 */
export interface MetricsHost {
	/** The reconnect grace, shared with the task side (doc/design/execution.md "Reconnect"). */
	readonly graceMs: number;
	/** The node's ready, active crha link, when it has one. */
	link(nodeId: string): MetricsLink | undefined;
	/** Whether any connection to the node is live (a pending or upgrade-only link included). */
	connected(nodeId: string): boolean;
	/** Resolves when the node's link changes, or when `timeoutMs` passes. */
	waitLink(nodeId: string, timeoutMs: number): Promise<void>;
	/** The node's pooled SSH connection, dialling it when needed. */
	sshSession(nodeId: string): Promise<SshSession>;
	/** Drops a dead pooled SSH connection, so the next `sshSession` dials again. */
	dropSshSession(nodeId: string): void;
	/** Installs (or removes) the link event sink. */
	setSink(sink: MetricsSink | undefined): void;
}

/** One successful sample kept in memory for the node list (doc/design/metrics.md "Reading"). */
export interface LatestMetrics {
	slotStartMs: number;
	values: MetricValue[];
}

export interface MetricsCollectorOptions {
	db: Db;
	store: MetricsRecorder;
	settings: MetricsSettings;
	host: MetricsHost;
	/** Wall clock; tests inject one so slots are deterministic. */
	now?: () => number;
	/** Monotonic clock; tests inject one so rates are deterministic. */
	monotonic?: () => number;
	/** The timer tick; tests shorten it or drive `tick()` themselves with `timer: false`. */
	tickMs?: number;
	/** Whether to start the one-second interval; tests pass false. */
	timer?: boolean;
}

/** The start of the slot that contains `nowMs` (doc/design/metrics.md "Collection"). */
export function metricsSlotStart(nowMs: number, intervalMs: number): number {
	if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) return nowMs;
	return Math.floor(nowMs / intervalMs) * intervalMs;
}

/** The end of a slot: the deadline of the sample it holds. */
export function metricsSampleDeadline(slotStartMs: number, intervalMs: number): number {
	return slotStartMs + intervalMs;
}

/**
 * A node's fixed offset in the first half of its slot, from a hash of its id. The offset is fixed so a
 * node's samples stay one interval apart, and bounded so the second half stays free for waiting and
 * retrying (doc/design/metrics.md "Collection").
 */
export function metricsNodeOffset(nodeId: string, intervalMs: number): number {
	const half = Math.floor(intervalMs / 2);
	if (half <= 0) return 0;
	// FNV-1a: small, stable, and independent of the platform's hash randomisation.
	let hash = 0x811c9dc5;
	for (let i = 0; i < nodeId.length; i++) {
		hash ^= nodeId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % half;
}

/** Thrown internally when stop() ends a wait; it never becomes a stored outcome. */
class CollectorStoppedError extends Error {}

interface NodeState {
	node: MetricsNode;
	/** The slot whose sample was started; one sample per slot, even if the wall clock steps back. */
	lastStartedSlot: number | undefined;
	/** The highest slot with a row; a retroactive write must not overwrite a newer one. */
	lastRecordedSlot: number | undefined;
	/**
	 * The first slot without a row while the node was disconnected. Its slots stay gaps when the node
	 * comes back with the same boot, and become up = 0 when it comes back with a new one or the grace
	 * runs out (doc/design/metrics.md "Availability").
	 */
	gapFromSlot: number | undefined;
	/** The slot width used when the gap started; a later interval change must not shift its slots. */
	gapIntervalMs: number | undefined;
	/** The node is known to be down after the grace ran out. */
	down: boolean;
	disconnectAtMs: number | undefined;
	graceTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped on every link change, so a baseline answer of a dead link is ignored. */
	generation: number;
	/** The baseline request in flight; the first stored sample waits for it. */
	baseline: Promise<void> | undefined;
	/** The link generation of that baseline, so the same link cannot start a second one. */
	baselineGeneration: number | undefined;
	/** A generation whose baseline a stored sample overtook; a late answer must not seed older counters. */
	baselineIgnoredGeneration: number | undefined;
	/** Whether a sampling failure has been logged, so it is logged when it starts and stops, not per sample. */
	failing: boolean;
	/**
	 * The reason and start of the current sampling failure, while `failing` is true. The node list shows it
	 * for an online node (doc/design/metrics.md "Collection"); recovery clears it.
	 */
	failure: { reason: string; since: string } | undefined;
	/**
	 * The filesystem names of the latest successful sample, in the order crha reported them. crhs does not
	 * store report order, so the WebUI gets it from here for the first-filesystem summary card
	 * (doc/design/metrics.md "Storage").
	 */
	diskOrder: string[] | undefined;
	/**
	 * Whether this node's sample is still running. A sample that outlives its slot is a skipped slot,
	 * never a second sample piled on the same node (doc/design/metrics.md "Collection").
	 */
	sampleInFlight: boolean;
}

/**
 * The host metrics collector. `start()` loads the nodes, takes the startup baselines, arms the grace of
 * the nodes that are not connected and starts the one-second timer. `stop()` ends the waits and waits
 * for the in-flight samples; the caller closes the MetricsStore afterwards.
 */
export class MetricsCollector {
	readonly #db: Db;
	readonly #store: MetricsRecorder;
	readonly #settings: MetricsSettings;
	readonly #host: MetricsHost;
	readonly #now: () => number;
	readonly #monotonic: () => number;
	readonly #tickMs: number;
	readonly #timerEnabled: boolean;
	readonly #computer = new MetricsComputer();
	readonly #states = new Map<string, NodeState>();
	readonly #latest = new Map<string, LatestMetrics>();
	readonly #inFlight = new Set<Promise<void>>();
	readonly #abort = new AbortController();
	#interval: ReturnType<typeof setInterval> | undefined;
	#started = false;
	#closed = false;
	#tickBusy = false;

	constructor(options: MetricsCollectorOptions) {
		this.#db = options.db;
		this.#store = options.store;
		this.#settings = options.settings;
		this.#host = options.host;
		this.#now = options.now ?? Date.now;
		this.#monotonic = options.monotonic ?? (() => performance.now());
		this.#tickMs = options.tickMs ?? METRICS_TICK_MS;
		this.#timerEnabled = options.timer !== false;
	}

	/** The latest successful sample of a node, or undefined until its first one after a restart. */
	latest(nodeId: string): LatestMetrics | undefined {
		const latest = this.#latest.get(nodeId);
		if (latest === undefined) return undefined;
		return {
			slotStartMs: latest.slotStartMs,
			values: latest.values.map((value) => ({ ...value })),
		};
	}

	/**
	 * Why the node's sampling is currently failing, and since when, or undefined while it succeeds. Kept in
	 * memory only: after a crhs restart it returns on the next failed sample (doc/design/metrics.md
	 * "Collection").
	 */
	metricsFailure(nodeId: string): { reason: string; since: string } | undefined {
		const failure = this.#states.get(nodeId)?.failure;
		return failure === undefined ? undefined : { ...failure };
	}

	/** The filesystem names of the node's latest successful sample in report order, when it reported any. */
	diskOrder(nodeId: string): string[] | undefined {
		const order = this.#states.get(nodeId)?.diskOrder;
		return order === undefined ? undefined : [...order];
	}

	/**
	 * Loads the nodes, takes the startup baselines, counts the nodes that never connected since this
	 * process started as disconnected, and starts the timer.
	 */
	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#host.setSink({
			onLinkUp: (nodeId) => this.#onLinkUp(nodeId),
			onLinkLost: (nodeId) => this.#onLinkLost(nodeId),
			onNodeRemoved: (nodeId) => this.#onNodeRemoved(nodeId),
		});
		await this.#refreshNodes();
		const enabled = this.#settings.current().metrics.enabled;
		const intervalMs = this.#intervalMs();
		for (const state of this.#states.values()) {
			if (state.node.transport === "ssh") {
				if (enabled && state.node.status === "active") this.#startBaseline(state);
				continue;
			}
			if (state.node.status !== "active") continue;
			if (this.#host.connected(state.node.id)) {
				if (enabled && this.#host.link(state.node.id) !== undefined) this.#startBaseline(state);
			} else {
				this.#markDisconnected(state, this.#now(), intervalMs);
			}
		}
		if (this.#timerEnabled) {
			this.#interval = setInterval(() => {
				void this.tick().catch((err: unknown) => {
					if (!this.#closed) console.error("metrics: tick failed:", err);
				});
			}, this.#tickMs);
			this.#interval.unref();
		}
	}

	/**
	 * One timer tick: the nodes that are due in the current slot start their sample. A tick that finds
	 * itself in a later slot never starts a sample for a slot that already ended: those slots are gaps.
	 */
	async tick(): Promise<void> {
		if (this.#closed || this.#tickBusy) return;
		this.#tickBusy = true;
		try {
			const settings = this.#settings.current().metrics;
			if (!settings.enabled) return;
			const intervalMs = settings.intervalMs;
			if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) return;
			await this.#refreshNodes();
			if (this.#closed) return;
			const now = this.#now();
			const slotStart = metricsSlotStart(now, intervalMs);
			const deadline = metricsSampleDeadline(slotStart, intervalMs);
			for (const state of [...this.#states.values()]) {
				if (this.#closed) return;
				this.#ensureAvailability(state, intervalMs);
				// A sample that outlived its slot leaves that slot without a row rather than stacking a
				// second sample on the same node (doc/design/metrics.md "Collection").
				if (state.sampleInFlight) continue;
				if (!shouldSample(state.node, this.#host)) continue;
				if (state.lastStartedSlot !== undefined && slotStart <= state.lastStartedSlot) continue;
				const due = slotStart + metricsNodeOffset(state.node.id, intervalMs);
				if (now < due) continue;
				state.lastStartedSlot = slotStart;
				this.#track(this.#sample(state, slotStart, deadline));
			}
		} finally {
			this.#tickBusy = false;
		}
	}

	/** Waits until every sample started so far has settled; shutdown uses it before the store closes. */
	async settle(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.all([...this.#inFlight]);
		}
	}

	/**
	 * Stops the timer, ends every wait and the in-flight samples, and removes the link sink. The buffered
	 * values stay in the store; the caller flushes and closes it afterwards.
	 */
	async stop(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#abort.abort();
		if (this.#interval !== undefined) {
			clearInterval(this.#interval);
			this.#interval = undefined;
		}
		for (const state of this.#states.values()) this.#clearGrace(state);
		this.#host.setSink(undefined);
		await this.settle();
	}

	// ---- node list and availability ----

	/** Re-reads the node rows; a node that disappeared loses its counters, latest sample and timers. */
	async #refreshNodes(): Promise<void> {
		const rows = await this.#db.selectFrom("nodes").select(["id", "transport", "status"]).execute();
		const seen = new Set(rows.map((row) => row.id));
		for (const nodeId of [...this.#states.keys()]) {
			if (!seen.has(nodeId)) this.#dropState(nodeId);
		}
		for (const row of rows) {
			const state = this.#states.get(row.id);
			if (state === undefined) {
				const created: NodeState = {
					node: row,
					lastStartedSlot: undefined,
					lastRecordedSlot: undefined,
					gapFromSlot: undefined,
					gapIntervalMs: undefined,
					down: false,
					disconnectAtMs: undefined,
					graceTimer: undefined,
					generation: 0,
					baseline: undefined,
					baselineGeneration: undefined,
					baselineIgnoredGeneration: undefined,
					failing: false,
					failure: undefined,
					diskOrder: undefined,
					sampleInFlight: false,
				};
				this.#states.set(row.id, created);
				this.#baselineNewState(created);
				continue;
			}
			if (state.node.transport !== row.transport) {
				this.#dropState(row.id);
				const created: NodeState = {
					node: row,
					lastStartedSlot: undefined,
					lastRecordedSlot: undefined,
					gapFromSlot: undefined,
					gapIntervalMs: undefined,
					down: false,
					disconnectAtMs: undefined,
					graceTimer: undefined,
					generation: 0,
					baseline: undefined,
					baselineGeneration: undefined,
					baselineIgnoredGeneration: undefined,
					failing: false,
					failure: undefined,
					diskOrder: undefined,
					sampleInFlight: false,
				};
				this.#states.set(row.id, created);
				this.#baselineNewState(created);
				continue;
			}
			if (state.node.status === "active" && row.status !== "active") {
				// A re-enrolled node is pending, not down: its link is sampled as up only, and the grace of
				// the identity it had before does not produce up = 0 rows (doc/design/metrics.md "Scope").
				this.#clearGrace(state);
				state.gapFromSlot = undefined;
				state.disconnectAtMs = undefined;
				state.down = false;
			}
			state.node = row;
		}
	}

	/**
	 * Takes the baseline of a node discovered after the collector started: SSH nodes are baselined when
	 * first seen, and a crha node that is already connected gets one before its first due sample.
	 */
	#baselineNewState(state: NodeState): void {
		if (!this.#settings.current().metrics.enabled || state.node.status !== "active") return;
		try {
			if (state.node.transport === "ssh") {
				this.#startBaseline(state);
				return;
			}
			if (this.#host.connected(state.node.id) && this.#host.link(state.node.id) !== undefined) {
				this.#startBaseline(state);
			}
		} catch (err) {
			console.error(`metrics: starting the baseline of node ${state.node.id} failed:`, err);
		}
	}

	/**
	 * Starts the grace of an active crha node that is not connected, or expires it when it already ran
	 * out. Called by each tick, so a settings change or a link event missed while collection was off
	 * still leaves the node in the right state.
	 */
	#ensureAvailability(state: NodeState, intervalMs: number): void {
		if (state.node.transport !== "client" || state.node.status !== "active") return;
		if (this.#host.connected(state.node.id)) return;
		if (state.down) return;
		if (state.gapFromSlot === undefined) {
			this.#markDisconnected(state, this.#now(), intervalMs);
			return;
		}
		const at = state.disconnectAtMs;
		if (at !== undefined && at + this.#host.graceMs <= this.#now()) this.#expireGrace(state);
	}

	#markDisconnected(state: NodeState, atMs: number, intervalMs: number): void {
		if (!this.#settings.current().metrics.enabled) {
			// Collection is off: no grace and no rows. When it is turned back on the node is simply
			// treated as disconnected from that moment, so the disabled time stays a gap.
			state.down = true;
			state.gapFromSlot = undefined;
			state.gapIntervalMs = undefined;
			state.disconnectAtMs = undefined;
			return;
		}
		const slot = metricsSlotStart(atMs, intervalMs);
		state.gapFromSlot = state.gapFromSlot === undefined ? slot : Math.min(state.gapFromSlot, slot);
		state.gapIntervalMs = intervalMs;
		state.disconnectAtMs = atMs;
		state.down = false;
		this.#clearGrace(state);
		const delay = Math.max(0, atMs + this.#host.graceMs - this.#now());
		state.graceTimer = setTimeout(() => {
			state.graceTimer = undefined;
			this.#expireGrace(state);
		}, delay);
		state.graceTimer.unref?.();
	}

	#expireGrace(state: NodeState): void {
		if (this.#closed || this.#states.get(state.node.id) !== state) return;
		if (state.gapFromSlot === undefined || state.down) return;
		this.#clearGrace(state);
		// The node came back (its handshake may still be running): its boot will decide gap or reboot.
		if (this.#host.connected(state.node.id)) return;
		if (!this.#settings.current().metrics.enabled) {
			// Collection is off: do not write availability rows for the time it was off.
			state.down = true;
			state.gapFromSlot = undefined;
			state.disconnectAtMs = undefined;
			return;
		}
		const intervalMs = state.gapIntervalMs ?? this.#intervalMs();
		const currentSlot = metricsSlotStart(this.#now(), intervalMs);
		// The node is down: every slot up to the one in which the grace ran out is a missed sample.
		// A timer that fires late (crhs itself was stalled) does not fill the slots that passed while
		// nothing ran: those are gaps, as a stalled slot always is (doc/design/metrics.md "Collection").
		// Later slots are written as their own ticks pass.
		const graceDeadline = (state.disconnectAtMs ?? this.#now()) + this.#host.graceMs;
		const endSlot = Math.min(metricsSlotStart(graceDeadline, intervalMs), currentSlot);
		this.#writeUpZero(state, state.gapFromSlot, metricsSampleDeadline(endSlot, intervalMs), intervalMs);
		state.gapFromSlot = undefined;
		state.disconnectAtMs = undefined;
		state.down = true;
		state.lastStartedSlot = state.lastStartedSlot === undefined ? endSlot : Math.max(state.lastStartedSlot, endSlot);
		this.#fail(state, "disconnected past the reconnect grace");
	}

	#clearGrace(state: NodeState): void {
		if (state.graceTimer === undefined) return;
		clearTimeout(state.graceTimer);
		state.graceTimer = undefined;
	}

	/** The cluster's link event: the node is back. Its boot decides whether the gap was downtime. */
	#onLinkUp(nodeId: string): void {
		if (this.#closed) return;
		const state = this.#states.get(nodeId);
		if (state === undefined) {
			// A node that connected before the tick that would have added it: load the row and take the
			// baseline then, so the first due sample still has counters (doc/design/metrics.md "Collection").
			void this.#refreshNodes()
				.then(() => {
					if (this.#closed) return;
					const added = this.#states.get(nodeId);
					if (added !== undefined) this.#linkUp(added);
				})
				.catch((err: unknown) => {
					if (!this.#closed) console.error("metrics: loading a connected node failed:", err);
				});
			return;
		}
		this.#linkUp(state);
	}

	#linkUp(state: NodeState): void {
		const nodeId = state.node.id;
		state.generation += 1;
		this.#clearGrace(state);
		if (state.node.transport !== "client" || state.node.status !== "active") return;
		state.down = false;
		const link = this.#host.link(nodeId);
		if (link === undefined) return;
		// A link that cannot answer metrics.collect has no boot to compare: the node is simply back,
		// and its slots during the grace stay gaps (doc/design/metrics.md "Availability").
		if (link.upgradeOnly || !link.peer.negotiated.has("metrics.collect")) {
			state.gapFromSlot = undefined;
			state.disconnectAtMs = undefined;
			return;
		}
		if (this.#settings.current().metrics.enabled) this.#startBaseline(state);
	}

	#onLinkLost(nodeId: string): void {
		if (this.#closed) return;
		const state = this.#states.get(nodeId);
		if (state === undefined) return;
		state.generation += 1;
		this.#clearGrace(state);
		if (state.node.transport !== "client" || state.node.status !== "active") return;
		if (!this.#settings.current().metrics.enabled) {
			// Collection is off: no grace and no rows for this disconnect. When it is turned back on,
			// the node is simply treated as disconnected from that moment.
			state.down = true;
			state.gapFromSlot = undefined;
			state.disconnectAtMs = undefined;
			return;
		}
		this.#markDisconnected(state, this.#now(), this.#intervalMs());
	}

	#onNodeRemoved(nodeId: string): void {
		this.#dropState(nodeId);
	}

	#dropState(nodeId: string): void {
		const state = this.#states.get(nodeId);
		if (state !== undefined) this.#clearGrace(state);
		this.#states.delete(nodeId);
		this.#computer.forget(nodeId);
		this.#latest.delete(nodeId);
	}

	// ---- sampling ----

	#track(work: Promise<void>): void {
		let tracked: Promise<void>;
		tracked = work
			.catch((err: unknown) => {
				if (this.#closed || err instanceof CollectorStoppedError) return;
				console.error("metrics: sample failed:", err);
			})
			.finally(() => {
				this.#inFlight.delete(tracked);
			});
		this.#inFlight.add(tracked);
	}

	async #sample(state: NodeState, slotStart: number, deadline: number): Promise<void> {
		state.sampleInFlight = true;
		try {
			if (state.node.transport === "ssh") {
				await this.#sampleSsh(state, slotStart, deadline);
				return;
			}
			await this.#sampleCrha(state, slotStart, deadline);
		} catch (err) {
			if (this.#closed || err instanceof CollectorStoppedError) return;
			const reason = err instanceof Error ? err.message : String(err);
			this.#fail(state, reason);
			this.#recordUpZero(state, slotStart);
		} finally {
			state.sampleInFlight = false;
		}
	}

	async #sampleCrha(state: NodeState, slotStart: number, deadline: number): Promise<void> {
		const nodeId = state.node.id;
		// A pending node is sampled from its connection state only (doc/design/metrics.md "Scope").
		if (state.node.status !== "active") {
			this.#recordUp(state, slotStart, this.#host.connected(nodeId));
			return;
		}
		for (;;) {
			if (this.#closed) return;
			if (this.#now() >= deadline) break;
			if (state.down) {
				if (!this.#host.connected(nodeId)) {
					this.#recordUpZero(state, slotStart);
					this.#fail(state, "the node is disconnected");
					return;
				}
				state.down = false;
			}
			const link = this.#host.link(nodeId);
			if (link !== undefined) {
				if (link.upgradeOnly || !link.peer.negotiated.has("metrics.collect")) {
					// A node that does not offer the command is sampled as up only, from the connection
					// state (doc/design/metrics.md "crha nodes").
					this.#recordUp(state, slotStart, true);
					return;
				}
				await this.#awaitBaseline(state, deadline);
				if (this.#closed) return;
				if (this.#now() > deadline) break;
				try {
					const raw = await this.#requestSnapshot(link, deadline);
					if (this.#closed) return;
					if (this.#now() > deadline) break;
					this.#handleSnapshot(state, raw, slotStart);
					return;
				} catch (err) {
					if (err instanceof CollectorStoppedError) return;
					if (err instanceof ConnectionError) {
						// The request ended with the connection; send it again on the new connection
						// before the deadline (doc/design/metrics.md "Availability").
						continue;
					}
					if (err instanceof RequestTimeoutError) break;
					if (err instanceof RemoteError) {
						this.#fail(state, `metrics.collect failed: ${err.code}: ${err.message}`);
						break;
					}
					throw err;
				}
			}
			if (!this.#host.connected(nodeId)) {
				// Disconnected at the due time: wait for the connection until the deadline.
				await this.#waitLink(nodeId, deadline);
				continue;
			}
			// Connected but its hello has not made the link ready yet: wait for that.
			await this.#waitLink(nodeId, Math.min(deadline, this.#now() + this.#tickMs));
		}
		if (this.#closed) return;
		// No sample by the deadline. A connected crha node is up = 0; one still inside its reconnect
		// grace gets no row, so an outage caused by crha is a gap rather than downtime.
		if (this.#host.connected(nodeId) || state.down) {
			this.#recordUpZero(state, slotStart);
			this.#fail(state, "no sample by the deadline");
		}
	}

	async #sampleSsh(state: NodeState, slotStart: number, deadline: number): Promise<void> {
		await this.#awaitBaseline(state, deadline);
		if (this.#closed) return;
		if (this.#now() > deadline) {
			this.#recordUpZero(state, slotStart);
			this.#fail(state, "no sample by the deadline");
			return;
		}
		try {
			const raw = await this.#readSshSample(state, deadline);
			if (this.#closed) return;
			if (this.#now() > deadline) {
				this.#recordUpZero(state, slotStart);
				this.#fail(state, "no sample by the deadline");
				return;
			}
			this.#handleSnapshot(state, raw, slotStart);
		} catch (err) {
			if (this.#closed || err instanceof CollectorStoppedError) return;
			this.#fail(state, err instanceof Error ? err.message : String(err));
			this.#recordUpZero(state, slotStart);
		}
	}

	#requestSnapshot(link: MetricsLink, deadline: number): Promise<MetricsSnapshot> {
		const remaining = deadline - this.#now();
		if (remaining <= 0) return Promise.reject(new RequestTimeoutError("metrics.collect", 0));
		return this.#untilAbort(link.peer.request("metrics.collect", {}, { timeoutMs: remaining }));
	}

	/** Waits for a link change, at most until `untilMs`; returns at the deadline or on stop. */
	async #waitLink(nodeId: string, untilMs: number): Promise<void> {
		const timeout = untilMs - this.#now();
		if (timeout <= 0) return;
		try {
			await this.#untilAbort(this.#host.waitLink(nodeId, timeout));
		} catch (err) {
			if (!(err instanceof CollectorStoppedError)) throw err;
		}
	}

	/** Waits for the node's baseline to settle, but never past the sample's deadline. */
	async #awaitBaseline(state: NodeState, deadline: number): Promise<void> {
		const baseline = state.baseline;
		if (baseline === undefined) return;
		const remaining = deadline - this.#now();
		if (remaining <= 0) return;
		try {
			await this.#untilAbort(raceTimeout(baseline, remaining));
		} catch (err) {
			if (!(err instanceof CollectorStoppedError)) throw err;
		}
	}

	// ---- baselines ----

	/** Starts a baseline request; the first stored sample waits for it, and it is never stored. */
	#startBaseline(state: NodeState): void {
		if (this.#closed) return;
		if (state.baseline !== undefined && state.baselineGeneration === state.generation) return;
		if (state.baselineIgnoredGeneration === state.generation) return;
		const generation = state.generation;
		state.baselineGeneration = generation;
		let tracked: Promise<void>;
		tracked = (async () => {
			try {
				if (state.node.transport === "ssh") {
					const raw = await this.#readSshSample(state, this.#now() + METRICS_BASELINE_TIMEOUT_MS);
					if (this.#closed || this.#states.get(state.node.id) !== state || generation !== state.generation) {
						return;
					}
					if (state.baselineIgnoredGeneration === generation) return;
					this.#computer.sample(state.node.id, raw, this.#monotonic());
					this.#recovered(state);
					return;
				}
				const link = this.#host.link(state.node.id);
				if (link === undefined || link.upgradeOnly || !link.peer.negotiated.has("metrics.collect")) return;
				if (!this.#settings.current().metrics.enabled) return;
				const raw = await this.#untilAbort(
					link.peer.request("metrics.collect", {}, { timeoutMs: METRICS_BASELINE_TIMEOUT_MS }),
				);
				if (this.#closed || this.#states.get(state.node.id) !== state || generation !== state.generation) {
					return;
				}
				if (state.baselineIgnoredGeneration === generation) return;
				// A replacement connection may have taken over while the answer was in flight.
				if (this.#host.link(state.node.id)?.peer !== link.peer) return;
				const result = this.#computer.sample(state.node.id, raw, this.#monotonic());
				this.#observeBoot(state, result, metricsSlotStart(this.#now(), this.#intervalMs()));
				this.#recovered(state);
			} catch (err) {
				// A baseline only seeds the counters: its failure loses that one sample's deltas and rates,
				// and is not a sampling failure of the node (doc/design/metrics.md "Computation").
				if (err instanceof CollectorStoppedError || this.#closed) return;
			}
		})().finally(() => {
			if (state.baseline === tracked) state.baseline = undefined;
		});
		state.baseline = tracked;
	}

	/**
	 * Applies a boot change to the availability state: a new boot writes up = 0 for the slots since the
	 * disconnect, a same-boot return leaves them as gaps. The caller records the sample only afterwards,
	 * so a retroactive row cannot overwrite the newer one in a coarse bucket (doc/design/metrics.md
	 * "Availability").
	 */
	#observeBoot(state: NodeState, result: ComputedSample, beforeSlot: number): void {
		state.down = false;
		if (state.gapFromSlot === undefined) return;
		if (result.rebooted) {
			const intervalMs = state.gapIntervalMs ?? this.#intervalMs();
			this.#writeUpZero(state, state.gapFromSlot, beforeSlot, intervalMs);
		} else if (result.bootId === undefined) {
			// Without a bootId the reboot cannot be told from a crha reconnect; keep the gap pending for
			// a later sample that reports one.
			return;
		}
		state.gapFromSlot = undefined;
		state.disconnectAtMs = undefined;
	}

	/** Stores a successful sample and keeps it as the node's latest successful one. */
	#handleSnapshot(state: NodeState, raw: MetricsSnapshot, slotStart: number): void {
		// A node deleted while its request was in flight has no state left and must not recreate the
		// computer's counters for its old id.
		if (this.#closed || this.#states.get(state.node.id) !== state) return;
		// A baseline still in flight has older counters than this sample; letting it land later would
		// move the previous values backwards and inflate the next delta.
		state.baselineIgnoredGeneration = state.generation;
		const result = this.#computer.sample(state.node.id, raw, this.#monotonic());
		this.#observeBoot(state, result, slotStart);
		// Keep the report order of the latest successful sample: a filesystem can disappear between
		// samples, and the WebUI's first-filesystem card needs the order the node last reported.
		state.diskOrder =
			raw.disks === undefined ? undefined : raw.disks.filter((disk) => disk.kind === "ok").map((disk) => disk.name);
		const values = [...result.values, { name: "up", kind: "gauge" as const, value: 1 }];
		if (this.#record(state, slotStart, values)) {
			this.#latest.set(state.node.id, {
				slotStartMs: slotStart,
				values: values.map((value) => ({ ...value })),
			});
		}
		this.#recovered(state);
	}

	// ---- recording ----

	#recordUp(state: NodeState, slotStart: number, up: boolean): void {
		const values: MetricValue[] = [{ name: "up", kind: "gauge", value: up ? 1 : 0 }];
		if (this.#record(state, slotStart, values) && up) {
			// An up-only sample is still the node's latest successful one; it just has no host figures.
			this.#latest.set(state.node.id, { slotStartMs: slotStart, values: values.map((value) => ({ ...value })) });
		}
		if (up) this.#recovered(state);
	}

	#recordUpZero(state: NodeState, slotStart: number): void {
		this.#record(state, slotStart, [{ name: "up", kind: "gauge", value: 0 }]);
	}

	/**
	 * Records one slot's values unless a newer slot already has a row. A retroactive up = 0 and the
	 * sample of the slot in which a node came back must not both write the same slot.
	 */
	#record(state: NodeState, slotStart: number, values: readonly MetricValue[]): boolean {
		if (this.#closed || this.#states.get(state.node.id) !== state) return false;
		if (state.lastRecordedSlot !== undefined && slotStart <= state.lastRecordedSlot) return false;
		this.#store.record(state.node.id, slotStart, values);
		state.lastRecordedSlot = slotStart;
		return true;
	}

	/** Writes up = 0 for every unrecorded slot in `[fromSlot, toExclusive)` with `intervalMs` width. */
	#writeUpZero(state: NodeState, fromSlot: number, toExclusive: number, intervalMs: number): void {
		if (!(intervalMs > 0)) return;
		let slot = fromSlot;
		if (state.lastRecordedSlot !== undefined) {
			const next = Math.floor(state.lastRecordedSlot / intervalMs) * intervalMs + intervalMs;
			if (next > slot) slot = next;
		}
		for (; slot < toExclusive; slot += intervalMs) {
			if (!this.#record(state, slot, [{ name: "up", kind: "gauge", value: 0 }])) return;
		}
	}

	// ---- logging ----

	#fail(state: NodeState, reason: string): void {
		if (!state.failing) {
			state.failing = true;
			state.failure = { reason, since: new Date(this.#now()).toISOString() };
			console.warn(`node ${state.node.id}: metrics sampling failed: ${reason}`);
			return;
		}
		// The failure continues: keep its start so the warning does not reset on every retry, but show
		// the newest reason, which is the one an operator can act on.
		if (state.failure !== undefined && state.failure.reason !== reason) {
			state.failure = { reason, since: state.failure.since };
		}
	}

	#recovered(state: NodeState): void {
		if (!state.failing) return;
		state.failing = false;
		state.failure = undefined;
		console.info(`node ${state.node.id}: metrics sampling recovered`);
	}

	// ---- helpers ----

	#intervalMs(): number {
		const intervalMs = this.#settings.current().metrics.intervalMs;
		return intervalMs > 0 && Number.isFinite(intervalMs) ? intervalMs : 60_000;
	}

	/** Races a promise with the collector's stop; a stop rejects with CollectorStoppedError. */
	#untilAbort<T>(work: Promise<T>): Promise<T> {
		const signal = this.#abort.signal;
		if (signal.aborted) return Promise.reject(new CollectorStoppedError());
		return new Promise<T>((resolve, reject) => {
			const onAbort = (): void => {
				signal.removeEventListener("abort", onAbort);
				reject(new CollectorStoppedError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			work.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(err: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	// ---- SSH ----

	/**
	 * Opens the node's pooled SSH connection, bounded by `deadline`. The pool owns the connection: a dial
	 * that settles after the race was lost is only ignored, never closed here, so the next sample can use
	 * it; its rejection is swallowed so a late failure is not unhandled.
	 */
	#dialSshSession(nodeId: string, deadline: number): Promise<SshSession> {
		const dial = this.#host.sshSession(nodeId);
		dial.catch(() => {});
		const remaining = deadline - this.#now();
		if (remaining <= 0) return Promise.reject(new Error("the SSH connection did not open by the deadline"));
		return new Promise<SshSession>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("the SSH connection did not open by the deadline")), remaining);
			timer.unref?.();
			dial.then(
				(session) => {
					clearTimeout(timer);
					resolve(session);
				},
				(err: unknown) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}

	/**
	 * Runs the metrics script on the node's pooled connection. A dead connection is replaced once; a
	 * refused channel (the server's session limit taken by tasks) is asked for again until the deadline.
	 */
	async #readSshSample(state: NodeState, deadline: number): Promise<MetricsSnapshot> {
		const nodeId = state.node.id;
		let replaced = false;
		let session: SshSession | undefined;
		for (;;) {
			if (this.#closed) throw new CollectorStoppedError();
			if (this.#now() >= deadline) throw new Error("the metrics script timed out");
			if (session === undefined) {
				session = await this.#untilAbort(this.#dialSshSession(nodeId, deadline));
			}
			if (session.closed) {
				if (replaced) throw new Error("the SSH connection is still closed");
				replaced = true;
				this.#host.dropSshSession(nodeId);
				session = undefined;
				continue;
			}
			try {
				const output = await this.#execSshScript(session, deadline);
				if (!sshMetricsScriptComplete(output)) throw new Error("the metrics script did not finish");
				return parseSshMetricsScript(output);
			} catch (err) {
				if (err instanceof CollectorStoppedError) throw err;
				// A dead pooled connection is replaced once. SshError is what SshSession.exec reports for a
				// connection it already knows is gone; the message check covers a transport that died without
				// its close event yet (doc/design/metrics.md "SSH nodes").
				if (session.closed || err instanceof SshError || isConnectionLostText(err)) {
					if (replaced) throw err;
					replaced = true;
					this.#host.dropSshSession(nodeId);
					session = undefined;
					continue;
				}
				if (this.#now() >= deadline) throw err;
				// The channel was refused, not the connection: ask again until the deadline.
				const remaining = deadline - this.#now();
				if (remaining <= 0) throw err;
				await this.#sleep(Math.min(METRICS_SSH_RETRY_MS, remaining));
			}
		}
	}

	#execSshScript(session: SshSession, deadline: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let channel: ClientChannel | undefined;
			let output = "";
			let exited = false;
			let exitCode: number | null = null;
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unwatch: (() => void) | undefined;
			const closeChannel = (): void => {
				try {
					channel?.close();
				} catch {
					// The channel is already gone; the sample's outcome does not change.
				}
			};
			const onAbort = (): void => {
				finish(new CollectorStoppedError());
				closeChannel();
			};
			const finish = (err?: Error): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				unwatch?.();
				this.#abort.signal.removeEventListener("abort", onAbort);
				if (err) reject(err);
				else resolve(output);
			};
			const remaining = deadline - this.#now();
			if (remaining <= 0) {
				finish(new Error("the metrics script timed out"));
				return;
			}
			timer = setTimeout(() => {
				finish(new Error("the metrics script timed out"));
				closeChannel();
			}, remaining);
			timer.unref?.();
			if (this.#abort.signal.aborted) {
				finish(new CollectorStoppedError());
				return;
			}
			this.#abort.signal.addEventListener("abort", onAbort, { once: true });
			unwatch = session.onClose(() => finish(new Error("the SSH connection closed")));
			if (settled) return;
			try {
				session
					.exec(SSH_METRICS_SCRIPT, (ch) => {
						channel = ch;
						ch.on("data", (data: Buffer) => {
							if (settled) return;
							output += data.toString("utf8");
							if (output.length > METRICS_SSH_OUTPUT_LIMIT) {
								finish(new Error("the metrics script output is too large"));
								try {
									ch.close();
								} catch {
									// Already closed by the remote side.
								}
							}
						});
						ch.stderr.resume();
						ch.on("exit", (code: number | null) => {
							exited = true;
							exitCode = code;
						});
						ch.on("close", () => {
							if (!exited) return finish(new Error("the metrics script ended without an exit status"));
							if (exitCode !== 0) {
								return finish(new Error(`the metrics script exited with ${exitCode ?? "a signal"}`));
							}
							finish();
						});
					})
					.catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
			} catch (err) {
				finish(err instanceof Error ? err : new Error(String(err)));
			}
			if (settled) closeChannel();
		});
	}

	#sleep(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.#abort.signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			timer.unref?.();
			const onAbort = (): void => {
				clearTimeout(timer);
				resolve();
			};
			this.#abort.signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/** Whether an SSH error is a dead transport rather than a refused channel. */
function isConnectionLostText(err: unknown): boolean {
	return err instanceof Error && /not connected|connection (?:lost|closed)/i.test(err.message);
}

/** Whether a node is sampled at all, and from which state (doc/design/metrics.md "Scope"). */
function shouldSample(node: MetricsNode, host: MetricsHost): boolean {
	if (node.transport === "ssh") return node.status === "active";
	if (node.status === "active") return true;
	// A pending node that is connected (a re-enrolled node awaiting approval) is sampled as up only.
	return node.status === "pending" && host.connected(node.id);
}

/** Resolves with `work` or after `ms`, whichever is first; a timeout is not an error. */
function raceTimeout(work: Promise<unknown>, ms: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		work.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}
