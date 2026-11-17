import type { SessionExtension, SessionView } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { BlocksIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePatchSession } from "./api";

/** The blocks icon and the on/total count: the session header's button and the draft's. */
export function ExtensionsButton({
	enabled,
	total,
	onClick,
	testId = "session-extensions",
}: {
	enabled: number;
	total: number;
	onClick: () => void;
	testId?: string;
}) {
	const { t } = useLingui();
	const label = t`Extensions: ${enabled}/${total}`;
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			data-testid={testId}
			title={label}
			aria-label={label}
			onClick={onClick}
		>
			<BlocksIcon />
		</Button>
	);
}

/**
 * The per-extension toggles (doc/design/extensions.md "Extensions"): the presentational list both the session
 * header and the draft page use. `disabled` is the owner's off list; toggling reports the complete next list, so
 * the header PATCHes it and the draft keeps it locally until the first message creates the session.
 */
export function ExtensionsDialog({
	open,
	onOpenChange,
	extensions,
	disabled,
	onChange,
	pending = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	extensions: readonly SessionExtension[];
	disabled: readonly string[];
	onChange: (disabled: string[]) => void;
	pending?: boolean;
}) {
	const toggle = (name: string) => {
		onChange(disabled.includes(name) ? disabled.filter((entry) => entry !== name) : [...disabled, name]);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-testid="extensions-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Extensions</Trans>
					</DialogTitle>
				</DialogHeader>
				<div className="grid gap-2">
					{extensions.map((extension) => (
						<label
							key={extension.name}
							htmlFor={`session-extension-${extension.name}`}
							className="flex items-start gap-2 text-sm"
						>
							<Checkbox
								id={`session-extension-${extension.name}`}
								checked={!disabled.includes(extension.name)}
								disabled={pending}
								onCheckedChange={() => toggle(extension.name)}
							/>
							<span className="grid gap-0.5">
								<code className="text-xs">{extension.name}</code>
								{extension.description !== null && (
									<span className="text-xs text-muted-foreground">{extension.description}</span>
								)}
							</span>
						</label>
					))}
					<p className="text-xs text-muted-foreground">
						<Trans>An extension that is off is hidden from the model. The change applies to the next turn.</Trans>
					</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The session owner's extensions button in the header (doc/design/webui.md "Session header"): the nav's blocks
 * icon with how many are on, opening the per-extension toggles (doc/design/extensions.md "Extensions"). A subagent
 * inherits its parent's set and can only turn more off; the server enforces that too. Administrators and
 * share viewers never see the button, and a session without extensions has nothing to toggle.
 */
export function SessionExtensions({ session }: { session: SessionView }) {
	const [open, setOpen] = useState(false);
	const patch = usePatchSession(session.id);
	const extensions = session.extensions ?? [];
	if (session.relationship !== "owner" || extensions.length === 0) return null;

	const disabled = extensions.filter((extension) => !extension.enabled).map((extension) => extension.name);
	const enabled = extensions.length - disabled.length;

	return (
		<>
			<ExtensionsButton enabled={enabled} total={extensions.length} onClick={() => setOpen(true)} />
			<ExtensionsDialog
				open={open}
				onOpenChange={setOpen}
				extensions={extensions}
				disabled={disabled}
				pending={patch.isPending}
				onChange={(next) => patch.mutate({ disabledExtensions: next })}
			/>
		</>
	);
}
