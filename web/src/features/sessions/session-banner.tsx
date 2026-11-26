import type { SessionWaitingKind } from "@crh/api";
import { Plural, Trans } from "@lingui/react/macro";

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

// The banner's background stays full-bleed; its text sits on the session page's shared column.
const LINE = "mx-auto block w-full max-w-(--session-column) px-3 py-1 text-xs";
const MUTED = "shrink-0 bg-muted text-muted-foreground";
const WARN = "shrink-0 bg-warn-bg/60 text-warn";
const DANGER = "shrink-0 bg-danger-bg text-danger";

/**
 * The one single-line banner of the session page (doc/design/webui.md "Session header"): the
 * highest-priority state wins, so several states never stack above the
 * transcript. Connection > failure > retry > waiting reason > queued messages.
 */
export function SessionBanner({ connection, failure, retry, waitingKind, queued }: SessionBannerProps) {
	if (connection !== "live") {
		return (
			<p className={MUTED} role="status">
				<span className={LINE}>
					{connection === "connecting" ? <Trans>Connecting…</Trans> : <Trans>Reconnecting…</Trans>}
				</span>
			</p>
		);
	}
	if (failure !== undefined) {
		return (
			<p className={DANGER} role="alert">
				<span className={LINE}>{failure}</span>
			</p>
		);
	}
	if (retry !== undefined) {
		return (
			<p className={MUTED} role="status">
				<span className={LINE}>
					<Trans>Retrying after an error: {retry}</Trans>
				</span>
			</p>
		);
	}
	if (waitingKind !== null) {
		return (
			<p className={WARN} role="status" data-testid="waiting-reason">
				<span className={LINE}>
					<WaitingReason kind={waitingKind} />
				</span>
			</p>
		);
	}
	if (queued > 0) {
		return (
			<p className={MUTED} role="status">
				<span className={LINE}>
					<Plural value={queued} one="# message queued" other="# messages queued" />
				</span>
			</p>
		);
	}
	return null;
}
