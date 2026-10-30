/**
 * Guard rules and targets of a trust entry (doc/privilege.md#防护规则, #方法与目标).
 *
 * Rules are compiled with RE2 only: the Node package `re2`, never a JS RegExp fallback. A pattern
 * RE2 cannot compile is treated conservatively (U6): an `allow` rule never matches and a `deny`
 * rule always matches, so a broken configuration cannot widen access. crha's Go regexp is the final
 * arbiter; crhs uses the same matching only to plan the authorization.
 */
import { posix } from "node:path";
import type { GuardRule, TaskSpec } from "@crh/protocol";
import RE2 from "re2";
import { type Method, operationOf } from "../policy/rules.ts";

/** A guard rule's regex may be at most this many UTF-8 bytes (doc/privilege.md#防护规则). */
export const MAX_GUARD_PATTERN_BYTES = 1000;

export class GuardRuleError extends Error {
	override name = "GuardRuleError";
}

const METHODS: readonly Method[] = ["exec", "file.read", "file.write"];
const MATCHES: readonly string[] = ["any", "prefix", "regex"];

interface CompiledRule {
	method: Method;
	any: boolean;
	re: RE2 | null;
}

interface CompiledRuleSet {
	rules: CompiledRule[];
	error: Error | null;
}

/** Escapes the characters of Go's regexp.QuoteMeta; other characters, including non-ASCII, stay literal. */
function quoteMeta(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compileRule(rule: GuardRule): CompiledRule {
	if (!METHODS.includes(rule.method)) throw new GuardRuleError(`guard rule has unknown method ${rule.method}`);
	if (!MATCHES.includes(rule.match)) throw new GuardRuleError(`guard rule has unknown match ${rule.match}`);
	if (Buffer.byteLength(rule.pattern, "utf8") > MAX_GUARD_PATTERN_BYTES) {
		throw new GuardRuleError(
			`guard rule pattern is ${Buffer.byteLength(rule.pattern, "utf8")} bytes, at most ${MAX_GUARD_PATTERN_BYTES} allowed`,
		);
	}
	if (rule.match === "any") {
		if (rule.pattern !== "") throw new GuardRuleError('guard rule with match "any" has a non-empty pattern');
		return { method: rule.method, any: true, re: null };
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
		const source = rule.match === "prefix" ? `(?s)^${quoteMeta(rule.pattern)}.*$` : `(?s)^(?:${rule.pattern})$`;
		return { method: rule.method, any: false, re: new RE2(source) };
	} catch (err) {
		throw new GuardRuleError(`cannot compile guard rule (${err instanceof Error ? err.message : String(err)})`);
	}
}

/** Rules never partly apply: one invalid rule invalidates the whole list. */
function compileRuleSet(rules: readonly GuardRule[]): CompiledRuleSet {
	const out: CompiledRule[] = [];
	for (const rule of rules) {
		try {
			out.push(compileRule(rule));
		} catch (err) {
			return { rules: [], error: err instanceof Error ? err : new Error(String(err)) };
		}
	}
	return { rules: out, error: null };
}

/** Compiles a trust entry's allow or deny list; throws the first rule's error. */
export function validateGuardRules(rules: readonly GuardRule[]): void {
	const compiled = compileRuleSet(rules);
	if (compiled.error) throw compiled.error;
}

function matches(rule: CompiledRule, method: Method, target: string, allowFileWriteCoversRead: boolean): boolean {
	if (rule.method !== method) {
		// A file.write allow rule also grants reading; deny rules stay method-exact (D67).
		if (!(allowFileWriteCoversRead && rule.method === "file.write" && method === "file.read")) return false;
	}
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

/** Every environment variable the task carries must be listed in env_allow. File tasks carry none. */
export function envAllowed(spec: TaskSpec, envAllow: readonly string[]): boolean {
	if (spec.kind !== "exec") return true;
	const allowed = new Set(envAllow);
	return Object.keys(spec.env).every((name) => allowed.has(name));
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
 * The (method, target) pair a task is authorized for, as doc/privilege.md#方法与目标 renders it. The
 * rendering is shared with crhs's own rules (`operationOf`); privileged file tasks additionally
 * require an absolute, clean path before any rule sees it.
 */
export function privilegedTarget(spec: TaskSpec): { method: Method; target: string } {
	if (spec.kind === "exec" && "argv" in spec.command && spec.command.argv.length === 0) {
		throw new PrivilegedTargetError("exec task has an empty argv");
	}
	const operation = operationOf(spec);
	if (operation.method !== "exec") {
		const path = "path" in spec ? spec.path : "";
		checkPrivilegedPath(path);
	}
	return operation;
}
