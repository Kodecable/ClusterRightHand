/**
 * The forward cases of the privileged system suite (doc/design/testing/privileged.md) on a `forward` node:
 *
 * - crhs-signed authorizations for exec and file tasks.
 * - a node that only trusts the user: crhs alone cannot escalate, the owner's signature makes it run.
 * - require-cosign: the user's signature and crhs's cosign ticket for the use are both needed, for a one-shot
 *   and a reusable authorization alike.
 * - a local approval window: `crha approve --for` releases a crhs-signed task on a node whose
 *   crhs entry denies it, the window closes with `crha lock` and does not survive a restart.
 * - one-shot replay, the persisted used list and a privileged mode restart.
 * - symlinks, path traversal, env and prefix attempts.
 * - trust digest changes, re-planning a waiting task, and privileged_unavailable.
 *
 * Every user signature is produced by the real `crhu sign --payload` on the host; crhs runs in
 * process, so both ends are the shipped code.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { taskSpecFromJson } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { specBytes } from "../../../src/privilege/payload.ts";
import { InProcessCrhs, waitFor } from "../../e2e/harness.ts";
import {
	authorizeWithCli,
	buildStaticCrha,
	PrivilegedNode,
	parseEnv,
	pendingAuthorization,
	podmanAvailable,
	publicKeyOf,
	registerSshCredential,
	signPayload,
	sshKeygen,
	submitAuthorization,
	type TrustSpec,
	waitTrustDigestChange,
} from "./harness.ts";

const describePodman = describe.skipIf(!podmanAvailable);
const runFile = promisify(execFile);
const FIXED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Variables that must never reach a task: the container's own and crha's overrides. */
function leaked(env: Record<string, string>): string[] {
	const containerOwn = new Set(["PRIV_SSH_PORT", "PRIV_NO_SSHD", "container"]);
	return Object.keys(env).filter((k) => containerOwn.has(k) || k.startsWith("CRHA_TASK_"));
}

