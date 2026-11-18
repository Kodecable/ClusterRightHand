import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, fetchBlob, setUnauthorizedHandler } from "./client";

afterEach(() => {
	vi.unstubAllGlobals();
	setUnauthorizedHandler(null);
});

describe("fetchBlob", () => {
	test("returns the bytes and sends the session cookie", async () => {
		const fetch = vi.fn(
			async () => new Response(new Blob(["abc"]), { status: 200, headers: { "content-type": "image/png" } }),
		);
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();

		const blob = await fetchBlob("/api/file?preview=1", controller.signal);
		expect(blob.type).toBe("image/png");
		expect(fetch).toHaveBeenCalledWith(
			"/api/file?preview=1",
			expect.objectContaining({ credentials: "same-origin", signal: controller.signal }),
		);
	});

	test("turns a JSON error body into the ApiError and reports a lost session on 401", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "this file cannot be previewed" }), {
						status: 401,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const unauthorized = vi.fn();
		setUnauthorizedHandler(unauthorized);

		const error = await fetchBlob("/api/file?preview=1").catch((err: unknown) => err);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 401, message: "this file cannot be previewed" });
		expect(unauthorized).toHaveBeenCalledTimes(1);
	});
});
