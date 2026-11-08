import type { PublicNode } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/dialogs";
import { FieldShell } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRenameNode } from "./api";

/** The "Rename" button of a node page and the one-field dialog it opens. */
export function RenameNodeButton({ node }: { node: PublicNode }) {
	const { t } = useLingui();
	const prefix = useId();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(node.name);
	const rename = useRenameNode();
	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => {
					setName(node.name);
					setOpen(true);
				}}
			>
				<Trans>Rename</Trans>
			</Button>
			<FormDialog
				open={open}
				onOpenChange={setOpen}
				title={<Trans>Rename node</Trans>}
				submitLabel={<Trans>Save</Trans>}
				busy={rename.isPending}
				submitDisabled={name.trim() === ""}
				error={rename.error !== null ? rename.error.message : undefined}
				onSubmit={() =>
					rename.mutate(
						{ id: node.id, name: name.trim() },
						{
							onSuccess: () => {
								toast.success(t`Node renamed.`);
								setOpen(false);
							},
						},
					)
				}
			>
				<FieldShell id={`${prefix}-name`} label={t`New name`}>
					<Input id={`${prefix}-name`} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
				</FieldShell>
			</FormDialog>
		</>
	);
}
