import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Reads a secret without echo on a TTY; reads one line from stdin otherwise (for scripts). */
export async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin });
		for await (const line of rl) {
			rl.close();
			return line;
		}
		throw new Error("no input on stdin");
	}
	let muted = false;
	const output = new Writable({
		write(chunk, encoding, callback) {
			if (!muted) process.stderr.write(chunk, encoding);
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	try {
		return await new Promise<string>((resolve) => {
			rl.question(prompt, resolve);
			muted = true;
		});
	} finally {
		rl.close();
		process.stderr.write("\n");
	}
}
