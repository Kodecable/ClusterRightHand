// biome-ignore-all lint/a11y: the virtualised body is an ARIA grid over divs; a real <table> cannot host virtua windowed rows, and grid rows are reached through their cells.
import { Trans } from "@lingui/react/macro";
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
	onRowClick?: (row: T) => void;
	/** Rows above this count are virtualised (doc/webui.md "DataTable"). */
	virtualizeAfter?: number;
	/** Height of the virtualised viewport. */
	height?: number;
	/** Fixed row height used by the virtualiser. */
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

function columnSize<T extends RowData>(column: DataTableColumn<T>): number {
	const size = column.size;
	return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * The one column template shared by the header row and every body row, so a
 * header label always sits above its values. A column with a declared size
 * keeps that width; the rest share what is left.
 */
function columnTemplate<T extends RowData>(columns: DataTableColumn<T>[], narrow: boolean): string {
	return columns
		.map((column) => {
			const size = columnSize(column);
			if (size > 0) return `${size}px`;
			return narrow ? `minmax(${NARROW_COLUMN_MIN_REM}rem, 1fr)` : "minmax(0, 1fr)";
		})
		.join(" ");
}

/**
 * Below `md` the table keeps its minimum column widths and scrolls sideways
 * instead of crushing every column to a few characters (doc/webui.md
 * "DataTable"). The computed minimum also sets the table's narrow width so the
 * header and the rows scroll together.
 */
function minimumWidth<T extends RowData>(columns: DataTableColumn<T>[]): string {
	let fixed = 0;
	let narrow = 0;
	for (const column of columns) {
		const size = columnSize(column);
		if (size > 0) fixed += size;
		else narrow += 1;
	}
	if (narrow === 0) return `${fixed}px`;
	return `calc(${fixed}px + ${narrow} * ${NARROW_COLUMN_MIN_REM}rem)`;
}

/**
 * The shared table: TanStack Table for the column model, cursor infinite
 * loading through `onLoadMore`, and virtua for the row window once the list is
 * long enough that rendering every row would hurt (a few hundred rows).
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
	onRowClick,
	virtualizeAfter = 250,
	height = 560,
	rowHeight = 44,
	className,
	label,
}: DataTableProps<T>) {
	const table = useTable({
		data,
		columns,
		features: stockFeatures,
		getRowId: getRowId ? (row) => getRowId(row) : undefined,
	});

	const rows = table.getRowModel().rows;
	const headerGroups = table.getHeaderGroups();
	const template = useMemo(() => columnTemplate(columns, false), [columns]);
	const narrowTemplate = useMemo(() => columnTemplate(columns, true), [columns]);
	const narrowWidth = useMemo(() => minimumWidth(columns), [columns]);
	const virtualised = rows.length > virtualizeAfter;

	if (error !== undefined) {
		return <ErrorState error={error} retry={onRetry} className={className} />;
	}

	if (loading && rows.length === 0) {
		return (
			<div className={cn("flex items-center justify-center rounded-lg border py-12", className)}>
				<Spinner />
			</div>
		);
	}

	if (rows.length === 0) {
		return (
			<div className={cn("rounded-lg border", className)}>
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
			className="border-b bg-muted/60 text-xs font-medium text-muted-foreground"
		>
			{headerGroups[0]?.headers.map((head) => (
				<div key={head.id} role="columnheader" className="min-w-0 px-3 py-2 text-left">
					{head.isPlaceholder ? null : flexRender(head.column.columnDef.header, head.getContext())}
				</div>
			))}
		</div>
	);

	const renderCells = (row: (typeof rows)[number]) => (
		<>
			{row.getVisibleCells().map((cell) => (
				<div key={cell.id} role="cell" className="min-w-0 truncate px-3 py-2 text-sm">
					{flexRender(cell.column.columnDef.cell, cell.getContext())}
				</div>
			))}
		</>
	);

	const sentinel = hasMore && onLoadMore && <LoadMoreSentinel loading={loadingMore} onLoadMore={onLoadMore} />;

	return (
		<div
			className={cn("overflow-hidden rounded-lg border", className)}
			data-slot="data-table"
			style={
				{
					"--dt-columns": template,
					"--dt-columns-narrow": narrowTemplate,
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
							rowHeight={rowHeight}
							renderCells={renderCells}
							onRowClick={onRowClick}
						/>
					) : (
						<div role="rowgroup">
							{rows.map((row) => (
								<div
									key={row.id}
									role="row"
									data-slot="data-table-row"
									data-state={row.getIsSelected() ? "selected" : undefined}
									className={cn("border-b last:border-b-0", onRowClick && "cursor-pointer hover:bg-accent/60")}
									onClick={onRowClick ? () => onRowClick(row.original) : undefined}
									onKeyDown={
										onRowClick
											? (event) => {
													if (event.key === "Enter" || event.key === " ") {
														event.preventDefault();
														onRowClick(row.original);
													}
												}
											: undefined
									}
									tabIndex={onRowClick ? 0 : undefined}
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
	renderCells,
	onRowClick,
}: {
	rows: ReturnType<Table<StockFeatures, T>["getRowModel"]>["rows"];
	height: number;
	rowHeight: number;
	renderCells: (row: ReturnType<Table<StockFeatures, T>["getRowModel"]>["rows"][number]) => React.ReactNode;
	onRowClick?: (row: T) => void;
}) {
	return (
		<div style={{ height }} className="overflow-y-auto" data-slot="data-table-virtual">
			<Virtualizer data={rows} itemSize={rowHeight} bufferSize={rowHeight * 6}>
				{(row) => (
					<div
						role="row"
						data-slot="data-table-row"
						data-row-id={row.id}
						className={cn("border-b last:border-b-0", onRowClick && "cursor-pointer hover:bg-accent/60")}
						style={{ height: rowHeight }}
						onClick={onRowClick ? () => onRowClick(row.original as T) : undefined}
						onKeyDown={
							onRowClick
								? (event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											onRowClick(row.original as T);
										}
									}
								: undefined
						}
						tabIndex={onRowClick ? 0 : undefined}
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
