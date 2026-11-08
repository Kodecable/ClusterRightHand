import type { RuleMethod } from "@crh/api";
import { toBase64url, tomlString } from "@/features/credentials/trust";

export { tomlString };

/**
 * The node side of trust (doc/privilege.md#信任配置): the WebUI cannot change a
 * node's privileged.toml, so it exports the `[[trust]]` block the operator
 * pastes there. This module builds that block from a small editable draft; the
 * rendering component lives in `trust-editor.tsx`.
 */

export type TrustKeySource =
	| { kind: "crhs"; authorizedKey: string }
	| { kind: "ssh"; name: string; publicKey: string }
	| { kind: "webauthn"; name: string; rpId: string; origins: string[]; credentialId: string; publicKey: string };

export interface GuardLine {
	method: RuleMethod;
	/** The command or path prefix the rule applies to. */
	prefix: string;
}

export interface TrustDraft {
	source: TrustKeySource;
	name: string;
	requireExact: boolean;
	requireUv: boolean;
	/** A Go duration such as "5m"; empty omits max_ttl (no limit). */
	maxTtl: string;
	allow: GuardLine[];
	deny: GuardLine[];
}

const METHODS: readonly RuleMethod[] = ["exec", "file.read", "file.write"];

/** Whether a string is one of the rule methods the node understands. */
export function isRuleMethod(value: string): value is RuleMethod {
	return (METHODS as readonly string[]).includes(value);
}

/** The role and the default rules a source deserves. */
export function defaultDraft(source: TrustKeySource): TrustDraft {
	const crhs = source.kind === "crhs";
	return {
		source,
		name: crhs ? "crhs" : source.name,
		requireExact: crhs,
		requireUv: false,
		maxTtl: crhs ? "5m" : "",
		allow: [
			{ method: "exec", prefix: "systemctl restart " },
			...(crhs ? [{ method: "file.read" as const, prefix: "/var/log/" }] : []),
		],
		deny: [{ method: "file.write", prefix: "/etc/crha/" }],
	};
}

export type GuardLinesError = "unknown-method" | "missing-target";

/** Parses the editor's one-rule-per-line text (`method prefix`). */
export function parseGuardLines(text: string): { lines: GuardLine[] } | { error: GuardLinesError } {
	const lines: GuardLine[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trimStart();
		if (line.trim() === "") continue;
		const space = line.search(/\s/);
		if (space < 0) return { error: "missing-target" };
		const method = line.slice(0, space);
		// Keep the trailing spaces of a prefix: "systemctl restart " must not
		// start matching "systemctl restart-evil".
		const prefix = line.slice(space + 1);
		if (!isRuleMethod(method)) return { error: "unknown-method" };
		if (prefix.trim() === "") return { error: "missing-target" };
		lines.push({ method, prefix });
	}
	return { lines };
}

/** The textarea text of a guard list. */
export function formatGuardLines(lines: GuardLine[]): string {
	return lines.map((line) => `${line.method} ${line.prefix}`).join("\n");
}

function guardArray(name: "allow" | "deny", lines: GuardLine[]): string[] {
	if (lines.length === 0) {
		return [name === "allow" ? "allow = [] # empty allows any method and target" : "deny  = [] # no exceptions"];
	}
	return [
		`${name} = [`,
		...lines.map((line) => `\t{ method = ${tomlString(line.method)}, prefix = ${tomlString(line.prefix)} },`),
		"]",
	];
}

/**
 * The editable `[[trust]]` block. Values are TOML basic strings, so a key with
 * quotes or backslashes cannot break out of the document.
 */
export function buildTrustBlock(draft: TrustDraft): string {
	const { source } = draft;
	const crhs = source.kind === "crhs";
	const lines = ["[[trust]]", `name          = ${tomlString(draft.name.trim() || (crhs ? "crhs" : source.name))}`];
	lines.push(`role          = ${tomlString(crhs ? "crhs" : "user")}`);
	if (source.kind === "ssh" || source.kind === "crhs") {
		const key = source.kind === "crhs" ? source.authorizedKey : source.publicKey;
		lines.push('format        = "sshsig"', `key           = ${tomlString(key)}`);
	} else {
		lines.push(
			'format        = "webauthn"',
			`rp_id         = ${tomlString(source.rpId)}`,
			`origins       = [${source.origins.map(tomlString).join(", ")}]`,
			`credential_id = ${tomlString(source.credentialId)}`,
			`key           = ${tomlString(`cose:${toBase64url(source.publicKey)}`)}`,
		);
	}
	lines.push(`kinds         = ${crhs ? '["execute", "cosign"]' : '["execute"]'}`);
	if (draft.requireExact) lines.push("require_exact = true");
	if (draft.requireUv) lines.push("require_uv    = true");
	const ttl = draft.maxTtl.trim();
	if (ttl !== "") lines.push(`max_ttl       = ${tomlString(ttl)}`);
	lines.push("");
	lines.push(...guardArray("allow", draft.allow));
	lines.push("");
	lines.push(...guardArray("deny", draft.deny));
	lines.push("");
	return lines.join("\n");
}
