/**
 * Jobs (doc/design/jobs.md): the compact notice every display surface renders
 * (`./schemas/job-notice.ts`) and the `JobView` the API, the WebUI's background bar, its tool rows and the
 * session event stream read. Types only; the runtime schemas live in `@crh/api/schemas`.
 */

import type { z } from "zod";
import type { JobNoticeSchema } from "./schemas/job-notice.ts";
import type {
	JobCancelResponseSchema,
	JobKindSchema,
	JobResourceSchema,
	JobStateSchema,
	JobViewSchema,
	JobWaitSchema,
} from "./schemas/jobs.ts";

export type JobKind = z.infer<typeof JobKindSchema>;
export type JobState = z.infer<typeof JobStateSchema>;
export type JobWait = z.infer<typeof JobWaitSchema>;
export type JobResource = z.infer<typeof JobResourceSchema>;
export type JobView = z.infer<typeof JobViewSchema>;
export type JobCancelResponse = z.infer<typeof JobCancelResponseSchema>;

/**
 * One finished job a completion notice names: the job id the model waits with, its kind, the action it did,
 * how it ended, whether the notice started a run, and the page its row links to when one exists. It carries
 * no output: that is read with `job_wait`, as a tool result.
 */
export type JobNotice = z.infer<typeof JobNoticeSchema>;
