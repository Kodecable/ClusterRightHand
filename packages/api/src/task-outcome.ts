/**
 * A task's or task group's classified outcome (`./schemas/task-outcome.ts`, doc/design/execution.md "State
 * machine"). The server computes it once; it is null while the task or group is not terminal.
 */

import type { z } from "zod";
import type { TaskOutcomeSchema } from "./schemas/task-outcome.ts";

export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;
