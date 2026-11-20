/**
 * Planning the authorization of a privileged task (doc/design/privilege.md "Authorization path").
 *
 * This is a pure state machine: it takes one task or a whole task group with the trust summaries of
 * their nodes, crhs's signing keys and the owner's stored authorizations, and returns exactly one of
 *
 * - `usable`: authorizations that can be claimed and sent now (crhs's own signature, or an owner
 *   authorization already stored that covers the tasks);
 * - `options`: the ways the owner could authorize (a signature over exact payload bytes, or a local
 *   approval window on one node), with the tasks that parked; tasks with no option at all are named
 *   as failures;
 * - `failure`: no usable path and no known option.
 *
 * The planner performs no I/O and stores nothing. The caller loads the inputs, then claims, parks or
 * fails according to the result, and stores the options on the task records. A plan is only a
 * prediction: crha re-verifies everything before executing.
 */
import { createHash } from "node:crypto";
import {
	type AuthorizationPayload,
	type CosignPayload,
	encodeCosignPayload,
	type Signature,
	type TaskSpec,
	type TrustEntry,
	type TrustSummary,
} from "@crh/protocol";
import { type AuthzCosign, type AuthzSignature, type AuthzWindow, authzEntryFromTrust, decide, STEP } from "./authz.ts";
import { cosignRequired } from "./cosign.ts";
import { privilegedTarget } from "./guard.ts";
import { type AuthorizationSigningKey, trustedSigningKey } from "./key.ts";
import { type BuiltAuthorization, buildAuthorization, specSha256 } from "./payload.ts";
import { verifyAgainstTrust } from "./submission.ts";

/** A crhs-signed one-shot authorization is valid for at most this long. */
export const CRHS_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
/**
 * Default lifetime of a user's one-shot authorization. A human may take a while to sign, so this is
 * longer than the crhs default; the trust entry's max_ttl still caps it.
 */
export const USER_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;
/** A user entry whose max_ttl is shorter than this is never offered for a signature. */
export const MIN_SIGN_TTL_MS = 60 * 1000;

/** The owner's registered signing credentials (doc/design/privilege.md "Server-side authorization" `signing_credentials`). */
export interface OwnerSigningCredentials {
	/** OpenSSH `SHA256:…` fingerprints of the owner's SSH keys. */
	sshKeyFingerprints: readonly string[];
	/** base64url credential ids of the owner's WebAuthn credentials. */
	webauthnCredentialIds: readonly string[];
}

/** One node group a node belongs to, for the missing-alias diagnosis (doc/design/privilege.md "Trust aliases"). */
export interface PlannerNodeGroup {
	id: string;
	name: string;
}

/** One node the planned tasks run on, with the trust summary the node reported. */
export interface PlannerNode {
	id: string;
	name: string;
	/** The node's current trust summary; the caller reports an unavailable summary as a planning failure itself. */
	summary: TrustSummary;
	/** The node groups the node belongs to, for reusable group-addressed authorizations. */
	groups?: readonly PlannerNodeGroup[];
}

/** One task the planner judges. */
export interface PlannerTask {
	id: string;
	attempt: number;
	spec: TaskSpec;
	node: PlannerNode;
	/** The task belongs to a task group, so a local approval window is never offered for it. */
	taskGroup: boolean;
	/**
	 * Whether the task's node is connected now. Only a task on a connected node is ever `usable`: a
	 * task.start for an absent node would only wait out its grace. A task on an absent node waits for
	 * it only when the owner already signed (`awaitingNode`) or can still sign (a `sign` option);
	 * otherwise it fails `node_offline` at once, even if crhs could sign it once the node is back.
	 */
	online: boolean;
	/**
	 * Set when crha rejected crhs's own signature for this task: the node's local window at that moment
	 * (its `openedAtMs`, an identity and never compared as a time; null when no window was open). The
	 * crhs path stays ruled out while the node reports the same window.
	 */
	crhsRejected?: { window: number | null } | null;
	/**
	 * The `created_at` (ms) of the newest owner authorization crha rejected for this task: only owner
	 * authorizations stored after it are used for the task again.
	 */
	rejectedBefore?: number | null;
}

/** A task group planned as one unit: one spec, the members that still need authorization. */
export interface PlannerGroup {
	spec: TaskSpec;
	tasks: readonly PlannerTask[];
}

export type PlannerTarget = { kind: "task"; task: PlannerTask } | { kind: "group"; group: PlannerGroup };

/** One stored owner authorization, decoded, as the lookup found it. */
export interface StoredOwnerAuthorization {
	id: string;
	/** When crhs stored it (ms, crhs's clock). */
	createdAtMs: number;
	payload: AuthorizationPayload;
	payloadBytes: Uint8Array;
	signatures: readonly Signature[];
}

