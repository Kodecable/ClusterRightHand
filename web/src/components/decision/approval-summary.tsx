import type { ApprovalAction, ApprovalRequest, ApprovalRequester } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { cn, MONO_CELL } from "@/lib/utils";
import { PrivilegedMark } from "./decision";

/**
 * The compact approval summary every surface renders from the server's `ApprovalRequest`
 * (doc/design/access-control.md "Approvals"): the requester, the action, the nodes and privileged flag,
 * and Auto Review's settled verdict. It mirrors the chat card and deliberately carries nothing per kind;
 * that detail belongs on the task, task group and external call pages.
 */

const FILE_OPERATION_LABELS: Record<Extract<ApprovalAction, { type: "file" }>["operation"], MessageDescriptor> = {
	read: msg`Read file`,
	write: msg`Write file`,
	push: msg`Push file`,
	pull: msg`Pull file`,
	edit: msg`Edit file`,
	stat: msg`Stat file`,
	list: msg`List directory`,
};

const RISK_LABELS: Record<"low" | "medium" | "high", MessageDescriptor> = {
	low: msg`Low`,
	medium: msg`Medium`,
	high: msg`High`,
};

/**
 * The action's identifying text without its verb: the command, the file operation and path, the API method
 * and path, or the extension tool. The approvals table's operation column uses it.
 */
export function approvalActionDetail(i18n: I18n, action: ApprovalAction): string {
	switch (action.type) {
		case "exec":
			return action.command;
		case "file": {
			const lines =
				action.lines === undefined ? "" : ` (${i18n._(msg`lines ${action.lines.start}-${action.lines.end}`)})`;
			return `${i18n._(FILE_OPERATION_LABELS[action.operation])} ${action.path}${lines}`;
		}
		case "api_request":
			return `${action.method} ${action.path}`;
		case "extension_tool":
			return `${action.extension}/${action.tool}`;
	}
}

/** The panel's requester line; a session title links to the session the request belongs to. */
export function ApprovalRequesterLine({ requester }: { requester: ApprovalRequester }) {
	const { t } = useLingui();
	switch (requester.type) {
		case "session": {
			const title = (
				<Link
					to="/sessions/$sessionId"
					params={{ sessionId: requester.sessionId }}
					className="underline underline-offset-2"
				>
					{requester.title.trim() === "" ? t`New Session` : requester.title}
				</Link>
			);
			return (
				<p data-testid="approval-requester" className="min-w-0 text-xs break-words text-muted-foreground">
					<Trans>From session “{title}”</Trans>
				</p>
			);
		}
		case "api_token":
			return (
				<p data-testid="approval-requester" className="min-w-0 text-xs break-words text-muted-foreground">
					<Trans>From API token “{requester.name}”</Trans>
				</p>
			);
		case "user":
			return (
				<p data-testid="approval-requester" className="min-w-0 text-xs break-words text-muted-foreground">
					<Trans>From user {requester.username}</Trans>
				</p>
			);
	}
}

/** The localized verb of an action; the detail (command, path, method, tool) stays in a mono span. */
export function ApprovalActionLine({ action }: { action: ApprovalAction }) {
	const { t } = useLingui();
	const detail =
		action.type === "exec"
			? action.command
			: action.type === "file"
				? action.path
				: action.type === "api_request"
					? `${action.method} ${action.path}`
					: `${action.extension}/${action.tool}`;
	const verb =
		action.type === "exec"
			? t`Run command`
			: action.type === "file"
				? t(FILE_OPERATION_LABELS[action.operation])
				: action.type === "api_request"
					? t`Call API`
					: t`Call extension`;
	return (
		<p data-testid="approval-action" className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
			<span className="shrink-0">{verb}</span>
			<code title={detail} className={cn(MONO_CELL, "min-w-0 truncate")}>
				{detail}
			</code>
			{action.type === "file" && action.lines !== undefined && (
				<span data-testid="approval-action-lines" className="shrink-0">
					<Trans>
						lines {action.lines.start}-{action.lines.end}
					</Trans>
				</span>
			)}
		</p>
	);
}

/** The node names the request needs, the count it leaves out, and the privileged badge. */
export function ApprovalNodesLine({ request }: { request: ApprovalRequest }) {
	const names = request.nodes ?? [];
	const more = request.moreNodes ?? 0;
	if (names.length === 0 && !request.privileged) return null;
	return (
		<p
			data-testid="approval-nodes"
			className="min-w-0 text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
		>
			{names.length > 0 && (
				<>
					<Trans>Nodes:</Trans> {names.join(", ")}
					{more > 0 && (
						<>
							{" "}
							<Trans>and {more} more</Trans>
						</>
					)}
				</>
			)}
			{request.privileged && (
				<>
					{names.length > 0 ? " " : null}
					<PrivilegedMark />
				</>
			)}
		</p>
	);
}

/** Auto Review's settled verdict: risk and reason, exactly as the chat card renders it. */
export function ApprovalReviewLine({ request }: { request: ApprovalRequest }) {
	const { i18n } = useLingui();
	if (request.review === undefined) return null;
	const risk = i18n._(RISK_LABELS[request.review.risk]);
	return (
		<p data-testid="approval-review" className="min-w-0 text-xs break-words text-muted-foreground">
			<Trans>
				Auto Review: {risk} risk · {request.review.reason}
			</Trans>
		</p>
	);
}

/** The whole summary block: requester, action, nodes and Auto Review. */
export function ApprovalSummary({ request }: { request: ApprovalRequest }) {
	return (
		<div data-slot="decision-summary" className="grid min-w-0 gap-1">
			<ApprovalRequesterLine requester={request.requester} />
			<ApprovalActionLine action={request.action} />
			<ApprovalNodesLine request={request} />
			<ApprovalReviewLine request={request} />
		</div>
	);
}
