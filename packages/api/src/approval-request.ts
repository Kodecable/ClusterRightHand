/**
 * The one compact approval description every display surface renders (`./schemas/approval-request.ts`,
 * doc/design/access-control.md "Approvals"): the WebUI, Telegram and Satori all render this model instead
 * of building their own per-kind summaries. Details beyond it belong on the task, task group and external
 * call pages.
 */

import type { z } from "zod";
import type {
	ApprovalActionSchema,
	ApprovalAlwaysAllowSchema,
	ApprovalRequesterSchema,
	ApprovalRequestSchema,
	ApprovalReviewSummarySchema,
} from "./schemas/approval-request.ts";

export type ApprovalRequester = z.infer<typeof ApprovalRequesterSchema>;
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;
export type ApprovalAlwaysAllow = z.infer<typeof ApprovalAlwaysAllowSchema>;
export type ApprovalReviewSummary = z.infer<typeof ApprovalReviewSummarySchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
