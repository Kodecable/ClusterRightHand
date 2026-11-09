import type { ApprovalBody, Evaluation, Operation, Rule, TaskGroupView, TaskView } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { ErrorText } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeTargetList } from "@/components/node-targets";
import { DateTime } from "@/components/relative-time";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { actorLabel, alwaysRule } from "@/features/approvals/rules";
import { ruleWithNames } from "@/lib/refs";
import { ruleResultTone } from "@/lib/status";
import { cn } from "@/lib/utils";

export type ApprovalItem = { kind: "task"; task: TaskView } | { kind: "task_group"; taskGroup: TaskGroupView };

const RULE_RESULT_LABELS: Record<string, MessageDescriptor> = {
	allow: msg`Allow`,
	deny: msg`Deny`,
	"require-approval": msg`Require approval`,
	inherit: msg`Inherit`,
};

/** A rule result's translated label; an unknown value stays visible raw. */
function ruleResultLabel(i18n: I18n, result: string): string {
	const descriptor = RULE_RESULT_LABELS[result];
	return descriptor === undefined ? result : i18n._(descriptor);
}

/** The rule chain evaluation: for each level its scope, own result, deciding rule and effective result. */
export function EvaluationTable({
	evaluation,
	tokenNames,
	refNames,
}: {
	evaluation: Evaluation;
	tokenNames?: Map<string, string>;
	/** Current node and node-group names for the UUIDs a matched rule stores (D109). */
	refNames?: Map<string, string>;
}) {
	const { t, i18n } = useLingui();
	return (
		<div className="overflow-x-auto rounded-md border">
			<table aria-label={t`Rule chain evaluation`} className="w-full text-xs">
				<thead className="bg-muted/60 text-muted-foreground">
					<tr>
						<th className="px-2 py-1.5 text-left font-medium">
							<Trans>Level</Trans>
						</th>
						<th className="px-2 py-1.5 text-left font-medium">
							<Trans>Own result</Trans>
						</th>
						<th className="px-2 py-1.5 text-left font-medium">
							<Trans>Matched rule</Trans>
						</th>
						<th className="px-2 py-1.5 text-left font-medium">
							<Trans>Effective</Trans>
						</th>
					</tr>
				</thead>
				<tbody>
					{evaluation.levels.map((level) => (
						<tr key={`${level.scope.type}:${level.scope.id}`} className="border-t">
							<td className="px-2 py-1.5">
								{level.scope.type === "api_token" ? <Trans>API token</Trans> : level.scope.type}{" "}
								<span className="font-mono">{tokenNames?.get(level.scope.id) ?? level.scope.id}</span>
							</td>
							<td className="px-2 py-1.5">
								<StatusText tone={ruleResultTone(level.own)}>{ruleResultLabel(i18n, level.own)}</StatusText>
							</td>
							<td className="max-w-64 px-2 py-1.5">
								{level.matched ? (
									<code className="block truncate font-mono">
										{JSON.stringify(ruleWithNames(level.matched, refNames ?? new Map()))}
									</code>
								) : (
									<span className="text-muted-foreground">
										<Trans>default</Trans>
									</span>
								)}
							</td>
							<td className="px-2 py-1.5">
								<StatusText tone={ruleResultTone(level.effective)}>{ruleResultLabel(i18n, level.effective)}</StatusText>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** The decision recorded on an approval. */
export function DecisionView({
	decision,
	tokenNames = new Map(),
}: {
	decision: NonNullable<TaskView["approval"]>["decision"];
	/** Resolves an API token's id to its name, for the deciding actor. */
	tokenNames?: Map<string, string>;
}) {
	if (!decision) return null;
	return (
		<KeyValueList
			items={[
				{
					label: <Trans>Decision</Trans>,
					value: (
						<StatusText tone={decision.decision === "approved" ? "ok" : "danger"}>
							{decision.decision === "approved" ? <Trans>Approved</Trans> : <Trans>Rejected</Trans>}
						</StatusText>
					),
				},
				{
					label: <Trans>Decided by</Trans>,
					value: <span>{actorLabel(decision.by.type, decision.by.id, tokenNames)}</span>,
				},
				{ label: <Trans>Decided at</Trans>, value: <DateTime value={decision.at} /> },
				...(decision.reason ? [{ label: <Trans>Reason</Trans>, value: decision.reason }] : []),
			]}
		/>
	);
}

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
			<label className="grid gap-1 text-xs font-medium" htmlFor="always-rule">
				<Trans>Rule to add to the caller's rule set</Trans>
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
			<Button type="submit" size="sm" disabled={busy} className="justify-self-start">
				<Trans>Approve and always allow</Trans>
			</Button>
		</form>
	);
}

/**
 * A waiting approval: what is asked, the rule chain that decided it, and the
 * approve / reject / always-allow actions. The parent supplies the mutation
 * (features/approvals/api.ts) and the name lookups; the card stays presentational.
 */
export function ApprovalCard({
	item,
	nodeNames = new Map(),
	refNames,
	tokenNames = new Map(),
	onDecide,
	busy = false,
	error,
	showFacts = true,
	showHeading = true,
	className,
}: {
	item: ApprovalItem;
	nodeNames?: Map<string, string>;
	/** Current node and node-group names for UUIDs in rules; defaults to `nodeNames`. */
	refNames?: Map<string, string>;
	tokenNames?: Map<string, string>;
	onDecide: (body: ApprovalBody) => void;
	busy?: boolean;
	error?: unknown;
	/** The task page already shows these facts, so it hides the card's own list. */
	showFacts?: boolean;
	/** The task page already names the task and its state above the card. */
	showHeading?: boolean;
	className?: string;
}) {
	const { t } = useLingui();
	const [reason, setReason] = useState("");
	const [alwaysOpen, setAlwaysOpen] = useState(false);

	const subject = item.kind === "task" ? item.task : item.taskGroup;
	const id = subject.id;
	const privileged = subject.privileged;
	const operation = item.kind === "task" ? item.task.operation : item.taskGroup.operation;
	const taskGroupKind = item.kind === "task_group" ? (item.taskGroup.kind ?? t`task group`) : null;
	const taskGroupTargets =
		item.kind === "task_group" ? (
			<NodeTargetList ids={item.taskGroup.targets} refs={item.taskGroup.refs} nodeNames={nodeNames} />
		) : null;
	const what =
		item.kind === "task" ? (
			<Trans>
				{item.task.kind} on {nodeNames.get(item.task.nodeId) ?? item.task.nodeId}
			</Trans>
		) : (
			<Trans>
				{taskGroupKind} on {taskGroupTargets}
			</Trans>
		);

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

	const decide = (decision: "approve" | "reject", rule?: Rule) => {
		const body: ApprovalBody = {
			decision,
			...(decision === "reject" && reason.trim() !== "" ? { reason: reason.trim() } : {}),
			...(rule ? { always: rule } : {}),
		};
		onDecide(body);
	};

	return (
		<section
			data-slot="approval-card"
			aria-label={`${item.kind === "task" ? t`Task` : t`Task group`} ${id}`}
			className={cn("grid gap-3 rounded-lg border bg-card p-4 text-card-foreground", className)}
		>
			{showHeading && (
				<div className="flex flex-wrap items-center gap-2">
					<h2 className="text-sm font-semibold">
						{item.kind === "task" ? <Trans>Task</Trans> : <Trans>Task group</Trans>}{" "}
						<span className="font-mono text-xs font-normal text-muted-foreground">{id}</span>
					</h2>
					<StatusText tone="warn">
						<Trans>Awaiting approval</Trans>
					</StatusText>
				</div>
			)}

			{showFacts && (
				<KeyValueList
					items={[
						{ label: <Trans>What</Trans>, value: what },
						{
							label: <Trans>Privileged</Trans>,
							value: privileged ? <Trans>Yes</Trans> : <Trans>No</Trans>,
						},
						{
							label: <Trans>Command / path</Trans>,
							value: <span className="font-mono text-xs">{subject.summary ?? ""}</span>,
						},
						{
							label: <Trans>Asked by</Trans>,
							value:
								item.kind === "task"
									? actorLabel(item.task.actorType, item.task.actorId, tokenNames)
									: item.taskGroup.actorType !== undefined && item.taskGroup.actorId !== undefined
										? actorLabel(item.taskGroup.actorType, item.taskGroup.actorId, tokenNames)
										: "–",
						},
						{ label: <Trans>Requested</Trans>, value: <DateTime value={subject.createdAt} /> },
					]}
				/>
			)}

			{evaluations.map((entry) => (
				<div key={entry.label ?? "task"} className="grid gap-1">
					{entry.label !== undefined && <h3 className="text-xs font-medium text-muted-foreground">{entry.label}</h3>}
					<EvaluationTable evaluation={entry.evaluation} tokenNames={tokenNames} refNames={refNames ?? nodeNames} />
				</div>
			))}

			<label className="grid gap-1 text-xs font-medium" htmlFor={`approval-reason-${id}`}>
				<Trans>Reason (optional, used when rejecting)</Trans>
				<Input
					id={`approval-reason-${id}`}
					value={reason}
					maxLength={1000}
					onChange={(event) => setReason(event.target.value)}
				/>
			</label>

			<div className="flex flex-wrap gap-2">
				<Button type="button" disabled={busy} onClick={() => decide("approve")}>
					<Trans>Approve</Trans>
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={busy || operation === null}
					aria-expanded={alwaysOpen}
					onClick={() => setAlwaysOpen((open) => !open)}
				>
					<Trans>Approve and always allow…</Trans>
				</Button>
				<Button type="button" variant="destructive" disabled={busy} onClick={() => decide("reject")}>
					<Trans>Reject</Trans>
				</Button>
			</div>

			{alwaysOpen && (
				<AlwaysAllowForm
					operation={operation}
					nodeNames={ruleNodes}
					privileged={privileged}
					busy={busy}
					onSubmit={(rule) => decide("approve", rule)}
				/>
			)}

			{error !== undefined && <ErrorText error={error} />}
		</section>
	);
}
