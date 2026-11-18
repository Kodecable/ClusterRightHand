/**
 * The one progression path of a privileged task's authorization (doc/design/privilege.md "Authorization path").
 *
 * The unit of authorization is a task group, or a task that belongs to none. Every event only asks for
 * the unit to be synced: the first dispatch, a node's trust.summary (a changed digest or the first
 * report on a connection), a submitted owner authorization, a crha rejection, a sign payload that is
 * due for a refresh and the periodic sweep. A sync pass reads the unit's waiting tasks as they are now,
 * runs the pure planner, and applies its result with rev-checked writes: it claims and sends what is
 * usable, parks the rest with options, or ends what nothing can authorize.
 *
 * Passes run on `core.authorizationSync`, a KeyedReconciler keyed by unit (doc/design/architecture.md
 * "Concurrency"): passes of one unit never overlap, and a request during a pass asks for exactly one
 * more pass that reads newer rows. A write that finds its row changed since the pass read it is
 * dropped, and the pass asks for another one instead of retrying itself.
 *
 * Code that runs inside a pass, or inside a task turn, only requests a sync (`requestAuthorizationSync`)
 * and never waits for one: a pass waiting for its own unit would wait for itself.
 */
import type { AuthorizationOption } from "@crh/api";
import { decodeAuthorizationPayload, type TaskSpec } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { SessionUser } from "../../auth/sessions.ts";
import type { BuiltAuthorization } from "../../privilege/payload.ts";
import {
	type AuthorizationPlan,
	type PlannedOption,
	type PlannedTaskFailure,
	type PlannedUse,
	type PlannerNodeGroup,
	type PlannerTask,
	planAuthorization,
	signRefreshAtMs,
} from "../../privilege/planner.ts";
import { ownerSigningCredentials } from "../../privilege/signing-credentials.ts";
import {
	assertSubmittingUser,
	loadUserSigningMaterial,
	type SubmittedAuthorization,
} from "../../privilege/submission.ts";
import type { TaskState as TaskRowState, TasksTable } from "../../storage/schema.ts";
import { NotFoundError, UserError } from "../../util/errors.ts";
import {
	optionRecords,
	parseTaskAuthorization,
	serializeTaskAuthorization,
	type TaskAuthorizationRecord,
} from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import { nodeGroupsForNodes } from "../node-groups.ts";
import { getNode, type NodeRow } from "../nodes.ts";
import { specFromRow } from "../spec.ts";
import { groupEnded, NODE_OFFLINE, NODE_OFFLINE_MESSAGE, syncGroupState, updateTask } from "../task-end.ts";
import { pendingInputColumn } from "../task-start.ts";
import { parseTrustReport, trustUnavailableMessage } from "../trust.ts";
import { type AuthorizedStart, claimCrhs, sendAuthorizedStart } from "./authorized-start.ts";
import { ALIAS_MISSING, aliasMissingMessage, emptyAuthorizationRecord, finishAuthorization } from "./common.ts";
import {
	claimOwnerAuthorization,
	insertOwnerAuthorization,
	loadStoredOwnerAuthorizations,
	storeCosignatures,
} from "./owner-authorizations.ts";
import { rejectAuthorizationWait } from "./reject.ts";

/** A task group, or a task that belongs to none: what one plan covers. */
export type AuthorizationUnit = { kind: "task"; id: string } | { kind: "group"; id: string };

/** The failure line of a task no plan could authorize. */
const NO_ONE = "no one on this node can authorize this command";

/** How far an authorization's issued_at may be ahead of crhs's clock before it is refused. */
const SUBMISSION_CLOCK_SKEW_MS = 60_000;

/** The unit a task row belongs to. */
export function unitOf(row: { id: string; task_group_id: string | null }): AuthorizationUnit {
	return row.task_group_id === null ? { kind: "task", id: row.id } : { kind: "group", id: row.task_group_id };
}

function unitKey(unit: AuthorizationUnit): string {
	return `${unit.kind}:${unit.id}`;
}

// ---- requests ----

/**
 * Syncs the unit's authorization and resolves once a pass that read data newer than this request has
 * finished. Never awaited from inside a pass or a task turn: use requestAuthorizationSync there.
 */
