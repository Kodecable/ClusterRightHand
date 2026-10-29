import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCrha, Env, goAvailable, pkill, runCrha, waitFor } from "./harness.ts";

const hasGo = await goAvailable();

describe.skipIf(!hasGo)("crha end-to-end against in-process crhs", () => {
	let tmp = "";
	let bin = "";

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-e2e-"));
		bin = await buildCrha(tmp);
	}, 180_000);

	afterAll(async () => {
		await pkill("sleep 31.");
		await rm(tmp, { recursive: true, force: true });
	});

	describe("with a connected node", () => {
		let env: Env;
		beforeAll(async () => {
			env = await Env.create(bin, tmp);
			await env.bringUp();
		}, 60_000);
		afterAll(async () => {
			if (env) await env.destroy();
		});

		const run = (body: Record<string, unknown>, waitMs?: number) => env.crhs.runTask(env.nodeId, body, waitMs);

		// Reports crha's log if something fails.
		const withLog = async <T>(fn: () => Promise<T>): Promise<T> => {
			try {
				return await fn();
			} catch (err) {
				(err as Error).message += `\n--- crha log ---\n${env.crhaLog}`;
				throw err;
			}
		};

		it("rejects a reused token and a token with a wrong fingerprint", async () => {
			// Each extra node gets its own config and state dir (a minimal config would default to /var/lib).
			const extra = async (name: string) => {
				const dir = join(env.dir, name);
				await mkdir(dir, { recursive: true });
				const cfg = join(dir, "crha.toml");
				await writeFile(cfg, `server = "${env.crhs.url}"\nstate_dir = "${join(dir, "state")}"\n`);
				return { cfg, state: join(dir, "state") };
			};
			const token = await env.crhs.enrollmentToken();
			const a = await extra("second");
			const first = await runCrha(env.bin, ["enroll", "--config", a.cfg, env.crhs.url, token]);
			expect(first.stdout + first.stderr).toContain("waiting for approval");
			expect(first.code).toBe(0);

			const b = await extra("third");
			const second = await runCrha(env.bin, ["enroll", "--config", b.cfg, env.crhs.url, token]);
			expect(second.code).not.toBe(0);
			expect(second.stdout + second.stderr).toContain("invalid, expired or already used");
			expect(existsSync(b.state)).toBe(false);

			// Wrong fingerprint: rejected from /agent/identity before the agent endpoint is contacted,
			// so the token's secret stays usable.
			const fresh = await env.crhs.enrollmentToken();
			const secret = fresh.split(".")[2];
			const c = await extra("fourth");
			const bad = await runCrha(env.bin, [
				"enroll",
				"--config",
				c.cfg,
				env.crhs.url,
				`crh1.${"A".repeat(43)}.${secret}`,
			]);
			expect(bad.code).not.toBe(0);
			expect(bad.stdout + bad.stderr).toMatch(/does not match the token/);
			expect(existsSync(c.state)).toBe(false);
			const good = await runCrha(env.bin, ["enroll", "--config", c.cfg, env.crhs.url, fresh]);
			expect(good.code).toBe(0);
		}, 60_000);

		it("exec: exit code, stdout, stderr, stdin, env, cwd", () =>
			withLog(async () => {
				const t = await run({ kind: "exec", shell: "echo hello; echo oops >&2; exit 3" });
				expect(t).toMatchObject({ state: "exited", exitCode: 3, signal: null });
				expect(t.stdoutTail).toBe("hello\n");
				expect(t.stderrTail).toBe("oops\n");

				const stdin = await run({ kind: "exec", argv: ["cat"], stdin: "from stdin" });
				expect(stdin).toMatchObject({ state: "exited", exitCode: 0 });
				expect(stdin.stdoutTail).toBe("from stdin");

				const e = await run({ kind: "exec", shell: 'printf %s "$FOO"', env: { FOO: "bar baz" } });
				expect(e.stdoutTail).toBe("bar baz");

				const cwd = await mkdtemp(join(tmp, "cwd-"));
				const c = await run({ kind: "exec", argv: ["pwd"], cwd });
				expect(c.stdoutTail.trim()).toBe(cwd);
			}));

		it(
			"reload: new groups reach crhs; an invalid file keeps the running config",
			() =>
				withLog(async () => {
					const original = await readFile(env.configPath, "utf8");
					const groupsOf = async () =>
						(
							await env.crhs.db
								.selectFrom("node_groups")
								.select("group_name")
								.where("node_id", "=", env.nodeId)
								.execute()
						)
							.map((g) => g.group_name)
							.sort();
					try {
						await writeFile(env.configPath, `${original}groups = ["web", "prod"]\n`);
						expect((await runCrha(env.bin, ["reload", "--config", env.configPath])).code).toBe(0);
						await waitFor("groups reported", async () => (await groupsOf()).join(",") === "prod,web", 10_000);

						await writeFile(env.configPath, `${original}groups = ["web"]\nbogus = 1\n`);
						// `crha reload` validates first and refuses to signal with a broken file…
						const refused = await runCrha(env.bin, ["reload", "--config", env.configPath]);
						expect(refused.code).not.toBe(0);
						expect(refused.stderr).toMatch(/bogus/);
						// …and a SIGHUP that arrives anyway leaves the running configuration in place.
						env.crha?.kill("SIGHUP");
						await waitFor("reload error logged", async () => env.crhaLog.includes("reload failed"), 10_000);
						expect(await groupsOf()).toEqual(["prod", "web"]);
						expect((await run({ kind: "exec", argv: ["true"] })).state).toBe("exited");
					} finally {
						await writeFile(env.configPath, original);
					}
				}),
			30_000,
		);

		it("spills large output to a file on the node", () =>
			withLog(async () => {
				const t = await run({ kind: "exec", shell: "seq 1 30000" }, 30_000);
				expect(t).toMatchObject({ state: "exited", exitCode: 0, stdoutBytes: 168894 });
				expect(t.outputFile).toBeTruthy();
				expect(t.stdoutHead.startsWith("1\n")).toBe(true);
				expect(t.stdoutTail.endsWith("30000\n")).toBe(true);
				expect(existsSync(t.outputFile as string)).toBe(true);
				const expected = `${Array.from({ length: 30000 }, (_, i) => i + 1).join("\n")}\n`;
				expect(await readFile(t.outputFile as string, "utf8")).toBe(expected);
			}));

		it("batch output: text keeps a combined tail, status keeps only the node's file", () =>
			withLog(async () => {
				const text = await env.crhs.api("/api/task-groups", {
					body: {
						kind: "exec",
						shell: "echo out; echo err >&2",
						targets: [env.nodeId],
						outputMode: "text",
						waitMs: 20_000,
					},
				});
				expect(text.status).toBe(201);
				expect(text.json.group.outputMode).toBe("text");
				const t = text.json.group.tasks[0];
				expect(t).toMatchObject({
					state: "exited",
					exitCode: 0,
					outputMode: "text",
					stdoutHead: "",
					stderrHead: "",
					stderrTail: "",
				});
				// One combined tail in arrival order, and the byte totals stay per stream.
				expect(t.stdoutTail).toContain("out");
				expect(t.stdoutTail).toContain("err");
				expect(t.stdoutBytes).toBeGreaterThan(0);
				expect(t.stderrBytes).toBeGreaterThan(0);
				expect(t.outputFile).toBeTruthy();

				const status = await env.crhs.api("/api/task-groups", {
					body: {
						kind: "exec",
						shell: "echo hidden",
						targets: [env.nodeId],
						outputMode: "status",
						waitMs: 20_000,
					},
				});
				expect(status.status).toBe(201);
				expect(status.json.group.outputMode).toBe("status");
				const s = status.json.group.tasks[0];
				expect(s).toMatchObject({
					state: "exited",
					exitCode: 0,
					outputMode: "status",
					stdoutHead: "",
					stdoutTail: "",
					stderrHead: "",
					stderrTail: "",
				});
				expect(s.stdoutBytes).toBe("hidden\n".length);
				expect(s.outputFile).toBeTruthy();
				expect(existsSync(s.outputFile as string)).toBe(true);
			}));

		it("files: write, edit, read, stat, list", () =>
			withLog(async () => {
				const dir = await mkdtemp(join(tmp, "files-"));
				const path = join(dir, "f.txt");

				const w = await run({ kind: "file.write", path, content: "a\nb\nc\n" });
				expect(w.state).toBe("exited");
				expect(await readFile(path, "utf8")).toBe("a\nb\nc\n");

				const again = await run({ kind: "file.write", path, content: "x" });
				expect(again.errorCode).toBe("exists");
				expect(await readFile(path, "utf8")).toBe("a\nb\nc\n");
				const over = await run({ kind: "file.write", path, content: "x\ny\nz\n", overwrite: true });
				expect(over.state).toBe("exited");
				expect(over.errorCode).toBeNull();
				expect(await readFile(path, "utf8")).toBe("x\ny\nz\n");

				const edit = await run({ kind: "file.edit", path, edits: [{ oldText: "y\n", newText: "Y!\n" }] });
				expect(edit.state).toBe("exited");
				expect(await readFile(path, "utf8")).toBe("x\nY!\nz\n");
				const miss = await run({ kind: "file.edit", path, edits: [{ oldText: "nope", newText: "z" }] });
				expect(miss.errorCode).toBe("edit_no_match");
				expect(await readFile(path, "utf8")).toBe("x\nY!\nz\n");

				const read = await run({ kind: "file.read", path });
				expect(read.stdoutTail).toBe("x\nY!\nz\n");
				const part = await run({ kind: "file.read", path, offset: 2, limit: 3 });
				expect(part.stdoutTail).toBe("Y!\n");

				const stat = await run({ kind: "file.stat", path });
				expect(stat.state).toBe("exited");
				expect(JSON.parse(stat.stdoutTail)).toMatchObject({ size: 7 });
				const list = await run({ kind: "file.list", path: dir });
				expect(list.state).toBe("exited");
				expect(list.stdoutTail).toContain("f.txt");
				expect(() => JSON.parse(list.stdoutTail)).not.toThrow();
			}));

		it("timeout kills with TERM; cancel reports cancelled", () =>
			withLog(async () => {
				const t = await run({ kind: "exec", argv: ["sleep", "10"], timeoutMs: 300 }, 10_000);
				expect(t.state).toBe("exited");
				expect(t.timedOut).toBe(true);
				expect(t.signal).toBe("TERM");

				const started = await run({ kind: "exec", argv: ["sleep", "30"] }, 0);
				await waitFor("running", async () => (await env.crhs.getTask(started.id)).state === "running");
				const cancel = await env.crhs.api(`/api/tasks/${started.id}/cancel`, { body: {} });
				expect(cancel.json.cancelled).toBe(true);
				const done = await env.crhs.waitTask(started.id);
				expect(done).toMatchObject({ state: "exited", cancelled: true });
			}));

		it("offline node: new tasks fail with node_offline", () =>
			withLog(async () => {
				await env.killCrha("SIGTERM");
				await env.waitDisconnected();
				const t = await run({ kind: "exec", argv: ["true"] });
				expect(t).toMatchObject({ state: "failed", errorCode: "node_offline" });
				env.startCrha();
				await env.waitConnected();
				expect((await run({ kind: "exec", argv: ["true"] })).state).toBe("exited");
			}));

		it("crhs restart mid-task: output and result survive", () =>
			withLog(async () => {
				const t = await run({ kind: "exec", shell: "for i in 1 2 3 4 5 6 7 8; do echo line$i; sleep 0.4; done" }, 0);
				await new Promise((r) => setTimeout(r, 1000));
				await env.crhs.restart();
				const done = await env.crhs.waitTask(t.id, 30_000);
				expect(done.state).toBe("exited");
				expect(done.exitCode).toBe(0);
				expect(done.stdoutTail).toBe(`${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `line${i}`).join("\n")}\n`);
			}));

		it("crha crash mid-task: task becomes unknown(executor_restarted)", () =>
			withLog(async () => {
				await env.waitConnected();
				const t = await run({ kind: "exec", argv: ["sleep", "31.1"] }, 0);
				await waitFor("running", async () => (await env.crhs.getTask(t.id)).state === "running");
				await env.killCrha("SIGKILL");
				await pkill("sleep 31.1");
				env.startCrha();
				const done = await env.crhs.waitTask(t.id, 60_000);
				expect(done).toMatchObject({ state: "unknown", errorCode: "executor_restarted" });
			}));
	});

	describe("connection lost", () => {
		let env: Env;
		beforeAll(async () => {
			env = await Env.create(bin, tmp, { reconnectGraceMs: 1500, idleTimeoutMs: 2000 });
			await env.bringUp();
		}, 60_000);
		afterAll(async () => {
			await pkill("sleep 31.2");
			if (env) await env.destroy();
		});

		it("crha gone for longer than the grace: unknown(connection_lost)", async () => {
			const t = await env.crhs.runTask(env.nodeId, { kind: "exec", argv: ["sleep", "31.2"] }, 0);
			await waitFor("running", async () => (await env.crhs.getTask(t.id)).state === "running");
			await env.killCrha("SIGKILL");
			await pkill("sleep 31.2");
			const done = await env.crhs.waitTask(t.id, 20_000);
			expect(done).toMatchObject({ state: "unknown", errorCode: "connection_lost" });
		}, 60_000);

		// A hung (not closed) connection is caught by crhs's idle timeout.
		it("SIGSTOPped crha: unknown(connection_lost), late result does not change the state", async () => {
			env.startCrha();
			await env.waitConnected();
			const t = await env.crhs.runTask(env.nodeId, { kind: "exec", shell: "sleep 4; echo late" }, 0);
			await waitFor("running", async () => (await env.crhs.getTask(t.id)).state === "running");
			env.crha?.kill("SIGSTOP");
			const during = await env.crhs.waitTask(t.id, 10_000);
			expect(during).toMatchObject({ state: "unknown", errorCode: "connection_lost" });
			env.crha?.kill("SIGCONT");
			await env.waitConnected();
			await waitFor("late result", async () => {
				const row = await env.crhs.db
					.selectFrom("tasks")
					.select("late_result")
					.where("id", "=", t.id)
					.executeTakeFirst();
				return row?.late_result;
			});
			expect((await env.crhs.getTask(t.id)).state).toBe("unknown");
		}, 60_000);
	});
});
