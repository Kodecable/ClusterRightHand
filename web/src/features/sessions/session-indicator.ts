import type { SessionListItem, SessionWaitingKind } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { waitingKindLabel } from "./session-item";

/**
 * The one indicator a session-list row shows (doc/design/webui.md "Sidebar list"): the tree's wait for the
 * user outranks its work, which outranks unread output. The aggregate `state` already covers the subtree;
 * `jobs` adds background work that may outlive the turn (an approval waiting after the turn ended).
 */
export type SessionIndicatorKind = "attention" | "busy" | "unread";

/** Why the row shows its indicator; the label and the tooltip name it. */
export type SessionIndicatorReason = "awaiting" | "job-awaiting" | "running" | "job-running" | "unread";

export interface SessionIndicator {
	kind: SessionIndicatorKind;
	reason: SessionIndicatorReason;
}

/**
 * The row's indicator, with one outcome per priority: attention (the yellow dot) when the tree awaits the
 * user or a background job waits for an approval or signature; busy (the spinner) when the tree or its
 * background jobs run; unread (the blue dot) for output the owner has not seen. Null means no indicator.
 */
export function sessionIndicator(item: Pick<SessionListItem, "state" | "unread" | "jobs">): SessionIndicator | null {
	if (item.state === "awaiting") return { kind: "attention", reason: "awaiting" };
	if (item.jobs.awaitingUser > 0) return { kind: "attention", reason: "job-awaiting" };
	if (item.state === "running") return { kind: "busy", reason: "running" };
	if (item.jobs.active > 0) return { kind: "busy", reason: "job-running" };
	if (item.unread) return { kind: "unread", reason: "unread" };
	return null;
}

/** The indicator's text: the tooltip and the accessible name both say which reason it shows. */
export function sessionIndicatorLabel(
	reason: SessionIndicatorReason,
	waitingKind: SessionWaitingKind | null,
): MessageDescriptor {
	switch (reason) {
		case "awaiting":
			return waitingKindLabel(waitingKind) ?? msg`Waiting for you`;
		case "job-awaiting":
			return msg`A background job is waiting for you`;
		case "running":
			return msg`Running`;
		case "job-running":
			return msg`Background jobs running`;
		case "unread":
			return msg`Unread`;
	}
}
