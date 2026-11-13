import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { type UploadFile, useUploadQueue } from "./use-upload-queue";

function file(name: string, size: number): File {
	return new File([new Uint8Array(size)], name);
}

describe("useUploadQueue", () => {
	test("uploads one file at a time and totals the bytes", async () => {
		let release: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			release = resolve;
		});
		const upload = vi.fn<UploadFile>(async (candidate, onProgress) => {
			if (candidate.name === "a.bin") await first;
			onProgress(candidate.size);
		});
		const { result } = renderHook(() => useUploadQueue(upload));

		act(() => result.current.start([file("a.bin", 4), file("b.bin", 6)]));
		await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
		expect(result.current.entries[0]?.status).toBe("running");
		expect(result.current.entries[1]?.status).toBe("pending");

		await act(async () => release());
		await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(result.current.running).toBe(false));
		expect(result.current.done).toBe(2);
		expect(result.current.totalFiles).toBe(2);
		expect(result.current.totalBytes).toBe(10);
		expect(result.current.loadedBytes).toBe(10);
	});

	test("records a failed file and continues with the next", async () => {
		const upload = vi.fn<UploadFile>(async (candidate) => {
			if (candidate.name === "bad.bin") throw new Error("the file is too large");
		});
		const { result } = renderHook(() => useUploadQueue(upload));
		const bad = file("bad.bin", 100);
		const good = file("good.bin", 2);

		act(() => result.current.start([bad, good]));
		await waitFor(() => expect(result.current.running).toBe(false));
		expect(upload).toHaveBeenCalledTimes(2);
		expect(result.current.done).toBe(1);
		expect(result.current.failures).toEqual([{ id: 0, file: bad, error: "the file is too large" }]);
		expect(result.current.entries[1]?.status).toBe("done");
	});

	test("cancel aborts the file in flight and the remaining files", async () => {
		const upload = vi.fn<UploadFile>(
			(_candidate, _onProgress, signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		);
		const { result } = renderHook(() => useUploadQueue(upload));

		act(() => result.current.start([file("a.bin", 1), file("b.bin", 1)]));
		await waitFor(() => expect(result.current.running).toBe(true));

		act(() => result.current.cancel());
		await waitFor(() => expect(result.current.running).toBe(false));
		expect(upload).toHaveBeenCalledTimes(1);
		expect(result.current.entries.map((entry) => entry.status)).toEqual(["canceled", "canceled"]);
		expect(result.current.done).toBe(0);
	});

	test("reports the speed and the remaining time from the processed bytes", async () => {
		let release: () => void = () => {};
		let now = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const upload = vi.fn<UploadFile>(async (_candidate, onProgress) => {
			now = 1_000;
			onProgress(4);
			await gate;
		});
		const { result } = renderHook(() => useUploadQueue(upload));

		act(() => result.current.start([file("a.bin", 10)]));
		await waitFor(() => expect(result.current.speed).toBe(4));
		expect(result.current.loadedBytes).toBe(4);
		expect(result.current.eta).toBe(1.5);

		await act(async () => release());
	});
});