export function syncAuthorization(core: ClusterCore, unit: AuthorizationUnit): Promise<void> {
	core.assertOutsideTaskTurn("syncAuthorization");
	// Tracked, so close() and drain() wait for the pass before the database goes away.
	return core.trackHandler(core.authorizationSync.run(unitKey(unit), () => authorizationPass(core, unit)));
}

/** Asks for a sync without waiting for it; safe anywhere, including inside a pass. */
export function requestAuthorizationSync(core: ClusterCore, unit: AuthorizationUnit): void {
	core.background(
		"authorization sync failed",
		core.authorizationSync.run(unitKey(unit), () => authorizationPass(core, unit)),
	);
}

/** Syncs every unit with a task waiting on this node: its trust summary changed or it reconnected. */
export async function syncNodeAuthorizations(core: ClusterCore, nodeId: string): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select(["id", "task_group_id"])
		.where("node_id", "=", nodeId)
		.where("state", "=", "awaiting_authorization")
		.execute();
	await Promise.all(uniqueUnits(rows).map((unit) => syncAuthorization(core, unit)));
}

function uniqueUnits(rows: readonly { id: string; task_group_id: string | null }[]): AuthorizationUnit[] {
	const units = new Map<string, AuthorizationUnit>();
	for (const row of rows) {
		const unit = unitOf(row);
		units.set(unitKey(unit), unit);
	}
	return [...units.values()];
}

/**
 * The first dispatch of a privileged task on a forward node, after its approval: the task moves to
 * `awaiting_authorization` with no options yet (the WebUI shows it as being prepared) and its input
 * stored, then its unit is synced. Called outside any turn.
 */
export async function startAuthorization(
	core: ClusterCore,
	id: string,
	inputBytes: Uint8Array,
	from: readonly TaskRowState[],
): Promise<void> {
	const unit = await core.taskQueue.run(id, async (): Promise<AuthorizationUnit | null> => {
		const row = await core.row(id);
		if (!row || !from.includes(row.state)) return null;
		if (await groupEnded(core, row.task_group_id)) return null;
		const record = parseTaskAuthorization(row.authorization) ?? emptyRecord(row);
		const moved = await updateTask(
			core,
			id,
			from,
			{
				state: "awaiting_authorization",
				authorization: serializeTaskAuthorization({ ...record, options: [], updatedAt: new Date().toISOString() }),
				pending_input: pendingInputColumn(inputBytes),
				dispatched_at: null,
				handler_type: "user",
				handler_session_id: null,
			},
			row.rev,
		);
		if (!moved) return null;
		core.background("task group state update failed", syncGroupState(core, row.task_group_id));
		return unitOf(row);
	});
	if (unit) await syncAuthorization(core, unit);
}

/**
 * POST /api/authorizations: checks a user's authorization and stores it (for display and reuse). Only the
 * failures the caller can fix are synchronous (the signature, the deadline and the issuer's clock); the
 * units it may cover are synced in the background, and the outcome shows up in the task states
 * (doc/design/privilege.md "Server-side authorization"). A unit whose node is away is not waited for:
 * the node's next report syncs it again.
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
	const owner = await core.db.selectFrom("users").select("org_id").where("id", "=", user.userId).executeTakeFirst();
	if (!owner) throw new NotFoundError("no such user");
	const stored = await insertOwnerAuthorization(core, user.userId, owner.org_id, submitted);
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
	// Tracked by the core, so close() waits for the syncs before the database is destroyed.
	core.background("authorization sync failed", syncSubmitted(core, user.userId, submitted));
	return { id: submitted.id };
}

/** Syncs the user's waiting units a submitted authorization names. */
async function syncSubmitted(core: ClusterCore, userId: string, submitted: SubmittedAuthorization): Promise<void> {
	let query = core.db
		.selectFrom("tasks")
		.select(["id", "task_group_id"])
		.where("on_behalf_of_user_id", "=", userId)
		.where("state", "=", "awaiting_authorization");
	// A one-shot authorization names its tasks; a reusable one is judged by the planner for every wait.
	const taskIds = submitted.payload.taskIds;
	if (taskIds !== null) {
		if (taskIds.length === 0) return;
		query = query.where("id", "in", taskIds);
	}
	const rows = await query.execute();
	await Promise.all(uniqueUnits(rows).map((unit) => syncAuthorization(core, unit)));
}

