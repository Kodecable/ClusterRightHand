/**
 * Item 9 of the M4 podman matrix (doc/m4.md 测试矩阵): an SSH node ignores `privileged`, runs the
 * task as the SSH user, and says so in the task's stderr; SFTP `file.*` tasks keep working.
 *
 * The sshd is the one in the M4 container (127.0.0.1:2222); crhs reaches it over a real SSH
 * connection with a key it generated through the API.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SSH_PRIVILEGED_NOTICE } from "../../src/cluster/ssh/exec.ts";
import { InProcessCrhs } from "../e2e/harness.ts";
import { buildStaticCrha, freePort, M4Node, podmanAvailable } from "./harness.ts";

const describePodman = describe.skipIf(!podmanAvailable);

describePodman("M4 podman: SSH nodes", () => {
	let tmp = "";
	let bin = "";
	let crhs: InProcessCrhs;
	let node: M4Node;
	let sshNodeId = "";
	let sshPort = 0;

	beforeAll(async () => {
		tmp = await mkdtemp(join(tmpdir(), "crh-m4-ssh-"));
		bin = await buildStaticCrha(tmp);
		crhs = await InProcessCrhs.create();
		await crhs.loginAdmin();
		sshPort = await freePort();
		node = await M4Node.create({ bin, crhs, mode: "forward", trust: [], ssh: true, sshPort });
		// crhs generates the key pair; the public half goes into the container's authorized_keys.
		const credential = await crhs.api("/api/ssh-credentials", { body: { name: "m4-sshd" } });
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
			body: { name: "m4-sshd", groups: ["web"], ...target, hostKey },
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
			path: "/root/m4-sftp.txt",
			content: "sftp-content\n",
			overwrite: true,
			privileged: true,
		});
		expect(written).toMatchObject({ state: "exited", exitCode: 0 });
		expect(written.stderrHead).toBe(SSH_PRIVILEGED_NOTICE);
		const read = await crhs.runTask(sshNodeId, { kind: "file.read", path: "/root/m4-sftp.txt", privileged: true });
		expect(read.state).toBe("exited");
		expect(read.stdoutHead + read.stdoutTail).toContain("sftp-content");
		expect(read.stderrHead).toBe(SSH_PRIVILEGED_NOTICE);
	}, 60_000);

	it("reports the SSH user's uid, not a privileged one", async () => {
		const t = await crhs.runTask(sshNodeId, { kind: "exec", argv: ["id", "-un"], privileged: true });
		expect(t).toMatchObject({ state: "exited", exitCode: 0 });
		expect(t.stdoutHead.trim()).toBe("root");
	}, 60_000);
});
