import { Plural, Trans } from "@lingui/react/macro";
import type { SessionWaitingKind } from "@/lib/api/types";

export interface SessionBannerProps {
	connection: "connecting" | "live" | "reconnecting";
	failure: string | undefined;
	retry: string | undefined;
	waitingKind: SessionWaitingKind | null;
	queued: number;
}

function WaitingReason({ kind }: { kind: SessionWaitingKind }) {
	if (kind === "approval") return <Trans>The session is waiting for an approval.</Trans>;
	if (kind === "authorization") return <Trans>The session is waiting for a signature.</Trans>;
	return <Trans>The session is paused: its token quota is used up.</Trans>;
}

const LINE = "shrink-0 px-3 py-1 text-xs";
const MUTED = `${LINE} bg-muted text-muted-foreground`;
const WARN = `${LINE} bg-warn-bg/60 text-warn`;
const DANGER = `${LINE} bg-danger-bg text-danger`;

/**
 * The one single-line banner of the session page (doc/webui.md "会话界面"): the
 * highest-priority state wins, so several states never stack above the
 * transcript. Connection > failure > retry > waiting reason > queued messages.
 */
export function SessionBanner({ connection, failure, retry, waitingKind, queued }: SessionBannerProps) {
	if (connection !== "live") {
		return (
			<p className={MUTED} role="status">
				{connection === "connecting" ? <Trans>Connecting…</Trans> : <Trans>Reconnecting…</Trans>}
			</p>
		);
	}
	if (failure !== undefined) {
		return (
			<p className={DANGER} role="alert">
				{failure}
			</p>
		);
	}
	if (retry !== undefined) {
		return (
			<p className={MUTED} role="status">
				<Trans>Retrying after an error: {retry}</Trans>
			</p>
		);
	}
	if (waitingKind !== null) {
		return (
			<p className={WARN} role="status" data-testid="waiting-reason">
				<WaitingReason kind={waitingKind} />
			</p>
		);
	}
	if (queued > 0) {
		return (
			<p className={MUTED} role="status">
				<Plural value={queued} one="# message queued" other="# messages queued" />
			</p>
		);
	}
	return null;
}
