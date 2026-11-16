import {
	type ApprovalAction,
	type ApprovalRequest,
	type ApprovalRequester,
	formatList,
	type QuotaApproval,
} from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formatNumber } from "@/lib/format";

/**
 * What a decision card shows, slot by slot, following the chat card's line order
 * (doc/design/channels.md "Approvals"): title, meta, risk with its reason, and the one-line detail.
 */
export interface DecisionCardContent {
	/** Localized title: the approval, the signature or the quota. */
	title: string;
	/** The privileged mark beside the title. */
	privileged?: boolean;
	/** The grey information line: node names, then the requester on a page. */
	meta?: ReactNode;
	/** The same line as plain text, for the truncated line's hover title. */
	metaText?: string;
	risk?: "low" | "medium" | "high";
	/** Auto Review's reason, shown after the risk badge. */
	reason?: string;
	/** The monochrome one-line block: the command, file operation, request or tool. */
	detail?: string;
}

/** Where a decision card is rendered: inline in a dock, or on a detail page with its full details. */
export type DecisionVariant = "inline" | "page";

/** The risk words every decision card and its Auto Review section use. */
export const DECISION_RISK_LABELS: Record<"low" | "medium" | "high", MessageDescriptor> = {
	low: msg`Low risk`,
	medium: msg`Medium risk`,
	high: msg`High risk`,
};

/**
 * The action's identifying text: the command, the file operation with its path and line range, the API
 * method and path, or the extension tool. The chat card and every decision surface use the same definitions,
 * so an approval looks the same wherever it is read (doc/design/webui.md "Shared components").
 */
export function actionDetail(i18n: I18n, action: ApprovalAction): string {
	switch (action.type) {
		case "exec":
			return action.command;
		case "file":
			return fileActionText(i18n, action);
		case "api_request":
			return `${action.method} ${action.path}`;
		case "extension_tool":
			return `${action.extension}/${action.tool}`;
	}
}

/**
 * A file operation as one message: the operation, the path and the line range are values of the same
 * message, so a translation owns the parentheses, the word order and the punctuation around the range.
 */
function fileActionText(i18n: I18n, action: Extract<ApprovalAction, { type: "file" }>): string {
	const path = oneLine(action.path);
	const lines = action.lines;
	switch (action.operation) {
		case "read":
			return lines === undefined
				? i18n._(msg`Read file ${path}`)
				: i18n._(msg`Read file ${path} (lines ${lines.start}-${lines.end})`);
		case "write":
			return lines === undefined
				? i18n._(msg`Write file ${path}`)
				: i18n._(msg`Write file ${path} (lines ${lines.start}-${lines.end})`);
		case "push":
			return lines === undefined
				? i18n._(msg`Push file ${path}`)
				: i18n._(msg`Push file ${path} (lines ${lines.start}-${lines.end})`);
		case "pull":
			return lines === undefined
				? i18n._(msg`Pull file ${path}`)
				: i18n._(msg`Pull file ${path} (lines ${lines.start}-${lines.end})`);
		case "edit":
			return lines === undefined
				? i18n._(msg`Edit file ${path}`)
				: i18n._(msg`Edit file ${path} (lines ${lines.start}-${lines.end})`);
		case "stat":
			return lines === undefined
				? i18n._(msg`Stat file ${path}`)
				: i18n._(msg`Stat file ${path} (lines ${lines.start}-${lines.end})`);
		case "list":
			return lines === undefined
				? i18n._(msg`List directory ${path}`)
				: i18n._(msg`List directory ${path} (lines ${lines.start}-${lines.end})`);
	}
}

/** The action text used by the approvals table's operation column. */
export const approvalActionDetail = actionDetail;

/** A value stays on one line: a path or title must not split a card line. */
export function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function sessionName(i18n: I18n, title: string): string {
	return title.trim() === "" ? i18n._(msg`New Session`) : title;
}

