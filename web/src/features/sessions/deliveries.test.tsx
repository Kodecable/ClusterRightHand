import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithI18n } from "@/test/render";
import { TurnDeliveries } from "./deliveries";
import type { DeliveryDetails } from "./tool-details";

const LIBRARIES = [{ id: "lib-1", ref: "user_group:team-renamed" }];

/** The library was renamed after the tool call; the box resolves it by id. */
const libraryDelivery: DeliveryDetails = {
	source: { library: "user_group:team", libraryId: "lib-1", path: "docs/report.txt" },
	name: "report.txt",
	bytes: 1234,
};

function stubFetch(preview = false): ReturnType<typeof vi.fn> {
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("preview=1")) {
			return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 });
		}
		if (preview) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify({ libraries: LIBRARIES }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TurnDeliveries", () => {
	test("shows the name, the resolved library source and the size, and downloads from the library", async () => {
		stubFetch();
		renderWithI18n(<TurnDeliveries deliveries={[libraryDelivery]} />);
		expect(screen.getByTestId("delivery-box")).toHaveTextContent("report.txt");
		expect(screen.getByTestId("delivery-box")).toHaveTextContent("1.2 KiB");
		await waitFor(() =>
			expect(screen.getByTestId("delivery-download")).toHaveAttribute(
				"href",
				"/api/libraries/user_group%3Ateam-renamed/file?path=docs%2Freport.txt",
			),
		);
		expect(screen.getByTestId("delivery-download")).toHaveAttribute("title", "docs/report.txt");
		// A text file has no preview button.
		expect(screen.queryByTestId("delivery-preview")).not.toBeInTheDocument();
	});

	test("a node source downloads through the node endpoint by node id", () => {
		stubFetch();
		renderWithI18n(
			<TurnDeliveries
				deliveries={[
					{
						source: { node: "web-1", nodeId: "node-1", path: "/srv/report.txt" },
						name: "report.txt",
						bytes: 12,
					},
				]}
			/>,
		);
		expect(screen.getByTestId("delivery-box")).toHaveTextContent("web-1");
		expect(screen.getByTestId("delivery-download")).toHaveAttribute(
			"href",
			"/api/nodes/node-1/file?path=%2Fsrv%2Freport.txt",
		);
		expect(screen.getByTestId("delivery-download")).toHaveAccessibleName("Download report.txt");
	});

	test("previews an image through the preview endpoint", async () => {
		Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:delivery"), configurable: true });
		const fetch = stubFetch();
		renderWithI18n(
			<TurnDeliveries
				deliveries={[
					{
						source: { library: "user_group:team", libraryId: "lib-1", path: "screens/pic.png" },
						name: "pic.png",
						bytes: 10,
					},
				]}
			/>,
		);
		const preview = screen.getByTestId("delivery-preview");
		expect(preview).toHaveAccessibleName("Preview pic.png");
		await userEvent.click(preview);
		expect(await screen.findByTestId("delivery-preview-image")).toHaveAttribute("src", "blob:delivery");
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/libraries/user_group%3Ateam-renamed/file?path=screens%2Fpic.png&preview=1",
				expect.anything(),
			),
		);
	});

	test("a failed preview shows the endpoint's error instead of an image", async () => {
		Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:delivery"), configurable: true });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("preview=1")) {
					return new Response(JSON.stringify({ error: "this file cannot be previewed" }), {
						status: 415,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ libraries: LIBRARIES }), { status: 200 });
			}),
		);
		renderWithI18n(
			<TurnDeliveries
				deliveries={[
					{
						source: { library: "user_group:team", libraryId: "lib-1", path: "screens/pic.png" },
						name: "pic.png",
						bytes: 10,
					},
				]}
			/>,
		);
		await userEvent.click(screen.getByTestId("delivery-preview"));
		expect(await screen.findByText("this file cannot be previewed")).toBeInTheDocument();
		expect(screen.queryByTestId("delivery-preview-image")).not.toBeInTheDocument();
	});
});
