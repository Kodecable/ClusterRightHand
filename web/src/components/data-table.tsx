// biome-ignore-all lint/a11y: the virtualised body is an ARIA grid over divs; a real <table> cannot host virtua windowed rows, and grid rows are reached through their cells.
import { Trans } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import {
	type ColumnDef,
	flexRender,
	type RowData,
	type StockFeatures,
	stockFeatures,
	type Table,
	useTable,
} from "@tanstack/react-table";
import { useEffect, useMemo, useRef } from "react";
import { Virtualizer } from "virtua";
import { ErrorState } from "@/components/error-state";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DataTableColumn<T extends RowData> = ColumnDef<StockFeatures, T>;

/**
 * Where a row links to: the router props of one of the detail routes a list row
 * can point at (doc/design/webui.md "List navigation, links and refresh"). The union keeps `to` and `params`
 * checked at the call site instead of trusting a cast inside the table.
 */
export type DataTableRowLink =
	| { to: "/nodes/$nodeId"; params: { nodeId: string } }
	| { to: "/node-groups/$nodeGroupId"; params: { nodeGroupId: string } }
	| { to: "/schedules/$scheduleId"; params: { scheduleId: string } }
	| { to: "/tasks/$taskId"; params: { taskId: string } }
	| { to: "/sessions/$sessionId"; params: { sessionId: string } }
	| { to: "/task-groups/$taskGroupId"; params: { taskGroupId: string } }
	| { to: "/users/$userId"; params: { userId: string } }
	| { to: "/user-groups/$userGroupId"; params: { userGroupId: string } };

/**
 * What a column may add for the table itself: `title` is the full text of a
 * cell the table truncates, for cells whose rendered text is not their value
 * (an id formatted for display, a name with a badge beside it).
 */
export interface DataTableColumnMeta<T> {
	title?: string | ((row: T) => string | undefined);
}

export interface DataTableProps<T extends RowData> {
	columns: DataTableColumn<T>[];
	data: T[];
	getRowId?: (row: T) => string;
	/** Infinite loading: `onLoadMore` runs from the bottom sentinel (and its button). */
	hasMore?: boolean;
	loadingMore?: boolean;
	onLoadMore?: () => void;
	loading?: boolean;
	error?: unknown;
	onRetry?: () => void;
	empty?: React.ReactNode;
	/**
	 * A table inside a card, dialog or another table: smaller cells and a
	 * tighter header, so the nested table reads as part of its container.
	 */
	density?: "default" | "compact";
	/** Set false for a table nested in a card/dialog that already draws the frame. */
	frame?: boolean;
	/** Extra `data-*` attributes on each row (test ids and ids pages jump to). */
	rowData?: (row: T) => Record<`data-${string}`, string | undefined>;
	/**
	 * Whole-row navigation to the item's own page: clicking a non-interactive
	 * part of the row navigates, and the chosen cell carries a real link for the
	 * keyboard, middle-click, Ctrl+click and "open in new tab". Return
	 * `undefined` for a row without a page (a run that has no session yet).
	 */
	rowLink?: (row: T) => DataTableRowLink | undefined;
	/** The accessible name of `rowLink` / `onRowActivate`, e.g. the item's name. */
	rowLabel?: (row: T) => string;
	/**
	 * The id of the column whose content carries the row's real link (the first
	 * column by default). Set it when the first column is a timestamp or an
	 * action and the item's name lives further right (doc/design/webui.md "List navigation, links and refresh").
	 */
	rowLinkColumn?: string;
	/** A whole-row action that is not a navigation (the audit detail dialog). */
	onRowActivate?: (row: T) => void;
	/** The id of the column whose content carries `onRowActivate`'s button (the first column by default). */
	rowActivateColumn?: string;
	/** Rows above this count are virtualised (doc/design/webui.md "DataTable"). */
	virtualizeAfter?: number;
	/** Height of the virtualised viewport. */
	height?: number;
	/**
	 * Fixed row height used by the virtualiser; defaults to the body row's own
	 * min height (40px, 32px compact).
	 */
	rowHeight?: number;
	className?: string;
	/** An accessible name for the table. */
	label?: string;
}

