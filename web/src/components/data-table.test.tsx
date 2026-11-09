import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { renderWithI18n, renderWithRouter } from "@/test/render";
import type { DataTableColumn } from "./data-table";
import { DataTable } from "./data-table";

interface Row {
	id: string;
	name: string;
	state: string;
}

const nameColumn: DataTableColumn<Row> = {
	accessorKey: "name",
	header: "Name",
	cell: (info) => String(info.getValue()),
};

const columns: DataTableColumn<Row>[] = [
	nameColumn,
	{ accessorKey: "state", header: "State", cell: (info) => String(info.getValue()) },
];

/**
 * One fixed column, one minimum column and two flexible free-text columns:
 * the minimum the table must keep is 120 + 140 + 2 * 48 = 356px, and below
 * `md` the two flexible columns get the 12rem floor.
 */
const sizedColumns: DataTableColumn<Row>[] = [
	{ accessorKey: "name", header: "Name", size: 120, cell: (info) => String(info.getValue()) },
	{ accessorKey: "state", header: "State", minSize: 140, cell: (info) => String(info.getValue()) },
	{ accessorKey: "id", header: "Id", cell: (info) => String(info.getValue()) },
	{ id: "note", header: "Note", cell: () => "free text" },
];

const rows: Row[] = Array.from({ length: 12 }, (_, index) => ({
	id: `r-${index}`,
	name: `row ${index}`,
	state: index % 2 === 0 ? "active" : "idle",
}));

/** A table whose second cell holds controls that must win over the row click. */
function withAction(onClick: (row: Row) => void): DataTableColumn<Row>[] {
	return [
		nameColumn,
		{
			id: "action",
			header: "Action",
			cell: ({ row }) => (
				<span className="flex items-center gap-2">
					<a href="/elsewhere" onClick={(event) => event.preventDefault()}>
						Elsewhere {row.original.name}
					</a>
					<button type="button" onClick={() => onClick(row.original)}>
						Act on {row.original.name}
					</button>
				</span>
			),
		},
	];
}

