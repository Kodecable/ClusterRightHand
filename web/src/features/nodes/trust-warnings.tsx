import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import type { TrustWarning, TrustWarningSeverity } from "@/lib/api/types";
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
 * (doc/privilege.md#信任缓存, D110). The server's message stays in the title for diagnosis.
 */
function TrustWarningText({ warning }: { warning: TrustWarning }) {
	const value =
		warning.uuid !== null ? (
			<span className="inline-flex flex-wrap items-center gap-1">
				<code className="font-mono text-xs">{warning.uuid}</code>
				{warning.nodeGroupName !== null && (
					<span>
						(<Trans>Node group</Trans> {warning.nodeGroupName})
					</span>
				)}
			</span>
		) : (
			<code className="font-mono text-xs">{warning.trustName ?? "–"}</code>
		);
	switch (warning.kind) {
		case "alias_superfluous":
			return (
				<span>
					<Trans>
						This alias is for a node group the node is not in. Reusable authorizations addressed to that group still
						work here. Remove the alias from aliases in privileged.toml on the node:
					</Trans>{" "}
					{value}
				</span>
			);
		case "alias_unknown":
			return (
				<span>
					<Trans>
						This alias is neither a node group nor this node. Remove it from aliases in privileged.toml on the node:
					</Trans>{" "}
					{value}
				</span>
			);
		case "alias_missing":
			return (
				<span>
					<Trans>
						The node is in this node group but does not trust it as an alias. Add the group UUID to aliases in
						privileged.toml on the node:
					</Trans>{" "}
					{value}
				</span>
			);
		case "trust_unknown":
			return (
				<span>
					<Trans>
						crhs does not know this trust entry's key. It is neither crhs's signing key nor a registered user
						credential:
					</Trans>{" "}
					{value}
				</span>
			);
	}
}

/** The trust warnings of a node, as a list whose colour and icon follow the severity. */
export function TrustWarningList({ warnings, className }: { warnings: readonly TrustWarning[]; className?: string }) {
	if (warnings.length === 0) return null;
	return (
		<section
			aria-labelledby="trust-warnings-heading"
			data-testid="trust-warnings"
			className={cn("grid gap-2", className)}
		>
			<h2 id="trust-warnings-heading" className="text-sm font-semibold">
				<Trans>Trust warnings</Trans>
			</h2>
			<ul className="grid gap-2">
				{warnings.map((warning) => {
					const Icon = SEVERITY_ICONS[warning.severity];
					return (
						<li
							key={`${warning.kind}-${warning.uuid ?? warning.trustName ?? ""}`}
							data-severity={warning.severity}
							title={warning.message}
							className={cn(
								"flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
								SEVERITY_STYLES[warning.severity],
							)}
						>
							<Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<p className="min-w-0" role={warning.severity === "danger" ? "alert" : undefined}>
								<TrustWarningText warning={warning} />
							</p>
						</li>
					);
				})}
			</ul>
		</section>
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
		<StatusBadge tone={tone} dot={false} title={i18n._(msg`Trust warnings`)}>
			<TriangleAlertIcon className="size-3" aria-hidden="true" />
			<Trans>Trust</Trans>
		</StatusBadge>
	);
}
