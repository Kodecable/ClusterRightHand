/**
 * The authorization decision crha makes before accepting a privileged task: steps 2–8 of
 * doc/privilege.md#校验流程 (step 1 is the peer uid check, step 10 persistence and execution).
 *
 * This is a side-effect-free port of crha's Go implementation (client/internal/privileged/authz).
 * crhs runs it to predict whether crha would accept an authorization; it reproduces every case of
 * test/interop/m4_authz_cases.json. The caller supplies signatures already verified against trust
 * entries, the clock, and the used state; nothing in here performs I/O.
 */
import {
	type AuthorizationPayload,
	decodeAuthorizationPayload,
	encodeAuthorizationPayload,
	type GuardRule,
	type TaskSpec,
	type TrustEntry as TrustSummaryEntry,
} from "@crh/protocol";
import type { Method } from "../policy/rules.ts";
import { errorText } from "../util/errors.ts";
import { cosignRequired, hasCosign } from "./cosign.ts";
import { envAllowed, guardAllows, privilegedTarget } from "./guard.ts";
import { authorizationId, specSha256 } from "./payload.ts";

export type AuthzResult =
	| "accepted"
	| "authorization_required"
	| "authorization_invalid"
	| "authorization_expired"
	| "authorization_rejected"
	| "already_accepted";

/** Steps of doc/privilege.md#校验流程 (step 1 belongs to the socket, step 10 to the caller). */
export const STEP = {
	task: 2,
	signatures: 3,
	authorization: 4,
	oneShot: 5,
	command: 6,
	trust: 7,
	cosign: 8,
	// Step 9 was the revocation check. Revocation was removed; the number stays unused so the
	// remaining steps keep their values in error messages.
} as const;

export type TrustRole = "crhs" | "user" | "local";
export type TrustKind = "execute" | "cosign" | "require-cosign";

/** One trust entry in the form the decision needs; the key itself lives with the signature verifier. */
export interface AuthzEntry {
	name: string;
	role: TrustRole;
	kinds: readonly TrustKind[];
	requireExact: boolean;
	requireTask: boolean;
	requireUv: boolean;
	/** max_ttl in milliseconds; null means no limit. */
	maxTtlMs: number | null;
	allow: readonly GuardRule[];
	deny: readonly GuardRule[];
	envAllow: readonly string[];
	/** `role = local`: the uids that may approve. */
	uids: readonly number[];
}

/** A decoded TrustSummary entry in the decision's form. */
export function authzEntryFromTrust(entry: TrustSummaryEntry): AuthzEntry {
	return {
		name: entry.name,
		role: entry.role,
		kinds: entry.kinds,
		requireExact: entry.requireExact,
		requireTask: entry.requireTask,
		requireUv: entry.requireUv,
		maxTtlMs: entry.maxTtlMs,
		allow: entry.allow,
		deny: entry.deny,
		envAllow: entry.envAllow,
		uids: entry.key.kind === "local" ? entry.key.uids : [],
	};
}

export interface AuthzTask {
	id: string;
	attempt: number;
	spec: TaskSpec;
}

/**
 * One signature after the caller's crypto check. `entry` is the trust entry whose key verified it,
 * or null when no trust entry matches; signatures with no entry are ignored, as the spec requires.
 */
export interface AuthzSignature {
	entry: AuthzEntry | null;
	valid: boolean;
	/** The UV flag of a WebAuthn assertion or an sk-* signature; false otherwise. */
	userVerified: boolean;
}

export interface AuthzAuthorization {
	/** The payload bytes exactly as signed. */
	payload: Uint8Array;
	/** The caller's strict decode of `payload`; the decision re-decodes and compares. */
	decoded: AuthorizationPayload;
	/** In wire order. */
	signatures: readonly AuthzSignature[];
}

export interface AuthzLocalApproval {
	uid: number;
	/** The spec hash recorded when the request was approved. */
	specSha256: Uint8Array;
}

