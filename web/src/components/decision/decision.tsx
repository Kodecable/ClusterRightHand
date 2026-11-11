import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Panel } from "@/components/section";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The small "Privileged" pill beside a decision title. It is deliberately
 * smaller than the title and never stretches it.
 */
export function PrivilegedMark() {
	return (
		<span className="inline-flex shrink-0 items-center rounded-full bg-warn-bg px-2 py-0.5 text-xs leading-none font-medium text-warn">
			<Trans>Privileged</Trans>
		</span>
	);
}

/**
 * The frame of every pending decision (doc/design/webui.md "Shared components"): what is asked,
 * what it is about, and the tabs that choose how to answer. The caller
 * supplies the tab bar and its panels; this frame only arranges the header,
 * the summary and the count a session dock adds.
 */
export function DecisionFrame({
	kind,
	title,
	badge,
	summary,
	count,
	details,
	children,
	className,
}: {
	kind: "approval" | "signature" | "quota";
	/** The one heading of the decision, also its accessible region name. */
	title: string;
	/** A small status beside the title, e.g. the privileged marker. */
	badge?: ReactNode;
	summary?: ReactNode;
	/** e.g. "1 of 3" while more decisions wait behind this one. */
	count?: ReactNode;
	/** A link to the task or task group the decision belongs to. */
	details?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Panel
			as="section"
			data-slot="decision"
			data-kind={kind}
			aria-label={title}
			className={cn("grid min-w-0 gap-1 bg-card text-card-foreground", className)}
		>
			<div className="grid min-w-0 gap-1.5">
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<h2 className="min-w-0 text-sm font-medium">{title}</h2>
						{badge}
					</div>
					{(count !== undefined || details !== undefined) && (
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{count}
							{details}
						</div>
					)}
				</div>
				{summary}
			</div>
			<div className="-mx-4 grid min-w-0 gap-2 border-t px-4 pt-1">{children}</div>
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
