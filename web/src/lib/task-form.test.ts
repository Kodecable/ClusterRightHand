import { describe, expect, test } from "vitest";
import { buildTaskRequest, emptyForm, TaskFormError } from "./task-form";

describe("buildTaskRequest", () => {
	test("exec shell with timeout", () => {
		expect(buildTaskRequest({ ...emptyForm, command: " uname -a ", timeoutSec: "5" })).toEqual({
			kind: "exec",
			waitMs: 0,
			timeoutMs: 5000,
			shell: "uname -a",
		});
	});

	test("exec argv", () => {
		const body = buildTaskRequest({ ...emptyForm, execMode: "argv", command: 'echo "a b"' });
		expect(body.argv).toEqual(["echo", "a b"]);
	});

	test("file kinds", () => {
		// A read pages by line: the offset is a 1-based line and the limit a line count.
		expect(buildTaskRequest({ ...emptyForm, kind: "file.read", path: "/x", offset: "3", limit: "10" })).toMatchObject({
			path: "/x",
			startLine: 3,
			lineCount: 10,
		});
		expect(buildTaskRequest({ ...emptyForm, kind: "file.edit", path: "/x", oldText: "a", newText: "b" }).edits).toEqual(
			[{ oldText: "a", newText: "b" }],
		);
	});

	test("validation returns codes, not English sentences", () => {
		const code = (form: Parameters<typeof buildTaskRequest>[0]): string | undefined => {
			try {
				buildTaskRequest(form);
				return undefined;
			} catch (error) {
				expect(error).toBeInstanceOf(TaskFormError);
				return error instanceof TaskFormError ? error.code : undefined;
			}
		};
		expect(code(emptyForm)).toBe("command-required");
		expect(code({ ...emptyForm, kind: "file.stat" })).toBe("path-required");
		expect(code({ ...emptyForm, command: "x", timeoutSec: "-1" })).toBe("timeout-invalid");
		expect(code({ ...emptyForm, kind: "file.read", path: "/x", offset: "-1" })).toBe("offset-invalid");
		expect(code({ ...emptyForm, kind: "file.read", path: "/x", offset: "0" })).toBe("offset-invalid");
		expect(code({ ...emptyForm, kind: "file.read", path: "/x", limit: "1.5" })).toBe("limit-invalid");
		expect(code({ ...emptyForm, kind: "file.edit", path: "/x" })).toBe("old-text-required");
	});

	test("the privileged flag is sent only when checked, for every kind", () => {
		expect(buildTaskRequest({ ...emptyForm, command: "true" }).privileged).toBeUndefined();
		expect(buildTaskRequest({ ...emptyForm, command: "true", privileged: true })).toMatchObject({
			privileged: true,
		});
		expect(buildTaskRequest({ ...emptyForm, kind: "file.read", path: "/etc/hosts", privileged: true })).toMatchObject({
			kind: "file.read",
			privileged: true,
		});
	});
});
