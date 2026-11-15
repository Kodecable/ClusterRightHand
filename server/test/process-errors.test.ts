import { describe, expect, it } from "vitest";
import {
	installProcessErrorHandlers,
	lastUnexpectedError,
	recordUnexpectedError,
	unexpectedErrorCount,
} from "../src/util/process-errors.ts";

describe("unexpected error accounting", () => {
	it("counts errors and keeps the latest message and time", () => {
		const before = unexpectedErrorCount();
		recordUnexpectedError(new Error("first"));
		recordUnexpectedError("second");
		expect(unexpectedErrorCount()).toBe(before + 2);
		const last = lastUnexpectedError();
		expect(last?.message).toBe("second");
		expect(last?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});

describe("process error handler installation", () => {
	it("registers each handler once, however often it is called", () => {
		const rejections = process.listenerCount("unhandledRejection");
		const exceptions = process.listenerCount("uncaughtException");
		installProcessErrorHandlers();
		installProcessErrorHandlers();
		installProcessErrorHandlers();
		expect(process.listenerCount("unhandledRejection")).toBe(rejections + 1);
		expect(process.listenerCount("uncaughtException")).toBe(exceptions + 1);
	});
});
