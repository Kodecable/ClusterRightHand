import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { PrivilegedMark } from "@/components/privileged-mark";
import { Panel } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { DECISION_RISK_LABELS } from "./content";

const RISK_TONES = { low: "muted", medium: "warn", high: "danger" } as const;

/**
 * The one decision card (doc/design/webui.md "Shared components"): the title and its privileged mark, the
 * grey meta line, Auto Review's risk badge and reason, and the monochrome detail line, then a divider and
 * the panel's own tabs. It mirrors the chat card's line order, so an approval reads the same in the WebUI
 * and in a channel. Every slot is optional; the truncated lines carry their full text in `title`.
 */
export function DecisionCard({
	title,
	privileged = false,
	meta,
	metaText,
	risk,
	reason,
	detail,
	kind,
	variant = "inline",
	count,
	details,
	children,
	className,
	...props
}: {
	/** The one heading of the decision, also its accessible region name. */
	title: string;
	/** The privileged mark beside the title. */
	privileged?: boolean;
	/** The grey information line. */
	meta?: ReactNode;
	/** The same line as plain text for its hover title. */
	metaText?: string;
	risk?: "low" | "medium" | "high";
	/** Auto Review's reason, shown after the risk badge. */
	reason?: string;
	/** The monochrome one-line detail block. */
	detail?: string;
	kind?: "approval" | "signature" | "quota";
	variant?: "inline" | "page";
	/** e.g. "1 of 3" while more decisions wait behind this one. */
	count?: ReactNode;
	/** A link to the object the decision belongs to (a task, a task group or its source). */
	details?: ReactNode;
	/** The panel's own tabs. */
	children: ReactNode;
	className?: string;
} & Omit<React.ComponentProps<"div">, "title" | "children">) {
	const { i18n } = useLingui();
	return (
		<Panel
			as="section"
			data-slot="decision"
			data-kind={kind}
			data-variant={variant}
			aria-label={title}
			className={cn("grid min-w-0 gap-3 bg-card text-card-foreground", className)}
			{...props}
		>
			<div className="grid min-w-0 gap-1.5">
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<h2 className="min-w-0 text-sm font-medium">{title}</h2>
						{privileged && <PrivilegedMark />}
					</div>
					{(count !== undefined || details !== undefined) && (
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{count}
							{details}
						</div>
					)}
				</div>
				{meta !== undefined && (
					<p data-testid="decision-meta" title={metaText} className="min-w-0 truncate text-xs text-muted-foreground">
						{meta}
					</p>
				)}
				{risk !== undefined && (
					<div className="flex min-w-0 items-center gap-2">
						<span data-testid="decision-risk" className="shrink-0">
							<StatusBadge tone={RISK_TONES[risk]}>{i18n._(DECISION_RISK_LABELS[risk])}</StatusBadge>
						</span>
						{reason !== undefined && reason !== "" && (
							<p
								data-testid="decision-reason"
								title={reason}
								className="min-w-0 truncate text-xs text-muted-foreground"
							>
								{reason}
							</p>
						)}
					</div>
				)}
				{detail !== undefined && detail !== "" && (
					<code
						data-testid="decision-detail"
						title={detail}
						className="block w-full min-w-0 truncate rounded bg-muted px-2 py-1 font-mono text-xs leading-5"
					>
						{detail}
					</code>
				)}
			</div>
			<div data-slot="decision-tabs" className="min-w-0 border-t pt-3">
				{children}
			</div>
		</Panel>
	);
}

/** The decision's tab root; controlled when `value` is set (a Passkey default that arrives later). */
export function DecisionTabs({
	value,
	defaultValue,
	onValueChange,
	children,
	className,
}: {
	value?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Tabs
			value={value}
			defaultValue={defaultValue}
			onValueChange={onValueChange === undefined ? undefined : (next) => onValueChange(String(next))}
			className={cn("min-w-0 gap-2", className)}
		>
			{children}
		</Tabs>
	);
}

/**
 * One horizontal tab bar for every decision. The list never widens the panel:
 * at a narrow width it scrolls sideways with its tabs, so nothing overflows the
 * page at 390 px or inside the session pane.
 */
export function DecisionTabList({ label, children }: { label: string; children: ReactNode }) {
	return (
		<TabsList variant="line" aria-label={label} className="w-full max-w-full justify-start overflow-x-auto">
			{children}
		</TabsList>
	);
}

/** One tab of a decision; it never shrinks its label to fit the bar. */
export function DecisionTab({ value, disabled, children }: { value: string; disabled?: boolean; children: ReactNode }) {
	return (
		<TabsTrigger value={value} disabled={disabled} className="flex-none">
			{children}
		</TabsTrigger>
	);
}
