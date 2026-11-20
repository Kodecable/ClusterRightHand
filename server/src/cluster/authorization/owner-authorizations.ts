/**
 * The owner's stored authorizations (doc/design/privilege.md "Authorization path"): loading them for the
 * planner, claiming the tasks one covers, and keeping the signatures crhs itself adds. The planner
 * decides whether a stored authorization covers a task; this module only acts on that decision.
 */
import { type AuthorizationPayload, decodeAuthorizationPayload, MAX_FRAME_BYTES, type TaskSpec } from "@crh/protocol";
import type { Selectable } from "kysely";
import { authorizationDeadline } from "../../privilege/payload.ts";
import { newUniqueSignatures, type StoredOwnerAuthorization } from "../../privilege/planner.ts";
import {
	encodeAuthorization,
	type SubmittedAuthorization,
	signaturesFromJson,
	signaturesToJson,
} from "../../privilege/submission.ts";
import type { TasksTable } from "../../storage/schema.ts";
import { errorText, UserError } from "../../util/errors.ts";
import { parseTaskAuthorization, serializeTaskAuthorization, type TaskAuthorizationRecord } from "../authorization.ts";
import { type ClusterCore, now } from "../core.ts";
import { newLive } from "../live-output.ts";
import { userCanAccessNode } from "../node-access.ts";
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
import { type AuthorizedStart, emptyAuthorizationRecord, finishAuthorization } from "./common.ts";

/** A task claimed for an owner authorization and ready to be sent: the same shape as crhs's own claim. */
export type ClaimedAuthorization = AuthorizedStart;

/**
 * The owner's stored authorizations a sync pass of one unit needs, decoded for the planner: the ones still
 * valid (a candidate to use) and the ones stored since the unit was created (they count toward the
 * signatures it asked for). A one-shot authorization that names none of the unit's tasks is dropped
 * before it is decoded. A damaged row is skipped: it can never be used, and one bad row must not stop
 * the others.
 */
export async function loadStoredOwnerAuthorizations(
	core: ClusterCore,
	ownerId: string,
	unit: { since: number; taskIds: readonly string[] },
): Promise<StoredOwnerAuthorization[]> {
	// The owner's organization, the same value insertOwnerAuthorization stores: an authorization is kept in
	// the organization of the user who issued it.
	const owner = await core.db.selectFrom("users").select("org_id").where("id", "=", ownerId).executeTakeFirst();
	if (!owner) return [];
	const nowIso = new Date().toISOString();
	const sinceIso = new Date(unit.since).toISOString();
	const rows = await core.db
		.selectFrom("authorizations")
		.selectAll()
		.where("issuer_user_id", "=", ownerId)
		.where("org_id", "=", owner.org_id)
		.where((eb) => eb.or([eb("deadline", ">", nowIso), eb("created_at", ">=", sinceIso)]))
		.execute();
	const taskIds = new Set(unit.taskIds);
	const out: StoredOwnerAuthorization[] = [];
	for (const row of rows) {
		if (row.task_ids !== null && !namesAny(row.task_ids, taskIds)) continue;
		const payloadBytes = Uint8Array.from(Buffer.from(row.payload, "base64"));
		let payload: AuthorizationPayload;
		try {
			payload = decodeAuthorizationPayload(payloadBytes);
		} catch {
			continue;
		}
		const signatures = signaturesFromJson(row.signatures);
		if (signatures.length === 0) continue;
		out.push({ id: row.id, createdAtMs: Date.parse(row.created_at), payload, payloadBytes, signatures });
	}
	return out;
}

/** Whether a stored `task_ids` JSON array names one of the tasks. */
function namesAny(json: string, taskIds: ReadonlySet<string>): boolean {
	try {
		const ids = JSON.parse(json) as unknown;
		return Array.isArray(ids) && ids.some((id) => typeof id === "string" && taskIds.has(id));
	} catch {
		return false;
	}
}

/**
 * Stores a submitted payload for display and reuse, in the issuer's organization. Returns false when the
 * issuer already stored it: its new signatures (another key, a Passkey with user verification) are added
 * to that row, so signing the same payload again is not lost, and it stays one signature for the cap
 * (doc/design/privilege.md "The planner"). The id is the payload's hash, so a payload someone else
 * already stored (or crhs signed) cannot be stored again: the submission is refused, and that row is
 * left alone.
 */
