import type { Operation, RefMap } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { NodeTargetList } from "@/components/node-targets";
import { cn } from "@/lib/utils";

/**
 * The operation of a task or task group on one line: its kind and the
 * parameter that identifies it (the rendered command or the path). The task
 * page's summary is the fallback when the server reports no operation.
 */
export function operationText(kind: string, operation: Operation | null | undefined, summary: string): string {
	const target = operation?.target ?? summary;
	return target.trim() === "" ? kind : `${kind}  ${target}`;
}

/**
 * What a decision is about, and nothing else (doc/design/webui.md "Shared components"): the target
 * nodes by name and the operation on one truncated line. Technical fields —
 * payload ids, attempts, hashes, deadlines — stay out of the default view.
 */
export function DecisionSummary({
	ids,
	refs,
	nodeNames,
	operation,
	purpose,
	className,
}: {
	/** Target ids: one node for a task, the stored targets for a task group. */
	ids: readonly string[];
	refs?: RefMap;
	nodeNames?: Map<string, string>;
	/** The full operation line; it is truncated with its text in `title`. */
	operation: string;
	/** Why a dedicated feature created it, such as `browse` for the node file manager. */
	purpose?: string | null;
	className?: string;
}) {
	const { t } = useLingui();
	const purposeLabel = purpose === "browse" ? t`File browsing` : purpose;
	return (
		<div data-slot="decision-summary" className={cn("grid min-w-0 gap-1", className)}>
			<p className="min-w-0 text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">
				<Trans>Targets</Trans>
				{": "}
				<NodeTargetList ids={ids} refs={refs} nodeNames={nodeNames} className="min-w-0" />
			</p>
			{purposeLabel !== null && purposeLabel !== undefined && purposeLabel !== "" && (
				<p className="text-xs text-muted-foreground" data-testid="decision-purpose">
					<Trans>Purpose</Trans>: {purposeLabel}
				</p>
			)}
			<code
				data-testid="decision-operation"
				title={operation}
				className="block w-full min-w-0 truncate rounded bg-[var(--code)] px-2 py-1 font-mono text-xs leading-5"
			>
				{operation}
			</code>
		</div>
	);
}
