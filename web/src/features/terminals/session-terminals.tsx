import { Trans, useLingui } from "@lingui/react/macro";
import { TerminalIcon } from "lucide-react";
import { useMemo } from "react";
import { InternalLink } from "@/components/internal-link";
import { useTerminals } from "./api";
import { terminalStateLabel } from "./terminal-format";

/**
 * The session page's compact terminal strip (doc/design/webui.md "Terminals page"): the terminals the
 * session created or is associated with, linked to their pages. It renders nothing while the session has
 * none, so a session page without terminals looks exactly as before.
 */
export function SessionTerminals({ sessionId }: { sessionId: string }) {
	const { i18n } = useLingui();
	const terminals = useTerminals();
	const matches = useMemo(
		() =>
			(terminals.data?.terminals ?? []).filter(
				(terminal) => terminal.creatingSessionId === sessionId || terminal.sessionIds.includes(sessionId),
			),
		[terminals.data, sessionId],
	);
	if (terminals.data === undefined || !terminals.data.enabled || matches.length === 0) return null;
	return (
		<div
			className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs"
			data-testid="session-terminals"
		>
			<span className="flex items-center gap-1 font-medium">
				<TerminalIcon className="size-3.5" aria-hidden="true" />
				<Trans>Terminals</Trans>
			</span>
			{matches.map((terminal) => (
				<InternalLink
					key={terminal.id}
					to="/terminals/$id"
					params={{ id: terminal.id }}
					className="rounded border bg-background px-1.5 py-0.5 no-underline"
					title={terminal.argv.length === 0 ? undefined : terminal.argv.join(" ")}
				>
					{terminal.nodeName ?? terminal.nodeId} · {terminalStateLabel(i18n, terminal.state)}
				</InternalLink>
			))}
		</div>
	);
}
