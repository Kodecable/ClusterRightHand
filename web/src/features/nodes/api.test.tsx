import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useNodeNames } from "./api";

/** Node names by id: the node's current name, or its id when the name is not known. */
function mockNodes(nodes: { id: string; name: string }[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ nodes }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useNodeNames", () => {
	test("maps each node to its name and falls back to its id", async () => {
		mockNodes([
			{ id: "node-1", name: "worker-01" },
			{ id: "node-2", name: "" },
		]);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { result } = renderHook(() => useNodeNames(), { wrapper: wrapper(client) });

		await waitFor(() => expect(result.current.get("node-1")).toBe("worker-01"));
		expect(result.current.get("node-2")).toBe("node-2");
		expect(result.current.get("missing")).toBeUndefined();
	});
});