export interface PlannerInput {
	/** One task, or a whole task group. */
	target: PlannerTarget;
	owner: OwnerSigningCredentials;
	/** crhs's authorization signing keys, newest first. */
	keys: readonly AuthorizationSigningKey[];
	/**
	 * The owner's stored authorizations that are still valid or were stored since `since`, in any order.
	 */
	stored?: readonly StoredOwnerAuthorization[];
	/** When the planned unit (the task, or the task group) was created (ms): the start of the signature count. */
	since: number;
	/** The sign payload the unit's waiting tasks hold now; kept when it is still valid. */
	current?: BuiltAuthorization | null;
	/** `issued_at_ms` of generated payloads; defaults to now. */
	now?: number;
	/** The signed human-readable payload note; defaults to "". */
	note?: string;
}

/** One trust entry that would accept a `sign` option's payload for the owner. */
export interface PlannedSignEntry {
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

/** A `sign` option: the exact stored payload, the complete spec it binds, and how the owner signs it. */
export interface PlannedSignOption {
	kind: "sign";
	entries: PlannedSignEntry[];
	ttlMs: number;
	authorization: BuiltAuthorization;
	/** The complete task spec (a task group's group spec) the payload binds; shown to the signer. */
	spec: TaskSpec;
}

/** A `local_window` option: the owner opens a window on this one node. */
export interface PlannedLocalWindowOption {
	kind: "local_window";
	nodeId: string;
	nodeName: string;
}

export type PlannedOption = PlannedSignOption | PlannedLocalWindowOption;

/** crhs's own signature, for one task. */
export interface PlannedCrhsUse {
	kind: "crhs";
	taskId: string;
	/** The fingerprint of the newest key this node trusts with `execute`; claimCrhs signs with it. */
	keyFingerprint: string;
	authorization: BuiltAuthorization;
}

/** A stored owner authorization that covers one or more tasks. */
export interface PlannedStoredUse {
	kind: "stored";
	/** The `authorizations.id` (hex SHA-256 of the payload). */
	id: string;
	payload: AuthorizationPayload;
	payloadBytes: Uint8Array;
	/** The owner's signatures, as stored. */
	signatures: Signature[];
	/** The tasks of this plan the authorization covers and every node accepts. */
	taskIds: string[];
	/**
	 * The covered tasks whose node also needs crhs's cosign ticket, with the key that node trusts to cosign: the
	 * dispatch signs one ticket for the uses it sends (doc/design/privilege.md "Cosigning").
	 */
	cosign: PlannedCosign[];
}

/** One use of a stored authorization that crhs confirms with a cosign ticket. */
export interface PlannedCosign {
	taskId: string;
	nodeId: string;
	/** The newest crhs key the node trusts with `cosign`. */
	keyFingerprint: string;
}

export type PlannedUse = PlannedCrhsUse | PlannedStoredUse;

/** A task that cannot be authorized by any plan or option. */
export interface PlannedTaskFailure {
	taskId: string;
	/** `node_offline`: the node is away and nothing the owner could do now would authorize the task. */
	code: "authorization_required" | "alias_missing" | "node_offline";
	/** Set with `alias_missing`: the node group the authorization addresses. */
	groupId?: string;
	groupName?: string;
}

export type AuthorizationPlan =
	| { kind: "usable"; uses: readonly PlannedUse[] }
	| {
			kind: "options";
			options: readonly PlannedOption[];
			failed: readonly PlannedTaskFailure[];
			/** Tasks on an absent node that a stored owner authorization covers: sent when the node is back. */
			awaitingNode: readonly string[];
	  }
	| { kind: "failure"; failures: readonly PlannedTaskFailure[] };

/** The payload TTL an entry allows: the smaller of its max_ttl and the default for the path. */
function payloadTtl(entry: TrustEntry, fallback: number): number {
	return Math.min(entry.maxTtlMs ?? fallback, fallback);
}

export function ownerSigningCredentialOf(
	entry: TrustEntry,
	owner: OwnerSigningCredentials,
): PlannedSignEntry["credential"] | null {
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

/** Whether a crhs trust entry names one of crhs's own signing keys (when the fingerprints are known). */
export function isOwnCrhsEntry(entry: TrustEntry, crhsFingerprints: readonly string[] | undefined): boolean {
	if (entry.role !== "crhs") return false;
	if (crhsFingerprints === undefined) return true;
	return entry.key.kind === "sshsig" && crhsFingerprints.includes(entry.key.fingerprint);
}

/** The fingerprints of the crhs keys this node trusts as `crhs` entries. */
function ownCrhsEntries(summary: TrustSummary, keys: readonly AuthorizationSigningKey[]): TrustEntry[] {
	const fingerprints = new Set(keys.map((key) => key.fingerprint));
	return summary.trust.filter(
		(entry) => entry.role === "crhs" && entry.key.kind === "sshsig" && fingerprints.has(entry.key.fingerprint),
	);
}

/** Whether a node trusts at least one of crhs's keys, whatever the entry's kinds. */
function trustsOwnCrhsKey(summary: TrustSummary, keys: readonly AuthorizationSigningKey[]): boolean {
	return ownCrhsEntries(summary, keys).length > 0;
}

/** The trust entry the node's key maps to first: crha maps a signature to the first entry with its key. */
function firstEntryForKey(summary: TrustSummary, fingerprint: string): TrustEntry | undefined {
	return summary.trust.find((entry) => entry.key.kind === "sshsig" && entry.key.fingerprint === fingerprint);
}

/** The trust entry of the newest own key that can cosign, as the node would map it. */
function firstCosignEntry(
	summary: TrustSummary,
	keys: readonly AuthorizationSigningKey[],
): { key: AuthorizationSigningKey; entry: TrustEntry } | undefined {
	// `trustedSigningKey` walks the keys newest-first against the node's first entry per key.
	const key = trustedSigningKey(keys, summary.trust, "cosign");
	if (!key) return undefined;
	const entry = firstEntryForKey(summary, key.fingerprint);
	return entry ? { key, entry } : undefined;
}

/**
 * crha maps a signature to the first trust entry with its key, so later entries repeating a key never
 * take part in a decision there; dropping them here keeps the preview from planning a path crha would
 * refuse. Local entries are matched by uid and all take part.
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

/**
 * The node's local approval window as its last trust summary reports it. crhs never compares the node's
 * times with its own clock: a window counts as open until the node reports it closed, and a window that
 * already closed on the node only costs one more crha rejection (doc/design/privilege.md "Local approval window").
 */
function openWindow(summary: TrustSummary): AuthzWindow | null {
	if (summary.localWindow.kind !== "open") return null;
	return {
		openedBy: summary.localWindow.openedByUid,
		openedAtMs: summary.localWindow.openedAtMs,
		untilMs: Number.POSITIVE_INFINITY,
	};
}

/** The identity of the node's current window, or null while none is open. */
export function windowIdentity(summary: TrustSummary): number | null {
	return summary.localWindow.kind === "open" ? summary.localWindow.openedAtMs : null;
}

/** Whether crha already rejected crhs's signature for this task under the window the node reports now. */
function crhsTried(task: PlannerTask): boolean {
	if (!task.crhsRejected) return false;
	return task.crhsRejected.window === windowIdentity(task.node.summary);
}

/** Runs the real decision with hypothetical signatures to see whether one entry would be accepted. */
function entryAccepts(
	task: PlannerTask,
	trust: readonly TrustEntry[],
	authorization: BuiltAuthorization,
	entryName: string,
	signatures: readonly AuthzSignature[],
	attempt: number,
	window: AuthzWindow | null,
	now: number,
	cosign: AuthzCosign | null = null,
): boolean {
	const decision = decide({
		now,
		clockSkewMs: task.node.summary.clockSkewMs,
		nodeId: task.node.id,
		aliases: task.node.summary.aliases,
		trust: trust.map(authzEntryFromTrust),
		task: { id: task.id, attempt, spec: task.spec },
		authorization: { payload: authorization.bytes, decoded: authorization.payload, signatures },
		cosign,
		window,
	});
	return decision.result === "accepted" && decision.entry === entryName;
}

/** How long a cosign ticket lives: it confirms uses being sent now, so a few minutes cover the clock skew and the send. */
export const COSIGN_TICKET_TTL_MS = 5 * 60_000;

/**
 * The cosign ticket crhs would sign for this task's use of an authorization, as the decision sees it: the
 * node's own cosign entry as a valid signer. Null when the node trusts none of crhs's keys to cosign.
 */
function hypotheticalCosign(
	task: PlannerTask,
	payloadBytes: Uint8Array,
	attempt: number,
	keys: readonly AuthorizationSigningKey[],
	now: number,
): AuthzCosign | null {
	const cosign = firstCosignEntry(task.node.summary, keys);
	if (!cosign) return null;
	const decoded: CosignPayload = cosignPayloadFor(
		payloadBytes,
		[{ node: task.node.id, taskId: task.id, attempt }],
		now,
	);
	return {
		payload: encodeCosignPayload(decoded),
		decoded,
		signatures: [{ entry: authzEntryFromTrust(cosign.entry), valid: true, userVerified: false }],
	};
}

/** The cosign payload confirming `uses` of the authorization whose payload bytes are given. */
export function cosignPayloadFor(payloadBytes: Uint8Array, uses: CosignPayload["uses"], now: number): CosignPayload {
	return {
		v: 1,
		authorizationId: Uint8Array.from(createHash("sha256").update(payloadBytes).digest()),
		uses,
		issuedAtMs: now,
		deadlineMs: now + COSIGN_TICKET_TTL_MS,
	};
}

/** Builds the one-shot spec payload for one task on one node. */
function buildTaskAuthorization(task: PlannerTask, now: number, ttlMs: number, note: string): BuiltAuthorization {
	// Render the target first: a spec the node could not match is refused here, before a payload is built.
	privilegedTarget(task.spec);
	return buildAuthorization({
		nodes: [task.node.id],
		command: { specSha256: specSha256(task.spec) },
		issuedAtMs: now,
		deadlineMs: now + ttlMs,
		taskIds: [task.id],
		attempt: task.attempt,
		note,
	});
}

/** Plans crhs's own signature for one task, or null when the node would not accept it. */
function planCrhs(input: PlannerInput, task: PlannerTask, now: number): PlannedCrhsUse | null {
	if (crhsTried(task)) return null;
	const summary = task.node.summary;
	const trust = firstEntryPerKey(summary.trust);
	const window = openWindow(summary);
	const viaWindow = window !== null;
	for (const key of input.keys) {
		const entry = firstEntryForKey(summary, key.fingerprint);
		if (entry?.role !== "crhs") continue;
		// An open window waives the entry's kinds and limits, so any own crhs key can sign then.
		if (!viaWindow && !entry.kinds.includes("execute")) continue;
		const ttl = viaWindow ? CRHS_AUTHORIZATION_TTL_MS : payloadTtl(entry, CRHS_AUTHORIZATION_TTL_MS);
		let authorization: BuiltAuthorization;
		try {
			authorization = buildTaskAuthorization(task, now, ttl, input.note ?? "");
		} catch {
			return null;
		}
		const authzEntry = trust.find((candidate) => candidate.name === entry.name);
		if (!authzEntry) continue;
		const signature: AuthzSignature = { entry: authzEntryFromTrust(authzEntry), valid: true, userVerified: false };
		if (entryAccepts(task, trust, authorization, entry.name, [signature], task.attempt, window, now)) {
			return {
				kind: "crhs",
				taskId: task.id,
				keyFingerprint: key.fingerprint,
				authorization,
			};
		}
	}
	return null;
}

/** The owner entry a decision accepted, when it really belongs to the owner's own credentials. */
function ownerEntry(entryName: string | null, trust: readonly TrustEntry[], owner: OwnerSigningCredentials): boolean {
	const entry = trust.find((candidate) => candidate.name === entryName);
	return entry?.role === "user" && ownerSigningCredentialOf(entry, owner) !== null;
}

/** One stored authorization judged for one task. */
interface StoredJudgment {
	accepted: boolean;
	entry: string | null;
	/** The crhs key whose cosign ticket the node needs for this use; null when it needs none. */
	cosignKey: string | null;
}

/** Judges one stored authorization for one task, with a crhs cosign ticket when the node needs one. */
async function judgeStored(
	task: PlannerTask,
	stored: StoredOwnerAuthorization,
	keys: readonly AuthorizationSigningKey[],
	owner: OwnerSigningCredentials,
	summary: TrustSummary,
	now: number,
	verified: VerifiedSignatures,
): Promise<StoredJudgment> {
	const trust = firstEntryPerKey(summary.trust);
	const signatures = await verified(stored, task.node.id, trust);
	const nodeView = { ...task, node: { ...task.node, summary } };
	const judge = (cosign: AuthzCosign | null) =>
		decide({
			now,
			clockSkewMs: summary.clockSkewMs,
			nodeId: task.node.id,
			aliases: summary.aliases,
			trust: trust.map(authzEntryFromTrust),
			task: { id: task.id, attempt: task.attempt, spec: task.spec },
			authorization: { payload: stored.payloadBytes, decoded: stored.payload, signatures },
			cosign,
			window: null,
		});
	let decision = judge(null);
	let cosignKey: string | null = null;
	if (decision.result !== "accepted" && decision.step === STEP.cosign) {
		const cosign = hypotheticalCosign(nodeView, stored.payloadBytes, task.attempt, keys, now);
		const key = firstCosignEntry(summary, keys)?.key;
		if (cosign && key) {
			const again = judge(cosign);
			if (again.result === "accepted") {
				decision = again;
				cosignKey = key.fingerprint;
			}
		}
	}
	if (decision.result !== "accepted") return { accepted: false, entry: null, cosignKey: null };
	if (!ownerEntry(decision.entry, summary.trust, owner)) return { accepted: false, entry: decision.entry, cosignKey };
	return { accepted: true, entry: decision.entry, cosignKey };
}

/**
 * The signatures of a stored authorization verified against one node's trust entries. A plan verifies
 * each stored authorization once per node, however many of the node's tasks it judges.
 */
type VerifiedSignatures = (
	stored: StoredOwnerAuthorization,
	nodeId: string,
	trust: readonly TrustEntry[],
) => Promise<AuthzSignature[]>;

function verifiedSignatures(): VerifiedSignatures {
	const cache = new Map<string, Promise<AuthzSignature[]>>();
	return (stored, nodeId, trust) => {
		const key = `${stored.id}\0${nodeId}`;
		let verified = cache.get(key);
		if (!verified) {
			verified = verifyAgainstTrust(stored.signatures, stored.payloadBytes, trust);
			cache.set(key, verified);
		}
		return verified;
	};
}

/** A reusable group-addressed authorization the node would accept only with a missing trust alias. */
async function missingAliasFor(
	task: PlannerTask,
	stored: StoredOwnerAuthorization,
	keys: readonly AuthorizationSigningKey[],
	owner: OwnerSigningCredentials,
	now: number,
	verified: VerifiedSignatures,
): Promise<PlannerNodeGroup | null> {
	if (stored.payload.taskIds !== null) return null;
	const summary = task.node.summary;
	const aliases = new Set(summary.aliases);
	const addressed = stored.payload.nodes.some(
		(candidate) => candidate === "*" || candidate === task.node.id || aliases.has(candidate),
	);
	if (addressed) return null;
	const missing = (task.node.groups ?? []).find(
		(group) => stored.payload.nodes.includes(group.id) && !aliases.has(group.id),
	);
	if (!missing) return null;
	const withAlias = { ...summary, aliases: [...summary.aliases, missing.id] };
	const judged = await judgeStored(task, stored, keys, owner, withAlias, now, verified);
	return judged.accepted ? missing : null;
}

/**
 * Finds the owner's stored authorizations that cover the remaining tasks, newest first, judging every
 * task before any is assigned. An authorization stored no later than the newest one crha rejected for
 * a task is never used for that task again.
 */
async function planStored(
	input: PlannerInput,
	tasks: readonly PlannerTask[],
	now: number,
): Promise<{ uses: PlannedStoredUse[]; blocked: Map<string, PlannerNodeGroup> }> {
	const uses: PlannedStoredUse[] = [];
	const blocked = new Map<string, PlannerNodeGroup>();
	const stored = [...(input.stored ?? [])].sort((a, b) => b.createdAtMs - a.createdAtMs);
	if (stored.length === 0 || tasks.length === 0) return { uses, blocked };
	const owner = input.owner;
	const verified = verifiedSignatures();
	const remaining = new Map(tasks.map((task) => [task.id, task] as const));
	for (const candidate of stored) {
		if (remaining.size === 0) break;
		if (candidate.payload.deadlineMs !== null && candidate.payload.deadlineMs <= now) continue;
		const covered: PlannerTask[] = [];
		const cosign: PlannedCosign[] = [];
		for (const task of [...remaining.values()]) {
			if (task.rejectedBefore != null && candidate.createdAtMs <= task.rejectedBefore) continue;
			if (candidate.payload.taskIds !== null) {
				if (!candidate.payload.taskIds.includes(task.id)) continue;
				if (candidate.payload.attempt !== task.attempt) continue;
			}
			const judged = await judgeStored(task, candidate, input.keys, owner, task.node.summary, now, verified);
			if (!judged.accepted) {
				// A group-addressed reusable authorization blocked only by an alias never becomes a
				// signature wait: the node would refuse it until its trust configuration changes.
				if (!blocked.has(task.id)) {
					const missing = await missingAliasFor(task, candidate, input.keys, owner, now, verified);
					if (missing) blocked.set(task.id, missing);
				}
				continue;
			}
			covered.push(task);
			if (judged.cosignKey) cosign.push({ taskId: task.id, nodeId: task.node.id, keyFingerprint: judged.cosignKey });
		}
		if (covered.length === 0) continue;
		for (const task of covered) remaining.delete(task.id);
		uses.push({
			kind: "stored",
			id: candidate.id,
			payload: candidate.payload,
			payloadBytes: candidate.payloadBytes,
			signatures: [...candidate.signatures],
			taskIds: covered.map((task) => task.id),
			cosign,
		});
	}
	return { uses, blocked };
}

/** Whether a stored authorization names this task's node (or the task itself) and its command. */
function addressesTask(stored: StoredOwnerAuthorization, task: PlannerTask): boolean {
	const payload = stored.payload;
	if (payload.taskIds !== null) {
		if (!payload.taskIds.includes(task.id)) return false;
	} else {
		const names = new Set([task.node.id, ...task.node.summary.aliases, ...(task.node.groups ?? []).map((g) => g.id)]);
		if (!payload.nodes.some((name) => name === "*" || names.has(name))) return false;
	}
	if (payload.command === null) return true;
	if (payload.command.kind === "spec") {
		return Buffer.from(payload.command.value).equals(Buffer.from(specSha256(task.spec)));
	}
	let method: string;
	let target: string;
	try {
		({ method, target } = privilegedTarget(task.spec));
	} catch {
		return false;
	}
	const methodAllowed =
		payload.command.method === method || (payload.command.method === "file.write" && method === "file.read");
	return methodAllowed && target.startsWith(payload.command.target);
}

/**
 * How many owner authorizations stored since the unit was created address every one of its tasks. Each
 * is a signature the owner already gave for this need, whatever crha made of it; at
 * MAX_SIGNATURES_PER_UNIT the owner is not asked for another one (doc/design/privilege.md "Authorization path").
 */
function signaturesGiven(input: PlannerInput, tasks: readonly PlannerTask[]): number {
	let count = 0;
	for (const stored of input.stored ?? []) {
		if (stored.createdAtMs < input.since) continue;
		if (tasks.every((task) => addressesTask(stored, task))) count++;
	}
	return count;
}

/** A unit (a task, or a task group) asks its owner for at most this many signatures. */
export const MAX_SIGNATURES_PER_UNIT = 2;

/** `existing` plus `candidates` that are not already present, each once, in order. */
export function newUniqueSignatures(existing: readonly Signature[], candidates: readonly Signature[]): Signature[] {
	const seen = new Set(existing.map(signatureKey));
	const added: Signature[] = [];
	for (const signature of candidates) {
		const key = signatureKey(signature);
		if (seen.has(key)) continue;
		seen.add(key);
		added.push(signature);
	}
	return [...existing, ...added];
}

/** Content identity of a signature, so a cosignature is appended only once. */
function signatureKey(signature: Signature): string {
	return JSON.stringify(
		signature.kind === "sshsig"
			? { kind: signature.kind, blob: Buffer.from(signature.blob).toString("base64") }
			: {
					kind: signature.kind,
					credentialId: Buffer.from(signature.credentialId).toString("base64"),
					authenticatorData: Buffer.from(signature.authenticatorData).toString("base64"),
					clientDataJson: Buffer.from(signature.clientDataJson).toString("base64"),
					signature: Buffer.from(signature.signature).toString("base64"),
				},
	);
}

/** The user entries that would accept a payload for a task, with the configuration the design decisions need. */
function acceptableUserEntries(
	task: PlannerTask,
	attempt: number,
	/** A provisional payload of the given lifetime: each entry is judged with the lifetime it allows. */
	provisional: (ttlMs: number) => BuiltAuthorization,
	owner: OwnerSigningCredentials,
	keys: readonly AuthorizationSigningKey[],
	now: number,
): { planned: PlannedSignEntry; ttlMs: number }[] {
	const summary = task.node.summary;
	const trust = firstEntryPerKey(summary.trust);
	const entriesByName = new Map(trust.map((entry) => [entry.name, entry] as const));
	const out: { planned: PlannedSignEntry; ttlMs: number }[] = [];
	for (const entry of summary.trust) {
		if (entry.role !== "user" || !entry.kinds.includes("execute")) continue;
		// Too short a lifetime leaves no time to sign and would refresh the payload without end: such
		// an entry is treated as absent (crha itself refuses a max_ttl under five minutes).
		if (entry.maxTtlMs !== null && entry.maxTtlMs < MIN_SIGN_TTL_MS) continue;
		const credential = ownerSigningCredentialOf(entry, owner);
		if (!credential) continue;
		const entryKey = entriesByName.get(entry.name);
		if (!entryKey) continue;
		const canUv = canAssertUv(entry);
		const needsCosign = cosignRequired(entry);
		const cosignAvailable = needsCosign && firstCosignEntry(summary, keys) !== undefined;
		const signatures: AuthzSignature[] = [
			{ entry: authzEntryFromTrust(entryKey), valid: true, userVerified: entry.requireUv ? canUv : false },
		];
		const ttlMs = payloadTtl(entry, USER_AUTHORIZATION_TTL_MS);
		const authorization = provisional(ttlMs);
		const cosign = cosignAvailable ? hypotheticalCosign(task, authorization.bytes, attempt, keys, now) : null;
		if (!entryAccepts(task, trust, authorization, entry.name, signatures, attempt, null, now, cosign)) continue;
		out.push({
			planned: {
				entry,
				credential,
				cosignRequired: needsCosign,
				cosignAvailable,
				requireUv: entry.requireUv,
				canAssertUv: canUv,
			},
			ttlMs,
		});
	}
	return out;
}

/** Builds the shared sign payload of a task group: one owner signature for every covered member. */
export function buildTaskGroupAuthorization(input: {
	nodeIds: readonly string[];
	taskIds: readonly string[];
	attempt: number;
	spec: TaskSpec;
	issuedAtMs: number;
	ttlMs: number;
	note?: string;
}): BuiltAuthorization {
	// Render the target first, like buildTaskAuthorization: an unrenderable spec is refused here.
	privilegedTarget(input.spec);
	if (input.nodeIds.length !== input.taskIds.length) {
		throw new Error("a one-shot authorization needs exactly one node per task id");
	}
	return buildAuthorization({
		nodes: input.nodeIds,
		command: { specSha256: specSha256(input.spec) },
		issuedAtMs: input.issuedAtMs,
		deadlineMs: input.issuedAtMs + input.ttlMs,
		taskIds: input.taskIds,
		attempt: input.attempt,
		note: input.note ?? "",
	});
}

/** Plans the `sign` option of the remaining tasks, or null when none of them can be signed for. */
function planSign(input: PlannerInput, tasks: readonly PlannerTask[], now: number): PlannedSignOption | null {
	if (tasks.length === 0) return null;
	const group = input.target.kind === "group";
	const note = input.note ?? "";
	const groupSpec = input.target.kind === "group" ? input.target.group.spec : null;
	// The attempt a shared one-shot payload carries: the highest one, which the caller writes on every
	// covered task (doc/design/protocol.md "Authorization object").
	const attempt = group ? Math.max(...tasks.map((task) => task.attempt)) : (tasks[0] as PlannerTask).attempt;
	// The spec the payload binds: a group's group spec, or the one task's spec. It is shown to the
	// signer, who checks the hash the payload carries against it (doc/design/privilege.md "Authorizations").
	const boundSpec = groupSpec ?? (tasks[0] as PlannerTask).spec;
	const buildShared = (covered: readonly PlannerTask[], ttlMs: number): BuiltAuthorization => {
		if (groupSpec === null) return buildTaskAuthorization(tasks[0] as PlannerTask, now, ttlMs, note);
		return buildTaskGroupAuthorization({
			nodeIds: covered.map((task) => task.node.id),
			taskIds: covered.map((task) => task.id),
			attempt,
			spec: groupSpec,
			issuedAtMs: now,
			ttlMs,
			note,
		});
	};
	// A provisional payload only asks whether the owner could sign at all; the final one is judged below.
	const provisionals = new Map<number, BuiltAuthorization>();
	const provisional = (ttlMs: number): BuiltAuthorization => {
		let built = provisionals.get(ttlMs);
		if (!built) {
			built = buildShared(tasks, ttlMs);
			provisionals.set(ttlMs, built);
		}
		return built;
	};
	try {
		provisional(USER_AUTHORIZATION_TTL_MS);
	} catch {
		return null;
	}
	const acceptable = new Map<string, { planned: PlannedSignEntry; ttlMs: number }[]>();
	for (const task of tasks) {
		const entries = acceptableUserEntries(task, attempt, provisional, input.owner, input.keys, now);
		if (entries.length > 0) acceptable.set(task.id, entries);
	}
	if (acceptable.size === 0) return null;
	// Judge the final shared payload; a node may refuse a task whose acceptance depended on a per-task
	// deadline or attempt. Dropping a task changes the payload, so rebuild until it is stable.
	let covered = tasks.filter((task) => acceptable.has(task.id));
	for (let round = 0; round < tasks.length + 1; round++) {
		const ttlMs = Math.min(...covered.flatMap((task) => (acceptable.get(task.id) ?? []).map((entry) => entry.ttlMs)));
		let authorization: BuiltAuthorization;
		try {
			authorization = buildShared(covered, ttlMs);
		} catch {
			return null;
		}
		const next: PlannerTask[] = [];
		for (const task of covered) {
			const trust = firstEntryPerKey(task.node.summary.trust);
			const accepting = (acceptable.get(task.id) ?? []).filter((candidate) =>
				entryAccepts(
					task,
					trust,
					authorization,
					candidate.planned.entry.name,
					hypotheticalSignatures(candidate),
					attempt,
					null,
					now,
					candidate.planned.cosignAvailable
						? hypotheticalCosign(task, authorization.bytes, attempt, input.keys, now)
						: null,
				),
			);
			if (accepting.length === 0) continue;
			acceptable.set(task.id, accepting);
			next.push(task);
		}
		if (next.length === covered.length) {
			const entries: PlannedSignEntry[] = [];
			const seen = new Set<string>();
			for (const task of next) {
				for (const candidate of acceptable.get(task.id) ?? []) {
					const key = `${candidate.planned.entry.name}\0${candidate.planned.credential.kind}\0${JSON.stringify(candidate.planned.credential)}`;
					if (seen.has(key)) continue;
					seen.add(key);
					entries.push(candidate.planned);
				}
			}
			if (entries.length === 0) return null;
			const kept = keptPayload(input, next, attempt, acceptable, now);
			return { kind: "sign", entries, ttlMs, authorization: kept ?? authorization, spec: boundSpec };
		}
		covered = next;
		if (covered.length === 0) return null;
	}
	return null;
}

/**
 * When a sign payload should be replaced by a fresh one: a margin before its deadline, a quarter of its
 * lifetime but at most a minute, so a short-lived payload is still offered most of its life.
 */
export function signRefreshAtMs(payload: { issuedAtMs: number; deadlineMs: number | null }): number | null {
	if (payload.deadlineMs === null) return null;
	const margin = Math.min(60_000, Math.floor((payload.deadlineMs - payload.issuedAtMs) / 4));
	return payload.deadlineMs - margin;
}

/**
 * The payload the unit already offers, when it still asks exactly for what a new one would: the same
 * tasks at the same attempt, not yet due for a refresh, and accepted by the same entries. The owner
 * may be signing it right now, so it is not replaced without a reason.
 */
function keptPayload(
	input: PlannerInput,
	covered: readonly PlannerTask[],
	attempt: number,
	acceptable: ReadonlyMap<string, readonly { planned: PlannedSignEntry }[]>,
	now: number,
): BuiltAuthorization | null {
	const current = input.current;
	if (!current) return null;
	const { payload } = current;
	if (payload.attempt !== attempt || payload.taskIds === null) return null;
	const ids = [...payload.taskIds].sort();
	const wanted = covered.map((task) => task.id).sort();
	if (ids.length !== wanted.length || ids.some((id, index) => id !== wanted[index])) return null;
	const refreshAt = signRefreshAtMs(payload);
	if (refreshAt === null || refreshAt <= now) return null;
	for (const task of covered) {
		const trust = firstEntryPerKey(task.node.summary.trust);
		const accepted = (acceptable.get(task.id) ?? []).some((candidate) =>
			entryAccepts(
				task,
				trust,
				current,
				candidate.planned.entry.name,
				hypotheticalSignatures(candidate),
				attempt,
				null,
				now,
				candidate.planned.cosignAvailable ? hypotheticalCosign(task, current.bytes, attempt, input.keys, now) : null,
			),
		);
		if (!accepted) return null;
	}
	return current;
}

/** The hypothetical signature a user option is judged with: the owner's entry. A cosignature is a separate ticket. */
function hypotheticalSignatures(candidate: { planned: PlannedSignEntry }): AuthzSignature[] {
	return [
		{
			entry: authzEntryFromTrust(candidate.planned.entry),
			valid: true,
			userVerified: candidate.planned.requireUv ? candidate.planned.canAssertUv : false,
		},
	];
}

/** The targets of a planner call, with an invalid spec turned into a failure instead of throwing. */
function validTargets(input: PlannerInput): { tasks: PlannerTask[]; failures: PlannedTaskFailure[] } {
	const tasks = input.target.kind === "task" ? [input.target.task] : [...input.target.group.tasks];
	const valid: PlannerTask[] = [];
	const failures: PlannedTaskFailure[] = [];
	for (const task of tasks) {
		try {
			privilegedTarget(task.spec);
			valid.push(task);
		} catch {
			failures.push({ taskId: task.id, code: "authorization_required" });
		}
	}
	return { tasks: valid, failures };
}

/**
 * Plans the authorization of one task or one task group.
 *
 * Each task is judged in preference order: crhs's own signature, then an owner authorization the
 * owner already stored. When neither is usable for any task, the remaining tasks get options: one
 * shared `sign` payload for the tasks the owner can sign for, plus a `local_window` option for a
 * single task (never for a task group). Tasks with no usable path and no option are returned as
 * failures; a plan never parks a task with empty options.
 */
export async function planAuthorization(input: PlannerInput): Promise<AuthorizationPlan> {
	const now = input.now ?? Date.now();
	const { tasks, failures } = validTargets(input);
	if (tasks.length === 0) return { kind: "failure", failures };
	const uses: PlannedUse[] = [];
	let remaining = [...tasks];

	// crhs's own signature first (an open local window counts here), for tasks whose node is connected.
	const crhsUsed: PlannerTask[] = [];
	for (const task of remaining.filter((candidate) => candidate.online)) {
		const use = planCrhs(input, task, now);
		if (use) {
			uses.push(use);
			crhsUsed.push(task);
		}
	}
	const crhsIds = new Set(crhsUsed.map((task) => task.id));
	remaining = remaining.filter((task) => !crhsIds.has(task.id));

	// Then an owner authorization that is already stored and covers the tasks.
	const stored = await planStored(
		input,
		remaining.filter((candidate) => candidate.online),
		now,
	);
	uses.push(...stored.uses);
	const storedIds = new Set(stored.uses.flatMap((use) => use.taskIds));
	remaining = remaining.filter((task) => !storedIds.has(task.id));

	if (uses.length > 0) return { kind: "usable", uses };

	// A task on an absent node that a stored owner authorization covers needs nothing more from the
	// owner: it waits for its node, whose next report sends it.
	const offline = await planStored(
		input,
		remaining.filter((candidate) => !candidate.online),
		now,
	);
	const awaitingNode = offline.uses.flatMap((use) => use.taskIds);
	const signed = new Set(awaitingNode);
	remaining = remaining.filter((task) => !signed.has(task.id));

	// No usable path at all: what could the owner do? A missing alias is a terminal failure for that
	// task (the node would refuse the authorization until its configuration changes).
	const optionTasks: PlannerTask[] = [];
	for (const task of remaining) {
		const missing = stored.blocked.get(task.id);
		if (missing) {
			failures.push({
				taskId: task.id,
				code: "alias_missing",
				groupId: missing.id,
				groupName: missing.name,
			});
			continue;
		}
		optionTasks.push(task);
	}
	const options: PlannedOption[] = [];
	// The owner signed for this need often enough: a further signature would meet the same refusal.
	const sign =
		optionTasks.length > 0 && signaturesGiven(input, optionTasks) < MAX_SIGNATURES_PER_UNIT
			? planSign(input, optionTasks, now)
			: null;
	if (sign) options.push(sign);
	// A local approval window is offered only for one single task whose node has a local entry and
	// trusts one of crhs's keys (otherwise opening a window could not authorize anything).
	const single = input.target.kind === "task" ? input.target.task : null;
	let windowTaskId: string | null = null;
	if (single !== null && !single.taskGroup) {
		const summary = single.node.summary;
		const hasLocal = summary.trust.some(
			(entry) => entry.role === "local" && entry.key.kind === "local" && entry.key.uids.length > 0,
		);
		if (hasLocal && trustsOwnCrhsKey(summary, input.keys)) {
			options.push({ kind: "local_window", nodeId: single.node.id, nodeName: single.node.name });
			windowTaskId = single.id;
		}
	}
	// A task the options do not cover has no way to be authorized now. On an absent node that is
	// reported as such: crhs does not keep it waiting for the node (doc/design/privilege.md "The planner").
	const covered = new Set(sign?.authorization.payload.taskIds ?? []);
	for (const task of optionTasks) {
		if (task.id === windowTaskId || covered.has(task.id)) continue;
		if (!failures.some((failure) => failure.taskId === task.id)) {
			failures.push({ taskId: task.id, code: task.online ? "authorization_required" : "node_offline" });
		}
	}
	if (options.length === 0 && awaitingNode.length === 0) return { kind: "failure", failures };
	return { kind: "options", options, failed: failures, awaitingNode };
}