describe("DataTable", () => {
	test("renders columns and rows", () => {
		renderWithI18n(<DataTable data={rows.slice(0, 3)} columns={columns} label="Test table" />);
		expect(screen.getByRole("table", { name: "Test table" })).toBeInTheDocument();
		expect(screen.getByText("row 0")).toBeInTheDocument();
		expect(screen.getByText("row 2")).toBeInTheDocument();
		expect(screen.queryByText("row 3")).not.toBeInTheDocument();
	});

	test("keeps the columns' minimum width so a narrow frame scrolls instead of clipping", () => {
		// jsdom does not apply index.css, so the stylesheet's contract is asserted
		// through the custom properties DataTable puts on the frame:
		//   min-width: var(--dt-min-width)  (all widths)
		//   min-width: var(--dt-narrow-width)  (below md)
		// The header and every row share the same grid template, so the whole
		// table scrolls together inside data-table-scroll.
		const { container } = renderWithI18n(
			<DataTable data={rows.slice(0, 2)} columns={sizedColumns} label="Sized table" />,
		);
		const frame = container.querySelector<HTMLElement>('[data-slot="data-table"]');
		if (frame === null) throw new Error("no data table frame");

		// 120px fixed + 140px minimum + 2 * 48px floor for the free-text columns.
		expect(frame.style.getPropertyValue("--dt-min-width")).toBe("356px");
		// Below md the flexible columns keep their 12rem floor as before.
		expect(frame.style.getPropertyValue("--dt-narrow-width")).toBe("calc(260px + 2 * 12rem)");
		expect(frame.style.getPropertyValue("--dt-columns")).toBe(
			"120px minmax(140px, 1fr) minmax(48px, 1fr) minmax(48px, 1fr)",
		);
		expect(frame.style.getPropertyValue("--dt-columns-narrow")).toBe(
			"120px minmax(140px, 1fr) minmax(12rem, 1fr) minmax(12rem, 1fr)",
		);
		expect(container.querySelector('[data-slot="data-table-scroll"]')).toHaveClass("overflow-x-auto");
	});

	test("body rows keep one fixed min height and center their cells", () => {
		const { container } = renderWithI18n(<DataTable data={rows.slice(0, 2)} columns={columns} label="Heights" />);
		const header = container.querySelector<HTMLElement>('[role="table"] > [role="row"]');
		if (header === null) throw new Error("no header row");
		expect(header).toHaveClass("min-h-8", "items-center");

		const bodyRows = container.querySelectorAll<HTMLElement>('[role="rowgroup"] [data-slot="data-table-row"]');
		expect(bodyRows).toHaveLength(2);
		for (const row of bodyRows) {
			// 40px whatever controls the cells hold, and the grid centers each cell.
			expect(row).toHaveClass("min-h-10", "items-center");
			// The fixed height is the row's; the cell keeps horizontal padding and a
			// small vertical padding so a control never drives the row height.
			expect(row.querySelector('[role="cell"]')).toHaveClass("px-3", "py-1", "text-sm");
		}
	});

	test("compact body rows are 32px high", () => {
		const { container } = renderWithI18n(
			<DataTable data={rows.slice(0, 1)} columns={columns} label="Compact heights" density="compact" />,
		);
		const header = container.querySelector<HTMLElement>('[role="table"] > [role="row"]');
		if (header === null) throw new Error("no header row");
		expect(header).toHaveClass("min-h-7", "items-center");
		const row = container.querySelector<HTMLElement>('[role="rowgroup"] [data-slot="data-table-row"]');
		if (row === null) throw new Error("no body row");
		expect(row).toHaveClass("min-h-8", "items-center");
		expect(row.querySelector('[role="cell"]')).toHaveClass("px-2", "py-0.5", "text-xs");
	});

	test("the load-more sentinel asks for the next cursor page", () => {
		const onLoadMore = vi.fn();
		renderWithI18n(
			<DataTable data={rows.slice(0, 3)} columns={columns} label="Paged" hasMore onLoadMore={onLoadMore} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	test("a loading sentinel cannot be clicked twice", () => {
		const onLoadMore = vi.fn();
		renderWithI18n(
			<DataTable data={rows.slice(0, 3)} columns={columns} label="Paged" hasMore loadingMore onLoadMore={onLoadMore} />,
		);
		expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
	});

	test("shows the empty state", () => {
		renderWithI18n(<DataTable data={[]} columns={columns} label="Empty" />);
		expect(screen.getByText("Nothing to show.")).toBeInTheDocument();
	});

	test("shows an error with retry", () => {
		const retry = vi.fn();
		renderWithI18n(<DataTable data={[]} columns={columns} label="Error" error={new Error("boom")} onRetry={retry} />);
		expect(screen.getByRole("alert")).toHaveTextContent("boom");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalled();
	});

	test("switches to the virtualised body for long lists", () => {
		const { container } = renderWithI18n(
			<DataTable data={rows} columns={columns} label="Long" virtualizeAfter={5} rowHeight={20} height={120} />,
		);
		expect(container.querySelector('[data-slot="data-table-virtual"]')).not.toBeNull();
	});

	test("the row's link sits inside the first cell and is named by the item", async () => {
		await renderWithRouter(
			<DataTable
				data={rows.slice(0, 2)}
				columns={columns}
				label="Linked"
				rowLink={(row) => ({ to: "/nodes/$nodeId", params: { nodeId: row.id } })}
				rowLabel={(row) => row.name}
			/>,
		);

		const first = screen.getByRole("link", { name: "row 0" });
		expect(first).toHaveAttribute("href", "/nodes/r-0");
		expect(screen.getByRole("link", { name: "row 1" })).toHaveAttribute("href", "/nodes/r-1");
		// The name itself is the link, and the link lives in the row's first cell.
		expect(screen.getByText("row 0").closest("a")).toBe(first);
		expect(first.closest('[role="cell"]')).toBe(screen.getByText("row 0").closest('[role="cell"]'));
		// One link per row, and it is the row's only focusable element.
		expect(screen.getAllByRole("link")).toHaveLength(2);
	});

	test("rowLinkColumn moves the row's link to the chosen cell", async () => {
		await renderWithRouter(
			<DataTable
				data={rows.slice(0, 1)}
				columns={columns}
				label="Linked state"
				rowLink={(row) => ({ to: "/nodes/$nodeId", params: { nodeId: row.id } })}
				rowLabel={(row) => row.name}
				rowLinkColumn="state"
			/>,
		);
		const link = screen.getByRole("link", { name: "row 0" });
		expect(link).toHaveTextContent("active");
		expect(screen.getByText("active").closest("a")).toBe(link);
	});

	test("clicking a cell that is not a link navigates to the row's page", async () => {
		await renderWithRouter(
			<DataTable
				data={rows.slice(0, 2)}
				columns={columns}
				label="Clickable"
				rowLink={(row) => ({ to: "/nodes/$nodeId", params: { nodeId: row.id } })}
				rowLabel={(row) => row.name}
			/>,
		);
		const active = screen.getAllByText("active")[0];
		if (active === undefined) throw new Error("no state cell");
		fireEvent.click(active);
		await waitFor(() => expect(screen.queryByRole("table", { name: "Clickable" })).not.toBeInTheDocument());
	});

	test("a link or button inside a cell keeps its click and never triggers the row", async () => {
		const onClick = vi.fn();
		await renderWithRouter(
			<DataTable
				data={rows.slice(0, 1)}
				columns={withAction(onClick)}
				label="Actions"
				rowLink={(row) => ({ to: "/tasks/$taskId", params: { taskId: row.id } })}
				rowLabel={(row) => row.name}
			/>,
		);
		const button = screen.getByRole("button", { name: "Act on row 0" });
		// The button sits in its own cell, outside the row's link.
		expect(button.closest("a")).toBeNull();
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledWith(rows[0]);
		// The click belongs to the controls: the row did not navigate away.
		expect(screen.getByRole("table", { name: "Actions" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("link", { name: "Elsewhere row 0" }));
		expect(screen.getByRole("table", { name: "Actions" })).toBeInTheDocument();
		// The row link itself still navigates.
		fireEvent.click(screen.getByRole("link", { name: "row 0" }));
		await waitFor(() => expect(screen.queryByRole("table", { name: "Actions" })).not.toBeInTheDocument());
	});

	test("Ctrl-click or middle-click opens the row in a new tab", async () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		await renderWithRouter(
			<DataTable
				data={rows.slice(0, 1)}
				columns={columns}
				label="New tab"
				rowLink={(row) => ({ to: "/nodes/$nodeId", params: { nodeId: row.id } })}
				rowLabel={(row) => row.name}
			/>,
		);
		const cell = screen.getByText("active");
		fireEvent.click(cell, { ctrlKey: true });
		expect(open).toHaveBeenCalledWith("/nodes/r-0", "_blank", "noopener");
		open.mockClear();
		fireEvent(cell, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
		expect(open).toHaveBeenCalledWith("/nodes/r-0", "_blank", "noopener");
		expect(screen.getByRole("table", { name: "New tab" })).toBeInTheDocument();
		open.mockRestore();
	});

	test("a click with a text selection does not navigate", async () => {
		const selection = { toString: () => "row 0" };
		const getSelection = vi.spyOn(window, "getSelection").mockReturnValue(selection as Selection);
		await renderWithRouter(
			<DataTable
				data={rows.slice(0, 1)}
				columns={columns}
				label="Selectable"
				rowLink={(row) => ({ to: "/nodes/$nodeId", params: { nodeId: row.id } })}
				rowLabel={(row) => row.name}
			/>,
		);
		fireEvent.click(screen.getByText("active"));
		expect(screen.getByRole("table", { name: "Selectable" })).toBeInTheDocument();
		getSelection.mockRestore();
	});

	test("row navigation adds no overlay, so cell titles stay reachable", async () => {
		const { container } = await renderWithRouter(
			<DataTable
				data={rows.slice(0, 1)}
				columns={columns}
				label="Titled"
				rowLink={(row) => ({ to: "/nodes/$nodeId", params: { nodeId: row.id } })}
				rowLabel={(row) => row.name}
			/>,
		);
		expect(screen.getByText("row 0").closest('[role="cell"]')).toHaveAttribute("title", "row 0");
		expect(container.querySelector(".absolute.inset-0")).toBeNull();
	});

	test("onRowActivate runs from a row click and from the in-cell button by keyboard", async () => {
		const onRowActivate = vi.fn();
		renderWithI18n(
			<DataTable
				data={rows.slice(0, 2)}
				columns={columns}
				label="Activatable"
				onRowActivate={onRowActivate}
				rowLabel={(row) => `Event ${row.id}`}
				rowActivateColumn="state"
			/>,
			"en",
		);
		const first = screen.getByRole("button", { name: "Event r-0" });
		expect(screen.getByRole("button", { name: "Event r-1" })).toBeInTheDocument();
		expect(first).toHaveTextContent("active");
		// A click on another cell activates the row.
		fireEvent.click(screen.getByText("row 0"));
		expect(onRowActivate).toHaveBeenCalledWith(rows[0]);
		onRowActivate.mockClear();
		fireEvent.click(first);
		expect(onRowActivate).toHaveBeenCalledWith(rows[0]);
		onRowActivate.mockClear();

		const user = userEvent.setup();
		first.focus();
		await user.keyboard("{Enter}");
		await user.keyboard(" ");
		expect(onRowActivate).toHaveBeenCalledTimes(2);
	});
});