/**
 * The periodic and startup sweep: syncs every waiting unit that has no options yet (crhs stopped in the
 * middle of a pass) or whose sign payload is due for a refresh (its timer died with the process).
 * Returns how many units it asked for.
 */
export function syncStaleAuthorizationWaits(core: ClusterCore, rows: readonly Selectable<TasksTable>[]): number {
	const now = Date.now();
	const stale = rows.filter((row) => {
		const record = parseTaskAuthorization(row.authorization);
		if (!record || record.options.length === 0) return true;
		return record.options.some((option) => {
			if (option.kind !== "sign" || option.payload === null) return false;
			const refreshAt = refreshAtOf(option.payload.payload);
			return refreshAt !== null && refreshAt <= now;
		});
	});
	const units = uniqueUnits(stale);
	for (const unit of units) requestAuthorizationSync(core, unit);
	return units.length;
}

// ---- one pass ----

/** One waiting task as a pass read it: the row (its rev is what the writes check) and the planner's view. */
interface PassTask {
	row: Selectable<TasksTable>;
	task: PlannerTask;
}

/** What a pass read for its unit. */
interface PassInput {
	ownerId: string;
	/** When the unit was created (ms): the start of its signature count. */
	since: number;
	tasks: PassTask[];
	/** The sign payload the unit's tasks offer now, if any. */
	current: BuiltAuthorization | null;
}

/** One sync pass of a unit: read, plan, apply. */
async function authorizationPass(core: ClusterCore, unit: AuthorizationUnit): Promise<void> {
	const input = await readUnit(core, unit);
	if (!input) {
		clearRefresh(core, unit);
		return;
	}
	const plan = await planAuthorization({
		target:
			unit.kind === "task"
				? { kind: "task", task: (input.tasks[0] as PassTask).task }
				: {
						kind: "group",
						group: { spec: (input.tasks[0] as PassTask).task.spec, tasks: input.tasks.map((entry) => entry.task) },
					},
		owner: await ownerSigningCredentials(core.db, input.ownerId),
		keys: core.signingKeys.keys,
		stored: await loadStoredOwnerAuthorizations(core, input.ownerId, {
			since: input.since,
			taskIds: input.tasks.map((entry) => entry.row.id),
		}),
		since: input.since,
		current: input.current,
		now: Date.now(),
	});
	const again = await applyPlan(core, unit, input, plan);
	if (again) requestAuthorizationSync(core, unit);
}

/**
 * Reads the unit's waiting tasks. Tasks that cannot be planned are settled here: a damaged spec or a
 * node whose privileged mode reports unavailable ends the task, a node that never reported is left
 * waiting for its first report. A group whose owner rejected its authorization rejects its waiting tasks
 * instead. Returns null when nothing is left to plan.
 */
async function readUnit(core: ClusterCore, unit: AuthorizationUnit): Promise<PassInput | null> {
	let rows: Selectable<TasksTable>[];
	let since: number;
	let ownerId: string;
	if (unit.kind === "task") {
		const row = await core.row(unit.id);
		if (row?.state !== "awaiting_authorization" || row.task_group_id !== null) return null;
		rows = [row];
		since = Date.parse(row.created_at);
		ownerId = row.on_behalf_of_user_id;
	} else {
		const group = await core.db
			.selectFrom("task_groups")
			.select(["id", "state", "created_at", "on_behalf_of_user_id"])
			.where("id", "=", unit.id)
			.executeTakeFirst();
		if (!group || (await groupEnded(core, group.id))) return null;
		rows = await core.db
			.selectFrom("tasks")
			.selectAll()
			.where("task_group_id", "=", unit.id)
			.where("state", "=", "awaiting_authorization")
			.orderBy("created_at")
			.execute();
		since = Date.parse(group.created_at);
		ownerId = group.on_behalf_of_user_id;
		// The owner rejected the group's wait: a member that waits again (crha refused it after the
		// rejection) ends the same way instead of asking anew (doc/design/privilege.md "Waiting for signatures").
		const rejection = core.groupRejection?.(unit.id);
		if (rejection) {
			for (const row of rows) {
				await rejectAuthorizationWait(core, row.id, rejection.reason, rejection.by, { audit: false });
			}
			return null;
		}
	}
	const tasks: PassTask[] = [];
	for (const row of rows) {
		const task = await plannerTask(core, row);
		if (task) tasks.push({ row, task });
	}
	if (tasks.length === 0) return null;
	return { ownerId, since, tasks, current: currentPayload(tasks) };
}

