/**
 * The cosignature rules of doc/privilege.md#联署, shared by the planner (which predicts whether a path
 * would be accepted) and the decision port (which applies the node's answer). Both read a trust
 * entry's role and kinds, whatever shape the caller holds it in: protocol's TrustEntry or the
 * decision's own AuthzEntry.
 */
import type { TrustEntry } from "@crh/protocol";

/** The part of a trust entry the cosignature rules look at. */
export interface CosignTrust {
	role: TrustEntry["role"];
	kinds: readonly TrustEntry["kinds"][number][];
}

/** Whether the entry is a user entry whose authorizations must carry a crhs cosignature. */
export function cosignRequired(entry: CosignTrust): boolean {
	return entry.role === "user" && entry.kinds.includes("require-cosign");
}

/**
 * Whether one of the entries offers the cosign kind. The planner passes the summary's own crhs
 * entries; the decision port passes the entries whose signatures verified on the payload. The cosign
 * entry's own require_exact, max_ttl and allow/deny rules do not apply (doc/privilege.md#联署).
 */
export function hasCosign(entries: Iterable<CosignTrust | null | undefined>): boolean {
	for (const entry of entries) {
		if (entry?.role === "crhs" && entry.kinds.includes("cosign")) return true;
	}
	return false;
}
