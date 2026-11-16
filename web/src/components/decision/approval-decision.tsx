import type { ApprovalAlwaysAllow, ApprovalBody, ApprovalRequest, Evaluation, Rule } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApprovalSummary } from "./approval-summary";
import { DecisionFrame, DecisionTab, DecisionTabList, DecisionTabs } from "./decision";
import { EvaluationTable } from "./evaluation";
import { RejectDecision } from "./reject";
import { ReviewingNotice } from "./reviewing-notice";

/** The localized radio label of a server-built always-allow candidate. */
const ALWAYS_OPTION_LABELS: Record<ApprovalAlwaysAllow["option"], MessageDescriptor> = {
	exact: msg`exact`,
	prefix: msg`prefix`,
	tool: msg`This tool only`,
	extension: msg`The whole extension`,
	request: msg`This request only`,
	route: msg`This route`,
};

/** One candidate "Approve and always allow" rule, with its radio label. */
interface AlwaysCandidate {
	label: string;
	rule: Rule;
}

/** The always-allow candidates the server built for this request, in display order. */
function alwaysCandidates(request: ApprovalRequest, i18n: I18n): AlwaysCandidate[] {
	return request.alwaysAllow.map((candidate) => ({
		label: i18n._(ALWAYS_OPTION_LABELS[candidate.option]),
		rule: candidate.rule,
	}));
}

/** One folded rule chain level: one evaluation, or one per task-group node. */
export interface ApprovalEvaluation {
	label?: string;
	evaluation: Evaluation;
}

/** The one Always allow form: the candidate radios and the editable rule JSON they submit. */
function AlwaysAllowForm({
	candidates,
	busy,
	onSubmit,
}: {
	candidates: AlwaysCandidate[];
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
 * The one pending approval panel (doc/design/webui.md "Shared components"): the server-built compact
 * request, then the Approve, Always allow and Reject tabs. The summary is requester, action, nodes and
 * privileged, and Auto Review's verdict — the same information every display surface shows. The rule chain
 * is folded away until asked for. The parent supplies the mutation and the name lookups; the component
 * stays presentational.
 */
export function ApprovalDecision({
	request,
	evaluations,
	nodeNames = new Map(),
	refNames,
	tokenNames = new Map(),
	busy = false,
	error,
	details,
	count,
	onDecide,
	className,
}: {
	request: ApprovalRequest;
	/** The rule chain evaluation(s) behind the request, folded away until asked for. */
	evaluations?: readonly ApprovalEvaluation[];
	nodeNames?: Map<string, string>;
	/** Current node and node-group names for UUIDs in rules; defaults to `nodeNames`. */
	refNames?: Map<string, string>;
	tokenNames?: Map<string, string>;
	busy?: boolean;
	error?: unknown;
	details?: ReactNode;
	count?: ReactNode;
	/** The body of the approve/reject decision; `always` carries the edited allow rule. */
	onDecide: (body: ApprovalBody) => void;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const candidates = alwaysCandidates(request, i18n);
	const itemKey = `${request.kind}:${request.id}`;

	if (request.phase === "reviewing") {
		return <ReviewingNotice summary={<ApprovalSummary request={request} />} className={className} />;
	}

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
			summary={<ApprovalSummary request={request} />}
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
					{evaluations !== undefined && evaluations.length > 0 && (
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
