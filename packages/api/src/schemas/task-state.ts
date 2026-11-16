/**
 * The task and task-group state vocabularies (`../tasks.ts`). They live in their own module so the
 * authorization schemas can name a task's state without importing the task views, which name
 * authorizations in turn.
 */
import { z } from "zod";

/**
 * The lifecycle state of a single task (doc/design/execution.md "State machine"). It is the platform's
 * progress, never the command's result: `exited` with a non-zero exit code succeeded at running, and the
 * outcome says whether the command failed.
 */
export const TaskStateSchema = z
	.enum([
		// Waits for an approval (a person, an ancestor agent or Auto Review).
		"awaiting_approval",
		// Waits for a signature.
		"awaiting_authorization",
		// Released to the node, not yet started.
		"dispatched",
		// The command runs on the node.
		"running",
		// The command ran and reported an exit code, including non-zero; success is the outcome, not the state.
		"exited",
		// The platform could not run or finish the command (node offline, connection failure, interrupted
		// dispatch, lost access); no exit code of the command.
		"errored",
		// A person or Auto Review rejected it.
		"rejected",
		// A rule denied it when it was created.
		"denied",
		// Cancelled before, while waiting or while running; a run that started keeps its exit code, signal
		// and output.
		"cancelled",
		// A signature wait timed out.
		"expired",
		// The node lost contact; whether the command finished is not known.
		"unknown",
	])
	.meta({
		description: [
			"The lifecycle state of a task (see doc/design/execution.md, State machine); the outcome says whether the command failed.",
			"",
			"- `awaiting_approval`: waits for an approval (a person, an ancestor agent or Auto Review).",
			"- `awaiting_authorization`: waits for a signature.",
			"- `dispatched`: released to the node, not yet started.",
			"- `running`: the command runs on the node.",
			"- `exited`: the command ran and reported an exit code, including non-zero; success is the outcome, not the state.",
			"- `errored`: the platform could not run or finish the command (node offline, connection failure, interrupted dispatch, lost access); no exit code of the command.",
			"- `rejected`: a person or Auto Review rejected it.",
			"- `denied`: a rule denied it when it was created.",
			"- `cancelled`: cancelled before, while waiting or while running; a run that started keeps its exit code, signal and output.",
			"- `expired`: a signature wait timed out.",
			"- `unknown`: the node lost contact; whether the command finished is not known.",
		].join("\n"),
	});

/** How much output crhs keeps for a task (doc/design/execution.md "Output"). */
export const OutputModeSchema = z.enum(["full", "text", "status", "head"]);

/** A task group is a batch, so it chooses between the two batch modes only. */
export const BatchOutputModeSchema = z.enum(["status", "text", "head"]);

/** The lifecycle state of a task group (doc/design/execution.md "Task groups"). */
export const TaskGroupStateSchema = z
	.enum([
		// Waits for an approval (a person, an ancestor agent or Auto Review).
		"awaiting_approval",
		// Waits for a signature.
		"awaiting_authorization",
		// The batch is released; members are dispatched or running.
		"running",
		// Every member ended; the outcome says whether any failed.
		"finished",
		// A restart or internal error ended the batch.
		"interrupted",
		// A person or Auto Review rejected it.
		"rejected",
		// Cancelled before or while running.
		"cancelled",
	])
	.meta({
		description: [
			"The lifecycle state of a task group (see doc/design/execution.md, Task groups).",
			"",
			"- `awaiting_approval`: waits for an approval (a person, an ancestor agent or Auto Review).",
			"- `awaiting_authorization`: waits for a signature.",
			"- `running`: members are dispatched or running.",
			"- `finished`: every member ended; the outcome says whether any failed.",
			"- `interrupted`: a restart or internal error ended the batch.",
			"- `rejected`: a person or Auto Review rejected it.",
			"- `cancelled`: cancelled before or while running.",
		].join("\n"),
	});
