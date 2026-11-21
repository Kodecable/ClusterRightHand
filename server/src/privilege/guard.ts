/**
 * Guard rules and targets of a trust entry (doc/design/privilege.md "Guard rules", doc/design/privilege.md "Methods and targets").
 *
 * Rules are compiled with RE2 only: the Node package `re2`, never a JS RegExp fallback. A pattern
 * RE2 cannot compile is treated conservatively (U6): an `allow` rule never matches and a `deny`
 * rule always matches, so a broken configuration cannot widen access. crha's Go regexp is the final
 * arbiter; crhs uses the same matching only to plan the authorization.
 *
 * Methods and match types are open names (doc/design/protocol.md "Encoding rules"): a newer node may
 * report a rule this crhs does not understand. A rule with an unknown method only ever applies to
 * that method, so it matches no task this crhs plans; a rule with an unknown match type is
 * conservative like an uncompilable pattern: as an allow rule it never matches, as a deny rule it
 * matches every target of its method.
 */
import { posix } from "node:path";
import { type GuardRule, isKnownMatch, isKnownMethod, type TaskSpec } from "@crh/protocol";
import RE2 from "re2";
import { type Method, operationOf } from "../policy/rules.ts";
import { escapeRegExp } from "../util/regex.ts";

/** A guard rule's regex may be at most this many UTF-8 bytes (doc/design/privilege.md "Guard rules"). */
export const MAX_GUARD_PATTERN_BYTES = 1000;

export class GuardRuleError extends Error {
	override name = "GuardRuleError";
}

interface CompiledRule {
	/** The rule's method, possibly one this crhs does not know. */
	method: string;
	any: boolean;
	re: RE2 | null;
	/** The match type is unknown: allow never matches, deny matches every target of the method. */
	unknownMatch: boolean;
}

interface CompiledRuleSet {
	rules: CompiledRule[];
	error: Error | null;
}

/**
 * Compiles one rule. `strict` refuses unknown methods and match types, for rules a person is about to
 * write into a node's configuration; a node's reported rules are compiled leniently, as above.
 */
