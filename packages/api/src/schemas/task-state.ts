/**
 * The task and task-group state vocabularies (`../tasks.ts`). They live in their own module so the
 * authorization schemas can name a task's state without importing the task views, which name
 * authorizations in turn.
 */
import { z } from "zod";

/** The state of a single task (doc/design/execution.md). */
export const TaskStateSchema = z.enum([
	"awaiting_approval",
	"awaiting_authorization",
	"denied",
	"dispatched",
	"running",
	"exited",
	"failed",
	"rejected",
	"unknown",
]);

/** How much output crhs keeps for a task (doc/design/execution.md "Output"). */
export const OutputModeSchema = z.enum(["full", "text", "status", "head"]);

/** A task group is a batch, so it chooses between the two batch modes only. */
export const BatchOutputModeSchema = z.enum(["status", "text", "head"]);

export const TaskGroupStateSchema = z.enum([
	"awaiting_approval",
	"awaiting_authorization",
	"running",
	"finished",
	"interrupted",
	"rejected",
	"cancelled",
]);
