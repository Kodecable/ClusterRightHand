import type { CustomModel } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState, ErrorText } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogScrollArea,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MONO_CELL } from "@/lib/utils";
import { useAddDiscoveredModels, useDiscoverProviderModels } from "./api";

/**
 * The "List provider models" dialog of a custom provider (doc/design/agent-runtime.md "Custom providers"):
 * only the ids the upstream lists that the provider does not configure yet, with a search and checkboxes.
 * The server makes the upstream request with the stored key, so nothing secret reaches the browser. A save
 * adds the selected models through the provider API and hands the saved models back to the provider form.
 */
export function ModelDiscoveryDialog({
	providerId,
	configured,
	onClose,
	onAdded,
}: {
	providerId: string;
	/** The ids already in the form, so one that is not saved yet is not offered twice. */
	configured: readonly string[];
	onClose: () => void;
	onAdded: (models: CustomModel[]) => void;
}) {
	const { t } = useLingui();
	const selectAllId = useId();
	const query = useDiscoverProviderModels(providerId);
	const add = useAddDiscoveredModels();
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const configuredIds = new Set(configured.map((id) => id.trim()));
	const available = (query.data ?? []).filter((id) => !configuredIds.has(id));
	const needle = search.trim().toLowerCase();
	const visible = needle === "" ? available : available.filter((id) => id.toLowerCase().includes(needle));
	const allVisible = visible.length > 0 && visible.every((id) => selected.has(id));
	const someVisible = visible.some((id) => selected.has(id));

	const toggle = (id: string, checked: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	const toggleVisible = (checked: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			for (const id of visible) {
				if (checked) next.add(id);
				else next.delete(id);
			}
			return next;
		});

	const submit = () => {
		const ids = [...selected];
		add.mutate(
			{ providerId, ids },
			{
				onSuccess: (provider) => {
					onAdded((provider.models ?? []).filter((model) => selected.has(model.id)));
					onClose();
				},
			},
		);
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
				data-testid="model-discovery-dialog"
				showCloseButton={false}
			>
				<DialogHeader className="border-b p-4">
					<DialogTitle>{t`Provider models`}</DialogTitle>
				</DialogHeader>
				<DialogScrollArea className="mx-0 my-0 grid min-h-0 flex-1 content-start gap-3 px-4 py-4">
					{query.isPending && <p className="text-sm text-muted-foreground">{t`Loading models…`}</p>}
					{query.isError && <ErrorState error={query.error} retry={() => void query.refetch()} compact />}
					{query.data !== undefined && available.length === 0 && (
						<EmptyState
							bare
							title={<Trans>Every model is configured</Trans>}
							description={<Trans>The provider lists no model that this provider does not configure yet.</Trans>}
						/>
					)}
					{available.length > 0 && (
						<>
							<Input
								type="search"
								aria-label={t`Search models`}
								placeholder={t`Search models`}
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
							<div className="flex items-center gap-2">
								<Checkbox
									id={selectAllId}
									aria-label={t`Select all visible`}
									checked={allVisible}
									indeterminate={!allVisible && someVisible}
									disabled={visible.length === 0}
									onCheckedChange={(checked) => toggleVisible(Boolean(checked))}
								/>
								<Label htmlFor={selectAllId}>{t`Select all visible`}</Label>
							</div>
							{visible.length === 0 ? (
								<p className="py-4 text-center text-sm text-muted-foreground">{t`No models match the search.`}</p>
							) : (
								<div className="grid gap-1">
									{visible.map((id, index) => {
										const rowId = `${selectAllId}-${index}`;
										return (
											<div key={id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted">
												<Checkbox
													id={rowId}
													aria-label={id}
													checked={selected.has(id)}
													onCheckedChange={(checked) => toggle(id, Boolean(checked))}
												/>
												<label htmlFor={rowId} className="cursor-pointer">
													<code className={MONO_CELL}>{id}</code>
												</label>
											</div>
										);
									})}
								</div>
							)}
						</>
					)}
					{add.error !== null && <ErrorText error={add.error} />}
				</DialogScrollArea>
				<DialogFooter className="mx-0 mb-0 rounded-none">
					<Button type="button" variant="outline" onClick={onClose} disabled={add.isPending}>
						{t`Cancel`}
					</Button>
					<Button type="button" onClick={submit} disabled={selected.size === 0 || add.isPending}>
						{t`Add models`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
