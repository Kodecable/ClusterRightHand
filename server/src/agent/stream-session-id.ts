import { createHash } from "node:crypto";

/**
 * The provider-facing session ids of a crh session's request streams (doc/design/agent-runtime.md "Custom
 * providers"). The main conversation keeps durable's provider session id; compaction, Auto Review and title
 * generation are separate streams with different prefixes, so each derives its own deterministic id instead
 * of sharing the conversation's cache identity.
 */

/** The purposes that get their own provider session id. */
export type SessionStreamPurpose = "review" | "title" | "compaction";

/** The fixed namespace of crhs's derived ids (RFC 9562 UUIDv5). */
const NAMESPACE = "6f1d3f0c-5b7a-4c2e-9f68-0a1b2c3d4e5f";

/**
 * A deterministic UUIDv5 from the namespace and `name`. `newId()` is a v7 id, so a derived id never equals a
 * crh session id, and the purpose in the name keeps the streams apart.
 */
function uuidV5(name: string): string {
	const namespace = Buffer.from(NAMESPACE.replaceAll("-", ""), "hex");
	const bytes = Buffer.from(createHash("sha1").update(namespace).update(`crhs:${name}`).digest().subarray(0, 16));
	bytes[6] = 0x50 | ((bytes[6] ?? 0) & 0x0f);
	bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The provider session id of one stream of a crh session or conversation. Stable across calls and restarts,
 * and pairwise different for `review`, `title` and `compaction`.
 */
export function streamSessionId(seed: string, purpose: SessionStreamPurpose): string {
	return uuidV5(`${purpose}:${seed}`);
}
