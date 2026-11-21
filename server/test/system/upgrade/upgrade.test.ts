/**
 * crha self-upgrade against real systemd (doc/design/distribution.md "crha self-upgrade"): a node set up
 * with `crha enroll` in a container whose PID 1 is systemd is upgraded from crhs, from crha 1.2.0 to the
 * 1.3.0 in crhs's release cache. Runs with CRH_TEST_PODMAN=1, like the rest of test/system.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type InProcessCrhs, waitFor } from "../../e2e/harness.ts";
import {
	ARCH,
	buildCrha,
	type Mode,
	type NodeOptions,
	podmanAvailable,
	stageRelease,
	startCrhs,
	UpgradeNode,
} from "./harness.ts";

const OLD = "1.2.0";
const NEW = "1.3.0";
const TEST_TIMEOUT = 8 * 60_000;

describe.skipIf(!podmanAvailable)("upgrade system: crha self-upgrade under systemd", () => {
	let tmp = "";
	let oldBin = "";
	let newBin = "";
	let neverReadyBin = "";
	const cleanup: (() => Promise<void>)[] = [];

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-upgrade-system-"));
		[oldBin, newBin, neverReadyBin] = await Promise.all([
			buildCrha(tmp, OLD),
			buildCrha(tmp, NEW),
			buildCrha(tmp, NEW, { neverReady: true }),
		]);
	}, 10 * 60_000);

	afterEach(async () => {
		for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
	});

	afterAll(async () => {
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	/** A crhs of NEW whose release cache holds `release` as NEW, and one node of OLD in `mode`. */
	const setup = async (
		mode: Mode,
		release = newBin,
		nodeOptions: NodeOptions = {},
	): Promise<{ crhs: InProcessCrhs; node: UpgradeNode }> => {
		const dataDir = await mkdtemp(join(tmp, "crhs-"));
		await stageRelease(dataDir, NEW, release);
		const crhs = await startCrhs(dataDir, NEW);
		cleanup.push(() => crhs.destroy());
		const node = await UpgradeNode.create(crhs, oldBin, mode, nodeOptions);
		cleanup.push(() => node.destroy());
		return { crhs, node };
	};

	/** Starts the upgrade of `node` from crhs and returns the started task groups. */
	const upgrade = async (crhs: InProcessCrhs, node: UpgradeNode) => {
		const res = await crhs.api("/api/nodes/upgrade", { body: { targets: [node.nodeId] } });
		expect(res.status, JSON.stringify(res.json)).toBe(201);
		expect(res.json.upgrades).toEqual([expect.objectContaining({ nodeId: node.nodeId, version: OLD, arch: ARCH })]);
		expect(res.json.taskGroups).toHaveLength(1);
		return res.json.taskGroups;
	};

	/** Waits until the upgrade log ends an upgrade with `step`: the node reconnects a little before the installer sees it ready. */
	const waitOutcome = (node: UpgradeNode, step: string) =>
		withDiagnostics(node, () =>
			waitFor(
				`upgrade outcome ${step}`,
				async () => (await node.upgradeLog()).some((entry) => entry.step === step),
				5 * 60_000,
				1_000,
			),
		);

	/** Fails with the node's upgrade log and journals, which say why an upgrade did not finish. */
	const withDiagnostics = async (node: UpgradeNode, fn: () => Promise<unknown>) => {
		try {
			await fn();
		} catch (err) {
			throw new Error(`${(err as Error).message}\n${await node.diagnostics()}`);
		}
	};

	it(
		"upgrades a forward node, and rolls it back by hand",
		async () => {
			const { crhs, node } = await setup("forward");
			// The first facts are sent before the privileged mode answers; crha reports again once it does.
			await withDiagnostics(node, () =>
				waitFor(
					"the forward node can self-upgrade",
					async () => (await node.node()).facts.selfUpgrade.available,
					60_000,
					500,
				),
			);
			const facts = (await node.node()).facts;
			expect(facts.selfUpgrade).toEqual({ available: true, reasons: [], arch: ARCH });
			expect(facts.upgradeLogPath).toBe("/var/lib/crha-upgrade/upgrade.jsonl");

			const plan = await crhs.api("/api/nodes/upgrade", { body: { targets: [node.nodeId], dryRun: true } });
			expect(plan.status).toBe(200);
			expect(plan.json).toMatchObject({ version: NEW, skipped: [], taskGroups: [] });

			await upgrade(crhs, node);
			await withDiagnostics(node, () => node.waitVersion(NEW, 4 * 60_000));
			await waitOutcome(node, "activated");
			const log = await node.upgradeLog();
			expect(log.at(-1)).toMatchObject({ step: "activated", from: OLD, to: NEW });
			expect(await node.unitVersion()).toBe(NEW);
			// The privileged mode runs the new binary too: crha's handshake with it requires equal versions.
			expect((await node.node()).facts.selfUpgrade.available).toBe(true);

			const status = await node.execOk(["/usr/local/bin/crha", "upgrade", "status"]);
			expect(status).toContain(`crha upgrade rollback returns to ${OLD}`);
			await node.execOk(["/usr/local/bin/crha", "upgrade", "rollback"]);
			await withDiagnostics(node, () => node.waitVersion(OLD, 2 * 60_000));
			expect(await node.unitVersion()).toBe(OLD);
			expect((await node.upgradeLog()).at(-1)).toMatchObject({ step: "rolled_back" });
			// The running version is now one no upgrade in the log produced: there is nothing more to undo.
			const again = await node.exec(["/usr/local/bin/crha", "upgrade", "rollback"]);
			expect(again.code).not.toBe(0);
			expect(again.stderr).toContain(`produced crha ${OLD}`);
		},
		TEST_TIMEOUT,
	);

	it(
		"upgrades a native node",
		async () => {
			const { crhs, node } = await setup("native");
			await withDiagnostics(node, () =>
				waitFor(
					"the native node can self-upgrade",
					async () => (await node.node()).facts.selfUpgrade.available,
					60_000,
					500,
				),
			);
			await upgrade(crhs, node);
			await withDiagnostics(node, () => node.waitVersion(NEW, 4 * 60_000));
			await waitOutcome(node, "activated");
			expect((await node.upgradeLog()).at(-1)).toMatchObject({ step: "activated", to: NEW });
		},
		TEST_TIMEOUT,
	);

	it(
		"rolls back by itself when the new version never reports ready",
		async () => {
			const { crhs, node } = await setup("forward", neverReadyBin);
			await withDiagnostics(node, () =>
				waitFor(
					"the forward node can self-upgrade",
					async () => (await node.node()).facts.selfUpgrade.available,
					60_000,
					500,
				),
			);
			await upgrade(crhs, node);
			await waitOutcome(node, "rolled_back");
			await withDiagnostics(node, () => node.waitVersion(OLD, 2 * 60_000));
			expect(await node.unitVersion()).toBe(OLD);
			const log = await node.upgradeLog();
			expect(log.some((entry) => entry.step === "activated")).toBe(false);
			expect(log.find((entry) => entry.step === "ready")?.msg).toContain("did not report ready");
		},
		TEST_TIMEOUT,
	);

	it(
		"upgrades an ignore node whose crha runs as root through a drop-in, and keeps the drop-in",
		async () => {
			const { crhs, node } = await setup("ignore", newBin, { asRoot: true });
			expect(await node.serviceUser()).toBe("root");
			await withDiagnostics(node, () =>
				waitFor(
					"the ignore node can self-upgrade",
					async () => (await node.node()).facts.selfUpgrade.available,
					60_000,
					500,
				),
			);
			await upgrade(crhs, node);
			await withDiagnostics(node, () => node.waitVersion(NEW, 4 * 60_000));
			await waitOutcome(node, "activated");
			// The upgrade rewrote crha.service, not the administrator's drop-in.
			expect(await node.serviceUser()).toBe("root");
			expect(await node.unitVersion()).toBe(NEW);
		},
		TEST_TIMEOUT,
	);

	it(
		"skips an ignore node that runs as the crha user, as enroll sets it up",
		async () => {
			const { crhs, node } = await setup("ignore");
			const facts = (await node.node()).facts;
			expect(facts.selfUpgrade.available).toBe(false);
			expect(facts.selfUpgrade.reasons).toContain("no_privilege");
			const res = await crhs.api("/api/nodes/upgrade", { body: { targets: [node.nodeId] } });
			expect(res.status).toBe(200);
			expect(res.json.upgrades).toEqual([]);
			expect(res.json.skipped).toEqual([
				expect.objectContaining({
					nodeId: node.nodeId,
					reason: "self_upgrade_unavailable",
					nodeReasons: ["no_privilege"],
				}),
			]);
		},
		TEST_TIMEOUT,
	);
});
