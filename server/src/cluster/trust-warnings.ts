/**
 * The out-of-sync warnings of a node's trust aliases (doc/privilege.md#信任缓存, D110): crhs shows
 * where a node trusts a node group it is not in, trusts something that is not a node group or its own
 * id, misses a group it is in (only `forward` nodes act on aliases), or trusts a key crhs does not
 * know. Warnings are computed from the cached TrustReport and crhs-managed node group membership;
 * they explain why a group-addressed reusable authorization may not reach the node.
 */
import type { TrustEntry, TrustSummary } from "@crh/protocol";
import { isOwnCrhsEntry, type OwnerCredentials, ownerCredentialOf } from "../privilege/planner.ts";
import type { Db } from "../storage/db.ts";
import type { NodeGroupRef } from "./node-groups.ts";
import type { NodeRow } from "./nodes.ts";
import { parseTrustReport } from "./trust.ts";

export type TrustWarningKind = "alias_superfluous" | "alias_unknown" | "alias_missing" | "trust_unknown";
export type TrustWarningSeverity = "danger" | "warning" | "info";

/** One out-of-sync line of a node's trust configuration. */
export interface TrustWarning {
	kind: TrustWarningKind;
	severity: TrustWarningSeverity;
	/** The alias or node group UUID the warning is about; null for a trust entry. */
	uuid: string | null;
	/** The node group the UUID names, when it is one. */
	nodeGroupName: string | null;
	/** The trust entry name, for `trust_unknown`. */
	trustName: string | null;
	message: string;
}

/** What the warnings need beyond the node's cached report: the node groups and the keys crhs knows. */
export interface TrustWarningContext {
	/** Fingerprint of crhs's current authorization signing key; undefined means it has none. */
	crhsFingerprint?: string;
	/** Every node group, id → name. */
	nodeGroups: ReadonlyMap<string, string>;
	/** The OpenSSH fingerprints of every registered user credential. */
	sshFingerprints: ReadonlySet<string>;
	/** The base64url credential ids of every registered Passkey. */
	webauthnCredentialIds: ReadonlySet<string>;
}

/** Loads the context shared by all warnings of one listing; once per listing, never per node. */
export async function trustWarningContext(db: Db, crhsFingerprint?: string): Promise<TrustWarningContext> {
	const [groups, credentials] = await Promise.all([
		db.selectFrom("node_groups").select(["id", "name"]).execute(),
		db.selectFrom("user_credentials").select(["kind", "fingerprint", "credential_id"]).execute(),
	]);
	return {
		crhsFingerprint,
		nodeGroups: new Map(groups.map((group) => [group.id, group.name])),
		sshFingerprints: new Set(
			credentials.flatMap((row) => (row.kind === "ssh" && row.fingerprint ? [row.fingerprint] : [])),
		),
		webauthnCredentialIds: new Set(
			credentials.flatMap((row) => (row.kind === "webauthn" && row.credential_id ? [row.credential_id] : [])),
		),
	};
}

/** A trust entry whose key crhs knows: its own signing key or a registered user credential. Local entries are never unknown. */
function trustEntryKnown(entry: TrustEntry, context: TrustWarningContext): boolean {
	if (entry.role === "local" || entry.key.kind === "local") return true;
	const credentials: OwnerCredentials = {
		sshKeyFingerprints: [...context.sshFingerprints],
		webauthnCredentialIds: [...context.webauthnCredentialIds],
	};
	if (entry.role === "crhs") {
		return context.crhsFingerprint !== undefined && isOwnCrhsEntry(entry, context.crhsFingerprint);
	}
	return ownerCredentialOf(entry, credentials) !== null;
}

export interface NodeTrustWarningInput {
	nodeId: string;
	privilegedMode: string | null;
	/** The cached summary, or null when the node has no valid `ok` report. */
	summary: TrustSummary | null;
	/** The node groups the node is a member of. */
	memberships: readonly NodeGroupRef[];
	context: TrustWarningContext;
}

/** The out-of-sync warnings of one node (doc/privilege.md#信任缓存). */
export function trustWarningsForNode(input: NodeTrustWarningInput): TrustWarning[] {
	const { summary } = input;
	if (summary === null) return [];
	const warnings: TrustWarning[] = [];
	const aliasSet = new Set(summary.aliases);
	const memberIds = new Set(input.memberships.map((group) => group.id));
	for (const alias of summary.aliases) {
		if (alias === input.nodeId) continue;
		const groupName = input.context.nodeGroups.get(alias);
		if (groupName === undefined) {
			warnings.push({
				kind: "alias_unknown",
				severity: "warning",
				uuid: alias,
				nodeGroupName: null,
				trustName: null,
				message: `"${alias}" in aliases is neither a node group UUID nor this node's id; remove "${alias}" from aliases in privileged.toml on the node`,
			});
			continue;
		}
		if (!memberIds.has(alias)) {
			warnings.push({
				kind: "alias_superfluous",
				severity: "danger",
				uuid: alias,
				nodeGroupName: groupName,
				trustName: null,
				message: `the node trusts node group ${groupName} (${alias}) although it is not a member; remove "${alias}" from aliases in privileged.toml on the node`,
			});
		}
	}
	// A surplus alias matters on any forward node, but a missing one only describes a forwarding node.
	if (input.privilegedMode === "forward") {
		for (const group of input.memberships) {
			if (aliasSet.has(group.id)) continue;
			warnings.push({
				kind: "alias_missing",
				severity: "info",
				uuid: group.id,
				nodeGroupName: group.name,
				trustName: null,
				message: `the node is in node group ${group.name} (${group.id}) but does not trust it as an alias; add "${group.id}" to aliases in privileged.toml on the node`,
			});
		}
	}
	for (const entry of summary.trust) {
		if (trustEntryKnown(entry, input.context)) continue;
		warnings.push({
			kind: "trust_unknown",
			severity: "warning",
			uuid: null,
			nodeGroupName: null,
			trustName: entry.name,
			message: `trust entry "${entry.name}" is neither crhs's current signing key nor a registered user credential`,
		});
	}
	return warnings;
}

/** The warnings of a batch of nodes, with the shared context loaded once (no per-node queries). */
export async function trustWarningsForRows(
	db: Db,
	rows: readonly NodeRow[],
	memberships: ReadonlyMap<string, readonly NodeGroupRef[]>,
	options: { crhsFingerprint?: string } = {},
): Promise<Map<string, TrustWarning[]>> {
	const context = await trustWarningContext(db, options.crhsFingerprint);
	const out = new Map<string, TrustWarning[]>();
	for (const row of rows) {
		const report = parseTrustReport(row.trust_report);
		out.set(
			row.id,
			trustWarningsForNode({
				nodeId: row.id,
				privilegedMode: row.privileged_mode,
				summary: report?.kind === "ok" ? report.summary : null,
				memberships: memberships.get(row.id) ?? [],
				context,
			}),
		);
	}
	return out;
}