describePodman("privileged system: forward", () => {
	let tmp = "";
	let bin = "";
	let crhs: InProcessCrhs;
	let node: PrivilegedNode;
	let userKey = "";
	let crhsKey = "";
	let credentialId = "";
	let actorId = "";
	let transferRoot = "";
	const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
	const actor = () => ({ type: "user" as const, id: actorId, onBehalfOfUserId: actorId });

	const userEntry = (extra: Partial<TrustSpec> = {}): TrustSpec => ({
		name: "owner",
		role: "user",
		format: "sshsig",
		key: userKey,
		kinds: ["execute"],
		...extra,
	});
	const crhsEntry = (extra: Partial<TrustSpec> = {}): TrustSpec => ({
		name: "crhs",
		role: "crhs",
		format: "sshsig",
		key: crhsKey,
		kinds: ["execute"],
		requireSpec: true,
		...extra,
	});
	const localEntry = (uids = [0], extra: Partial<TrustSpec> = {}): TrustSpec => ({
		name: "local-admins",
		role: "local",
		uids,
		kinds: [],
		...extra,
	});

	const task = (body: Record<string, unknown>, waitMs = 1000) => node.task(body, waitMs);

	async function waitAwaiting(id: string, timeoutMs = 20_000): Promise<void> {
		let last = "";
		try {
			await waitFor(
				`task ${id} to wait for an authorization`,
				async () => {
					const t = await crhs.getTask(id);
					last = `${t.state} ${t.errorCode ?? ""} ${t.errorMessage ?? ""} ${JSON.stringify(t.authorization?.options)}`;
					return t.state === "awaiting_authorization";
				},
				timeoutMs,
			);
		} catch (err) {
			throw new Error(`${err instanceof Error ? err.message : String(err)}; last: ${last}`);
		}
	}

	async function waitTerminal(id: string, timeoutMs = 30_000) {
		let last = "";
		try {
			return await waitFor(
				`task ${id} to finish`,
				async () => {
					const t = await crhs.getTask(id);
					last = `${t.state} ${t.errorCode ?? ""} ${t.errorMessage ?? ""} ${JSON.stringify(t.authorization?.options)}`;
					return t.state !== "running" && t.state !== "dispatched" && t.state !== "awaiting_authorization"
						? t
						: undefined;
				},
				timeoutMs,
			);
		} catch (err) {
			throw new Error(`${err instanceof Error ? err.message : String(err)} (last: ${last})`);
		}
	}

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-priv-forward-"));
		bin = await buildStaticCrha(tmp);
		transferRoot = join(tmp, "staging");
		crhs = await InProcessCrhs.create({ transferRoot });
		await crhs.loginAdmin();
		actorId = (await crhs.db.selectFrom("users").select("id").where("username", "=", "root").executeTakeFirstOrThrow())
			.id;
		// clock_skew 0: both processes share the host clock, and the fallback case needs a 1 ms
		// authorization to really expire (doc/design/privilege.md "Clock").
		node = await PrivilegedNode.create({ bin, crhs, mode: "forward", trust: [], clockSkew: "0s" });
		userKey = await publicKeyOf(node.userKeyPath);
		crhsKey = (await crhs.api("/api/privilege/crhs-key")).json.key.authorizedKey as string;
		credentialId = await registerSshCredential(crhs, node.crhuBin, node.userKeyPath);
		expect(credentialId).toBeTruthy();
	}, 600_000);

	afterAll(async () => {
		await node?.destroy();
		await crhs?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	describe("item 3: crhs-signed authorizations", () => {
		beforeAll(async () => {
			await node.setTrust([
				crhsEntry({
					allow: [{ method: "exec" }, { method: "file.read" }, { method: "file.write" }],
				}),
			]);
		}, 60_000);

		it("runs a privileged exec as root", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			expect(done.outputHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("crhs");
			expect(done.authorization?.payloadId).toMatch(/^[0-9a-f]{64}$/);
		}, 60_000);

		it("writes and reads a file as root", async () => {
			const written = await task({
				kind: "file.write",
				path: "/root/crh-forward.txt",
				content: "signed-content\n",
				overwrite: true,
			});
			const w = await node.taskState(written.id);
			expect(w).toMatchObject({ state: "exited", exitCode: 0 });
			const read = await task({ kind: "file.read", path: "/root/crh-forward.txt" });
			const r = await node.taskState(read.id);
			expect(r.state).toBe("exited");
			expect(r.outputHead + r.outputTail).toContain("signed-content");
			// uid 998 cannot read it, so the content really came from the root executor.
			const denied = await node.execAs(998, ["/bin/cat", "/root/crh-forward.txt"]);
			expect(denied.code).not.toBe(0);
		}, 60_000);

		it("leaves ordinary tasks on the non-privileged path", async () => {
			const t = await crhs.runTask(node.nodeId, { kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
			expect(done.outputHead).toBe("998\n");
		}, 60_000);

		it("gives an ordinary task the crha account's identity, not the container's environment", async () => {
			const t = await crhs.runTask(node.nodeId, { kind: "exec", argv: ["/usr/bin/env"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
			const env = parseEnv(done.outputHead + done.outputTail);
			expect(env).toMatchObject({
				HOME: "/home/crha",
				USER: "crha",
				LOGNAME: "crha",
				SHELL: "/bin/sh",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
			});
			expect(leaked(env)).toEqual([]);
		}, 60_000);

		it("gives a privileged task root's identity, the fixed PATH and the discovered shell", async () => {
			const t = await task({ kind: "exec", argv: ["/usr/bin/env"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			const env = parseEnv(done.outputHead + done.outputTail);
			expect(env).toMatchObject({
				HOME: "/root",
				USER: "root",
				LOGNAME: "root",
				SHELL: "/bin/sh",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				PATH: FIXED_PATH,
			});
			expect(leaked(env)).toEqual([]);
		}, 60_000);
	});

	// -----------------------------------------------------------------------
	describe("item 4: a node that only trusts the user", () => {
		beforeAll(async () => {
			await node.setTrust([userEntry()]);
		}, 60_000);

		it("does not execute without the owner's signature", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const waiting = await crhs.getTask(t.id);
			expect(waiting.outputBytes).toBe(0);
			expect(waiting.authorization?.dispatchedPath).toBeNull();
			expect((waiting.authorization?.options ?? []).map((option) => option.kind)).toEqual(["sign"]);
		}, 60_000);

		it("runs after the owner signs the pending payload with crhu sign", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const pending = await pendingAuthorization(crhs, t.id);
			expect(pending.decoded.taskIds).toEqual([t.id]);
			expect(pending.decoded.attempt).toBe(1);
			const submitted = await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.outputHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("user");
			expect(done.authorization?.payloadId).toBe(submitted.id);
		}, 60_000);

		it("refuses a signature from a key the owner did not register", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const pending = await pendingAuthorization(crhs, t.id);
			const strangerKey = join(tmp, "stranger-key");
			await sshKeygen(strangerKey);
			const authorization = await signPayload(node.crhuBin, strangerKey, pending);
			const res = await submitAuthorization(crhs, authorization);
			expect(res.status).toBe(400);
			expect(res.json.error).toContain("signing credentials");
			expect((await crhs.getTask(t.id)).state).toBe("awaiting_authorization");
			// Clean up: the owner can still sign and run it.
			await authorizeWithCli(node, t.id);
			expect((await waitTerminal(t.id)).state).toBe("exited");
		}, 60_000);
	});

	// -----------------------------------------------------------------------
	describe("item 5: require-cosign", () => {
		const withCosign = () => [userEntry({ kinds: ["execute", "require-cosign"] }), crhsEntry({ kinds: ["cosign"] })];

		beforeAll(async () => {
			await node.setTrust(withCosign());
		}, 60_000);

		it("runs on the user's signature with crhs's cosign ticket for the use", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			// A cosign-only crhs entry cannot execute by itself; only the owner's entry is a path.
			const waiting = await crhs.getTask(t.id);
			expect((waiting.authorization?.options ?? []).map((option) => option.kind)).toEqual(["sign"]);
			const submitted = await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.outputHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("user");
			// The stored authorization keeps the user's signature alone; crhs's confirmation went out as a
			// ticket beside it (doc/design/privilege.md "Cosigning").
			const row = await crhs.db
				.selectFrom("authorizations")
				.select("signatures")
				.where("id", "=", submitted.id)
				.executeTakeFirst();
			expect(row).toBeDefined();
			expect(JSON.parse(row?.signatures ?? "[]")).toHaveLength(1);
		}, 60_000);

		it("runs a reusable authorization's uses, each with a cosign ticket of its own", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const spec = taskSpecFromJson({ kind: "exec", command: { argv: ["id", "-u"] }, env: {}, cwd: "", stdin: null });
			const specB64 = Buffer.from(specBytes(spec)).toString("base64");
			const signed = await runFile(node.crhuBin, [
				"grant",
				"--nodes",
				node.nodeId,
				"--spec",
				specB64,
				"--deadline",
				"10m",
				"--key",
				node.userKeyPath,
				"--yes",
			]);
			const submitted = await submitAuthorization(crhs, signed.stdout.trim());
			expect(submitted.status).toBe(200);
			expect((await waitTerminal(t.id)).state).toBe("exited");
			// A second task of the same spec runs on the same authorization, confirmed by a new ticket.
			const again = await task({ kind: "exec", argv: ["id", "-u"] });
			expect(await waitTerminal(again.id)).toMatchObject({ state: "exited", exitCode: 0 });
			// Remove it so later cases do not see it as a stored candidate.
			const id = submitted.json.authorization?.id as string;
			await crhs.db.deleteFrom("authorizations").where("id", "=", id).execute();
		}, 60_000);
	});

	// -----------------------------------------------------------------------
	describe("item 6: local approval window", () => {
		beforeAll(async () => {
			await node.ctl("reset-priv-state");
			await node.ctl("start-priv");
			// The crhs entry denies every exec task, so only an open window can release one.
			await node.setTrust([crhsEntry({ deny: [{ method: "exec" }] }), localEntry([0])]);
		}, 90_000);

		it("opens a window, runs a crhs task, and locks it again", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const waiting = await crhs.getTask(t.id);
			// A task waiting for a window offers a local_window option instead of a sign payload.
			expect(waiting.authorization?.options).toContainEqual(expect.objectContaining({ kind: "local_window" }));
			expect(waiting.authorization?.options?.some((option) => option.kind === "sign")).toBe(false);

			const closed = await node.execAs(0, ["/usr/local/bin/crha", "approve"]);
			expect(closed.code).toBe(0);
			expect(closed.stdout).toContain("closed");

			const opened = await node.execAs(0, ["/usr/local/bin/crha", "approve", "--for", "1m"]);
			expect(opened.code).toBe(0);
			expect(opened.stdout).toContain("open until");

			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.outputHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("crhs");

			const locked = await node.execAs(0, ["/usr/local/bin/crha", "lock"]);
			expect(locked.code).toBe(0);
			expect(locked.stdout).toContain("closed");
		}, 90_000);

		it("refuses a window longer than max_window", async () => {
			// max_window is not part of the trust summary, so the digest does not change: wait for
			// the reload by the refusal itself.
			await node.reloadTrust([crhsEntry({ deny: [{ method: "exec" }] }), localEntry([0], { maxWindow: "1m" })]);
			const over = await waitFor(
				"the reloaded max_window",
				async () => {
					const r = await node.execAs(0, ["/usr/local/bin/crha", "approve", "--for", "5m"]);
					if (r.code === 0) await node.execAs(0, ["/usr/local/bin/crha", "lock"]);
					return r.code !== 0 ? r : undefined;
				},
				30_000,
			);
			expect(over.stderr).toContain("1m0s");
			const ok = await node.execAs(0, ["/usr/local/bin/crha", "approve", "--for", "1m"]);
			expect(ok.code).toBe(0);
			await node.execAs(0, ["/usr/local/bin/crha", "lock"]);

			// Back to the default limit for the next case.
			await node.reloadTrust([crhsEntry({ deny: [{ method: "exec" }] }), localEntry([0])]);
			await waitFor(
				"the default max_window",
				async () => {
					const r = await node.execAs(0, ["/usr/local/bin/crha", "approve", "--for", "5m"]);
					return r.code === 0 ? r : undefined;
				},
				30_000,
			);
			await node.execAs(0, ["/usr/local/bin/crha", "lock"]);
		}, 90_000);

		it("loses the window when the privileged mode restarts", async () => {
			const before = (await node.trust()).digest;
			const opened = await node.execAs(0, ["/usr/local/bin/crha", "approve", "--for", "10m"]);
			expect(opened.code).toBe(0);
			const withWindow = await waitTrustDigestChange(node, before);
			await node.ctl("restart-priv");
			// crha reconnects to the restarted privileged mode and reports the closed window.
			await waitTrustDigestChange(node, withWindow);
			const state = await node.execAs(0, ["/usr/local/bin/crha", "approve"]);
			expect(state.code).toBe(0);
			expect(state.stdout).toContain("closed");

			// A task created afterwards waits for a new window; opening one releases it.
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const reopened = await node.execAs(0, ["/usr/local/bin/crha", "approve", "--for", "1m"]);
			expect(reopened.code).toBe(0);
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("exited");
			expect(done.authorization?.dispatchedPath).toBe("crhs");
		}, 120_000);

		afterAll(async () => {
			// A window left open would change the trust digest when it expires during a later case.
			await node.execAs(0, ["/usr/local/bin/crha", "lock"]);
		});
	});

	// -----------------------------------------------------------------------
	describe("item 7: one-shot replay and the used list", () => {
		beforeAll(async () => {
			await node.setTrust([userEntry()]);
		}, 60_000);

		it("executes a one-shot user authorization once and records it as used", async () => {
			await node.ctl("reset-priv-state");
			await node.ctl("start-priv");
			// The same trust as beforeAll: the digest need not change, so wait for the report instead.
			await node.reloadTrust([userEntry()]);
			await node.waitTrust("ok");
			await node.exec(["/bin/sh", "-c", "rm -f /root/crh-runs"]);
			const t = await task({ kind: "exec", shell: "echo run >> /root/crh-runs; wc -l < /root/crh-runs" });
			await waitAwaiting(t.id);
			const submitted = await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.outputHead.trim()).toBe("1");
			const used = await node.exec(["/bin/cat", "/var/lib/crha-privileged/used"]);
			expect(used.code).toBe(0);
			expect(used.stdout).toContain(t.id);
			expect(used.stdout).toContain(submitted.id);
			// Replaying the same authorization dispatches nothing and runs nothing again.
			const replay = await submitAuthorization(crhs, submitted.authorization);
			expect(replay.status).toBe(200);
			await crhs.cluster.drain();
			const lines = await node.exec(["/bin/sh", "-c", "wc -l < /root/crh-runs"]);
			expect(lines.stdout.trim()).toBe("1");
			// The used list survives a privileged mode restart.
			await node.ctl("restart-priv");
			await node.waitTrust("ok");
			const usedAfter = await node.exec(["/bin/cat", "/var/lib/crha-privileged/used"]);
			expect(usedAfter.stdout).toContain(t.id);
			await submitAuthorization(crhs, submitted.authorization);
			expect((await node.exec(["/bin/sh", "-c", "wc -l < /root/crh-runs"])).stdout.trim()).toBe("1");
		}, 120_000);

		it("reuses a submitted authorization only for the command it names", async () => {
			// A reusable user authorization (no task ids) for one exact command. The command is
			// unique to this case, so an authorization stored by an earlier case cannot be reused.
			const spec = taskSpecFromJson({
				kind: "exec",
				command: { argv: ["id", "-u", "--"] },
				env: {},
				cwd: "",
				stdin: null,
			});
			const specB64 = Buffer.from(specBytes(spec)).toString("base64");
			// crhu needs ssh-keygen and the private key, so it runs on the host like the owner would.
			const signed = await runFile(node.crhuBin, [
				"grant",
				"--nodes",
				node.nodeId,
				"--spec",
				specB64,
				"--deadline",
				"10m",
				"--key",
				node.userKeyPath,
				"--yes",
			]);
			const authorization = signed.stdout.trim();
			const submitted = await submitAuthorization(crhs, authorization);
			expect(submitted.status).toBe(200);
			const reuse = await task({ kind: "exec", argv: ["id", "-u", "--"] });
			const reused = await node.taskState(reuse.id);
			expect(reused).toMatchObject({ state: "exited", exitCode: 0 });
			expect(reused.authorization?.dispatchedPath).toBe("user");
			expect(reused.authorization?.payloadId).toBe(submitted.json.authorization?.id);
			// A different command is not covered by the reusable authorization, so the next task
			// waits for a one-shot signature.
			const after = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(after.id);
			const pending = await pendingAuthorization(crhs, after.id);
			expect(pending.decoded.taskIds).toEqual([after.id]);
			await authorizeWithCli(node, after.id);
			expect((await waitTerminal(after.id)).state).toBe("exited");
		}, 120_000);
	});

	// -----------------------------------------------------------------------
	describe("item 8: path, env and prefix attempts", () => {
		it("refuses a file read through a symlink", async () => {
			await node.setTrust([crhsEntry({ allow: [{ method: "file.read" }] })]);
			await node.exec(["/bin/ln", "-sf", "/etc/shadow", "/tmp/crh-link"]);
			const t = await task({ kind: "file.read", path: "/tmp/crh-link" });
			const done = await waitTerminal(t.id);
			// The executor opens with openat2(RESOLVE_NO_SYMLINKS); nothing is read.
			expect(done.state).toBe("errored");
			expect(done.errorCode).toBe("symlink_not_allowed");
			expect(done.outputBytes).toBe(0);
			expect(done.errorMessage?.toLowerCase()).toContain("symbolic link");
		}, 60_000);

		it("refuses an unnormalized path", async () => {
			const t = await task({ kind: "file.read", path: "/etc/../etc/hostname" });
			const done = await waitTerminal(t.id);
			expect(done.state).not.toBe("exited");
			expect(done.outputBytes).toBe(0);
		}, 60_000);

		it("does not let a shell command hide behind an exec prefix rule", async () => {
			await node.setTrust([userEntry({ allow: [{ method: "exec", prefix: "id -u" }] })]);
			const shell = await task({ kind: "exec", shell: "id -u" });
			const done = await waitTerminal(shell.id);
			expect(done.state).toBe("rejected");
			expect(done.errorCode).toBe("authorization_required");
			// The rendered argv is compared as one target: a semicolon smuggled into an option
			// changes the target instead of extending a matching one (doc/design/privilege.md "Methods and targets").
			const argv = await task({ kind: "exec", argv: ["id", "-u;cat /etc/shadow"] });
			const argvDone = await waitTerminal(argv.id);
			expect(argvDone.state).toBe("rejected");
			expect(argvDone.errorCode).toBe("authorization_required");
			// The exact command the rule allows still needs the owner's own signature.
			const allowed = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(allowed.id);
			await authorizeWithCli(node, allowed.id);
			expect((await waitTerminal(allowed.id)).state).toBe("exited");
		}, 90_000);

		it("lets a privileged task override HOME when env_allow permits it", async () => {
			await node.setTrust([userEntry({ allow: [{ method: "exec" }], envAllow: ["HOME"] })]);
			const t = await task({ kind: "exec", argv: ["/usr/bin/env"], env: { HOME: "/tmp/crh-home" } });
			await waitAwaiting(t.id);
			await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			const env = parseEnv(done.outputHead + done.outputTail);
			expect(env.HOME).toBe("/tmp/crh-home");
			expect(env.PATH).toBe(FIXED_PATH);
		}, 120_000);

		it("refuses environment variables the trust entry does not allow", async () => {
			await node.setTrust([userEntry({ allow: [{ method: "exec" }], envAllow: ["PRIV_SAFE"] })]);
			const t = await task({ kind: "exec", argv: ["id", "-u"], env: { LD_PRELOAD: "/tmp/evil.so" } });
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("rejected");
			expect(done.errorCode).toBe("authorization_required");
			// An allowed variable still reaches the privileged process.
			const env = await task({ kind: "exec", argv: ["/usr/bin/env"], env: { PRIV_SAFE: "present" } });
			await waitAwaiting(env.id);
			await authorizeWithCli(node, env.id);
			const envDone = await waitTerminal(env.id);
			expect(envDone).toMatchObject({ state: "exited", exitCode: 0 });
			expect(envDone.outputHead + envDone.outputTail).toContain("PRIV_SAFE=present");
		}, 120_000);
	});

	// -----------------------------------------------------------------------
	describe("item 10: trust digest, re-planning and privileged_unavailable", () => {
		it("changes the digest when the trust configuration changes", async () => {
			const d1 = await node.setTrust([userEntry()]);
			const first = await node.trust();
			expect(first.status).toBe("ok");
			expect(first.digest).toBe(d1);
			const d2 = await node.setTrust([userEntry(), crhsEntry()]);
			expect(d2).not.toBe(d1);
			const second = await node.trust();
			expect(second.summary?.trust).toHaveLength(2);
		}, 60_000);

		it("re-plans a waiting task when the digest changes", async () => {
			await node.setTrust([userEntry()]);
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const before = await pendingAuthorization(crhs, t.id);
			expect(before.decoded.attempt).toBe(1);
			// Adding an executing crhs entry changes the digest; crhs may now take its own path.
			await node.setTrust([userEntry(), crhsEntry()]);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.outputHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("crhs");
			expect(done.authorization?.payloadId).not.toBe(before.id);
		}, 60_000);

		it("fails privileged tasks with privileged_unavailable while the privileged mode is away", async () => {
			await node.setTrust([crhsEntry()]);
			await node.ctl("stop-priv");
			await node.waitTrust("unavailable");
			const t = await task({ kind: "exec", argv: ["true"] });
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("errored");
			expect(done.errorCode).toBe("privileged_unavailable");
			// When it comes back with the same trust, the next task runs again.
			await node.ctl("start-priv");
			await node.waitTrust("ok");
			const again = await task({ kind: "exec", argv: ["true"] });
			expect((await node.taskState(again.id)).state).toBe("exited");
		}, 90_000);
	});

	// -----------------------------------------------------------------------
	describe("item 11: file plane transfers", () => {
		beforeAll(async () => {
			await node.setTrust([crhsEntry({ allow: [{ method: "file.read" }, { method: "file.write" }] })]);
		}, 60_000);

		it("pushes a file to a root-owned path with its owner, group and mode", async () => {
			const content = Buffer.from("forward push content\n");
			const path = "/root/crh-plane-push.txt";
			const location = await crhs.cluster.stageBytesForPush(content);
			const t = await crhs.cluster.pushFile({
				nodeId: node.nodeId,
				path,
				location,
				overwrite: true,
				mode: 0o640,
				owner: "root",
				group: "root",
				privileged: true,
				actor: actor(),
			});
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			expect(done.authorization?.dispatchedPath).toBe("crhs");
			const stat = await node.exec(["/usr/bin/stat", "-c", "%a %u %g %s", path]);
			expect(stat.stdout.trim()).toBe(`640 0 0 ${content.length}`);
			expect((await node.exec(["/bin/cat", path])).stdout).toBe(content.toString());
		}, 60_000);

		it("pulls a root-only file into the staging location", async () => {
			const content = Buffer.from("forward pull content\n");
			const path = "/root/crh-plane-pull.txt";
			const created = await node.exec(["/usr/bin/tee", path], { stdin: content.toString() });
			expect(created.code).toBe(0);
			expect((await node.exec(["/bin/chmod", "0600", path])).code).toBe(0);
			expect((await node.execAs(998, ["/bin/cat", path])).code).not.toBe(0);
			const location = crhs.cluster.stagingLocation();
			const t = await crhs.cluster.pullFile({
				nodeId: node.nodeId,
				path,
				maxBytes: 4096,
				location,
				privileged: true,
				actor: actor(),
			});
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			expect(done.authorization?.dispatchedPath).toBe("crhs");
			expect(done.result).toMatchObject({ kind: "file.pull", size: content.length, sha256: sha256Hex(content) });
			const staged = await readFile(join(transferRoot, location.path));
			expect(staged.equals(content)).toBe(true);
		}, 60_000);
	});
});
