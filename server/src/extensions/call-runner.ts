/**
 * The runner behind a `call` job (doc/design/jobs.md "Background extension calls"): the extension request runs here,
 * owned by crhs, not by the tool invocation that started it. The invocation only waits on it, so a request outlives
 * the tool returning and an approval decided after the invocation went still starts it.
 *
 * One runner exists per process, created by the composition root and injected with the job service, the runtime and
 * the MCP surface, keyed by the external call id. Every call holds its own abort controllers: one
 * for the approval wait (a shutdown stops waiting without cancelling the pending approval) and one for the request
 * itself (cancelling sends the MCP cancellation). The runner finishes the `external_calls` row exactly as the tool
 * used to: the state, `external_call.finished`, `unknown` on a lost or aborted call, and the converted
 * model-facing result, which it hands to the job layer through `CallJobSink` so `job_wait` can return it.
 *
 * The tools and jobs layers are not imported at runtime here: the result conversion and the job sink arrive with
 * each start (doc/design/jobs.md "Adapters").
 */
import type { Audit, AuditActor } from "../audit/audit.ts";
import type { ImageCache } from "../library/image-cache.ts";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import { errorResult, type ToolResult, textResult } from "../util/tool-result.ts";
import {
	cancelWaitingExternalCall,
	type ExternalCallRow,
	externalCallApproval,
	externalCallPhase,
	finishExternalCall,
	getExternalCall,
	waitExternalCall,
} from "./external-calls.ts";
import {
	type Extension,
	ExtensionCallLostError,
	type ExtensionIdentity,
	ExtensionToolError,
	ExtensionUnavailableError,
} from "./model.ts";
import { extensionsForUser } from "./store.ts";

/** How a call's raw result becomes the cluster tools' output form (the tools layer supplies it). */
export type CallResultConverter = (
	result: unknown,
	options: { extension: string; tool: string; imageCache?: ImageCache },
) => Promise<ToolResult>;

/** What the runner needs from the job layer: keep the model-facing result and project the job. */
export interface CallJobSink {
	/** Stores the result in `jobs.result` and projects the job (Jobs.callResult). */
	callResult(callKey: string, result: ToolResult): Promise<void>;
	/** Projects the job after its external call changed state (Jobs.callChanged). */
	callChanged(callKey: string): Promise<void>;
}

/** Everything one call needs to run to its end. */
export interface CallStartInput {
	db: Db;
	/** The durable tool call's key, the same one the external call row and the job derive from. */
	callKey: string;
	/** The row as the tool invocation created or found it. */
	row: ExternalCallRow;
	extension: Extension;
	tool: string;
	arguments: Record<string, unknown>;
	/** The acting user; availability is checked again after an approval, as it always was. */
	userId: string;
	/** The identity headers of the MCP request. */
	identity?: ExtensionIdentity;
	convert: CallResultConverter;
	imageCache?: ImageCache;
	jobs?: CallJobSink;
	audit?: Audit;
}

/** How a call ended: its final row and the model-facing result, when one was produced. */
export interface CallOutcome {
	row: ExternalCallRow;
	/** What the tool returns: the converted result or the note of a call that never ran. */
	result?: ToolResult;
	/** An unexpected failure of the extension machinery; the foreground tool rethrows it as before. */
	error?: unknown;
}

/** One in-flight call: the handle the tool invocation, `job_wait` and job cancellation share. */
export interface RunningCall {
	readonly callId: string;
	readonly callKey: string;
	/** Resolves once the row is terminal or the runner stopped waiting at shutdown; never rejects. */
	readonly done: Promise<CallOutcome>;
	/** How the call stands right now. */
	readonly state: "awaiting_approval" | "running" | "settled";
	/** Waits up to `ms` for the call to settle; false at the deadline or on abort. Never stops the call. */
	wait(ms: number, signal?: AbortSignal): Promise<boolean>;
	/** Cancels a waiting call or aborts a running request (MCP cancellation); true when something was stopped. */
	abort(reason: string): Promise<boolean>;
}

/** The label every note and result names the call by. */
export function callLabel(row: Pick<ExternalCallRow, "extension_name" | "tool_name">): string {
	return `${row.extension_name}/${row.tool_name}`;
}

