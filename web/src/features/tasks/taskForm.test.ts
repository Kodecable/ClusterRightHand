import { describe, expect, test } from "vitest";
import { buildTaskRequest, emptyForm } from "./taskForm";

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
		expect(buildTaskRequest({ ...emptyForm, kind: "file.read", path: "/x", limit: "10" })).toMatchObject({
			path: "/x",
			limit: 10,
		});
		expect(buildTaskRequest({ ...emptyForm, kind: "file.edit", path: "/x", oldText: "a", newText: "b" }).edits).toEqual(
			[{ oldText: "a", newText: "b" }],
		);
	});

	test("validation", () => {
		expect(() => buildTaskRequest(emptyForm)).toThrow("command is required");
		expect(() => buildTaskRequest({ ...emptyForm, kind: "file.stat" })).toThrow("path is required");
		expect(() => buildTaskRequest({ ...emptyForm, command: "x", timeoutSec: "-1" })).toThrow("timeout");
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
