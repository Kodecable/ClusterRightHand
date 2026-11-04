/**
 * Node and node-group names (D109, doc/access-control.md#用户模型). Both share
 * one case-insensitive namespace; these are the client-side checks the forms
 * apply before asking the server, which enforces the same rule again.
 */

export const NAME_MIN = 2;
export const NAME_MAX = 64;

/** 2-64 characters, starting with a letter, ending with a letter or digit. */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9._/-]*[A-Za-z0-9]$/;

/** The one system target: every node the acting user can access. */
export const ALL_TARGET = "_all";

export type NameProblem = "empty" | "reserved" | "format";

/** Why `raw` is not a valid name; undefined when it is. The messages are translated by the caller. */
export function nameProblem(raw: string): NameProblem | undefined {
	const name = raw.trim();
	if (name === "") return "empty";
	// The name rule already excludes a leading `_`; say why instead of "invalid".
	if (name.startsWith("_")) return "reserved";
	if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) return "format";
	return undefined;
}
