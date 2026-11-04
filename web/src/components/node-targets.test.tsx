import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { RefMap } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { NodeTargetList } from "./node-targets";

const REFS: RefMap = {
	"node-1": { kind: "node", name: "worker-01" },
	"group-1": { kind: "node_group", name: "web" },
	gone: null,
};

describe("NodeTargetList", () => {
	test("renders links, All accessible nodes and deleted references", async () => {
		await renderWithRouter(<NodeTargetList ids={["node-1", "group-1", "_all", "gone", "legacy-name"]} refs={REFS} />);
		expect(screen.getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("href", "/node-groups/group-1");
		expect(screen.getByText("All accessible nodes")).toBeInTheDocument();
		expect(screen.getByText("Deleted node or node group")).toBeInTheDocument();
		// An old non-UUID target has no ref; it stays visible instead of disappearing.
		expect(screen.getByText("legacy-name")).toBeInTheDocument();
	});

	test("falls back to the supplied node names when refs lack an id", async () => {
		await renderWithRouter(
			<NodeTargetList ids={["node-1"]} refs={{}} nodeNames={new Map([["node-1", "worker-01"]])} />,
		);
		const targets = screen.getByText("worker-01").closest("[data-slot='node-targets']");
		if (!(targets instanceof HTMLElement)) throw new Error("no targets list");
		expect(within(targets).getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
	});
});
