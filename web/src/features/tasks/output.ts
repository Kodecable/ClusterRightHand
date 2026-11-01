import type { TaskView } from "@/lib/api/types";

const TERMINAL = new Set(["exited", "failed", "rejected", "unknown", "denied"]);

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

/** How a task's kept output is shown: full head/tail, one combined tail, a head, or only the node's file. */
export type BatchOutput =
	| { kind: "full" }
	| { kind: "tail"; text: string; bytes: number }
	| { kind: "head"; text: string; bytes: number }
	| { kind: "status"; file: string | null };

/** Interprets the head/tail fields by the task's output mode (doc/execution-plane.md#输出). */
export function batchOutput(
	task: Pick<TaskView, "outputMode" | "stdoutHead" | "stdoutTail" | "stdoutBytes" | "stderrBytes" | "outputFile">,
): BatchOutput {
	if (task.outputMode === "text")
		return { kind: "tail", text: task.stdoutTail, bytes: task.stdoutBytes + task.stderrBytes };
	// A file operation keeps each node's head, so its page can be continued from that node's next line.
	if (task.outputMode === "head") return { kind: "head", text: task.stdoutHead, bytes: task.stdoutBytes };
	if (task.outputMode === "status") return { kind: "status", file: task.outputFile };
	return { kind: "full" };
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

/** How a task ended, structured so the UI can translate it. */
export type TaskOutcome =
	| { kind: "exit"; code: number | null }
	| { kind: "signal"; signal: string }
	| { kind: "timed-out" }
	| { kind: "cancelled" }
	| { kind: "error"; code: string | null; message: string | null }
	| { kind: "state"; state: string };

export function taskOutcome(task: TaskView): TaskOutcome {
	if (task.state === "exited") {
		if (task.timedOut) return { kind: "timed-out" };
		if (task.cancelled) return { kind: "cancelled" };
		if (task.signal !== null) return { kind: "signal", signal: task.signal };
		return { kind: "exit", code: task.exitCode };
	}
	if (task.errorCode !== null || task.errorMessage !== null) {
		return { kind: "error", code: task.errorCode, message: task.errorMessage };
	}
	return { kind: "state", state: task.state };
}
