import type { PublicNode } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ChevronsUpDownIcon } from "lucide-react";
import { nodeStatusLabel } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface BaseProps {
	nodes: PublicNode[];
	label?: string;
	placeholder?: string;
	disabled?: boolean;
	id?: string;
	className?: string;
}

type SingleProps = BaseProps & {
	multiple?: false;
	value: string | null;
	onChange: (id: string | null) => void;
};

type MultiProps = BaseProps & {
	multiple: true;
	value: string[];
	onChange: (ids: string[]) => void;
};

/** Pick one node (a select) or many (a checkbox list in a popover). */
export function NodePicker(props: SingleProps | MultiProps) {
	return props.multiple === true ? <MultiNodePicker {...props} /> : <SingleNodePicker {...props} />;
}

function SingleNodePicker({ nodes, value, onChange, label, placeholder, disabled, id, className }: SingleProps) {
	const { t } = useLingui();
	return (
		<Select
			value={value}
			onValueChange={(next) => onChange(typeof next === "string" && next !== "" ? next : null)}
			disabled={disabled}
		>
			<SelectTrigger id={id} aria-label={label ?? t`Node`} className={cn("w-full", className)}>
				<SelectValue placeholder={placeholder ?? t`Choose a node`}>
					{(current: string | null) =>
						nodes.find((node) => node.id === current)?.name ?? placeholder ?? t`Choose a node`
					}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{nodes.map((node) => (
					<SelectItem key={node.id} value={node.id}>
						<span className="flex items-center gap-2">
							{node.name}
							<span className="text-xs text-muted-foreground">{node.hostname ?? node.transport}</span>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function MultiNodePicker({ nodes, value, onChange, label, placeholder, disabled, id, className }: MultiProps) {
	const { t, i18n } = useLingui();
	const selected = new Set(value);
	const toggle = (nodeId: string, checked: boolean) => {
		const next = new Set(selected);
		if (checked) next.add(nodeId);
		else next.delete(nodeId);
		onChange([...next]);
	};
	return (
		<Popover>
			<PopoverTrigger
				disabled={disabled}
				render={<Button type="button" variant="outline" id={id} className={cn("w-full justify-between", className)} />}
			>
				<span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
					{value.length === 0 ? (
						(placeholder ?? t`Choose nodes`)
					) : (
						<Plural value={value.length} one="# node selected" other="# nodes selected" />
					)}
				</span>
				<ChevronsUpDownIcon className="size-4 text-muted-foreground" />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-0">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="text-xs font-medium text-muted-foreground">{label ?? t`Nodes`}</span>
					{value.length > 0 && (
						<Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
							<Trans>Clear</Trans>
						</Button>
					)}
				</div>
				<ScrollArea className="h-64">
					<div className="grid gap-1 p-2">
						{nodes.map((node) => (
							<label
								key={node.id}
								htmlFor={`node-picker-${node.id}`}
								className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
							>
								<Checkbox
									id={`node-picker-${node.id}`}
									checked={selected.has(node.id)}
									onCheckedChange={(checked) => toggle(node.id, Boolean(checked))}
								/>
								<span className="min-w-0 flex-1 truncate">{node.name}</span>
								<Badge variant="secondary">{nodeStatusLabel(i18n, node.status, node.connected)}</Badge>
							</label>
						))}
					</div>
				</ScrollArea>
			</PopoverContent>
		</Popover>
	);
}
