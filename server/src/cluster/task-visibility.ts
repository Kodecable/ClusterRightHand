import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import { sessionCapabilities } from "../sessions/sharing.ts";
import type { Db } from "../storage/db.ts";

/**
 * Who may see a task or task group (doc/design/access-control.md "Ownership, access grants and sharing"): visibility depends only
 * on the user's relation to the task, never on node access. Administrators see everything, the on_behalf_of
 * user sees their own work even after losing node access, and users who can view the session that issued it
 * (through session sharing) see it too. Node access reveals nothing about other users' tasks.
 */
export interface TaskSubject {
	onBehalfOfUserId: string;
	actorType: string;
	actorId: string;
}

/** What a user may do with a task: see it, or also act on it (cancel, decide its approval). */
export interface TaskRelation {
	visible: boolean;
	/** Admin or the on_behalf_of user. Session shares grant viewing, not acting. */
	acts: boolean;
}

export async function taskRelation(db: Db, user: SessionUser, subject: TaskSubject): Promise<TaskRelation> {
	if (isAdmin(user)) return { visible: true, acts: true };
	if (subject.onBehalfOfUserId === user.userId) return { visible: true, acts: true };
	if (subject.actorType === "session" || subject.actorType === "subagent") {
		const permissions = await sessionCapabilities(db, user, subject.actorId);
		return { visible: permissions?.capabilities.view === true, acts: false };
	}
	return { visible: false, acts: false };
}

export async function canViewTask(db: Db, user: SessionUser, subject: TaskSubject): Promise<boolean> {
	return (await taskRelation(db, user, subject)).visible;
}
