/**
 * The authorization plan of a privileged task (doc/design/privilege.md "Authorization path").
 *
 * crhs computes from its cached TrustSummary which path can authorize a task, in preference order:
 * its own crhs signing key (`crhs`), the owner's user credentials (`user`), or a local approval on
 * the node (`local`, single tasks only). The matching is the same decision crha makes, run with
 * a hypothetical valid signature (`decide`), so crhs cannot pick a path the node would reject.
 * A plan is only a prediction: crha re-verifies everything before executing.
 */
import type { AuthorizationPath } from "@crh/api";
import type { TaskSpec, TrustEntry, TrustSummary } from "@crh/protocol";
import { type AuthzEntry, type AuthzSignature, authzEntryFromTrust, decide } from "./authz.ts";
import { cosignRequired, hasCosign } from "./cosign.ts";
import { privilegedTarget } from "./guard.ts";
import { type BuiltAuthorization, buildAuthorization, specSha256 } from "./payload.ts";

/** A crhs-signed one-shot authorization is valid for at most this long. */
export const CRHS_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
/**
 * Default lifetime of a user's one-shot authorization. A human may take a while to sign, so this is
 * longer than the crhs default; the trust entry's max_ttl still caps it.
 */
export const USER_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

export type { AuthorizationPath };

/** The owner's registered signing credentials (doc/design/privilege.md "Server-side authorization" `signing_credentials`). */
export interface OwnerSigningCredentials {
	/** OpenSSH `SHA256:…` fingerprints of the owner's SSH keys. */
	sshKeyFingerprints: readonly string[];
	/** base64url credential ids of the owner's WebAuthn credentials. */
	webauthnCredentialIds: readonly string[];
}

export interface PlannerInput {
	/** The cached TrustSummary; null when the node has not reported one or reported it unavailable. */
	summary: TrustSummary | null;
	/** Why `summary` is null, e.g. a TrustReport `unavailable` message; used in the "none" reason. */
	summaryUnavailable?: string;
	nodeId: string;
	/** The trust aliases the node reported (payload nodes may address one of them). */
	aliases: readonly string[];
	task: { id: string; attempt: number; spec: TaskSpec; privileged: boolean };
	/** Tasks of a task group never use local approval. */
	taskGroup: boolean;
	owner: OwnerSigningCredentials;
	/**
	 * The fingerprints of crhs's own authorization signing keys, newest first. When given, only crhs
	 * trust entries with one of these keys can sign or cosign, and the newest key the node trusts with
	 * the needed kind is used; a node may trust several crhs keys (e.g. during rotation). Undefined
	 * means the caller did not resolve the keys, so any crhs entry is considered.
	 */
	crhsFingerprints?: readonly string[];
	/** Paths already tried for this task; a crha rejection of the crhs path is not retried. */
	tried?: readonly AuthorizationPath[];
	/** `issued_at_ms` of generated payloads; defaults to now. */
	now?: number;
	/** The signed human-readable payload note; defaults to "". */
	note?: string;
}

export interface PlannedCrhsPath {
	path: "crhs";
	entry: TrustEntry;
	/** The fingerprint of the newest key this node trusts with `execute`; claimCrhs signs with it. */
	keyFingerprint: string;
	authorization: BuiltAuthorization;
}

export interface PlannedUserEntry {
	entry: TrustEntry;
	/** Which of the owner's registered credentials matches the trust entry. */
	credential: { kind: "sshsig"; fingerprint: string } | { kind: "webauthn"; credentialId: string };
	/** The entry's kinds include `require-cosign`, so a crhs cosignature must be added. */
	cosignRequired: boolean;
	/** The node has a crhs trust entry with the `cosign` kind. */
	cosignAvailable: boolean;
	/** The entry demands UV; only WebAuthn or an sk-* SSH key can provide it. */
	requireUv: boolean;
	canAssertUv: boolean;
}

export interface PlannedUserPath {
	path: "user";
	/** The owner's entries that would accept one-shot exact payloads for this task. */
	entries: PlannedUserEntry[];
	/** Whether this task belongs to a task group; local approval does not apply then. */
	taskGroup: boolean;
	/**
	 * A one-shot exact payload for this task. A task group signs one shared payload for all nodes
	 * and tasks instead (buildTaskGroupAuthorization), so this payload is not used there.
	 */
	authorization: BuiltAuthorization;
	/**
	 * How long that payload is valid: the smaller of the 24 h default and the strictest accepting
	 * entry's max_ttl. A task group's shared payload uses the strictest ttl of its tasks.
	 */
	ttlMs: number;
}

export interface PlannedLocalPath {
	path: "local";
	entry: TrustEntry;
}

