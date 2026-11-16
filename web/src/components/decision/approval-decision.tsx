import type { ApprovalBody, Evaluation, ExternalCallView, Rule, TaskGroupView } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { alwaysRule } from "@/lib/approval-rules";
import { MONO_CELL } from "@/lib/utils";
import { DecisionFrame, DecisionTab, DecisionTabList, DecisionTabs, PrivilegedMark } from "./decision";
import { EvaluationTable, ReviewSummary } from "./evaluation";
import { RejectDecision } from "./reject";
import { ReviewingNotice } from "./reviewing-notice";
import { DecisionSummary, operationText } from "./summary";
import type { ApprovalDecisionItem } from "./types";

/** One candidate "Approve and always allow" rule, with the radio label its kind calls it. */
interface AlwaysCandidate {
	label: string;
	rule: Rule;
}

/** An api_request's target is the route it calls; its "always allow" is about that route. */
function isApiRequest(call: ExternalCallView): boolean {
	return call.extension === "crhs-api" && call.tool === "api_request";
}

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

function argument(call: ExternalCallView, name: string): unknown {
	const args = call.arguments;
	return typeof args === "object" && args !== null && !Array.isArray(args)
		? (args as Record<string, unknown>)[name]
		: undefined;
}

/** The kind-specific summary of an external call: the API request, or the extension tool and its arguments. */
function ExternalCallSummary({ call }: { call: ExternalCallView }) {
	const { t } = useLingui();
	const method = call.operation.method;
	const apiRequest = isApiRequest(call);
	const apiMethod = typeof argument(call, "method") === "string" ? String(argument(call, "method")).toUpperCase() : "";
	const apiPath = typeof argument(call, "path") === "string" ? String(argument(call, "path")) : "";
	const apiQuery = argument(call, "query");
	const apiBody = requestBody(argument(call, "body"));
	return (
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
					{call.annotations !== null && (
						<p className="text-xs text-muted-foreground" data-testid="external-call-annotations">
							<Trans>Annotations</Trans>: <code className={MONO_CELL}>{JSON.stringify(call.annotations)}</code>
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
		</div>
	);
}

/** The always-allow rules a kind offers, in the order its radios show them. */
function alwaysCandidates(item: ApprovalDecisionItem, nodeNames: Map<string, string>, i18n: I18n): AlwaysCandidate[] {
	if (item.kind === "external_call") {
		const call = item.call;
		const method = call.operation.method;
		const apiRequest = isApiRequest(call);
		const target = apiRequest ? call.operation.target : `${call.extension}/${call.tool}`;
		return [
			{
				label: i18n._(apiRequest ? msg`This request only` : msg`This tool only`),
				rule: { action: "allow", method, exact: target },
			},
			{
				label: i18n._(apiRequest ? msg`This route` : msg`The whole extension`),
				rule: { action: "allow", method, prefix: apiRequest ? target : `${call.extension}/` },
			},
		];
	}
	const task = item.kind === "task" ? item.task : undefined;
	const taskGroup = item.kind === "task_group" ? item.taskGroup : undefined;
	const subject = task ?? (taskGroup as TaskGroupView);
	if (subject.operation === null || subject.operation === undefined) return [];
	const nodes =
		task !== undefined
			? [nodeNames.get(task.nodeId) ?? task.nodeId]
			: (taskGroup?.approval?.nodes
					.filter((node) => node.evaluation.result === "require-approval")
					.map((node) => nodeNames.get(node.nodeId) ?? node.nodeId) ?? []);
	return (["exact", "prefix"] as const).flatMap((mode) => {
		const rule = alwaysRule(subject.operation, nodes, mode, subject.privileged);
		return rule === undefined ? [] : [{ label: i18n._(mode === "exact" ? msg`exact` : msg`prefix`), rule }];
	});
}

/** The one Always allow form: kind-specific candidates as radios, and the rule JSON it submits, editable. */
function AlwaysAllowForm({
	candidates,
	testId,
	busy,
	onSubmit,
}: {
	candidates: AlwaysCandidate[];
	testId?: string;
	busy: boolean;
	onSubmit: (rule: Rule) => void;
}) {
	const [selected, setSelected] = useState(0);
	const [text, setText] = useState(() => JSON.stringify(candidates[0]?.rule ?? {}, null, 2));
	const [error, setError] = useState<string>();
	const { t } = useLingui();
	const name = useId();
	const textareaId = useId();

	const choose = (index: number) => {
		setSelected(index);
		setText(JSON.stringify(candidates[index]?.rule ?? {}, null, 2));
	};
	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("expected a rule object");
			}
			setError(undefined);
			onSubmit(parsed as Rule);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};

	if (candidates.length === 0) return null;
	return (
		<form onSubmit={submit} className="grid gap-2 rounded-md border p-3" aria-label={t`Always allow rule`}>
			<div className="flex flex-wrap gap-4 text-sm">
				{candidates.map((candidate, index) => (
					<label key={candidate.label} className="flex items-center gap-1.5">
						<input type="radio" name={name} checked={selected === index} onChange={() => choose(index)} />
						{candidate.label}
					</label>
				))}
			</div>
			<label className="grid gap-1 text-xs" htmlFor={textareaId}>
				<span className="font-medium">
					<Trans>Rule to add to the caller's rule set</Trans>
				</span>
				<Textarea
					id={textareaId}
					data-testid={testId}
					className="font-mono text-xs"
					rows={7}
					value={text}
					onChange={(event) => setText(event.target.value)}
				/>
			</label>
			{error !== undefined && (
				<p role="alert" className="text-xs text-danger">
					<Trans>Not a valid rule: {error}</Trans>
				</p>
			)}
			<div className="flex justify-end">
				<Button type="submit" size="sm" disabled={busy}>
					<Trans>Approve and always allow</Trans>
				</Button>
			</div>
		</form>
	);
}

