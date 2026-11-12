import { rootSessionIdOf } from "../sessions/session-chain.ts";
import type { Db } from "../storage/db.ts";
import { TREE_STATE } from "./session-list.ts";
import type { SessionState } from "./session-state.ts";

/**
 * Unread sessions (doc/design/webui.md "Sidebar list"): when a session that was `running` becomes `idle` or `awaiting` and
 * that leaves its tree's aggregate state not `running`, the tree has new output for its owner, so its root
 * gets `reply_at = now`. The owner's list then shows the row unread until `POST /api/sessions/:id/read` sets
 * `owner_read_at`.
 *
 * A tree that is still awaiting may already have been awaiting through another session; that is not a
 * `running -> awaiting` transition and records nothing. An idle tree cannot have been awaiting before (only
 * the changed session was running), so `idle` is always a real transition.
 */
export async function recordTreeReply(
	db: Db,
	sessionId: string,
	previous: SessionState,
	next: SessionState,
): Promise<void> {
	if (previous !== "running" || next === "running") return;
	const rootId = await rootSessionIdOf(db, sessionId);
	if (!rootId) return;
	const tree = await db
		.selectFrom("sessions")
		.select(TREE_STATE.as("state"))
		.where("id", "=", rootId)
		.executeTakeFirst();
	if (!tree || tree.state === "running") return;
	if (tree.state === "awaiting") {
		// A tree that is awaiting after an idle change was already awaiting through another session, so the
		// aggregate did not leave `running` now. For an awaiting change, another awaiting session means the
		// same; only this session's own wait can have made the tree leave `running`.
		if (next !== "awaiting") return;
		const other = await db
			.selectFrom("sessions")
			.select("id")
			.where("root_session_id", "=", rootId)
			.where("id", "!=", sessionId)
			.where("state", "=", "awaiting")
			.executeTakeFirst();
		if (other) return;
	}
	await db.updateTable("sessions").set({ reply_at: new Date().toISOString() }).where("id", "=", rootId).execute();
}
