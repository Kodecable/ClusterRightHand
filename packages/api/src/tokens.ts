/**
 * API tokens and their rules (doc/design/access-control.md "API tokens").
 */

import type { z } from "zod";
import type { ApiTokenViewSchema } from "./schemas/tokens.ts";

export type ApiTokenView = z.infer<typeof ApiTokenViewSchema>;