/** The WebUI's details of a call: the external call id, its extension and its tool. */
export function callDetails(row: ExternalCallRow): Record<string, unknown> {
	return { extension: row.extension_name, tool: row.tool_name, external_call_id: row.id };
}

/** Adds the external call id to a converted result's details, where the WebUI finds it. */
export function withCallDetails(result: ToolResult, row: ExternalCallRow): ToolResult {
	return { ...result, details: { ...callDetails(row), ...(result.details ?? {}) } };
}

/**
 * The note of a call still waiting for approval, with the link the WebUI opens and the job id to follow; a call
 * Auto Review is still judging reads as running (doc/design/jobs.md "States").
 */
export function callWaitingResult(
	row: ExternalCallRow,
	jobId: string | undefined,
	url: (id: string) => string,
): ToolResult {
	const label = callLabel(row);
	if (externalCallPhase(row) === "reviewing") return callRunningResult(row, jobId);
	const link = `${label}, waiting for approval: ${url(row.id)}`;
	const follow = jobId === undefined ? undefined : `job ${jobId}: call job_wait with this id`;
	return textResult([{ note: `[${[...[link, follow].filter((part) => part !== undefined)].join(", ")}]` }], {
		details: callDetails(row),
	});
}

/** The note of a call that is still running: the job id is the model-facing handle. */
export function callRunningResult(row: ExternalCallRow, jobId: string | undefined): ToolResult {
	const follow = jobId === undefined ? "still running" : `still running, job ${jobId}: call job_wait with this id`;
	return textResult([{ note: `[${callLabel(row)}, ${follow}]` }], { details: callDetails(row) });
}

/**
 * A settled call whose MCP result was not kept by this runner (a replay after a restart, or a job created late).
 * Rejected and cancelled calls never reached the extension; unknown ones may have.
 */
export function settledCallResult(row: ExternalCallRow): ToolResult {
	const label = callLabel(row);
	const details = callDetails(row);
	switch (row.state) {
		case "rejected":
			return errorResult(
				"text",
				"rejected",
				externalCallApproval(row)?.decision?.reason ?? "rejected by the user",
				details,
			);
		case "cancelled":
			return errorResult("text", "cancelled", "the call was cancelled before it ran", details);
		case "unknown":
			return errorResult(
				"text",
				"unknown",
				"crhs stopped while the call was in flight; its outcome is unknown and it was not sent again",
				details,
			);
		case "failed":
			return errorResult("text", "error", "the call failed", details);
		default:
			return textResult(
				[
					{
						note: `[${label}: the call finished before its result was kept, and the extension was not called again]`,
					},
				],
				{ details },
			);
	}
}

/** The current state of one call as its runner reports it, so a shutdown can be told from a decision. */
function isTerminal(state: ExternalCallRow["state"]): boolean {
	return state !== "awaiting_approval" && state !== "running";
}

class RunningCallImpl implements RunningCall {
	readonly callId: string;
	readonly callKey: string;
	readonly #input: CallStartInput;
	/** Stops the approval wait without cancelling a pending approval (shutdown). */
	readonly #approvalAbort = new AbortController();
	/** Aborts the request; the MCP transport turns that into a cancellation. */
	readonly #callAbort = new AbortController();
	#state: RunningCall["state"];
	/** Set when shutdown began: a call that becomes runnable afterwards must not start a request. */
	#closed = false;
	#resolve!: (outcome: CallOutcome) => void;
	readonly done: Promise<CallOutcome>;
	readonly #onDone: (call: RunningCallImpl) => void;

	constructor(input: CallStartInput, onDone: (call: RunningCallImpl) => void) {
		this.#input = input;
		this.callId = input.row.id;
		this.callKey = input.callKey;
		this.#state = input.row.state === "awaiting_approval" ? "awaiting_approval" : "running";
		this.#onDone = onDone;
		this.done = new Promise<CallOutcome>((resolve) => {
			this.#resolve = resolve;
		});
		void this.#run();
	}

	get state(): RunningCall["state"] {
		return this.#state;
	}

