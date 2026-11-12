import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { UserError } from "../util/errors.ts";

/** Asks questions on one input stream; secrets are not echoed on a terminal. */
export interface Prompter {
	question(prompt: string): Promise<string>;
	secret(prompt: string): Promise<string>;
	close(): void;
}

/**
 * One readline interface for a sequence of questions. Complete lines are queued, so lines already
 * buffered on an injected stream (a test) are not lost before the next question. An injected stream
 * is not a terminal and is read without echo, like a pipe.
 */
export function createPrompter(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stderr,
): Prompter {
	let muted = false;
	const sink = new Writable({
		write(chunk, encoding, callback) {
			if (!muted) output.write(chunk, encoding);
			callback();
		},
	});
	const rl = createInterface({ input, output: sink });
	const lines: string[] = [];
	let waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
	let closed = false;
	rl.on("line", (line) => {
		if (waiter) {
			const current = waiter;
			waiter = undefined;
			current.resolve(line);
		} else {
			lines.push(line);
		}
	});
	rl.on("close", () => {
		closed = true;
		waiter?.reject(new UserError("no input on standard input: pipe the value in or run on a terminal"));
		waiter = undefined;
	});
	const next = (prompt: string, secret: boolean): Promise<string> => {
		output.write(prompt);
		if (secret) muted = true;
		return new Promise<string>((resolve, reject) => {
			const finish = (line: string): void => {
				if (secret) {
					muted = false;
					output.write("\n");
				}
				resolve(line);
			};
			const queued = lines.shift();
			if (queued !== undefined) return finish(queued);
			if (closed) {
				muted = false;
				reject(new UserError("no input on standard input: pipe the value in or run on a terminal"));
				return;
			}
			waiter = { resolve: finish, reject };
		});
	};
	return {
		question(prompt: string): Promise<string> {
			return next(prompt, false);
		},
		secret(prompt: string): Promise<string> {
			return next(prompt, true);
		},
		close(): void {
			rl.close();
		},
	};
}

/** Reads a secret without echo on a TTY; reads one line from stdin otherwise (for scripts). */
export async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin });
		for await (const line of rl) {
			rl.close();
			return line;
		}
		throw new UserError("no input on standard input: pipe the value in or run on a terminal");
	}
	const prompter = createPrompter();
	try {
		return await prompter.secret(prompt);
	} finally {
		prompter.close();
	}
}
