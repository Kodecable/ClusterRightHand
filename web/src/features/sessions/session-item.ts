import type { SessionWaitingKind } from "@crh/api";
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
