/**
 * The owner's authorizations (doc/privilege.md#授权路径, doc/m4.md M4.4): finding a stored one that covers
 * a task, judging one against a node's trust summary (with crhs's cosignature when the node needs it),
 * claiming the tasks it covers, and the submission of a new one.
 */
import {
	type AuthorizationPayload,
	decodeAuthorizationPayload,
	MAX_FRAME_BYTES,
	type Signature,
	type TaskSpec,
	type TaskStart,
	type TrustSummary,
} from "@crh/protocol";
import type { Selectable } from "kysely";
import type { SessionUser } from "../../auth/sessions.ts";
import type { AuthzDecision, AuthzSignature } from "../../privilege/authz.ts";
import { authzEntryFromTrust, decide, STEP } from "../../privilege/authz.ts";
import {
	assertSubmittingUser,
	encodeAuthorization,
	entryBelongsToUser,
	loadUserSigningMaterial,
	type SubmittedAuthorization,
	signaturesFromJson,
	signaturesToJson,
	type UserSigningMaterial,
	verifyAgainstTrust,
} from "../../privilege/submission.ts";
import type { TaskState as TaskRowState, TasksTable } from "../../storage/schema.ts";
import { NotFoundError, UserError } from "../../users/service.ts";
import { parseTaskAuthorization, serializeTaskAuthorization, type TaskAuthorizationRecord } from "../authorization.ts";
import { type ClusterCore, now } from "../core.ts";
import type { NodeLink } from "../links.ts";
import { newLive } from "../live-output.ts";
import { userCanAccessNode } from "../node-access.ts";
import { nodeGroupsForNodes } from "../node-groups.ts";
import type { NodeRow } from "../nodes.ts";
import { specFromRow } from "../spec.ts";
import {
	groupEnded,
	NODE_ACCESS_REVOKED,
	NODE_ACCESS_REVOKED_MESSAGE,
	syncGroupState,
	updateTask,
} from "../task-end.ts";
import { pendingInputOf, taskStartOf } from "../task-start.ts";
import { parseTrustReport } from "../trust.ts";
import { sendAuthorizedStart } from "./authorized-start.ts";
import {
	failAliasMissing,
	finishAuthorization,
	finishNodeOffline,
	type MissingAlias,
	withdrawLocal,
	withoutRequests,
} from "./common.ts";

/** How far an authorization's issued_at may be ahead of crhs's clock before it is refused. */
const SUBMISSION_CLOCK_SKEW_MS = 60_000;

/** A task claimed for an owner authorization and ready to be sent. */
export interface ClaimedAuthorization {
	start: TaskStart;
	record: TaskAuthorizationRecord;
	input: Uint8Array;
	cosigned: boolean;
}

/** A waiting task of a submission, judged against its node's trust summary before anything is claimed. */
interface JudgedSubmission {
	row: Selectable<TasksTable>;
	node: NodeRow;
	link: NodeLink;
	/** The user's signatures plus the cosignature this node needed (when one was needed). */
	signatures: Signature[];
	cosigned: boolean;
}

/** A waiting task of a submission that was judged and claimed; sending happens after all of them. */
interface PreparedSubmission {
	nodeId: string;
	claim: ClaimedAuthorization;
}

export type ReusableAuthorizationLookup =
	| { kind: "found"; submitted: SubmittedAuthorization; cosigned: boolean }
	/** A reusable authorization only this node's missing alias stands in the way of (D110). */
	| ({ kind: "alias_missing" } & MissingAlias)
	| null;

/** One owner authorization to judge for one task on one node. */
interface OwnerAuthorizationInput {
	payload: AuthorizationPayload;
	payloadBytes: Uint8Array;
	signatures: Signature[];
	summary: TrustSummary;
	nodeId: string;
	task: { id: string; attempt: number; spec: TaskSpec };
	material: UserSigningMaterial;
}

// ---- finding and judging a stored authorization ----

/** The node groups a node is in, id → name, for the alias checks. */
async function nodeGroupNamesForNode(core: ClusterCore, nodeId: string): Promise<Map<string, string>> {
	return new Map(
		((await nodeGroupsForNodes(core.db, [nodeId])).get(nodeId) ?? []).map((group) => [group.id, group.name]),
	);
}

