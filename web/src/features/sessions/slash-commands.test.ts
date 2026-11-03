import { describe, expect, test } from "vitest";
import { parseSlashCommand, SLASH_COMMANDS, slashSuggestions } from "./slash-commands";

describe("parseSlashCommand", () => {
	test("parses a command without arguments", () => {
		const parsed = parseSlashCommand("/compact");
		expect(parsed?.command.name).toBe("compact");
		expect(parsed?.args).toBe("");
	});

	test("parses and trims the arguments on the same line", () => {
		const parsed = parseSlashCommand("/compact keep node names");
		expect(parsed?.command.name).toBe("compact");
		expect(parsed?.args).toBe("keep node names");
	});

	test("keeps line breaks between arguments", () => {
		expect(parseSlashCommand("/compact keep\nnode names")?.args).toBe("keep\nnode names");
	});

	test("trims the whole draft before parsing", () => {
		expect(parseSlashCommand("  /compact   keep x  ")?.args).toBe("keep x");
	});

	test("an exact name is required", () => {
		expect(parseSlashCommand("/compactor")).toBeUndefined();
		expect(parseSlashCommand("/compacted keep x")).toBeUndefined();
		expect(parseSlashCommand("/compact/foo")).toBeUndefined();
	});

	test("a plain message is not a command", () => {
		expect(parseSlashCommand("")).toBeUndefined();
		expect(parseSlashCommand("compact")).toBeUndefined();
		expect(parseSlashCommand("/")).toBeUndefined();
		expect(parseSlashCommand("/ compact")).toBeUndefined();
	});
});

describe("slashSuggestions", () => {
	test("a lone slash lists every command", () => {
		expect(slashSuggestions("/").map((command) => command.name)).toEqual(SLASH_COMMANDS.map((command) => command.name));
	});

	test("narrows by the typed prefix", () => {
		expect(slashSuggestions("/co").map((command) => command.name)).toEqual(["compact"]);
		expect(slashSuggestions("/compact").map((command) => command.name)).toEqual(["compact"]);
	});

	test("an unknown token has no suggestions", () => {
		expect(slashSuggestions("/x")).toEqual([]);
		expect(slashSuggestions("/compactor")).toEqual([]);
	});

	test("whitespace ends completion", () => {
		expect(slashSuggestions("/compact ")).toEqual([]);
		expect(slashSuggestions("/compact keep x")).toEqual([]);
		expect(slashSuggestions(" /")).toEqual([]);
		expect(slashSuggestions("")).toEqual([]);
	});
});
