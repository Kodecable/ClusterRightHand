/**
 * Runtime schemas for tasks and task groups (`../tasks.ts`,
 * doc/design/execution.md, doc/design/access-control.md "Approvals"). The task result schema mirrors the
 * protocol's JSON result (`@crh/protocol`); the protocol stays the authority for what crha reports.
 */
import { z } from "zod";
import { ApprovalRequestSchema } from "./approval-request.ts";
import { TaskAuthorizationViewSchema } from "./authorizations.ts";
import { cursorPageSchema, IdParamSchema, RefMapSchema } from "./common.ts";
import {
	ApprovalPhaseSchema,
	ApprovalRecordSchema,
	OperationSchema,
	RuleRefSchema,
	TaskGroupApprovalRecordSchema,
} from "./policy.ts";
import { RequestSourceSchema } from "./request-source.ts";
import { TaskActionSchema } from "./task-action.ts";
import { TaskOutcomeSchema } from "./task-outcome.ts";
import { BatchOutputModeSchema, OutputModeSchema, TaskGroupStateSchema, TaskStateSchema } from "./task-state.ts";

/** One entry of a `file.list` result (doc/design/protocol.md "Task results"). */
export const FileListEntryViewSchema = z
	.object({
		name: z.string(),
		type: z.string(),
		size: z.number(),
		mode: z.string(),
		mtime: z.string(),
	})
	.meta({ id: "FileListEntryView" });

/** The task's structured result, in the JSON form the API serves (doc/design/protocol.md "Task results"). */
export const TaskResultViewSchema = z
	.discriminatedUnion("kind", [
		z.object({
			kind: z.literal("file.read"),
			from: z.number(),
			to: z.number(),
			eof: z.boolean(),
			total: z.number().nullable(),
			tooLong: z.boolean(),
		}),
		z.object({
			kind: z.literal("file.stat"),
			path: z.string(),
			type: z.string(),
			size: z.number(),
			mode: z.string(),
			uid: z.number(),
			gid: z.number(),
			owner: z.string(),
			group: z.string(),
			mtime: z.string(),
			linkTarget: z.string().nullable(),
		}),
		z.object({
			kind: z.literal("file.list"),
			entries: z.array(FileListEntryViewSchema),
			truncated: z.boolean(),
		}),
		z.object({ kind: z.literal("file.write"), bytes: z.number(), created: z.boolean() }),
		z.object({ kind: z.literal("file.edit"), replacements: z.number() }),
		z.object({ kind: z.literal("file.pull"), size: z.number(), sha256: z.string() }),
	])
	.meta({ id: "TaskResultView" });

export const TaskViewSchema = z
	.object({
		id: z.string(),
		nodeId: z.string(),
		kind: z.string(),
		summary: z.string().describe("One line describing what ran: the command line or the path."),
		action: TaskActionSchema.describe("What the task does, as every display surface renders it."),
		source: RequestSourceSchema.describe("Who started the task (the request source)."),
		outcome: TaskOutcomeSchema.nullable().describe("The classified result; null while the task is not terminal."),
		operation: OperationSchema.nullable().describe("What authorization rules match on."),
		actorType: z.string(),
		actorId: z.string(),
		onBehalfOfUserId: z.string(),
		state: TaskStateSchema,
		exitCode: z.number().nullable(),
		signal: z.string().nullable(),
		timedOut: z.boolean(),
		cancelled: z.boolean(),
		timeoutMs: z.number().nullable().describe("The task's timeout in milliseconds; null when it had none."),
		errorCode: z.string().nullable(),
		errorMessage: z.string().nullable(),
		outputBytes: z.number().describe("Bytes of the single output stream."),
		outputHead: z.string().describe('The kept head of the output stream; text mode keeps only a tail, so this is "".'),
		outputTail: z.string().describe("The kept tail of the output stream."),
		outputTailLines: z.number().describe("Lines shown by `outputTail`."),
		outputLines: z.number().nullable().describe("Total lines of the output; null until the node reports it."),
		notice: z.string().nullable().describe("crhs's own note about the task; not part of the output."),
		maxLines: z.number().nullable().describe("The task's output budget; null is the default for its mode."),
		maxBytes: z.number().nullable(),
		outputFile: z.string().nullable(),
		outputMode: OutputModeSchema,
		privileged: z.boolean().describe("Whether this is a privileged task (doc/design/privilege.md)."),
		authorization: TaskAuthorizationViewSchema.nullable().describe("The authorization state of a privileged task."),
		result: TaskResultViewSchema.nullable().describe("The task's structured result; null when it has none."),
		createdAt: z.string(),
		finishedAt: z.string().nullable(),
		taskGroupId: z.string().nullable(),
		ruleChain: z.array(RuleRefSchema).nullable(),
		approval: ApprovalRecordSchema.nullable(),
		rootSessionId: z.string().nullable().describe("The chain's first session, for grouping approvals by session tree."),
		handlerType: z
			.enum(["agent", "user"])
			.nullable()
			.describe("Who handles a waiting approval; null when it is not waiting."),
		handlerSessionId: z.string().nullable(),
		purpose: z.string().nullable().describe("Why a dedicated feature created this task, such as `browse`."),
		phase: ApprovalPhaseSchema.describe(
			"`reviewing` while Auto Review decides and the task counts as running; `awaiting_user` is a user-facing wait; `awaiting_signature` waits for the user's signature.",
		),
	})
	.meta({ id: "TaskView", description: "One task, as the task and approval pages show it." });

