/**
 * POSIX single quoting: the result is one shell word with no expansion.
 *
 * It lives in `util/` because policy rules quote an argv before it reaches the SSH transport; importing it from
 * `cluster/ssh/exec.ts` would make the policy layer depend on the cluster layer.
 */
export function shellQuote(s: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
