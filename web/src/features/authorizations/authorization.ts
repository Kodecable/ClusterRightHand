/**
 * Rendering data of a waiting authorization (doc/m4.md M4.4): the decoded
 * payload as label/value lines and the two signing recipes. Kept out of the
 * React component so it can be tested directly; labels are keys that the card
 * translates.
 */
import type { PendingAuthorization } from "@crh/api";
import { formatDateTimeSeconds } from "@/lib/format";

export type PayloadLineKey =
	| "nodes"
	| "command"
	| "issued"
	| "deadline"
	| "attempt"
	| "tasks"
	| "specHash"
	| "note"
	| "authorizationId";

export interface PayloadLine {
	key: PayloadLineKey;
	value: string;
	/** Values rendered in a monospace font (ids, hashes, commands). */
	mono?: boolean;
}

/** The command a payload authorizes, in one line (a technical value, not UI text). */
export function commandText(command: PendingAuthorization["decoded"]["command"]): string {
	// The card supplies the translated text for an unrestricted payload.
	if (command === null) return "";
	if (command.match === "exact") return `${command.method} exact ${command.target}`;
	return `${command.method} prefix ${command.target}`;
}

/**
 * The decoded payload as the waiting card shows it: nodes, command, spec hash,
 * deadline, note, task ids and attempt. The full base64 payload is shown
 * separately by the signing recipes.
 */
export function authorizationLines(pending: PendingAuthorization, locale: string): PayloadLine[] {
	const { decoded } = pending;
	const lines: PayloadLine[] = [
		{ key: "nodes", value: decoded.nodes.join(", "), mono: true },
		{ key: "command", value: commandText(decoded.command), mono: true },
		{ key: "issued", value: formatDateTimeSeconds(decoded.issuedAt, locale) },
		{ key: "deadline", value: formatDateTimeSeconds(pending.deadline, locale) },
		{ key: "attempt", value: String(pending.attempt) },
		{ key: "tasks", value: pending.taskIds.join(", "), mono: true },
	];
	if (decoded.command?.match === "exact") {
		lines.push({ key: "specHash", value: decoded.command.specSha256, mono: true });
	}
	if (decoded.note !== "") lines.push({ key: "note", value: decoded.note });
	lines.push({ key: "authorizationId", value: pending.id, mono: true });
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