export const TaskGroupViewSchema = z
	.object({
		id: z.string(),
		state: TaskGroupStateSchema,
		targets: z.array(z.string()).describe("Stored target UUIDs or `_all`; the display names are in `refs`."),
		refs: RefMapSchema.describe("Display names for the UUID targets; null means the node or node group was deleted."),
		nodeIds: z.array(z.string()),
		parallel: z.number(),
		failFast: z.boolean(),
		outputMode: BatchOutputModeSchema,
		nodeMaxLines: z.number().nullable().describe("Per-node output caps; null means the defaults, 8KB / 128 lines."),
		nodeMaxBytes: z.number().nullable(),
		privileged: z.boolean(),
		skipped: z.array(z.string()),
		tasks: z.array(TaskViewSchema),
		createdAt: z.string(),
		finishedAt: z.string().nullable(),
		summary: z.string().describe("What runs on each node, for display."),
		action: TaskActionSchema.describe("What runs on each node, as every display surface renders it."),
		source: RequestSourceSchema.describe("Who started the task group (the request source)."),
		outcome: TaskOutcomeSchema.nullable().describe("The group's classified result; null while it is not terminal."),
		kind: z.string(),
		ruleChain: z.array(RuleRefSchema).nullable(),
		approval: TaskGroupApprovalRecordSchema.nullable(),
		actorType: z.string(),
		actorId: z.string(),
		onBehalfOfUserId: z.string(),
		operation: OperationSchema.nullable().describe("What authorization rules match on, the same for every node."),
		rootSessionId: z.string().nullable(),
		handlerType: z.enum(["agent", "user"]).nullable(),
		handlerSessionId: z.string().nullable(),
		purpose: z.string().nullable(),
		phase: ApprovalPhaseSchema.describe(
			"`reviewing` while Auto Review decides; `awaiting_signature` waits for the user's signature; otherwise `awaiting_user`.",
		),
	})
	.meta({ id: "TaskGroupView", description: "One batch: one task per target node." });

export const TaskResponseSchema = z.object({
	task: TaskViewSchema,
	request: ApprovalRequestSchema.nullable().optional().describe("The compact approval request, when one exists."),
});
export const TaskGroupResponseSchema = z.object({
	taskGroup: TaskGroupViewSchema,
	request: ApprovalRequestSchema.nullable().optional().describe("The compact approval request, when one exists."),
});
export const TaskListResponseSchema = z.object({ tasks: z.array(TaskViewSchema) });
export const TaskPageResponseSchema = cursorPageSchema(TaskViewSchema).meta({ id: "TaskPageResponse" });
export const TaskCancelledResponseSchema = z.object({ cancelled: z.boolean() });

/** `GET /api/tasks` filters (doc/design/webui.md "Task and task group pages"); query values are strings. */
export const TaskListQuerySchema = z.object({
	cursor: z.string().optional().describe("The `nextCursor` of the previous page."),
	limit: z.string().optional().describe("Page size, 1 to 200; 50 by default."),
	state: TaskStateSchema.optional(),
	actorType: z.string().optional(),
	nodeId: z.string().optional(),
	userId: z.string().optional().describe("Tasks whose acting user (`onBehalfOfUserId`) is this user."),
	includePurpose: z.string().optional().describe("`true` or `1` includes tasks a dedicated feature created."),
});

/** `GET /api/tasks/{id}/wait` and `GET /api/task-groups/{id}/wait`: how long to wait, in milliseconds. */
export const TaskWaitQuerySchema = z.object({
	timeoutMs: z.string().optional().describe("How long to wait, in milliseconds; 30000 by default."),
});

/** Path parameter of the task routes. */
export const TaskIdParamSchema = IdParamSchema;
export const TaskGroupIdParamSchema = IdParamSchema;

/** The body of the task routes: `kind` plus the kind's fields (see {@link TaskRequest}). */
export const TaskRequestSchema = z
	.record(z.string(), z.unknown())
	.meta({ id: "TaskRequest", description: "`kind` plus the kind's fields (doc/design/execution.md)." });