export type PlannedPath = PlannedCrhsPath | PlannedUserPath | PlannedLocalPath;

export interface AuthorizationPlan {
	/** Available paths in preference order: crhs, user, local. Empty when nothing applies. */
	paths: PlannedPath[];
	/** Set exactly when `paths` is empty: a human-readable reason, including "no one on this node…". */
	reason?: string;
}

const NOBODY = "no one on this node can authorize this command";

/** The payload TTL an entry allows: the smaller of its max_ttl and the default for the path. */
function payloadTtl(entry: TrustEntry, fallback: number): number {
	return Math.min(entry.maxTtlMs ?? fallback, fallback);
}

export function ownerSigningCredentialOf(
	entry: TrustEntry,
	owner: OwnerSigningCredentials,
): PlannedUserEntry["credential"] | null {
	if (entry.key.kind === "sshsig") {
		return owner.sshKeyFingerprints.includes(entry.key.fingerprint)
			? { kind: "sshsig", fingerprint: entry.key.fingerprint }
			: null;
	}
	if (entry.key.kind === "webauthn") {
		const credentialId = Buffer.from(entry.key.credentialId).toString("base64url");
		return owner.webauthnCredentialIds.includes(credentialId) ? { kind: "webauthn", credentialId } : null;
	}
	return null;
}

/** Whether the entry's key type can assert UV at all; plain ssh-ed25519 and ecdsa keys cannot. */
function canAssertUv(entry: TrustEntry): boolean {
	if (entry.key.kind === "webauthn") return true;
	return entry.key.kind === "sshsig" && entry.key.publicKey.startsWith("sk-");
}

/** Whether a crhs trust entry is one of crhs's own keys (when the fingerprints are known). */
export function isOwnCrhsEntry(entry: TrustEntry, crhsFingerprints: readonly string[] | undefined): boolean {
	if (entry.role !== "crhs") return false;
	if (crhsFingerprints === undefined) return true;
	return entry.key.kind === "sshsig" && crhsFingerprints.includes(entry.key.fingerprint);
}

/** The summary's own crhs entries: the only ones whose cosignature this crhs can attach. */
function ownCrhsEntries(summary: TrustSummary, crhsFingerprints: readonly string[] | undefined): TrustEntry[] {
	return summary.trust.filter((entry) => isOwnCrhsEntry(entry, crhsFingerprints));
}

/**
 * The trust entry of the newest own key that can cosign. The fingerprints are newest first, so the
 * planner previews the same key `cosignature()` signs with (doc/design/privilege.md "Authorization signing key").
 */
function firstCosignEntry(
	summary: TrustSummary,
	crhsFingerprints: readonly string[] | undefined,
): AuthzEntry | undefined {
	if (crhsFingerprints === undefined) {
		const entry = ownCrhsEntries(summary, undefined).find((candidate) => candidate.kinds.includes("cosign"));
		return entry ? authzEntryFromTrust(entry) : undefined;
	}
	for (const fingerprint of crhsFingerprints) {
		const entry = summary.trust.find(
			(candidate) =>
				candidate.role === "crhs" &&
				candidate.key.kind === "sshsig" &&
				candidate.key.fingerprint === fingerprint &&
				candidate.kinds.includes("cosign"),
		);
		if (entry) return authzEntryFromTrust(entry);
	}
	return undefined;
}

/**
 * crha maps a signature to the first trust entry with its key (doc/design/privilege.md "Trust configuration"), so later
 * entries repeating a key never take part in a decision there; dropping them here keeps the preview
 * from planning a path crha would refuse. Local entries are matched by uid and all take part.
 */
