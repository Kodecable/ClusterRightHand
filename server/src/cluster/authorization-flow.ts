/**
 * The authorization of a privileged task (doc/design/privilege.md "Authorization path"): the one sync
 * path that plans a unit (a task group, or a task in none), claims and sends what is usable, parks the
 * rest with options and fails what nothing can authorize, plus the owner's rejection and the sweep.
 *
 * These are the entry points the Cluster facade and the connection handlers use; the work is done in
 * `authorization/`:
 *
 * - `sync.ts`: the sync passes and the events that request them (first dispatch, trust report,
 *   submission, rejection, payload refresh);
 * - `owner-authorizations.ts`: loading stored authorizations, claiming the tasks one covers, signatures;
 * - `authorized-start.ts`: crhs's own signature, sending task.start, the retry after a rejection;
 * - `reject.ts`: the owner rejecting the wait instead of signing;
 * - `sweeps.ts`: expiring the waits and syncing the ones a pass or a timer missed.
 */

export { rejectAuthorizationWait } from "./authorization/reject.ts";
export { sweepAuthorizationWaits } from "./authorization/sweeps.ts";
export { submitAuthorization } from "./authorization/sync.ts";