/**
 * The header of a row-actions column: a visually hidden label, so the column
 * is still announced while the buttons speak for themselves.
 */
export function actionsHeader(): React.ReactElement {
	return (
		<span className="sr-only">
			<Trans>Actions</Trans>
		</span>
	);
}

/** The narrowest a column without a declared size may get below `md`, in rem. */
const NARROW_COLUMN_MIN_REM = 12;

/**
 * The narrowest a flexible column may get above `md`, in px: enough for a few
 * characters, so a free-text column truncates instead of collapsing to a
 * sliver when the fixed columns already use the available width.
 */
const WIDE_COLUMN_FLOOR_PX = 48;

/**
 * Elements that own a click: a row click that starts inside one of them never
 * navigates or activates the row (doc/design/webui.md "List navigation, links and refresh").
 */
const ROW_INTERACTIVE_SELECTOR =
	"a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [contenteditable]";

/**
 * The row's real link/button looks like the cell text: inherited colour, no
 * underline, and a focus ring for keyboard users. It sits inside the chosen
 * cell instead of covering the row, so tooltips and text selection work
 * (doc/design/webui.md "List navigation, links and refresh").
 */
const ROW_LINK_CLASS =
	"block min-w-0 rounded-sm text-left text-inherit no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** Whether the user has selected text; a click that ends a selection must not navigate. */
function hasTextSelection(): boolean {
	return (window.getSelection()?.toString() ?? "") !== "";
}

/** The link that carries the row's navigation: a {@link Link}, so every router anchor behaviour stays intact. */
function RowLink({
	href,
	label,
	onClick,
	children,
}: {
	href: DataTableRowLink;
	label: string;
	onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
	children: React.ReactNode;
}) {
	const props = { "aria-label": label, className: ROW_LINK_CLASS, onClick };
	switch (href.to) {
		case "/nodes/$nodeId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/node-groups/$nodeGroupId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/schedules/$scheduleId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/tasks/$taskId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/sessions/$sessionId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/task-groups/$taskGroupId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/users/$userId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
		case "/user-groups/$userGroupId":
			return (
				<Link to={href.to} params={href.params} {...props}>
					{children}
				</Link>
			);
	}
}

/** The row's non-navigation action, the keyboard counterpart of the row click. */
function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
			className={ROW_LINK_CLASS}
		>
			{children}
		</button>
	);
}

/** The index of the cell that carries a row's link/button (the first column when unset or missing). */
function columnIndex(cells: { column: { id: string } }[], columnId: string | undefined): number {
	if (columnId === undefined) return 0;
	const index = cells.findIndex((cell) => cell.column.id === columnId);
	return index === -1 ? 0 : index;
}

