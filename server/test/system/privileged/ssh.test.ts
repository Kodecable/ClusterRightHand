/**
 * The SSH-node case of the privileged system suite (doc/design/testing/privileged.md): an SSH node ignores
 * `privileged`, runs the task as the SSH user, and says so in the task notice; SFTP `file.*` tasks
 * keep working.
 *
 * The sshd is the one in the suite container (127.0.0.1:2222); crhs reaches it over a real SSH
 * connection with a key it generated through the API.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SSH_PRIVILEGED_NOTICE } from "../../../src/cluster/ssh/exec.ts";
import { InProcessCrhs } from "../../e2e/harness.ts";
import { buildStaticCrha, freePort, PrivilegedNode, parseEnv, podmanAvailable } from "./harness.ts";

const describePodman = describe.skipIf(!podmanAvailable);

describePodman("privileged system: SSH nodes", () => {
	let tmp = "";
	let bin = "";
	let crhs: InProcessCrhs;
	let node: PrivilegedNode;
	let sshNodeId = "";
	let sshPort = 0;
	let transferRoot = "";
	let actorId = "";
	const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
	const actor = () => ({ type: "user" as const, id: actorId, onBehalfOfUserId: actorId });

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-priv-ssh-"));
		bin = await buildStaticCrha(tmp);
		transferRoot = join(tmp, "staging");
		crhs = await InProcessCrhs.create({ transferRoot });
		await crhs.loginAdmin();
		actorId = (await crhs.db.selectFrom("users").select("id").where("username", "=", "root").executeTakeFirstOrThrow())
			.id;
		sshPort = await freePort();
		node = await PrivilegedNode.create({ bin, crhs, mode: "forward", trust: [], ssh: true, sshPort });
		// crhs generates the key pair; the public half goes into the container's authorized_keys.
		const credential = await crhs.api("/api/ssh-credentials", { body: { name: "priv-sshd" } });
		expect(credential.status).toBe(201);
		const publicKey = credential.json.credential.publicKey as string;
		const credentialId = credential.json.credential.id as string;
		await node.authorizeSshKey(publicKey);
		const target = { host: "127.0.0.1", port: sshPort, user: "root", credentialId };
		const probe = await crhs.api("/api/ssh-nodes/probe", { body: target });
		expect(probe.status).toBe(200);
		const hostFingerprint = probe.json.fingerprint as string;
		expect(hostFingerprint).toMatch(/^SHA256:/);
		const created = await crhs.api("/api/ssh-nodes", {
			body: { name: "priv-sshd", ...target, hostFingerprint },
		});
		expect(created.status).toBe(201);
		sshNodeId = created.json.node.id as string;
	}, 600_000);

	afterAll(async () => {
		await node?.destroy();
		await crhs?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	it("runs a privileged exec as the SSH user and writes the notice on the task", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-u"], privileged: true });
		expect(t).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
		expect(t.outputHead).toBe("0\n");
		expect(t.notice).toBe(SSH_PRIVILEGED_NOTICE);
	}, 60_000);

	it("adds no notice to an ordinary task", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-u"] });
		expect(t).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
		expect(t.outputHead).toBe("0\n");
		expect(t.notice).toBeNull();
	}, 60_000);

	it("still runs a privileged file.write and file.read over SFTP", async () => {
		const written = await crhs.runTask(sshNodeId, {
			kind: "file.write",
			path: "/root/crh-sftp.txt",
			content: "sftp-content\n",
			overwrite: true,
			privileged: true,
		});
		expect(written).toMatchObject({ state: "exited", exitCode: 0 });
		expect(written.notice).toBe(SSH_PRIVILEGED_NOTICE);
		const read = await crhs.runTask(sshNodeId, { kind: "file.read", path: "/root/crh-sftp.txt", privileged: true });
		expect(read.state).toBe("exited");
		expect(read.outputHead + read.outputTail).toContain("sftp-content");
		// The notice is not part of the page; the file.read result is the task's structured result.
		expect(read.notice).toBe(SSH_PRIVILEGED_NOTICE);
		expect(read.result).toMatchObject({ kind: "file.read", from: 1, to: 1, eof: true });
	}, 60_000);

	it("pushes and pulls a file over SFTP and writes the privileged notice", async () => {
		const pushedContent = Buffer.from("sftp plane push\n");
		const pushPath = "/root/crh-sftp-plane-push.txt";
		const location = await crhs.cluster.stageBytesForPush(pushedContent);
		const pushed = await crhs.cluster.pushFile({
			nodeId: sshNodeId,
			path: pushPath,
			location,
			overwrite: true,
			mode: 0o600,
			privileged: true,
			actor: actor(),
		});
		const p = await node.taskState(pushed.id);
		expect(p).toMatchObject({ state: "exited", exitCode: 0, privileged: true, notice: SSH_PRIVILEGED_NOTICE });
		expect((await node.exec(["/usr/bin/stat", "-c", "%a %s", pushPath])).stdout.trim()).toBe(
			`600 ${pushedContent.length}`,
		);
		expect((await node.exec(["/bin/cat", pushPath])).stdout).toBe(pushedContent.toString());

		const pulledContent = Buffer.from("sftp plane pull\n");
		const pullPath = "/root/crh-sftp-plane-pull.txt";
		const created = await node.exec(["/usr/bin/tee", pullPath], { stdin: pulledContent.toString() });
		expect(created.code).toBe(0);
		expect((await node.exec(["/bin/chmod", "0600", pullPath])).code).toBe(0);
		const target = crhs.cluster.stagingLocation();
		const pulled = await crhs.cluster.pullFile({
			nodeId: sshNodeId,
			path: pullPath,
			maxBytes: 4096,
			location: target,
			privileged: true,
			actor: actor(),
		});
		const pull = await node.taskState(pulled.id);
		expect(pull).toMatchObject({
			state: "exited",
			exitCode: 0,
			privileged: true,
			notice: SSH_PRIVILEGED_NOTICE,
		});
		expect(pull.result).toMatchObject({
			kind: "file.pull",
			size: pulledContent.length,
			sha256: sha256Hex(pulledContent),
		});
		expect((await readFile(join(transferRoot, target.path))).equals(pulledContent)).toBe(true);
	}, 60_000);

	it("sets LANG and LC_ALL, keeps sshd's identity and drops CRHA_TASK_*", async () => {
		const t = await crhs.runTask(sshNodeId, {
			kind: "exec",
			argv: ["/usr/bin/env"],
			env: { CRHA_TASK_HOME: "/tmp/leak" },
		});
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		const env = parseEnv(t.outputHead + t.outputTail);
		expect(env).toMatchObject({
			HOME: "/root",
			USER: "root",
			LOGNAME: "root",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
		});
		expect(env.CRHA_TASK_HOME).toBeUndefined();
		expect(Object.keys(env).filter((k) => ["PRIV_SSH_PORT", "PRIV_NO_SSHD", "container"].includes(k))).toEqual([]);
	}, 60_000);

	it("lets a task's own LANG win over the default", async () => {
		const t = await crhs.runTask(sshNodeId, {
			kind: "exec",
			argv: ["/usr/bin/env"],
			env: { LANG: "de_DE.UTF-8" },
		});
		expect(t.state).toBe("exited");
		expect(parseEnv(t.outputHead + t.outputTail).LANG).toBe("de_DE.UTF-8");
	}, 60_000);

	it("reports the probed shells and runs a shell command on the probed sh", async () => {
		const node = (await crhs.api(`/api/nodes/${sshNodeId}`)).json.node as {
			facts: { shells: { sh: string | null; bash: string | null } };
		};
		expect(node.facts.shells.sh).toMatch(/^\//);
		expect(node.facts.shells.bash).toMatch(/^\//);
		// The inner shell's $0 is the shell the connection probed; the authorization target still
		// renders /bin/sh -c, whatever sh the node discovered (doc/design/execution.md "SSH execution").
		const t = await crhs.runTask(sshNodeId, { kind: "exec", shell: 'printf %s "$0"' });
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		expect(t.outputHead.trim()).toBe(node.facts.shells.sh);
		const view = (await crhs.api(`/api/tasks/${t.id}`)).json.task as {
			operation: { method: string; target: string };
		};
		expect(view.operation).toEqual({ method: "exec", target: `/bin/sh -c 'printf %s "$0"'` });
	}, 60_000);

	it("reports the SSH user's uid, not a privileged one", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-un"], privileged: true });
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		expect(t.outputHead.trim()).toBe("root");
	}, 60_000);
});
