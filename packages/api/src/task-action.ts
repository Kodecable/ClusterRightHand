/**
 * What a task or a waiting approval does (`./schemas/task-action.ts`, doc/design/webui.md "Shared
 * components"). The server builds it from the stored task spec; every display surface renders this model.
 */

import type { z } from "zod";
import type { TaskActionSchema } from "./schemas/task-action.ts";

export type TaskAction = z.infer<typeof TaskActionSchema>;