export interface AuthzInput {
	/** Node clock, Unix milliseconds. */
	now: number;
	clockSkewMs: number;
	nodeId: string;
	aliases: readonly string[];
	trust: readonly AuthzEntry[];
	task: AuthzTask;
	authorization: AuthzAuthorization | null;
	localApproval: AuthzLocalApproval | null;
	/** Whether the task id already ran on this node. */
	executed?: (taskId: string) => boolean;
	/** Whether (authorization id, task id) is already in the used list. */
	used?: (authorizationId: Uint8Array, taskId: string) => boolean;
}

export interface AuthzDecision {
	result: AuthzResult;
	/** null for an accepted task; otherwise the failing step of doc/privilege.md#校验流程. */
	step: number | null;
	/** The accepting trust entry's name; null unless accepted. */
	entry: string | null;
	message: string;
}

/** Decides steps 2–8. See `AuthzInput` for the state the caller must supply. */
export function decide(input: AuthzInput): AuthzDecision {
	let method: Method;
	let target: string;
	let specHash: Uint8Array;
	try {
		({ method, target } = privilegedTarget(input.task.spec));
		specHash = specSha256(input.task.spec);
	} catch (err) {
		return failure("authorization_rejected", STEP.task, errorText(err));
	}
	if (input.authorization === null) return decideLocal(input, method, target, specHash);
	return decideAuthorization(input, method, target, specHash);
}

/**
 * task.start after `crha approve`: the local approval replaces the authorization object, so steps 3,
 * 4 and the command part of step 6 do not apply (doc/privilege.md#本地批准).
 */
function decideLocal(input: AuthzInput, method: Method, target: string, specHash: Uint8Array): AuthzDecision {
	const approval = input.localApproval;
	if (approval === null) {
		return failure("authorization_required", STEP.signatures, "no authorization and no local approval");
	}
	const entries = input.trust.filter((entry) => entry.role === "local" && entry.uids.includes(approval.uid));
	if (entries.length === 0) {
		return failure("authorization_required", STEP.signatures, `uid ${approval.uid} is not in a local trust entry`);
	}
	let first: AuthzDecision | undefined;
	for (const entry of entries) {
		if (taskExecuted(input, input.task.id)) {
			return failure("already_accepted", STEP.oneShot, `task ${input.task.id} already ran on this node`);
		}
		if (!bytesEqual(approval.specSha256, specHash)) {
			first ??= failure("authorization_rejected", STEP.command, "spec hash differs from the approved one");
			continue;
		}
		const trusted = checkTrust(entry, input, method, target);
		if (!trusted.ok) {
			first ??= trusted.decision;
			continue;
		}
		return accepted(entry.name);
	}
	return first as AuthzDecision;
}

function decideAuthorization(input: AuthzInput, method: Method, target: string, specHash: Uint8Array): AuthzDecision {
	const authorization = input.authorization as AuthzAuthorization;
	// Re-decode the raw bytes instead of trusting the caller's decode: this reapplies the payload
	// invariants and guarantees the used list keys off the bytes the signatures cover.
	let decoded: AuthorizationPayload;
	try {
		decoded = decodeAuthorizationPayload(authorization.payload);
	} catch (err) {
		return failure("authorization_invalid", STEP.signatures, `authorization payload: ${errorText(err)}`);
	}
	let sameDecoded: boolean;
	try {
		sameDecoded =
			bytesEqual(encodeAuthorizationPayload(decoded), encodeAuthorizationPayload(authorization.decoded)) &&
			bytesEqual(encodeAuthorizationPayload(decoded), authorization.payload);
	} catch {
		sameDecoded = false;
	}
	if (!sameDecoded) {
		return failure("authorization_invalid", STEP.signatures, "authorization payload does not match its decoded form");
	}
	if (authorization.signatures.length === 0) {
		return failure("authorization_invalid", STEP.signatures, "authorization has no signatures");
	}

	const candidates: AuthzSignature[] = [];
	for (const signature of authorization.signatures) {
		if (signature.entry === null) continue; // signed by a key this node does not trust
		if (!signature.valid) {
			return failure(
				"authorization_invalid",
				STEP.signatures,
				`signature by "${signature.entry.name}" does not verify`,
			);
		}
		switch (signature.entry.role) {
			case "crhs":
			case "user":
				candidates.push(signature);
				break;
			case "local":
				// A local trust entry has uids, not a signature key; it cannot sign.
				break;
			default:
				return failure(
					"authorization_invalid",
					STEP.signatures,
					`trust entry "${signature.entry.name}" has an unknown role`,
				);
		}
	}
	if (candidates.length === 0) {
		return failure("authorization_invalid", STEP.signatures, "no signature matches a trust entry");
	}

	const id = authorizationId(authorization.payload);
	let first: AuthzDecision | undefined;
	for (const signature of candidates) {
		const candidate = checkCandidate(input, authorization, decoded, signature, id, method, target, specHash);
		if (!candidate.ok) {
			first ??= candidate.decision;
			continue;
		}
		return candidate.decision;
	}
	return first as AuthzDecision;
}