export async function insertOwnerAuthorization(
	core: ClusterCore,
	ownerId: string,
	orgId: string,
	submitted: SubmittedAuthorization,
): Promise<boolean> {
	const existing = await core.db
		.selectFrom("authorizations")
		.select(["issuer_user_id", "signatures"])
		.where("id", "=", submitted.id)
		.executeTakeFirst();
	if (existing) {
		if (existing.issuer_user_id !== ownerId) throw new UserError("this payload was already stored by someone else");
		const stored = signaturesFromJson(existing.signatures);
		const combined = newUniqueSignatures(stored, submitted.signatures);
		if (combined.length > stored.length) {
			await core.db
				.updateTable("authorizations")
				.set({ signatures: signaturesToJson(combined) })
				.where("id", "=", submitted.id)
				.where("issuer_user_id", "=", ownerId)
				.execute();
		}
		return false;
	}
	await core.db
		.insertInto("authorizations")
		.values({
			id: submitted.id,
			org_id: orgId,
			payload: Buffer.from(submitted.payloadBytes).toString("base64"),
			signatures: signaturesToJson(submitted.signatures),
			issuer_user_id: ownerId,
			task_ids: submitted.payload.taskIds === null ? null : JSON.stringify(submitted.payload.taskIds),
			deadline: authorizationDeadline(submitted.payload.deadlineMs),
			created_at: now(),
		})
		.execute();
	return true;
}

/**
 * Claims a waiting task for an owner authorization: the attempt is fixed, the options are cleared and
 * the task moves to `dispatched`. Sending is separate, so a whole task group can be claimed before the
 * first task.start is sent and a rejection cannot change a sibling's attempt. Runs in the task's turn
 * on the row the sync pass planned from. Returns null when the task was not claimed: a cause that will
 * not go away (access revoked, a spec or an authorization that cannot be encoded) ends the task here.
 */
export async function claimOwnerAuthorization(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	submitted: SubmittedAuthorization,
): Promise<ClaimedAuthorization | null> {
	if (row.state !== "awaiting_authorization") return null;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return null;
	const record = parseTaskAuthorization(row.authorization);
	// The signature may arrive long after the task was parked: check access again before claiming it.
	if (!(await userCanAccessNode(core.db, row.on_behalf_of_user_id, node.id))) {
		await finishAuthorization(core, row.id, row, "errored", NODE_ACCESS_REVOKED, NODE_ACCESS_REVOKED_MESSAGE, record);
		return null;
	}
	const oneShot = submitted.payload.taskIds !== null;
	const attempt = oneShot ? (submitted.payload.attempt as number) : row.attempt;
	if (oneShot && attempt !== row.attempt) return null;
	let spec: TaskSpec;
	try {
		spec = specFromRow(row.spec, "task");
	} catch (err) {
		await finishAuthorization(
			core,
			row.id,
			row,
			"errored",
			"invalid_spec",
			`the stored spec cannot be read: ${errorText(err)}`,
			record,
		);
		return null;
	}
	let encoded: Uint8Array;
	try {
		encoded = encodeAuthorization(submitted.payloadBytes, submitted.signatures);
	} catch (err) {
		await finishAuthorization(
			core,
			row.id,
			row,
			"errored",
			"invalid_spec",
			`cannot encode the authorization: ${errorText(err)}`,
			record,
		);
		return null;
	}
	// An authorization may take at most half a frame so the rest of task.start still fits (doc/design/protocol.md "Authorization object").
	if (encoded.length > MAX_FRAME_BYTES / 2) {
		await finishAuthorization(
			core,
			row.id,
			row,
			"errored",
			"invalid_spec",
			`the authorization is ${encoded.length} bytes, more than half a frame`,
			record,
		);
		return null;
	}
	const input = pendingInputOf(row);
	const updated: TaskAuthorizationRecord = {
		...(record ?? emptyAuthorizationRecord(attempt)),
		options: [],
		dispatchedPath: "user",
		payloadId: submitted.id,
		attempt,
		trustDigest: node.trust_digest,
		updatedAt: new Date().toISOString(),
	};
	const claimed = await updateTask(
		core,
		row.id,
		["awaiting_authorization"],
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
	// The task no longer waits for a signature; the session it belongs to runs again (doc/design/agent-runtime.md "Session state").
	core.onChange?.(row.actor_id);
	const start = taskStartOf(row.id, row, spec, { privileged: true, attempt, authorizations: [encoded] });
	return { nodeId: node.id, start, record: updated, input };
}
