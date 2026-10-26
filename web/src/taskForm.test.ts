import { expect, test } from "vitest";
import { buildTaskRequest, emptyForm } from "./taskForm.ts";

test("exec shell with timeout", () => {
	expect(buildTaskRequest({ ...emptyForm, command: " uname -a ", timeoutSec: "5" })).toEqual({
		kind: "exec",
		waitMs: 0,
		timeoutMs: 5000,
		shell: "uname -a",
	});
});

test("exec argv", () => {
	const b = buildTaskRequest({ ...emptyForm, execMode: "argv", command: 'echo "a b"' });
	expect(b.argv).toEqual(["echo", "a b"]);
});

test("file kinds", () => {
	expect(buildTaskRequest({ ...emptyForm, kind: "file.read", path: "/x", limit: "10" })).toMatchObject({
		path: "/x",
		limit: 10,
	});
	expect(buildTaskRequest({ ...emptyForm, kind: "file.edit", path: "/x", oldText: "a", newText: "b" }).edits).toEqual([
		{ oldText: "a", newText: "b" },
	]);
});

test("validation", () => {
	expect(() => buildTaskRequest(emptyForm)).toThrow("command is required");
	expect(() => buildTaskRequest({ ...emptyForm, kind: "file.stat" })).toThrow("path is required");
	expect(() => buildTaskRequest({ ...emptyForm, command: "x", timeoutSec: "-1" })).toThrow("timeout");
});
