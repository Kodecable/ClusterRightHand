/**
 * A task row as the API and the tools see it (doc/design/protocol.md "Task results"): the stored columns, with
 * the output of a running task taken from its live record when there is one.
 */
import { type JsonTaskResult, taskResultFromJson, taskResultToJson } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { RuleRef } from "../policy/store.ts";
import type { TasksTable } from "../storage/schema.ts";
import { authorizationView } from "./authorization.ts";
import type { OutputSnapshot } from "./batch-output.ts";
import type { Live } from "./live-output.ts";
import { countOutputLines } from "./output.ts";
import { operationOfJson, summarize } from "./spec.ts";
import { type ApprovalRecord, type TaskView, TERMINAL } from "./types.ts";

export function toView(row: Selectable<TasksTable>, live: Live | undefined): TaskView {
	const b64 = (s: string | null) => (s ? Buffer.from(s, "base64").toString("utf8") : "");
	const fromLive = live && !TERMINAL.has(row.state);
	const text = (b: Buffer | null) => (b ? b.toString("utf8") : "");
	const output = fromLive ? live.output.snapshot() : undefined;
	const outputTail = output ? text(output.outputTail) : b64(row.output_tail);
	return {
		id: row.id,
		nodeId: row.node_id,
		kind: row.kind,
		summary: summarize(row.spec),
		operation: operationOfJson(row.spec),
		actorType: row.actor_type,
		actorId: row.actor_id,
		onBehalfOfUserId: row.on_behalf_of_user_id,
		state: row.state,
		exitCode: row.exit_code,
		signal: row.signal,
		timedOut: row.timed_out === 1,
		cancelled: row.cancelled === 1,
		timeoutMs: row.timeout_ms,
		errorCode: row.error_code,
		errorMessage: row.error_message,
		outputBytes: output ? output.outputBytes : Number(row.output_bytes),
		outputHead: output ? text(output.outputHead) : b64(row.output_head),
		// Text mode puts the kept tail here; the other modes leave it empty.
		outputTail,
		outputTailLines: countOutputLines(outputTail),
		outputLines: row.output_lines === null ? null : Number(row.output_lines),
		notice: row.notice,
		maxLines: row.max_lines,
		maxBytes: row.max_bytes,
		outputFile: row.output_file,
		outputMode: row.output_mode,
		privileged: row.privileged === 1,
		authorization: authorizationView(row.authorization),
		result: taskResultView(row.result),
		createdAt: row.created_at,
		finishedAt: row.finished_at,
		taskGroupId: row.task_group_id,
		ruleChain: row.rule_chain ? (JSON.parse(row.rule_chain) as RuleRef[]) : null,
		approval: row.approval ? (JSON.parse(row.approval) as ApprovalRecord) : null,
		rootSessionId: row.root_session_id,
		handlerType: row.handler_type,
		handlerSessionId: row.handler_session_id,
	};
}

/**
 * The structured result stored on a task row. A row whose JSON cannot be read is shown without a
 * result instead of failing every task view: the column is display data, not part of the protocol.
 */
function taskResultView(json: string | null): JsonTaskResult | null {
	if (json === null) return null;
	try {
		return taskResultToJson(taskResultFromJson(JSON.parse(json)));
	} catch {
		return null;
	}
}

/** The DB columns of an output snapshot; null fields mean the mode keeps no head/tail there. */
export function outputColumns(out: OutputSnapshot) {
	return {
		output_bytes: out.outputBytes,
		output_head: out.outputHead?.toString("base64") ?? null,
		output_tail: out.outputTail?.toString("base64") ?? null,
	};
}