/**
 * The one pending approval panel (doc/design/webui.md "Shared components"): a task, a task group or an
 * external call, with the same title for every kind. The target and the operation, or the API request and
 * extension call details, then the Approve, Always allow and Reject tabs. The rule chain evaluation is
 * folded away until asked for. The parent supplies the mutation and the name lookups; the component stays
 * presentational.
 */
export function ApprovalDecision({
	item,
	nodeNames = new Map(),
	refNames,
	tokenNames = new Map(),
	busy = false,
	error,
	details,
	count,
	showReview = false,
	onDecide,
	className,
}: {
	item: ApprovalDecisionItem;
	nodeNames?: Map<string, string>;
	/** Current node and node-group names for UUIDs in rules; defaults to `nodeNames`. */
	refNames?: Map<string, string>;
	tokenNames?: Map<string, string>;
	busy?: boolean;
	error?: unknown;
	details?: ReactNode;
	count?: ReactNode;
	/** Show Auto Review's compact verdict under the summary (the session dock does; approval pages show it in full). */
	showReview?: boolean;
	onDecide: (body: ApprovalBody) => void;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const task = item.kind === "task" ? item.task : undefined;
	const taskGroup = item.kind === "task_group" ? item.taskGroup : undefined;
	const call = item.kind === "external_call" ? item.call : undefined;
	const phase = task?.phase ?? taskGroup?.phase ?? call?.phase;
	const approval = task?.approval ?? taskGroup?.approval ?? call?.approval;
	const evaluations: { label?: string; evaluation: Evaluation }[] =
		task !== undefined
			? task.approval
				? [{ evaluation: task.approval.evaluation }]
				: []
			: taskGroup !== undefined
				? (taskGroup.approval?.nodes ?? []).map((node) => ({
						label: nodeNames.get(node.nodeId) ?? node.nodeId,
						evaluation: node.evaluation,
					}))
				: call?.approval
					? [{ evaluation: call.approval.evaluation }]
					: [];
	const privileged = task?.privileged ?? taskGroup?.privileged ?? false;
	const readOnly =
		call !== undefined &&
		(call.annotations?.readOnlyHint === true || (isApiRequest(call) && call.operation.method.endsWith(".read")));
	const candidates = alwaysCandidates(item, nodeNames, i18n);
	const itemKey = task?.id ?? taskGroup?.id ?? call?.id ?? "";

	const summary =
		call !== undefined ? (
			<ExternalCallSummary call={call} />
		) : (
			<DecisionSummary
				ids={task !== undefined ? [task.nodeId] : (taskGroup?.targets ?? [])}
				refs={taskGroup?.refs}
				nodeNames={nodeNames}
				operation={operationText(
					task?.kind ?? taskGroup?.kind ?? "",
					task?.operation ?? taskGroup?.operation,
					task?.summary ?? taskGroup?.summary ?? "",
				)}
				purpose={task?.purpose ?? taskGroup?.purpose}
			/>
		);

	if (phase === "reviewing") return <ReviewingNotice summary={summary} className={className} />;

	const decide = (decision: "approve" | "reject", rule?: Rule, reason?: string) => {
		const body: ApprovalBody = {
			decision,
			...(decision === "reject" && reason !== undefined && reason !== "" ? { reason } : {}),
			...(rule ? { always: rule } : {}),
		};
		onDecide(body);
	};

	return (
		<DecisionFrame
			kind="approval"
			title={t`Your approval is needed`}
			badge={
				privileged ? (
					<PrivilegedMark />
				) : readOnly ? (
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs leading-none font-medium text-muted-foreground">
						<Trans>Read-only</Trans>
					</span>
				) : undefined
			}
			summary={
				<>
					{summary}
					{showReview && <ReviewSummary review={approval?.review} />}
				</>
			}
			details={details}
			count={count}
			className={className}
		>
			<DecisionTabs defaultValue="approve">
				<DecisionTabList label={t`How to decide`}>
					<DecisionTab value="approve">
						<Trans>Approve</Trans>
					</DecisionTab>
					<DecisionTab value="always" disabled={candidates.length === 0}>
						<Trans>Always allow</Trans>
					</DecisionTab>
					<DecisionTab value="reject">
						<Trans>Reject</Trans>
					</DecisionTab>
				</DecisionTabList>
				<TabsContent value="approve" className="grid min-w-0 gap-2 pt-1">
					<div className="flex justify-end">
						<Button type="button" disabled={busy} onClick={() => decide("approve")}>
							<Trans>Approve</Trans>
						</Button>
					</div>
					{evaluations.length > 0 && (
						<details className="w-full min-w-0 rounded-md border p-2">
							<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
								<Trans>Rule chain evaluation</Trans>
							</summary>
							<div className="mt-2 grid gap-3">
								{evaluations.map((entry) => (
									<div key={entry.label ?? "task"} className="grid min-w-0 gap-1">
										{entry.label !== undefined && (
											<h3 className="text-xs font-medium text-muted-foreground">{entry.label}</h3>
										)}
										<EvaluationTable
											evaluation={entry.evaluation}
											tokenNames={tokenNames}
											refNames={refNames ?? nodeNames}
										/>
									</div>
								))}
							</div>
						</details>
					)}
				</TabsContent>
				<TabsContent value="always" className="min-w-0 pt-1">
					<AlwaysAllowForm
						key={itemKey}
						candidates={candidates}
						testId={call === undefined ? undefined : "external-call-always-rule"}
						busy={busy}
						onSubmit={(rule) => decide("approve", rule)}
					/>
				</TabsContent>
				<TabsContent value="reject" className="min-w-0 pt-1">
					<RejectDecision busy={busy} onReject={(reason) => decide("reject", undefined, reason)} />
				</TabsContent>
			</DecisionTabs>
			{error !== undefined && <ErrorText error={error} />}
		</DecisionFrame>
	);
}
