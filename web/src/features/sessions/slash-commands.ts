import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * A command the session composer recognizes. The registry is the one place a
 * command's name, argument hint and translated description live, so the
 * completion popup and `parseSlashCommand` can never disagree about them.
 */
export interface SlashCommand {
	name: string;
	/** The argument hint shown after the name; a plain string stays untranslated. */
	args?: MessageDescriptor | string;
	description: MessageDescriptor;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: "compact",
		args: msg`[instructions]`,
		description: msg`Summarize older context to free up the context window. Optional instructions guide the summary.`,
	},
];

/**
 * The command and trimmed arguments of an exact `/<name> [args]` draft, or
 * undefined for anything else. Only the exact name counts: `/compactor` is a
 * normal message rather than a fuzzy match for `/compact`.
 */
export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | undefined {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match === null) return undefined;
	const name = match[1];
	if (name === undefined) return undefined;
	const command = SLASH_COMMANDS.find((candidate) => candidate.name === name);
	if (command === undefined) return undefined;
	return { command, args: (match[2] ?? "").trim() };
}

/**
 * Whether a draft is a lone `/token` that names no registered command: it is
 * still a normal message, and the composer says so while the user can still
 * fix it.
 */
export function isUnknownSlashCommand(text: string): boolean {
	return parseSlashCommand(text) === undefined && /^\/\S+$/.test(text);
}

/**
 * The commands to suggest for a draft that is still one `/token` (no
 * whitespace yet): `/` lists every command, `/co` narrows to `/compact`, and
 * `/<unknown>` lists nothing. Whitespace anywhere, a leading space included,
 * means the user is past completion.
 */
export function slashSuggestions(text: string): SlashCommand[] {
	const match = /^\/(\S*)$/.exec(text);
	if (match === null) return [];
	const prefix = match[1] ?? "";
	return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
}
