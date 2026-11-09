import { Combobox } from "@base-ui/react/combobox";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useDebouncedValue } from "@/hooks/use-debounced";
import { cn } from "@/lib/utils";
import { type EntityKind, type EntityOption, type EntityOptionKind, useEntityLabels, useEntitySearch } from "./api";

/** The default search placeholder per kind; a caller may override it. */
const SEARCH_PLACEHOLDERS: Record<EntityKind, MessageDescriptor> = {
	user: msg`Search users…`,
	userGroup: msg`Search user groups…`,
	node: msg`Search nodes…`,
	nodeGroup: msg`Search node groups…`,
	directory: msg`Search users and groups…`,
	nodeTarget: msg`Search nodes and node groups…`,
};

/** The default empty trigger text per kind and mode. */
const SINGLE_PLACEHOLDERS: Record<EntityKind, MessageDescriptor> = {
	user: msg`Choose a user`,
	userGroup: msg`Choose a user group`,
	node: msg`Choose a node`,
	nodeGroup: msg`Choose a node group`,
	directory: msg`Choose a user or user group`,
	nodeTarget: msg`Choose a node or node group`,
};

const MULTI_PLACEHOLDERS: Record<EntityKind, MessageDescriptor> = {
	user: msg`Choose users`,
	userGroup: msg`Choose user groups`,
	node: msg`Choose nodes`,
	nodeGroup: msg`Choose node groups`,
	directory: msg`Choose users or user groups`,
	nodeTarget: msg`Choose nodes or node groups`,
};

interface BaseProps {
	kind: EntityKind;
	/** The control's accessible name; required so every picker is labelled. */
	label: string;
	/** The empty trigger text; defaults to a kind-appropriate "Choose …". */
	placeholder?: string;
	searchPlaceholder?: string;
	emptyText?: string;
	moreText?: string;
	loadingText?: string;
	disabled?: boolean;
	id?: string;
	className?: string;
	testId?: string;
	/** Ids to hide from the results, e.g. the group's current members. */
	exclude?: readonly string[];
	/** Whether pending/disabled nodes may be picked. Defaults to true; the batch page wants active nodes only. */
	includeDisabled?: boolean;
}

interface SingleProps extends BaseProps {
	multiple?: false;
	value: string | null;
	onChange: (id: string | null, option: EntityOption | null) => void;
}

interface MultiProps extends BaseProps {
	multiple: true;
	value: readonly string[];
	onChange: (ids: string[], options: EntityOption[]) => void;
}

export type EntityPickerProps = SingleProps | MultiProps;

/** The trigger's classes, matching the app's Select trigger (doc/webui.md "共享部件"). */
const TRIGGER_CLASS =
	"flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50";

function fallbackOption(id: string, kind: EntityKind): EntityOption {
	// A merged picker still needs one concrete kind for a value whose label has not arrived.
	const optionKind: EntityOptionKind =
		kind === "directory" ? "user" : kind === "nodeTarget" ? "node" : (kind as EntityOptionKind);
	return { id, kind: optionKind, primary: id };
}

/** The type badge of a merged picker's row: directory shows users/groups, nodeTarget nodes/groups. */
function OptionKindBadge({ kind }: { kind: EntityOptionKind }) {
	return (
		<Badge variant="secondary" className="col-start-3">
			{kind === "user" ? (
				<Trans>User</Trans>
			) : kind === "userGroup" ? (
				<Trans>User group</Trans>
			) : kind === "node" ? (
				<Trans>Node</Trans>
			) : (
				<Trans>Node group</Trans>
			)}
		</Badge>
	);
}

/**
 * The one searchable entity picker (doc/webui.md "实体搜索"): a trigger that looks like the
 * host's Select, a popup with a server-searched list, keyboard navigation and, in multiple
 * mode, removable chips under the trigger. The option's kind is a badge in directory mode.
 *
 * The selected values keep their labels through the endpoints' `ids` lookup, so a value picked
 * earlier still shows its name after the search text changes or the popup reopens.
 */
