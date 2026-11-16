import { Trans, useLingui } from "@lingui/react/macro";
import { CodeText } from "@/components/code-text";
import { InternalLink } from "@/components/internal-link";
import { Dialog, DialogContent, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { detailId, resultId, type ToolItem } from "./tool-call";
import { prettyJson } from "./tool-details";

/**
 * The dialog a tool card opens: the call's arguments, the returned result, and plain links to the task, task
 * group or subagent session the call names. A call that has not returned shows no result section; the
 * composer dock already shows approval and signature waits, and the card follows a live task.
 */
export function ToolDialog({
	item,
	open,
	onOpenChange,
}: {
	item: ToolItem;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLingui();
	const result = item.result;
	const returned = result !== undefined;
	const subagent =
		item.details !== null && typeof item.details === "object" && !Array.isArray(item.details)
			? item.details.sessionId
			: undefined;
	const subagentId = typeof subagent === "string" && subagent !== "" ? subagent : undefined;
	const hasArgs = Object.keys(item.args).length > 0;
	const taskId = resultId(item, "task_id") ?? detailId(item.details, "task_id");
	const taskGroupId = resultId(item, "task_group_id") ?? detailId(item.details, "task_group_id");
	const hasLinks = taskId !== undefined || taskGroupId !== undefined || subagentId !== undefined;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl" data-testid="tool-dialog">
				<DialogHeader>
					<DialogTitle className="pr-6 font-mono text-sm">{item.name}</DialogTitle>
				</DialogHeader>
				<DialogScrollArea className="grid max-h-[70vh] gap-3" data-testid="tool-output">
					{hasArgs && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Arguments</Trans>
							</span>
							<CodeText
								text={JSON.stringify(item.args, null, 2)}
								maxLines={0}
								preClassName="max-h-none"
								label={t`Tool arguments`}
							/>
						</div>
					)}
					{returned && (
						<div className="grid gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">
								<Trans>Result</Trans>
							</span>
							<ToolResultContent result={result} />
						</div>
					)}
					{hasLinks && (
						<div className="flex flex-wrap items-center gap-3 text-xs" data-testid="tool-dialog-links">
							{taskId !== undefined && (
								<InternalLink to="/tasks/$taskId" params={{ taskId }} className="text-xs">
									<Trans>Task details</Trans>
								</InternalLink>
							)}
							{taskGroupId !== undefined && (
								<InternalLink to="/task-groups/$taskGroupId" params={{ taskGroupId }} className="text-xs">
									<Trans>Task group details</Trans>
								</InternalLink>
							)}
							{subagentId !== undefined && (
								<InternalLink to="/sessions/$sessionId" params={{ sessionId: subagentId }} className="text-xs">
									<Trans>Subagent session</Trans>
								</InternalLink>
							)}
						</div>
					)}
				</DialogScrollArea>
			</DialogContent>
		</Dialog>
	);
}

/**
 * A returned tool result (doc/design/agent-runtime.md "Tool output"): one JSON block keeps the pretty JSON
 * view, while a text result shows each raw or note block in its own monospace block.
 */
function ToolResultContent({ result }: { result: NonNullable<ToolItem["result"]> }) {
	const { t } = useLingui();
	const blocks = result.blocks !== undefined && result.blocks.length > 0 ? result.blocks : [result.text];
	const only = blocks.length === 1 ? blocks[0] : undefined;
	const json = only === undefined ? undefined : prettyJson(only);
	if (json !== undefined) {
		return (
			<CodeText
				text={json.pretty}
				maxLines={0}
				preClassName="max-h-none"
				label={t`Tool result`}
				className={result.isError ? "border-danger/40" : undefined}
			/>
		);
	}
	return (
		<div className="grid gap-1.5" data-testid="tool-result-text">
			{blocks.map((block, index) => {
				const key = `${index}:${block.slice(0, 16)}`;
				return (
					<CodeText
						key={key}
						text={block}
						maxLines={0}
						preClassName="max-h-none"
						label={t`Tool result`}
						className={result.isError ? "border-danger/40" : undefined}
					/>
				);
			})}
		</div>
	);
}
