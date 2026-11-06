import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A second confirmation for a dangerous action. The caller owns the mutation;
 * the dialog only closes itself after `onConfirm` resolves (or immediately when
 * no busy state is passed in). Keep it open while `busy` to avoid double submits.
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	cancelLabel,
	destructive = true,
	busy = false,
	onConfirm,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	confirmLabel?: ReactNode;
	cancelLabel?: ReactNode;
	destructive?: boolean;
	busy?: boolean;
	onConfirm: () => void;
	children?: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-slot="confirm-dialog">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description !== undefined && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>
				{children}
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						{cancelLabel ?? <Trans>Cancel</Trans>}
					</Button>
					<Button type="button" variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
						{confirmLabel ?? <Trans>Confirm</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * A dialog that wraps a form: title, description, fields, an error line and
 * the cancel/submit footer. The header and footer stay fixed while the fields
 * scroll in their own body, inside the popup's clipped rounded frame. The
 * caller keeps validation in react-hook-form and passes `onSubmit` as the
 * form's submit handler; `busy` disables the footer, and `submitDisabled` holds
 * the submit button back on its own (an empty required field, for example).
 * Native constraint validation stays off, as in the hand-written dialogs this
 * replaced: every form keeps its own zod checks.
 */
export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	onSubmit,
	submitLabel,
	cancelLabel,
	busy = false,
	submitDisabled = false,
	error,
	testId,
	children,
	className,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	onSubmit: () => void;
	submitLabel?: ReactNode;
	cancelLabel?: ReactNode;
	busy?: boolean;
	/** Disables the submit button without implying a request is in flight. */
	submitDisabled?: boolean;
	error?: ReactNode;
	testId?: string;
	children: ReactNode;
	className?: string;
}) {
	const { t } = useLingui();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-slot="form-dialog"
				className={cn("flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0", className)}
				data-testid={testId}
			>
				<DialogHeader className="border-b p-4 pr-12">
					<DialogTitle>{title}</DialogTitle>
					{description !== undefined && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>
				<form
					className="flex min-h-0 flex-1 flex-col"
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit();
					}}
				>
					{/* The header and footer stay put; only this body scrolls inside the rounded frame. */}
					<DialogScrollArea className="mx-0 my-0 grid flex-1 content-start gap-3 px-4 py-4">
						{children}
					</DialogScrollArea>
					{error !== undefined && error !== null && (
						<p role="alert" className="shrink-0 px-4 pb-3 text-sm text-danger">
							{error}
						</p>
					)}
					<DialogFooter className="mx-0 mb-0 rounded-none">
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
							{cancelLabel ?? <Trans>Cancel</Trans>}
						</Button>
						<Button type="submit" disabled={busy || submitDisabled} aria-busy={busy || undefined}>
							{submitLabel ?? t`Save`}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
