import { describe, expect, it } from "vitest";
import { senderTimeZone, sentTimeText, validTimeZone, withSentTime } from "../src/agent/sent-time.ts";

describe("sent time", () => {
	const at = new Date("2026-11-19T11:30:00.000Z");

	it("names the local time, weekday, zone, offset and whose zone it is", () => {
		expect(sentTimeText(at, { zone: "Asia/Shanghai", source: "user" })).toBe(
			"[Sent 2026-11-19 19:30, Thursday, Asia/Shanghai (UTC+08:00), the user's time zone]",
		);
		expect(sentTimeText(at, { zone: "UTC", source: "server" })).toBe(
			"[Sent 2026-11-19 11:30, Thursday, UTC (UTC+00:00), the server's time zone]",
		);
		expect(sentTimeText(at, { zone: "America/St_Johns", source: "schedule" })).toBe(
			"[Sent 2026-11-19 08:00, Thursday, America/St_Johns (UTC-03:30), the schedule's time zone]",
		);
	});

	it("accepts only time zones the runtime knows and falls back to the server's", () => {
		expect(validTimeZone("asia/shanghai")).toBe("Asia/Shanghai");
		for (const bad of ["", "Not/A_Zone", "x".repeat(65), 8, null, undefined]) expect(validTimeZone(bad)).toBeNull();
		expect(senderTimeZone("Europe/Berlin")).toEqual({ zone: "Europe/Berlin", source: "user" });
		expect(senderTimeZone("Not/A_Zone").source).toBe("server");
		expect(senderTimeZone(undefined).source).toBe("server");
	});

	it("keeps the typed text and attachment blocks first and the sent time last", () => {
		const zone = { zone: "UTC", source: "server" } as const;
		expect(withSentTime("hi", at, zone)).toEqual([
			{ type: "text", text: "hi" },
			{ type: "text", text: sentTimeText(at, zone) },
		]);
		expect(
			withSentTime(
				[
					{ type: "text", text: "typed" },
					{ type: "text", text: "note" },
				],
				at,
				zone,
			).map((block) => block.text),
		).toEqual(["typed", "note", sentTimeText(at, zone)]);
	});
});
