/**
 * Whether "always allow" would end an approval (doc/design/access-control.md "Evaluation"). The rule goes to
 * the root of the request's chain, so it lifts only what the root imposes: a restriction from a lower level
 * (a subagent's own rules) or a stricter matching rule on the root itself stays. A candidate is offered, and
 * accepted, only when appending it to the root makes every waiting operation `allow`.
 */
import type { Rule, RuleRef, TaskGroupView } from "@crh/api";
import { nodeGroupIdsForNodes } from "../cluster/node-groups.ts";
import { type ChainLevel, evaluate, type Operation } from "../policy/rules.ts";
import { loadChain } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";

/** The operations a waiting request stands for, one per node for a task or a task group. */
export async function waitingOperations(
	db: Db,
	operation: { method: Operation["method"]; target: string },
	privileged: boolean,
	nodeIds: readonly string[] | null,
): Promise<Operation[]> {
	if (nodeIds === null) return [{ method: operation.method, target: operation.target, privileged }];
	const groups = await nodeGroupIdsForNodes(db, [...nodeIds]);
	return nodeIds.map((id) => ({
		method: operation.method,
		target: operation.target,
		privileged,
		node: { id, groupIds: groups.get(id) ?? [] },
	}));
}

/** Loads a request's chain once, to test several candidates against it. */
export async function loadRequestChain(db: Db, chain: readonly RuleRef[] | null): Promise<ChainLevel[] | null> {
	if (!chain || chain.length === 0) return null;
	try {
		return await loadChain(db, [...chain]);
	} catch {
		// A level that no longer exists (a deleted token) cannot be lifted by a rule either.
		return null;
	}
}

/** Whether `rule`, appended to the root, lets every operation run. The rule's nodes must be UUIDs. */
export function liftsWithRule(
	levels: readonly ChainLevel[] | null,
	operations: readonly Operation[],
	rule: Rule,
): boolean {
	const root = levels?.[0];
	if (!levels || !root || operations.length === 0) return false;
	const amended: ChainLevel[] = [
		{ ...root, set: { ...root.set, rules: [...root.set.rules, rule] } },
		...levels.slice(1),
	];
	return operations.every((operation) => evaluate(amended, operation).result === "allow");
}

/** The members of a task group the approval is for: those whose rule result needs approval. */
export function groupNodesNeedingApproval(group: TaskGroupView): string[] {
	return group.approval
		? group.approval.nodes.filter((node) => node.evaluation.result === "require-approval").map((node) => node.nodeId)
		: group.nodeIds;
}

/**
 * Whether an "always" rule sent with a decision would end the approval; one that would not is refused, so an
 * old page or a direct API call cannot append a rule that changes nothing.
 */
export async function alwaysRuleLifts(
	db: Db,
	chain: readonly RuleRef[] | null,
	operation: { method: Operation["method"]; target: string } | null,
	privileged: boolean,
	nodeIds: readonly string[] | null,
	rule: Rule,
): Promise<boolean> {
	if (!operation) return false;
	return liftsWithRule(
		await loadRequestChain(db, chain),
		await waitingOperations(db, operation, privileged, nodeIds),
		rule,
	);
}
