import { describe, expect, test } from "vitest";
import { actorLabel } from "./approval-rules";

describe("actorLabel", () => {
	test("resolves API token names", () => {
		const names = new Map([["t1", "deploy bot"]]);
		expect(actorLabel("api_token", "t1", names)).toBe("API token deploy bot");
		expect(actorLabel("api_token", "missing", names)).toBe("API token missing");
		expect(actorLabel("user", "u1", names)).toBe("user u1");
	});
});
