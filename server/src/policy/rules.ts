import { posix } from "node:path";
import type {
	Evaluation as ApiEvaluation,
	LevelResult as ApiLevelResult,
	Rule as ApiRule,
	RulePreset as ApiRulePreset,
	RuleAction,
	RuleMethod,
} from "@crh/api";
import type { TaskSpec } from "@crh/protocol";
import { ALL_TARGET, isUuid, NAME_RE } from "../cluster/names.ts";
import { shellQuote } from "../cluster/ssh/exec.ts";
import { UserError } from "../users/service.ts";

/**
 * Authorization rules along a rule chain; see doc/access-control.md#授权规则. Pure functions: loading
 * rule sets and acting on the result belong to the callers.
 */

export type Action = RuleAction;
export type DefaultAction = Action | "inherit";
export type Method = RuleMethod;
export type RulePreset = ApiRulePreset;

export const RULE_PRESETS: readonly RulePreset[] = ["ask", "auto_review", "yolo"];
const METHODS: readonly Method[] = ["exec", "file.read", "file.write"];
const ACTIONS: readonly Action[] = ["allow", "deny", "require-approval"];
const MAX_RULES = 200;
const MAX_PATTERN = 1000;

export type Rule = ApiRule;

export interface RuleSet {
	default: DefaultAction;
	rules: Rule[];
}

/** One level of a chain, as loaded: the root first. */
export interface ChainLevel {
	scope: { type: string; id: string };
	set: RuleSet;
}

/** What a task does, in the terms rules match on. */
export interface Operation {
	method: Method;
	/** exec: the rendered argv; files: the normalized absolute path. */
	target: string;
	node: { id: string; groupIds: string[] };
	/** The task's privileged flag; a rule with `privileged` matches only that value. */
	privileged: boolean;
}

export type LevelResult = ApiLevelResult;
export type Evaluation = ApiEvaluation;

/** The rules a root rule preset stands for; rules the user adds come after these. */
export function rulePresetRuleSet(rulePreset: RulePreset): RuleSet {
	if (rulePreset === "yolo") return { default: "allow", rules: [] };
	// ask and auto_review differ in who answers the approval, not in the rules. Reads may pass, but a
	// privileged read still waits: native and ignore nodes have no other gate than these rules (D86).
	return {
		default: "require-approval",
		rules: [{ action: "allow", method: "file.read", privileged: false }],
	};
}

const STRICTNESS: Record<Action, number> = { allow: 0, "require-approval": 1, deny: 2 };

