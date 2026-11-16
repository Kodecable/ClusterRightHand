import { type ApprovalRequest, formatList, type QuotaApproval } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { RequestSource, requestSourceText } from "@/components/request-source";
import { actionText, oneLine } from "@/lib/action-text";
import { quotaDetailText, quotaStatus } from "@/lib/quota";
import { displaySessionTitle } from "@/lib/session-title";

/**
 * What a decision card shows, slot by slot, following the chat card's line order
 * (doc/design/channels.md "Approvals"): title, meta, risk with its reason, and the one-line detail.
 */
export interface DecisionCardContent {
	/** Localized title: the approval, the signature or the quota. */
	title: string;
	/** The privileged mark beside the title. */
	privileged?: boolean;
	/** The grey information line: node names, then the source on a page. */
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
 * title follows the phase, the meta line names the nodes and (on a page) the source, and Auto Review's
 * settled verdict carries the risk and reason. Inline cards never show the source; a page links to it.
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
	const showSource = variant === "page";
	const source = showSource ? i18n._(msg`Source: ${requestSourceText(i18n, request.source)}`) : undefined;
	const metaText = [nodes, source].filter((part): part is string => part !== undefined).join(" · ");
	const meta =
		nodes !== undefined || showSource ? (
			<>
				<NodesValue request={request} />
				{nodes !== undefined && showSource && " · "}
				{showSource && (
					<Trans>
						Source: <RequestSource source={request.source} />
					</Trans>
				)}
			</>
		) : undefined;
	return {
		title,
		privileged: request.privileged,
		...(meta !== undefined ? { meta } : {}),
		...(metaText !== "" ? { metaText } : {}),
		...(request.review !== undefined ? { risk: request.review.risk, reason: oneLine(request.review.reason) } : {}),
		detail: actionText(i18n, request.action),
	};
}

/**
 * The quota wait's card: the session's title as meta and its budget as the detail, in the same words as the
 * chat card. A quota has no risk and no source.
 */
export function quotaCardContent(wait: QuotaApproval, i18n: I18n): DecisionCardContent {
	const status = quotaStatus(wait.budgetRemaining, wait.budgetUsedTokens);
	const title = displaySessionTitle(wait.title, i18n);
	return {
		title: i18n._(msg`Token quota used up`),
		meta: title,
		metaText: title,
		detail: quotaDetailText(i18n, status),
	};
}