/**
 * Whether a group-addressed reusable authorization would be accepted if the node trusted the
 * addressed node group as an alias (doc/privilege.md#信任缓存, D110). Only reusable authorizations
 * are expanded by group UUID; a one-shot one names its nodes itself and is never in this case.
 * `groups` lets a caller reuse one membership lookup across candidates.
 */
async function missingAliasForAuthorization(
	core: ClusterCore,
	input: OwnerAuthorizationInput,
	groups?: ReadonlyMap<string, string>,
): Promise<MissingAlias | null> {
	if (input.payload.taskIds !== null) return null;
	const aliases = new Set(input.summary.aliases);
	const memberships = groups ?? (await nodeGroupNamesForNode(core, input.nodeId));
	const addressed = input.payload.nodes.some(
		(candidate) => candidate === "*" || candidate === input.nodeId || aliases.has(candidate),
	);
	if (addressed) return null;
	const missing = input.payload.nodes.find((candidate) => memberships.has(candidate) && !aliases.has(candidate));
	if (missing === undefined) return null;
	const groupName = memberships.get(missing);
	if (groupName === undefined) return null;
	const withAlias = await judgeOwnerAuthorization(core, {
		...input,
		summary: { ...input.summary, aliases: [...input.summary.aliases, missing] },
	});
	return withAlias.accepted ? { groupId: missing, groupName } : null;
}

/**
 * Finds a stored authorization of the task's owner that covers it and that the node's trust
 * summary would accept (doc/privilege.md#授权路径). Reusable ones (no task ids) and one-shot ones
 * for this task with the same attempt qualify; a cosignature is added when the accepting entry
 * needs one and the payload is one-shot. A group-addressed reusable authorization that the node
 * would accept only with a missing alias is reported as `alias_missing` (D110).
 */
export async function findReusableAuthorization(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	summary: TrustSummary,
	spec: TaskSpec,
	skip: ReadonlySet<string>,
): Promise<ReusableAuthorizationLookup> {
	const ownerId = row.on_behalf_of_user_id;
	// The owner's organization, the same value insertOwnerAuthorization stores: an authorization is kept in
	// the organization of the user who issued it.
	const owner = await core.db.selectFrom("users").select("org_id").where("id", "=", ownerId).executeTakeFirst();
	if (!owner) return null;
	const stored = await core.db
		.selectFrom("authorizations")
		.selectAll()
		.where("issuer_user_id", "=", ownerId)
		.where("org_id", "=", owner.org_id)
		.orderBy("created_at")
		.execute();
	if (stored.length === 0) return null;
	const material = await loadUserSigningMaterial(core.db, ownerId);
	let aliasMissing: MissingAlias | null = null;
	let memberGroups: ReadonlyMap<string, string> | undefined;
	for (const candidate of stored) {
		if (skip.has(candidate.id)) continue;
		const payloadBytes = Uint8Array.from(Buffer.from(candidate.payload, "base64"));
		let payload: AuthorizationPayload;
		try {
			payload = decodeAuthorizationPayload(payloadBytes);
		} catch {
			continue; // a damaged row is never usable (fail closed)
		}
		// Every authorization must carry a deadline; a stored row without one would be refused
		// by the node (step 4) and is never reused.
		if (payload.deadlineMs === null) continue;
		if (payload.taskIds !== null) {
			if (!payload.taskIds.includes(row.id)) continue;
			if (payload.attempt !== row.attempt) continue;
		}
		const signatures = signaturesFromJson(candidate.signatures);
		if (signatures.length === 0) continue;
		const input: OwnerAuthorizationInput = {
			payload,
			payloadBytes,
			signatures,
			summary,
			nodeId: node.id,
			task: { id: row.id, attempt: row.attempt, spec },
			material,
		};
		const judged = await judgeOwnerAuthorization(core, input);
		if (!judged.accepted) {
			// A group-addressed reusable authorization is the case D110 warns about: if only the
			// node's configured aliases are missing, adding the alias would make the node accept it.
			if (aliasMissing === null) {
				memberGroups ??= await nodeGroupNamesForNode(core, node.id);
				aliasMissing = await missingAliasForAuthorization(core, input, memberGroups);
			}
			continue;
		}
		return {
			kind: "found",
			submitted: { payload, payloadBytes, signatures: judged.signatures, id: candidate.id },
			cosigned: judged.cosigned,
		};
	}
	return aliasMissing === null ? null : { kind: "alias_missing", ...aliasMissing };
}

