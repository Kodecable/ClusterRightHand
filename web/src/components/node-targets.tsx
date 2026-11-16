import type { NodeGroupRef, RefMap } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LocalizedList } from "@/components/localized-list";
import { ALL_TARGET } from "@/lib/names";
import { cn, linkClass } from "@/lib/utils";

export function NodeLink({ id, name }: { id: string; name: string }) {
	return (
		<Link to="/nodes/$nodeId" params={{ nodeId: id }} className={linkClass}>
			{name}
		</Link>
	);
}

function NodeGroupLink({ id, name }: { id: string; name: string }) {
	return (
		<Link to="/node-groups/$nodeGroupId" params={{ nodeGroupId: id }} className={linkClass}>
			{name}
		</Link>
	);
}

/**
 * One stored node/node-group reference: its current name and a link, `_all` as
 * "All accessible nodes", and a deleted object by what can still be said about it.
 * `nodeNames` is the fallback for an id the response did not describe.
 */
export function NodeTarget({ id, refs, nodeNames }: { id: string; refs?: RefMap; nodeNames?: Map<string, string> }) {
	if (id === ALL_TARGET)
		return (
			<span>
				<Trans>All accessible nodes</Trans>
			</span>
		);
	const target = refs?.[id];
	// The server reports a deleted reference as null and keeps no kind for it.
	if (target === null)
		return (
			<span>
				<Trans>Deleted node or node group</Trans>
			</span>
		);
	if (target !== undefined) {
		return target.kind === "node" ? (
			<NodeLink id={id} name={target.name} />
		) : (
			<NodeGroupLink id={id} name={target.name} />
		);
	}
	const name = nodeNames?.get(id);
	if (name !== undefined) return <NodeLink id={id} name={name} />;
	return <span className="font-mono text-xs">{id}</span>;
}

/** A localized list of stored targets, for a task group or a rule. */
export function NodeTargetList({
	ids,
	refs,
	nodeNames,
	empty = "–",
	className,
}: {
	ids?: readonly string[];
	refs?: RefMap;
	nodeNames?: Map<string, string>;
	empty?: React.ReactNode;
	className?: string;
}) {
	if (ids === undefined || ids.length === 0) return <>{empty}</>;
	return (
		<span data-slot="node-targets" className={cn("inline", className)}>
			<LocalizedList
				items={ids}
				getKey={(id) => id}
				render={(id) => <NodeTarget id={id} refs={refs} nodeNames={nodeNames} />}
			/>
		</span>
	);
}

/** A node's node groups as links, e.g. in the nodes table and on the node page. */
export function NodeGroupLinks({
	nodeGroups,
	empty = "–",
	className,
}: {
	nodeGroups: readonly NodeGroupRef[];
	empty?: React.ReactNode;
	className?: string;
}) {
	if (nodeGroups.length === 0) return <>{empty}</>;
	return (
		<span data-slot="node-group-links" className={cn("inline", className)}>
			<LocalizedList
				items={nodeGroups}
				getKey={(group) => group.id}
				render={(group) => <NodeGroupLink id={group.id} name={group.name} />}
			/>
		</span>
	);
}