function stricter(a: Action, b: Action): Action {
	return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

function methodMatches(rule: Rule, op: Operation): boolean {
	if (!rule.method || rule.method === op.method) return true;
	// Allowing file.write also allows reading (as in crha); deny and require-approval stay exact, so that
	// "deny file.write /etc/x" does not hide the file from reading.
	return rule.action === "allow" && rule.method === "file.write" && op.method === "file.read";
}

function nodeMatches(rule: Rule, op: Operation): boolean {
	if (!rule.nodes) return true;
	// References are resolved to UUIDs at write time; `_all` matches every node the acting user can operate,
	// which is every node evaluated here: access was checked before the task was created.
	return rule.nodes.some((ref) => ref === ALL_TARGET || ref === op.node.id || op.node.groupIds.includes(ref));
}

function targetMatches(rule: Rule, op: Operation): boolean {
	if (rule.exact !== undefined) return op.target === rule.exact;
	if (rule.prefix !== undefined) return op.target.startsWith(rule.prefix);
	return true;
}

function privilegedMatches(rule: Rule, op: Operation): boolean {
	return rule.privileged === undefined || rule.privileged === op.privileged;
}

export function ruleMatches(rule: Rule, op: Operation): boolean {
	return methodMatches(rule, op) && nodeMatches(rule, op) && privilegedMatches(rule, op) && targetMatches(rule, op);
}

/** A level's own result: the strictest matching rule, else its default. */
function levelResult(set: RuleSet, op: Operation): { own: DefaultAction; rule?: number } {
	let best: { own: Action; rule: number } | undefined;
	set.rules.forEach((rule, i) => {
		if (!ruleMatches(rule, op)) return;
		if (!best || STRICTNESS[rule.action] > STRICTNESS[best.own]) best = { own: rule.action, rule: i };
	});
	return best ?? { own: set.default };
}

/**
 * Evaluates an operation along a chain, root first: each level can only tighten the one above
 * (eₖ = stricter(eₖ₋₁, rₖ), where inherit and allow add nothing).
 */
export function evaluate(chain: ChainLevel[], op: Operation): Evaluation {
	if (chain.length === 0) throw new Error("a rule chain needs a root");
	const levels: LevelResult[] = [];
	let effective: Action | undefined;
	for (const [i, level] of chain.entries()) {
		const { own, rule } = levelResult(level.set, op);
		if (i === 0 && own === "inherit") throw new Error("the root of a rule chain cannot inherit");
		const mine: Action = own === "inherit" ? "allow" : own;
		effective = effective === undefined ? mine : stricter(effective, mine);
		levels.push({
			scope: level.scope,
			own,
			...(rule === undefined ? {} : { rule, matched: level.set.rules[rule] }),
			effective,
		});
	}
	return { result: effective as Action, levels };
}

const KIND_METHOD: Record<string, Method> = {
	exec: "exec",
	"file.read": "file.read",
	"file.stat": "file.read",
	"file.list": "file.read",
	"file.write": "file.write",
	"file.edit": "file.write",
};

/** The method and target of a task spec (doc/privilege.md#方法与目标). */
export function operationOf(spec: TaskSpec): { method: Method; target: string } {
	const method = KIND_METHOD[spec.kind];
	if (!method) throw new Error("task spec has no kind");
	if (spec.kind === "exec") {
		const argv = "argv" in spec.command ? spec.command.argv : ["/bin/sh", "-c", spec.command.shell];
		return { method, target: argv.map(shellQuote).join(" ") };
	}
	// Normalized, so that "/etc/nginx/../shadow" is matched as "/etc/shadow". Symbolic links are not
	// resolved here; for privileged tasks crha refuses them (doc/privilege.md).
	return { method, target: posix.normalize(spec.path) };
}

/** Parses and validates a rule set from user input; throws UserError. */
export function parseRuleSet(raw: unknown, root: boolean): RuleSet {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UserError("rules must be an object");
	const o = raw as Record<string, unknown>;
	const def = o.default ?? (root ? undefined : "inherit");
	const allowed: readonly string[] = root ? ACTIONS : [...ACTIONS, "inherit"];
	if (typeof def !== "string" || !allowed.includes(def)) {
		throw new UserError(`default must be one of ${allowed.join(", ")}`);
	}
	return { default: def as DefaultAction, rules: parseRules(o.rules ?? []) };
}

export function parseRules(raw: unknown): Rule[] {
	if (!Array.isArray(raw)) throw new UserError("rules must be a list");
	if (raw.length > MAX_RULES) throw new UserError(`at most ${MAX_RULES} rules`);
	return raw.map((r, i) => parseRule(r, `rule ${i + 1}`));
}

function parseRule(raw: unknown, where: string): Rule {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UserError(`${where}: not an object`);
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o)) {
		if (!["action", "method", "nodes", "privileged", "exact", "prefix"].includes(k)) {
			throw new UserError(`${where}: unknown field ${k}`);
		}
	}
	if (typeof o.action !== "string" || !(ACTIONS as readonly string[]).includes(o.action)) {
		throw new UserError(`${where}: action must be one of ${ACTIONS.join(", ")}`);
	}
	const rule: Rule = { action: o.action as Action };
	if (o.privileged !== undefined) {
		if (typeof o.privileged !== "boolean") throw new UserError(`${where}: privileged must be a boolean`);
		rule.privileged = o.privileged;
	}
	if (o.method !== undefined) {
		if (typeof o.method !== "string" || !(METHODS as readonly string[]).includes(o.method)) {
			throw new UserError(`${where}: method must be one of ${METHODS.join(", ")}`);
		}
		rule.method = o.method as Method;
	}
	if (o.nodes !== undefined) {
		if (!Array.isArray(o.nodes) || o.nodes.length === 0 || !o.nodes.every((n) => typeof n === "string" && n)) {
			throw new UserError(`${where}: nodes must be a non-empty list of node names, node-group names, ids or _all`);
		}
		for (const ref of o.nodes as string[]) {
			if (ref !== ALL_TARGET && !isUuid(ref) && !NAME_RE.test(ref)) {
				throw new UserError(`${where}: ${JSON.stringify(ref)} is not a node or node-group name, a UUID or _all`);
			}
		}
		rule.nodes = o.nodes as string[];
	}
	const targets = (["exact", "prefix"] as const).filter((k) => o[k] !== undefined);
	if (targets.length > 1) throw new UserError(`${where}: exact and prefix are mutually exclusive`);
	for (const k of targets) {
		const v = o[k];
		if (typeof v !== "string" || v.length > MAX_PATTERN) {
			throw new UserError(`${where}: ${k} must be a string of at most ${MAX_PATTERN} characters`);
		}
		rule[k] = v;
	}
	return rule;
}