/**
 * Judges one owner authorization for one task with the real decision port: which trust entry
 * verifies which signature, whether the node would accept it, and whether a crhs cosignature has
 * to be appended first (doc/privilege.md#联署).
 */
async function judgeOwnerAuthorization(
	core: ClusterCore,
	input: OwnerAuthorizationInput,
): Promise<{
	accepted: boolean;
	signatures: Signature[];
	entry: string | null;
	cosigned: boolean;
	reason: string;
}> {
	const trust = input.summary.trust;
	let signatures = [...input.signatures];
	const judge = (candidates: readonly AuthzSignature[]) =>
		decideOwnerAuthorization({
			now: Date.now(),
			summary: input.summary,
			nodeId: input.nodeId,
			task: input.task,
			payload: input.payload,
			payloadBytes: input.payloadBytes,
			signatures: candidates,
		});
	let authz = await verifyAgainstTrust(signatures, input.payloadBytes, trust);
	let decision = judge(authz);
	let cosigned = false;
	if (decision.result !== "accepted" && decision.step === STEP.cosign && input.payload.taskIds !== null) {
		const cosign = cosignature(core, input.payloadBytes, input.summary);
		if (cosign) {
			signatures = [...signatures, cosign];
			authz = await verifyAgainstTrust(signatures, input.payloadBytes, trust);
			const again = judge(authz);
			if (again.result === "accepted") {
				decision = again;
				cosigned = true;
			}
		}
	}
	if (decision.result !== "accepted") {
		return {
			accepted: false,
			signatures,
			entry: null,
			cosigned,
			reason: decision.step === null ? decision.message : `step ${decision.step}: ${decision.message}`,
		};
	}
	if (!entryBelongsToUser(decision.entry, trust, input.material)) {
		return {
			accepted: false,
			signatures,
			entry: decision.entry,
			cosigned,
			reason: "the accepting trust entry does not belong to the owner's credentials",
		};
	}
	return { accepted: true, signatures, entry: decision.entry, cosigned, reason: "" };
}

/** crhs's cosignature for a payload, when the node trusts its signing key with the cosign kind. */
function cosignature(core: ClusterCore, payloadBytes: Uint8Array, summary: TrustSummary): Signature | null {
	const key = core.authorizationKey;
	if (!key) return null;
	const entry = summary.trust.find(
		(trustee) =>
			trustee.role === "crhs" &&
			trustee.kinds.includes("cosign") &&
			trustee.key.kind === "sshsig" &&
			trustee.key.fingerprint === key.fingerprint,
	);
	if (!entry) return null;
	return { kind: "sshsig", blob: key.sign(payloadBytes) };
}

/** The decision port (`authz.ts`) fed with an owner authorization and a node's trust summary. */
function decideOwnerAuthorization(input: {
	now: number;
	summary: TrustSummary;
	nodeId: string;
	task: { id: string; attempt: number; spec: TaskSpec };
	payload: AuthorizationPayload;
	payloadBytes: Uint8Array;
	signatures: readonly AuthzSignature[];
}): AuthzDecision {
	return decide({
		now: input.now,
		clockSkewMs: input.summary.clockSkewMs,
		nodeId: input.nodeId,
		aliases: input.summary.aliases,
		trust: input.summary.trust.map(authzEntryFromTrust),
		task: input.task,
		authorization: { payload: input.payloadBytes, decoded: input.payload, signatures: input.signatures },
		localApproval: null,
	});
}

// ---- claiming and sending ----

/**
 * Claims a task for an owner authorization: the attempt is fixed, the pending payload is cleared
 * and the local approval request withdrawn. Sending is separate, so a whole task group can be
 * claimed before the first task.start is sent and a rejection cannot change a sibling's attempt.
 * This is the turn body (D118): planPrivileged calls it inside its plan turn, and every caller outside
 * a turn (the stored-authorization sweep, a submission) wraps it in a turn of the task's queue from a
 * fresh read. The task.start is sent after that turn.
 */
