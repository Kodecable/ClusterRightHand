/**
 * Rendering of a waiting authorization (doc/m4.md M4.4): the decoded payload as label/value lines and
 * the two signing recipes. Kept out of the React component so it can be tested directly.
 */
import type { PendingAuthorization } from "./api.ts";
import { formatTime } from "./lib.ts";

export interface PayloadLine {
	label: string;
	value: string;
	/** Values rendered in a monospace font (ids, hashes, commands). */
	mono?: boolean;
}

/** The command a payload authorizes, in one line. */
export function commandText(command: PendingAuthorization["decoded"]["command"]): string {
	if (command === null) return "any method and target";
	if (command.match === "exact") return `${command.method} exact ${command.target}`;
	return `${command.method} prefix ${command.target}`;
}

/**
 * The decoded payload as the waiting page shows it: nodes, command, spec hash, deadline, note, task
 * ids and attempt. The full base64 payload is shown separately by the signing recipes.
 */
export function authorizationLines(pending: PendingAuthorization): PayloadLine[] {
	const { decoded } = pending;
	const lines: PayloadLine[] = [
		{ label: "Nodes", value: decoded.nodes.join(", "), mono: true },
		{ label: "Command", value: commandText(decoded.command), mono: true },
		{ label: "Issued", value: formatTime(decoded.issuedAt) },
		{ label: "Deadline", value: formatTime(pending.deadline) },
		{ label: "Attempt", value: String(pending.attempt) },
		{ label: "Tasks", value: pending.taskIds.join(", "), mono: true },
	];
	if (decoded.command?.match === "exact") {
		lines.push({ label: "Spec hash", value: decoded.command.specSha256, mono: true });
	}
	if (decoded.note !== "") lines.push({ label: "Note", value: decoded.note });
	lines.push({ label: "Authorization id", value: pending.id, mono: true });
	return lines;
}

/** The `crha grant` command that signs the payload with the owner's SSH key. */
export function grantCommand(payload: string): string {
	return `crha grant --payload ${payload} --key ~/.ssh/id_ed25519`;
}

/** The equivalent manual `ssh-keygen -Y sign` recipe: write the exact bytes, sign, then wrap them. */
export function sshKeygenRecipe(payload: string): string {
	return [
		`printf %s '${payload}' | base64 -d > crh-payload.bin`,
		"ssh-keygen -Y sign -n crh-auth-v1 -f ~/.ssh/id_ed25519 crh-payload.bin",
		"# crh-payload.bin.sig is the armored SSHSIG; `crha grant --payload` adds it to the authorization",
	].join("\n");
}
