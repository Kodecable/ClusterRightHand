import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { UserError } from "../util/errors.ts";

/** Asks questions on one input stream; secrets are not echoed on a terminal. */
export interface Prompter {
	question(prompt: string): Promise<string>;
	secret(prompt: string): Promise<string>;
	close(): void;
}

/** Ctrl+C (or Ctrl+D on an empty line) at a terminal question; the command exits with status 130. */
export class PromptInterrupted extends UserError {
	constructor() {
		super("interrupted");
	}
}

/** The exit status of a command stopped by Ctrl+C, as a shell reports a SIGINT. */
export const INTERRUPTED_EXIT_CODE = 130;

const NO_INPUT = "no input on standard input: pipe the value in or run on a terminal";

/**
 * One readline interface for a sequence of questions. Complete lines are queued, so lines already
 * buffered on an injected stream (a test) are not lost before the next question. An injected stream
 * is not a terminal and is read without echo, like a pipe.
 *
 * On a terminal, readline runs in terminal mode: the input is in raw mode, so the terminal itself
 * does not echo (readline echoes through the muted sink, which hides secrets) and Ctrl+C reaches
 * readline as a key rather than as a SIGINT. The latter matters in a container, where crhs is PID 1
 * and the kernel drops a SIGINT that has no handler.
 */
export function createPrompter(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stderr,
): Prompter {
	const terminal = Boolean((input as { isTTY?: boolean }).isTTY);
	let muted = false;
	const sink = new Writable({
		write(chunk, encoding, callback) {
			if (!muted) output.write(chunk, encoding);
			callback();
		},
	});
	// readline wraps and redraws the line by the output's width.
	Object.defineProperty(sink, "columns", { get: () => (output as { columns?: number }).columns });
	const rl = createInterface({ input, output: sink, terminal, historySize: 0 });
	const lines: string[] = [];
	let waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
	let failure: Error | undefined;
	let closed = false;
	const fail = (error: Error): void => {
		failure ??= error;
		muted = false;
		waiter?.reject(failure);
		waiter = undefined;
	};
	rl.on("line", (line) => {
		if (waiter) {
			const current = waiter;
			waiter = undefined;
			current.resolve(line);
		} else {
			lines.push(line);
		}
	});
	rl.on("SIGINT", () => {
		muted = false;
		output.write("\n");
		fail(new PromptInterrupted());
		rl.close();
	});
	rl.on("close", () => {
		closed = true;
		fail(terminal ? new PromptInterrupted() : new UserError(NO_INPUT));
	});
	const next = (prompt: string, secret: boolean): Promise<string> => {
		if (closed) {
			// Lines queued before the input ended are still answered; readline refuses a closed prompt.
			output.write(prompt);
		} else {
			rl.setPrompt(prompt);
			rl.prompt();
		}
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
			if (failure) {
				muted = false;
				reject(failure);
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
		throw new UserError(NO_INPUT);
	}
	const prompter = createPrompter();
	try {
		return await prompter.secret(prompt);
	} finally {
		prompter.close();
	}
}
