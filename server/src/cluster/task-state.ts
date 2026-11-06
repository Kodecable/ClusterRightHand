/**
 * The task state machine (doc/execution-plane.md#状态机), as the Cluster facade uses it. The work is
 * done by the modules this re-exports from; the cluster modules import those directly:
 *
 * - `task-dispatch.ts`: judging a task with the rule chain, creating it and dispatching it;
 * - `task-end.ts`: the node's reports, the terminal row and the side effects every ending shares;
 * - `task-approval.ts`: approval decisions, Auto Review, agent routing, changed rules;
 * - `task-wait.ts`: reading, waiting for and cancelling a task;
 * - `live-output.ts`: the output of a running task and the batch budgets.
 */
export { releaseGroupBudget } from "./live-output.ts";
export { decide, escalateAgentDecision, recordReview, reevaluate, requestAgentDecision } from "./task-approval.ts";
export { createTask, evaluateFor, evaluateForNodes } from "./task-dispatch.ts";
export { cancelTask, getTask, groupTasks, waitTask } from "./task-wait.ts";