/** The planner's view of one waiting task, or null when the task cannot be planned now. */
async function plannerTask(core: ClusterCore, row: Selectable<TasksTable>): Promise<PlannerTask | null> {
	let spec: TaskSpec;
	try {
		spec = specFromRow(row.spec, "task");
	} catch (err) {
		await endInPass(core, row, "errored", "invalid_spec", `the stored spec cannot be read: ${String(err)}`);
		return null;
	}
	const node = await getNode(core.db, row.node_id);
	if (!node) return null;
	const report = parseTrustReport(node.trust_report);
	// No report yet: the node's first report syncs the unit again (doc/design/privilege.md "Trust cache").
	if (!report) return null;
	if (report.kind !== "ok") {
		await endInPass(core, row, "errored", "privileged_unavailable", trustUnavailableMessage(report));
		return null;
	}
	const record = parseTaskAuthorization(row.authorization);
	const groups: PlannerNodeGroup[] = ((await nodeGroupsForNodes(core.db, [node.id])).get(node.id) ?? []).map(
		(group) => ({ id: group.id, name: group.name }),
	);
	return {
		id: row.id,
		attempt: row.attempt,
		spec,
		node: { id: node.id, name: node.name, summary: report.summary, groups },
		taskGroup: row.task_group_id !== null,
		online: online(core, node.id),
		crhsRejected: record?.crhsRejected ?? null,
		rejectedBefore: record?.rejectedBefore ? Date.parse(record.rejectedBefore) : null,
	};
}

/** Whether the node has a ready connection now (links.ts imports this module, so not its isConnected). */
function online(core: ClusterCore, nodeId: string): boolean {
	const link = core.links.get(nodeId);
	return link !== undefined && link.ready && !link.conn.closed;
}

/** The sign payload the unit's tasks hold now: a group's tasks share one. */
function currentPayload(tasks: readonly PassTask[]): BuiltAuthorization | null {
	for (const { row } of tasks) {
		for (const option of parseTaskAuthorization(row.authorization)?.options ?? []) {
			if (option.kind !== "sign" || option.payload === null) continue;
			try {
				const bytes = Uint8Array.from(Buffer.from(option.payload.payload, "base64"));
				return { bytes, id: option.payload.id, payload: decodeAuthorizationPayload(bytes) };
			} catch {}
		}
	}
	return null;
}

// ---- applying a plan ----

/** Applies a plan; returns whether the unit needs another pass. */
async function applyPlan(
	core: ClusterCore,
	unit: AuthorizationUnit,
	input: PassInput,
	plan: AuthorizationPlan,
): Promise<boolean> {
	switch (plan.kind) {
		case "usable":
			clearRefresh(core, unit);
			return applyUses(core, unit, input, plan.uses);
		case "options":
			return applyOptions(core, unit, input, plan.options, plan.failed, plan.awaitingNode);
		case "failure":
			clearRefresh(core, unit);
			return failTasks(core, input, plan.failures);
	}
}

/**
 * Claims every usable task first, then sends them, each to its node and without waiting: one node's
 * rejection cannot change the attempt of a sibling still being claimed. Tasks the uses do not cover
 * are planned by the next pass.
 */
