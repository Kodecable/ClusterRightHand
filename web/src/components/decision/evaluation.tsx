import type { Evaluation, TaskView } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { KeyValueList } from "@/components/key-value";
import { DateTime } from "@/components/relative-time";
import { StatusText } from "@/components/status-badge";
import { UserLink } from "@/components/user-link";
import { actorLabel } from "@/features/approvals/rules";
import { ruleWithNames } from "@/lib/refs";
import { ruleResultTone } from "@/lib/status";
import { cn, MONO_CELL } from "@/lib/utils";

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
	/** Current node and node-group names for the UUIDs a matched rule stores. */
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