export function EntityPicker(props: EntityPickerProps) {
	const { t, i18n } = useLingui();
	const multiple = props.multiple === true;
	const generatedId = useId();
	const id = props.id ?? generatedId;
	const [open, setOpen] = useState(false);
	const [inputValue, setInputValue] = useState("");
	const query = inputValue.trim();
	const debouncedQuery = useDebouncedValue(query, 200);
	const search = useEntitySearch(props.kind, debouncedQuery, open);

	const selectedIds = props.multiple === true ? props.value : props.value === null ? [] : [props.value];
	const labels = useEntityLabels(props.kind, selectedIds);
	const excluded = useMemo(() => new Set(props.exclude ?? []), [props.exclude]);

	// Everything known about the selected ids: the label lookup wins over a transient search row.
	const known = useMemo(() => {
		const map = new Map<string, EntityOption>();
		for (const option of search.data?.options ?? []) map.set(option.id, option);
		for (const option of labels.data ?? []) map.set(option.id, option);
		return map;
	}, [search.data, labels.data]);

	const selectedOptions = useMemo(
		() => selectedIds.map((selected) => known.get(selected) ?? fallbackOption(selected, props.kind)),
		[selectedIds, known, props.kind],
	);

	const visibleOptions = useMemo(
		() =>
			(search.data?.options ?? []).filter(
				(option) => !excluded.has(option.id) && (props.includeDisabled !== false || option.disabled !== true),
			),
		[search.data, excluded, props.includeDisabled],
	);

	// Labels of selected values must stay resolvable even when they are outside the current result window.
	const items = useMemo(() => {
		const map = new Map(known);
		for (const option of selectedOptions) map.set(option.id, option);
		return [...map.values()];
	}, [known, selectedOptions]);

	const loading = open && (search.isFetching || query !== debouncedQuery || search.isPending);
	const stale = query !== debouncedQuery;
	const empty = !loading && !search.isError && visibleOptions.length === 0;
	const more = search.data?.more === true;

	const remove = (option: EntityOption) => {
		if (props.multiple !== true) return;
		const options = selectedOptions.filter((selected) => selected.id !== option.id);
		props.onChange(
			options.map((selected) => selected.id),
			options,
		);
	};

	const change = (next: EntityOption | EntityOption[] | null) => {
		// Prefer the resolved row (a label or a search result) over a placeholder built only from the id.
		const options = (Array.isArray(next) ? next : next === null ? [] : [next]).map(
			(option) => known.get(option.id) ?? option,
		);
		if (props.multiple === true) {
			props.onChange(
				options.map((option) => option.id),
				options,
			);
			return;
		}
		const option = options[0] ?? null;
		props.onChange(option?.id ?? null, option);
	};

	const chipsTestId = props.testId === undefined ? `entity-picker-${props.kind}-chips` : `${props.testId}-chips`;
	const placeholder =
		props.placeholder ?? i18n._(multiple ? MULTI_PLACEHOLDERS[props.kind] : SINGLE_PLACEHOLDERS[props.kind]);
	const searchPlaceholder = props.searchPlaceholder ?? i18n._(SEARCH_PLACEHOLDERS[props.kind]);

	return (
		<div className="grid gap-1.5" data-testid={props.testId}>
			<Combobox.Root
				items={items}
				filteredItems={visibleOptions}
				filter={null}
				multiple={multiple}
				disabled={props.disabled}
				value={multiple ? selectedOptions : (selectedOptions[0] ?? null)}
				onValueChange={change}
				isItemEqualToValue={(item, value) => item.id === value.id}
				itemToStringLabel={(option) => option.primary}
				open={open}
				onOpenChange={(next, details) => {
					// Multiple picking keeps the popup and the typed search while the user picks several rows.
					if (!next && multiple && details.reason === "item-press") {
						details.cancel();
						return;
					}
					setOpen(next);
				}}
				onOpenChangeComplete={(next) => {
					if (!next) setInputValue("");
				}}
				onInputValueChange={(next, details) => {
					if (details.isItemPress) {
						// In multiple mode keep the query so several matches can be picked from one search.
						if (multiple) details.cancel();
						return;
					}
					setInputValue(next);
				}}
			>
				<Combobox.Trigger
					type="button"
					id={id}
					disabled={props.disabled}
					aria-label={props.label}
					className={cn(TRIGGER_CLASS, props.className)}
				>
					<span
						className={cn("min-w-0 flex-1 truncate text-left", selectedOptions.length === 0 && "text-muted-foreground")}
					>
						{selectedOptions.length === 0 ? (
							placeholder
						) : multiple ? (
							<Plural value={selectedOptions.length} one="# selected" other="# selected" />
						) : (
							selectedOptions[0]?.primary
						)}
					</span>
					<ChevronsUpDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
				</Combobox.Trigger>

				<Combobox.Portal>
					<Combobox.Positioner align="start" sideOffset={4} className="isolate z-50">
						<Combobox.Popup
							aria-busy={search.isFetching || undefined}
							className="relative isolate z-50 flex max-h-(--available-height) w-(--anchor-width) min-w-72 max-w-(--available-width) flex-col overflow-hidden rounded-lg bg-popover p-0 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden"
						>
							<div className="border-b p-2">
								<Combobox.Input
									aria-label={searchPlaceholder}
									placeholder={searchPlaceholder}
									className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
								/>
							</div>
							<Combobox.List className="max-h-64 overflow-y-auto overscroll-contain p-1 outline-hidden">
								{(option: EntityOption) => (
									<Combobox.Item
										key={option.id}
										value={option}
										className={cn(
											"grid cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-sm outline-hidden select-none",
											"data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
										)}
									>
										<Combobox.ItemIndicator className="col-start-1 flex size-4 items-center justify-center">
											<CheckIcon className="size-3.5" />
										</Combobox.ItemIndicator>
										<span className="col-start-2 flex min-w-0 flex-col">
											<span className="truncate">{option.primary}</span>
											{option.secondary !== undefined && option.secondary !== "" && (
												<span className="truncate text-xs text-muted-foreground">{option.secondary}</span>
											)}
										</span>
										{props.kind === "directory" || props.kind === "nodeTarget" ? (
											<OptionKindBadge kind={option.kind} />
										) : null}
									</Combobox.Item>
								)}
							</Combobox.List>
							<Combobox.Empty>
								{empty && !more ? (
									<p className="px-2 py-2 text-sm text-muted-foreground">{props.emptyText ?? t`No matches`}</p>
								) : null}
							</Combobox.Empty>
							{loading && (
								<p className="border-t px-3 py-2 text-xs text-muted-foreground">{props.loadingText ?? t`Loading…`}</p>
							)}
							{!loading && search.isError && (
								<p className="border-t px-3 py-2 text-xs text-muted-foreground">{t`Search failed`}</p>
							)}
							{!loading && !stale && more && (
								<p className="border-t px-3 py-2 text-xs text-muted-foreground">
									{props.moreText ?? t`More results — keep typing to narrow down`}
								</p>
							)}
						</Combobox.Popup>
					</Combobox.Positioner>
				</Combobox.Portal>
			</Combobox.Root>

			{multiple && selectedOptions.length > 0 && (
				<div className="flex flex-wrap gap-1" data-testid={chipsTestId}>
					{selectedOptions.map((option) => (
						<Badge key={option.id} variant="secondary" className="gap-1 pr-1">
							<span className="max-w-48 truncate">{option.primary}</span>
							<button
								type="button"
								aria-label={t`Remove ${option.primary}`}
								disabled={props.disabled}
								className="flex size-3.5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
								onClick={() => remove(option)}
							>
								<XIcon className="size-3" />
							</button>
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}
