/**
 * crhs's cosign tickets (doc/design/privilege.md "Cosigning", doc/design/protocol.md "Cosign ticket"): when a user
 * entry requires crhs's cosignature, every use of the user's authorization carries a ticket that confirms that
 * use (the task, its attempt and its node) for that authorization. The authorization itself is never changed.
 */
import { createHash } from "node:crypto";
import {
	type CosignTicket,
	type CosignUse,
	cosignTicketCodec,
	encode as encodeCbor,
	encodeCosignPayload,
	MAX_FRAME_BYTES,
	type Signature,
} from "@crh/protocol";
import { cosignPayloadFor } from "../../privilege/planner.ts";
import type { ClusterCore } from "../core.ts";

/** One claimed use the ticket confirms, with the crhs key its node trusts to cosign. */
export interface TicketUse extends CosignUse {
	keyFingerprint: string;
}

/**
 * Signs the tickets for the claimed uses of one authorization and returns each task's encoded ticket. One ticket
 * confirms every use sent together; when it would not fit beside the authorization in half a frame
 * (doc/design/protocol.md "task.start"), each node gets a ticket with its own uses instead. A use whose key was
 * deleted since the plan gets no ticket: its node refuses the task and the retry plans it again. Each ticket is
 * audited once.
 */
export function signCosignTickets(
	core: ClusterCore,
	authorization: { id: string; payloadBytes: Uint8Array; encodedBytes: number },
	uses: readonly TicketUse[],
	onBehalfOfUserId: string,
): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	const usable = uses.filter((use) => core.signingKeys.byFingerprint(use.keyFingerprint) !== undefined);
	if (usable.length === 0) return out;
	const issue = (batch: readonly TicketUse[]): Uint8Array => {
		const payload = encodeCosignPayload(
			cosignPayloadFor(
				authorization.payloadBytes,
				batch.map(({ node, taskId, attempt }) => ({ node, taskId, attempt })),
				Date.now(),
			),
		);
		const fingerprints = [...new Set(batch.map((use) => use.keyFingerprint))];
		const signatures: Signature[] = [];
		for (const fingerprint of fingerprints) {
			const key = core.signingKeys.byFingerprint(fingerprint);
			if (key) signatures.push({ kind: "sshsig", blob: key.signCosign(payload) });
		}
		const ticket: CosignTicket = { payload, signatures };
		const encoded = encodeCbor(cosignTicketCodec.encode(ticket));
		core.auditLater({
			actor: { type: "system", id: "cluster", onBehalfOfUserId },
			action: "authorization.cosigned",
			target: { type: "authorization", id: authorization.id },
			detail: {
				ticket_id: createHash("sha256").update(payload).digest("hex"),
				uses: batch.map((use) => ({ node_id: use.node, task_id: use.taskId, attempt: use.attempt })),
				keys: fingerprints,
			},
		});
		return encoded;
	};
	const fits = (encoded: Uint8Array) => authorization.encodedBytes + encoded.length <= MAX_FRAME_BYTES / 2;
	const shared = issueIfFits(usable, issue, fits);
	if (shared) {
		for (const use of usable) out.set(use.taskId, shared);
		return out;
	}
	const byNode = new Map<string, TicketUse[]>();
	for (const use of usable) byNode.set(use.node, [...(byNode.get(use.node) ?? []), use]);
	for (const batch of byNode.values()) {
		const ticket = issue(batch);
		for (const use of batch) out.set(use.taskId, ticket);
	}
	return out;
}

/**
 * The shared ticket of every use, when it fits beside the authorization. The size is measured on an unsigned
 * draft with one signature's worth of room per key, so a ticket that would not fit is never signed or audited.
 */
function issueIfFits(
	uses: readonly TicketUse[],
	issue: (batch: readonly TicketUse[]) => Uint8Array,
	fits: (encoded: Uint8Array) => boolean,
): Uint8Array | null {
	if (uses.length === 1) return issue(uses);
	const keys = new Set(uses.map((use) => use.keyFingerprint)).size;
	const draft = encodeCbor(
		cosignTicketCodec.encode({
			payload: encodeCosignPayload({
				v: 1,
				authorizationId: new Uint8Array(32),
				uses: uses.map(({ node, taskId, attempt }) => ({ node, taskId, attempt })),
				issuedAtMs: Number.MAX_SAFE_INTEGER - 1,
				deadlineMs: Number.MAX_SAFE_INTEGER,
			}),
			// An ed25519 SSHSIG blob is under 300 bytes.
			signatures: Array.from({ length: keys }, () => ({ kind: "sshsig" as const, blob: new Uint8Array(300) })),
		}),
	);
	return fits(draft) ? issue(uses) : null;
}
