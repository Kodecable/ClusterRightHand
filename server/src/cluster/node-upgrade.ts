/**
 * Upgrading crha nodes to crhs's own version (doc/design/distribution.md "crha self-upgrade"): which of the
 * requested nodes can be upgraded and why the others are skipped, then one privileged `node.upgrade` task
 * group per architecture, its binary staged from the verified release. Several nodes of one architecture
 * share one spec, so one signature covers the group.
 */
import type { NodeUpgradeSkipReason } from "@crh/api";
import { factsFromJson, type JsonFacts, type TaskSpec } from "@crh/protocol";
import type { Db } from "../storage/db.ts";
import type { CrhaReleases } from "./crha-release.ts";
import { isReleaseArch, isReleaseVersion } from "./crha-release.ts";
import type { NodeRow } from "./nodes.ts";
import { TERMINAL } from "./types.ts";

/** Why a node is skipped: the API's list, so the two cannot drift apart. */
export type UpgradeSkipReason = NodeUpgradeSkipReason;

export interface UpgradeSkip {
	nodeId: string;
	name: string;
	reason: UpgradeSkipReason;
	/** The node's own reasons, for self_upgrade_unavailable. */
	nodeReasons: string[];
	version: string | null;
}

export interface UpgradeCandidate {
	nodeId: string;
	name: string;
	version: string;
	arch: string;
	/** Tasks running on the node now, which the restart ends. */
	runningTasks: number;
}

export interface UpgradePlan {
	version: string;
	/** The nodes to upgrade, by architecture. */
	byArch: Map<string, UpgradeCandidate[]>;
	skipped: UpgradeSkip[];
}

interface SemVer {
	core: [number, number, number];
	pre: string[];
}

function parseSemVer(version: string): SemVer | undefined {
	if (!isReleaseVersion(version)) return undefined;
	const [main = "", ...rest] = version.split("-");
	const [a = 0, b = 0, c = 0] = main.split(".").map(Number);
	const pre = rest.join("-");
	return { core: [a, b, c], pre: pre === "" ? [] : pre.split(".") };
}

/**
 * SemVer precedence of two release versions: negative when `a` is older. A prerelease sorts before its
 * release; prerelease identifiers compare numerically when both are numbers, otherwise as text.
 */
export function compareVersions(a: string, b: string): number {
	const x = parseSemVer(a);
	const y = parseSemVer(b);
	if (!x || !y) throw new Error(`not release versions: ${a}, ${b}`);
	for (let i = 0; i < 3; i++) {
		const diff = (x.core[i] as number) - (y.core[i] as number);
		if (diff !== 0) return diff;
	}
	if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i] as string;
		const q = y.pre[i] as string;
		if (p === q) continue;
		const pn = /^[0-9]+$/.test(p);
		const qn = /^[0-9]+$/.test(q);
		if (pn && qn) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return x.pre.length - y.pre.length;
}

function factsOf(row: NodeRow): JsonFacts {
	try {
		return row.facts === null ? {} : factsFromJson(JSON.parse(row.facts));
	} catch {
		return {};
	}
}

/**
 * Whether a crha node runs a release older than crhs's own release (doc/design/distribution.md
 * "Versions"): only two releases compare, so a development build, a version crha could not report, and
 * an SSH node (which has no crha) never show the notice. It is a generic "update available" remark, not
 * a plan: the upgrade itself still goes through {@link planUpgrade}.
 */
export function crhaUpdateAvailable(
	transport: "client" | "ssh",
	clientVersion: string | null,
	crhsVersion: string,
): boolean {
	if (transport !== "client" || clientVersion === null) return false;
	if (!isReleaseVersion(clientVersion) || !isReleaseVersion(crhsVersion)) return false;
	return compareVersions(clientVersion, crhsVersion) < 0;
}

/** Sorts the requested nodes into upgrade candidates by architecture and skipped nodes with a reason. */
export async function planUpgrade(
	db: Db,
	nodes: readonly NodeRow[],
	version: string,
	isConnected: (nodeId: string) => boolean,
): Promise<UpgradePlan> {
	const byArch = new Map<string, UpgradeCandidate[]>();
	const skipped: UpgradeSkip[] = [];
	const ids = nodes.map((node) => node.id);
	const running = await runningTaskCounts(db, ids);
	const upgrading = await nodesUpgrading(db, ids);
	for (const node of nodes) {
		const facts = factsOf(node);
		const nodeVersion = node.client_version;
		const skip = (reason: UpgradeSkipReason, nodeReasons: string[] = []) =>
			skipped.push({ nodeId: node.id, name: node.name, reason, nodeReasons, version: nodeVersion });
		if (node.transport !== "client") {
			skip("not_crha");
			continue;
		}
		if (!isConnected(node.id)) {
			skip("not_connected");
			continue;
		}
		const self = facts.selfUpgrade;
		if (!self?.available) {
			skip("self_upgrade_unavailable", self?.reasons ?? []);
			continue;
		}
		if (self.arch === undefined) {
			skip("no_arch");
			continue;
		}
		if (!isReleaseArch(self.arch)) {
			skip("unsupported_arch");
			continue;
		}
		if (nodeVersion === null || !isReleaseVersion(nodeVersion)) {
			skip("not_a_release_version");
			continue;
		}
		const order = compareVersions(nodeVersion, version);
		if (order === 0) {
			skip("up_to_date");
			continue;
		}
		// There is no downgrade: configuration migrations only go forward.
		if (order > 0) {
			skip("newer_than_crhs");
			continue;
		}
		// One upgrade at a time: a second would wait behind the first and then find nothing to do.
		if (upgrading.has(node.id)) {
			skip("upgrade_in_progress");
			continue;
		}
		const list = byArch.get(self.arch) ?? [];
		list.push({
			nodeId: node.id,
			name: node.name,
			version: nodeVersion,
			arch: self.arch,
			runningTasks: running.get(node.id) ?? 0,
		});
		byArch.set(self.arch, list);
	}
	return { version, byArch, skipped };
}

/** The nodes with an upgrade task that has not ended, whatever it waits for. */
async function nodesUpgrading(db: Db, nodeIds: readonly string[]): Promise<Set<string>> {
	if (nodeIds.length === 0) return new Set();
	const rows = await db
		.selectFrom("tasks")
		.select("node_id")
		.distinct()
		.where("node_id", "in", [...nodeIds])
		.where("kind", "=", "node.upgrade")
		.where("state", "not in", [...TERMINAL])
		.execute();
	return new Set(rows.map((row) => row.node_id));
}

async function runningTaskCounts(db: Db, nodeIds: readonly string[]): Promise<Map<string, number>> {
	if (nodeIds.length === 0) return new Map();
	const rows = await db
		.selectFrom("tasks")
		.select(["node_id"])
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.where("node_id", "in", [...nodeIds])
		.where("state", "in", ["dispatched", "running"])
		.groupBy("node_id")
		.execute();
	return new Map(rows.map((row) => [row.node_id, Number(row.count)]));
}

/** The spec of an upgrade group: the binary's size and hash; each member gets its own transfer id. */
export function upgradeSpec(release: {
	version: string;
	arch: string;
	bytes: Uint8Array;
	sha256: Uint8Array;
}): TaskSpec {
	return {
		kind: "node.upgrade",
		version: release.version,
		arch: release.arch,
		size: release.bytes.length,
		sha256: release.sha256,
		endpoint: { kind: "crhs", transferId: "" },
	};
}

export type { CrhaReleases };
