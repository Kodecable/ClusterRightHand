/**
 * Planning the authorization of a privileged task (doc/privilege.md#授权路径) and parking it in
 * `awaiting_authorization` when no path can be taken at once; a task group's waiting tasks share one
 * payload to sign (D88).
 */
import type { TaskSpec } from "@crh/protocol";
import type { Selectable, Updateable } from "kysely";
import { ownerCredentials } from "../../privilege/credentials.ts";
import type { BuiltAuthorization } from "../../privilege/payload.ts";
import {
	buildTaskGroupAuthorization,
	type PlannedLocalPath,
	type PlannedUserPath,
	planAuthorization,
	USER_AUTHORIZATION_TTL_MS,
} from "../../privilege/planner.ts";
import type { TaskState as TaskRowState, TasksTable } from "../../storage/schema.ts";
import {
	type PendingPayloadView,
	parseTaskAuthorization,
	planView,
	serializeTaskAuthorization,
	type TaskAuthorizationRecord,
} from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import type { NodeLink } from "../links.ts";
import { waitTrust } from "../links.ts";
import { getNode, type NodeRow } from "../nodes.ts";
import { specFromRow } from "../spec.ts";
import { groupEnded, syncGroupState, updateTask } from "../task-end.ts";
import { pendingInputColumn, pendingInputOf } from "../task-start.ts";
import { parseTrustReport, trustUnavailableMessage } from "../trust.ts";
import { dispatchCrhs } from "./authorized-start.ts";
import { ALIAS_MISSING, aliasMissingMessage, finishAuthorization, withoutRequests } from "./common.ts";
import { sendLocalRequest } from "./local-approval.ts";
import { dispatchOwnerAuthorization, findReusableAuthorization } from "./owner-authorizations.ts";

// ---- planning and parking ----

/**
 * Computes the authorization plan of a privileged task and acts on it, in this order
 * (doc/privilege.md#授权路径): an authorization the owner already stored that covers the task,
 * crhs's own signature, the owner's signature or a local approval. With no usable path the task
 * ends rejected and says why.
 */
