import { PassThrough, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createPrompter, PromptInterrupted } from "../src/cli/prompt.ts";

/** A stream that looks like a terminal to readline: it puts it in raw mode and reads keys. */
function fakeTerminal(): PassThrough & { isTTY: boolean; setRawMode: (raw: boolean) => void; raw: boolean } {
	const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (raw: boolean) => void; raw: boolean };
	input.isTTY = true;
	input.raw = false;
	input.setRawMode = (raw: boolean) => {
		input.raw = raw;
	};
	return input;
}

function capture(): { stream: Writable; text: () => string } {
	let text = "";
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			text += chunk.toString();
			callback();
		},
	});
	return { stream, text: () => text };
}

describe("createPrompter on a terminal", () => {
	test("reads in raw mode and does not show a secret", async () => {
		const input = fakeTerminal();
		const output = capture();
		const prompter = createPrompter(input, output.stream);
		expect(input.raw).toBe(true);
		const answer = prompter.secret("Password: ");
		input.write("hunter2\r");
		await expect(answer).resolves.toBe("hunter2");
		expect(output.text()).toContain("Password: ");
		expect(output.text()).not.toContain("hunter2");
		const name = prompter.question("Name: ");
		input.write("alice\r");
		await expect(name).resolves.toBe("alice");
		expect(output.text()).toContain("alice");
		prompter.close();
		expect(input.raw).toBe(false);
	});

	test("Ctrl+C interrupts the question and every later one", async () => {
		const input = fakeTerminal();
		const prompter = createPrompter(input, capture().stream);
		const answer = prompter.question("Listen address: ");
		input.write("\x03");
		await expect(answer).rejects.toBeInstanceOf(PromptInterrupted);
		await expect(prompter.question("Listen port: ")).rejects.toBeInstanceOf(PromptInterrupted);
		expect(input.raw).toBe(false);
	});

	test("Ctrl+D on an empty line interrupts the question", async () => {
		const input = fakeTerminal();
		const prompter = createPrompter(input, capture().stream);
		const answer = prompter.secret("Password: ");
		input.write("\x04");
		await expect(answer).rejects.toBeInstanceOf(PromptInterrupted);
	});
});
