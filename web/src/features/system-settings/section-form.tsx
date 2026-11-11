import { Trans } from "@lingui/react/macro";
import { type ReactNode, useId } from "react";
import { ErrorText } from "@/components/error-state";
import { FormActions } from "@/components/form";
import { Panel, SectionHeader } from "@/components/section";
import { Button } from "@/components/ui/button";

/**
 * One saveable block of the System settings page: a titled section, its fields and
 * one Save button that patches only this section's values (doc/design/webui.md
 * "System settings page"). Save is disabled while nothing changed.
 */
export function SettingsSection({
	title,
	description,
	onSubmit,
	busy,
	dirty,
	error,
	children,
	testId,
}: {
	title: ReactNode;
	description?: ReactNode;
	onSubmit: () => void;
	busy: boolean;
	/** The form differs from its last saved values. */
	dirty: boolean;
	error?: unknown;
	children: ReactNode;
	testId: string;
}) {
	const id = useId();
	return (
		<Panel as="section" aria-labelledby={id} data-testid={testId} className="grid gap-3">
			<SectionHeader id={id} title={title} />
			{description !== undefined && <p className="-mt-2 text-sm text-muted-foreground">{description}</p>}
			<form
				className="grid gap-3"
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit();
				}}
			>
				{children}
				<ErrorText error={error} />
				<FormActions>
					<Button type="submit" disabled={busy || !dirty} aria-busy={busy || undefined}>
						<Trans>Save</Trans>
					</Button>
				</FormActions>
			</form>
		</Panel>
	);
}
