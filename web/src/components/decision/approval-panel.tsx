import type { ApprovalAlwaysAllow, ApprovalBody, ApprovalRequest, Rule } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { type DecisionVariant, requestCardContent } from "./content";
import { DecisionCard, DecisionTab, DecisionTabList, DecisionTabs } from "./decision";
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
 * The one pending rule approval (doc/design/webui.md "Shared components"): the server-built compact request
 * in the shared card layout, then the Approve, Always allow and Reject tabs. Auto Review's verdict sits in
 * the card; the rule chain and payload details belong to the page's RequestDetails, never to the panel.
 */
export function ApprovalPanel({
	request,
	variant = "inline",
	busy = false,
	error,
	details,
	count,
	onDecide,
	className,
}: {
	request: ApprovalRequest;
	variant?: DecisionVariant;
	busy?: boolean;
	error?: unknown;
	/** A link to the task, task group or external call the decision belongs to. */
	details?: ReactNode;
	/** e.g. "1 of 3" while more decisions wait behind this one. */
	count?: ReactNode;
	/** The body of the approve/reject decision; `always` carries the edited allow rule. */
	onDecide: (body: ApprovalBody) => void;
	className?: string;
}) {
	const { t, i18n } = useLingui();
	const candidates = alwaysCandidates(request, i18n);
	const itemKey = `${request.kind}:${request.id}`;
	const content = requestCardContent(request, { variant, i18n });

	if (request.phase === "reviewing") {
		return (
			<DecisionCard
				{...content}
				kind="approval"
				variant={variant}
				count={count}
				details={details}
				className={className}
			>
				<ReviewingNotice />
			</DecisionCard>
		);
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
		<DecisionCard {...content} kind="approval" variant={variant} count={count} details={details} className={className}>
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
		</DecisionCard>
	);
}
