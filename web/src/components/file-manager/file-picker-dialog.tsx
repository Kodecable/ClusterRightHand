import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FileManager } from "./file-manager";
import type { FileEntry, FileSource } from "./types";

export interface FilePickerDialogProps {
	source: FileSource;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Where the selected files are reported; a single picker reports one. */
	onSelect: (entries: FileEntry[]) => void;
	multiple?: boolean;
	/** The breadcrumb root; defaults to the source's obvious label. */
	rootLabel?: string;
	title?: ReactNode;
	description?: ReactNode;
	testId?: string;
}

/**
 * The FileManager in selection mode (doc/design/webui.md "Shared components"): choose one or several
 * files from any source. Directories only navigate; a picker never uploads, renames or deletes.
 */
export function FilePickerDialog({
	source,
	open,
	onOpenChange,
	onSelect,
	multiple = false,
	rootLabel,
	title,
	description,
	testId,
}: FilePickerDialogProps) {
	const { t } = useLingui();
	const [path, setPath] = useState("");
	const [selected, setSelected] = useState<Map<string, FileEntry>>(new Map());

	useEffect(() => {
		if (!open) return;
		setPath("");
		setSelected(new Map());
	}, [open]);

	const toggle = (entry: FileEntry) => {
		setSelected((current) => {
			const next = multiple ? new Map(current) : new Map<string, FileEntry>();
			if (next.has(entry.path)) next.delete(entry.path);
			else next.set(entry.path, entry);
			return next;
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onOpenChange(false);
			}}
		>
			<DialogContent
				className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
				showCloseButton={false}
				data-testid={testId ?? "file-picker-dialog"}
			>
				<DialogHeader className="border-b p-4">
					<DialogTitle>{title ?? (multiple ? <Trans>Choose files</Trans> : <Trans>Choose a file</Trans>)}</DialogTitle>
					<DialogDescription>
						{description ?? (multiple ? <Trans>Choose one or more files.</Trans> : <Trans>Choose one file.</Trans>)}
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-auto p-4">
					<FileManager
						source={source}
						path={path}
						onPathChange={setPath}
						rootLabel={rootLabel ?? t`Files`}
						selection={{ multiple, selected: new Set(selected.keys()), onToggle: toggle }}
						testId="file-picker-manager"
					/>
				</div>
				<DialogFooter className="mx-0 mb-0 rounded-none">
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={selected.size === 0}
						onClick={() => {
							onSelect([...selected.values()]);
							onOpenChange(false);
						}}
					>
						{selected.size > 1 ? t`Select ${selected.size} files` : t`Select`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