function columnSize<T extends RowData>(column: DataTableColumn<T>): number {
	const size = column.size;
	return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * The min width a column declares (`minSize`, TanStack's own field): the
 * primary name column and the free-text columns set one so the grid can never
 * squeeze them to a few characters. They still grow to use spare width.
 */
function columnMinSize<T extends RowData>(column: DataTableColumn<T>): number {
	const size = column.minSize;
	return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * The one column template shared by the header row and every body row, so a
 * header label always sits above its values. A column with a declared size
 * keeps that width; a column with a minimum width gets at least that and grows;
 * the rest share what is left, never below a small floor. The table keeps the
 * grid's computed minimum and lets its scroll frame scroll instead of crushing
 * a name or a timestamp (doc/design/webui.md "DataTable").
 */
function columnTemplate<T extends RowData>(columns: DataTableColumn<T>[], narrow: boolean): string {
	return columns
		.map((column) => {
			const size = columnSize(column);
			if (size > 0) return `${size}px`;
			const minSize = columnMinSize(column);
			if (minSize > 0) return `minmax(${minSize}px, 1fr)`;
			return narrow ? `minmax(${NARROW_COLUMN_MIN_REM}rem, 1fr)` : `minmax(${WIDE_COLUMN_FLOOR_PX}px, 1fr)`;
		})
		.join(" ");
}

/**
 * Below `md` the table keeps its minimum column widths and scrolls sideways
 * instead of crushing every column to a few characters (doc/design/webui.md "DataTable").
 * The computed minimum also sets the table's width at every
 * breakpoint, so the header and the rows scroll together instead of the last
 * columns being clipped by the frame.
 */
function minimumWidth<T extends RowData>(columns: DataTableColumn<T>[], narrow: boolean): string {
	let fixed = 0;
	let flexible = 0;
	for (const column of columns) {
		const size = columnSize(column);
		if (size > 0) {
			fixed += size;
			continue;
		}
		const minSize = columnMinSize(column);
		if (minSize > 0) fixed += minSize;
		else flexible += 1;
	}
	if (flexible === 0) return `${fixed}px`;
	if (narrow) return `calc(${fixed}px + ${flexible} * ${NARROW_COLUMN_MIN_REM}rem)`;
	return `${fixed + flexible * WIDE_COLUMN_FLOOR_PX}px`;
}

/** The full text of a cell for its `title`, so a truncated value is never lost. */
function columnTitle<T extends RowData>(column: DataTableColumn<T>, cellValue: unknown, row: T): string | undefined {
	const meta = column.meta as DataTableColumnMeta<T> | undefined;
	const declared = typeof meta?.title === "function" ? meta.title(row) : meta?.title;
	if (declared !== undefined && declared !== "") return declared;
	if (typeof cellValue === "string" && cellValue !== "") return cellValue;
	if (typeof cellValue === "number") return String(cellValue);
	return undefined;
}

/**
 * The shared table: TanStack Table for the column model, cursor infinite
 * loading through `onLoadMore`, and virtua for the row window once the list is
 * long enough that rendering every row would hurt (a few hundred rows).
 *
 * A list row that stands for an item with a detail page navigates there as a
 * whole (`rowLink`); a row whose action is not a navigation gets
 * `onRowActivate`. The affordance is the pointer cursor and the accent hover;
 * the row's keyboard/“open in new tab” target is a real link (or button for
 * `onRowActivate`) inside one chosen cell, styled as plain text, so it never
 * covers the other cells and their `title` tooltips (doc/design/webui.md "List navigation, links and refresh").
 *
 * Columns use `size` for a fixed width and `minSize` for a minimum that still
 * grows; an absolute-time column's `size` comes from `useTimeColumnWidth`
 * (`time-column.ts`), which measures a full timestamp in the cell font. A cell
 * whose rendered text may truncate gets a `title` from its value or from
 * `meta.title`. Nested tables pass `density="compact"` and
 * `frame={false}` (doc/design/webui.md "Tables, status and dialogs").
 */
export function DataTable<T extends RowData>({
	columns,
	data,
	getRowId,
	hasMore = false,
	loadingMore = false,
	onLoadMore,
	loading = false,
	error,
	onRetry,
	empty,
	density = "default",
	frame = true,
	rowData,
	rowLink,
	rowLabel,
	rowLinkColumn,
	onRowActivate,
	rowActivateColumn,
	virtualizeAfter = 250,
	height = 560,
	rowHeight,
	className,
	label,
}: DataTableProps<T>) {
	const table = useTable({
		data,
		columns,
		features: stockFeatures,
		getRowId: getRowId ? (row) => getRowId(row) : undefined,
	});
	// `warn: false` keeps a plain table (no `rowLink`) renderable without a router.
	const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;

	const rows = table.getRowModel().rows;
	const headerGroups = table.getHeaderGroups();
	const template = useMemo(() => columnTemplate(columns, false), [columns]);
	const narrowTemplate = useMemo(() => columnTemplate(columns, true), [columns]);
	const minWidth = useMemo(() => minimumWidth(columns, false), [columns]);
	const narrowWidth = useMemo(() => minimumWidth(columns, true), [columns]);
	const virtualised = rows.length > virtualizeAfter;
	const compact = density === "compact";
	// Every body row has the same minimum height whatever controls it holds; the
	// virtualiser's item size follows it unless the caller measured its own rows.
	const bodyRowMinHeight = compact ? "min-h-8" : "min-h-10";
	const virtualRowHeight = rowHeight ?? (compact ? 32 : 40);

	if (error !== undefined) {
		return <ErrorState error={error} retry={onRetry} className={className} />;
	}

	if (loading && rows.length === 0) {
		return (
			<div className={cn("flex items-center justify-center py-12", frame && "rounded-lg border", className)}>
				<Spinner />
			</div>
		);
	}

	if (rows.length === 0) {
		return (
			<div className={cn(frame && "rounded-lg border", className)}>
				{empty ?? (
					<p className="py-12 text-center text-sm text-muted-foreground">
						<Trans>Nothing to show.</Trans>
					</p>
				)}
			</div>
		);
	}

	const header = (
		<div
			role="row"
			data-slot="data-table-row"
			className={cn(
				"items-center border-b bg-muted/60 font-medium text-muted-foreground",
				compact ? "min-h-7 text-[11px] leading-4" : "min-h-8 text-xs",
			)}
		>
			{headerGroups[0]?.headers.map((head) => (
				<div
					key={head.id}
					role="columnheader"
					className={cn("min-w-0 text-left", compact ? "px-2 py-1.5" : "px-3 py-1.5")}
				>
					{head.isPlaceholder ? null : flexRender(head.column.columnDef.header, head.getContext())}
				</div>
			))}
		</div>
	);

	const isInteractive = (row: T): boolean => rowLink?.(row) !== undefined || onRowActivate !== undefined;

	const hrefOf = (href: DataTableRowLink): string | undefined => router?.buildLocation(href).href;

	/** A click on the row itself (not on a control inside it) navigates or activates it. */
	const activate = (row: T, event: React.MouseEvent<HTMLDivElement>) => {
		if (event.defaultPrevented) return;
		const target = event.target;
		if (target instanceof Element && target.closest(ROW_INTERACTIVE_SELECTOR) !== null) return;
		// A click that ends a text selection must not navigate: copying a cell wins.
		if (hasTextSelection()) return;
		const href = rowLink?.(row);
		if (href !== undefined) {
			if (event.metaKey || event.ctrlKey || event.shiftKey) {
				event.preventDefault();
				const url = hrefOf(href);
				if (url !== undefined) window.open(url, "_blank", "noopener");
				return;
			}
			void router?.navigate(href);
			return;
		}
		if (rowLink === undefined) onRowActivate?.(row);
	};

	/** A middle click opens the row's page in a new tab, like a real link. */
	const activateInNewTab = (row: T, event: React.MouseEvent<HTMLDivElement>) => {
		if (event.button !== 1) return;
		const target = event.target;
		if (target instanceof Element && target.closest(ROW_INTERACTIVE_SELECTOR) !== null) return;
		const href = rowLink?.(row);
		if (href === undefined) return;
		const url = hrefOf(href);
		if (url === undefined) return;
		event.preventDefault();
		window.open(url, "_blank", "noopener");
	};

	const rowHandlers = (
		row: T,
	): {
		onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
		onAuxClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
	} => {
		if (!isInteractive(row)) return {};
		return {
			onClick: (event) => activate(row, event),
			onAuxClick: (event) => activateInNewTab(row, event),
		};
	};

	/** The plain-text link's own click: a selection inside the name must not navigate. */
	const onRowLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
		if (hasTextSelection()) event.preventDefault();
	};

	const renderCells = (row: (typeof rows)[number]) => {
		const original = row.original as T;
		const href = rowLink?.(original);
		const name = rowLabel?.(original) ?? "";
		const cells = row.getVisibleCells();
		const linkIndex = href === undefined ? -1 : columnIndex(cells, rowLinkColumn);
		const activateIndex =
			href === undefined && onRowActivate !== undefined ? columnIndex(cells, rowActivateColumn) : -1;
		return (
			<>
				{cells.map((cell, index) => {
					const title = columnTitle(cell.column.columnDef as DataTableColumn<T>, cell.getValue(), original);
					let content = flexRender(cell.column.columnDef.cell, cell.getContext());
					if (index === linkIndex && href !== undefined) {
						content = (
							<RowLink href={href} label={name} onClick={onRowLinkClick}>
								{content}
							</RowLink>
						);
					} else if (index === activateIndex && onRowActivate !== undefined) {
						content = (
							<RowButton label={name} onClick={() => onRowActivate(original)}>
								{content}
							</RowButton>
						);
					}
					return (
						<div
							key={cell.id}
							role="cell"
							title={title}
							className={cn("min-w-0 truncate", compact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm")}
						>
							{content}
						</div>
					);
				})}
			</>
		);
	};

	const sentinel = hasMore && onLoadMore && <LoadMoreSentinel loading={loadingMore} onLoadMore={onLoadMore} />;

	return (
		<div
			className={cn("overflow-hidden", frame && "rounded-lg border", className)}
			data-slot="data-table"
			style={
				{
					"--dt-columns": template,
					"--dt-columns-narrow": narrowTemplate,
					"--dt-min-width": minWidth,
					"--dt-narrow-width": narrowWidth,
				} as React.CSSProperties
			}
		>
			<div data-slot="data-table-scroll" className="overflow-x-auto">
				<div role="table" aria-label={label} className="w-full">
					{header}
					{virtualised ? (
						<VirtualizedBody
							rows={rows}
							height={height}
							rowHeight={virtualRowHeight}
							bodyRowMinHeight={bodyRowMinHeight}
							renderCells={renderCells}
							isInteractive={isInteractive}
							rowHandlers={rowHandlers}
							rowData={rowData}
						/>
					) : (
						<div role="rowgroup">
							{rows.map((row) => (
								<div
									key={row.id}
									{...(rowData?.(row.original as T) ?? {})}
									{...rowHandlers(row.original as T)}
									role="row"
									data-slot="data-table-row"
									data-state={row.getIsSelected() ? "selected" : undefined}
									className={cn(
										"relative items-center border-b last:border-b-0",
										bodyRowMinHeight,
										isInteractive(row.original) && "cursor-pointer hover:bg-accent/60",
									)}
								>
									{renderCells(row)}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
			{sentinel}
		</div>
	);
}

function VirtualizedBody<T extends RowData>({
	rows,
	height,
	rowHeight,
	bodyRowMinHeight,
	renderCells,
	isInteractive,
	rowHandlers,
	rowData,
}: {
	rows: ReturnType<Table<StockFeatures, T>["getRowModel"]>["rows"];
	height: number;
	rowHeight: number;
	bodyRowMinHeight: string;
	renderCells: (row: ReturnType<Table<StockFeatures, T>["getRowModel"]>["rows"][number]) => React.ReactNode;
	isInteractive: (row: T) => boolean;
	rowHandlers: (row: T) => {
		onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
		onAuxClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
	};
	rowData?: (row: T) => Record<`data-${string}`, string | undefined>;
}) {
	return (
		<div style={{ height }} className="overflow-y-auto" data-slot="data-table-virtual">
			<Virtualizer data={rows} itemSize={rowHeight} bufferSize={rowHeight * 6}>
				{(row) => (
					<div
						{...(rowData?.(row.original as T) ?? {})}
						{...rowHandlers(row.original as T)}
						role="row"
						data-slot="data-table-row"
						data-row-id={row.id}
						className={cn(
							"relative items-center border-b last:border-b-0",
							bodyRowMinHeight,
							isInteractive(row.original as T) && "cursor-pointer hover:bg-accent/60",
						)}
						style={{ height: rowHeight }}
					>
						{renderCells(row as (typeof rows)[number])}
					</div>
				)}
			</Virtualizer>
		</div>
	);
}

function LoadMoreSentinel({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting) && !loading) onLoadMore();
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [loading, onLoadMore]);

	return (
		<div ref={ref} className="flex justify-center border-t p-2" data-slot="data-table-load-more">
			<Button type="button" variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>
				{loading && <Spinner className="size-4" decorative />}
				<Trans>Load more</Trans>
			</Button>
		</div>
	);
}
