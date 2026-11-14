/**
 * Runtime schemas for the approvals page (`../approvals.ts`, doc/design/webui.md "Approvals page").
 */
import { z } from "zod";
import { ExternalCallViewSchema } from "./extensions.ts";
import { QuotaApprovalSchema } from "./sessions.ts";
import { TaskGroupViewSchema, TaskViewSchema } from "./tasks.ts";

/** `GET /api/approvals`: everything waiting for the caller's decision. */
export const ApprovalListSchema = z
	.object({
		tasks: z.array(TaskViewSchema),
		taskGroups: z.array(TaskGroupViewSchema),
		externalCalls: z.array(ExternalCallViewSchema).describe("External MCP calls waiting for this user's approval."),
		authorizations: z
			.object({ tasks: z.array(TaskViewSchema), taskGroups: z.array(TaskGroupViewSchema) })
			.describe("Tasks and task groups waiting for the caller's signature."),
		quotas: z.array(QuotaApprovalSchema),
	})
	.meta({ id: "ApprovalList" });

export const ExternalCallResponseSchema = z.object({ externalCall: ExternalCallViewSchema });
