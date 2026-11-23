import type { PtyState, PublicNode } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { shellArgument } from "@/lib/authorization";
import type { StatusTone } from "@/lib/status";

/**
 * The terminal state's label and tone (doc/design/webui.md "Terminals page"). A terminal is opening while an
 * approval or a signature is pending, then running or exited; the label is the lifecycle value, and
 * the exit code is shown beside it.
 */
export const TERMINAL_STATE_LABELS: Record<PtyState, MessageDescriptor> = {
	opening: msg`Opening`,
	running: msg`Running`,
	exited: msg`Exited`,
};

/** A terminal state's translated label; an unexpected value stays visible as the server sent it. */
export function terminalStateLabel(i18n: I18n, state: PtyState | string): string {
	const descriptor = TERMINAL_STATE_LABELS[state as PtyState];
	return descriptor === undefined ? state : i18n._(descriptor);
}

/** Opening waits for a decision, running is healthy, exited is neutral (its exit code says more). */
export function terminalStateTone(state: PtyState | string): StatusTone {
	switch (state) {
		case "opening":
			return "warn";
		case "running":
			return "info";
		default:
			return "muted";
	}
}

/**
 * The command of a terminal as one shell line: the argv shell-quoted, or `loginShell` for the empty argv
 * that runs the identity's login shell. The same rendering the server's `pty.create` target uses.
 */
export function terminalCommand(argv: readonly string[], loginShell: string): string {
	return argv.length === 0 ? loginShell : argv.map((argument) => shellArgument(argument)).join(" ");
}

/**
 * The nodes a person may open a terminal on (doc/design/pty.md "Scope"): crha nodes only, and only an
 * active one. SSH nodes never have terminals.
 */
export function selectableTerminalNodes(nodes: readonly PublicNode[]): PublicNode[] {
	return nodes.filter((node) => node.transport === "client" && node.status === "active");
}
