import type { ApprovalBody, ExternalCallView, Rule } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { MONO_CELL } from "@/lib/utils";
import { DecisionFrame, DecisionTab, DecisionTabList, DecisionTabs } from "./decision";
import { EvaluationTable, ReviewSummary } from "./evaluation";
import { RejectDecision } from "./reject";

/** One waiting external call as the session dock and the approvals page show it. */
/** The body as crhs sends it: a string holding a JSON object or list is sent as that JSON (api-request.ts). */
function requestBody(body: unknown): unknown {
	if (typeof body !== "string") return body;
	try {
		const value: unknown = JSON.parse(body);
		return typeof value === "object" && value !== null ? value : body;
	} catch {
		return body;
	}
}

export function ExternalCallDecision({
	call,
	busy = false,
	error,
	count,
	details,
	showReview = false,
	onDecide,
}: {
	call: ExternalCallView;
	busy?: boolean;
	error?: unknown;
	count?: ReactNode;
	details?: ReactNode;
	/** Show Auto Review's compact verdict under the summary (the session dock does; approval pages show it in full). */
	showReview?: boolean;
	onDecide: (body: ApprovalBody) => void;
}) {
	const { t } = useLingui();
	const [always, setAlways] = useState<"tool" | "extension">("tool");
	const method = call.operation.method;
	// `api_request` is one built-in tool whose target is the route it calls, so "always allow" is about that
	// route, not about `crhs-api/api_request` (doc/design/extensions.md "Rules and approvals").
	const apiRequest = call.extension === "crhs-api" && call.tool === "api_request";
	const target = apiRequest ? call.operation.target : `${call.extension}/${call.tool}`;
	const rule = (scope: "tool" | "extension"): Rule =>
		apiRequest
			? {
					action: "allow",
					method,
					exact: scope === "tool" ? target : undefined,
					prefix: scope === "extension" ? target : undefined,
				}
			: {
					action: "allow",
					method,
					exact: scope === "tool" ? target : undefined,
					prefix: scope === "extension" ? `${call.extension}/` : undefined,
				};
	const annotations = call.annotations;
	const argument = (name: string): unknown => {
		const args = call.arguments;
		return typeof args === "object" && args !== null && !Array.isArray(args)
			? (args as Record<string, unknown>)[name]
			: undefined;
	};
	const apiMethod = typeof argument("method") === "string" ? String(argument("method")).toUpperCase() : "";
	const apiPath = typeof argument("path") === "string" ? String(argument("path")) : "";
	const apiQuery = argument("query");
	const apiBody = requestBody(argument("body"));
	return (
		<DecisionFrame
			kind="approval"
			title={apiRequest ? t`An API request needs approval` : t`An extension tool call needs approval`}
			badge={
				annotations?.readOnlyHint === true || (apiRequest && method.endsWith(".read")) ? (
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs leading-none font-medium text-muted-foreground">
						<Trans>Read-only</Trans>
					</span>
				) : undefined
			}
			summary={
				<div className="grid min-w-0 gap-1.5" data-slot="decision-summary">
					{apiRequest ? (
						<>
							<p className="text-xs text-muted-foreground" data-testid="external-call-api-request">
								<Trans>Method</Trans>: <code className={MONO_CELL}>{apiMethod}</code>
								{" · "}
								<Trans>Path</Trans>: <code className={MONO_CELL}>{apiPath}</code>
								{" · "}
								{method.endsWith(".read") ? <Trans>Operation: read</Trans> : <Trans>Operation: write</Trans>}
							</p>
							{apiQuery !== undefined && (
								<p className="text-xs text-muted-foreground" data-testid="external-call-query">
									<Trans>Query</Trans>: <code className={MONO_CELL}>{JSON.stringify(apiQuery)}</code>
								</p>
							)}
							{apiBody !== undefined && (
								<pre
									data-testid="external-call-body"
									title={t`Body`}
									className="max-h-40 w-full min-w-0 overflow-auto rounded bg-[var(--code)] px-2 py-1 font-mono text-xs leading-5 whitespace-pre-wrap"
								>
									{JSON.stringify(apiBody, null, 2)}
								</pre>
							)}
						</>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								<Trans>Extension</Trans>: <code className={MONO_CELL}>{call.extension}</code>
								{" · "}
								<Trans>Tool</Trans>: <code className={MONO_CELL}>{call.tool}</code>
								{" · "}
								{method.endsWith(".read") ? <Trans>Operation: read</Trans> : <Trans>Operation: write</Trans>}
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
						</>
					)}
					{showReview && <ReviewSummary review={call.approval?.review} />}
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
							{apiRequest ? <Trans>This request only</Trans> : <Trans>This tool only</Trans>}
						</label>
						<label className="flex items-center gap-1.5">
							<input
								type="radio"
								name="external-always-mode"
								checked={always === "extension"}
								onChange={() => setAlways("extension")}
							/>
							{apiRequest ? <Trans>This route</Trans> : <Trans>The whole extension</Trans>}
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