	/** The session tree this call belongs to; undefined for an API token's call. */
	get session(): string | undefined {
		const { actor_type, actor_id } = this.#input.row;
		return actor_type === "session" || actor_type === "subagent" ? actor_id : undefined;
	}

	wait(ms: number, signal?: AbortSignal): Promise<boolean> {
		if (this.#state === "settled") return Promise.resolve(true);
		if (signal?.aborted) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			let finished = false;
			const finish = (settled: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(settled);
			};
			const onAbort = () => finish(false);
			// A zero budget asks for the current state; the call keeps running.
			const timer = setTimeout(() => finish(false), Math.max(0, ms));
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			void this.done.then(() => finish(true));
			if (ms <= 0) finish(false);
		});
	}

	async abort(reason: string): Promise<boolean> {
		const row = (await getExternalCall(this.#input.db, this.callId)) ?? this.#input.row;
		if (row.state === "awaiting_approval") {
			const cancelled = await cancelWaitingExternalCall(this.#input.db, this.callId);
			if (cancelled) this.#audit(row, "cancelled", reason);
			this.#approvalAbort.abort();
			// The approval may have won the race: a cancel that arrived first must still stop the request.
			if (!cancelled) this.#callAbort.abort();
			return cancelled;
		}
		if (row.state !== "running") return false;
		this.#callAbort.abort();
		return true;
	}

	/** Stops without deciding the call: a waiting approval stays for the next process (shutdown). */
	stopWaiting(): void {
		this.#approvalAbort.abort();
	}

	/** Aborts the request of this call: a shutdown never leaves a request running into a destroyed database. */
	abortCall(): void {
		this.#closed = true;
		if (this.#state === "running") this.#callAbort.abort();
	}

	async #run(): Promise<void> {
		let outcome: CallOutcome;
		try {
			outcome = await this.#execute();
		} catch (err) {
			// Only the finish path can reach here; report unknown rather than losing the row.
			console.error(`extensions: finishing the call ${this.callId} failed:`, err);
			outcome = { row: this.#input.row, error: err };
		}
		this.#state = "settled";
		this.#resolve(outcome);
		this.#onDone(this);
	}

	async #execute(): Promise<CallOutcome> {
		const { db, row: initial, jobs } = this.#input;
		let row = initial;
		if (row.state === "running") {
			// The caller may hold a row it read before another attempt (or the previous process) finished the
			// call. A runner that finished wrote its terminal row before it left the registry, so starting from
			// the stale `running` row would call the extension a second time (doc/design/jobs.md "Background
			// extension calls"). A freshly allowed call's row is still `running`, so only a terminal row settles.
			const current = await getExternalCall(db, row.id);
			if (current && isTerminal(current.state)) return this.#settled(current);
		}
		if (row.state === "awaiting_approval") {
			row = await waitExternalCall(db, row.id, {
				signal: this.#approvalAbort.signal,
				// A shutdown stops waiting; it must not decide a pending approval (main.ts recovers requests later).
				cancelOnAbort: false,
			});
			if (row.state === "awaiting_approval") {
				// The wait was stopped without a decision: leave the job waiting and the row on the approvals page.
				return { row };
			}
			if (row.state === "running") {
				this.#state = "running";
				// The approval is a state change the job projection must see before the request runs.
				await jobs?.callChanged(this.callKey);
			}
		}
		if (row.state !== "running") return this.#settled(row);
		return this.#runRequest(row);
	}

	async #runRequest(row: ExternalCallRow): Promise<CallOutcome> {
		if (this.#closed || this.#callAbort.signal.aborted) {
			return this.#failed(row, "unknown", "the call was aborted", "unknown");
		}
		// An approval may have waited a long time: read the user's availability again instead of trusting the
		// dispatch snapshot, and re-check the tool the call was judged on (doc/design/extensions.md "External calls").
		if (this.#input.row.state === "awaiting_approval") {
			const available = await extensionsForUser(this.#input.db, this.#input.userId);
			if (!available.some((candidate) => candidate.name === this.#input.extension.name)) {
				return this.#failed(
					row,
					"failed",
					`the extension ${this.#input.extension.name} is no longer available to you`,
					"unavailable",
				);
			}
			try {
				await this.#input.extension.prepareCall();
			} catch (err) {
				return this.#failed(
					row,
					"failed",
					`the extension ${this.#input.extension.name} is unavailable: ${(err as Error).message}`,
					"unavailable",
				);
			}
			const current = this.#input.extension.tools().find((candidate) => candidate.name === this.#input.tool);
			if (!current) {
				return this.#failed(
					row,
					"failed",
					`the extension ${this.#input.extension.name} has no tool named ${this.#input.tool}`,
					"unknown_tool",
				);
			}
			if (row.tool_rev !== null && current.rev !== undefined && current.rev !== row.tool_rev) {
				return this.#failed(row, "failed", toolChangedMessage(this.#input.extension.name, current), "tool_changed");
			}
		}
		let value: unknown;
		if (this.#closed || this.#callAbort.signal.aborted) {
			return this.#failed(row, "unknown", "the call was aborted", "unknown");
		}
		try {
			value = await this.#input.extension.call(this.#input.tool, this.#input.arguments, {
				signal: this.#callAbort.signal,
				...(this.#input.identity ? { identity: this.#input.identity } : {}),
				builtin: {
					db: this.#input.db,
					actor: {
						type: row.actor_type,
						id: row.actor_id,
						onBehalfOfUserId: row.on_behalf_of_user_id,
					},
				},
			});
		} catch (err) {
			return this.#callError(row, err);
		}
		let converted: ToolResult;
		try {
			converted = await this.#input.convert(value, {
				extension: this.#input.extension.name,
				tool: this.#input.tool,
				...(this.#input.imageCache ? { imageCache: this.#input.imageCache } : {}),
			});
		} catch (err) {
			// The call reached the server but its result could not be converted; it must not stay running.
			return this.#failed(row, "unknown", "the call's result could not be converted", undefined, err);
		}
		return this.#finish(row, "succeeded", withCallDetails(converted, row));
	}

	/** The result of a call that ended before its request ran (rejected, cancelled or recovered as unknown). */
	async #settled(row: ExternalCallRow): Promise<CallOutcome> {
		const result = withCallDetails(settledCallResult(row), row);
		await this.#storeResult(result);
		return { row, result };
	}

	/** Ends the row through one of the terminal states and stores the result the model gets. */
	async #finish(
		row: ExternalCallRow,
		state: "succeeded" | "failed" | "unknown",
		result: ToolResult,
		error?: unknown,
	): Promise<CallOutcome> {
		try {
			if (!isTerminal(row.state)) {
				await finishExternalCall(this.#input.db, row.id, { state });
				this.#audit(row, state);
			}
		} catch (err) {
			// A failed finish must not hide the result or the error the caller is waiting for: log it and let
			// the next process recover the row.
			console.error("extensions: finishing an extension call failed:", err);
		}
		let current = row;
		try {
			current = (await getExternalCall(this.#input.db, row.id)) ?? row;
		} catch {
			// Keep the row read before the finish; the result itself is still the model's answer.
		}
		await this.#storeResult(result);
		return { row: current, result, ...(error === undefined ? {} : { error }) };
	}

	/** Keeps the model-facing result in the job while the job is kept (doc/design/jobs.md "Results"). */
	async #storeResult(result: ToolResult): Promise<void> {
		try {
			await this.#input.jobs?.callResult(this.callKey, result);
		} catch (err) {
			console.error("extensions: storing an extension call's result failed:", err);
		}
	}

	/** An expected failure before or during the request, in the shape the tool used to return. */
	#callError(row: ExternalCallRow, err: unknown): Promise<CallOutcome> {
		if (err instanceof UserError) {
			return this.#failed(row, "failed", err.message, err.code ?? "invalid_argument");
		}
		if (err instanceof ExtensionUnavailableError) {
			return this.#failed(row, "failed", err.message, "unavailable");
		}
		if (err instanceof ExtensionToolError) {
			return this.#failed(row, "failed", err.message, "tool_error");
		}
		if (err instanceof ExtensionCallLostError) {
			// A lost, timed-out or aborted call may have run: unknown, and never repeated.
			return this.#failed(row, "unknown", `${err.message}; its outcome is unknown and it was not retried`, "unknown");
		}
		console.error(`extensions: the call ${callLabel(row)} failed unexpectedly:`, err);
		return this.#failed(
			row,
			"unknown",
			"the call failed unexpectedly; its outcome is unknown and it was not retried",
			"unknown",
			err,
		);
	}

	async #failed(
		row: ExternalCallRow,
		state: "failed" | "unknown",
		message: string,
		code = "error",
		error?: unknown,
	): Promise<CallOutcome> {
		return this.#finish(row, state, errorResult("text", code, message, callDetails(row)), error);
	}

	#audit(row: ExternalCallRow, state: string, reason?: string): void {
		const actor: AuditActor = {
			type: row.actor_type,
			id: row.actor_id,
			onBehalfOfUserId: row.on_behalf_of_user_id,
		};
		void this.#input.audit?.record({
			actor,
			action: "external_call.finished",
			target: { type: "external_call", id: row.id },
			detail: {
				extension: row.extension_name,
				tool: row.tool_name,
				state,
				...(reason === undefined ? {} : { reason }),
			},
		});
	}
}

