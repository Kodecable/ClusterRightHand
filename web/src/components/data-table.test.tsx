import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import type { DataTableColumn } from "./data-table";
import { DataTable } from "./data-table";

interface Row {
	id: string;
	name: string;
	state: string;
}

const columns: DataTableColumn<Row>[] = [
	{ accessorKey: "name", header: "Name", cell: (info) => String(info.getValue()) },
	{ accessorKey: "state", header: "State", cell: (info) => String(info.getValue()) },
];

const rows: Row[] = Array.from({ length: 12 }, (_, index) => ({
	id: `r-${index}`,
	name: `row ${index}`,
	state: index % 2 === 0 ? "active" : "idle",
}));

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

	test("rows are clickable when a row handler is given", () => {
		const onRowClick = vi.fn();
		renderWithI18n(<DataTable data={rows.slice(0, 1)} columns={columns} label="Clickable" onRowClick={onRowClick} />);
		fireEvent.click(screen.getByText("row 0"));
		expect(onRowClick).toHaveBeenCalledWith(rows[0]);
	});
});
