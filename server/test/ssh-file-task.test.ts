import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FileListResult, FileStatResult, TaskResult, TaskSpec } from "@crh/protocol";
import { Client, type SFTPWrapper } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileTaskError, runSftpFileTask } from "../src/cluster/ssh/file-task.ts";

const target = process.env.CRH_TEST_SSH;
const keyPath = process.env.CRH_TEST_SSH_KEY;

describe.skipIf(!target || !keyPath)("ssh file tasks over SFTP", () => {
	const client = new Client();
	let sftp: SFTPWrapper;
	let dir = "";

	const exec = (cmd: string): Promise<string> =>
		new Promise((resolve, reject) => {
			client.exec(cmd, (err, stream) => {
				if (err) {
					return reject(err);
				}
				let out = "";
				stream.on("data", (d: Buffer) => {
					out += d.toString();
				});
				stream.stderr.on("data", (d: Buffer) => {
					out += d.toString();
				});
				stream.on("close", () => resolve(out));
			});
		});

	beforeAll(async () => {
		const m = /^(.+)@(.+):(\d+)$/.exec(target ?? "");
		if (!m) {
			throw new Error("CRH_TEST_SSH must be user@host:port");
		}
		await new Promise<void>((resolve, reject) => {
			client.on("ready", resolve).on("error", reject);
			client.connect({
				host: m[2],
				port: Number(m[3]),
				username: m[1],
				privateKey: readFileSync(keyPath ?? ""),
				hostVerifier: () => true,
			});
		});
		sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
			client.sftp((err, s) => (err ? reject(err) : resolve(s)));
		});
		dir = `/tmp/crh-${randomBytes(6).toString("hex")}`;
		await exec(`mkdir -m 755 ${dir}`);
	});

	afterAll(async () => {
		if (dir) {
			await exec(`rm -rf ${dir}`);
		}
		client.end();
	});

	// Remote shell helpers.
	const sh = (cmd: string) => exec(`cd ${dir} && ${cmd}`);
	const cat = (name: string) => exec(`cat ${dir}/${name}`);
	const modeOf = async (name: string) => (await exec(`stat -c %a ${dir}/${name}`)).trim();
	const put = async (name: string, content: string, mode = "644") => {
		await exec(`printf %s '${content.replaceAll("'", "'\\''")}' > ${dir}/${name} && chmod ${mode} ${dir}/${name}`);
	};
	const noTemps = async () => {
		expect((await sh("ls -A | grep -F .crh- || true")).trim()).toBe("");
	};
	const p = (name: string) => `${dir}/${name}`;

	type Kind = "file.read" | "file.write" | "file.edit" | "file.stat" | "file.list";
	const specOf = (kind: Kind, value: object) => ({ kind, ...value }) as TaskSpec;

	/** Runs one file task; its structured result and its text output (the page of a file.read). */
	async function runTask(
		kind: Kind,
		value: object,
		input?: Uint8Array,
		signal: AbortSignal = new AbortController().signal,
	): Promise<{ result: TaskResult; stdout: Buffer }> {
		const out: Uint8Array[] = [];
		const result = await runSftpFileTask(sftp, specOf(kind, value), input, (d) => out.push(Buffer.from(d)), signal);
		return { result, stdout: Buffer.concat(out) };
	}
	async function runRaw(
		kind: Kind,
		value: object,
		input?: Uint8Array,
		signal: AbortSignal = new AbortController().signal,
	): Promise<Buffer> {
		return (await runTask(kind, value, input, signal)).stdout;
	}
	const run = async (kind: Kind, value: object, input?: Uint8Array): Promise<TaskResult> => {
		return (await runTask(kind, value, input)).result;
	};
	/** The result of a task, checked to be the branch its kind reports. */
	function of<K extends TaskResult["kind"]>(result: TaskResult, kind: K): Extract<TaskResult, { kind: K }> {
		if (result.kind !== kind) throw new Error(`task result is ${result.kind}, want ${kind}`);
		return result as Extract<TaskResult, { kind: K }>;
	}
	async function code(promise: Promise<unknown>): Promise<string> {
		try {
			await promise;
		} catch (e) {
			expect(e).toBeInstanceOf(FileTaskError);
			return (e as FileTaskError).code;
		}
		return "";
	}

	const writeSpec = (path: string, content: string, extra: object = {}) => ({
		path,
		content: { size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest() },
		overwrite: false,
		mode: 0,
		owner: "",
		group: "",
		createParentDirs: false,
		...extra,
	});
	const write = (path: string, content: string, extra: object = {}) =>
		run("file.write", writeSpec(path, content, extra), Buffer.from(content));
	const edit = (path: string, ...pairs: string[]) => {
		const edits = [];
		for (let i = 0; i < pairs.length; i += 2) {
			edits.push({ oldText: pairs[i], newText: pairs[i + 1] });
		}
		return run("file.edit", { path, edits });
	};
	const readSpec = (path: string, startLine = 1, lineCount = 2000) => ({ path, startLine, lineCount });
	/** Runs one file.read and returns the page as text and its result. */
	const read = async (path: string, startLine = 1, lineCount = 2000) => {
		const { result, stdout } = await runTask("file.read", readSpec(path, startLine, lineCount));
		return { page: stdout.toString(), result: of(result, "file.read") };
	};

	it("rejects invalid paths", async () => {
		for (const path of ["rel/path", "/a/../b", "/a//b", "/a/", ""]) {
			expect(await code(run("file.stat", { path }))).toBe("invalid_spec");
		}
	});

	it("pages by lines", async () => {
		await exec(`printf 'one\\ntwo\\nthree\\nfour\\n' > ${p("r")}`);
		expect(await read(p("r"), 1, 2)).toEqual({
			page: "one\ntwo\n",
			result: { kind: "file.read", from: 1, to: 2, eof: false, total: null, tooLong: false },
		});
		expect(await read(p("r"), 3, 10)).toEqual({
			page: "three\nfour\n",
			result: { kind: "file.read", from: 3, to: 4, eof: true, total: 4, tooLong: false },
		});
		// A start line past the end reports the line count the scan found.
		expect(await read(p("r"), 9, 1)).toEqual({
			page: "",
			result: { kind: "file.read", from: 0, to: 0, eof: true, total: 4, tooLong: false },
		});
		expect(await code(run("file.read", readSpec(dir)))).toBe("is_directory");
		expect(await code(run("file.read", readSpec(p("nope"))))).toBe("not_found");
	});

	it("stops a page at the byte cap, whole lines only", async () => {
		await exec(`awk 'BEGIN{for(i=0;i<2000;i++)printf "%0999d\\n", i}' > ${p("lines")}`);
		const { page, result } = await read(p("lines"), 1, 2000);
		expect(Buffer.byteLength(page)).toBe(51 * 1000);
		expect(result).toEqual({ kind: "file.read", from: 1, to: 51, eof: false, total: null, tooLong: false });
	});

	it("honours cancellation", async () => {
		await put("c", "x");
		const ac = new AbortController();
		ac.abort();
		expect(await code(runRaw("file.read", readSpec(p("c")), undefined, ac.signal))).toBe("cancelled");
	});

	it("creates files", async () => {
		const out = await write(p("new"), "hello");
		expect(out).toEqual({ kind: "file.write", bytes: 5, created: true });
		expect(await cat("new")).toBe("hello");
		expect(await modeOf("new")).toBe("644");
		await noTemps();
	});

	it("writes large content", async () => {
		const content = "x".repeat(1_000_000);
		await write(p("large"), content);
		expect((await exec(`wc -c < ${p("large")}`)).trim()).toBe("1000000");
	});

	it("creates missing parent directories with createParentDirs", async () => {
		const file = p("a/b/c/f");
		const out = await write(file, "hello", { createParentDirs: true });
		expect(out).toEqual({ kind: "file.write", bytes: 5, created: true });
		expect(await cat("a/b/c/f")).toBe("hello");
		// New directories are 0755 before the remote umask, like mkdir -p (D114).
		expect(await modeOf("a")).toBe("755");
		expect(await modeOf("a/b")).toBe("755");
		expect(await modeOf("a/b/c")).toBe("755");
		await noTemps();
	});

	it("keeps an existing parent directory's mode", async () => {
		await exec(`mkdir -m 700 ${p("keep")}`);
		await write(p("keep/deep/f"), "x", { createParentDirs: true });
		expect(await cat("keep/deep/f")).toBe("x");
		expect(await modeOf("keep")).toBe("700");
	});

	it("still reports a missing parent without createParentDirs", async () => {
		expect(await code(write(p("missing/deep/f"), "x"))).toBe("not_found");
	});

	it("refuses a parent path that is a file", async () => {
		await put("plain", "x");
		expect(await code(write(p("plain/f"), "x", { createParentDirs: true }))).toBe("not_found");
	});

	it("uses an explicit mode", async () => {
		await write(p("m"), "x", { mode: 0o600 });
		expect(await modeOf("m")).toBe("600");
	});

	it("fails with exists unless overwrite", async () => {
		await put("e", "old");
		expect(await code(write(p("e"), "new"))).toBe("exists");
		expect(await cat("e")).toBe("old");
		await noTemps();
	});

	it("overwrites keeping mode", async () => {
		await put("o", "old", "640");
		const out = of(await write(p("o"), "new", { overwrite: true }), "file.write");
		expect(out.created).toBe(false);
		expect(await cat("o")).toBe("new");
		expect(await modeOf("o")).toBe("640");
		await noTemps();
	});

	it("detects input mismatch", async () => {
		const spec = writeSpec(p("mm"), "hello");
		for (const input of ["hel", "hello!!"]) {
			expect(await code(run("file.write", spec, Buffer.from(input)))).toBe("input_mismatch");
		}
		expect((await sh("ls mm 2>&1 || true")).includes("No such file")).toBe(true);
		await noTemps();
	});

	it("reports write errors", async () => {
		expect(await code(write(p("missing/f"), "x"))).toBe("not_found");
		expect(await code(write(dir, "x", { overwrite: true }))).toBe("is_directory");
		expect(await code(write(p("f"), "x", { owner: "root" }))).toBe("invalid_spec");
		expect(await code(write(p("f"), "x", { group: "root" }))).toBe("invalid_spec");
		expect(await code(run("file.write", { ...writeSpec(p("f"), "x"), content: undefined }))).toBe("invalid_spec");
		await noTemps();
	});

	it("edits files", async () => {
		await put("ed", "alpha\nbeta\ngamma\n", "750");
		expect(await edit(p("ed"), "gamma", "GAMMA", "alpha", "ALPHA")).toEqual({ kind: "file.edit", replacements: 2 });
		expect(await cat("ed")).toBe("ALPHA\nbeta\nGAMMA\n");
		expect(await modeOf("ed")).toBe("750");
		await noTemps();
	});

	it("matches edits against the original", async () => {
		await put("ao", "a b\n");
		expect(await code(edit(p("ao"), "a", "b", "x", "y"))).toBe("edit_no_match");
		await edit(p("ao"), "a", "b", "b", "a");
		expect(await cat("ao")).toBe("b a\n");
	});

	it("preserves CRLF and BOM", async () => {
		await exec(`printf 'one\\r\\ntwo\\r\\nthree\\r\\n' > ${p("crlf")}`);
		await edit(p("crlf"), "one\ntwo", "1\n2\n2.5");
		expect(await cat("crlf")).toBe("1\r\n2\r\n2.5\r\nthree\r\n");
		await exec(`printf '\\xEF\\xBB\\xBFhello\\n' > ${p("bom")}`);
		await edit(p("bom"), "hello", "bye");
		expect(await cat("bom")).toBe("\uFEFFbye\n");
	});

	it("reports edit errors", async () => {
		await put("ee", "foo bar foo\nbaz\n");
		expect(await code(edit(p("ee"), "nothing", "x"))).toBe("edit_no_match");
		expect(await code(edit(p("ee"), "foo", "x"))).toBe("edit_ambiguous");
		expect(await code(edit(p("ee"), "bar foo", "x", "foo bar", "y"))).toBe("edit_overlap");
		expect(await code(edit(p("ee"), "", "x"))).toBe("invalid_spec");
		expect(await code(edit(p("ee")))).toBe("invalid_spec");
		expect(await code(edit(p("ee"), "baz", "baz"))).toBe("edit_no_change");
		expect(await code(edit(p("missing"), "a", "b"))).toBe("not_found");
		expect(await code(edit(dir, "a", "b"))).toBe("is_directory");
		expect(await cat("ee")).toBe("foo bar foo\nbaz\n");
		await noTemps();
		expect(await code(edit(p("ee"), "bar", "x", "foo bar foo", "y"))).toBe("edit_overlap");
	});

	it("rejects too large edits", async () => {
		await exec(`truncate -s 16777217 ${p("huge")}`);
		expect(await code(edit(p("huge"), "a", "b"))).toBe("too_large");
	});

	it("stats files, dirs and symlinks", async () => {
		await put("s", "abc", "640");
		const out: FileStatResult = of(await run("file.stat", { path: p("s") }), "file.stat");
		expect(out).toMatchObject({ type: "file", size: 3, mode: "0640", path: p("s"), owner: "", group: "" });
		expect(out.mtime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		expect(out.linkTarget).toBeNull();
		expect(of(await run("file.stat", { path: dir }), "file.stat").type).toBe("dir");
		await sh("ln -s /nonexistent/target sl");
		expect(await run("file.stat", { path: p("sl") })).toMatchObject({
			type: "symlink",
			linkTarget: "/nonexistent/target",
		});
		expect(await code(run("file.stat", { path: p("nope") }))).toBe("not_found");
	});

	it("lists directories", async () => {
		const ld = p("ls");
		await exec(`mkdir ${ld} && cd ${ld} && for n in c a b d; do printf $n > $n; done && mkdir sub && ln -s a ln`);
		const list = async (value: object): Promise<FileListResult> => of(await run("file.list", value), "file.list");
		const names = (l: FileListResult) => l.entries.map((e) => e.name);
		const out = await list({ path: ld, limit: 0 });
		expect(names(out)).toEqual(["a", "b", "c", "d", "ln", "sub"]);
		expect(out.truncated).toBe(false);
		const types = Object.fromEntries(out.entries.map((e) => [e.name, e.type]));
		expect(types).toMatchObject({ a: "file", sub: "dir", ln: "symlink" });
		const small = await list({ path: ld, limit: 2 });
		expect(names(small)).toEqual(["a", "b"]);
		expect(small.truncated).toBe(true);
		expect((await list({ path: ld, limit: 6 })).truncated).toBe(false);
		expect(await code(run("file.list", { path: `${ld}/a` }))).toBe("not_a_directory");
		expect(await code(run("file.list", { path: `${ld}/nope` }))).toBe("not_found");
	});

	it("lists empty directories", async () => {
		await sh("mkdir empty");
		expect(await run("file.list", { path: p("empty"), limit: 0 })).toEqual({
			kind: "file.list",
			entries: [],
			truncated: false,
		});
	});

	it("maps permission errors", async () => {
		await sh("mkdir ro && chmod 555 ro");
		expect(await code(write(p("ro/f"), "x"))).toBe("permission_denied");
	});
});
