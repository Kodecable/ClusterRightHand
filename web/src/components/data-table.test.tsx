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

const rows: Row[] = Array.from({ length: 12 }, (_, index) => ({
	id: `r-${index}`,
	name: `row ${index}`,
	state: index % 2 === 0 ? "active" : "idle",
}));

/** A table whose second cell holds a control that must win over the row overlay. */
function withAction(onClick: (row: Row) => void): DataTableColumn<Row>[] {
	return [
		nameColumn,
		{
			id: "action",
			header: "Action",
			cell: ({ row }) => (
				<button type="button" className="relative z-10" onClick={() => onClick(row.original)}>
					Act on {row.original.name}
				</button>
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

	test("a row link is one real anchor covering the row, named by the item", async () => {
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
		// The item's own name stays plain text; the anchor is the invisible overlay in the first cell.
		expect(screen.getByText("row 0").closest("a")).toBeNull();
		expect(first.closest('[role="cell"]')).not.toBeNull();
		// One link per row, and it is the row's only focusable element.
		expect(screen.getAllByRole("link")).toHaveLength(2);
	});

	test("an inner control stays above the row link and is not part of it", async () => {
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
		// The button sits in its own cell, outside the row's stretched link.
		expect(button.closest("a")).toBeNull();
		expect(button).toHaveClass("relative", "z-10");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledWith(rows[0]);
		// The click belongs to the button: the row did not navigate away.
		expect(screen.getByRole("table", { name: "Actions" })).toBeInTheDocument();
		// The row link itself still navigates.
		fireEvent.click(screen.getByRole("link", { name: "row 0" }));
		await waitFor(() => expect(screen.queryByRole("table", { name: "Actions" })).not.toBeInTheDocument());
	});

	test("onRowActivate renders a stretched button reachable by click and keyboard", async () => {
		const onRowActivate = vi.fn();
		renderWithI18n(
			<DataTable
				data={rows.slice(0, 2)}
				columns={columns}
				label="Activatable"
				onRowActivate={onRowActivate}
				rowLabel={(row) => `Event ${row.id}`}
			/>,
			"en",
		);
		const first = screen.getByRole("button", { name: "Event r-0" });
		expect(screen.getByRole("button", { name: "Event r-1" })).toBeInTheDocument();
		fireEvent.click(first);
		expect(onRowActivate).toHaveBeenCalledWith(rows[0]);

		const user = userEvent.setup();
		first.focus();
		await user.keyboard("{Enter}");
		await user.keyboard(" ");
		expect(onRowActivate).toHaveBeenCalledTimes(3);
	});
});
