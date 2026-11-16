/**
 * Who a request came from (`./schemas/request-source.ts`, doc/design/webui.md "Request source"): a
 * session, an API token or a user; audit events also carry the system, Auto Review and a schedule.
 */

import type { z } from "zod";
import type { RequestSourceSchema } from "./schemas/request-source.ts";

export type RequestSource = z.infer<typeof RequestSourceSchema>;