/** The requester in words, for a hover title. */
function requesterText(i18n: I18n, requester: ApprovalRequester): string {
	switch (requester.type) {
		case "session": {
			const title = sessionName(i18n, oneLine(requester.title));
			return i18n._(msg`From session “${title}”`);
		}
		case "api_token":
			return i18n._(msg`From API token “${oneLine(requester.name)}”`);
		case "user":
			return i18n._(msg`From user ${oneLine(requester.username)}`);
	}
}

/** The requester as a line: a session title links to the session it belongs to. */
function RequesterValue({ requester }: { requester: ApprovalRequester }) {
	switch (requester.type) {
		case "session": {
			const title = (
				<Link
					to="/sessions/$sessionId"
					params={{ sessionId: requester.sessionId }}
					className="underline underline-offset-2"
				>
					{requester.title.trim() === "" ? <Trans>New Session</Trans> : requester.title}
				</Link>
			);
			return <Trans>From session “{title}”</Trans>;
		}
		case "api_token":
			return <Trans>From API token “{requester.name}”</Trans>;
		case "user":
			return <Trans>From user {requester.username}</Trans>;
	}
}

function nodesText(i18n: I18n, request: ApprovalRequest): string | undefined {
	const names = request.nodes ?? [];
	if (names.length === 0) return undefined;
	const more = request.moreNodes ?? 0;
	const list = formatList(
		i18n.locale,
		names.map((name) => oneLine(name)),
	);
	return more > 0 ? i18n._(msg`Nodes: ${list} and ${more} more`) : i18n._(msg`Nodes: ${list}`);
}

function NodesValue({ request }: { request: ApprovalRequest }) {
	const { i18n } = useLingui();
	const names = request.nodes ?? [];
	const more = request.moreNodes ?? 0;
	if (names.length === 0) return null;
	const list = formatList(
		i18n.locale,
		names.map((name) => oneLine(name)),
	);
	return more > 0 ? (
		<Trans>
			Nodes: {list} and {more} more
		</Trans>
	) : (
		<Trans>Nodes: {list}</Trans>
	);
}

/**
 * The one compact approval request every panel renders (doc/design/access-control.md "Approvals"): the
 * title follows the phase, the meta line names the nodes and (on a page) the requester, and Auto Review's
 * settled verdict carries the risk and reason. Inline cards never show the requester; a page links to it.
 */
export function requestCardContent(
	request: ApprovalRequest,
	{ variant, i18n }: { variant: DecisionVariant; i18n: I18n },
): DecisionCardContent {
	const title =
		request.phase === "awaiting_signature"
			? i18n._(msg`Your signature is needed`)
			: i18n._(msg`Your approval is needed`);
	const nodes = nodesText(i18n, request);
	const showRequester = variant === "page";
	const requester = showRequester ? requesterText(i18n, request.requester) : undefined;
	const metaText = [nodes, requester].filter((part): part is string => part !== undefined).join(" · ");
	const meta =
		nodes !== undefined || showRequester ? (
			<>
				<NodesValue request={request} />
				{nodes !== undefined && showRequester && " · "}
				{showRequester && <RequesterValue requester={request.requester} />}
			</>
		) : undefined;
	return {
		title,
		privileged: request.privileged,
		...(meta !== undefined ? { meta } : {}),
		...(metaText !== "" ? { metaText } : {}),
		...(request.review !== undefined ? { risk: request.review.risk, reason: oneLine(request.review.reason) } : {}),
		detail: actionDetail(i18n, request.action),
	};
}

/**
 * The quota wait's card: the session's title as meta and its budget as the detail, in the same words as the
 * chat card. A quota has no risk and no requester.
 */
export function quotaCardContent(wait: QuotaApproval, i18n: I18n): DecisionCardContent {
	const used = formatNumber(wait.budgetUsedTokens, i18n.locale);
	const remaining = formatNumber(wait.budgetRemaining, i18n.locale);
	return {
		title: i18n._(msg`Token quota used up`),
		meta: wait.title === null || wait.title.trim() === "" ? i18n._(msg`New Session`) : wait.title,
		metaText: wait.title === null || wait.title.trim() === "" ? i18n._(msg`New Session`) : wait.title,
		detail: i18n._(msg`used ${used} · remaining ${remaining}`),
	};
}
