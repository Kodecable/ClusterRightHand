import type { NodeGroup } from "@crh/api";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ChevronsUpDownIcon } from "lucide-react";
import { EmptyHint } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/** Pick any number of existing node groups (a checkbox list in a popover). */
export function NodeGroupPicker({
	groups,
	value,
	onChange,
	label,
	placeholder,
	disabled,
	id,
	className,
}: {
	groups: NodeGroup[];
	value: string[];
	onChange: (ids: string[]) => void;
	label?: string;
	placeholder?: string;
	disabled?: boolean;
	id?: string;
	className?: string;
}) {
	const { t } = useLingui();
	const selected = new Set(value);
	const toggle = (groupId: string, checked: boolean) => {
		const next = new Set(selected);
		if (checked) next.add(groupId);
		else next.delete(groupId);
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
						(placeholder ?? t`Choose node groups`)
					) : (
						<Plural value={value.length} one="# node group selected" other="# node groups selected" />
					)}
				</span>
				<ChevronsUpDownIcon className="size-4 text-muted-foreground" />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-0">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="text-xs font-medium text-muted-foreground">{label ?? t`Node groups`}</span>
					{value.length > 0 && (
						<Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
							<Trans>Clear</Trans>
						</Button>
					)}
				</div>
				<ScrollArea className="h-64">
					<div className="grid gap-1 p-2">
						{groups.length === 0 && <EmptyHint className="px-2 py-1.5">No node groups</EmptyHint>}
						{groups.map((group) => (
							<label
								key={group.id}
								htmlFor={`node-group-picker-${group.id}`}
								className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
							>
								<Checkbox
									id={`node-group-picker-${group.id}`}
									checked={selected.has(group.id)}
									onCheckedChange={(checked) => toggle(group.id, Boolean(checked))}
								/>
								<span className="min-w-0 flex-1 truncate">{group.name}</span>
								<span className="text-xs text-muted-foreground">
									<Plural value={group.memberIds.length} one="# member" other="# members" />
								</span>
							</label>
						))}
					</div>
				</ScrollArea>
			</PopoverContent>
		</Popover>
	);
}
