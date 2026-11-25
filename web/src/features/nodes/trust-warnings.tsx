import type { TrustWarning, TrustWarningSeverity } from "@crh/api";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

const SEVERITY_STYLES: Record<TrustWarningSeverity, string> = {
	danger: "border-danger/40 bg-danger-bg text-danger",
	warning: "border-warn/40 bg-warn-bg text-warn",
	info: "border-info/30 bg-info-bg text-info",
};

const SEVERITY_ICONS = {
	danger: CircleAlertIcon,
	warning: TriangleAlertIcon,
	info: InfoIcon,
} as const;

/**
 * What an out-of-sync alias or unknown trust entry means and which UUID to add or remove
 * (doc/design/privilege.md "Trust cache"). The server's message stays in the title for diagnosis.
 */
function TrustWarningText({ warning }: { warning: TrustWarning }) {
	const value =
		warning.uuid !== null ? (
			<span className="inline-flex flex-wrap items-center gap-1">
				<code className="font-mono text-xs break-all">{warning.uuid}</code>
				{warning.nodeGroupName !== null && (
					<span>
						<Trans>(Node group {warning.nodeGroupName})</Trans>
					</span>
				)}
			</span>
		) : (
			<code className="font-mono text-xs break-all">{warning.trustName ?? "–"}</code>
		);
	switch (warning.kind) {
		case "alias_superfluous":
			return (
				<span>
					<Trans>
						This alias is for a node group the node is not in. Reusable authorizations addressed to that group still
						work here. Remove the alias from aliases in privileged.toml on the node: {value}
					</Trans>
				</span>
			);
		case "alias_unknown":
			return (
				<span>
					<Trans>
						This alias is neither a node group nor this node. Remove it from aliases in privileged.toml on the node:{" "}
						{value}
					</Trans>
				</span>
			);
		case "alias_missing":
			return (
				<span>
					<Trans>
						The node is in this node group but does not trust it as an alias. Add the group UUID to aliases in
						privileged.toml on the node: {value}
					</Trans>
				</span>
			);
		case "trust_unknown":
			return (
				<span>
					<Trans>
						crhs does not know this trust entry's key. It is neither crhs's signing key nor a registered user
						credential: {value}
					</Trans>
				</span>
			);
		case "trust_newer_values":
			return (
				<span>
					<Trans>
						This trust entry uses a role, capability, method or match type from a newer version. crhs plans around it
						conservatively and the node decides; upgrade crhs to use it: {value}
					</Trans>
				</span>
			);
		case "upgrade_not_denied":
			return (
				<span>
					<Trans>
						This crhs entry denies some operations but not upgrade, so crhs alone can replace the binary that enforces
						them. Add a deny rule for method "upgrade" in privileged.toml so an upgrade needs a user's signature:{" "}
						{value}
					</Trans>
				</span>
			);
		case "pty_not_denied":
			return (
				<span>
					<Trans>
						This crhs entry denies some operations but not pty.create, so crhs alone can open a privileged terminal,
						which runs anything the privileged identity can. Add a deny rule for method "pty.create" in privileged.toml
						so a privileged terminal needs a user's signature: {value}
					</Trans>
				</span>
			);
	}
}

/** One warning as the shared list shows it: severity, hover title and the translated text. */
export interface WarningItem {
	key: string;
	severity: TrustWarningSeverity;
	title?: string;
	content: ReactNode;
}

/**
 * Warnings as a list whose colour and icon follow the severity (doc/design/webui.md "Node pages"). The
 * trust warnings and the metrics collection warning have the same shape, so the two read alike. Each
 * entry has its own border, icon and colour, so the list needs no heading of its own.
 */
export function WarningList({
	items,
	label,
	testId = "node-warnings",
	className,
}: {
	items: readonly WarningItem[];
	label: string;
	testId?: string;
	className?: string;
}) {
	if (items.length === 0) return null;
	return (
		<section aria-label={label} data-testid={testId} className={cn("grid gap-2", className)}>
			<ul className="grid gap-2">
				{items.map((item) => {
					const Icon = SEVERITY_ICONS[item.severity];
					return (
						<li
							key={item.key}
							data-severity={item.severity}
							title={item.title}
							className={cn(
								"flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
								SEVERITY_STYLES[item.severity],
							)}
						>
							<Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
							<div className="min-w-0" role={item.severity === "danger" ? "alert" : undefined}>
								{item.content}
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** The trust warnings of a node, as a list whose colour and icon follow the severity. */
export function TrustWarningList({ warnings, className }: { warnings: readonly TrustWarning[]; className?: string }) {
	const { t } = useLingui();
	return (
		<WarningList
			label={t`Trust warnings`}
			testId="trust-warnings"
			className={className}
			items={warnings.map((warning) => ({
				key: `${warning.kind}-${warning.uuid ?? warning.trustName ?? ""}`,
				severity: warning.severity,
				title: warning.message,
				content: <TrustWarningText warning={warning} />,
			}))}
		/>
	);
}

/** A compact node-list marker in the trust warning style, for a warning that is not a trust entry. */
export function WarningIndicator({
	tone,
	title,
	testId,
	children,
}: {
	tone: "danger" | "warn" | "info";
	title: string;
	testId?: string;
	children: ReactNode;
}) {
	return (
		<span data-testid={testId} data-tone={tone} title={title} className="inline-flex">
			<StatusBadge tone={tone} dot={false} title={title}>
				{children}
			</StatusBadge>
		</span>
	);
}

/** A compact node-list marker; danger takes precedence over warning, and warning over info. */
export function TrustWarningIndicator({ warnings }: { warnings: readonly TrustWarning[] }) {
	const { i18n } = useLingui();
	if (warnings.length === 0) return null;
	const tone = warnings.some((warning) => warning.severity === "danger")
		? "danger"
		: warnings.some((warning) => warning.severity === "warning")
			? "warn"
			: "info";
	return (
		<WarningIndicator tone={tone} title={i18n._(msg`Trust warnings`)} testId="trust-warning-indicator">
			<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
			<Trans>Trust</Trans>
		</WarningIndicator>
	);
}
