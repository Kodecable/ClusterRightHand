import type { ApprovalBody, Evaluation, Operation, Rule } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { alwaysRule } from "@/lib/approval-rules";
import { DecisionFrame, DecisionTab, DecisionTabList, DecisionTabs, PrivilegedMark } from "./decision";
import { EvaluationTable } from "./evaluation";
import { RejectDecision } from "./reject";
import { DecisionSummary, operationText } from "./summary";
import type { ApprovalItem } from "./types";

function AlwaysAllowForm({
	operation,
	nodeNames,
	privileged,
	busy,
	onSubmit,
}: {
	operation: Operation | null | undefined;
	nodeNames: string[];
	privileged: boolean;
	busy: boolean;
	onSubmit: (rule: Rule) => void;
}) {
	const [mode, setMode] = useState<"exact" | "prefix">("exact");
	const build = (next: "exact" | "prefix") => {
		const rule = alwaysRule(operation, nodeNames, next, privileged);
		return rule ? JSON.stringify(rule, null, 2) : "";
	};
	const [text, setText] = useState(() => build("exact"));
	const [error, setError] = useState<string>();
	const { t } = useLingui();

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

	return (
		<form onSubmit={submit} className="grid gap-2 rounded-md border p-3" aria-label={t`Always allow rule`}>
			<div className="flex gap-4 text-sm">
				<label className="flex items-center gap-1.5">
					<input
						type="radio"
						name="always-mode"
						checked={mode === "exact"}
						onChange={() => {
							setMode("exact");
							setText(build("exact"));
						}}
					/>
					<Trans>exact</Trans>
				</label>
				<label className="flex items-center gap-1.5">
					<input
						type="radio"
						name="always-mode"
						checked={mode === "prefix"}
						onChange={() => {
							setMode("prefix");
							setText(build("prefix"));
						}}
					/>
					<Trans>prefix</Trans>
				</label>
			</div>
			<label className="grid gap-1 text-xs" htmlFor="always-rule">
				<span className="font-medium">
					<Trans>Rule to add to the caller's rule set</Trans>
				</span>
				<Textarea
					id="always-rule"
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
 * A pending rule approval (doc/design/webui.md "Shared components"): the target nodes and the
 * operation, then the Approve, Always allow and Reject tabs. The rule chain
 * evaluation is folded away until asked for. The parent supplies the mutation
 * and the name lookups; the component stays presentational.
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
	onDecide,
	className,
}: {
	item: ApprovalItem;
	nodeNames?: Map<string, string>;
	/** Current node and node-group names for UUIDs in rules; defaults to `nodeNames`. */
	refNames?: Map<string, string>;
	tokenNames?: Map<string, string>;
	busy?: boolean;
	error?: unknown;
	details?: ReactNode;
	count?: ReactNode;
	onDecide: (body: ApprovalBody) => void;
	className?: string;
}) {
	const { t } = useLingui();
	const subject = item.kind === "task" ? item.task : item.taskGroup;
	const ids = item.kind === "task" ? [item.task.nodeId] : item.taskGroup.targets;
	const evaluations: { label?: string; evaluation: Evaluation }[] =
		item.kind === "task"
			? item.task.approval
				? [{ evaluation: item.task.approval.evaluation }]
				: []
			: (item.taskGroup.approval?.nodes ?? []).map((node) => ({
					label: nodeNames.get(node.nodeId) ?? node.nodeId,
					evaluation: node.evaluation,
				}));
	const ruleNodes =
		item.kind === "task"
			? [nodeNames.get(item.task.nodeId) ?? item.task.nodeId]
			: (item.taskGroup.approval?.nodes
					.filter((node) => node.evaluation.result === "require-approval")
					.map((node) => nodeNames.get(node.nodeId) ?? node.nodeId) ?? []);

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
			badge={subject.privileged ? <PrivilegedMark /> : undefined}
			summary={
				<DecisionSummary
					ids={ids}
					refs={item.kind === "task_group" ? item.taskGroup.refs : undefined}
					nodeNames={nodeNames}
					operation={operationText(subject.kind, subject.operation, subject.summary)}
					purpose={item.kind === "task_group" ? item.taskGroup.purpose : item.task.purpose}
				/>
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
					<DecisionTab value="always" disabled={subject.operation === null}>
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
						operation={subject.operation}
						nodeNames={ruleNodes}
						privileged={subject.privileged}
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