/** The answer to a call made against a tool definition that changed while it waited. */
function toolChangedMessage(extension: string, tool: { name: string; inputSchema: Record<string, unknown> }): string {
	return (
		`the tool ${extension}/${tool.name} changed since the call was made, so it was not run; check its current input ` +
		`schema and call it again: ${JSON.stringify(tool.inputSchema)}`
	);
}

/** The crhs-owned calls of this process (doc/design/jobs.md "Background extension calls"). Keyed by external call id,
 * so a replayed tool call, `job_wait` and a cancellation all find the same in-flight call.
 */
export class CallRunner {
	readonly #calls = new Map<string, RunningCallImpl>();

	/** Starts a call once it is allowed or approved, or returns the one already in flight for its row. */
	start(input: CallStartInput): RunningCall {
		const existing = this.#calls.get(input.row.id);
		if (existing) return existing;
		const call = new RunningCallImpl(input, (finished) => {
			if (this.#calls.get(finished.callId) === finished) this.#calls.delete(finished.callId);
		});
		this.#calls.set(input.row.id, call);
		return call;
	}

	get callCount(): number {
		return this.#calls.size;
	}

	/** The in-flight call of an external call row, if this process has one. */
	get(callId: string): RunningCall | undefined {
		return this.#calls.get(callId);
	}

	/** Waits up to `ms` for the call to settle; false when it is not in flight here or the deadline passed. */
	async wait(callId: string, ms: number, signal?: AbortSignal): Promise<boolean> {
		const call = this.#calls.get(callId);
		if (!call) return false;
		return call.wait(ms, signal);
	}

	/** Cancels a waiting call or aborts its request; false when this process holds no live call for the row. */
	async cancel(callId: string, reason: string): Promise<boolean> {
		const call = this.#calls.get(callId);
		if (!call) return false;
		const stopped = await call.abort(reason);
		// Its row and job result are written before the caller reads them, as a cancelled task's state is.
		if (stopped) await call.done;
		return stopped;
	}

	/** Stops every in-flight call of a session tree (stopping a session, doc/design/jobs.md "Lifecycle"). */
	async abortSessions(sessions: readonly string[], reason: string): Promise<void> {
		const ids = new Set(sessions);
		await Promise.all(
			[...this.#calls.values()]
				.filter((call) => call.session !== undefined && ids.has(call.session))
				.map(async (call) => {
					await call.abort(reason);
					// Its row and job result are written before the stop returns, as the cancelled tasks are.
					await call.done;
				}),
		);
	}

	/**
	 * Shutdown: stop waiting for approvals (leaving them for the next process), abort requests still in flight and
	 * wait until every call has written its row and result, before the database closes.
	 */
	async shutdown(): Promise<void> {
		const calls = [...this.#calls.values()];
		for (const call of calls) {
			call.stopWaiting();
			call.abortCall();
		}
		await Promise.allSettled(calls.map((call) => call.done));
	}

	/** Waits for the in-flight calls to finish without stopping them (a caller that only needs the writes). */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.#calls.values()].map((call) => call.done));
	}
}
