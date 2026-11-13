/**
 * The native, ignore and reject cases of the privileged system suite
 * (doc/design/testing/privileged.md):
 *
 * - native (sudo / doas): exec / file, cancel and timeout, and privileged_unsupported when the
 *   escalation tool cannot start the helper.
 * - ignore / reject.
 *
 * The non-privileged mode runs as uid 998 and the helper as root, both in the same container as a
 * real sudo/doas, so the output "0" is the real uid of the process the trusted code started.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessCrhs, waitFor } from "../../e2e/harness.ts";
import { buildStaticCrha, PrivilegedNode, parseEnv, podmanAvailable } from "./harness.ts";

const FIXED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Variables that must never reach a task: the container's own and crha's overrides. */
function leaked(env: Record<string, string>): string[] {
	const containerOwn = new Set(["PRIV_SSH_PORT", "PRIV_NO_SSHD", "container"]);
	return Object.keys(env).filter((k) => containerOwn.has(k) || k.startsWith("CRHA_TASK_"));
}

describe.skipIf(!podmanAvailable)("privileged system: native, ignore and reject", () => {
	let tmp = "";
	let bin = "";
	let crhs: InProcessCrhs;
	let node: PrivilegedNode;
	let transferRoot = "";
	let actorId = "";
	const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
	const actor = () => ({ type: "user" as const, id: actorId, onBehalfOfUserId: actorId });

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-priv-native-"));
		bin = await buildStaticCrha(tmp);
		transferRoot = join(tmp, "staging");
		crhs = await InProcessCrhs.create({ transferRoot });
		await crhs.loginAdmin();
		actorId = (await crhs.db.selectFrom("users").select("id").where("username", "=", "root").executeTakeFirstOrThrow())
			.id;
		node = await PrivilegedNode.create({ bin, crhs, mode: "native", native: "sudo", trust: [] });
		await waitFor(
			"the node to report native mode",
			async () => (await crhs.api(`/api/nodes/${node.nodeId}`)).json.node.privilegedMode === "native",
		);
	}, 600_000);

	afterAll(async () => {
		await node?.destroy();
		await crhs?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	describe("exec environment", () => {
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

		it("gives a privileged task root's identity and the fixed PATH", async () => {
			const t = await node.task({ kind: "exec", argv: ["/usr/bin/env"] });
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

		it("lets both modes override HOME through the task's env", async () => {
			const plain = await crhs.runTask(node.nodeId, {
				kind: "exec",
				argv: ["/usr/bin/env"],
				env: { HOME: "/tmp/crh-unprivileged-home" },
			});
			const plainDone = await node.taskState(plain.id);
			expect(plainDone.state).toBe("exited");
			expect(parseEnv(plainDone.outputHead + plainDone.outputTail).HOME).toBe("/tmp/crh-unprivileged-home");

			const privileged = await node.task({
				kind: "exec",
				argv: ["/usr/bin/env"],
				env: { HOME: "/tmp/crh-privileged-home" },
			});
			const privilegedDone = await node.taskState(privileged.id);
			expect(privilegedDone.state).toBe("exited");
			expect(parseEnv(privilegedDone.outputHead + privilegedDone.outputTail).HOME).toBe("/tmp/crh-privileged-home");
		}, 60_000);

		it("reports the shells it discovered in facts", async () => {
			const res = await crhs.api(`/api/nodes/${node.nodeId}`);
			expect(res.json.node.facts.shells).toEqual({ sh: "/bin/sh", bash: "/bin/bash" });
		});
	});

	describe("native with sudo", () => {
		it("runs an exec as root", async () => {
			const t = await node.task({ kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			expect(done.outputHead).toBe("0\n");
		}, 60_000);

		it("runs a file.write and a file.read as root", async () => {
			const written = await node.task({
				kind: "file.write",
				path: "/root/crh-native.txt",
				content: "native-file\n",
				overwrite: true,
			});
			const w = await node.taskState(written.id);
			expect(w).toMatchObject({ state: "exited", exitCode: 0 });
			const read = await node.task({ kind: "file.read", path: "/root/crh-native.txt" });
			const r = await node.taskState(read.id);
			expect(r.state).toBe("exited");
			expect(r.outputHead + r.outputTail).toContain("native-file");
		}, 60_000);

		it("pushes and pulls a file as root", async () => {
			const pushedContent = Buffer.from("native plane push\n");
			const pushPath = "/root/crh-native-plane-push.txt";
			const location = await crhs.cluster.stageBytesForPush(pushedContent);
			const pushed = await crhs.cluster.pushFile({
				nodeId: node.nodeId,
				path: pushPath,
				location,
				overwrite: true,
				mode: 0o600,
				owner: "root",
				group: "root",
				privileged: true,
				actor: actor(),
			});
			const p = await node.taskState(pushed.id);
			expect(p).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			const stat = await node.exec(["/usr/bin/stat", "-c", "%a %u %g %s", pushPath]);
			expect(stat.stdout.trim()).toBe(`600 0 0 ${pushedContent.length}`);
			expect((await node.exec(["/bin/cat", pushPath])).stdout).toBe(pushedContent.toString());

			const pulledContent = Buffer.from("native plane pull\n");
			const pullPath = "/root/crh-native-plane-pull.txt";
			const created = await node.exec(["/usr/bin/tee", pullPath], { stdin: pulledContent.toString() });
			expect(created.code).toBe(0);
			expect((await node.exec(["/bin/chmod", "0600", pullPath])).code).toBe(0);
			const target = crhs.cluster.stagingLocation();
			const pulled = await crhs.cluster.pullFile({
				nodeId: node.nodeId,
				path: pullPath,
				maxBytes: 4096,
				location: target,
				privileged: true,
				actor: actor(),
			});
			const pull = await node.taskState(pulled.id);
			expect(pull).toMatchObject({ state: "exited", exitCode: 0 });
			expect(pull.result).toMatchObject({
				kind: "file.pull",
				size: pulledContent.length,
				sha256: sha256Hex(pulledContent),
			});
			expect((await readFile(join(transferRoot, target.path))).equals(pulledContent)).toBe(true);
		}, 60_000);

		it("cancels a running task through the helper", async () => {
			const t = await node.task({ kind: "exec", argv: ["sleep", "120"] });
			await waitFor("the task to run", async () => (await crhs.getTask(t.id)).state === "running", 20_000);
			const cancel = await crhs.api(`/api/tasks/${t.id}/cancel`, { body: {} });
			expect(cancel.status).toBe(200);
			const done = await node.taskState(t.id);
			expect(done.cancelled).toBe(true);
			expect(done.state).not.toBe("running");
		}, 60_000);

		it("times out inside the helper", async () => {
			const t = await node.task({ kind: "exec", argv: ["sleep", "120"], timeoutMs: 1500 });
			const done = await node.taskState(t.id);
			expect(done.timedOut).toBe(true);
			expect(done.exitCode).not.toBe(0);
		}, 60_000);

		it("keeps the output of a privileged file task away from uid 998", async () => {
			const res = await node.execAs(998, ["/bin/sh", "-c", "cat /root/crh-native.txt"]);
			expect(res.code).not.toBe(0);
			expect(res.stdout).toBe("");
		}, 30_000);
	});

	describe("native with doas", () => {
		beforeAll(async () => {
			await node.setMode("native", "doas");
		}, 60_000);

		it("runs an exec as root", async () => {
			const t = await node.task({ kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			expect(done.outputHead).toBe("0\n");
		}, 60_000);

		it("fails privileged_unsupported when doas does not allow the helper", async () => {
			const moved = await node.exec(["/bin/mv", "/etc/doas.conf", "/etc/doas.conf.off"]);
			expect(moved.code).toBe(0);
			try {
				const t = await node.task({ kind: "exec", argv: ["true"] });
				const done = await node.taskState(t.id);
				expect(done.state).toBe("failed");
				expect(done.errorCode).toBe("privileged_unsupported");
				expect(done.errorMessage?.length).toBeGreaterThan(0);
				expect(done.outputBytes).toBe(0);
			} finally {
				const restored = await node.exec(["/bin/mv", "/etc/doas.conf.off", "/etc/doas.conf"]);
				expect(restored.code).toBe(0);
			}
		}, 60_000);
	});

	describe("ignore", () => {
		beforeAll(async () => {
			await node.setMode("ignore");
		}, 60_000);

		it("runs a privileged exec as the non-privileged user", async () => {
			const t = await node.task({ kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
			expect(done.outputHead).toBe("998\n");
		}, 60_000);

		it("runs a privileged file task as the non-privileged user", async () => {
			const t = await node.task({
				kind: "file.write",
				path: "/tmp/crh-ignore.txt",
				content: "ignored\n",
				overwrite: true,
			});
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0 });
			const stat = await node.execAs(998, ["/bin/cat", "/tmp/crh-ignore.txt"]);
			expect(stat.stdout).toBe("ignored\n");
		}, 60_000);
	});

	describe("reject", () => {
		beforeAll(async () => {
			await node.setMode("reject");
		}, 60_000);

		it("refuses a privileged exec before it is accepted", async () => {
			const t = await node.task({ kind: "exec", argv: ["true"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "failed", errorCode: "privileged_unsupported", privileged: true });
			expect(done.exitCode).toBeNull();
			expect(done.outputBytes).toBe(0);
		}, 60_000);

		it("refuses a privileged file task the same way", async () => {
			const t = await node.task({ kind: "file.read", path: "/etc/hostname" });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "failed", errorCode: "privileged_unsupported" });
		}, 60_000);

		it("still runs an ordinary task as uid 998", async () => {
			const t = await crhs.runTask(node.nodeId, { kind: "exec", argv: ["id", "-u"] });
			const done = await node.taskState(t.id);
			expect(done).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
			expect(done.outputHead).toBe("998\n");
		}, 60_000);
	});
});
