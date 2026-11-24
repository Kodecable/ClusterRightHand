/**
 * The names crhs knows for each open name and union are the ones crha knows: both compare their lists with
 * test/interop/known_names.json.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TASK_SPEC_KINDS } from "../src/messages.ts";
import { KNOWN_CAPABILITIES, KNOWN_MATCHES, KNOWN_METHODS, KNOWN_ROLES } from "../src/privileged.ts";
import { COMMANDS, EVENTS } from "../src/registry.ts";

const fixture = JSON.parse(
	readFileSync(new URL("../../../test/interop/known_names.json", import.meta.url), "utf8"),
) as Record<"methods" | "matches" | "roles" | "capabilities" | "task_kinds" | "commands" | "events", string[]>;

describe("known names", () => {
	it("agree with crha", () => {
		expect([...KNOWN_METHODS]).toEqual(fixture.methods);
		expect([...KNOWN_MATCHES]).toEqual(fixture.matches);
		expect([...KNOWN_ROLES]).toEqual(fixture.roles);
		expect([...KNOWN_CAPABILITIES]).toEqual(fixture.capabilities);
		expect([...TASK_SPEC_KINDS]).toEqual(fixture.task_kinds);
		expect(Object.keys(COMMANDS).sort()).toEqual(fixture.commands);
		expect(Object.keys(EVENTS).sort()).toEqual(fixture.events);
	});
});
