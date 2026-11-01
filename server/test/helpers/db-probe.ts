import type {
	DeleteQueryNode,
	KyselyPlugin,
	OperationNode,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	RootOperationNode,
	SchemableIdentifierNode,
	SelectQueryNode,
	TableNode,
	UpdateQueryNode,
} from "kysely";
import type { Db } from "../../src/storage/db.ts";

/**
 * A one-shot hook on the queries a runtime makes: `onNext` arms it, and the matching query runs `after` with its
 * result already computed (so a write can land "in between" and the caller still sees the stale rows). Tests use
 * it to place a session settle inside a runtime's read-then-write gap without racing wall time.
 */
export interface DbProbe {
	/** The database the runtime must be opened with; assertions can keep using the raw one. */
	db: Db;
	/** Arm the hook for the next query whose root node matches; it fires once. */
	onNext(match: (node: RootOperationNode) => boolean, after: () => Promise<void> | void): void;
	/** Counts the queries whose root node matches; `stop()` unregisters the counter and returns its count. */
	count(match: (node: RootOperationNode) => boolean): { stop: () => number };
}

/** The table a select/update/delete names directly (joins, CTEs and subqueries are not the table of the row). */
export function tableOf(node: OperationNode): string | undefined {
	if (node.kind === "SelectQueryNode") {
		const froms = (node as SelectQueryNode).from?.froms ?? [];
		if (froms.length !== 1 || froms[0]?.kind !== "TableNode") return undefined;
		return tableName((froms[0] as TableNode).table);
	}
	if (node.kind === "UpdateQueryNode") {
		const table = (node as UpdateQueryNode).table;
		if (table?.kind !== "TableNode") return undefined;
		return tableName((table as TableNode).table);
	}
	if (node.kind === "DeleteQueryNode") {
		const froms = (node as DeleteQueryNode).from.froms;
		if (froms.length !== 1 || froms[0]?.kind !== "TableNode") return undefined;
		return tableName((froms[0] as TableNode).table);
	}
	return undefined;
}

function tableName(identifier: OperationNode): string | undefined {
	if (identifier.kind !== "SchemableIdentifierNode") return undefined;
	return (identifier as SchemableIdentifierNode).identifier.name;
}

/** Installs the probe plugin on `db`; pass `probe.db` to the runtime under test. */
export function probeDb(db: Db): DbProbe {
	let next: { match: (node: RootOperationNode) => boolean; after: () => Promise<void> | void } | undefined;
	const counters: { match: (node: RootOperationNode) => boolean; hits: number }[] = [];
	const armed = new WeakMap<PluginTransformQueryArgs["queryId"], () => Promise<void> | void>();
	const plugin: KyselyPlugin = {
		transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
			for (const counter of counters) if (counter.match(args.node)) counter.hits++;
			if (!next?.match(args.node)) return args.node;
			const after = next.after;
			next = undefined;
			armed.set(args.queryId, after);
			return args.node;
		},
		async transformResult(args: PluginTransformResultArgs) {
			const after = armed.get(args.queryId);
			armed.delete(args.queryId);
			if (after) await after();
			return args.result;
		},
	};
	return {
		db: db.withPlugin(plugin),
		onNext(match, after) {
			next = { match, after };
		},
		count(match) {
			const counter = { match, hits: 0 };
			counters.push(counter);
			return {
				stop: () => {
					counters.splice(counters.indexOf(counter), 1);
					return counter.hits;
				},
			};
		},
	};
}
