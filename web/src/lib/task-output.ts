import type { TaskView } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

const TERMINAL = new Set(["exited", "errored", "rejected", "cancelled", "expired", "unknown", "denied"]);

export function isTerminal(state: string): boolean {
	return TERMINAL.has(state);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Combines the stored head and tail of an output stream. `omitted > 0` means a
 * gap sits between them; the caller renders the marker. Overlapping head and
 * tail (short outputs) are de-duplicated. Counts bytes, not characters.
 */
export function joinOutput(
	head: string,
	tail: string,
	totalBytes: number,
): { before: string; after: string; omitted: number } {
	const headBytes = encoder.encode(head);
	if (tail === "" || tail === head) {
		return { before: head, after: "", omitted: Math.max(0, totalBytes - headBytes.length) };
	}
	const tailBytes = encoder.encode(tail);
	const gap = totalBytes - headBytes.length - tailBytes.length;
	if (gap > 0) return { before: head, after: tail, omitted: gap };
	// Overlap: the tail's first -gap bytes were already in the head.
	return { before: head, after: decoder.decode(tailBytes.slice(Math.min(tailBytes.length, -gap))), omitted: 0 };
}

export function outputText(head: string, tail: string, totalBytes: number): string {
	const joined = joinOutput(head, tail, totalBytes);
	return joined.omitted > 0
		? `${joined.before}\n… ${joined.omitted} bytes omitted …\n${joined.after}`
		: joined.before + joined.after;
}

/** How a task's kept output is shown: the single stream's head/tail, or only the node's file. */
export type BatchOutput =
	| { kind: "output"; head: string; tail: string; bytes: number }
	| { kind: "status"; file: string | null };

/** The kept output is one stream: the head and tail the server kept, or a status-only task. */
export function batchOutput(
	task: Pick<TaskView, "outputMode" | "outputHead" | "outputTail" | "outputBytes" | "outputFile">,
): BatchOutput {
	if (task.outputMode === "status") return { kind: "status", file: task.outputFile };
	return { kind: "output", head: task.outputHead, tail: task.outputTail, bytes: task.outputBytes };
}

/**
 * Why a status-only task has no output. A task that ran has its output only on
 * the node (or nowhere, for SSH); a task that never ran has no output to
 * explain. The component translates the key.
 */
export function statusOutputNoteKey(task: Pick<TaskView, "state" | "exitCode" | "signal">): "running" | "none" | "ssh" {
	if (!isTerminal(task.state)) return "running";
	if (task.exitCode === null && task.signal === null) return "none";
	return "ssh";
}

/**
 * The task error codes the UI explains in words. An unknown code stays visible
 * next to the server's message, so a new platform error is still diagnosable
 * before its translation lands. Server messages are not translated.
 */
const TASK_ERROR_LABELS: Record<string, MessageDescriptor> = {
	alias_missing: msg`The node has no alias for this task's node group. Add the node group UUID to aliases in privileged.toml on the node, then run the task again.`,
	node_access_revoked: msg`Access to the node was revoked before the task was dispatched.`,
	/** A task group's own outcome code; it has no platform error behind it. */
	interrupted: msg`Interrupted`,
};

/** One readable line for a task's platform error (doc/design/access-control.md "Ownership, access grants and sharing"). */
export function taskErrorText(i18n: I18n, code: string | null, message: string | null): string {
	const label = code === null ? undefined : TASK_ERROR_LABELS[code];
	if (label !== undefined) return i18n._(label);
	if (code !== null && message !== null && message !== "") return `${code}: ${message}`;
	return code ?? message ?? "";
}
