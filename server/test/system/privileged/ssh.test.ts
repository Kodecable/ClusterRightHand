/**
 * The SSH-node case of the privileged system suite (doc/testing/privileged.md): an SSH node ignores
 * `privileged`, runs the task as the SSH user, and says so in the task's stderr; SFTP `file.*` tasks
 * keep working.
 *
 * The sshd is the one in the suite container (127.0.0.1:2222); crhs reaches it over a real SSH
 * connection with a key it generated through the API.
 */
import { mkdtemp, rm } from "node:fs/promises";
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

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-priv-ssh-"));
		bin = await buildStaticCrha(tmp);
		crhs = await InProcessCrhs.create();
		await crhs.loginAdmin();
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
		const hostKey = probe.json.fingerprint as string;
		expect(hostKey).toMatch(/^SHA256:/);
		const created = await crhs.api("/api/ssh-nodes", {
			body: { name: "priv-sshd", ...target, hostKey },
		});
		expect(created.status).toBe(201);
		sshNodeId = created.json.node.id as string;
	}, 600_000);

	afterAll(async () => {
		await node?.destroy();
		await crhs?.destroy();
		await rm(tmp, { recursive: true, force: true });
	});

	it("runs a privileged exec as the SSH user and writes the notice to stderr", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-u"], privileged: true });
		expect(t).toMatchObject({ state: "exited", exitCode: 0, privileged: true });
		expect(t.stdoutHead).toBe("0\n");
		expect(t.stderrHead).toBe(SSH_PRIVILEGED_NOTICE);
	}, 60_000);

	it("adds no notice to an ordinary task", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-u"] });
		expect(t).toMatchObject({ state: "exited", exitCode: 0, privileged: false });
		expect(t.stdoutHead).toBe("0\n");
		expect(t.stderrHead).toBe("");
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
		expect(written.stderrHead).toBe(SSH_PRIVILEGED_NOTICE);
		const read = await crhs.runTask(sshNodeId, { kind: "file.read", path: "/root/crh-sftp.txt", privileged: true });
		expect(read.state).toBe("exited");
		expect(read.stdoutHead + read.stdoutTail).toContain("sftp-content");
		// The notice comes first; the task's own stderr carries the file.read result JSON.
		expect(read.stderrHead.startsWith(SSH_PRIVILEGED_NOTICE)).toBe(true);
		expect(read.stderrHead).toContain('"from"');
	}, 60_000);

	it("sets LANG and LC_ALL, keeps sshd's identity and drops CRHA_TASK_*", async () => {
		const t = await crhs.runTask(sshNodeId, {
			kind: "exec",
			argv: ["/usr/bin/env"],
			env: { CRHA_TASK_HOME: "/tmp/leak" },
		});
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		const env = parseEnv(t.stdoutHead + t.stdoutTail);
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
		expect(parseEnv(t.stdoutHead + t.stdoutTail).LANG).toBe("de_DE.UTF-8");
	}, 60_000);

	it("reports the probed shells and runs a shell command on the probed sh", async () => {
		const node = (await crhs.api(`/api/nodes/${sshNodeId}`)).json.node as {
			facts: { shells: { sh: string | null; bash: string | null } };
		};
		expect(node.facts.shells.sh).toMatch(/^\//);
		expect(node.facts.shells.bash).toMatch(/^\//);
		// The inner shell's $0 is the shell the connection probed; the authorization target still
		// renders /bin/sh -c, whatever sh the node discovered (doc/execution-plane.md#执行).
		const t = await crhs.runTask(sshNodeId, { kind: "exec", shell: 'printf %s "$0"' });
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		expect(t.stdoutHead.trim()).toBe(node.facts.shells.sh);
		const view = (await crhs.api(`/api/tasks/${t.id}`)).json.task as {
			operation: { method: string; target: string };
		};
		expect(view.operation).toEqual({ method: "exec", target: `/bin/sh -c 'printf %s "$0"'` });
	}, 60_000);

	it("reports the SSH user's uid, not a privileged one", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-un"], privileged: true });
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		expect(t.stdoutHead.trim()).toBe("root");
	}, 60_000);
});