async function applyUses(
	core: ClusterCore,
	unit: AuthorizationUnit,
	input: PassInput,
	uses: readonly PlannedUse[],
): Promise<boolean> {
	const byId = new Map(input.tasks.map((entry) => [entry.row.id, entry] as const));
	const claims: AuthorizedStart[] = [];
	const cosigned: { use: Extract<PlannedUse, { kind: "stored" }>; ownerId: string }[] = [];
	let stale = false;
	const covered = new Set<string>();
	for (const use of uses) {
		for (const taskId of use.kind === "crhs" ? [use.taskId] : use.taskIds) {
			const entry = byId.get(taskId);
			if (!entry) continue;
			covered.add(taskId);
			const claim = await core.taskQueue.run(taskId, async (): Promise<AuthorizedStart | null> => {
				const fresh = await core.row(taskId);
				if (!unchanged(fresh, entry.row)) {
					stale = true;
					return null;
				}
				const node = await getNode(core.db, fresh.node_id);
				if (!node) return null;
				if (use.kind === "crhs") return claimCrhs(core, fresh, node, use.authorization, use.keyFingerprint);
				const claimed = await claimOwnerAuthorization(
					core,
					fresh,
					node,
					{ id: use.id, payload: use.payload, payloadBytes: use.payloadBytes, signatures: use.signatures },
					use.cosignatures.length > 0,
				);
				if (claimed && use.cosignatures.length > 0) cosigned.push({ use, ownerId: fresh.on_behalf_of_user_id });
				return claimed;
			});
			if (claim) claims.push(claim);
		}
	}
	// crhs's cosignatures are stored with the owner's authorization before the frames leave.
	for (const { use, ownerId } of cosigned) await storeCosignatures(core, use.id, use.cosignatures, ownerId);
	for (const claim of claims) {
		core.background(
			"authorized task.start failed",
			sendAuthorizedStart(core, claim.nodeId, claim.start, claim.input, claim.record, () =>
				requestAuthorizationSync(core, unit),
			),
		);
	}
	return stale || input.tasks.some((entry) => !covered.has(entry.row.id));
}

/**
 * Parks the tasks the options cover with those options (a group's tasks share one sign payload and its
 * attempt), ends the tasks the plan names as failures, and arms the payload's refresh.
 */
async function applyOptions(
	core: ClusterCore,
	unit: AuthorizationUnit,
	input: PassInput,
	options: readonly PlannedOption[],
	failures: readonly PlannedTaskFailure[],
	awaitingNode: readonly string[],
): Promise<boolean> {
	const sign = options.find((option): option is Extract<PlannedOption, { kind: "sign" }> => option.kind === "sign");
	const shared = optionRecords(options);
	let stale = false;
	for (const entry of input.tasks) {
		const failure = failures.find((candidate) => candidate.taskId === entry.row.id);
		if (failure) {
			if (!(await failTask(core, entry, failure))) stale = true;
			continue;
		}
		// The owner already signed for a task whose node is away: it waits for the node, asking nothing.
		const waitsForNode = awaitingNode.includes(entry.row.id);
		const stored: AuthorizationOption[] = waitsForNode ? [{ kind: "awaiting_node" }] : shared;
		const parked = await core.taskQueue.run(entry.row.id, async (): Promise<boolean> => {
			const fresh = await core.row(entry.row.id);
			if (!unchanged(fresh, entry.row)) return false;
			const record = parseTaskAuthorization(fresh.authorization) ?? emptyRecord(fresh);
			// A shared payload carries the highest attempt of the tasks it covers; it only ever raises a
			// waiting task's attempt (the pass read every task it covers at the rev written here).
			const attempt = waitsForNode
				? fresh.attempt
				: Math.max(fresh.attempt, sign?.authorization.payload.attempt ?? fresh.attempt);
			// A pass that comes to the same options writes nothing: the owner keeps what is on the screen.
			if (attempt === fresh.attempt && JSON.stringify(record.options) === JSON.stringify(stored)) return true;
			const written = await updateTask(
				core,
				fresh.id,
				["awaiting_authorization"],
				{
					attempt,
					authorization: serializeTaskAuthorization({
						...record,
						options: stored,
						attempt,
						dispatchedPath: null,
						updatedAt: new Date().toISOString(),
					}),
				},
				fresh.rev,
			);
			if (!written) return false;
			core.background("task group state update failed", syncGroupState(core, fresh.task_group_id));
			// The wait now has its options: the session and the chat card follow (doc/design/agent-runtime.md "Session state").
			core.onChange?.(fresh.actor_id);
			return true;
		});
		if (!parked) stale = true;
	}
	const refreshAt = sign ? signRefreshAtMs(sign.authorization.payload) : null;
	if (refreshAt === null) clearRefresh(core, unit);
	else armRefresh(core, unit, refreshAt);
	return stale;
}

