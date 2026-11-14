import type { ApprovalBody, ExternalCallView, Rule } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { MONO_CELL } from "@/lib/utils";
import { DecisionFrame, DecisionTab, DecisionTabList, DecisionTabs } from "./decision";
import { EvaluationTable } from "./evaluation";
import { RejectDecision } from "./reject";

/** One waiting external call as the session dock and the approvals page show it. */
export function ExternalCallDecision({
	call,
	busy = false,
	error,
	count,
	details,
	onDecide,
}: {
	call: ExternalCallView;
	busy?: boolean;
	error?: unknown;
	count?: ReactNode;
	details?: ReactNode;
	onDecide: (body: ApprovalBody) => void;
}) {
	const { t } = useLingui();
	const [always, setAlways] = useState<"tool" | "server">("tool");
	const method = call.operation.method;
	const rule = (scope: "tool" | "server"): Rule => ({
		action: "allow",
		method,
		exact: scope === "tool" ? `${call.server}/${call.tool}` : undefined,
		prefix: scope === "server" ? `${call.server}/` : undefined,
	});
	const annotations = call.annotations;
	return (
		<DecisionFrame
			kind="approval"
			title={t`An external tool call needs approval`}
			badge={
				annotations?.readOnlyHint === true ? (
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs leading-none font-medium text-muted-foreground">
						<Trans>Read-only</Trans>
					</span>
				) : undefined
			}
			summary={
				<div className="grid min-w-0 gap-1.5" data-slot="decision-summary">
					<p className="text-xs text-muted-foreground">
						<Trans>Server</Trans>: <code className={MONO_CELL}>{call.server}</code>
						{" · "}
						<Trans>Tool</Trans>: <code className={MONO_CELL}>{call.tool}</code>
						{" · "}
						{method === "mcp.read" ? <Trans>Operation: read</Trans> : <Trans>Operation: write</Trans>}
					</p>
					{annotations !== null && (
						<p className="text-xs text-muted-foreground" data-testid="external-call-annotations">
							<Trans>Annotations</Trans>: <code className={MONO_CELL}>{JSON.stringify(annotations)}</code>
						</p>
					)}
					<pre
						data-testid="external-call-arguments"
						title={t`Arguments`}
						className="max-h-40 w-full min-w-0 overflow-auto rounded bg-[var(--code)] px-2 py-1 font-mono text-xs leading-5 whitespace-pre-wrap"
					>
						{JSON.stringify(call.arguments, null, 2)}
					</pre>
				</div>
			}
			details={details}
			count={count}
		>
			<DecisionTabs defaultValue="approve">
				<DecisionTabList label={t`How to decide`}>
					<DecisionTab value="approve">
						<Trans>Approve</Trans>
					</DecisionTab>
					<DecisionTab value="always">
						<Trans>Always allow</Trans>
					</DecisionTab>
					<DecisionTab value="reject">
						<Trans>Reject</Trans>
					</DecisionTab>
				</DecisionTabList>
				<TabsContent value="approve" className="grid min-w-0 gap-2 pt-1">
					<div className="flex justify-end">
						<Button type="button" disabled={busy} onClick={() => onDecide({ decision: "approve" })}>
							<Trans>Approve</Trans>
						</Button>
					</div>
					{call.approval?.evaluation !== undefined && (
						<details className="w-full min-w-0 rounded-md border p-2">
							<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
								<Trans>Rule chain evaluation</Trans>
							</summary>
							<div className="mt-2">
								<EvaluationTable evaluation={call.approval.evaluation} />
							</div>
						</details>
					)}
				</TabsContent>
				<TabsContent value="always" className="grid min-w-0 gap-2 pt-1">
					<div className="flex gap-4 text-sm">
						<label className="flex items-center gap-1.5">
							<input
								type="radio"
								name="external-always-mode"
								checked={always === "tool"}
								onChange={() => setAlways("tool")}
							/>
							<Trans>This tool only</Trans>
						</label>
						<label className="flex items-center gap-1.5">
							<input
								type="radio"
								name="external-always-mode"
								checked={always === "server"}
								onChange={() => setAlways("server")}
							/>
							<Trans>The whole server</Trans>
						</label>
					</div>
					<pre className="rounded bg-[var(--code)] p-2 font-mono text-xs" data-testid="external-call-always-rule">
						{JSON.stringify(rule(always), null, 2)}
					</pre>
					<div className="flex justify-end">
						<Button
							type="button"
							disabled={busy}
							onClick={() => onDecide({ decision: "approve", always: rule(always) })}
						>
							<Trans>Approve and always allow</Trans>
						</Button>
					</div>
				</TabsContent>
				<TabsContent value="reject" className="min-w-0 pt-1">
					<RejectDecision busy={busy} onReject={(reason) => onDecide({ decision: "reject", reason })} />
				</TabsContent>
			</DecisionTabs>
			{error !== undefined && <ErrorText error={error} />}
		</DecisionFrame>
	);
}