function firstEntryPerKey(trust: readonly TrustEntry[]): TrustEntry[] {
	const seen = new Set<string>();
	return trust.filter((entry) => {
		let key: string;
		if (entry.key.kind === "sshsig") key = `sshsig:${entry.key.fingerprint}`;
		else if (entry.key.kind === "webauthn")
			key = `webauthn:${Buffer.from(entry.key.credentialId).toString("base64url")}`;
		else return true;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Runs the real decision with hypothetical signatures to see whether one entry would be accepted. */
function entryAccepts(
	summary: TrustSummary,
	entries: readonly AuthzEntry[],
	input: PlannerInput,
	task: PlannerInput["task"],
	authorization: BuiltAuthorization,
	entryName: string,
	signatures: readonly AuthzSignature[],
	now: number,
): boolean {
	const decision = decide({
		now,
		clockSkewMs: summary.clockSkewMs,
		nodeId: input.nodeId,
		aliases: input.aliases,
		trust: entries,
		task: { id: task.id, attempt: task.attempt, spec: task.spec },
		authorization: { payload: authorization.bytes, decoded: authorization.payload, signatures },
		localApproval: null,
	});
	return decision.result === "accepted" && decision.entry === entryName;
}

/** Plans the authorization paths for one task; see the module comment. */
export function planAuthorization(input: PlannerInput): AuthorizationPlan {
	if (!input.task.privileged) {
		return { paths: [], reason: "the task is not privileged and needs no authorization" };
	}
	if (input.summary === null) {
		const detail = input.summaryUnavailable ?? "the node has not reported a usable trust summary";
		return { paths: [], reason: `${NOBODY}: ${detail}` };
	}
	const summary = { ...input.summary, trust: firstEntryPerKey(input.summary.trust) };
	let method: "exec" | "file.read" | "file.write";
	let target: string;
	try {
		({ method, target } = privilegedTarget(input.task.spec));
	} catch (err) {
		return { paths: [], reason: `${NOBODY}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const now = input.now ?? Date.now();
	const note = input.note ?? "";
	const specHash = specSha256(input.task.spec);
	const authzEntries = summary.trust.map(authzEntryFromTrust);
	const entriesByName = new Map(authzEntries.map((entry) => [entry.name, entry]));
	const tried = new Set(input.tried ?? []);
	const paths: PlannedPath[] = [];
	const notes: string[] = [];

	if (tried.has("crhs")) notes.push("the crhs authorization path was already rejected");

	if (!tried.has("crhs")) {
		// Newest key first: the node's trust report decides which of crhs's keys it accepts
		// (doc/design/privilege.md "Authorization signing key"). Without a resolved key set, keep the summary's order.
		const candidates: { entry: TrustEntry; keyFingerprint: string }[] = [];
		if (input.crhsFingerprints === undefined) {
			for (const entry of summary.trust) {
				if (isOwnCrhsEntry(entry, undefined) && entry.key.kind === "sshsig") {
					candidates.push({ entry, keyFingerprint: entry.key.fingerprint });
				}
			}
		} else {
			for (const fingerprint of input.crhsFingerprints) {
				const entry = summary.trust.find(
					(candidate) => candidate.key.kind === "sshsig" && candidate.key.fingerprint === fingerprint,
				);
				if (entry?.role === "crhs") candidates.push({ entry, keyFingerprint: fingerprint });
			}
		}
		for (const { entry, keyFingerprint } of candidates) {
			if (!entry.kinds.includes("execute")) continue;
			const ttl = payloadTtl(entry, CRHS_AUTHORIZATION_TTL_MS);
			const authorization = buildAuthorization({
				nodes: [input.nodeId],
				command: { method, exact: { target, specSha256: specHash } },
				issuedAtMs: now,
				deadlineMs: now + ttl,
				taskIds: [input.task.id],
				attempt: input.task.attempt,
				note,
			});
			const authzEntry = entriesByName.get(entry.name);
			if (!authzEntry) continue;
			const signature: AuthzSignature = {
				entry: authzEntry,
				valid: true,
				// A crhs signature is an SSHSIG with no UV flag.
				userVerified: false,
			};
			if (entryAccepts(summary, authzEntries, input, input.task, authorization, entry.name, [signature], now)) {
				paths.push({ path: "crhs", entry, keyFingerprint, authorization });
				break;
			}
		}
	}

	if (tried.has("user")) notes.push("the user authorization path was already tried");
	if (!tried.has("user")) {
		const acceptable: { planned: PlannedUserEntry; ttl: number }[] = [];
		for (const entry of summary.trust) {
			if (entry.role !== "user" || !entry.kinds.includes("execute")) continue;
			const credential = ownerSigningCredentialOf(entry, input.owner);
			if (!credential) continue;
			const entryKey = entriesByName.get(entry.name);
			if (!entryKey) continue;
			const ttl = payloadTtl(entry, USER_AUTHORIZATION_TTL_MS);
			const authorization = buildAuthorization({
				nodes: [input.nodeId],
				command: { method, exact: { target, specSha256: specHash } },
				issuedAtMs: now,
				deadlineMs: now + ttl,
				taskIds: [input.task.id],
				attempt: input.task.attempt,
				note,
			});
			const canUv = canAssertUv(entry);
			const needsCosign = cosignRequired(entry);
			const available = needsCosign && hasCosign(ownCrhsEntries(summary, input.crhsFingerprints));
			const signatures: AuthzSignature[] = [
				{ entry: entryKey, valid: true, userVerified: entry.requireUv ? canUv : false },
			];
			if (available) {
				const cosign = firstCosignEntry(summary, input.crhsFingerprints);
				if (cosign) signatures.push({ entry: cosign, valid: true, userVerified: false });
			}
			if (!entryAccepts(summary, authzEntries, input, input.task, authorization, entry.name, signatures, now)) {
				continue;
			}
			acceptable.push({
				planned: {
					entry,
					credential,
					cosignRequired: needsCosign,
					cosignAvailable: hasCosign(ownCrhsEntries(summary, input.crhsFingerprints)),
					requireUv: entry.requireUv,
					canAssertUv: canUv,
				},
				ttl,
			});
		}
		if (acceptable.length > 0) {
			// One payload serves all entries, so its deadline must fit the strictest max_ttl.
			const ttl = Math.min(...acceptable.map((candidate) => candidate.ttl));
			const authorization = buildAuthorization({
				nodes: [input.nodeId],
				command: { method, exact: { target, specSha256: specHash } },
				issuedAtMs: now,
				deadlineMs: now + ttl,
				taskIds: [input.task.id],
				attempt: input.task.attempt,
				note,
			});
			paths.push({
				path: "user",
				entries: acceptable.map((candidate) => candidate.planned),
				taskGroup: input.taskGroup,
				authorization,
				ttlMs: ttl,
			});
		} else {
			const ownerEntries = summary.trust.filter(
				(entry) =>
					entry.role === "user" && entry.kinds.includes("execute") && ownerSigningCredentialOf(entry, input.owner),
			);
			if (ownerEntries.length === 0) {
				notes.push("the node trusts none of the owner's credentials");
			} else if (
				ownerEntries.some(
					(entry) => cosignRequired(entry) && !hasCosign(ownCrhsEntries(summary, input.crhsFingerprints)),
				)
			) {
				notes.push("the owner's authorization needs a crhs cosignature and the node trusts no crhs cosign key");
			} else {
				notes.push("the owner's credentials do not cover this command");
			}
		}
	}

	const localEntries = summary.trust.filter(
		(entry) =>
			entry.role === "local" &&
			entry.kinds.includes("execute") &&
			entry.key.kind === "local" &&
			entry.key.uids.length > 0,
	);
	if (tried.has("local")) notes.push("the local approval path was already tried");
	for (const entry of localEntries) {
		const authzEntry = entriesByName.get(entry.name);
		const uid = entry.key.kind === "local" ? entry.key.uids[0] : undefined;
		if (!authzEntry || uid === undefined) continue;
		const decision = decide({
			now,
			clockSkewMs: summary.clockSkewMs,
			nodeId: input.nodeId,
			aliases: input.aliases,
			trust: authzEntries,
			task: { id: input.task.id, attempt: input.task.attempt, spec: input.task.spec },
			authorization: null,
			localApproval: { uid, specSha256: specHash },
		});
		if (decision.result !== "accepted" || decision.entry !== entry.name) continue;
		if (input.taskGroup) {
			notes.push("the task is part of a task group, so local approval does not apply");
			break;
		}
		if (!tried.has("local")) {
			paths.push({ path: "local", entry });
			break;
		}
	}

	if (paths.length > 0) return { paths };
	if (notes.length === 0) notes.push("no trust entry can authorize it");
	return { paths: [], reason: `${NOBODY}: ${notes.join("; ")}` };
}

export interface TaskGroupAuthorizationInput {
	/** The nodes of the group, with groups already expanded to node ids. */
	nodeIds: readonly string[];
	/** The tasks created for those nodes, in the same order. */
	taskIds: readonly string[];
	/** The shared attempt of the task group's tasks. */
	attempt: number;
	/** The one spec all tasks share. */
	spec: TaskSpec;
	issuedAtMs?: number;
	/** Defaults to USER_AUTHORIZATION_TTL_MS; cap it with the signing entry's max_ttl. */
	ttlMs?: number;
	note?: string;
}

/**
 * One payload that covers every task of a task group: all node ids, all task ids, a shared
 * attempt and one exact command. A user signs it once; crha consumes each (authorization, task) pair
 * separately, so a partial rejection only needs a new payload for the rejected nodes.
 */
export function buildTaskGroupAuthorization(input: TaskGroupAuthorizationInput): BuiltAuthorization {
	const { method, target } = privilegedTarget(input.spec);
	const issuedAtMs = input.issuedAtMs ?? Date.now();
	return buildAuthorization({
		nodes: input.nodeIds,
		command: { method, exact: { target, specSha256: specSha256(input.spec) } },
		issuedAtMs,
		deadlineMs: issuedAtMs + (input.ttlMs ?? USER_AUTHORIZATION_TTL_MS),
		taskIds: input.taskIds,
		attempt: input.attempt,
		note: input.note ?? "",
	});
}
