import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import {
	authorizationStatusTone,
	nodeStatusTone,
	type StatusTone,
	scheduleStatusTone,
	sessionStatusTone,
	taskStatusTone,
	tokenStatusTone,
} from "@/lib/status";
import { cn } from "@/lib/utils";

const TONE_CLASSES: Record<StatusTone, { badge: string; dot: string }> = {
	ok: { badge: "border-ok/30 bg-ok-bg text-ok", dot: "bg-ok" },
	warn: { badge: "border-warn/30 bg-warn-bg text-warn", dot: "bg-warn" },
	danger: { badge: "border-danger/30 bg-danger-bg text-danger", dot: "bg-danger" },
	info: { badge: "border-info/30 bg-info-bg text-info", dot: "bg-info" },
	muted: { badge: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
};

/** One dot in a status colour; `label` is required when it is the only status indicator. */
export function StatusDot({ tone, label, className }: { tone: StatusTone; label?: string; className?: string }) {
	const classes = cn("inline-block size-2 shrink-0 rounded-full", TONE_CLASSES[tone].dot, className);
	if (label === undefined) return <span data-tone={tone} aria-hidden="true" className={classes} />;
	return <span data-tone={tone} role="img" aria-label={label} className={classes} />;
}

/** A tinted status pill. Its label is passed in so the caller controls the translation. */
export function StatusBadge({
	tone,
	children,
	className,
	dot = true,
}: {
	tone: StatusTone;
	children: React.ReactNode;
	className?: string;
	dot?: boolean;
}) {
	return (
		<span
			data-tone={tone}
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
	pending: msg`Pending`,
	active: msg`Active`,
	disabled: msg`Disabled`,
};

export function NodeStatusBadge({
	status,
	className,
	dot = true,
}: {
	status: string;
	className?: string;
	dot?: boolean;
}) {
	const { i18n } = useLingui();
	return (
		<StatusBadge tone={nodeStatusTone(status)} className={className} dot={dot}>
			{statusLabel(i18n, NODE_LABELS, status)}
		</StatusBadge>
	);
}

const TASK_LABELS: Record<string, MessageDescriptor> = {
	awaiting_approval: msg`Awaiting approval`,
	awaiting_authorization: msg`Awaiting authorization`,
	exited: msg`Exited`,
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

export function TaskStatusBadge({
	state,
	exitCode = null,
	signal = null,
	className,
}: {
	state: string;
	exitCode?: number | null;
	signal?: string | null;
	className?: string;
}) {
	const { i18n } = useLingui();
	return (
		<StatusBadge tone={taskStatusTone(state, exitCode, signal)} className={className}>
			{statusLabel(i18n, TASK_LABELS, state)}
			{state === "exited" && exitCode !== null && exitCode !== 0 ? ` (${exitCode})` : ""}
		</StatusBadge>
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
		<StatusBadge tone={sessionStatusTone(state)} className={className}>
			{statusLabel(i18n, SESSION_LABELS, state)}
		</StatusBadge>
	);
}

/** The status dot alone, for dense lists (the label is announced to screen readers). */
export function SessionStatusDot({ state, className }: { state: string; className?: string }) {
	const { i18n } = useLingui();
	const label = statusLabel(i18n, SESSION_LABELS, state);
	return <StatusDot tone={sessionStatusTone(state)} label={label} className={className} />;
}

const AUTHORIZATION_LABELS: Record<string, MessageDescriptor> = {
	active: msg`Active`,
	issued: msg`Issued`,
	signed: msg`Signed`,
	pending: msg`Pending`,
	awaiting: msg`Awaiting signature`,
	revoked: msg`Revoked`,
	expired: msg`Expired`,
	rejected: msg`Rejected`,
	dead: msg`Expired`,
};

export function AuthorizationStatusBadge({ status, className }: { status: string; className?: string }) {
	const { i18n } = useLingui();
	return (
		<StatusBadge tone={authorizationStatusTone(status)} className={className}>
			{statusLabel(i18n, AUTHORIZATION_LABELS, status)}
		</StatusBadge>
	);
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
		<StatusBadge tone={scheduleStatusTone(status)} className={className}>
			{statusLabel(i18n, SCHEDULE_LABELS, status)}
		</StatusBadge>
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
		<StatusBadge tone={tokenStatusTone(status)} className={className}>
			{statusLabel(i18n, TOKEN_LABELS, status)}
		</StatusBadge>
	);
}
