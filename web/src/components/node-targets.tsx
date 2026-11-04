import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import type { NodeGroupRef, RefMap } from "@/lib/api/types";
import { ALL_TARGET } from "@/lib/names";
import { cn } from "@/lib/utils";

const LINK_CLASS = "text-primary underline underline-offset-2";

export function NodeLink({ id, name }: { id: string; name: string }) {
	return (
		<Link to="/nodes/$nodeId" params={{ nodeId: id }} className={LINK_CLASS}>
			{name}
		</Link>
	);
}

function NodeGroupLink({ id, name }: { id: string; name: string }) {
	return (
		<Link to="/node-groups/$nodeGroupId" params={{ nodeGroupId: id }} className={LINK_CLASS}>
			{name}
		</Link>
	);
}

/**
 * One stored node/node-group reference: its current name and a link, `_all` as
 * "All my nodes", and a deleted object by what can still be said about it.
 * `nodeNames` is the fallback for an id the response did not describe.
 */
export function NodeTarget({ id, refs, nodeNames }: { id: string; refs?: RefMap; nodeNames?: Map<string, string> }) {
	if (id === ALL_TARGET)
		return (
			<span>
				<Trans>All my nodes</Trans>
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

/** A comma-separated list of stored targets, for a task group or a rule. */
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
		<span data-slot="node-targets" className={cn("inline-flex flex-wrap items-center gap-x-1", className)}>
			{ids.map((id, index) => (
				<Fragment key={id}>
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<NodeTarget id={id} refs={refs} nodeNames={nodeNames} />
				</Fragment>
			))}
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
		<span data-slot="node-group-links" className={cn("inline-flex flex-wrap items-center gap-x-1", className)}>
			{nodeGroups.map((group, index) => (
				<Fragment key={group.id}>
					{index > 0 && <span className="text-muted-foreground">,</span>}
					<NodeGroupLink id={group.id} name={group.name} />
				</Fragment>
			))}
		</span>
	);
}