/** Ends the tasks of a failed plan; returns whether a row changed under the pass. */
async function failTasks(
	core: ClusterCore,
	input: PassInput,
	failures: readonly PlannedTaskFailure[],
): Promise<boolean> {
	let stale = false;
	for (const failure of failures) {
		const entry = input.tasks.find((candidate) => candidate.row.id === failure.taskId);
		if (entry && !(await failTask(core, entry, failure))) stale = true;
	}
	return stale;
}

/** Ends one task the plan could not authorize, at the rev the pass read. */
async function failTask(core: ClusterCore, entry: PassTask, failure: PlannedTaskFailure): Promise<boolean> {
	return core.taskQueue.run(entry.row.id, async () => {
		const fresh = await core.row(entry.row.id);
		if (!unchanged(fresh, entry.row)) return false;
		const record = parseTaskAuthorization(fresh.authorization) ?? emptyRecord(fresh);
		if (failure.code === "node_offline") {
			return finishAuthorization(core, fresh.id, fresh, "errored", NODE_OFFLINE, NODE_OFFLINE_MESSAGE, record);
		}
		const alias = failure.code === "alias_missing";
		return finishAuthorization(
			core,
			fresh.id,
			fresh,
			alias ? "errored" : "rejected",
			alias ? ALIAS_MISSING : (record.lastRejection?.code ?? "authorization_required"),
			failureMessage(failure, record),
			record,
		);
	});
}

/** Ends a task the pass cannot plan at all, in its own turn. */
async function endInPass(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	state: "errored",
	code: string,
	message: string,
): Promise<void> {
	await core.taskQueue.run(row.id, async () => {
		const fresh = await core.row(row.id);
		if (!unchanged(fresh, row)) return;
		await finishAuthorization(core, row.id, fresh, state, code, message, parseTaskAuthorization(fresh.authorization));
	});
}

/** Whether the row is still the waiting row the pass planned from. */
function unchanged(
	fresh: Selectable<TasksTable> | undefined,
	planned: Selectable<TasksTable>,
): fresh is Selectable<TasksTable> {
	return fresh?.state === "awaiting_authorization" && fresh.rev === planned.rev;
}

/** The error line of a task no plan could authorize. */
function failureMessage(failure: PlannedTaskFailure, record: TaskAuthorizationRecord): string {
	if (failure.code === "alias_missing") {
		if (failure.groupId !== undefined && failure.groupName !== undefined) {
			return aliasMissingMessage({ groupId: failure.groupId, groupName: failure.groupName });
		}
		return ALIAS_MISSING;
	}
	const rejection = record.lastRejection;
	return rejection ? `${rejection.message}; ${NO_ONE}` : NO_ONE;
}

function emptyRecord(row: Selectable<TasksTable>): TaskAuthorizationRecord {
	return emptyAuthorizationRecord(row.attempt);
}

// ---- sign payload refresh ----

/** The refresh time of a stored payload (base64 CBOR), or null when it cannot be read. */
function refreshAtOf(payloadBase64: string): number | null {
	try {
		return signRefreshAtMs(decodeAuthorizationPayload(Uint8Array.from(Buffer.from(payloadBase64, "base64"))));
	} catch {
		return null;
	}
}

/** Syncs the unit again when its sign payload is due for a refresh; replaces an earlier timer. */
function armRefresh(core: ClusterCore, unit: AuthorizationUnit, atMs: number): void {
	clearRefresh(core, unit);
	const key = unitKey(unit);
	const timer = setTimeout(
		() => {
			core.authorizationRefresh.delete(key);
			if (!core.closing) requestAuthorizationSync(core, unit);
		},
		Math.max(0, atMs - Date.now()),
	);
	timer.unref?.();
	core.authorizationRefresh.set(key, timer);
}

function clearRefresh(core: ClusterCore, unit: AuthorizationUnit): void {
	const key = unitKey(unit);
	const timer = core.authorizationRefresh.get(key);
	if (timer) clearTimeout(timer);
	core.authorizationRefresh.delete(key);
}

// ---- helpers ----

/** An authorization command with its byte hash as hex, for the audit detail. */
function commandForAudit(command: SubmittedAuthorization["payload"]["command"]): Record<string, unknown> | null {
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
