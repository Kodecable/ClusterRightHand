import type { SessionListItem, SessionWaitingKind } from "@crh/api";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** The label of the wait behind `waitingKind`, or undefined for a non-waiting row. */
export function waitingKindLabel(kind: SessionWaitingKind | null): MessageDescriptor | undefined {
	switch (kind) {
		case "quota":
			return msg`Waiting for a quota decision`;
		case "approval":
			return msg`Waiting for approval`;
		case "authorization":
			return msg`Waiting for a signature`;
		default:
			return undefined;
	}
}

/** The title shown for a row; a null or blank title from the server still needs a visible label. */
export function sessionTitle(item: Pick<SessionListItem, "title">, fallback: string): string {
	if (item.title === null || item.title.trim() === "") return fallback;
	return item.title;
}