type Checked = { ok: true; decision: AuthzDecision } | { ok: false; decision: AuthzDecision };

/** Steps 4–8 for one signature and its trust entry. */
function checkCandidate(
	input: AuthzInput,
	authorization: AuthzAuthorization,
	payload: AuthorizationPayload,
	signature: AuthzSignature,
	id: Uint8Array,
	method: Method,
	target: string,
	specHash: Uint8Array,
): Checked {
	const entry = signature.entry as AuthzEntry;
	// Step 4: the authorization body.
	if (!addressedTo(payload.nodes, input.nodeId, input.aliases)) {
		return no("authorization_invalid", STEP.authorization, "payload does not address this node");
	}
	const issuedAtMs = payload.issuedAtMs;
	if (issuedAtMs > input.now + input.clockSkewMs) {
		return no("authorization_expired", STEP.authorization, "authorization was issued in the future");
	}
	// Every authorization must expire: without a deadline a one-shot record would have to be
	// trusted forever, and the used list cannot bound it. This uses the same result and step as
	// the max_ttl path below, so callers see one stable refusal.
	if (payload.deadlineMs === null) {
		return no("authorization_expired", STEP.authorization, "authorization has no deadline");
	}
	if (payload.deadlineMs < input.now - input.clockSkewMs) {
		return no("authorization_expired", STEP.authorization, "authorization has expired");
	}
	if (entry.maxTtlMs !== null) {
		if (payload.deadlineMs - issuedAtMs > entry.maxTtlMs) {
			return no("authorization_expired", STEP.authorization, "authorization ttl exceeds max_ttl");
		}
	}
	if (entry.requireExact) {
		if (payload.command === null || payload.command.match.kind !== "exact") {
			return no("authorization_rejected", STEP.authorization, "trust entry requires an exact command");
		}
	}

	// Step 5: one-shot constraints and used state.
	if (taskExecuted(input, input.task.id)) {
		return no("already_accepted", STEP.oneShot, `task ${input.task.id} already ran on this node`);
	}
	if (payload.taskIds !== null) {
		if (!payload.taskIds.includes(input.task.id)) {
			return no("authorization_invalid", STEP.oneShot, "task id is not in task_ids");
		}
		const binding = oneShotNodeCheck(payload.nodes, payload.taskIds, input.task.id, input.nodeId);
		if (binding !== null) {
			return no("authorization_invalid", STEP.oneShot, `one-shot authorization: ${binding}`);
		}
		if (payload.attempt === null || payload.attempt !== input.task.attempt) {
			return no("authorization_invalid", STEP.oneShot, "attempt does not match task.start");
		}
		if (pairUsed(input, id, input.task.id)) {
			return no("authorization_rejected", STEP.oneShot, "authorization was already used for this task");
		}
	} else {
		if (entry.role === "crhs") {
			return no("authorization_rejected", STEP.oneShot, "crhs authorizations must carry task_ids");
		}
		if (entry.requireTask) {
			return no("authorization_rejected", STEP.oneShot, "trust entry requires task_ids");
		}
		// A cosignature is a single confirmation, so an authorization that needs one must be one-shot.
		if (cosignRequired(entry)) {
			return no("authorization_rejected", STEP.oneShot, "an authorization that requires cosign must carry task_ids");
		}
	}

	// Step 6: the command restriction.
	if (!commandCovers(payload.command, method, target, specHash)) {
		return no("authorization_rejected", STEP.command, "authorization does not cover this task");
	}

	// Step 7: the trust entry.
	const trusted = checkTrust(entry, input, method, target);
	if (!trusted.ok) return trusted;
	if (entry.requireUv && !signature.userVerified) {
		return no("authorization_rejected", STEP.trust, "trust entry requires user verification");
	}

	// Step 8: cosignature.
	if (cosignRequired(entry) && !hasCosign(verifiedEntries(authorization))) {
		return no("authorization_rejected", STEP.cosign, "authorization requires a crhs cosignature");
	}
	return { ok: true, decision: accepted(entry.name) };
}

