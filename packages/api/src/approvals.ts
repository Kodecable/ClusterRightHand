/**
 * The approvals page: waiting approvals, tasks and groups waiting for the
 * caller's signature, and exhausted quotas (doc/design/webui.md "Approvals page").
 */

import type { z } from "zod";
import type { ApprovalListSchema } from "./schemas/approvals.ts";

export type ApprovalList = z.infer<typeof ApprovalListSchema>;