export async function planPrivileged(
	core: ClusterCore,
	id: string,
	node: NodeRow,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	opts: { timeoutMs?: number },
	from: readonly TaskRowState[],
): Promise<void> {
	const row = await core.row(id);
	if (!row || !from.includes(row.state)) return;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return;
	if (!link.conn.supportsForward) {
		// A crha without the M4 names cannot take part in forward whatever its reported mode says
		// (doc/protocol.md#握手载荷).
		await finishAuthorization(
			core,
			id,
			row,
			"failed",
			"privileged_unsupported",
			"the node's crha does not support forward",
			null,
		);
		return;
	}
	await waitTrust(core, link);
	const fresh = await getNode(core.db, node.id);
	const report = fresh ? parseTrustReport(fresh.trust_report) : null;
	// A report kept from a previous connection is stale until this connection reports again: the node's
	// trust configuration may have changed while it was away (doc/privilege.md#信任缓存).
	if (!fresh || !link.trustFresh || report?.kind !== "ok") {
		const message = link.trustFresh
			? trustUnavailableMessage(report)
			: "the node has not reported a trust summary on this connection";
		await finishAuthorization(core, id, row, "failed", "privileged_unavailable", message, null);
		return;
	}
	const summary = report.summary;
	const previous = parseTaskAuthorization(row.authorization);
	const tried = previous ? [...previous.tried] : [];
	// Without a signing key crhs cannot take its own path; treating it as tried keeps the plan honest.
	if (!core.authorizationKey && !tried.includes("crhs")) tried.push("crhs");
	const plan = planAuthorization({
		summary,
		nodeId: node.id,
		aliases: summary.aliases,
		task: { id, attempt: row.attempt, spec, privileged: true },
		taskGroup: row.task_group_id !== null,
		owner: await ownerCredentials(core.db, row.on_behalf_of_user_id),
		...(core.authorizationKey ? { crhsFingerprint: core.authorizationKey.fingerprint } : {}),
		tried,
		now: Date.now(),
	});
	const record: TaskAuthorizationRecord = {
		plan: planView(plan),
		tried,
		dispatchedPath: previous?.dispatchedPath ?? null,
		payloadId: previous?.payloadId ?? null,
		attempt: row.attempt,
		trustDigest: fresh.trust_digest,
		pending: previous?.pending ?? null,
		local: previous?.local ?? null,
		lastRejection: previous?.lastRejection ?? null,
		updatedAt: new Date().toISOString(),
	};
	const crhsPath = plan.paths.find((path) => path.path === "crhs");
	if (crhsPath?.path === "crhs") {
		await dispatchCrhs(core, id, row, node, link, spec, inputBytes, opts, record, crhsPath.authorization, from);
		return;
	}
	// The owner may already have signed a reusable authorization that covers this command
	// (doc/privilege.md#授权路径 step 3): use it instead of asking for a signature again. A payload
	// crha already rejected is not retried automatically, or the retry would loop.
	const skip = new Set<string>();
	if (previous?.lastRejection && previous.payloadId) skip.add(previous.payloadId);
	const reusable = await findReusableAuthorization(core, row, node, summary, spec, skip);
	if (reusable?.kind === "found") {
		const dispatched = await dispatchOwnerAuthorization(
			core,
			row,
			node,
			link,
			reusable.submitted,
			reusable.cosigned,
			from,
			inputBytes,
		);
		if (dispatched) return;
	}
	const userPath = plan.paths.find((path): path is PlannedUserPath => path.path === "user");
	const localPath = plan.paths.find((path): path is PlannedLocalPath => path.path === "local");
	// A reusable authorization addressed to a node group this node is in, which the node does not
	// trust as an alias, is never sent (D110): the node would refuse it, and the owner's signature
	// would not fix the node's configuration. Local approval is the one other path that still works
	// without the alias (and only for a single task).
	if (reusable?.kind === "alias_missing" && !(localPath && row.task_group_id === null)) {
		await finishAuthorization(
			core,
			id,
			row,
			"failed",
			ALIAS_MISSING,
			aliasMissingMessage(reusable),
			withoutRequests(record, { keepStamp: true }),
		);
		return;
	}
	if (!userPath && !(localPath && row.task_group_id === null)) {
		const code = record.lastRejection?.code ?? "authorization_required";
		const reason = plan.reason ?? "no one on this node can authorize this command";
		const message = record.lastRejection === null ? reason : `${record.lastRejection.message}; ${reason}`;
		await finishAuthorization(core, id, row, "rejected", code, message, withoutRequests(record, { keepStamp: true }));
		return;
	}
	await parkForAuthorization(core, id, row, link, spec, inputBytes, record, userPath, localPath, from);
}

/**
 * Plans a waiting task again on its node's current link, with the spec and input stored on its row
 * unless the caller still holds them. Does nothing while the node has no ready link.
 */
export async function replanWaiting(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	given?: { spec: TaskSpec; input: Uint8Array },
): Promise<void> {
	const node = await getNode(core.db, row.node_id);
	const link = core.links.get(row.node_id);
	if (!node || !link || link.conn.closed || !link.ready) return;
	const spec = given?.spec ?? specFromRow(row.spec, "task");
	const input = given?.input ?? pendingInputOf(row);
	await planPrivileged(core, id, node, link, spec, input, { timeoutMs: row.timeout_ms ?? undefined }, [
		"awaiting_authorization",
	]);
}

/**
 * Parks the task in `awaiting_authorization`: for a single task it records the exact payload the
 * owner must sign and, when the node offers local approval, requests that too. A task group's
 * shared payload is built across all of the group's waiting tasks (refreshGroupPending).
 */
async function parkForAuthorization(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
	userPath: PlannedUserPath | undefined,
	localPath: PlannedLocalPath | undefined,
	from: readonly TaskRowState[],
): Promise<void> {
	const single = row.task_group_id === null;
	const pending = single && userPath ? pendingOf(userPath.authorization) : null;
	const local = single && localPath ? { attempt: row.attempt } : null;
	// The last task.start was rejected (or none was sent): nothing is in flight while the task waits.
	const updated: TaskAuthorizationRecord = {
		...record,
		pending,
		local,
		dispatchedPath: null,
		updatedAt: new Date().toISOString(),
	};
	const parked = await updateTask(core, id, from, {
		state: "awaiting_authorization",
		authorization: serializeTaskAuthorization(updated),
		pending_input: pendingInputColumn(inputBytes),
		dispatched_at: null,
		handler_type: "user",
		handler_session_id: null,
	});
	if (!parked) return;
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	core.onChange?.(row.actor_id);
	if (row.task_group_id !== null) {
		// Every waiting task of the group signs one payload covering all of them (D88).
		await refreshGroupPending(core, row.task_group_id);
		return;
	}
	if (localPath) await sendLocalRequest(core, id, link, spec, updated);
}