/** The trust entry parts of step 7, shared with local approvals. */
function checkTrust(entry: AuthzEntry, input: AuthzInput, method: Method, target: string): Checked {
	if (!entry.kinds.includes("execute")) {
		return no("authorization_rejected", STEP.trust, `trust entry "${entry.name}" cannot authorize (no execute)`);
	}
	if (!guardAllows(entry, method, target)) {
		return no("authorization_rejected", STEP.trust, `trust entry "${entry.name}" rules reject this task`);
	}
	if (!envAllowed(input.task.spec, entry.envAllow)) {
		return no("authorization_rejected", STEP.trust, `trust entry "${entry.name}" does not allow the task environment`);
	}
	return { ok: true, decision: accepted(entry.name) };
}

/**
 * The trust entries whose signature verifies: the candidates a cosignature may come from. A signature
 * of a key the node does not trust is ignored, and an invalid one has already failed step 3.
 */
function verifiedEntries(authorization: AuthzAuthorization): AuthzEntry[] {
	const entries: AuthzEntry[] = [];
	for (const signature of authorization.signatures) {
		if (signature.valid && signature.entry !== null) entries.push(signature.entry);
	}
	return entries;
}

/**
 * The per-position node binding of a one-shot authorization (doc/protocol.md#授权对象): nodes lists
 * only node ids, has one entry per task id, and the task's id sits at this node's position. Returns
 * the failure reason, or null when the binding holds.
 */
function oneShotNodeCheck(
	nodes: readonly string[],
	taskIds: readonly string[],
	taskId: string,
	nodeId: string,
): string | null {
	if (nodes.length !== taskIds.length) {
		return `nodes has ${nodes.length} entries but task_ids has ${taskIds.length}`;
	}
	for (const node of nodes) {
		if (node === "*") return `nodes must contain node ids, not "${node}"`;
	}
	const index = taskIds.indexOf(taskId);
	if (index < 0) return "task id is not in task_ids";
	if (nodes[index] !== nodeId) return `task "${taskId}" belongs to node "${nodes[index]}", not this node`;
	return null;
}

/** Whether the payload's nodes cover this node: its id, one of its trust aliases, or "*". */
function addressedTo(nodes: readonly string[], nodeId: string, aliases: readonly string[]): boolean {
	return nodes.some((node) => node === "*" || node === nodeId || aliases.includes(node));
}

/** A null command covers every method and target. */
function commandCovers(
	command: AuthorizationPayload["command"],
	method: Method,
	target: string,
	specHash: Uint8Array,
): boolean {
	if (command === null) return true;
	if (command.match.kind === "exact") {
		return (
			command.method === method && command.match.target === target && bytesEqual(command.match.specSha256, specHash)
		);
	}
	return methodCovers(command.method, method) && target.startsWith(command.match.target);
}

/** file.write includes file.read; the reverse never holds. */
function methodCovers(authorized: Method, actual: Method): boolean {
	return authorized === actual || (authorized === "file.write" && actual === "file.read");
}

function taskExecuted(input: AuthzInput, taskId: string): boolean {
	return input.executed?.(taskId) ?? false;
}

function pairUsed(input: AuthzInput, id: Uint8Array, taskId: string): boolean {
	return input.used?.(id, taskId) ?? false;
}

function accepted(entry: string): AuthzDecision {
	return { result: "accepted", step: null, entry, message: "" };
}

function failure(result: AuthzResult, step: number, message: string): AuthzDecision {
	return { result, step, entry: null, message };
}

function no(result: AuthzResult, step: number, message: string): Checked {
	return { ok: false, decision: failure(result, step, message) };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}
