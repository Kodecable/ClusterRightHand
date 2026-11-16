import type { NodeGroupRef, RefMap } from "@crh/api";
import { formatList } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LocalizedList } from "@/components/localized-list";
import { ALL_TARGET } from "@/lib/names";
import { cn, linkClass, MONO_CELL } from "@/lib/utils";

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
 * `nodeNames` is the fallback for an id the response did not describe; an id no
 * name is known for stays visible as muted monospace text.
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
	return <span className={cn(MONO_CELL, "text-muted-foreground")}>{id}</span>;
}

/** A table cell's target list: one clipped line instead of wrapping over several rows. */
const COMPACT_CLASS = "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom";

/**
 * The full text of a target list, for a truncated cell's tooltip: the locale's list plus the one
 * "and N more" wording. The visible lists below build the same message.
 */
export function nodeTargetsText(i18n: I18n, names: readonly string[], more = 0): string {
	if (names.length === 0) return "";
	const list = formatList(i18n.locale, names);
	return more > 0 ? i18n._(msg`${list} and ${more} more`) : list;
}

/** The names of the targets a compact request carries (it sends names, not ids). */
export function NodeNameList({
	names,
	more = 0,
	compact = false,
	empty = "–",
	className,
}: {
	names: readonly string[];
	more?: number;
	compact?: boolean;
	empty?: React.ReactNode;
	className?: string;
}) {
	if (names.length === 0) return <>{empty}</>;
	const list = <LocalizedList items={names} getKey={(name) => name} render={(name) => <span>{name}</span>} />;
	return (
		<span data-slot="node-targets" className={cn(compact ? COMPACT_CLASS : "inline min-w-0", className)}>
			{more > 0 ? (
				<Trans>
					{list} and {more} more
				</Trans>
			) : (
				list
			)}
		</span>
	);
}

/**
 * A localized list of stored targets, for a task group or a rule. `more` renders the targets left
 * out of a compact request as part of the same message; `compact` keeps the list on one clipped line
 * for a table cell.
 */
export function NodeTargetList({
	ids,
	refs,
	nodeNames,
	more = 0,
	compact = false,
	empty = "–",
	className,
}: {
	ids?: readonly string[];
	refs?: RefMap;
	nodeNames?: Map<string, string>;
	/** Targets the server left out of a compact request; rendered as "and N more". */
	more?: number;
	/** One clipped, non-wrapping line for a table cell. */
	compact?: boolean;
	empty?: React.ReactNode;
	className?: string;
}) {
	if (ids === undefined || ids.length === 0) return <>{empty}</>;
	const list = (
		<LocalizedList
			items={ids}
			getKey={(id) => id}
			render={(id) => <NodeTarget id={id} refs={refs} nodeNames={nodeNames} />}
		/>
	);
	return (
		<span data-slot="node-targets" className={cn(compact ? COMPACT_CLASS : "inline min-w-0", className)}>
			{more > 0 ? (
				<Trans>
					{list} and {more} more
				</Trans>
			) : (
				list
			)}
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
