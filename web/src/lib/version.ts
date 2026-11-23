/**
 * The version of the tree, shown in the sidebar brand. Vite injects `__CRH_VERSION__` at build time
 * (web/vite.config.ts resolves it with scripts/version.ts); vitest does not run that define, and a
 * source checkout without a tag resolves to `dev` anyway.
 */
export const CRH_VERSION: string = typeof __CRH_VERSION__ === "undefined" ? "dev" : __CRH_VERSION__;

/** The brand label: `dev` as is, a version with a `v` prefix (for example `v0.4.0-rc.1`). */
export function versionLabel(version: string): string {
	return version === "dev" ? "dev" : `v${version}`;
}
