import type { PtyCreateBody, PtySize } from "@crh/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "@/components/dialogs";
import { EmptyHint } from "@/components/empty-state";
import { FieldShell } from "@/components/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNodes } from "@/features/nodes/api";
import { errorMessage } from "@/lib/api/client";
import { splitArgv } from "@/lib/argv";
import { useCreateTerminal } from "./api";
import { selectableTerminalNodes } from "./terminal-format";

/** crha's largest accepted rows or columns (doc/design/pty.md "The terminal object"). */
const MAX_DIMENSION = 1000;
/** The API's most argv entries. */
const MAX_ARGV = 64;

function parseDimension(value: string): number | undefined {
	if (value.trim() === "") return undefined;
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= MAX_DIMENSION ? number : Number.NaN;
}

/**
 * The "New terminal" dialog (doc/design/webui.md "Terminals page"): pick an active crha node, optionally a
 * command (split like a shell line), the privileged mode and a size. A privileged terminal opens on its
 * page, where its signature wait is shown; every created terminal goes there so the attach happens once.
 */
export function NewTerminalDialog({ onClose }: { onClose: () => void }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const nodes = useNodes();
	const create = useCreateTerminal();
	const [nodeId, setNodeId] = useState("");
	const [command, setCommand] = useState("");
	const [privileged, setPrivileged] = useState(false);
	const [rows, setRows] = useState("");
	const [cols, setCols] = useState("");
	const [error, setError] = useState<string>();
	const [fieldErrors, setFieldErrors] = useState<{ command?: string; size?: string }>({});

	const eligible = useMemo(() => selectableTerminalNodes(nodes.data ?? []), [nodes.data]);

	useEffect(() => {
		if (nodeId !== "" || eligible.length === 0) return;
		setNodeId(eligible[0]?.id ?? "");
	}, [eligible, nodeId]);

	const submit = async () => {
		setError(undefined);
		setFieldErrors({});
		const nextErrors: { command?: string; size?: string } = {};
		if (nodeId === "") {
			setError(t`Choose a node.`);
			return;
		}
		const argv = splitArgv(command);
		if (argv.length > MAX_ARGV) {
			nextErrors.command = t`A command has at most ${MAX_ARGV} arguments.`;
		} else if (argv.some((argument) => argument === "")) {
			nextErrors.command = t`Remove the empty argument.`;
		}
		const parsedRows = parseDimension(rows);
		const parsedCols = parseDimension(cols);
		if (Number.isNaN(parsedRows) || Number.isNaN(parsedCols)) {
			nextErrors.size = t`Enter whole numbers from 1 to ${MAX_DIMENSION}.`;
		} else if ((parsedRows === undefined) !== (parsedCols === undefined)) {
			nextErrors.size = t`Give both rows and columns, or neither.`;
		}
		if (Object.keys(nextErrors).length > 0) {
			setFieldErrors(nextErrors);
			return;
		}
		const size: PtySize | undefined =
			parsedRows !== undefined && parsedCols !== undefined ? { rows: parsedRows, cols: parsedCols } : undefined;
		const body: PtyCreateBody = {
			node: nodeId,
			...(argv.length > 0 ? { argv } : {}),
			...(privileged ? { privileged: true } : {}),
			...(size === undefined ? {} : { size }),
		};
		try {
			const terminal = await create.mutateAsync(body);
			onClose();
			await navigate({ to: "/terminals/$id", params: { id: terminal.id } });
		} catch (caught) {
			setError(errorMessage(caught));
		}
	};

	return (
		<FormDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={<Trans>New terminal</Trans>}
			description={<Trans>Open an interactive shell on a crha node. Several people can watch and type in it.</Trans>}
			submitLabel={<Trans>Open terminal</Trans>}
			busy={create.isPending}
			submitDisabled={eligible.length === 0}
			error={error}
			onSubmit={() => void submit()}
			testId="new-terminal-dialog"
		>
			<FieldShell
				id="new-terminal-node"
				label={<Trans>Node</Trans>}
				description={<Trans>Only active crha nodes have terminals; SSH nodes cannot open one.</Trans>}
			>
				<Select
					value={nodeId === "" ? null : nodeId}
					onValueChange={(next) => setNodeId(next ?? "")}
					disabled={create.isPending}
				>
					<SelectTrigger id="new-terminal-node" className="w-full">
						<SelectValue placeholder={t`Choose a node`}>
							{(selected: string | null) => eligible.find((node) => node.id === selected)?.name ?? t`Choose a node`}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{eligible.map((node) => (
							<SelectItem key={node.id} value={node.id}>
								{node.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</FieldShell>
			{!nodes.isPending && eligible.length === 0 && (
				<EmptyHint>
					<Trans>No active crha node is available to you.</Trans>
				</EmptyHint>
			)}
			<FieldShell
				id="new-terminal-command"
				label={<Trans>Command</Trans>}
				description={
					<Trans>Leave empty for the login shell. Arguments are split like a shell line; quotes group words.</Trans>
				}
				error={fieldErrors.command}
			>
				<Input
					id="new-terminal-command"
					value={command}
					disabled={create.isPending}
					placeholder={t`e.g. top -d 5`}
					onChange={(event) => setCommand(event.target.value)}
				/>
			</FieldShell>
			<div className="flex items-start gap-2">
				<Checkbox
					id="new-terminal-privileged"
					className="mt-0.5"
					checked={privileged}
					disabled={create.isPending}
					onCheckedChange={(checked) => setPrivileged(Boolean(checked))}
				/>
				<div className="grid gap-1">
					<Label htmlFor="new-terminal-privileged">
						<Trans>Run in the privileged mode</Trans>
					</Label>
					<p className="text-xs text-muted-foreground">
						<Trans>A privileged terminal waits for your signature before it opens.</Trans>
					</p>
				</div>
			</div>
			<div className="flex flex-wrap items-start gap-3">
				<FieldShell id="new-terminal-rows" label={<Trans>Rows</Trans>} error={fieldErrors.size} className="w-28">
					<Input
						id="new-terminal-rows"
						inputMode="numeric"
						value={rows}
						disabled={create.isPending}
						placeholder={t`Default`}
						onChange={(event) => setRows(event.target.value)}
					/>
				</FieldShell>
				<FieldShell id="new-terminal-cols" label={<Trans>Columns</Trans>} className="w-28">
					<Input
						id="new-terminal-cols"
						inputMode="numeric"
						value={cols}
						disabled={create.isPending}
						placeholder={t`Default`}
						onChange={(event) => setCols(event.target.value)}
					/>
				</FieldShell>
			</div>
		</FormDialog>
	);
}