function compileRule(rule: GuardRule, strict: boolean): CompiledRule {
	if (strict && !isKnownMethod(rule.method)) throw new GuardRuleError(`guard rule has unknown method ${rule.method}`);
	if (!isKnownMatch(rule.match)) {
		if (strict) throw new GuardRuleError(`guard rule has unknown match ${rule.match}`);
		return { method: rule.method, any: false, re: null, unknownMatch: true };
	}
	if (Buffer.byteLength(rule.pattern, "utf8") > MAX_GUARD_PATTERN_BYTES) {
		throw new GuardRuleError(
			`guard rule pattern is ${Buffer.byteLength(rule.pattern, "utf8")} bytes, at most ${MAX_GUARD_PATTERN_BYTES} allowed`,
		);
	}
	if (rule.match === "any") {
		if (rule.pattern !== "") throw new GuardRuleError('guard rule with match "any" has a non-empty pattern');
		return { method: rule.method, any: true, re: null, unknownMatch: false };
	}
	if (rule.match === "regex") {
		// Compile the pattern on its own first: an unbalanced pattern like "a)|(b" breaks out of
		// the implicit full match and would turn "(?s)^(?:a)|(b)$" into an alternation. It is a
		// configuration error, not a rule.
		try {
			new RE2(rule.pattern);
		} catch (err) {
			throw new GuardRuleError(`cannot compile guard rule (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	try {
		// (?s) keeps "." matching a target that contains a newline, as in crha's Go regexp.
		const source = rule.match === "prefix" ? `(?s)^${escapeRegExp(rule.pattern)}.*$` : `(?s)^(?:${rule.pattern})$`;
		return { method: rule.method, any: false, re: new RE2(source), unknownMatch: false };
	} catch (err) {
		throw new GuardRuleError(`cannot compile guard rule (${err instanceof Error ? err.message : String(err)})`);
	}
}

/** Rules never partly apply: one invalid rule invalidates the whole list. */
function compileRuleSet(rules: readonly GuardRule[], strict = false): CompiledRuleSet {
	const out: CompiledRule[] = [];
	for (const rule of rules) {
		try {
			out.push(compileRule(rule, strict));
		} catch (err) {
			return { rules: [], error: err instanceof Error ? err : new Error(String(err)) };
		}
	}
	return { rules: out, error: null };
}

/** Compiles a trust entry's allow or deny list; throws the first rule's error. */
export function validateGuardRules(rules: readonly GuardRule[]): void {
	const compiled = compileRuleSet(rules, true);
	if (compiled.error) throw compiled.error;
}

function matches(rule: CompiledRule, method: Method, target: string, allow: boolean): boolean {
	if (rule.method !== method) {
		// A file.write allow rule also grants reading; deny rules stay method-exact.
		if (!(allow && rule.method === "file.write" && method === "file.read")) return false;
	}
	if (rule.unknownMatch) return !allow;
	return rule.any || (rule.re?.test(target) ?? false);
}

function denies(set: CompiledRuleSet, method: Method, target: string): boolean {
	if (set.error) return true;
	return set.rules.some((rule) => matches(rule, method, target, false));
}

function allows(set: CompiledRuleSet, method: Method, target: string): boolean {
	if (set.error) return false;
	return set.rules.some((rule) => matches(rule, method, target, true));
}

/** Applies a trust entry's deny and allow lists: any deny hit rejects, and a non-empty allow list must hit. */
export function guardAllows(
	entry: { deny: readonly GuardRule[]; allow: readonly GuardRule[] },
	method: Method,
	target: string,
): boolean {
	if (denies(compileRuleSet(entry.deny), method, target)) return false;
	if (entry.allow.length === 0) return true;
	return allows(compileRuleSet(entry.allow), method, target);
}

/**
 * The environment variables of a task that env_allow does not list, sorted; empty when the task may run. An
 * empty env_allow places no limit (doc/design/privilege.md "Guard rules"). File tasks carry no environment.
 */
export function envNotAllowed(spec: TaskSpec, envAllow: readonly string[]): string[] {
	if (spec.kind !== "exec" || envAllow.length === 0) return [];
	const allowed = new Set(envAllow);
	return Object.keys(spec.env)
		.filter((name) => !allowed.has(name))
		.sort();
}

export class PrivilegedTargetError extends Error {
	override name = "PrivilegedTargetError";
}

/** filepath.Clean: like posix.normalize, but a trailing separator is dropped too (Go cleans it away). */
function cleanPath(path: string): string {
	const clean = posix.normalize(path);
	return clean.length > 1 && clean.endsWith("/") ? clean.replace(/\/+$/, "") : clean;
}

/** A privileged file path must be absolute and already clean (no ".", "..", repeated "/" or trailing "/"). */
export function checkPrivilegedPath(path: string): void {
	if (path === "") throw new PrivilegedTargetError("path is empty");
	if (!posix.isAbsolute(path)) throw new PrivilegedTargetError(`path "${path}" is not absolute`);
	const clean = cleanPath(path);
	if (clean !== path) throw new PrivilegedTargetError(`path "${path}" is not normalized (want "${clean}")`);
}

/**
 * The (method, target) pair a task is authorized for, as doc/design/privilege.md "Methods and targets" renders it. The
 * rendering is shared with crhs's own rules (`operationOf`); privileged file tasks additionally
 * require an absolute, clean path before any rule sees it.
 */
export function privilegedTarget(spec: TaskSpec): { method: Method; target: string } {
	if (spec.kind === "exec" && "argv" in spec.command && spec.command.argv.length === 0) {
		throw new PrivilegedTargetError("exec task has an empty argv");
	}
	const operation = operationOf(spec);
	// An upgrade's target is a version and a hash, not a path (doc/design/privilege.md "Methods and targets").
	if (operation.method !== "exec" && operation.method !== "upgrade") {
		const path = "path" in spec ? spec.path : "";
		checkPrivilegedPath(path);
	}
	return operation;
}
