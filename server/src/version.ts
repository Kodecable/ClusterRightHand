// Replaced by the bundler's define; unbundled, it is not defined and crhs reports "dev".
declare const __CRH_VERSION__: string | undefined;

/** The version crhs reports (`--version`, MCP); a bundled build carries its version. */
export const CRH_VERSION: string = typeof __CRH_VERSION__ === "undefined" ? "dev" : __CRH_VERSION__;