// ---- task groups: one payload for every waiting task (D88) ----

/** Rebuilds the shared payload of a group's waiting tasks from their plans, one signature for all. */
async function refreshGroupPending(core: ClusterCore, groupId: string): Promise<void> {
	await core.groupQueue.run(groupId, async () => {
		const group = await core.db.selectFrom("task_groups").selectAll().where("id", "=", groupId).executeTakeFirst();
		if (!group) return;
		const rows = await core.db
			.selectFrom("tasks")
			.selectAll()
			.where("task_group_id", "=", groupId)
			.orderBy("created_at")
			.execute();
		const entries = rows
			.filter((row) => row.state === "awaiting_authorization")
			.map((row) => ({ row, record: parseTaskAuthorization(row.authorization) }));
		const withUser = entries.filter((entry) => entry.record?.plan.paths.some((path) => path.path === "user"));
		if (withUser.length === 0) {
			for (const entry of entries) await clearGroupPending(core, entry.row, entry.record);
			return;
		}
		// The protocol ties a task.start to the payload's attempt, so all covered tasks move to the
		// highest attempt (doc/protocol.md#授权对象, D88).
		const attempt = Math.max(...withUser.map((entry) => entry.row.attempt));
		const ttlMs = Math.min(...withUser.map((entry) => userPathTtl(entry.record)));
		let spec: TaskSpec;
		try {
			spec = specFromRow(group.spec ?? withUser[0]?.row.spec ?? null, "task group");
		} catch (err) {
			console.warn(`task group ${groupId}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const authorization = buildTaskGroupAuthorization({
			nodeIds: withUser.map((entry) => entry.row.node_id),
			taskIds: withUser.map((entry) => entry.row.id),
			attempt,
			spec,
			ttlMs,
		});
		const pending = pendingOf(authorization);
		const covered = new Set(withUser.map((entry) => entry.row.id));
		for (const row of rows) {
			if (row.state !== "awaiting_authorization") continue;
			const record = parseTaskAuthorization(row.authorization);
			if (!covered.has(row.id)) {
				await clearGroupPending(core, row, record);
				continue;
			}
			if (!record) continue;
			const updated: TaskAuthorizationRecord = {
				...record,
				attempt,
				pending,
				updatedAt: new Date().toISOString(),
			};
			const set: Updateable<TasksTable> = { authorization: serializeTaskAuthorization(updated) };
			if (row.attempt !== attempt) set.attempt = attempt;
			const res = await core.db
				.updateTable("tasks")
				.set(set)
				.where("id", "=", row.id)
				.where("state", "=", "awaiting_authorization")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) continue;
			if (row.attempt !== attempt) core.notify(row.id);
		}
	});
}

async function clearGroupPending(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	record: TaskAuthorizationRecord | null,
): Promise<void> {
	if (!record?.pending) return;
	const updated: TaskAuthorizationRecord = { ...record, pending: null, updatedAt: new Date().toISOString() };
	await core.db
		.updateTable("tasks")
		.set({ authorization: serializeTaskAuthorization(updated) })
		.where("id", "=", row.id)
		.where("state", "=", "awaiting_authorization")
		.execute();
}

// ---- helpers ----

/** The payload the owner signs, in the form stored on the task and shown by the API. */
function pendingOf(authorization: BuiltAuthorization): PendingPayloadView {
	return {
		payload: Buffer.from(authorization.bytes).toString("base64"),
		id: authorization.id,
		deadline:
			authorization.payload.deadlineMs === null ? null : new Date(authorization.payload.deadlineMs).toISOString(),
		taskIds: authorization.payload.taskIds ?? [],
		attempt: authorization.payload.attempt ?? 0,
	};
}

/** The lifetime of the user path of a stored plan; the default when the plan has none. */
function userPathTtl(record: TaskAuthorizationRecord | null): number {
	const path = record?.plan.paths.find((candidate) => candidate.path === "user");
	return path?.ttlMs ?? USER_AUTHORIZATION_TTL_MS;
}
