/**
 * The one compact approval description every display surface renders (`./schemas/approval-request.ts`,
 * doc/design/access-control.md "Approvals"): the WebUI, Telegram and Satori all render this model instead
 * of building their own per-kind summaries. Details beyond it belong on the task, task group and external
 * call pages. `source` and `action` are the shared models a task view also carries.
 */

import type { z } from "zod";
import type {
	ApprovalAlwaysAllowSchema,
	ApprovalRequestJobSchema,
	ApprovalRequestSchema,
	ApprovalReviewSummarySchema,
} from "./schemas/approval-request.ts";

export type { RequestSource } from "./request-source.ts";
export type { TaskAction } from "./task-action.ts";

export type ApprovalAlwaysAllow = z.infer<typeof ApprovalAlwaysAllowSchema>;
export type ApprovalReviewSummary = z.infer<typeof ApprovalReviewSummarySchema>;
export type ApprovalRequestJob = z.infer<typeof ApprovalRequestJobSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
