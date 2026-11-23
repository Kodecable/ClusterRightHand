import { describe, expect, it } from "vitest";
import { agentsMdPromptSection } from "../src/library/agents-md.ts";

describe("agentsMdPromptSection", () => {
	it("quotes the owner's instructions after a line that puts the guide and messages first", () => {
		const section = agentsMdPromptSection({ kind: "content", text: "Always be brief.\n\n  \n" }, "user:alice");
		expect(section).toBe(
			"User instructions: the user keeps standing instructions for you in user:alice at AGENTS.md. Follow them; " +
				"the tool guide above and the user's messages in this session take precedence when they conflict.\n" +
				"<user_instructions>\nAlways be brief.\n</user_instructions>",
		);
	});

	it("names a file past the limit and how to read it, without including content", () => {
		expect(agentsMdPromptSection({ kind: "too_large", size: 40_000 }, "user:bob")).toBe(
			"User instructions: user:bob holds AGENTS.md (40000 bytes), larger than the 32 KiB that is included here. " +
				"Read it with read_file (library user:bob, path AGENTS.md) before acting, and follow it.",
		);
	});

	it("is empty when there is no instructions file", () => {
		expect(agentsMdPromptSection(undefined, "user:carol")).toBe("");
	});

	it("is empty for whitespace-only content", () => {
		expect(agentsMdPromptSection({ kind: "content", text: " \n\t\n" }, "user:dave")).toBe("");
	});
});