export async function claimOwnerAuthorization(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	link: NodeLink,
	submitted: SubmittedAuthorization,
	cosigned: boolean,
	from: readonly TaskRowState[] = ["awaiting_authorization"],
	inputBytes?: Uint8Array,
): Promise<ClaimedAuthorization | null> {
	if (!from.includes(row.state)) return null;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return null;
	// The signature may arrive long after the task was parked: check access again before claiming it (D108).
	if (!(await userCanAccessNode(core.db, row.on_behalf_of_user_id, node.id))) {
		await finishAuthorization(
			core,
			row.id,
			row,
			"failed",
			NODE_ACCESS_REVOKED,
			NODE_ACCESS_REVOKED_MESSAGE,
			parseTaskAuthorization(row.authorization),
		);
		return null;
	}
	const oneShot = submitted.payload.taskIds !== null;
	const attempt = oneShot ? (submitted.payload.attempt as number) : row.attempt;
	if (oneShot && attempt !== row.attempt) return null;
	let encoded: Uint8Array;
	try {
		encoded = encodeAuthorization(submitted.payloadBytes, submitted.signatures);
	} catch (err) {
		console.error(`authorization ${submitted.id} cannot be encoded:`, err);
		return null;
	}
	if (encoded.length > MAX_FRAME_BYTES / 2) return null;
	const record = parseTaskAuthorization(row.authorization);
	const updated: TaskAuthorizationRecord = {
		plan: record?.plan ?? { paths: [] },
		tried: record?.tried ?? [],
		dispatchedPath: "user",
		payloadId: submitted.id,
		attempt,
		trustDigest: record?.trustDigest ?? null,
		pending: null,
		local: null,
		lastRejection: record?.lastRejection ?? null,
		updatedAt: new Date().toISOString(),
	};
	withdrawLocal(link, row.id, record);
	const claimed = await updateTask(
		core,
		row.id,
		from,
		{
			state: "dispatched",
			attempt,
			dispatched_at: now(),
			authorization: serializeTaskAuthorization(updated),
			pending_input: null,
			handler_type: null,
			handler_session_id: null,
		},
		row.rev,
	);
	if (!claimed) return null;
	newLive(core, row.id, node.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	// The task no longer waits for a signature; the session it belongs to runs again (doc/agent-runtime.md#会话状态).
	core.onChange?.(row.actor_id);
	if (cosigned) {
		core.auditLater({
			actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "authorization.cosigned",
			target: { type: "authorization", id: submitted.id },
			detail: { node_id: node.id, task_id: row.id, attempt },
		});
	}
	const spec = specFromRow(row.spec, "task");
	// A task that waited has its input in pending_input; a fresh one it only ever had in memory
	// (doc/execution-plane.md#状态机).
	const input = inputBytes ?? pendingInputOf(row);
	const start = taskStartOf(row.id, row, spec, { privileged: true, attempt, authorizations: [encoded] });
	return { start, record: updated, input, cosigned };
}

// ---- a submitted authorization ----

/**
 * POST /api/authorizations: checks a user's authorization and stores it (for display and reuse). Only
 * the failures the caller can fix are synchronous (the signature, the deadline and the issuer's clock);
 * finding the waiting tasks it covers, judging them, claiming them, sending their task.start and
 * storing crhs's cosignatures continue in the background (D118), and the outcome shows up in the task
 * states (doc/m4.md M4.4).
 */
export async function submitAuthorization(
	core: ClusterCore,
	user: SessionUser,
	submitted: SubmittedAuthorization,
): Promise<{ id: string }> {
	const material = await loadUserSigningMaterial(core.db, user.userId);
	await assertSubmittingUser(material, submitted.payloadBytes, submitted.signatures);
	const nowMs = Date.now();
	const { deadlineMs } = submitted.payload;
	if (deadlineMs === null) {
		throw new UserError("the authorization must have a deadline");
	}
	if (deadlineMs < nowMs) {
		throw new UserError(`the authorization expired at ${new Date(deadlineMs).toISOString()}`);
	}
	if (submitted.payload.issuedAtMs > nowMs + SUBMISSION_CLOCK_SKEW_MS) {
		throw new UserError("the authorization was issued in the future");
	}
	const stored = await insertOwnerAuthorization(core, user, submitted);
	core.auditLater({
		actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		action: "authorization.submitted",
		target: { type: "authorization", id: submitted.id },
		detail: {
			nodes: submitted.payload.nodes,
			command: commandForAudit(submitted.payload.command),
			task_ids: submitted.payload.taskIds,
			attempt: submitted.payload.attempt,
			deadline: new Date(deadlineMs).toISOString(),
			duplicate: !stored,
		},
	});
	// Tracked by the core, so close() waits for an in-flight dispatch before the database is destroyed.
	core.background("authorization dispatch failed", dispatchSubmittedAuthorization(core, user, submitted, material));
	return { id: submitted.id };
}

/**
 * The background half of a submission (D118): judges every waiting task of the user the authorization
 * covers, claims the accepted ones, then sends their task.start and stores crhs's cosignatures. The
 * order matters: all judgments happen before the first claim, and all claims before the first send, so
 * one node's rejection cannot change the attempt of a sibling that is still about to be sent.
 */
async function dispatchSubmittedAuthorization(
	core: ClusterCore,
	user: SessionUser,
	submitted: SubmittedAuthorization,
	material: UserSigningMaterial,
): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("state", "=", "awaiting_authorization")
		.where("on_behalf_of_user_id", "=", user.userId)
		.orderBy("created_at")
		.execute();
	// The tasks are judged concurrently so a whole group on an offline node waits out one grace, not one
	// grace per member. The judge waits for its node, so it runs outside the task turn; its failure
	// writes run in a turn on a fresh read, and the claim below re-reads the row in a turn of its own
	// (D118).
	const judged = (await Promise.all(rows.map(({ id }) => judgeSubmitted(core, id, submitted, material)))).filter(
		(entry): entry is JudgedSubmission => entry !== null,
	);
	// The Authorization is one object for the whole group (D88), so it carries the union of the
	// cosignatures the covered nodes need; a node ignores a signature of a key it does not trust.
	const cosignatures = newSignatures(
		submitted.signatures,
		judged.flatMap((entry) => entry.signatures),
	);
	const signatures = [...submitted.signatures, ...cosignatures];
	const prepared: PreparedSubmission[] = [];
	for (const entry of judged) {
		// Judge and claim are separate turns: the row read by the judge may have been changed in between
		// (a sibling's re-plan refreshes the group's attempt). Claim from a fresh read, not from that row.
		const claim = await core.taskQueue.run(entry.row.id, async () => {
			const fresh = await core.row(entry.row.id);
			if (!fresh) return null;
			return claimOwnerAuthorization(core, fresh, entry.node, entry.link, { ...submitted, signatures }, entry.cosigned);
		});
		if (!claim) continue;
		prepared.push({ nodeId: entry.node.id, claim });
	}
	for (const entry of prepared) {
		const { claim } = entry;
		await sendAuthorizedStart(core, entry.nodeId, claim.start, claim.input, claim.record);
	}
	if (cosignatures.length > 0) await storeCosignatures(core, submitted, cosignatures, user.userId);
}

