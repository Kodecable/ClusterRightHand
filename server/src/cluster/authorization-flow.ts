/**
 * The authorization of a privileged task (doc/design/privilege.md "Authorization path"): planning which
 * path the node would accept, reusing an authorization the owner already stored, asking for the
 * owner's signature or a local approval, sending the signed `task.start`, retrying with a higher
 * attempt after a rejection, and storing what was issued.
 *
 * These are the entry points the Cluster facade and the connection handlers use; the work is done in
 * `authorization/`:
 *
 * - `plan.ts`: planning, parking in awaiting_authorization, a task group's shared payload;
 * - `local-approval.ts`: local.request and the node's decision;
 * - `owner-authorizations.ts`: stored and submitted owner authorizations, cosignatures, claiming;
 * - `authorized-start.ts`: crhs's own signature, sending task.start, the retry after a rejection;
 * - `reject.ts`: the owner rejecting the wait instead of signing;
 * - `sweeps.ts`: stored authorizations after a reconnect, re-planning, expiring the waits;
 * - `common.ts`: ending a task that could not be authorized, withdrawing a local request.
 */
export { onLocalDecision, resendLocalRequests } from "./authorization/local-approval.ts";
export { submitAuthorization } from "./authorization/owner-authorizations.ts";
export { rejectAuthorizationWait } from "./authorization/reject.ts";
export { expireAuthorizationWaits, replanAwaiting, useStoredAuthorizations } from "./authorization/sweeps.ts";
