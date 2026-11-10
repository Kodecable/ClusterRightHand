import type { ApprovalBody, Evaluation, Operation, Rule, TaskGroupView, TaskView } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { ErrorText } from "@/components/error-state";
import { KeyValueList } from "@/components/key-value";
import { NodeTargetList } from "@/components/node-targets";
import { DateTime } from "@/components/relative-time";
import { Panel } from "@/components/section";
import { StatusText } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UserLink } from "@/components/user-link";
import { actorLabel, alwaysRule } from "@/features/approvals/rules";
import { ruleWithNames } from "@/lib/refs";
import { ruleResultTone } from "@/lib/status";
import { cn, MONO_CELL } from "@/lib/utils";

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

/** The kinds of rule chain level the approval UI names in words; anything else stays raw. */
const SCOPE_TYPE_LABELS: Record<string, MessageDescriptor> = {
	api_token: msg`API token`,
	session: msg`Session`,
	schedule: msg`Schedule`,
};

/** A level's scope type in words, instead of the raw wire value. */
function scopeTypeLabel(i18n: I18n, type: string): string {
	const descriptor = SCOPE_TYPE_LABELS[type];
	return descriptor === undefined ? type : i18n._(descriptor);
}

/**
 * An actor of a task: a user is a link to its page (the destination handles no
 * access); a token, system, agent or schedule actor stays plain text.
 */
function ActorValue({
	type,
	id,
	tokenNames,
	userNames,
}: {
	type: string;
	id: string;
	tokenNames?: Map<string, string>;
	userNames?: Map<string, string>;
}) {
	if (type === "user") return <UserLink id={id} name={userNames?.get(id)} title={`user:${id}`} />;
	return <span>{actorLabel(type, id, tokenNames ?? new Map())}</span>;
}

/** The rule chain evaluation: each level's scope, the rule it matched, its own result and the cumulative result. */
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
	const columns: DataTableColumn<Evaluation["levels"][number]>[] = [
		{
			id: "level",
			header: t`Level`,
			size: 220,
			cell: ({ row }) => (
				<>
					{scopeTypeLabel(i18n, row.original.scope.type)}{" "}
					<span className={MONO_CELL}>{tokenNames?.get(row.original.scope.id) ?? row.original.scope.id}</span>
				</>
			),
			meta: {
				title: (level: Evaluation["levels"][number]) =>
					`${scopeTypeLabel(i18n, level.scope.type)} ${tokenNames?.get(level.scope.id) ?? level.scope.id}`,
			},
		},
		{
			id: "matched",
			header: t`Matched rule`,
			minSize: 180,
			cell: ({ row }) =>
				row.original.matched ? (
					<code className={cn("block truncate", MONO_CELL)}>
						{JSON.stringify(ruleWithNames(row.original.matched, refNames ?? new Map()))}
					</code>
				) : (
					<span className="text-muted-foreground">
						<Trans>Default</Trans>
					</span>
				),
			meta: {
				title: (level: Evaluation["levels"][number]) =>
					level.matched ? JSON.stringify(ruleWithNames(level.matched, refNames ?? new Map())) : i18n._(msg`Default`),
			},
		},
		{
			id: "own",
			header: t`Rule result`,
			size: 110,
			cell: ({ row }) => (
				<StatusText tone={ruleResultTone(row.original.own)}>{ruleResultLabel(i18n, row.original.own)}</StatusText>
			),
		},
		{
			id: "effective",
			header: t`Cumulative result`,
			size: 110,
			cell: ({ row }) => (
				<StatusText tone={ruleResultTone(row.original.effective)}>
					{ruleResultLabel(i18n, row.original.effective)}
				</StatusText>
			),
		},
	];
	return (
		<DataTable
			label={t`Rule chain evaluation`}
			columns={columns}
			data={evaluation.levels}
			getRowId={(level) => `${level.scope.type}:${level.scope.id}`}
			density="compact"
		/>
	);
}

/** The decision recorded on an approval. */
export function DecisionView({
	decision,
	tokenNames = new Map(),
	userNames,
}: {
	decision: NonNullable<TaskView["approval"]>["decision"];
	/** Resolves an API token's id to its name, for the deciding actor. */
	tokenNames?: Map<string, string>;
	/** Display names by user id, for a user actor. */
	userNames?: Map<string, string>;
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
					value: (
						<ActorValue type={decision.by.type} id={decision.by.id} tokenNames={tokenNames} userNames={userNames} />
					),
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
	userNames,
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
	/** Display names by user id, for the asked-by and decided-by user links. */
	userNames?: Map<string, string>;
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
		<Panel
			as="section"
			data-slot="approval-card"
			aria-label={`${item.kind === "task" ? t`Task` : t`Task group`} ${id}`}
			className={cn("grid gap-3 bg-card text-card-foreground", className)}
		>
			{showHeading && (
				<div className="flex flex-wrap items-center gap-2">
					<h2 className="text-sm font-medium">
						{item.kind === "task" ? <Trans>Task</Trans> : <Trans>Task group</Trans>}{" "}
						<span className={cn(MONO_CELL, "font-normal text-muted-foreground")}>{id}</span>
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
							value: subject.summary ?? "",
							mono: true,
						},
						{
							label: <Trans>Asked by</Trans>,
							value:
								item.kind === "task" ? (
									<ActorValue
										type={item.task.actorType}
										id={item.task.actorId}
										tokenNames={tokenNames}
										userNames={userNames}
									/>
								) : item.taskGroup.actorType !== undefined && item.taskGroup.actorId !== undefined ? (
									<ActorValue
										type={item.taskGroup.actorType}
										id={item.taskGroup.actorId}
										tokenNames={tokenNames}
										userNames={userNames}
									/>
								) : (
									"–"
								),
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
		</Panel>
	);
}