/**
 * One waiting task of the submitting user, judged against its node's fresh trust summary. The wait for
 * the node and the judgment run outside the task's turn; the failure writes run in a turn on a fresh
 * read (D118), and the claim is a later turn of its own.
 */
async function judgeSubmitted(
	core: ClusterCore,
	id: string,
	submitted: SubmittedAuthorization,
	material: UserSigningMaterial,
): Promise<JudgedSubmission | null> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return null;
	const payload = submitted.payload;
	if (payload.taskIds !== null) {
		if (!payload.taskIds.includes(id) || payload.attempt !== row.attempt) return null;
	}
	// D113: the submission waits for its node within the grace; a node that stays away fails the task
	// here instead of leaving it waiting for a signature that already arrived.
	const ready = await core.waitNodeReady(row.node_id, { trust: true });
	if (!ready?.link) {
		await core.taskQueue.run(id, async () => {
			const current = await core.row(id);
			if (current?.state !== "awaiting_authorization") return;
			const previous = parseTaskAuthorization(current.authorization);
			await finishNodeOffline(core, id, current, previous ? withoutRequests(previous) : null);
		});
		return null;
	}
	const node = ready.node;
	const link = ready.link;
	const report = parseTrustReport(node.trust_report);
	if (report?.kind !== "ok") return null;
	const input: OwnerAuthorizationInput = {
		payload,
		payloadBytes: submitted.payloadBytes,
		signatures: submitted.signatures,
		summary: report.summary,
		nodeId: node.id,
		task: { id, attempt: row.attempt, spec: specFromRow(row.spec, "task") },
		material,
	};
	const judged = await judgeOwnerAuthorization(core, input);
	if (!judged.accepted) {
		// A submitted reusable authorization that only the node's missing alias blocks ends the
		// task here instead of leaving it waiting forever (D110), unless local approval can still
		// authorize this single task.
		const missing = await missingAliasForAuthorization(core, input);
		if (missing !== null) {
			await core.taskQueue.run(id, async () => {
				const current = await core.row(id);
				if (current?.state !== "awaiting_authorization") return;
				await failAliasMissing(core, current, parseTaskAuthorization(current.authorization), missing);
			});
		}
		return null;
	}
	return { row, node, link, signatures: judged.signatures, cosigned: judged.cosigned };
}

