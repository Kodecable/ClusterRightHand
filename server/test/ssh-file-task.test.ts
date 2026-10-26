import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type SFTPWrapper } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileTaskError, runSftpFileTask } from "../src/cluster/ssh/file-task.ts";

const target = process.env.CRH_TEST_SSH;
const keyPath = process.env.CRH_TEST_SSH_KEY;

type Json = Record<string, unknown>;

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

	type Kind = "fileRead" | "fileWrite" | "fileEdit" | "fileStat" | "fileList";
	const specOf = (kind: Kind, value: object) => ({ kind: { case: kind, value } }) as never;

	async function runRaw(
		kind: Kind,
		value: object,
		input?: Uint8Array,
		signal: AbortSignal = new AbortController().signal,
	): Promise<Buffer> {
		const chunks: Uint8Array[] = [];
		await runSftpFileTask(sftp, specOf(kind, value), input, (d) => chunks.push(Buffer.from(d)), signal);
		return Buffer.concat(chunks);
	}
	const run = async (kind: Kind, value: object, input?: Uint8Array): Promise<Json> => {
		const out = await runRaw(kind, value, input);
		return out.length ? (JSON.parse(out.toString()) as Json) : {};
	};
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
		content: { size: BigInt(Buffer.byteLength(content)), sha256: createHash("sha256").update(content).digest() },
		overwrite: false,
		mode: 0,
		owner: "",
		group: "",
		...extra,
	});
	const write = (path: string, content: string, extra: object = {}) =>
		run("fileWrite", writeSpec(path, content, extra), Buffer.from(content));
	const edit = (path: string, ...pairs: string[]) => {
		const edits = [];
		for (let i = 0; i < pairs.length; i += 2) {
			edits.push({ oldText: pairs[i], newText: pairs[i + 1] });
		}
		return run("fileEdit", { path, edits });
	};
	const readSpec = (path: string, offset = 0n, limit = 0n) => ({ path, offset, limit });

	it("rejects invalid paths", async () => {
		for (const path of ["rel/path", "/a/../b", "/a//b", "/a/", ""]) {
			expect(await code(run("fileStat", { path }))).toBe("invalid_spec");
		}
	});

	it("reads ranges", async () => {
		await put("r", "0123456789");
		const read = async (off: bigint, lim: bigint) => (await runRaw("fileRead", readSpec(p("r"), off, lim))).toString();
		expect(await read(0n, 0n)).toBe("0123456789");
		expect(await read(3n, 4n)).toBe("3456");
		expect(await read(8n, 100n)).toBe("89");
		expect(await read(20n, 0n)).toBe("");
		expect(await code(run("fileRead", readSpec(dir)))).toBe("is_directory");
		expect(await code(run("fileRead", readSpec(p("nope"))))).toBe("not_found");
	});

	it("reads large files in chunks", async () => {
		await exec(`head -c 200000 /dev/zero | tr '\\0' 'a' > ${p("big")}`);
		const out = await runRaw("fileRead", readSpec(p("big")));
		expect(out.length).toBe(200000);
		expect((await runRaw("fileRead", readSpec(p("big"), 199990n, 50n))).length).toBe(10);
	});

	it("honours cancellation", async () => {
		await put("c", "x");
		const ac = new AbortController();
		ac.abort();
		expect(await code(runRaw("fileRead", readSpec(p("c")), undefined, ac.signal))).toBe("cancelled");
	});

	it("creates files", async () => {
		const out = await write(p("new"), "hello");
		expect(out).toEqual({ bytes: 5, created: true });
		expect(await cat("new")).toBe("hello");
		expect(await modeOf("new")).toBe("644");
		await noTemps();
	});

	it("writes large content", async () => {
		const content = "x".repeat(1_000_000);
		await write(p("large"), content);
		expect((await exec(`wc -c < ${p("large")}`)).trim()).toBe("1000000");
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
		const out = await write(p("o"), "new", { overwrite: true });
		expect(out.created).toBe(false);
		expect(await cat("o")).toBe("new");
		expect(await modeOf("o")).toBe("640");
		await noTemps();
	});

	it("detects input mismatch", async () => {
		const spec = writeSpec(p("mm"), "hello");
		for (const input of ["hel", "hello!!"]) {
			expect(await code(run("fileWrite", spec, Buffer.from(input)))).toBe("input_mismatch");
		}
		expect((await sh("ls mm 2>&1 || true")).includes("No such file")).toBe(true);
		await noTemps();
	});

	it("reports write errors", async () => {
		expect(await code(write(p("missing/f"), "x"))).toBe("not_found");
		expect(await code(write(dir, "x", { overwrite: true }))).toBe("is_directory");
		expect(await code(write(p("f"), "x", { owner: "root" }))).toBe("invalid_spec");
		expect(await code(write(p("f"), "x", { group: "root" }))).toBe("invalid_spec");
		expect(await code(run("fileWrite", { ...writeSpec(p("f"), "x"), content: undefined }))).toBe("invalid_spec");
		await noTemps();
	});

	it("edits files", async () => {
		await put("ed", "alpha\nbeta\ngamma\n", "750");
		expect(await edit(p("ed"), "gamma", "GAMMA", "alpha", "ALPHA")).toEqual({ replacements: 2 });
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
		const out = await run("fileStat", { path: p("s") });
		expect(out).toMatchObject({ type: "file", size: 3, mode: "0640", path: p("s"), owner: "", group: "" });
		expect(out.mtime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		expect("link_target" in out).toBe(false);
		expect((await run("fileStat", { path: dir })).type).toBe("dir");
		await sh("ln -s /nonexistent/target sl");
		expect(await run("fileStat", { path: p("sl") })).toMatchObject({
			type: "symlink",
			link_target: "/nonexistent/target",
		});
		expect(await code(run("fileStat", { path: p("nope") }))).toBe("not_found");
	});

	it("lists directories", async () => {
		const ld = p("ls");
		await exec(`mkdir ${ld} && cd ${ld} && for n in c a b d; do printf $n > $n; done && mkdir sub && ln -s a ln`);
		const names = (o: Json) => (o.entries as { name: string }[]).map((e) => e.name);
		const out = await run("fileList", { path: ld, limit: 0 });
		expect(names(out)).toEqual(["a", "b", "c", "d", "ln", "sub"]);
		expect(out.truncated).toBe(false);
		const types = Object.fromEntries((out.entries as { name: string; type: string }[]).map((e) => [e.name, e.type]));
		expect(types).toMatchObject({ a: "file", sub: "dir", ln: "symlink" });
		const small = await run("fileList", { path: ld, limit: 2 });
		expect(names(small)).toEqual(["a", "b"]);
		expect(small.truncated).toBe(true);
		expect((await run("fileList", { path: ld, limit: 6 })).truncated).toBe(false);
		expect(await code(run("fileList", { path: `${ld}/a` }))).toBe("not_a_directory");
		expect(await code(run("fileList", { path: `${ld}/nope` }))).toBe("not_found");
	});

	it("lists empty directories", async () => {
		await sh("mkdir empty");
		expect(await run("fileList", { path: p("empty"), limit: 0 })).toEqual({ entries: [], truncated: false });
	});

	it("maps permission errors", async () => {
		await sh("mkdir ro && chmod 555 ro");
		expect(await code(write(p("ro/f"), "x"))).toBe("permission_denied");
	});
});
