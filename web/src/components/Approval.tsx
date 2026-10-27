import type { ApprovalDecision, Evaluation } from "../api.ts";
import { formatTime } from "../lib.ts";
import { Badge } from "./Feedback.tsx";

const resultKind = (r: string) => (r === "allow" ? "ok" : r === "deny" ? "bad" : "warn");

/** The rule chain evaluation: for each level its scope, own result, deciding rule and effective result. */
export function EvaluationView({
	evaluation,
	tokenNames,
}: {
	evaluation: Evaluation;
	tokenNames?: Map<string, string>;
}) {
	return (
		<div className="scroll-x">
			<table aria-label="Rule chain evaluation">
				<thead>
					<tr>
						<th>Level</th>
						<th>Own result</th>
						<th>Matched rule</th>
						<th>Effective</th>
					</tr>
				</thead>
				<tbody>
					{evaluation.levels.map((l) => (
						<tr key={`${l.scope.type}:${l.scope.id}`}>
							<td>
								{l.scope.type === "api_token" ? "API token" : l.scope.type}{" "}
								<span className="mono">{tokenNames?.get(l.scope.id) ?? l.scope.id}</span>
							</td>
							<td>
								<Badge kind={l.own === "inherit" ? "off" : resultKind(l.own)}>{l.own}</Badge>
							</td>
							<td>
								{l.matched ? (
									<code className="mono">{JSON.stringify(l.matched)}</code>
								) : (
									<span className="muted">default</span>
								)}
							</td>
							<td>
								<Badge kind={resultKind(l.effective)}>{l.effective}</Badge>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function DecisionView({ decision }: { decision: ApprovalDecision }) {
	return (
		<dl className="kv">
			<dt>Decision</dt>
			<dd>
				<Badge kind={decision.decision === "approved" ? "ok" : "bad"}>{decision.decision}</Badge>
			</dd>
			<dt>Decided by</dt>
			<dd>
				{decision.by.type} <span className="mono">{decision.by.id}</span>
			</dd>
			<dt>Decided at</dt>
			<dd>{formatTime(decision.at)}</dd>
			{decision.reason && (
				<>
					<dt>Reason</dt>
					<dd>{decision.reason}</dd>
				</>
			)}
		</dl>
	);
}