/**
 * Stores a submitted payload for display and reuse, in the issuer's organization: that is the value
 * findReusableAuthorization compares when it looks for an authorization of the task's owner.
 */
async function insertOwnerAuthorization(
	core: ClusterCore,
	user: SessionUser,
	submitted: SubmittedAuthorization,
): Promise<boolean> {
	const existing = await core.db
		.selectFrom("authorizations")
		.select("id")
		.where("id", "=", submitted.id)
		.executeTakeFirst();
	if (existing) return false;
	const owner = await core.db.selectFrom("users").select("org_id").where("id", "=", user.userId).executeTakeFirst();
	if (!owner) throw new NotFoundError("no such user");
	await core.db
		.insertInto("authorizations")
		.values({
			id: submitted.id,
			org_id: owner.org_id,
			payload: Buffer.from(submitted.payloadBytes).toString("base64"),
			signatures: signaturesToJson(submitted.signatures),
			issuer_user_id: user.userId,
			task_ids: submitted.payload.taskIds === null ? null : JSON.stringify(submitted.payload.taskIds),
			deadline: submitted.payload.deadlineMs === null ? null : new Date(submitted.payload.deadlineMs).toISOString(),
			created_at: now(),
		})
		.execute();
	return true;
}

/**
 * Appends crhs's cosignatures to the row of the submitting owner. A row stored by someone else is left
 * alone: its id names the same payload, so the lookup by id alone would otherwise let a second submitter
 * add signatures to an authorization it does not own.
 */
async function storeCosignatures(
	core: ClusterCore,
	submitted: SubmittedAuthorization,
	cosignatures: Signature[],
	ownerId: string,
): Promise<void> {
	const row = await core.db
		.selectFrom("authorizations")
		.select("signatures")
		.where("id", "=", submitted.id)
		.where("issuer_user_id", "=", ownerId)
		.executeTakeFirst();
	if (!row) return;
	const stored = signaturesFromJson(row.signatures);
	const combined = [...stored, ...newSignatures(stored, cosignatures)];
	await core.db
		.updateTable("authorizations")
		.set({ signatures: signaturesToJson(combined) })
		.where("id", "=", submitted.id)
		.where("issuer_user_id", "=", ownerId)
		.execute();
}

// ---- helpers ----

/** An authorization command with its byte hash as hex, for the audit detail. */
function commandForAudit(command: AuthorizationPayload["command"]): Record<string, unknown> | null {
	if (command === null) return null;
	return command.match.kind === "exact"
		? {
				method: command.method,
				match: "exact",
				target: command.match.target,
				spec_sha256: Buffer.from(command.match.specSha256).toString("hex"),
			}
		: { method: command.method, match: "prefix", target: command.match.target };
}

/** The signatures of `candidates` that `existing` lacks, each once, in order: a cosignature is never appended twice. */
function newSignatures(existing: readonly Signature[], candidates: Iterable<Signature>): Signature[] {
	const keys = new Set(existing.map(signatureKey));
	const added: Signature[] = [];
	for (const signature of candidates) {
		const key = signatureKey(signature);
		if (keys.has(key)) continue;
		keys.add(key);
		added.push(signature);
	}
	return added;
}

/** Content identity of a signature, so a stored cosignature is not appended twice. */
function signatureKey(signature: Signature): string {
	return signaturesToJson([signature]);
}
