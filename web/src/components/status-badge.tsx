import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	nodeStatusTone,
	type StatusTone,
	scheduleStatusTone,
	sessionStatusTone,
	taskStatusTone,
	tokenStatusTone,
} from "@/lib/status";
import { cn } from "@/lib/utils";

const TONE_CLASSES: Record<StatusTone, { badge: string; dot: string; text: string }> = {
	ok: { badge: "border-ok/30 bg-ok-bg text-ok", dot: "bg-ok", text: "text-ok" },
	warn: { badge: "border-warn/30 bg-warn-bg text-warn", dot: "bg-warn", text: "text-warn" },
	danger: { badge: "border-danger/30 bg-danger-bg text-danger", dot: "bg-danger", text: "text-danger" },
	info: { badge: "border-info/30 bg-info-bg text-info", dot: "bg-info", text: "text-info" },
	muted: {
		badge: "border-border bg-muted text-muted-foreground",
		dot: "bg-muted-foreground",
		text: "text-muted-foreground",
	},
};

/**
 * A status as plain inline text: the tone colours the label and nothing else
 * (doc/design/webui.md "Shared components"). It inherits the surrounding font size and sits in
 * the normal flow, so a table cell stays a normal value instead of a pill.
 */
export function StatusText({
	tone,
	children,
	className,
	title,
}: {
	tone: StatusTone;
	children: React.ReactNode;
	className?: string;
	/** The detail behind a merged status, shown on hover. */
	title?: string;
}) {
	return (
		<span data-tone={tone} title={title} className={cn("font-medium", TONE_CLASSES[tone].text, className)}>
			{children}
		</span>
	);
}

/** One dot in a status colour; `label` is required when it is the only status indicator. */
export function StatusDot({ tone, label, className }: { tone: StatusTone; label?: string; className?: string }) {
	const classes = cn("inline-block size-2 shrink-0 rounded-full", TONE_CLASSES[tone].dot, className);
	if (label === undefined) return <span data-tone={tone} aria-hidden="true" className={classes} />;
	return <span data-tone={tone} role="img" aria-label={label} className={classes} />;
}

/**
 * A tinted status pill, kept for the few places that deliberately use a chip
 * (the trust-warning indicator). Ordinary status displays use StatusText.
 */
export function StatusBadge({
	tone,
	children,
	className,
	dot = true,
	title,
}: {
	tone: StatusTone;
	children: React.ReactNode;
	className?: string;
	dot?: boolean;
	/** The detail behind a merged status, shown on hover. */
	title?: string;
}) {
	return (
		<span
			data-tone={tone}
			title={title}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
				TONE_CLASSES[tone].badge,
				className,
			)}
		>
			{dot && <StatusDot tone={tone} />}
			{children}
		</span>
	);
}

/**
 * A known value's translated label; an unknown value stays visible as the raw
 * server string instead of being flattened to "Unknown" (a new state should be
 * diagnosable in the UI before its translation lands).
 */
function statusLabel(i18n: I18n, labels: Record<string, MessageDescriptor>, value: string): string {
	const descriptor = labels[value];
	return descriptor === undefined ? value : i18n._(descriptor);
}

const NODE_LABELS: Record<string, MessageDescriptor> = {
	pending: msg`Pending approval`,
	active: msg`Active`,
	disabled: msg`Disabled`,
};

/** The node's status label: enrollment plus reachability, when it is known. */
export function nodeStatusLabel(i18n: I18n, status: string, connected: boolean | null = null): string {
	if (status === "active" && connected !== null) {
		return connected ? i18n._(msg`Connected`) : i18n._(msg`Offline`);
	}
	return statusLabel(i18n, NODE_LABELS, status);
}

/**
 * The node status (doc/design/webui.md "Node pages"): enrollment and reachability folded
 * into one value, so a row is one line high. The raw state and the connection
 * detail sit in the tooltip; `connected` is null for transport kinds that
 * connect per task (SSH).
 */
export function NodeStatusBadge({
	status,
	connected = null,
	className,
}: {
	status: string;
	connected?: boolean | null;
	className?: string;
}) {
	const { i18n } = useLingui();
	const title =
		status === "active" && connected !== null
			? connected
				? i18n._(msg`Active · connected`)
				: i18n._(msg`Active · not connected`)
			: status === "pending"
				? i18n._(msg`Awaiting approval`)
				: undefined;
	return (
		<StatusText tone={nodeStatusTone(status)} className={className} title={title}>
			{nodeStatusLabel(i18n, status, connected)}
		</StatusText>
	);
}

const TASK_LABELS: Record<string, MessageDescriptor> = {
	awaiting_approval: msg`Awaiting approval`,
	awaiting_authorization: msg`Awaiting authorization`,
	exited: msg`Finished`,
	failed: msg`Failed`,
	denied: msg`Denied`,
	rejected: msg`Rejected`,
	unknown: msg`Unknown`,
	running: msg`Running`,
	dispatched: msg`Dispatched`,
	cancelled: msg`Cancelled`,
};

/** The translated label of a task state, or the raw state when it is unknown. */
export function taskStateLabel(i18n: I18n, state: string): string {
	return statusLabel(i18n, TASK_LABELS, state);
}

/**
 * The task's state. `exited` always reads Finished, whatever the exit code or
 * signal; the outcome column is the one place the command's result appears.
 */
export function TaskStatusBadge({ state, className }: { state: string; className?: string }) {
	const { i18n } = useLingui();
	return (
		<StatusText tone={taskStatusTone(state)} className={className}>
			{statusLabel(i18n, TASK_LABELS, state)}
		</StatusText>
	);
}

const SESSION_LABELS: Record<"idle" | "running" | "awaiting", MessageDescriptor> = {
	idle: msg`Idle`,
	running: msg`Running`,
	awaiting: msg`Awaiting`,
};

export function SessionStatusBadge({ state, className }: { state: string; className?: string }) {
	const { i18n } = useLingui();
	return (
		<StatusText tone={sessionStatusTone(state)} className={className}>
			{statusLabel(i18n, SESSION_LABELS, state)}
		</StatusText>
	);
}

/** The status dot alone, for dense lists (the label is announced to screen readers). */
export function SessionStatusDot({ state, className }: { state: string; className?: string }) {
	const { i18n } = useLingui();
	const label = statusLabel(i18n, SESSION_LABELS, state);
	return <StatusDot tone={sessionStatusTone(state)} label={label} className={className} />;
}

const SCHEDULE_LABELS: Record<string, MessageDescriptor> = {
	succeeded: msg`Succeeded`,
	running: msg`Running`,
	preempted: msg`Preempted`,
	pending: msg`Queued`,
	failed: msg`Failed`,
	never: msg`Never run`,
};

export function ScheduleStatusBadge({ status, className }: { status: string; className?: string }) {
	const { i18n } = useLingui();
	return (
		<StatusText tone={scheduleStatusTone(status)} className={className}>
			{statusLabel(i18n, SCHEDULE_LABELS, status)}
		</StatusText>
	);
}

const TOKEN_LABELS: Record<string, MessageDescriptor> = {
	active: msg`Active`,
	expired: msg`Expired`,
	revoked: msg`Revoked`,
};

export function TokenStatusBadge({ status, className }: { status: string; className?: string }) {
	const { i18n } = useLingui();
	return (
		<StatusText tone={tokenStatusTone(status)} className={className}>
			{statusLabel(i18n, TOKEN_LABELS, status)}
		</StatusText>
	);
}
