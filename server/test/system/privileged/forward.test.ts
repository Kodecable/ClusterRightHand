/**
 * The forward cases of the privileged system suite (doc/testing/privileged.md) on a `forward` node:
 *
 * - crhs-signed authorizations for exec and file tasks.
 * - a node that only trusts the user: crhs alone cannot escalate, the owner's signature makes it run.
 * - require-cosign: the user signature and crhs's cosignature are both needed.
 * - local approval with `crha pending` / `approve` / `deny`, surviving a privileged mode restart, and
 *   the attempt + 1 fallback after a crhs signature was refused.
 * - one-shot replay, the persisted used list and a privileged mode restart.
 * - symlinks, path traversal, env and prefix attempts.
 * - trust digest changes, re-planning a waiting task, and privileged_unavailable.
 *
 * Every user signature is produced by the real `crha grant --payload` on the host; crhs runs in
 * process, so both ends are the shipped code.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { taskSpecFromJson } from "@crh/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { specSha256 } from "../../../src/privilege/payload.ts";
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
		requireExact: true,
		...extra,
	});
	const localEntry = (uids = [0]): TrustSpec => ({ name: "local-admins", role: "local", uids, kinds: ["execute"] });

	const task = (body: Record<string, unknown>, waitMs = 1000) => node.task(body, waitMs);

	async function waitAwaiting(id: string, timeoutMs = 20_000): Promise<void> {
		await waitFor(
			`task ${id} to wait for an authorization`,
			async () => (await crhs.getTask(id)).state === "awaiting_authorization",
			timeoutMs,
		);
	}

	async function waitTerminal(id: string, timeoutMs = 30_000) {
		let last = "";
		try {
			return await waitFor(
				`task ${id} to finish`,
				async () => {
					const t = await crhs.getTask(id);
					last = `${t.state} ${t.errorCode ?? ""} ${t.errorMessage ?? ""} ${JSON.stringify(t.authorization?.plan)}`;
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
		crhs = await InProcessCrhs.create();
		await crhs.loginAdmin();
		// clock_skew 0: both processes share the host clock, and the fallback case needs a 1 ms
		// authorization to really expire (doc/privilege.md 时钟).
		node = await PrivilegedNode.create({ bin, crhs, mode: "forward", trust: [], clockSkew: "0s" });
		userKey = await publicKeyOf(node.userKeyPath);
		crhsKey = (await crhs.api("/api/privilege/crhs-key")).json.key.authorizedKey as string;
		credentialId = await registerSshCredential(crhs, userKey);
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
			expect(done.stdoutHead).toBe("0\n");
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
			expect(r.stdoutHead + r.stdoutTail).toContain("signed-content");
			// uid 998 cannot read it, so the content really came from the root executor.
			const denied = await node.execAs(998, ["/bin/cat", "/root/crh-forward.txt"]);
			expect(denied.code).not.toBe(0);
		}, 60_000);

		it("leaves ordinary tasks on the non-privileged path", async () => {
			const t = await crhs.runTask(node.nodeId, { kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
			expect(done.stdoutHead).toBe("998\n");
		}, 60_000);

		it("gives an ordinary task the crha account's identity, not the container's environment", async () => {
			const t = await crhs.runTask(node.nodeId, { kind: "exec", argv: ["/usr/bin/env"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
			const env = parseEnv(done.stdoutHead + done.stdoutTail);
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
			const env = parseEnv(done.stdoutHead + done.stdoutTail);
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
			expect(waiting.stdoutBytes).toBe(0);
			expect(waiting.authorization?.dispatchedPath).toBeNull();
			const paths = (waiting.authorization?.plan.paths ?? []).map((p: { path: string }) => p.path);
			expect(paths).toEqual(["user"]);
		}, 60_000);

		it("runs after the owner signs the pending payload with crha grant", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const pending = await pendingAuthorization(crhs, t.id);
			expect(pending.decoded.taskIds).toEqual([t.id]);
			expect(pending.decoded.attempt).toBe(1);
			const submitted = await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.stdoutHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("user");
			expect(done.authorization?.payloadId).toBe(submitted.id);
		}, 60_000);

		it("refuses a signature from a key the owner did not register", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const pending = await pendingAuthorization(crhs, t.id);
			const strangerKey = join(tmp, "stranger-key");
			await sshKeygen(strangerKey);
			const authorization = await signPayload(bin, strangerKey, pending.payload);
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

		it("runs when the user's signature carries crhs's cosignature", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			// A cosign-only crhs entry cannot execute by itself; only the owner's entry is a path.
			const waiting = await crhs.getTask(t.id);
			expect((waiting.authorization?.plan.paths ?? []).map((p: { path: string }) => p.path)).toEqual(["user"]);
			const submitted = await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.stdoutHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("user");
			// Both signatures are stored on the same payload (doc/privilege.md 联署).
			const row = await crhs.db
				.selectFrom("authorizations")
				.select("signatures")
				.where("id", "=", submitted.id)
				.executeTakeFirst();
			expect(row).toBeDefined();
			expect(JSON.parse(row?.signatures ?? "[]")).toHaveLength(2);
		}, 60_000);

		it("does not run on a user signature that cannot carry crhs's cosignature", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			// A reusable authorization has no task ids, and crhs only cosigns one-shot payloads
			// (doc/privilege.md 联署), so this signature can never satisfy require-cosign.
			const spec = taskSpecFromJson({ kind: "exec", command: { argv: ["id", "-u"] }, env: {}, cwd: "", stdin: null });
			const sha = Buffer.from(specSha256(spec)).toString("hex");
			const signed = await runFile(bin, [
				"grant",
				"--nodes",
				node.nodeId,
				"--method",
				"exec",
				"--exact",
				"id -u",
				"--spec-sha256",
				sha,
				"--deadline",
				"10m",
				"--key",
				node.userKeyPath,
				"--yes",
			]);
			const submitted = await submitAuthorization(crhs, signed.stdout.trim());
			expect(submitted.status).toBe(200);
			expect(submitted.json.authorization?.dispatched).toEqual([]);
			// Still waiting, nothing ran. The one-shot payload crhs offers is cosigned and works.
			expect((await crhs.getTask(t.id)).state).toBe("awaiting_authorization");
			await authorizeWithCli(node, t.id);
			expect((await waitTerminal(t.id)).state).toBe("exited");
			// The reusable authorization can never authorize a cosign command; remove it so later
			// cases do not see it as a stored candidate.
			const id = submitted.json.authorization?.id as string;
			await crhs.db.deleteFrom("authorizations").where("id", "=", id).execute();
		}, 60_000);
	});

	// -----------------------------------------------------------------------
	describe("item 6: local approval", () => {
		beforeAll(async () => {
			await node.ctl("reset-priv-state");
			await node.ctl("start-priv");
			await node.setTrust([localEntry([0])]);
		}, 90_000);

		it("lists and approves a pending task as a trusted uid", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			const waiting = await crhs.getTask(t.id);
			// A local-only plan has no payload to sign; the request itself is the authorization path.
			expect(waiting.authorization?.local).toEqual({ attempt: 1 });
			expect(waiting.authorization?.pending).toBeNull();
			const listed = await node.execAs(0, ["/usr/local/bin/crha", "pending"]);
			expect(listed.code).toBe(0);
			expect(listed.stdout).toContain(t.id);
			const approved = await node.execAs(0, ["/usr/local/bin/crha", "approve", t.id, "--yes"]);
			expect(approved.code).toBe(0);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.stdoutHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("local");
		}, 60_000);

		it("denies a pending task", async () => {
			const t = await task({ kind: "exec", argv: ["true"] });
			await waitAwaiting(t.id);
			const denied = await node.execAs(0, ["/usr/local/bin/crha", "deny", t.id, "--message", "not today", "--yes"]);
			expect(denied.code).toBe(0);
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("rejected");
			expect(done.errorCode).toBe("authorization_rejected");
			expect(done.errorMessage).toContain("not today");
		}, 60_000);

		it("re-registers the request after the privileged mode restarts", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			await node.ctl("restart-priv");
			// crhs sends local.request again after the new `ok` trust report.
			await waitFor(
				"the approval request to be re-sent",
				async () => {
					const listed = await node.execAs(0, ["/usr/local/bin/crha", "pending"]);
					return listed.stdout.includes(t.id);
				},
				30_000,
			);
			const approved = await node.execAs(0, ["/usr/local/bin/crha", "approve", t.id, "--yes"]);
			expect(approved.code).toBe(0);
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("exited");
			expect(done.authorization?.dispatchedPath).toBe("local");
		}, 90_000);

		it("keeps the request across a disconnect of the non-privileged mode", async () => {
			const t = await task({ kind: "exec", argv: ["id", "-u"] });
			await waitAwaiting(t.id);
			await node.ctl("restart-crha");
			await waitFor(
				"the node to reconnect",
				async () => (await crhs.api(`/api/nodes/${node.nodeId}`)).json.node.connected === true,
				45_000,
			);
			// The task is still awaiting, not unknown, and crhs re-sends local.request after the
			// new trust report (doc/protocol.md 本地批准).
			const during = await crhs.getTask(t.id);
			expect(during.state).toBe("awaiting_authorization");
			await waitFor(
				"the approval request after the reconnect",
				async () => {
					const listed = await node.execAs(0, ["/usr/local/bin/crha", "pending"]);
					return listed.stdout.includes(t.id);
				},
				30_000,
			);
			const approved = await node.execAs(0, ["/usr/local/bin/crha", "approve", t.id, "--yes"]);
			expect(approved.code).toBe(0);
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("exited");
			expect(done.authorization?.dispatchedPath).toBe("local");
		}, 120_000);

		it("falls back to local approval with attempt + 1 after crha refused crhs's signature", async () => {
			// clock_skew 0 and max_ttl 1ms: the crhs-signed payload is expired by the time the node
			// looks at it, so task.start is refused before acceptance and the retry must go local.
			await node.setTrust([crhsEntry({ maxTtl: "1ms" }), localEntry([0])]);
			// Task creation itself waits for the daemon's task.start response, so the request has to
			// be in flight while the privileged mode is stopped; SIGCONT then releases the refusal.
			const pid = (await node.exec(["/bin/cat", "/run/priv/priv.pid"])).stdout.trim();
			expect(pid).toMatch(/^\d+$/);
			await node.exec(["/bin/kill", "-STOP", pid]);
			const creating = task({ kind: "exec", argv: ["id", "-u"] });
			await new Promise((r) => setTimeout(r, 300));
			await node.exec(["/bin/kill", "-CONT", pid]);
			const t = await creating;
			const retried = await waitFor(
				"the retry to wait for local approval",
				async () => {
					const row = await crhs.getTask(t.id);
					return row.state === "awaiting_authorization" && row.authorization?.attempt === 2 ? row : undefined;
				},
				30_000,
			);
			expect(retried.authorization?.tried).toContain("crhs");
			expect(retried.authorization?.lastRejection?.code).toMatch(/^authorization_/);
			expect(retried.authorization?.pending).toBeNull();
			expect(retried.authorization?.local).toEqual({ attempt: 2 });
			const approved = await node.execAs(0, ["/usr/local/bin/crha", "approve", t.id, "--yes"]);
			expect(approved.code).toBe(0);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.stdoutHead).toBe("0\n");
			expect(done.authorization?.attempt).toBe(2);
			expect(done.authorization?.dispatchedPath).toBe("local");
		}, 90_000);
	});

	// -----------------------------------------------------------------------
	describe("item 7: one-shot replay and the used list", () => {
		beforeAll(async () => {
			await node.setTrust([userEntry()]);
		}, 60_000);

		it("executes a one-shot user authorization once and records it as used", async () => {
			await node.ctl("reset-priv-state");
			await node.ctl("start-priv");
			await node.setTrust([userEntry()]);
			await node.exec(["/bin/sh", "-c", "rm -f /root/crh-runs"]);
			const t = await task({ kind: "exec", shell: "echo run >> /root/crh-runs; wc -l < /root/crh-runs" });
			await waitAwaiting(t.id);
			const submitted = await authorizeWithCli(node, t.id);
			const done = await waitTerminal(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.stdoutHead.trim()).toBe("1");
			const used = await node.exec(["/bin/cat", "/var/lib/crha/privileged/used"]);
			expect(used.code).toBe(0);
			expect(used.stdout).toContain(t.id);
			expect(used.stdout).toContain(submitted.id);
			// Replaying the same authorization dispatches nothing and runs nothing again.
			const replay = await submitAuthorization(crhs, submitted.authorization);
			expect(replay.status).toBe(200);
			expect(replay.json.authorization?.dispatched).toEqual([]);
			const lines = await node.exec(["/bin/sh", "-c", "wc -l < /root/crh-runs"]);
			expect(lines.stdout.trim()).toBe("1");
			// The used list survives a privileged mode restart.
			await node.ctl("restart-priv");
			await node.waitTrust("ok");
			const usedAfter = await node.exec(["/bin/cat", "/var/lib/crha/privileged/used"]);
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
			const sha = Buffer.from(specSha256(spec)).toString("hex");
			// grant needs ssh-keygen and the private key, so it runs on the host like the owner would.
			const signed = await runFile(bin, [
				"grant",
				"--nodes",
				node.nodeId,
				"--method",
				"exec",
				"--exact",
				"id -u --",
				"--spec-sha256",
				sha,
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
			expect(done.state).toBe("failed");
			expect(done.errorCode).toBe("symlink_not_allowed");
			expect(done.stdoutBytes).toBe(0);
			expect(done.errorMessage?.toLowerCase()).toContain("symbolic link");
		}, 60_000);

		it("refuses an unnormalized path", async () => {
			const t = await task({ kind: "file.read", path: "/etc/../etc/hostname" });
			const done = await waitTerminal(t.id);
			expect(done.state).not.toBe("exited");
			expect(done.stdoutBytes).toBe(0);
		}, 60_000);

		it("does not let a shell command hide behind an exec prefix rule", async () => {
			await node.setTrust([userEntry({ allow: [{ method: "exec", prefix: "id -u" }] })]);
			const shell = await task({ kind: "exec", shell: "id -u" });
			const done = await waitTerminal(shell.id);
			expect(done.state).toBe("rejected");
			expect(done.errorCode).toBe("authorization_required");
			// The rendered argv is compared as one target: a semicolon smuggled into an option
			// changes the target instead of extending a matching one (doc/privilege.md 方法与目标).
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
			const env = parseEnv(done.stdoutHead + done.stdoutTail);
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
			expect(envDone.stdoutHead + envDone.stdoutTail).toContain("PRIV_SAFE=present");
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
			expect(done.stdoutHead).toBe("0\n");
			expect(done.authorization?.dispatchedPath).toBe("crhs");
			expect(done.authorization?.payloadId).not.toBe(before.id);
		}, 60_000);

		it("fails privileged tasks with privileged_unavailable while the privileged mode is away", async () => {
			await node.setTrust([crhsEntry()]);
			await node.ctl("stop-priv");
			await node.waitTrust("unavailable");
			const t = await task({ kind: "exec", argv: ["true"] });
			const done = await waitTerminal(t.id);
			expect(done.state).toBe("failed");
			expect(done.errorCode).toBe("privileged_unavailable");
			// When it comes back with the same trust, the next task runs again.
			await node.ctl("start-priv");
			await node.waitTrust("ok");
			const again = await task({ kind: "exec", argv: ["true"] });
			expect((await node.taskState(again.id)).state).toBe("exited");
		}, 90_000);
	});
});
